// Gateway: the HTTP adapter only (auth, routing, admin routes, client disconnects).
// Rotation, billing and unsaved-state replies are tested through execute() in broker.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serve, config, exa, tavily, json, secret, flakyStore } from './helpers.mjs';
import { probeHealth } from '../src/control.mjs';

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
