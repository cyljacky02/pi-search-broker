// Gateway: its lifecycle (start, serve, stop) and the HTTP adapter (auth, routing, admin routes, client disconnects).
// Rotation, billing and unsaved-state replies are tested through execute() in broker.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serve, config, exa, tavily, json, secret, flakyStore, freePort, assertPortAvailable, onServerRequest } from './helpers.mjs';
import { probeHealth } from '../src/control.mjs';
import { createGateway } from '../src/gateway.mjs';
import { VERSION } from '../src/config.mjs';
import { StateNotSaved } from '../src/pool.mjs';
import { memoryStore } from '../src/pool/store.mjs';

// ---------- lifecycle: start, serve, stop ----------

test('A Gateway that cannot bind its Port writes nothing and refuses broker control', async () => {
  const backing = memoryStore();
  let writes = 0;
  const store = { load: () => backing.load(), save: (state) => { writes++; backing.save(state); } };
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  const owner = createGateway(cfg, { store });
  const { port } = await owner.start({ port: 0 });
  try {
    writes = 0;
    const contender = createGateway(cfg, { store });
    await assert.rejects(contender.start({ port }), { code: 'EADDRINUSE' });
    assert.equal(writes, 0, 'a failed bind must not persist Account pool state');
    await assert.rejects(contender.control.setSpent('t', 'free', 9), /Port/);
  } finally {
    await owner.stop();
  }
});

test('A Gateway loads the latest Account pool only once it owns the Port', async () => {
  const store = memoryStore();
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  const later = createGateway(cfg, { store });
  const current = createGateway(cfg, { store });
  try {
    await assert.rejects(later.control.status(), /Port/);
    await current.start({ port: 0 });
    await current.control.setSpent('t', 'free', 4);
    await current.stop();
    await later.start({ port: 0 });
    assert.equal((await later.control.status()).accounts[0].allocations[0].spent, 4);
  } finally {
    await later.stop();
    await current.stop();
  }
});

test('A Gateway whose Account pool cannot be saved fails to start and releases its Port', async () => {
  const store = flakyStore();
  store.writable = false;
  const port = await freePort();
  const gateway = createGateway(config(tavily('t', 'tvly-aaaaaaaa')), { store });
  await assert.rejects(gateway.start({ port }), (err) => err instanceof StateNotSaved && !/secret-key/.test(err.message));
  await assertPortAvailable(port, 'a failed start must release the Port');
  await gateway.stop();
});

test('Stopping a Gateway that never started resolves; a stopped Gateway cannot start again', async () => {
  const gateway = createGateway(config(tavily('t', 'tvly-aaaaaaaa')));
  await gateway.stop();
  await assert.rejects(gateway.start({ port: 0 }), /shutting down/i);
  await assert.rejects(gateway.control.status(), /shutting down/i);
});

test('Stopping cancels a pending balance check without a later Account pool write', async () => {
  const store = memoryStore();
  const cfg = config(tavily('a', 'tvly-aaaaaaaa'), tavily('b', 'tvly-bbbbbbbb'));
  let startBody;
  let failBody;
  let signal;
  let calls = 0;
  const started = new Promise((resolve) => { startBody = resolve; });
  const body = new Promise((_resolve, reject) => { failBody = reject; });
  const gateway = createGateway(cfg, {
    store,
    reconcileFetch: async (_url, options) => {
      calls++;
      signal = options.signal;
      return { ok: true, json: () => { startBody(); return body; } };
    }
  });
  const replacement = createGateway(cfg, { store });
  let reconcile;
  await gateway.start({ port: 0 });
  try {
    reconcile = gateway.control.reconcile();
    await started;
    await gateway.stop();
    assert.equal(signal.aborted, true);
    assert.deepEqual(await reconcile, [{ id: 'a', skipped: 'shutdown' }, { id: 'b', skipped: 'shutdown' }]);
    assert.equal(calls, 1, 'stopping starts no balance check on the next Account');

    await replacement.start({ port: 0 });
    await replacement.control.setSpent('a', 'free', 3);
    failBody(new Error('late adapter failure'));
    await new Promise((resolve) => setImmediate(resolve));
    const account = (await replacement.control.status()).accounts[0];
    assert.equal(account.allocations[0].spent, 3);
    assert.equal(account.reconcileError, null, 'a cancelled check is not recorded as a balance error');
    assert.equal(account.providerBalance, null);
  } finally {
    failBody(new Error('cleanup'));
    await reconcile;
    await gateway.stop();
    await replacement.stop();
  }
});

