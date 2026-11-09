// Provider policies: pure rules (classification, rate cards, error sanitizing, balance parsing). No I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, ACTION, EFFECT } from '../src/providers.mjs';

const quote = (provider, path, body) => PROVIDERS[provider].quote(path, body);

test('Exa 402 X402_PAYMENT_REQUIRED is a credential problem, other 402 is quota; network 429 passes through', () => {
  const classify = (...args) => PROVIDERS.exa.classify(...args);
  assert.equal(classify(402, { tag: 'X402_PAYMENT_REQUIRED' }).effect, EFFECT.AUTH);
  assert.equal(classify(402, { tag: 'NO_MORE_CREDITS' }).effect, EFFECT.QUOTA);
  const network = { get: (h) => (h === 'x-ratelimit-scope' ? 'network' : null) };
  assert.equal(classify(429, {}, network).action, ACTION.PASSTHROUGH);
});

test('Tavily validation errors are summarized without echoing the request', () => {
  const v = PROVIDERS.tavily.sanitizeError(422, { detail: [{ loc: ['body', 'max_results'], msg: 'too big' }] }, []);
  assert.equal(v.detail.error, 'Validation failed: body.max_results: too big');
});

test('Exa quote follows the current rate card (contents included on /search up to 10 results)', () => {
  // pi-web-access's default call: auto, 5 results, highlights -> $0.007
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 5, contents: { highlights: true } }), 0.007);
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 5, contents: { text: true, highlights: true } }), 0.007);
  assert.equal(quote('exa', '/search', { type: 'deep-lite' }), 0.012);
  assert.equal(quote('exa', '/search', { type: 'deep-reasoning' }), 0.015);
  assert.equal(quote('exa', '/search', { type: 'lite', numResults: 10 }), 0.004);
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 12, contents: { text: true } }), 0.009);
  assert.equal(quote('exa', '/search', { type: 'auto', numResults: 5, contents: { summary: {} } }), 0.012);
  assert.equal(quote('exa', '/search', { type: 'something-new' }), 0.015);
  assert.equal(quote('exa', '/contents', { urls: ['a', 'b'], text: true }), 0.002);
  assert.equal(quote('exa', '/contents', { ids: ['a', 'b', 'c'], text: true, summary: {} }), 0.006);
  assert.equal(quote('exa', '/contents', { urls: ['a'], text: true, subpages: 2 }), 0.003);
});

test('Tavily quote: advanced and auto_parameters cost 2, everything else 1', () => {
  assert.equal(quote('tavily', '/search', { search_depth: 'advanced' }), 2);
  assert.equal(quote('tavily', '/search', { auto_parameters: true }), 2);
  assert.equal(quote('tavily', '/search', { auto_parameters: true, search_depth: 'basic' }), 1);
  assert.equal(quote('tavily', '/search', { search_depth: 'fast' }), 1);
});

test('Tavily /usage parsing: plan + paygo remaining, capped by a per-key limit', () => {
  const parse = PROVIDERS.tavily.balance.parse;
  const r = parse({
    key: { usage: 150, limit: 200 },
    account: { current_plan: 'Researcher', plan_usage: 400, plan_limit: 1000, paygo_usage: 0, paygo_limit: null }
  });
  assert.equal(r.remaining, 50);
  assert.equal(r.details.plan, 'Researcher');
  assert.equal(parse({ key: { usage: 1, limit: null }, account: { plan_usage: 990, plan_limit: 1000, paygo_usage: 5, paygo_limit: 20 } }).remaining, 25);
  assert.throws(() => parse({}), /Unexpected/);
});

test('Exa /credits parsing', () => {
  const r = PROVIDERS.exa.balance.parse({ credits_usd: 42.5, expiring_credits: [{ amount_usd: 30, expires_at: '2026-12-01T00:00:00Z' }], metadata: { generated_at: '2026-11-09T05:59:00Z' } });
  assert.equal(r.remaining, 42.5);
  assert.deepEqual(r.details.expiringCredits, [{ amountUsd: 30, expiresAt: '2026-12-01T00:00:00Z' }]);
});

test('A 429 verdict carries Retry-After in ms, from delta-seconds or an HTTP date', () => {
  const now = Date.parse('2026-11-09T06:00:00Z');
  const headers = (value) => new Headers(value === undefined ? {} : { 'retry-after': value });
  const classify = (h) => PROVIDERS.tavily.classify(429, null, h, now);
  assert.equal(classify(headers('45')).retryAfterMs, 45000);
  assert.equal(classify(headers('1.5')).retryAfterMs, 1500);
  assert.equal(classify(headers('Mon, 09 Nov 2026 06:01:00 GMT')).retryAfterMs, 60000);
  assert.equal(classify(headers('Mon, 09 Nov 2026 05:00:00 GMT')).retryAfterMs, 0, 'a date in the past means now');
  assert.equal(classify(headers('soon')).retryAfterMs, 0);
  assert.equal(classify(headers()).retryAfterMs, 0);
  assert.equal(classify(headers('45')).effect, EFFECT.RATE_LIMIT);
});
