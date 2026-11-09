// Account state over time: allocation windows, reset days, startsAt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/manager.mjs';
import { config, exa, tavily } from './helpers.mjs';

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

test('Free allocation starts only after configured promo expires (startsAt)', () => {
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
