import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/gateway.mjs';
import { quote, AccountManager } from '../src/manager.mjs';
import { validateConfig } from '../src/config.mjs';

const DATE = Date.parse('2026-11-09T06:00:00Z');
const secret = 'local-only-secret-with-32-chars-12345';
const exa = (id, key, promoExpiration = '2026-12-03T00:00:00Z') => ({
  id, provider: 'exa', apiKey: key,
  allocations: [{ id: 'promo', limit: 60, period: 'once', expiresAt: promoExpiration }, { id: 'free', limit: 10, period: 'monthly' }]
});
const tavily = (id, key) => ({ id, provider: 'tavily', apiKey: key, allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] });
const config = (...accounts) => validateConfig({
  gateway: { host: '127.0.0.1', port: 19473, token: secret },
  totalTimeoutMs: 50000, attemptTimeoutMs: 10000, accounts
});
async function run(config, fetchImpl, fn, time = { ms: DATE }) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-dual-key-'));
  const statePath = join(temp, 'state.json');
  const { server, manager } = createGateway(config, { statePath, fetchImpl, now: () => time.ms });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token = secret) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  try { await fn({ base, post, manager, statePath, time }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
}

// Public seam: provider-compatible localhost routes (same path and JSON as pi-web-access uses).
test('Exa fails over from spent promo key to a second independent account in the SAME search', async () => {
  const attempts = [];
  await run(config(
    exa('early', 'exa-real-aaa', '2026-11-10T00:00:00Z'),
    exa('later', 'exa-real-bbb', '2026-12-01T00:00:00Z')
  ), async (url, options) => {
    attempts.push({ url, key: options.headers['x-api-key'] });
    return options.headers['x-api-key'] === 'exa-real-aaa'
      ? new Response(JSON.stringify({ error: 'quota exhausted' }), { status: 402 })
      : Response.json({ results: [{ title: 'good', url: 'https://example.com' }], costDollars: { total: 0.013 } });
  }, async ({ post, manager, statePath }) => {
    const res = await post('/exa/search', { query: 'test', type: 'auto', numResults: 5, contents: { highlights: true } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).results.map((r) => r.title), ['good']);
    assert.deepEqual(attempts.map((x) => x.key), ['exa-real-aaa', 'exa-real-bbb']);
    assert.equal(attempts[0].url, 'https://api.exa.ai/search');
    const status = manager.snapshot();
    assert.equal(status.accounts[0].status, 'quota');
    assert.equal(status.accounts[1].allocations[0].spent, 0.013);
    assert.equal(status.accounts[1].requests, 1);
    const persisted = readFileSync(statePath, 'utf8');
    assert.ok(!persisted.includes('exa-real-'));
  });
});

test('Tavily rate limiting cools down the account and tries another key immediately', async () => {
  const keys = [];
  await run(config(tavily('t-a', 'tvly-aaaaa'), tavily('t-b', 'tvly-bbbbb')),
    async (_url, options) => {
      keys.push(options.headers.Authorization);
      if (options.headers.Authorization === 'Bearer tvly-aaaaa') {
        return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'Retry-After': '45' } });
      }
      return Response.json({ results: [] });
    }, async ({ post, manager }) => {
      const first = await post('/tavily/search', { query: 'hello', search_depth: 'advanced' });
      assert.equal(first.status, 200);
      assert.deepEqual(keys, ['Bearer tvly-aaaaa', 'Bearer tvly-bbbbb']);
      const a = manager.snapshot().accounts[0];
      assert.equal(a.status, 'cooldown');
      assert.ok(a.retryAt?.startsWith('2026-11-09'));
      assert.equal(manager.snapshot().accounts[1].allocations[0].spent, 2);
      const second = await post('/tavily/search', { query: 'again', search_depth: 'basic' });
      assert.equal(second.status, 200);
      assert.equal(keys.at(-1), 'Bearer tvly-bbbbb');
      assert.equal(keys.length, 3);
    }
  );
});

test('Promo expiration keeps Exa monthly allocation usable; monthly spend resets next month', async () => {
  const time = { ms: Date.parse('2026-11-12T00:00:00Z') };
  const accounts = config(exa('exa-a', 'exa-aaaaa', '2026-11-11T00:00:00Z'));
  await run(accounts, async () => Response.json({ results: [], costDollars: { total: 1 } }),
    async ({ post, manager }) => {
      assert.equal((await post('/exa/search', { query: 'test' })).status, 200);
      let allocations = manager.snapshot().accounts[0].allocations;
      assert.equal(allocations[0].active, false);
      assert.equal(allocations[0].remainingEstimate, 0);
      assert.equal(allocations[1].remainingEstimate, 9);
      time.ms = Date.parse('2026-12-01T00:01:00Z');
      assert.equal(manager.snapshot().accounts[0].allocations[1].remainingEstimate, 10);
    }, time);
});

