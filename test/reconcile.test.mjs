// Balance policy lives at the module's run interface; HTTP translation and Gateway lifecycle have separate coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, config, exa, tavily, json, DATE } from './helpers.mjs';
import { createBalanceChecks } from '../src/reconcile.mjs';
import { createAccountPool } from '../src/pool.mjs';
import { memoryStore } from '../src/pool/store.mjs';
import { ROUTES, EFFECT } from '../src/providers.mjs';

const usage = (remaining) => json({ account: { plan_usage: 1000 - remaining, plan_limit: 1000 } });

function setup(accounts, fetchImpl) {
  const time = { ms: DATE };
  const now = () => time.ms;
  const store = memoryStore();
  const pool = createAccountPool(accounts, { store, now });
  const checks = createBalanceChecks({ accounts, pool, fetchImpl, now });
  return { checks, pool, store, time };
}

test('run checks supported Accounts with the Provider URL and credential, skipping unsupported Accounts', async () => {
  const accounts = config(
    tavily('t', 'tvly-aaaaaaaa'),
    { ...tavily('off', 'tvly-disabled'), reconcile: false },
    exa('no-admin', 'exa-search-no-admin'),
    { ...exa('e', 'exa-search-key'), adminKey: 'exa-admin-key' },
    { ...exa('off-admin', 'exa-disabled-search'), adminKey: 'exa-disabled-admin', reconcile: false }
  ).accounts;
  const calls = [];
  const { checks, pool } = setup(accounts, async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers });
    return calls.length === 1 ? usage(25) : json({ credits_usd: 3.25 });
  });

  assert.deepEqual(await checks.run(), [
    { id: 't', remaining: 25 },
    { id: 'off', skipped: 'not-supported' },
    { id: 'no-admin', skipped: 'not-supported' },
    { id: 'e', remaining: 3.25 },
    { id: 'off-admin', skipped: 'not-supported' }
  ]);
  assert.deepEqual(calls, [
    { url: 'https://api.tavily.com/usage', method: 'GET', headers: { Authorization: 'Bearer tvly-aaaaaaaa' } },
    { url: 'https://admin-api.exa.ai/team-management/credits', method: 'GET', headers: { 'x-api-key': 'exa-admin-key' } }
  ]);
  assert.deepEqual(pool.snapshot().accounts.map((a) => [a.id, a.providerBalance?.remaining ?? null, a.reconcileError]), [
    ['t', 25, null], ['off', null, null], ['no-admin', null, null], ['e', 3.25, null], ['off-admin', null, null]
  ]);
});

const tavilyRoute = ROUTES['/tavily/search'];
const exaRoute = ROUTES['/exa/search'];
const spend = (pool, route, amount) => pool.attempt(route, amount, new Set(), (r) => r.settle({ amount, exact: true }));
const usageOf = ({ planUsage, planLimit = 1000, keyUsage = 0, keyLimit = null }) =>
  json({ key: { usage: keyUsage, limit: keyLimit }, account: { plan_usage: planUsage, plan_limit: planLimit } });

test('A Tavily-reported balance becomes the Account credit; local spend since the report comes off it', async () => {
  const { checks, pool } = setup(config(tavily('t', 'tvly-aaaaaaaa')).accounts, async () => usageOf({ planUsage: 975 }));
  const before = pool.snapshot().accounts[0];
  assert.deepEqual([before.balance.source, before.available], ['hint', 1000], 'the free plan until the first report');

  assert.deepEqual(await checks.run('t'), [{ id: 't', remaining: 25 }]);
  const synced = pool.snapshot().accounts[0];
  assert.deepEqual([synced.balance.source, synced.available, synced.balance.limit, synced.balance.reportedAt],
    ['provider', 25, 1000, new Date(DATE).toISOString()]);

  await spend(pool, tavilyRoute, 3);
  assert.equal(pool.snapshot().accounts[0].available, 22);
  assert.equal(await pool.attempt(tavilyRoute, 30, new Set(), () => assert.fail('no Account has 30 credits')), null);
});

test('A zero Provider balance parks the Account until the next reset; a later report with credit brings it back', async () => {
  let planUsage = 1000;
  const { checks, pool, time } = setup(config(tavily('t', 'tvly-aaaaaaaa')).accounts, async () => usageOf({ planUsage }));
  await checks.run('t');
  const parked = pool.snapshot().accounts[0];
  assert.deepEqual([parked.status, parked.retryAt], ['quota', '2026-12-01T00:00:00.000Z']);
  assert.equal(await pool.attempt(tavilyRoute, 1, new Set(), () => assert.fail('parked')), null);

  planUsage = 960;
  time.ms += 60000;
  await checks.run('t');
  const back = pool.snapshot().accounts[0];
  assert.deepEqual([back.status, back.available], ['active', 40]);
});

