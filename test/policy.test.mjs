import test from 'node:test';
import assert from 'node:assert/strict';
import { run, config, exa, tavily, json, secret } from './helpers.mjs';
import { PROVIDERS, ACTION, EFFECT } from '../src/providers.mjs';

const quote = (provider, path, body) => PROVIDERS[provider].quote(path, body);

const keyOf = (opts) => opts.headers['x-api-key'] ?? opts.headers.Authorization;
const status = (manager, i) => manager.snapshot().accounts[i];

test('Exa 403 PROHIBITED_CONTENT is returned once and never rotated or used to disable accounts', async () => {
  const calls = [];
  await run(config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb')),
    async (_u, opts) => { calls.push(keyOf(opts)); return json({ requestId: 'r1', error: 'refused for exa-key-aaaa', tag: 'PROHIBITED_CONTENT' }, 403); },
    async ({ post, manager }) => {
      const res = await post('/exa/search', { query: 'bad' });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.tag, 'PROHIBITED_CONTENT');
      assert.equal(body.requestId, 'r1');
      assert.ok(!JSON.stringify(body).includes('exa-key-aaaa'));
      assert.equal(calls.length, 1, 'a refused query must not be sent to another team');
      assert.equal(status(manager, 0).status, 'active');
      assert.equal(status(manager, 1).status, 'active');
    });
});

test('Exa 403 TEAM_BLOCKED disables that account and rotates', async () => {
  await run(config(exa('a', 'exa-key-aaaa', '2026-11-20T00:00:00Z'), exa('b', 'exa-key-bbbb')),
    async (_u, opts) => keyOf(opts) === 'exa-key-aaaa'
      ? json({ error: 'revoked', tag: 'TEAM_BLOCKED' }, 403)
      : json({ results: [], costDollars: { total: 0.007 } }),
    async ({ post, manager }) => {
      assert.equal((await post('/exa/search', { query: 'q' })).status, 200);
      assert.equal(status(manager, 0).status, 'blocked');
      assert.equal(status(manager, 0).lastErrorTag, 'TEAM_BLOCKED');
    });
});

test('Exa 403 FEATURE_DISABLED tries exactly one other account, disables nobody, then returns the 403', async () => {
  let calls = 0;
  await run(config(exa('a', 'exa-key-aaaa'), exa('b', 'exa-key-bbbb'), exa('c', 'exa-key-cccc')),
    async () => { calls++; return json({ error: 'Snapshot is not on this plan', tag: 'FEATURE_DISABLED' }, 403); },
    async ({ post, manager }) => {
      const res = await post('/exa/search', { query: 'q' });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).tag, 'FEATURE_DISABLED');
      assert.equal(calls, 2, 'one other account, not the whole pool');
      for (let i = 0; i < 3; i++) assert.equal(status(manager, i).status, 'active');
    });
});

test('Exa 402 X402_PAYMENT_REQUIRED is treated as a credential problem, other 402 as quota', () => {
  const classify = (...args) => PROVIDERS.exa.classify('/search', ...args);
  assert.equal(classify(402, { tag: 'X402_PAYMENT_REQUIRED' }).effect, EFFECT.AUTH);
  assert.equal(classify(402, { tag: 'NO_MORE_CREDITS' }).effect, EFFECT.QUOTA);
  const network = { get: (h) => (h === 'x-ratelimit-scope' ? 'network' : null) };
  assert.equal(classify(429, {}, network).action, ACTION.PASSTHROUGH);
});

test('Exa 503 SERVICE_OVERLOADED retries with backoff without cooling the account down', async () => {
  let calls = 0;
  await run(config(exa('only', 'exa-key-only')),
    async () => (++calls === 1 ? json({ error: 'overloaded', tag: 'SERVICE_OVERLOADED' }, 503) : json({ results: [], costDollars: { total: 0.007 } })),
    async ({ post, manager, sleeps }) => {
      assert.equal((await post('/exa/search', { query: 'q' })).status, 200);
      assert.equal(calls, 2);
      assert.deepEqual(sleeps, [250]);
      assert.equal(status(manager, 0).status, 'active');
    });
});

test('Persistent Exa 503 gives up after maxTransientRetries with 503 (transient for pi fallback)', async () => {
  let calls = 0;
  await run(config(exa('only', 'exa-key-only')),
    async () => { calls++; return json({ error: 'overloaded', tag: 'SERVICE_OVERLOADED' }, 503); },
    async ({ post, manager, sleeps }) => {
      assert.equal((await post('/exa/search', { query: 'q' })).status, 503);
      assert.equal(calls, 3);
      assert.deepEqual(sleeps, [250, 500]);
      assert.equal(status(manager, 0).status, 'active');
    });
});

