// Balance policy lives at the module's run interface; HTTP translation and Gateway lifecycle have separate coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, config, exa, tavily, json, DATE } from './helpers.mjs';
import { createBalanceChecks } from '../src/reconcile.mjs';
import { createAccountPool } from '../src/pool.mjs';
import { memoryStore } from '../src/pool/store.mjs';
import { ROUTES } from '../src/providers.mjs';

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

test('Provider balance is report-only: local spend and available credit still allow a subsequent Reservation', async () => {
  const { checks, pool } = setup(config(tavily('t', 'tvly-aaaaaaaa')).accounts, async () => usage(0));
  pool.setSpent('t', 'free', 7);
  const before = pool.snapshot().accounts[0];

  assert.deepEqual(await checks.run('t'), [{ id: 't', remaining: 0 }]);
  const after = pool.snapshot().accounts[0];
  assert.equal(after.providerBalance.remaining, 0);
  assert.equal(after.available, before.available);
  assert.deepEqual(after.allocations, before.allocations);

  let reserved = false;
  await pool.attempt(ROUTES['/tavily/search'], 1, new Set(), (reservation) => {
    reserved = true;
    assert.equal(reservation.account.id, 't');
    reservation.settle({ amount: 1, exact: true });
  });
  assert.equal(reserved, true, 'a zero Provider balance does not block a Reservation');
  assert.equal(pool.snapshot().accounts[0].allocations[0].spent, 8);
  assert.equal(pool.snapshot().accounts[0].available, 992);
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
