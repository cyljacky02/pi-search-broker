// Brokered request: the attempt loop, exercised through execute() with a real pool and controlled providers.
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { broker, config, exa, tavily, json, keyOf, secret, DATE } from './helpers.mjs';
import { EFFECT, ROUTES } from '../src/providers.mjs';
import { CLIENT_CLOSED, createBroker } from '../src/broker.mjs';
import { createAccountPool } from '../src/pool.mjs';
import { memoryStore } from '../src/pool/store.mjs';

const ok = (cost) => json({ results: [], costDollars: { total: cost } });

function partialResponseUntilAbort(signal, { status, headers, chunk, read }) {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      signal.addEventListener('abort', () => controller.error(new DOMException('body aborted', 'AbortError')), { once: true });
    }
  }), { status, headers });
  if (read) {
    const consume = response[read.method].bind(response);
    response[read.method] = () => { read.started(); return consume(); };
  }
  return response;
}

// ---------- rotation and failover ----------

test('Exa fails over from a spent promo account to a second account in the same request', async () => {
  const attempts = [];
  const b = broker(config(exa('early', 'exa-real-aaa', '2026-11-10T00:00:00Z'), exa('later', 'exa-real-bbb', '2026-12-01T00:00:00Z')),
    async (url, opts) => {
      attempts.push({ url, key: keyOf(opts) });
      return keyOf(opts) === 'exa-real-aaa' ? json({ error: 'quota exhausted' }, 402) : json({ results: [{ title: 'good' }], costDollars: { total: 0.013 } });
    });
  const res = await b.call('/exa/search', { query: 'test', type: 'auto', numResults: 5, contents: { highlights: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => r.title), ['good']);
  assert.deepEqual(attempts.map((x) => x.key), ['exa-real-aaa', 'exa-real-bbb']);
  assert.equal(attempts[0].url, 'https://api.exa.ai/search');
  assert.equal(b.account(0).status, 'quota');
  assert.equal(b.account(1).allocations[0].spent, 0.013);
  assert.equal(b.account(1).requests, 1);
});

test('Tavily rate limiting cools the account down and tries another one immediately', async () => {
  const keys = [];
  const b = broker(config(tavily('t-a', 'tvly-aaaaa'), tavily('t-b', 'tvly-bbbbb')), async (_u, opts) => {
    keys.push(keyOf(opts));
    return keyOf(opts) === 'Bearer tvly-aaaaa' ? json({ error: 'rate limited' }, 429, { 'Retry-After': '45' }) : json({ results: [] });
  });
  assert.equal((await b.call('/tavily/search', { query: 'hello', search_depth: 'advanced' })).status, 200);
  assert.deepEqual(keys, ['Bearer tvly-aaaaa', 'Bearer tvly-bbbbb']);
  assert.equal(b.account(0).status, 'cooldown');
  assert.equal(b.account(0).retryAt, new Date(b.time.ms + 45000).toISOString());
  assert.equal(b.account(1).allocations[0].spent, 2);
  assert.equal((await b.call('/tavily/search', { query: 'again' })).status, 200);
  assert.deepEqual(keys.slice(2), ['Bearer tvly-bbbbb']);
});

test('Exa /contents rotates on 401 and disables the bad account', async () => {
  const calls = [];
  const b = broker(config(exa('a', 'exa-bad-aaa', '2026-11-11T00:00:00Z'), exa('b', 'exa-ok-bbb', '2026-11-12T00:00:00Z')), async (url, opts) => {
    calls.push(url);
    return keyOf(opts) === 'exa-bad-aaa' ? json({ error: 'invalid key' }, 401) : ok(0.002);
  });
  assert.equal((await b.call('/exa/contents', { urls: ['https://site.test'], text: true })).status, 200);
  assert.deepEqual(calls, ['https://api.exa.ai/contents', 'https://api.exa.ai/contents']);
  assert.equal(b.account(0).status, 'auth');
  assert.equal(b.account(1).allocations[0].spent, 0.002);
});

test('Accounts too close to empty for the estimate are skipped; more remaining wins at equal expiry', async () => {
  const small = { ...tavily('small', 'tvly-small'), allocations: [{ id: 'free', limit: 1, period: 'monthly' }] };
  const calls = [];
  const b = broker(config(small, tavily('other', 'tvly-other')), async (_u, opts) => { calls.push(keyOf(opts)); return json({ results: [] }); });
  assert.equal((await b.call('/tavily/search', { query: 'first' })).status, 200);
  assert.equal((await b.call('/tavily/search', { query: 'second' })).status, 200);
  assert.deepEqual(calls, ['Bearer tvly-other', 'Bearer tvly-other']);
});

test('Concurrent requests cannot overspend a tiny allocation: the held estimate blocks the second', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived;
  const firstArrived = new Promise((resolve) => { arrived = resolve; });
  const small = { ...tavily('a', 'tvly-very-small'), allocations: [{ id: 'only', limit: 1, period: 'monthly' }] };
  let count = 0;
  const b = broker(config(small), async () => { count++; arrived(); await gate; return json({ results: [] }); });
  const first = b.call('/tavily/search', { query: 'one' });
  await firstArrived;
  assert.equal((await b.call('/tavily/search', { query: 'two' })).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal(count, 1);
});

// ---------- allocations over time ----------

test('Promo is spent before the recurring free allocation even when free resets sooner', async () => {
  const b = broker(config(exa('a', 'exa-promo-xxxx', '2026-12-20T00:00:00Z')), async () => ok(0.02));
  assert.equal((await b.call('/exa/search', { query: 'q' })).status, 200);
  assert.equal(b.account(0).allocations[0].spent, 0.02);
  assert.equal(b.account(0).allocations[1].spent, 0);
});

test('After promo expiry the monthly allocation stays usable; monthly spend resets next month', async () => {
  const time = { ms: Date.parse('2026-11-12T00:00:00Z') };
  const b = broker(config(exa('exa-a', 'exa-aaaaa', '2026-11-11T00:00:00Z')), async () => ok(1), { time });
  assert.equal((await b.call('/exa/search', { query: 'test' })).status, 200);
  const [promo, free] = b.account(0).allocations;
  assert.equal(promo.active, false);
  assert.equal(promo.remainingEstimate, 0);
  assert.equal(free.remainingEstimate, 9);
  time.ms = Date.parse('2026-12-01T00:01:00Z');
  assert.equal(b.account(0).allocations[1].remainingEstimate, 10);
});

test('A quota block re-opens at promo expiry so the same account can use its monthly allocation', async () => {
  const time = { ms: Date.parse('2026-11-09T06:00:00Z') };
  let calls = 0;
  const b = broker(config(exa('a', 'exa-promo-abc', '2026-11-10T00:00:00Z')),
    async () => (++calls === 1 ? json({ error: 'exhausted' }, 402) : ok(0.01)), { time });
  assert.equal((await b.call('/exa/search', { query: 'q' })).status, 429);
  assert.equal(b.account(0).status, 'quota');
  time.ms = Date.parse('2026-11-10T00:01:00Z');
  assert.equal((await b.call('/exa/search', { query: 'q' })).status, 200);
  assert.equal(b.account(0).status, 'active');
  assert.equal(b.account(0).allocations[1].spent, 0.01);
  assert.equal(calls, 2);
});

// ---------- Exa error semantics ----------

test('Exa 403 PROHIBITED_CONTENT is returned once and never rotated or used to disable accounts', async () => {
  const calls = [];
  const b = broker(config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb')),
    async (_u, opts) => { calls.push(keyOf(opts)); return json({ requestId: 'r1', error: 'refused for exa-key-aaaa', tag: 'PROHIBITED_CONTENT' }, 403); });
  const res = await b.call('/exa/search', { query: 'bad' });
  assert.equal(res.status, 403);
  assert.equal(res.body.tag, 'PROHIBITED_CONTENT');
  assert.equal(res.body.requestId, 'r1');
  assert.ok(!JSON.stringify(res.body).includes('exa-key-aaaa'));
  assert.equal(calls.length, 1, 'a refused query must not be sent to another team');
  assert.equal(b.account(0).status, 'active');
  assert.equal(b.account(1).status, 'active');
});

test('Exa 403 TEAM_BLOCKED disables that account and rotates', async () => {
  const b = broker(config(exa('a', 'exa-key-aaaa', '2026-11-20T00:00:00Z'), exa('b', 'exa-key-bbbb')),
    async (_u, opts) => (keyOf(opts) === 'exa-key-aaaa' ? json({ error: 'revoked', tag: 'TEAM_BLOCKED' }, 403) : ok(0.007)));
  assert.equal((await b.call('/exa/search', { query: 'q' })).status, 200);
  assert.equal(b.account(0).status, 'blocked');
  assert.equal(b.account(0).lastErrorTag, 'TEAM_BLOCKED');
});

test('Exa 403 FEATURE_DISABLED tries exactly one other account, disables nobody, then returns the 403', async () => {
  let calls = 0;
  const b = broker(config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb'), exa('c', 'exa-key-cccc')),
    async () => { calls++; return json({ error: 'Snapshot is not on this plan', tag: 'FEATURE_DISABLED' }, 403); });
  const res = await b.call('/exa/search', { query: 'q' });
  assert.equal(res.status, 403);
  assert.equal(res.body.tag, 'FEATURE_DISABLED');
  assert.equal(calls, 2, 'one other account, not the whole pool');
  for (let i = 0; i < 3; i++) assert.equal(b.account(i).status, 'active');
});

test('A client closing during a 403 error-body read ends the request without retrying or billing it', async () => {
  const client = new AbortController();
  let reading;
  const bodyReadStarted = new Promise((resolve) => { reading = resolve; });
  let calls = 0;
  const b = broker(config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb')), async (_u, opts) => {
    calls++;
    return partialResponseUntilAbort(opts.signal, {
      status: 403, chunk: '{"tag":', read: { method: 'text', started: reading }
    });
  });
  const pending = b.call('/exa/search', { query: 'q' }, { signal: client.signal });
  await bodyReadStarted;
  client.abort();
  const res = await pending;
  assert.equal(res.status, CLIENT_CLOSED);
  assert.equal(res.body, null);
  assert.equal(calls, 1);
  assert.equal(b.account(0).possiblyBilled, 0);
  assert.equal(b.account(0).allocations[0].spent, 0);
  assert.equal(b.account(0).status, 'active');
  assert.equal(b.status().recent.at(-1).status, 403);
});

