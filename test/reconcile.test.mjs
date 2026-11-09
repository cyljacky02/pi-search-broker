// Provider balance checks: report-only, rate-gapped, key-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, config, exa, tavily, json } from './helpers.mjs';
import { canReconcile } from '../src/reconcile.mjs';
import { PROVIDERS } from '../src/providers.mjs';

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