test('Estimated budget guards skip nearly exhausted keys, and never include keys in HTTP /status', async () => {
  const limited = { ...tavily('small', 'tvly-small'), allocations: [{ id: 'free', limit: 1, period: 'monthly' }] };
  const calls = [];
  await run(config(limited, tavily('other', 'tvly-other')), async (_url, opts) => {
    calls.push(opts.headers.Authorization);
    return Response.json({ results: [] });
  }, async ({ post, base }) => {
    const r1 = await post('/tavily/search', { query: 'first' });
    assert.equal(r1.status, 200);
    const r2 = await post('/tavily/search', { query: 'second' });
    assert.equal(r2.status, 200);
    assert.deepEqual(calls, ['Bearer tvly-other', 'Bearer tvly-other']); // more remaining wins same expiry
    const stat = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(stat.status, 200);
    const text = await stat.text();
    assert.ok(!text.includes('tvly-small') && !text.includes('tvly-other'));
    const denied = await post('/tavily/search', { query: 'bad' }, 'incorrect-key');
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 2);
  });
});

test('Provider bad request is not rotated and API keys do not appear in error response', async () => {
  let calls = 0;
  await run(config(exa('a', 'exa-secret-a'), exa('b', 'exa-secret-b')),
    async () => { calls++; return Response.json({ error: 'exa-secret-a invalid query' }, { status: 400 }); },
    async ({ post }) => {
      const res = await post('/exa/search', { query: 'bad' });
      assert.equal(res.status, 400);
      const text = await res.text();
      assert.ok(!text.includes('exa-secret-a'));
      assert.equal(calls, 1);
    });
});

test('Exa contents endpoint rotates on 401 and disables the bad key', async () => {
  const calls = [];
  await run(config(exa('a', 'exa-bad-aaa', '2026-11-11T00:00:00Z'), exa('b', 'exa-ok-bbb', '2026-11-12T00:00:00Z')),
    async (url, opts) => {
      calls.push([url, opts.headers['x-api-key']]);
      return opts.headers['x-api-key'] === 'exa-bad-aaa'
        ? Response.json({ error: 'invalid key' }, { status: 401 })
        : Response.json({ results: [], costDollars: { total: 0.002 } });
    }, async ({ post, manager }) => {
      assert.equal((await post('/exa/contents', { urls: ['https://site.test'], text: true })).status, 200);
      assert.deepEqual(calls.map((x) => x[0]), ['https://api.exa.ai/contents', 'https://api.exa.ai/contents']);
      assert.equal(manager.snapshot().accounts[0].status, 'auth');
      assert.equal(manager.snapshot().accounts[1].allocations[0].spent, 0.002);
    });
});

test('Authorized admin can enable, disable and reconcile expenditure without restarting', async () => {
  await run(config(tavily('t-1', 'tvly-managed')),
    async () => Response.json({ results: [] }), async ({ post, base, manager }) => {
      assert.equal((await post('/admin/disable', { id: 't-1' })).status, 200);
      assert.equal((await post('/tavily/search', { query: 'test' })).status, 429);
      assert.equal((await post('/admin/set-spent', { id: 't-1', allocationId: 'free', spent: 820 })).status, 200);
      assert.equal(manager.snapshot().accounts[0].allocations[0].remainingEstimate, 180);
      assert.equal((await post('/tavily/search', { query: 'test' })).status, 200);
      assert.equal((await post('/admin/disable', { id: 't-1' }, 'bad-token')).status, 401);
      assert.equal((await post('/admin/enable', { id: 't-1' })).status, 200);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    });
});

test('Config rejects non-loopback listeners, duplicate API keys and expired allocation without timezone', () => {
  assert.throws(() => validateConfig({ ...config(tavily('a', 'tvly-key-1')), gateway: { host: '0.0.0.0', port: 19473, token: secret } }), /loopback/);
  assert.throws(() => config(tavily('a', 'tvly-key-1'), tavily('b', 'tvly-key-1')), /Duplicate apiKey/);
  assert.throws(() => config({ ...exa('a', 'exa-secret-1'), allocations: [{ id: 'promo', limit: 60, period: 'once', expiresAt: '2026-11-30' }] }), /ISO expiresAt/);
});

