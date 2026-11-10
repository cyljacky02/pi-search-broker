// Provider balance checks: report-only, rate-gapped, key-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, config, exa, tavily, json } from './helpers.mjs';
import { canReconcile } from '../src/reconcile.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { createGateway } from '../src/gateway.mjs';
import { memoryStore } from '../src/pool/store.mjs';

test('A standalone Gateway that cannot bind does not write the shared Account pool', async () => {
  const backing = memoryStore();
  let writes = 0;
  const store = { load: () => backing.load(), save: (state) => { writes++; backing.save(state); } };
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  const owner = createGateway(cfg, { store });
  await new Promise((resolve) => owner.server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = owner.server.address();
    writes = 0;
    const contender = createGateway(cfg, { store });
    const error = await new Promise((resolve) => {
      contender.server.once('error', resolve);
      contender.server.listen(port, '127.0.0.1');
    });
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(writes, 0, 'a failed bind must not persist Account pool state');
  } finally {
    await new Promise((resolve) => owner.server.close(resolve));
  }
});

test('A Gateway that does not own a Port cannot mutate another owner’s Account pool', async () => {
  const store = memoryStore();
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  const stale = createGateway(cfg, { store });
  const owner = createGateway(cfg, { store });
  let replacement;
  await new Promise((resolve) => owner.server.listen(0, '127.0.0.1', resolve));
  try {
    await owner.control.setSpent('t', 'free', 4);
    await assert.rejects(stale.control.setSpent('t', 'free', 9), /port/i);
    await new Promise((resolve) => owner.server.close(resolve));
    replacement = createGateway(cfg, { store });
    await new Promise((resolve) => replacement.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await replacement.control.status()).accounts[0].allocations[0].spent, 4);
  } finally {
    if (owner.server.listening) await new Promise((resolve) => owner.server.close(resolve));
    if (replacement?.server.listening) await new Promise((resolve) => replacement.server.close(resolve));
  }
});

test('An unbound Gateway loads the latest Account pool only after acquiring a Port', async () => {
  const store = memoryStore();
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  const later = createGateway(cfg, { store });
  const current = createGateway(cfg, { store });
  try {
    await assert.rejects(later.control.status(), /Port/);
    await new Promise((resolve) => current.server.listen(0, '127.0.0.1', resolve));
    await current.control.setSpent('t', 'free', 4);
    await new Promise((resolve) => current.server.close(resolve));
    await new Promise((resolve) => later.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await later.control.status()).accounts[0].allocations[0].spent, 4);
  } finally {
    if (later.server.listening) await new Promise((resolve) => later.server.close(resolve));
    if (current.server.listening) await new Promise((resolve) => current.server.close(resolve));
  }
});

test('Standalone close cancels a pending balance body without a later Account pool write', async () => {
  const store = memoryStore();
  const cfg = config(tavily('a', 'tvly-aaaaaaaa'), tavily('b', 'tvly-bbbbbbbb'));
  let startBody;
  let failBody;
  let signal;
  let calls = 0;
  const started = new Promise((resolve) => { startBody = resolve; });
  const body = new Promise((resolve, reject) => { failBody = reject; });
  const gateway = createGateway(cfg, {
    store,
    reconcileFetch: async (_url, options) => {
      calls++;
      signal = options.signal;
      return { ok: true, json: () => { startBody(); return body; } };
    }
  });
  let replacement;
  let reconcile;
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    reconcile = gateway.control.reconcile();
    await started;
    await new Promise((resolve, reject) => gateway.server.close((err) => err ? reject(err) : resolve()));
    assert.throws(() => gateway.server.listen(0, '127.0.0.1'), /shutting down/i);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await reconcile, [{ id: 'a', skipped: 'shutdown' }, { id: 'b', skipped: 'shutdown' }]);
    assert.equal(calls, 1, 'shutdown does not start balance work on the next Account');

    replacement = createGateway(cfg, { store });
    await new Promise((resolve) => replacement.server.listen(0, '127.0.0.1', resolve));
    await replacement.control.setSpent('a', 'free', 3);
    failBody(new Error('late adapter failure'));
    await new Promise((resolve) => setImmediate(resolve));
    const account = (await replacement.control.status()).accounts[0];
    assert.equal(account.allocations[0].spent, 3);
    assert.equal(account.reconcileError, null, 'shutdown is not persisted as a balance error');
    assert.equal(account.providerBalance, null);
  } finally {
    failBody(new Error('cleanup'));
    await reconcile;
    if (gateway.server.listening) await new Promise((resolve) => gateway.server.close(resolve));
    if (replacement?.server.listening) await new Promise((resolve) => replacement.server.close(resolve));
  }
});