test('Exa-reported credit is spent soonest-expiring first, and spend inside the report lag still counts against it', async () => {
  const account = { ...exa('e', 'exa-search-key'), adminKey: 'exa-admin-key' };
  const { checks, pool, time } = setup(config(account).accounts, async () => json({
    credits_usd: 30, expiring_credits: [{ amount_usd: 10, expires_at: '2026-11-20T00:00:00Z' }], metadata: { generated_at: new Date(time.ms).toISOString() }
  }));
  await spend(pool, exaRoute, 2); // may not be in a report that lags by up to 5 minutes
  time.ms += 60000;
  await checks.run('e');
  const a = pool.snapshot().accounts[0];
  assert.deepEqual([a.balance.source, a.available, a.balance.limit], ['provider', 28, null]);
  assert.deepEqual(a.balance.expiring, [{ amount: 8, expiresAt: '2026-11-20T00:00:00Z' }]);
});

test('A report from an earlier month no longer counts: the Account falls back to its Allocations until the next report', async () => {
  const { checks, pool, time } = setup(config(tavily('t', 'tvly-aaaaaaaa')).accounts, async () => usageOf({ planUsage: 975 }));
  await checks.run('t');
  time.ms = Date.parse('2026-12-01T00:00:01Z');
  const a = pool.snapshot().accounts[0];
  assert.deepEqual([a.balance.source, a.available], ['hint', 1000]);
});

test('Before a parked Account is retried, its balance is asked for first; the report decides, or the park ends after a grace period', async () => {
  const time = { ms: DATE };
  const asked = [];
  const accounts = config(tavily('t', 'tvly-aaaaaaaa')).accounts;
  const pool = createAccountPool(accounts, { store: memoryStore(), now: () => time.ms, requestBalanceSync: (id) => asked.push(id) });
  let planUsage = 1000;
  const checks = createBalanceChecks({ accounts, pool, now: () => time.ms, fetchImpl: async () => usageOf({ planUsage }) });
  await pool.attempt(tavilyRoute, 1, new Set(), (r) => r.fail({ status: 432, effect: EFFECT.QUOTA }));
  assert.deepEqual(asked, ['t'], 'running out asks for the balance');
  time.ms = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(pool.snapshot().accounts[0].status, 'quota', 'still parked while the balance is asked for');
  assert.deepEqual(asked, ['t', 't']);
  await checks.run('t');
  assert.equal(pool.snapshot().accounts[0].status, 'quota', 'the report says there is still no credit');
  planUsage = 0;
  time.ms += 60000;
  await checks.run('t');
  assert.equal(pool.snapshot().accounts[0].status, 'active');
  // No answer at all: the park ends after the grace period.
  await pool.attempt(tavilyRoute, 1, new Set(), (r) => r.fail({ status: 432, effect: EFFECT.QUOTA }));
  time.ms = Date.parse('2027-01-01T00:00:00Z');
  assert.equal(pool.snapshot().accounts[0].status, 'quota');
  time.ms += 5 * 60000;
  assert.equal(pool.snapshot().accounts[0].status, 'active');
});

test('A check asked for too soon after the last one runs once the minimum gap has passed', async () => {
  let calls = 0;
  const accounts = config(tavily('t', 'tvly-aaaaaaaa')).accounts;
  const pool = createAccountPool(accounts, { store: memoryStore(), now: () => DATE });
  const checks = createBalanceChecks({ accounts, pool, now: () => DATE, minGapMs: 30, fetchImpl: async () => { calls++; return usageOf({ planUsage: 10 }); } });
  await checks.run('t');
  assert.deepEqual(await checks.soon('t'), [{ id: 't', skipped: 'too-soon' }]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls, 2, 'the skipped check ran later');
});

test('Spend inside the Exa report lag is remembered across a restart', async () => {
  const time = { ms: DATE };
  const store = memoryStore();
  const account = { ...exa('e', 'exa-search-key'), adminKey: 'exa-admin-key' };
  const accounts = config(account).accounts;
  await spend(createAccountPool(accounts, { store, now: () => time.ms }), exaRoute, 2);
  time.ms += 60000;
  const restarted = createAccountPool(accounts, { store, now: () => time.ms });
  const checks = createBalanceChecks({ accounts, pool: restarted, now: () => time.ms, fetchImpl: async () => json({ credits_usd: 30 }) });
  await checks.run('e');
  assert.equal(restarted.snapshot().accounts[0].available, 28);
});

test('the default minimum gap skips until exactly 60000ms after the last attempt without recording skips', async () => {
  let calls = 0;
  const { checks, pool, time } = setup(config(tavily('t', 'tvly-aaaaaaaa')).accounts, async () => usage(++calls));
  assert.deepEqual(await checks.run('t'), [{ id: 't', remaining: 1 }]);
  const lastGood = pool.snapshot().accounts[0].providerBalance;

  assert.deepEqual(await checks.run('t'), [{ id: 't', skipped: 'too-soon' }]);
  time.ms += 59999;
  assert.deepEqual(await checks.run('t'), [{ id: 't', skipped: 'too-soon' }]);
  assert.equal(calls, 1);
  assert.deepEqual(pool.snapshot().accounts[0].providerBalance, lastGood);

  time.ms++;
  assert.deepEqual(await checks.run('t'), [{ id: 't', remaining: 2 }]);
  assert.equal(calls, 2);
  assert.equal(pool.snapshot().accounts[0].providerBalance.at, new Date(time.ms).toISOString());
});