test('A client closing during a 429 error-body read still applies the provider rate limit without rotating', async () => {
  const client = new AbortController();
  let reading;
  const bodyReadStarted = new Promise((resolve) => { reading = resolve; });
  let calls = 0;
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), async (_u, opts) => {
    calls++;
    return partialResponseUntilAbort(opts.signal, {
      status: 429, headers: { 'Retry-After': '45' }, chunk: '{"detail":', read: { method: 'text', started: reading }
    });
  });
  const pending = b.call('/tavily/search', { query: 'q' }, { signal: client.signal });
  await bodyReadStarted;
  client.abort();
  assert.deepEqual(await pending, { status: CLIENT_CLOSED, body: null });
  assert.equal(calls, 1);
  assert.equal(b.account(0).status, 'cooldown');
  assert.equal(b.account(0).retryAt, new Date(b.time.ms + 45000).toISOString());
  assert.equal(b.account(0).possiblyBilled, 0);
  assert.equal(b.account(0).allocations[0].spent, 0);
  assert.equal(b.status().recent.at(-1).status, 429);
});

test('An Exa 403 whose error body times out remains a refusal and is never retried', async (t) => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  let calls = 0;
  const cfg = { ...config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb')), attemptTimeoutMs: 50 };
  const b = broker(cfg, async (_u, opts) => {
    calls++;
    return partialResponseUntilAbort(opts.signal, { status: 403, chunk: '{"tag":' });
  });
  const res = await b.call('/exa/search', { query: 'q' });
  assert.equal(res.status, 403);
  assert.equal(calls, 1);
  assert.equal(b.account(0).possiblyBilled, 0);
  assert.equal(b.account(0).allocations[0].spent, 0);
  assert.equal(b.account(0).status, 'active');
  assert.equal(b.status().recent.at(-1).status, 403);
});