test('Independent budget reservations prevent concurrent requests from overspending a tiny quota', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived;
  const firstArrived = new Promise((resolve) => { arrived = resolve; });
  const small = { ...tavily('a', 'tvly-very-small'), allocations: [{ id: 'only', limit: 1, period: 'monthly' }] };
  let count = 0;
  await run(config(small), async () => { count++; arrived(); await gate; return Response.json({ results: [] }); },
    async ({ post }) => {
      const first = post('/tavily/search', { query: 'one' });
      await firstArrived;
      const second = await post('/tavily/search', { query: 'two' });
      assert.equal(second.status, 429);
      release();
      assert.equal((await first).status, 200);
      assert.equal(count, 1);
    });
});

test('Quoted Exa cost follows the current rate card (contents included on search up to 10 results)', () => {
  assert.equal(quote('tavily', '/search', { search_depth: 'advanced' }), 2);
  assert.equal(quote('exa', '/contents', { urls: ['a', 'b'], text: true }), 0.002);
  // pi-web-access's default call: auto, 5 results, highlights -> $0.007 (was over-reserved at $0.012)
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 5, contents: { highlights: true } }), 0.007);
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 5, contents: { text: true, highlights: true } }), 0.007);
});

test('Exa promo is spent before recurring free budget even when free resets sooner', async () => {
  const promo = exa('a', 'exa-promo-xxxx', '2026-12-20T00:00:00Z');
  await run(config(promo), async () => Response.json({ results: [], costDollars: { total: 0.02 } }),
    async ({ post, manager }) => {
      assert.equal((await post('/exa/search', { query: 'q' })).status, 200);
      assert.equal(manager.snapshot().accounts[0].allocations[0].spent, 0.02);
      assert.equal(manager.snapshot().accounts[0].allocations[1].spent, 0);
    });
});

test('Exa quota block can re-open after promo expiry so same key can use monthly free allowance', async () => {
  const time = { ms: Date.parse('2026-11-09T06:00:00Z') };
  const attempts = [];
  await run(config(exa('a', 'exa-promo-abc', '2026-11-10T00:00:00Z')),
    async (_url, opts) => {
      attempts.push(opts.headers['x-api-key']);
      return attempts.length === 1 ? Response.json({ error: 'exhausted' }, { status: 402 }) : Response.json({ results: [], costDollars: { total: 0.01 } });
    }, async ({ post, manager }) => {
      assert.equal((await post('/exa/search', { query: 'q' })).status, 429);
      assert.equal(manager.snapshot().accounts[0].status, 'quota');
      time.ms = Date.parse('2026-11-10T00:01:00Z');
      assert.equal((await post('/exa/search', { query: 'q' })).status, 200);
      assert.equal(manager.snapshot().accounts[0].status, 'active');
      assert.equal(manager.snapshot().accounts[0].allocations[1].spent, 0.01);
      assert.equal(attempts.length, 2);
    }, time);
});

test('Monthly allocations support a per-account UTC reset day', () => {
  const time = { ms: Date.parse('2026-11-12T06:00:00Z') };
  const cfg = config({ ...tavily('a', 'tvly-day12'), allocations: [{ id: 'monthly', period: 'monthly', limit: 1000, resetDay: 15 }] });
  const mgr = new AccountManager(cfg, { now: () => time.ms });
  assert.equal(mgr.snapshot().accounts[0].allocations[0].window, '2026-10-15');
  mgr.change('a', 'set-spent', { allocationId: 'monthly', spent: 500 });
  time.ms = Date.parse('2026-11-15T00:00:00Z');
  assert.equal(mgr.snapshot().accounts[0].allocations[0].remainingEstimate, 1000);
  assert.equal(mgr.snapshot().accounts[0].allocations[0].window, '2026-11-15');
});

test('Free allocation starts only after configured promo expires (startsAt)', async () => {
  const time = { ms: Date.parse('2026-11-09T06:00:00Z') };
  const cutoff = '2026-11-10T00:00:00Z';
  const a = exa('a', 'exa-starts-at', cutoff);
  a.allocations[1].startsAt = cutoff;
  const mgr = new AccountManager(config(a), { now: () => time.ms });
  assert.equal(mgr.snapshot().accounts[0].allocations[1].active, false);
  assert.equal(mgr.snapshot().accounts[0].allocations[1].remainingEstimate, 0);
  time.ms = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(mgr.snapshot().accounts[0].allocations[0].active, false);
  assert.equal(mgr.snapshot().accounts[0].allocations[1].active, true);
  assert.equal(mgr.snapshot().accounts[0].allocations[1].remainingEstimate, 10);
});