test('all-Account traversal waits for one Provider reply before starting the next', async () => {
  let finishFirst;
  const first = new Promise((resolve) => { finishFirst = resolve; });
  const calls = [];
  const { checks, pool } = setup(config(tavily('a', 'tvly-aaaaaaaa'), tavily('b', 'tvly-bbbbbbbb')).accounts,
    async (_url, opts) => {
      calls.push(opts.headers.Authorization);
      return calls.length === 1 ? first : usage(20);
    });
  const running = checks.run();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['Bearer tvly-aaaaaaaa'], 'the second Account waits for the first');
  } finally {
    finishFirst(usage(10));
    await running;
  }
  assert.deepEqual(await running, [{ id: 'a', remaining: 10 }, { id: 'b', remaining: 20 }]);
  assert.deepEqual(calls, ['Bearer tvly-aaaaaaaa', 'Bearer tvly-bbbbbbbb']);
  assert.deepEqual(pool.snapshot().accounts.map((a) => a.providerBalance.remaining), [10, 20]);
});

const failures = [
  ['network', (secrets) => { throw new Error(`connection failed for ${secrets}`); }, 'Balance request failed (network/timeout)'],
  ['HTTP', (secrets) => json({ error: secrets }, 429), 'Balance request failed: HTTP 429'],
  ['JSON', (secrets) => new Response(secrets), 'Balance response was not JSON'],
  ['shape', (secrets) => json({ error: secrets }), 'Unexpected /credits response shape']
];
for (const [kind, fail, message] of failures) {
  test(`${kind} errors are key-safe, retain the last good Provider balance, and consume the minimum gap`, async () => {
    const account = { ...exa('e', 'exa-search-secret'), adminKey: 'exa-admin-secret' };
    const secrets = `${account.apiKey} ${account.adminKey}`;
    let calls = 0;
    const { checks, pool, store, time } = setup(config(account).accounts, async () => {
      calls++;
      return calls === 1 ? json({ credits_usd: 3.25 }) : fail(secrets);
    });
    assert.deepEqual(await checks.run('e'), [{ id: 'e', remaining: 3.25 }]);
    const lastGood = pool.snapshot().accounts[0].providerBalance;
    time.ms += 60000;

    const results = await checks.run('e');
    assert.deepEqual(results, [{ id: 'e', error: message }]);
    const snapshot = pool.snapshot();
    assert.deepEqual(snapshot.accounts[0].providerBalance, lastGood);
    assert.deepEqual(snapshot.accounts[0].reconcileError, { at: new Date(time.ms).toISOString(), message });
    assert.deepEqual(await checks.run('e'), [{ id: 'e', skipped: 'too-soon' }]);
    assert.equal(calls, 2);
    const exposed = JSON.stringify({ results, snapshot, saved: store.load() });
    assert.ok(!exposed.includes(account.apiKey));
    assert.ok(!exposed.includes(account.adminKey));
  });
}

test('an unknown Account id is rejected without fetching or changing the Account pool', async () => {
  let calls = 0;
  const { checks, pool } = setup(config(tavily('t', 'tvly-aaaaaaaa')).accounts, async () => {
    calls++;
    return usage(25);
  });
  const before = pool.snapshot();
  await assert.rejects(checks.run('nope'), { message: 'Unknown account id' });
  assert.equal(calls, 0);
  assert.deepEqual(pool.snapshot(), before);
});

test('POST /admin/reconcile translates success and unknown-id errors to HTTP', async () => {
  await serve(config(tavily('t', 'tvly-aaaaaaaa')), async () => json({}), async ({ post }) => {
    const success = await post('/admin/reconcile', { id: 't' });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true, results: [{ id: 't', remaining: 25 }] });
    const unknown = await post('/admin/reconcile', { id: 'nope' });
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: 'Unknown account id' });
  }, { reconcileFetch: async () => usage(25) });
});

test('Tavily reports lag too: spend in the hour before a report still counts against it', async () => {
  const { checks, pool, time } = setup(config(tavily('t', 'tvly-aaaaaaaa')).accounts, async () => usageOf({ planUsage: 0 }));
  await spend(pool, tavilyRoute, 1);
  time.ms += 20 * 60000; // inside the assumed lag (see the Tavily lagMs in providers.mjs)
  await checks.run('t');
  assert.equal(pool.snapshot().accounts[0].available, 999);
  time.ms += 60 * 60000;
  await checks.run('t');
  assert.equal(pool.snapshot().accounts[0].available, 1000, 'after the lag window the report is trusted as is');
});