test('Exa 503 SERVICE_OVERLOADED retries with backoff without cooling the account down', async () => {
  let calls = 0;
  const b = broker(config(exa('only', 'exa-key-only')),
    async () => (++calls === 1 ? json({ error: 'overloaded', tag: 'SERVICE_OVERLOADED' }, 503) : ok(0.007)));
  assert.equal((await b.call('/exa/search', { query: 'q' })).status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(b.sleeps, [250]);
  assert.equal(b.account(0).status, 'active');
});

test('A client closing during transient backoff returns promptly without a second attempt', async () => {
  const client = new AbortController();
  let sleeping;
  const sleepStarted = new Promise((resolve) => { sleeping = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cfg = config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb'));
  const pool = createAccountPool(cfg.accounts, { store: memoryStore(), now: () => DATE });
  let calls = 0;
  const b = createBroker({ pool, limits: cfg, now: () => DATE,
    fetchImpl: async () => { calls++; return json({ error: 'overloaded', tag: 'SERVICE_OVERLOADED' }, 503); },
    sleep: () => { sleeping(); return gate; }
  });
  const pending = b.execute(ROUTES['/exa/search'], { query: 'q' }, { signal: client.signal });
  await sleepStarted;
  client.abort();
  let timer;
  const result = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), 100); })]);
  clearTimeout(timer);
  release();
  await pending;
  assert.deepEqual(result, { status: CLIENT_CLOSED, body: null });
  assert.equal(calls, 1);
  assert.equal(pool.snapshot().accounts[0].possiblyBilled, 0);
  assert.equal(pool.snapshot().accounts[0].allocations[0].spent, 0);
  assert.equal(pool.snapshot().recent.at(-1).status, 503);
});

