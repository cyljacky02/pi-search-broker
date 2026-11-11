// The footer line and the status report, from status snapshots (the shape pool.snapshot() and offline status return).
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusLine, statusReport } from '../src/format.mjs';

const NOW = '2026-11-10T12:00:00.000Z';
const minutesAgo = (m) => new Date(Date.parse(NOW) - m * 60000).toISOString();
const account = (id, provider, { status = 'active', retryAt = null, requests = 0, failures = 0, balance, allocations = [] }) => ({
  id, provider, status, retryAt, cooldownReason: null, requests, failures, possiblyBilled: 0, lastErrorTag: null,
  available: balance.remaining, balance: { limit: null, reportedAt: null, expiring: [], spentThisMonth: 0, syncError: null, ...balance },
  allocations
});
const snapshot = (accounts) => ({ updatedAt: NOW, persistence: { state: 'ok' }, accounts, recent: [] });

test('The footer adds up known balances and marks unknown ones', () => {
  assert.equal(statusLine(snapshot([
    account('e1', 'exa', { balance: { source: 'provider', remaining: 41.2 } }),
    account('e2', 'exa', { balance: { source: 'unknown', remaining: null } }),
    account('e3', 'exa', { status: 'quota', balance: { source: 'unknown', remaining: null } }),
    account('t1', 'tavily', { balance: { source: 'provider', remaining: 688 } }),
    account('t2', 'tavily', { balance: { source: 'hint', remaining: 1000 } })
  ])), 'search: exa $41.20+? (2/3) · tavily 1,688cr (2/2)');
  assert.equal(statusLine(snapshot([
    account('e1', 'exa', { balance: { source: 'unknown', remaining: null } }),
    account('e2', 'exa', { balance: { source: 'unknown', remaining: null } })
  ])), 'search: exa ? (2/2)');
});

test('The status report says where each balance comes from and how old it is', () => {
  const report = statusReport(snapshot([
    account('t1', 'tavily', { requests: 3, balance: { source: 'provider', remaining: 688, limit: 1000, reportedAt: minutesAgo(12) } }),
    account('e1', 'exa', { requests: 1, balance: {
      source: 'provider', remaining: 58.1, reportedAt: minutesAgo(3), expiring: [{ amount: 50, expiresAt: '2026-12-01T00:00:00Z' }]
    } }),
    account('e2', 'exa', { requests: 2, balance: { source: 'unknown', remaining: null, spentThisMonth: 0.42 } }),
    account('e3', 'exa', { status: 'quota', retryAt: '2026-12-01T00:00:00.000Z', failures: 1, balance: { source: 'unknown', remaining: null } }),
    account('e4', 'exa', { balance: { source: 'unknown', remaining: null, expiring: [{ amount: 5, expiresAt: '2026-11-20T00:00:00Z' }] } }),
    account('t2', 'tavily', {
      balance: { source: 'hint', remaining: 1000, syncError: { at: minutesAgo(1), message: 'Balance request failed: HTTP 429' } },
      allocations: [{ id: 'free', period: 'monthly', limit: 1000, spent: 0, remainingEstimate: 1000, window: '2026-11-01', active: true, expiresAt: null }]
    })
  ]), { mode: 'live' });
  const lines = report.split('\n');
  assert.equal(lines[0], `Search broker (live) as of ${NOW}`);
  assert.deepEqual(lines.slice(1), [
    't1 [tavily] active | ok 3, failed 0 | 688 of 1,000cr left (Tavily-reported 12 min ago)',
    'e1 [exa] active | ok 1, failed 0 | $58.10 left, $50.00 expires 2026-12-01 (Exa-reported 3 min ago)',
    'e2 [exa] active | ok 2, failed 0 | balance unknown; $0.420 spent this month',
    'e3 [exa] parked until 2026-12-01 (out of credit) | ok 0, failed 1 | balance unknown; $0.000 spent this month',
    'e4 [exa] active | ok 0, failed 0 | balance unknown (hint: $5.000 expires 2026-11-20); $0.000 spent this month',
    't2 [tavily] active | ok 0, failed 0 | ~1,000cr left (estimate from Allocations)',
    '  free: ~1,000cr of 1,000cr left (monthly from 2026-11-01)',
    `  balance sync failed at ${minutesAgo(1)}: Balance request failed: HTTP 429`
  ]);
});