test('Other 5xx rotate with a short 10 s cooldown (unchanged behaviour); all failing returns 503', async () => {
  let calls = 0;
  await run(config(exa('a', 'exa-key-aaaa'), tavily('t', 'tvly-aaaaaaaa'), exa('b', 'exa-key-bbbb')),
    async () => { calls++; return json({ error: 'boom' }, 500); },
    async ({ post, manager, sleeps, time }) => {
      assert.equal((await post('/exa/search', { query: 'q' })).status, 503);
      assert.equal(calls, 2);
      assert.deepEqual(sleeps, []);
      assert.equal(status(manager, 0).status, 'cooldown');
      assert.equal(status(manager, 0).cooldownReason, EFFECT.UPSTREAM);
      time.ms += 10001;
      assert.equal(status(manager, 0).status, 'active');
    });
});

test('Tavily 433 (PayGo limit) rotates and marks quota; all exhausted returns 429', async () => {
  const keys = [];
  await run(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async (_u, opts) => { keys.push(keyOf(opts)); return json({ detail: { error: 'PayGo limit exceeded' } }, 433); },
    async ({ post, manager }) => {
      assert.equal((await post('/tavily/search', { query: 'q' })).status, 429);
      assert.equal(keys.length, 2);
      assert.equal(status(manager, 0).status, 'quota');
      assert.equal(status(manager, 1).status, 'quota');
    });
});

test('Tavily 434 (flex capacity) rotates without penalty; all 434 returns 503', async () => {
  await run(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async () => json({ detail: { error: 'Flex tier capacity exceeded' } }, 434),
    async ({ post, manager }) => {
      assert.equal((await post('/tavily/search', { query: 'q', max_age_hours: 1 })).status, 503);
      assert.equal(status(manager, 0).status, 'active');
    });
});

test('Tavily 403 on /search cools the account down for 10 minutes instead of disabling it forever', async () => {
  await run(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async (_u, opts) => keyOf(opts) === 'Bearer tvly-aaaaaaaa' ? json({ detail: { error: 'Forbidden' } }, 403) : json({ results: [] }),
    async ({ post, manager, time }) => {
      assert.equal((await post('/tavily/search', { query: 'q' })).status, 200);
      const a = status(manager, 0);
      assert.equal(a.status, 'cooldown');
      assert.equal(a.cooldownReason, 'forbidden');
      time.ms += 10 * 60 * 1000 + 1;
      assert.equal(status(manager, 0).status, 'active');
    });
});

test('Quota wins over transient when reporting exhaustion (order independent)', async () => {
  await run(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async (_u, opts) => keyOf(opts) === 'Bearer tvly-aaaaaaaa'
      ? json({ detail: { error: 'capacity' } }, 434)
      : json({ detail: { error: 'rate' } }, 429),
    async ({ post }) => {
      assert.equal((await post('/tavily/search', { query: 'q' })).status, 429);
    });
});

test('stream: true is rejected before any upstream call', async () => {
  let calls = 0;
  await run(config(exa('a', 'exa-key-aaaa'), tavily('t', 'tvly-aaaaaaaa')),
    async () => { calls++; return json({}); },
    async ({ post }) => {
      const e = await post('/exa/search', { query: 'q', stream: true, outputSchema: {} });
      assert.equal(e.status, 400);
      assert.equal((await e.json()).tag, 'BROKER_UNSUPPORTED');
      assert.equal((await post('/tavily/search', { query: 'q', stream: true })).status, 400);
      assert.equal(calls, 0);
    });
});

test('Tavily: body api_key is stripped, include_usage is injected, usage.credits is recorded exactly', async () => {
  const bodies = [];
  await run(config(tavily('t', 'tvly-aaaaaaaa')),
    async (_u, opts) => { bodies.push(JSON.parse(opts.body)); return json({ results: [], usage: { credits: 2 }, request_id: 'tv-123' }); },
    async ({ post, manager }) => {
      const res = await post('/tavily/search', { query: 'q', api_key: secret });
      const data = await res.json();
      assert.equal(bodies[0].api_key, undefined, 'the local token must never reach Tavily');
      assert.equal(bodies[0].include_usage, true);
      assert.equal(data.usage, undefined, 'usage is hidden when the client did not ask for it');
      const a = status(manager, 0);
      assert.equal(a.allocations[0].spent, 2);
      assert.equal(a.lastRequestId, 'tv-123');
      const withUsage = await (await post('/tavily/search', { query: 'q', include_usage: true })).json();
      assert.deepEqual(withUsage.usage, { credits: 2 });
    });
});

test('Tavily reported usage.credits of 0 is exact (not replaced by the estimate)', async () => {
  await run(config(tavily('t', 'tvly-aaaaaaaa')),
    async () => json({ results: [], usage: { credits: 0 } }),
    async ({ post, manager }) => {
      assert.equal((await post('/tavily/search', { query: 'q' })).status, 200);
      assert.equal(status(manager, 0).allocations[0].spent, 0);
    });
});