test('Persistent Exa 503 gives up after maxTransientRetries with 503 (transient for pi fallback)', async () => {
  let calls = 0;
  const b = broker(config(exa('only', 'exa-key-only')), async () => { calls++; return json({ error: 'overloaded', tag: 'SERVICE_OVERLOADED' }, 503); });
  assert.equal((await b.call('/exa/search', { query: 'q' })).status, 503);
  assert.equal(calls, 3);
  assert.deepEqual(b.sleeps, [250, 500]);
  assert.equal(b.account(0).status, 'active');
});

test('Other 5xx rotate with a 10 s cooldown; all failing returns 503', async () => {
  let calls = 0;
  const b = broker(config(exa('a', 'exa-key-aaaa'), tavily('t', 'tvly-aaaaaaaa'), exa('b', 'exa-key-bbbb')),
    async () => { calls++; return json({ error: 'boom' }, 500); });
  assert.equal((await b.call('/exa/search', { query: 'q' })).status, 503);
  assert.equal(calls, 2);
  assert.deepEqual(b.sleeps, []);
  assert.equal(b.account(0).status, 'cooldown');
  assert.equal(b.account(0).cooldownReason, EFFECT.UPSTREAM);
  b.time.ms += 10001;
  assert.equal(b.account(0).status, 'active');
});

test('Provider bad request is not rotated and keys never appear in the error body', async () => {
  let calls = 0;
  const b = broker(config(exa('a', 'exa-secret-a'), exa('b', 'exa-secret-b')),
    async () => { calls++; return json({ error: 'exa-secret-a invalid query' }, 400); });
  const res = await b.call('/exa/search', { query: 'bad' });
  assert.equal(res.status, 400);
  assert.ok(!JSON.stringify(res.body).includes('exa-secret-a'));
  assert.equal(calls, 1);
});

// ---------- Tavily error semantics ----------

test('Tavily 433 (PayGo limit) rotates and marks quota; all exhausted returns 429', async () => {
  const keys = [];
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async (_u, opts) => { keys.push(keyOf(opts)); return json({ detail: { error: 'PayGo limit exceeded' } }, 433); });
  assert.equal((await b.call('/tavily/search', { query: 'q' })).status, 429);
  assert.equal(keys.length, 2);
  assert.equal(b.account(0).status, 'quota');
  assert.equal(b.account(1).status, 'quota');
});

test('Tavily 434 (flex capacity) rotates without penalty; all 434 returns 503', async () => {
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async () => json({ detail: { error: 'Flex tier capacity exceeded' } }, 434));
  assert.equal((await b.call('/tavily/search', { query: 'q', max_age_hours: 1 })).status, 503);
  assert.equal(b.account(0).status, 'active');
});