test('Periodic reconciliation handles a storage rejection and can still shut down', async () => {
  const backing = memoryStore();
  let failWrites = false;
  let failObserved;
  const failed = new Promise((resolve) => { failObserved = resolve; });
  const store = {
    load: () => backing.load(),
    save: (state) => {
      if (failWrites) { failObserved(); throw new Error('disk failure'); }
      backing.save(state);
    }
  };
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  cfg.reconcileIntervalMs = 1; // Exercise the timer without waiting for the production minimum interval.
  const gateway = createGateway(cfg, {
    store,
    reconcileFetch: async () => json({ key: { usage: 0, limit: 1000 }, account: {} })
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    failWrites = true;
    await failed;
    await new Promise((resolve, reject) => gateway.server.close((err) => err ? reject(err) : resolve()));
    await new Promise((resolve) => setImmediate(resolve)); // A rejected timer task must not become unhandled.
  } finally {
    if (gateway.server.listening) await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test('Standalone Gateway reports startup failure and releases its Port', async () => {
  const backing = memoryStore();
  const store = { load: () => backing.load(), save: () => { throw new Error('disk failure'); } };
  const gateway = createGateway(config(tavily('t', 'tvly-aaaaaaaa')), { store });
  let listenCallbackCalled = false;
  const error = await new Promise((resolve) => {
    gateway.server.once('error', resolve);
    gateway.server.listen(0, '127.0.0.1', () => { listenCallbackCalled = true; });
  });
  assert.match(error.message, /could not be saved/i);
  assert.equal(gateway.server.listening, false);
  assert.equal(listenCallbackCalled, false);
});

test('Closing an unbound Gateway handles the shutdown rejection with or without a callback', async () => {
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  const withCallback = createGateway(cfg);
  const error = await new Promise((resolve) => withCallback.server.close(resolve));
  assert.equal(error.code, 'ERR_SERVER_NOT_RUNNING');
  createGateway(cfg).server.close();
  await new Promise((resolve) => setImmediate(resolve));
});

test('Only Tavily accounts and Exa accounts with an adminKey can be checked', () => {
  assert.equal(canReconcile({ provider: 'tavily' }), true);
  assert.equal(canReconcile({ provider: 'tavily', reconcile: false }), false);
  assert.equal(canReconcile({ provider: 'exa' }), false);
  assert.equal(canReconcile({ provider: 'exa', adminKey: 'svc' }), true);
});

test('Balance checks are report-only: they never cap spending or rewrite local accounting', async () => {
  const calls = [];
  const reconcileFetch = async (url, opts) => {
    calls.push([url, opts.headers.Authorization]);
    return json({ key: { usage: 1000, limit: null }, account: { plan_usage: 1000, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } });
  };
  let searches = 0;
  await serve(config(tavily('t', 'tvly-aaaaaaaa')),
    async () => { searches++; return json({ results: [], usage: { credits: 1 } }); },
    async ({ post, status }) => {
      const { results } = await (await post('/admin/reconcile', {})).json();
      assert.deepEqual(results, [{ id: 't', remaining: 0 }]);
      assert.equal(calls[0][0], PROVIDERS.tavily.balance.url);
      const a = (await status()).accounts[0];
      assert.equal(a.providerBalance.remaining, 0);
      assert.equal(a.allocations[0].spent, 0, 'local spend is not overwritten');
      assert.equal(a.available, 1000, 'local budget is not capped');
      assert.equal((await post('/tavily/search', { query: 'q' })).status, 200);
      assert.equal(searches, 1);
      // A second call within the minimum gap is skipped (protects Tavily's 10 per 10 minutes limit).
      const again = await (await post('/admin/reconcile', { id: 't' })).json();
      assert.equal(again.results[0].skipped, 'too-soon');
      assert.ok(!JSON.stringify(await status()).includes('tvly-'));
    }, { reconcileFetch });
});

test('Exa balance check uses the admin service key against the Team Management API', async () => {
  const seen = [];
  const account = { ...exa('e', 'exa-key-aaaa'), adminKey: 'exa-service-key-1234' };
  await serve(config(account), async () => json({ results: [] }), async ({ post, status }) => {
    const { results } = await (await post('/admin/reconcile', {})).json();
    assert.equal(results[0].remaining, 3.25);
    assert.deepEqual(seen, [[PROVIDERS.exa.balance.url, 'exa-service-key-1234']]);
    assert.equal((await status()).accounts[0].providerBalance.remaining, 3.25);
  }, {
    reconcileFetch: async (url, opts) => { seen.push([url, opts.headers['x-api-key']]); return json({ credits_usd: 3.25, expiring_credits: [] }); }
  });
});

test('Balance check failures are recorded without leaking keys', async () => {
  await serve(config(tavily('t', 'tvly-aaaaaaaa')), async () => json({}), async ({ post, status }) => {
    const { results } = await (await post('/admin/reconcile', {})).json();
    assert.match(results[0].error, /HTTP 429/);
    assert.match((await status()).accounts[0].reconcileError.message, /HTTP 429/);
  }, { reconcileFetch: async () => json({ detail: { error: 'slow down' } }, 429) });
});