test('Attempt timeout is counted as possibly billed, never cools down, and is never retried on another account', async () => {
  const keys = [];
  await run(config(exa('a', 'exa-key-aaaa', '2026-11-20T00:00:00Z'), exa('b', 'exa-key-bbbb')),
    async (_u, opts) => {
      keys.push(keyOf(opts));
      throw new DOMException('The operation timed out.', 'TimeoutError');
    },
    async ({ post, manager }) => {
      const res = await post('/exa/search', { query: 'q', numResults: 5 });
      assert.equal(res.status, 504, 'pi classifies 504 as transient and falls back to the other provider');
      assert.match((await res.json()).error, /not retried to avoid double billing/);
      assert.deepEqual(keys, ['exa-key-aaaa'], 'a second account would risk billing the same request twice');
      const a = status(manager, 0);
      assert.equal(a.status, 'active');
      assert.equal(a.possiblyBilled, 1);
      assert.equal(a.allocations[0].spent, 0.007);
      assert.equal(a.requests, 0);
    });
});

test('Network errors before a response rotate with a short cooldown (unchanged behaviour)', async () => {
  let calls = 0;
  await run(config(tavily('t-a', 'tvly-aaaaaaaa'), tavily('t-b', 'tvly-bbbbbbbb')),
    async () => { if (++calls === 1) throw new TypeError('fetch failed'); return json({ results: [] }); },
    async ({ post, manager, sleeps }) => {
      assert.equal((await post('/tavily/search', { query: 'q' })).status, 200);
      assert.equal(calls, 2);
      assert.deepEqual(sleeps, []);
      assert.equal(status(manager, 0).cooldownReason, EFFECT.UPSTREAM);
    });
});

test('Non-retryable provider errors are passed through sanitized, in the provider shape', async () => {
  await run(config(tavily('t', 'tvly-aaaaaaaa')),
    async () => json({ detail: { error: 'Invalid topic for key tvly-aaaaaaaa' } }, 400),
    async ({ post }) => {
      const res = await post('/tavily/search', { query: 'q', topic: 'nope' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.detail.error, /Invalid topic/);
      assert.ok(!JSON.stringify(body).includes('tvly-aaaaaaaa'));
    });
  const v = PROVIDERS.tavily.sanitizeError(422, { detail: [{ loc: ['body', 'max_results'], msg: 'too big' }] }, []);
  assert.equal(v.detail.error, 'Validation failed: body.max_results: too big');
});

test('Exa integration and beta headers are forwarded only when well-formed; client auth never is', async () => {
  const seen = [];
  await run(config(exa('a', 'exa-key-aaaa')),
    async (_u, opts) => { seen.push(opts.headers); return json({ results: [], requestId: 'abc123' }); },
    async ({ post, manager }) => {
      await post('/exa/search', { query: 'q' }, secret, { 'x-exa-integration': 'my-tool', 'exa-beta': 'dynamic-highlights-2026-08-28' });
      await post('/exa/search', { query: 'q' }, secret, { 'x-exa-integration': 'bad value with spaces' });
      assert.equal(seen[0]['x-exa-integration'], 'my-tool');
      assert.equal(seen[0]['Exa-Beta'], 'dynamic-highlights-2026-08-28');
      assert.equal(seen[1]['x-exa-integration'], 'pi-web-access');
      assert.ok(!JSON.stringify(seen).includes(secret));
      const snap = manager.snapshot();
      assert.equal(snap.accounts[0].lastRequestId, 'abc123');
      assert.equal(snap.recent.length, 2);
      assert.ok(!JSON.stringify(snap).includes('exa-key-aaaa'));
    });
});

test('A provider key sent to the broker gets a 401 with a configuration hint', async () => {
  await run(config(tavily('t', 'tvly-aaaaaaaa')), async () => json({}), async ({ post }) => {
    const res = await post('/tavily/search', { query: 'q' }, 'tvly-someone-real-key');
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.match(text, /PI_SEARCH_BROKER_TOKEN/);
    assert.ok(!text.includes('tvly-someone-real-key'));
  });
});

test('Exa quote covers new search types, summaries, ids and subpages', () => {
  assert.equal(quote('exa', '/search', { type: 'deep-lite' }), 0.012);
  assert.equal(quote('exa', '/search', { type: 'deep-reasoning' }), 0.015);
  assert.equal(quote('exa', '/search', { type: 'lite', numResults: 10 }), 0.004);
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 12, contents: { text: true } }), 0.009);
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 5, contents: { summary: {} } }), 0.012);
  assert.equal(quote('exa', '/search', { type: 'something-new' }), 0.015);
  assert.equal(quote('exa', '/contents', { ids: ['a', 'b', 'c'], text: true, summary: {} }), 0.006);
  assert.equal(quote('exa', '/contents', { urls: ['a'], text: true, subpages: 2 }), 0.003);
  assert.equal(quote('tavily', '/search', { auto_parameters: true }), 2);
  assert.equal(quote('tavily', '/search', { auto_parameters: true, search_depth: 'basic' }), 1);
  assert.equal(quote('tavily', '/search', { search_depth: 'fast' }), 1);
});