test('Tavily 403 on /search cools the account down for 10 minutes instead of disabling it', async () => {
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async (_u, opts) => (keyOf(opts) === 'Bearer tvly-aaaaaaaa' ? json({ detail: { error: 'Forbidden' } }, 403) : json({ results: [] })));
  assert.equal((await b.call('/tavily/search', { query: 'q' })).status, 200);
  assert.equal(b.account(0).status, 'cooldown');
  assert.equal(b.account(0).cooldownReason, 'forbidden');
  b.time.ms += 10 * 60 * 1000 + 1;
  assert.equal(b.account(0).status, 'active');
});

test('Quota wins over transient when reporting exhaustion (order independent)', async () => {
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async (_u, opts) => (keyOf(opts) === 'Bearer tvly-aaaaaaaa' ? json({ detail: { error: 'capacity' } }, 434) : json({ detail: { error: 'rate' } }, 429)));
  assert.equal((await b.call('/tavily/search', { query: 'q' })).status, 429);
});

test('Non-retryable Tavily errors are passed through sanitized, in the provider shape', async () => {
  const b = broker(config(tavily('t', 'tvly-aaaaaaaa')), async () => json({ detail: { error: 'Invalid topic for key tvly-aaaaaaaa' } }, 400));
  const res = await b.call('/tavily/search', { query: 'q', topic: 'nope' });
  assert.equal(res.status, 400);
  assert.match(res.body.detail.error, /Invalid topic/);
  assert.ok(!JSON.stringify(res.body).includes('tvly-aaaaaaaa'));
});

// ---------- request shaping and accounting ----------

test('stream: true is rejected before any upstream call', async () => {
  let calls = 0;
  const b = broker(config(exa('a', 'exa-key-aaaa'), tavily('t', 'tvly-aaaaaaaa')), async () => { calls++; return json({}); });
  const e = await b.call('/exa/search', { query: 'q', stream: true, outputSchema: {} });
  assert.equal(e.status, 400);
  assert.equal(e.body.tag, 'BROKER_UNSUPPORTED');
  assert.equal((await b.call('/tavily/search', { query: 'q', stream: true })).status, 400);
  assert.equal(calls, 0);
});

test('Tavily: body api_key is stripped, include_usage is injected, usage.credits is recorded exactly', async () => {
  const bodies = [];
  const b = broker(config(tavily('t', 'tvly-aaaaaaaa')),
    async (_u, opts) => { bodies.push(JSON.parse(opts.body)); return json({ results: [], usage: { credits: 2 }, request_id: 'tv-123' }); });
  const res = await b.call('/tavily/search', { query: 'q', api_key: secret });
  assert.equal(bodies[0].api_key, undefined, 'the gateway token must never reach Tavily');
  assert.equal(bodies[0].include_usage, true);
  assert.equal(res.body.usage, undefined, 'usage is hidden when the client did not ask for it');
  assert.equal(b.account(0).allocations[0].spent, 2);
  assert.equal(b.account(0).lastRequestId, 'tv-123');
  assert.deepEqual((await b.call('/tavily/search', { query: 'q', include_usage: true })).body.usage, { credits: 2 });
});

test('Tavily reported usage.credits of 0 is exact (not replaced by the estimate)', async () => {
  const b = broker(config(tavily('t', 'tvly-aaaaaaaa')), async () => json({ results: [], usage: { credits: 0 } }));
  assert.equal((await b.call('/tavily/search', { query: 'q' })).status, 200);
  assert.equal(b.account(0).allocations[0].spent, 0);
});

test('Exa integration and beta headers are forwarded only when well-formed; client auth never is', async () => {
  const seen = [];
  const b = broker(config(exa('a', 'exa-key-aaaa')), async (_u, opts) => { seen.push(opts.headers); return json({ results: [], requestId: 'abc123' }); });
  await b.call('/exa/search', { query: 'q' }, { headers: { 'x-api-key': secret, 'x-exa-integration': 'my-tool', 'exa-beta': 'dynamic-highlights-2026-08-28' } });
  await b.call('/exa/search', { query: 'q' }, { headers: { 'x-exa-integration': 'bad value with spaces' } });
  assert.equal(seen[0]['x-exa-integration'], 'my-tool');
  assert.equal(seen[0]['Exa-Beta'], 'dynamic-highlights-2026-08-28');
  assert.equal(seen[1]['x-exa-integration'], 'pi-web-access');
  assert.ok(!JSON.stringify(seen).includes(secret));
  const snap = b.status();
  assert.equal(snap.accounts[0].lastRequestId, 'abc123');
  assert.equal(snap.recent.length, 2);
  assert.ok(!JSON.stringify(snap).includes('exa-key-aaaa'));
});