test('Periodic balance checks survive a storage rejection, and the Gateway can still stop', async () => {
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
  const gateway = createGateway(cfg, { store, reconcileFetch: async () => json({ key: { usage: 0, limit: 1000 }, account: {} }) });
  await gateway.start({ port: 0 });
  try {
    failWrites = true;
    await failed;
    await gateway.stop();
    await new Promise((resolve) => setImmediate(resolve)); // A rejected timer task must not become unhandled.
  } finally {
    await gateway.stop();
  }
});

test('A server error after start is logged instead of crashing the process, and the Gateway keeps serving', async () => {
  const lines = [];
  const gateway = createGateway(config(tavily('t', 'tvly-aaaaaaaa')), { logger: (line) => lines.push(line) });
  const { port, url } = await gateway.start({ port: 0 });
  let server;
  const unsubscribe = onServerRequest(port, (message) => { server = message.server; });
  try {
    await fetch(`${url}/health`);
    unsubscribe();
    // An accept failure such as EMFILE reaches the server as an 'error' event; unhandled, it would end the pi process.
    assert.doesNotThrow(() => server.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' })));
    assert.match(lines.join('\n'), /Gateway server error: EMFILE/);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    unsubscribe();
    await gateway.stop();
  }
});

test('In-process health() never rejects: down, ready while serving, unavailable while stopping, then down', async () => {
  let startSearch;
  let finishSearch;
  const started = new Promise((resolve) => { startSearch = resolve; });
  const upstream = new Promise((resolve) => { finishSearch = resolve; });
  const gateway = createGateway(config(tavily('t', 'tvly-aaaaaaaa')), {
    fetchImpl: async () => { startSearch(); await upstream; return json({ results: [] }); }
  });
  assert.deepEqual(await gateway.control.health(), { state: 'down' });
  const { url } = await gateway.start({ port: 0 });
  let search;
  try {
    assert.deepEqual(await gateway.control.health(), { state: 'running', version: VERSION, control: 'ready' });
    search = fetch(`${url}/tavily/search`, {
      method: 'POST', headers: { 'x-api-key': secret, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
    });
    await started;
    const stopping = gateway.stop();
    assert.deepEqual(await gateway.control.health(), { state: 'running', version: VERSION, control: 'unavailable' },
      'what the HTTP adapter reports for a draining Port owner');
    finishSearch();
    assert.equal((await search).status, 200);
    await stopping;
    assert.deepEqual(await gateway.control.health(), { state: 'down' });
  } finally {
    finishSearch();
    await search;
    await gateway.stop();
  }
});

// ---------- HTTP adapter ----------

test('Searches are proxied on the provider-compatible routes and persisted state never contains keys', async () => {
  await serve(config(exa('a', 'exa-real-aaa')), async (url) => json({ results: [{ url }], costDollars: { total: 0.007 } }),
    async ({ post, statePath }) => {
      const res = await post('/exa/search', { query: 'q' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).results[0].url, 'https://api.exa.ai/search');
      assert.ok(!readFileSync(statePath, 'utf8').includes('exa-real-'));
    });
});

test('Every route except /health needs the gateway token; /status never includes keys', async () => {
  let calls = 0;
  await serve(config(tavily('t', 'tvly-small'), tavily('u', 'tvly-other')), async () => { calls++; return json({ results: [] }); },
    async ({ post, base }) => {
      assert.equal((await post('/tavily/search', { query: 'q' }, 'incorrect-key')).status, 401);
      assert.equal((await fetch(`${base}/status`)).status, 401);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      const stat = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${secret}` } });
      assert.equal(stat.status, 200);
      const text = await stat.text();
      assert.ok(!text.includes('tvly-small') && !text.includes('tvly-other'));
      assert.equal(calls, 0);
    });
});

test('A provider key sent to the broker gets a 401 with a configuration hint', async () => {
  await serve(config(tavily('t', 'tvly-aaaaaaaa')), async () => json({}), async ({ post }) => {
    const res = await post('/tavily/search', { query: 'q' }, 'tvly-someone-real-key');
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.match(text, /PI_SEARCH_BROKER_TOKEN/);
    assert.ok(!text.includes('tvly-someone-real-key'));
  });
});

test('Unknown routes, query strings and non-JSON bodies are rejected before any upstream call', async () => {
  let calls = 0;
  await serve(config(tavily('t', 'tvly-aaaaaaaa')), async () => { calls++; return json({}); }, async ({ post, base }) => {
    assert.equal((await post('/tavily/crawl', { url: 'x' })).status, 404);
    assert.equal((await post('/tavily/search?x=1', { query: 'q' })).status, 400);
    const bad = await fetch(`${base}/tavily/search`, { method: 'POST', headers: { 'x-api-key': secret }, body: '[1,2]' });
    assert.equal(bad.status, 400);
    assert.equal(calls, 0);
  });
});

test('An admin change that cannot be saved is a 503 that never echoes the storage error', async () => {
  const store = flakyStore();
  await serve(config(tavily('t', 'tvly-secret-key')), async () => json({ results: [] }), async ({ post, status }) => {
    store.writable = false;
    const change = await post('/admin/disable', { id: 't' });
    assert.equal(change.status, 503);
    assert.doesNotMatch(await change.text(), /secret-key/);
    assert.equal((await status()).accounts[0].status, 'manual', 'the live change is kept');
    assert.equal((await status()).persistence.state, 'unavailable');
    store.writable = true;
    assert.equal((await post('/admin/enable', { id: 't' })).status, 200);
    assert.equal((await status()).persistence.state, 'ok');
  }, { store });
});

test('Admin routes enable, disable and set-spent without restarting', async () => {
  await serve(config(tavily('t-1', 'tvly-managed')), async () => json({ results: [] }), async ({ post, status }) => {
    assert.equal((await post('/admin/disable', { id: 't-1' })).status, 200);
    assert.equal((await post('/tavily/search', { query: 'test' })).status, 429);
    assert.equal((await post('/admin/set-spent', { id: 't-1', allocationId: 'free', spent: 820 })).status, 200);
    assert.equal((await status()).accounts[0].allocations[0].remainingEstimate, 180);
    assert.equal((await post('/tavily/search', { query: 'test' })).status, 200);
    assert.equal((await post('/admin/disable', { id: 't-1' }, 'bad-token')).status, 401);
    assert.equal((await post('/admin/enable', { id: 't-1' })).status, 200);
    assert.equal((await post('/admin/explode', { id: 't-1' })).status, 400);
    const empty = await post('/admin/enable', { id: '' });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'Unknown account id');
    assert.equal((await post('/admin/enable', {})).status, 400);
  });
});

test('A client that disconnects aborts the upstream attempt, which is counted as possibly billed', async () => {
  const client = new AbortController();
  let upstreamAborted;
  const aborted = new Promise((resolve) => { upstreamAborted = resolve; });
  await serve(config(tavily('t', 'tvly-aaaaaaaa')), (_u, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => { upstreamAborted(); reject(opts.signal.reason); });
    client.abort();
  }), async ({ post, status }) => {
    await assert.rejects(post('/tavily/search', { query: 'q' }, secret, {}, client.signal));
    await aborted;
    for (let i = 0; i < 50 && (await status()).accounts[0].possiblyBilled === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await status()).accounts[0].possiblyBilled, 1);
  });
});

test('/health reports the pi-search-broker service; probes also accept the pre-rename id', async () => {
  const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
  await serve(cfg, async () => json({}), async ({ base }) => {
    assert.equal((await (await fetch(`${base}/health`)).json()).service, 'pi-search-broker');
  });
  const answering = (body) => async () => json(body);
  assert.equal((await probeHealth(cfg, { fetchImpl: answering({ service: 'pi-search-broker', version: '0.3.0' }) })).state, 'running');
  assert.equal((await probeHealth(cfg, { fetchImpl: answering({ service: 'pi-dual-key-manager', version: '0.2.0' }) })).state, 'running');
  assert.equal((await probeHealth(cfg, { fetchImpl: answering({ service: 'something-else' }) })).state, 'other');
  assert.equal((await probeHealth(cfg, { fetchImpl: async () => { throw new TypeError('fetch failed'); } })).state, 'down');
});
