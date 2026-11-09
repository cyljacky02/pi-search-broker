import test from 'node:test';
import assert from 'node:assert/strict';
import { run, config, exa, tavily, json, DATE } from './helpers.mjs';
import { canReconcile } from '../src/reconcile.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { validateConfig, resolveSecret } from '../src/config.mjs';

const TOKEN = 'local-only-secret-with-32-chars-12345';

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

test('Only Tavily accounts and Exa accounts with an adminKey can be checked', () => {
  assert.equal(canReconcile({ provider: 'tavily' }), true);
  assert.equal(canReconcile({ provider: 'tavily', reconcile: false }), false);
  assert.equal(canReconcile({ provider: 'exa' }), false);
  assert.equal(canReconcile({ provider: 'exa', adminKey: 'svc' }), true);
});

test('Balance checks are optional: periodic checks are off by default', () => {
  assert.equal(config(tavily('t', 'tvly-aaaaaaaa')).reconcileIntervalMs, 0);
});

test('Balance checks are report-only: they never cap spending or rewrite local accounting', async () => {
  const calls = [];
  const reconcileFetch = async (url, opts) => {
    calls.push([url, opts.headers.Authorization]);
    return json({ key: { usage: 1000, limit: null }, account: { plan_usage: 1000, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } });
  };
  let searches = 0;
  await run(config(tavily('t', 'tvly-aaaaaaaa')),
    async () => { searches++; return json({ results: [], usage: { credits: 1 } }); },
    async ({ post, manager }) => {
      const { results } = await (await post('/admin/reconcile', {})).json();
      assert.deepEqual(results, [{ id: 't', remaining: 0 }]);
      assert.equal(calls[0][0], PROVIDERS.tavily.balance.url);
      const a = manager.snapshot().accounts[0];
      assert.equal(a.providerBalance.remaining, 0);
      assert.equal(a.allocations[0].spent, 0, 'local spend is not overwritten');
      assert.equal(a.available, 1000, 'local budget is not capped');
      assert.equal((await post('/tavily/search', { query: 'q' })).status, 200);
      assert.equal(searches, 1);
      // A second call within the minimum gap is skipped (protects Tavily's 10 per 10 minutes limit).
      const again = await (await post('/admin/reconcile', { id: 't' })).json();
      assert.equal(again.results[0].skipped, 'too-soon');
      assert.ok(!JSON.stringify(manager.snapshot()).includes('tvly-'));
    }, { ms: DATE }, { reconcileFetch });
});

test('Exa balance check uses the admin service key against the Team Management API', async () => {
  const seen = [];
  const account = { ...exa('e', 'exa-key-aaaa'), adminKey: 'exa-service-key-1234' };
  await run(config(account), async () => json({ results: [] }), async ({ post, manager }) => {
    const { results } = await (await post('/admin/reconcile', {})).json();
    assert.equal(results[0].remaining, 3.25);
    assert.deepEqual(seen, [[PROVIDERS.exa.balance.url, 'exa-service-key-1234']]);
    assert.equal(manager.snapshot().accounts[0].providerBalance.remaining, 3.25);
  }, { ms: DATE }, {
    reconcileFetch: async (url, opts) => { seen.push([url, opts.headers['x-api-key']]); return json({ credits_usd: 3.25, expiring_credits: [] }); }
  });
});

test('Balance check failures are recorded without leaking keys', async () => {
  await run(config(tavily('t', 'tvly-aaaaaaaa')), async () => json({}), async ({ post, manager }) => {
    const { results } = await (await post('/admin/reconcile', {})).json();
    assert.match(results[0].error, /HTTP 429/);
    assert.match(manager.snapshot().accounts[0].reconcileError.message, /HTTP 429/);
  }, { ms: DATE }, { reconcileFetch: async () => json({ detail: { error: 'slow down' } }, 429) });
});

test('Secrets can come from $ENV and !command sources and are validated after resolution', () => {
  const env = { MY_TAVILY: 'tvly-from-env-123' };
  assert.equal(resolveSecret('$MY_TAVILY', 'k', { env }), 'tvly-from-env-123');
  assert.equal(resolveSecret('${MY_TAVILY}', 'k', { env }), 'tvly-from-env-123');
  assert.equal(resolveSecret('$$literal', 'k', { env }), '$literal');
  assert.equal(resolveSecret('!secret-tool read tavily', 'k', { runCommand: () => 'tvly-from-cmd-123\n' }), 'tvly-from-cmd-123');
  assert.throws(() => resolveSecret('$MISSING', 'k', { env }), /empty or unset/);
  assert.throws(() => resolveSecret('!x', 'k', { runCommand: () => { throw new Error('tvly-should-not-leak'); } }), (e) => !e.message.includes('tvly-should-not-leak'));
  const gateway = { host: '127.0.0.1', port: 19473, token: TOKEN };
  assert.equal(validateConfig({ gateway, accounts: [tavily('t', '$MY_TAVILY')] }, { env }).accounts[0].apiKey, 'tvly-from-env-123');
  assert.throws(() => validateConfig({ gateway, accounts: [tavily('a', '$MY_TAVILY'), tavily('b', 'tvly-from-env-123')] }, { env }), /Duplicate apiKey/);
  // Exa onboarding bonus never expires.
  const never = validateConfig({
    gateway,
    accounts: [{ id: 'e', provider: 'exa', apiKey: 'exa-key-aaaa', allocations: [{ id: 'bonus', limit: 10, period: 'once', expires: 'never' }] }]
  });
  assert.equal(never.accounts[0].allocations[0].expires, 'never');
});