// ---------- possibly billed ----------

test('A provider that consumes the request then closes without headers is possibly billed and never rotated', async (t) => {
  const received = [];
  const server = createServer((req) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push({ body: JSON.parse(body), authorization: req.headers.authorization }); req.socket.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/search`;
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    (_url, opts) => fetch(url, opts));

  const res = await b.call('/tavily/search', { query: 'delivered', search_depth: 'advanced' });
  assert.equal(received.length, 1, 'never send the same possibly billed request to a second account');
  assert.equal(received[0].body.query, 'delivered');
  assert.equal(received[0].body.search_depth, 'advanced');
  assert.equal(received[0].authorization, 'Bearer tvly-aaaaaaaa');
  assert.equal(res.status, 503);
  assert.match(res.body.detail.error, /not retried to avoid double billing/);
  assert.ok(!JSON.stringify(res.body).includes('tvly-aaaaaaaa'));
  assert.equal(b.account(0).status, 'active');
  assert.equal(b.account(0).possiblyBilled, 1);
  assert.equal(b.account(0).allocations[0].spent, 2);
  assert.equal(b.account(0).requests, 0);
  assert.equal(b.account(1).allocations[0].spent, 0);
  assert.equal(b.status().recent.at(-1).status, 'ambiguous-network');
});

test('Attempt timeout is possibly billed, never cools down, and is never retried on another account', async () => {
  const keys = [];
  const b = broker(config(exa('a', 'exa-key-aaaa', '2026-11-20T00:00:00Z'), exa('b', 'exa-key-bbbb')), async (_u, opts) => {
    keys.push(keyOf(opts));
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  const res = await b.call('/exa/search', { query: 'q', numResults: 5 });
  assert.equal(res.status, 504, 'pi classifies 504 as transient and falls back to the other provider');
  assert.match(res.body.error, /not retried to avoid double billing/);
  assert.deepEqual(keys, ['exa-key-aaaa'], 'a second account would risk billing the same request twice');
  const a = b.account(0);
  assert.equal(a.status, 'active');
  assert.equal(a.possiblyBilled, 1);
  assert.equal(a.allocations[0].spent, 0.007);
  assert.equal(a.requests, 0);
});

test('An attempt deadline reported by fetch as AbortError remains a 504 timeout', async (t) => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  let calls = 0;
  const cfg = { ...config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), attemptTimeoutMs: 50 };
  const b = broker(cfg, (_u, opts) => new Promise((_resolve, reject) => {
    calls++;
    opts.signal.addEventListener('abort', () => reject(new DOMException('request aborted', 'AbortError')), { once: true });
  }));
  const res = await b.call('/tavily/search', { query: 'q' });
  assert.equal(res.status, 504);
  assert.match(res.body.detail.error, /not retried to avoid double billing/);
  assert.equal(calls, 1);
  assert.equal(b.account(0).possiblyBilled, 1);
  assert.equal(b.account(0).allocations[0].spent, 1);
  assert.equal(b.status().recent.at(-1).status, 'timeout');
});

test('A client that goes away mid-attempt aborts upstream; the attempt is possibly billed and not retried', async () => {
  const client = new AbortController();
  let calls = 0;
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), (_u, opts) => new Promise((_resolve, reject) => {
    calls++;
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    client.abort();
  }));
  const res = await b.call('/tavily/search', { query: 'q' }, { signal: client.signal });
  assert.equal(res.status, CLIENT_CLOSED);
  assert.equal(calls, 1);
  assert.equal(b.account(0).possiblyBilled, 1);
  assert.equal(b.account(0).allocations[0].spent, 1);
  assert.equal(b.status().recent.at(-1).status, 'client-closed');
});

test('A client closing while reading a 2xx body is client-closed and possibly billed', async () => {
  const client = new AbortController();
  let reading;
  const bodyReadStarted = new Promise((resolve) => { reading = resolve; });
  let calls = 0;
  const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), async (_u, opts) => {
    calls++;
    return partialResponseUntilAbort(opts.signal, {
      status: 200, chunk: '{"results":', read: { method: 'json', started: reading }
    });
  });
  const pending = b.call('/tavily/search', { query: 'q' }, { signal: client.signal });
  await bodyReadStarted;
  client.abort();
  const res = await pending;
  assert.equal(res.status, CLIENT_CLOSED);
  assert.equal(res.body, null);
  assert.equal(calls, 1);
  assert.equal(b.account(0).possiblyBilled, 1);
  assert.equal(b.account(0).allocations[0].spent, 1);
  assert.equal(b.account(1).allocations[0].spent, 0);
  assert.equal(b.status().recent.at(-1).status, 'client-closed');
});

test('A timeout while reading a 2xx body is a timeout and possibly billed even if the stream throws AbortError', async (t) => {
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout uses an unref'ed timer.
  t.after(() => clearTimeout(keepAlive));
  let calls = 0;
  const cfg = { ...config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), attemptTimeoutMs: 50 };
  const b = broker(cfg, async (_u, opts) => {
    calls++;
    return partialResponseUntilAbort(opts.signal, { status: 200, chunk: '{"results":' });
  });
  const res = await b.call('/tavily/search', { query: 'q' });
  assert.equal(res.status, 504);
  assert.match(res.body.detail.error, /not retried to avoid double billing/);
  assert.equal(calls, 1);
  assert.equal(b.account(0).possiblyBilled, 1);
  assert.equal(b.account(0).allocations[0].spent, 1);
  assert.equal(b.account(1).allocations[0].spent, 0);
  assert.equal(b.status().recent.at(-1).status, 'timeout');
});

test('Client closure takes precedence over TimeoutError during fetch and a 2xx body read', async () => {
  for (const phase of ['fetch', 'body']) {
    const client = new AbortController();
    let calls = 0;
    const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), async () => {
      calls++;
      const interrupt = () => { client.abort(); throw new DOMException('timed out', 'TimeoutError'); };
      if (phase === 'fetch') return interrupt();
      const response = json({ results: [] });
      response.json = async () => interrupt();
      return response;
    });
    const res = await b.call('/tavily/search', { query: 'q' }, { signal: client.signal });
    assert.deepEqual(res, { status: CLIENT_CLOSED, body: null }, phase);
    assert.equal(calls, 1, phase);
    assert.equal(b.account(0).possiblyBilled, 1, phase);
    assert.equal(b.account(0).allocations[0].spent, 1, phase);
    assert.equal(b.account(1).allocations[0].spent, 0, phase);
    assert.equal(b.status().recent.length, 1, phase);
    assert.equal(b.status().recent[0].status, 'client-closed', phase);
  }
});

test('TimeoutError during fetch or a 2xx body read is secret-safe and never rotated', async () => {
  for (const phase of ['fetch', 'body']) {
    let calls = 0;
    const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), async () => {
      calls++;
      const error = Object.assign(new Error(`timed out with tvly-aaaaaaaa and ${secret}`), { name: 'TimeoutError', code: 'ECONNREFUSED' });
      if (phase === 'fetch') throw error;
      const response = json({ results: [] });
      response.json = async () => { throw error; };
      return response;
    });
    const res = await b.call('/tavily/search', { query: 'q' });
    assert.equal(res.status, 504, phase);
    assert.match(res.body.detail.error, /not retried to avoid double billing/, phase);
    assert.ok(!JSON.stringify(res.body).includes('tvly-aaaaaaaa'), phase);
    assert.ok(!JSON.stringify(res.body).includes(secret), phase);
    assert.equal(calls, 1, phase);
    assert.equal(b.account(0).possiblyBilled, 1, phase);
    assert.equal(b.account(0).allocations[0].spent, 1, phase);
    assert.equal(b.account(1).allocations[0].spent, 0, phase);
    assert.equal(b.status().recent.length, 1, phase);
    assert.equal(b.status().recent[0].status, 'timeout', phase);
  }
});

test('An unreadable 2xx body is possibly billed and not retried on another account', async () => {
  let calls = 0;
  const b = broker(config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb')), async () => { calls++; return new Response('<html>', { status: 200 }); });
  const res = await b.call('/exa/search', { query: 'q' });
  assert.equal(res.status, 502);
  assert.equal(calls, 1);
  assert.equal(b.account(0).possiblyBilled + b.account(1).possiblyBilled, 1);
});

test('An unreadable 2xx body containing secrets is not exposed to the client', async () => {
  const b = broker(config(exa('a', 'exa-key-aaaa')), async () => new Response(`<html>exa-key-aaaa ${secret}`, { status: 200 }));
  const res = await b.call('/exa/search', { query: 'q' });
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res.body).includes('exa-key-aaaa'));
  assert.ok(!JSON.stringify(res.body).includes(secret));
  assert.equal(b.account(0).possiblyBilled, 1);
  assert.equal(b.status().recent.length, 1);
  assert.equal(b.status().recent[0].status, 'invalid-response');
});

test('Generic failures, resets, socket closes and conflicting cause codes are never proof of non-delivery', async () => {
  const coded = (code, cause) => Object.assign(new Error(`failure with tvly-aaaaaaaa and ${secret}`, { cause }), { code });
  const cyclic = coded('ECONNREFUSED');
  cyclic.cause = cyclic;
  const failures = [
    new TypeError(`fetch failed with tvly-aaaaaaaa and ${secret}`),
    new TypeError('fetch failed', { cause: coded('ECONNRESET') }),
    new TypeError('fetch failed', { cause: coded('UND_ERR_SOCKET') }),
    new TypeError('fetch failed', { cause: coded('EPIPE') }),
    new TypeError('fetch failed', { cause: coded('ECONNRESET', coded('ECONNREFUSED')) }),
    new TypeError('fetch failed', { cause: new AggregateError([coded('ECONNRESET')], 'mixed failures', { cause: coded('ECONNREFUSED') }) }),
    new TypeError('fetch failed', { cause: cyclic })
  ];
  for (const error of failures) {
    let calls = 0;
    const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
      async () => { calls++; throw error; });
    const res = await b.call('/tavily/search', { query: 'q' });
    assert.equal(res.status, 503);
    assert.match(res.body.detail.error, /not retried to avoid double billing/);
    assert.ok(!JSON.stringify(res.body).includes('tvly-aaaaaaaa'));
    assert.ok(!JSON.stringify(res.body).includes(secret));
    assert.equal(calls, 1);
    assert.equal(b.account(0).possiblyBilled, 1);
    assert.equal(b.account(0).allocations[0].spent, 1);
    assert.equal(b.account(1).allocations[0].spent, 0);
    assert.equal(b.account(0).status, 'active');
    assert.equal(b.status().recent.at(-1).status, 'ambiguous-network');
  }
});

test('Proven pre-delivery connection failures rotate without charging the failed account', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    let calls = 0;
    const b = broker(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')), async () => {
      if (++calls === 1) {
        const cause = Object.assign(new Error('connect failed'), { code });
        throw new TypeError('fetch failed', { cause: new Error('wrapped', { cause }) });
      }
      return json({ results: [] });
    });
    const res = await b.call('/tavily/search', { query: 'q' });
    assert.equal(res.status, 200, code);
    assert.equal(calls, 2, code);
    assert.deepEqual(b.sleeps, [], code);
    assert.equal(b.account(0).cooldownReason, EFFECT.UPSTREAM, code);
    assert.equal(b.account(0).possiblyBilled, 0, code);
    assert.equal(b.account(0).allocations[0].spent, 0, code);
    assert.equal(b.account(1).allocations[0].spent, 1, code);
    assert.equal(b.status().recent[0].status, 'network', code);
  }
});

test('If preparing the upstream request throws, nothing is sent and the reserved credit comes back', async () => {
  let calls = 0;
  const b = broker(config(exa('a', 'exa-key-aaaa')), async () => { calls++; return ok(0.007); });
  const headers = { get 'x-exa-integration'() { throw new Error('unreadable header'); } };
  await assert.rejects(b.call('/exa/search', { query: 'q' }, { headers }), /unreadable header/);
  assert.equal(calls, 0);
  const a = b.account(0);
  assert.equal(a.available, 70, 'all 60 promo + 10 free is available again');
  assert.deepEqual([a.failures, a.possiblyBilled, a.status], [0, 0, 'active']);
});
