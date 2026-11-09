// Account pool: reservations, allocation windows over time, health, admin changes and persistence.
// Everything goes through the pool interface with an in-memory store and a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountPool } from '../src/pool.mjs';
import { fileStore, memoryStore } from '../src/pool/store.mjs';
import { nextCreditChange } from '../src/pool/allocation.mjs';
import { ROUTES, EFFECT } from '../src/providers.mjs';
import { config, exa, tavily, DATE } from './helpers.mjs';

const TAVILY = ROUTES['/tavily/search'];
const EXA = ROUTES['/exa/search'];
const poolOf = (cfg, time = { ms: DATE }, store = memoryStore()) => createAccountPool(cfg.accounts, { store, now: () => time.ms });
const account = (pool, i = 0) => pool.snapshot().accounts[i];

test('A reservation holds its estimate until it ends, then exactly one ending applies', () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')));
  const r = pool.reserve(TAVILY, 2);
  assert.equal(r.account.id, 't');
  assert.equal(account(pool).available, 998, 'held credit is not available to other requests');
  r.settle({ amount: 1, exact: true, requestId: 'req-1' });
  assert.equal(account(pool).available, 999, 'the hold is replaced by what was actually billed');
  assert.equal(account(pool).lastRequestId, 'req-1');
  assert.throws(() => r.settle({ amount: 1, exact: true }), /already ended/);
  assert.throws(() => r.abandon(), /already ended/);
  assert.equal(r.open, false);
});

test('Abandoning a reservation returns the credit with no penalty and no spend', () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')));
  pool.reserve(TAVILY, 2).abandon();
  const a = account(pool);
  assert.equal(a.available, 1000);
  assert.equal(a.failures, 0);
  assert.equal(a.status, 'active');
  assert.equal(pool.snapshot().recent.at(-1).status, 'abandoned');
});

test('No reservation when no account of that provider can cover the estimate; excluded accounts are skipped', () => {
  const small = { ...tavily('small', 'tvly-small'), allocations: [{ id: 'free', limit: 1, period: 'monthly' }] };
  const pool = poolOf(config(small, exa('e', 'exa-key-aaaa')));
  assert.equal(pool.reserve(TAVILY, 2), null);
  const r = pool.reserve(TAVILY, 1);
  assert.equal(pool.reserve(TAVILY, 1), null, 'the first hold uses the whole allocation');
  r.abandon();
  assert.equal(pool.reserve(TAVILY, 1, new Set(['small'])), null);
  assert.equal(pool.reserve(EXA, 0.007).account.id, 'e');
});

test('Possibly billed outcomes charge the estimate; only a timeout counts as a failure', () => {
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa'), tavily('b', 'tvly-bbbbbbbb')));
  pool.reserve(TAVILY, 2, new Set(['b'])).settleUncertain('timeout');
  pool.reserve(TAVILY, 2, new Set(['a'])).settleUncertain('client-closed');
  const [a, b] = pool.snapshot().accounts;
  assert.deepEqual([a.possiblyBilled, a.allocations[0].spent, a.failures, a.requests], [1, 2, 1, 0]);
  assert.deepEqual([b.possiblyBilled, b.allocations[0].spent, b.failures, b.status], [1, 2, 0, 'active']);
});

test('Failure effects: rate limit honours Retry-After within 1-120 s; auth disables until re-enabled', () => {
  const time = { ms: DATE };
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa'), tavily('b', 'tvly-bbbbbbbb')), time);
  pool.reserve(TAVILY, 1, new Set(['b'])).fail({ status: 429, effect: EFFECT.RATE_LIMIT, retryAfterMs: 600000 });
  assert.equal(account(pool, 0).retryAt, new Date(DATE + 120000).toISOString(), 'clamped to 120 s');
  pool.reserve(TAVILY, 1, new Set(['a'])).fail({ status: 401, effect: EFFECT.AUTH });
  time.ms += 121000;
  assert.equal(account(pool, 0).status, 'active');
  assert.equal(account(pool, 1).status, 'auth');
  pool.enable('b');
  assert.equal(account(pool, 1).status, 'active');
});

test('Spend is charged to the allocation window current when the reservation ends (month rollover)', () => {
  const time = { ms: Date.parse('2026-11-30T23:59:59Z') };
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')), time);
  pool.setSpent('t', 'free', 400);
  const r = pool.reserve(TAVILY, 2);
  time.ms = Date.parse('2026-12-01T00:00:02Z');
  r.settle({ amount: 2, exact: true });
  const [free] = account(pool).allocations;
  assert.equal(free.window, '2026-12-01');
  assert.equal(free.spent, 2, 'the new month starts from zero and carries only this request');
});

test('Monthly allocations support a per-account UTC reset day', () => {
  const time = { ms: Date.parse('2026-11-12T06:00:00Z') };
  const pool = poolOf(config({ ...tavily('a', 'tvly-day12'), allocations: [{ id: 'monthly', period: 'monthly', limit: 1000, resetDay: 15 }] }), time);
  assert.equal(account(pool).allocations[0].window, '2026-10-15');
  pool.setSpent('a', 'monthly', 500);
  time.ms = Date.parse('2026-11-15T00:00:00Z');
  assert.equal(account(pool).allocations[0].remainingEstimate, 1000);
  assert.equal(account(pool).allocations[0].window, '2026-11-15');
});

test('Free allocation starts only after configured promo expires (startsAt)', () => {
  const time = { ms: Date.parse('2026-11-09T06:00:00Z') };
  const cutoff = '2026-11-10T00:00:00Z';
  const a = exa('a', 'exa-starts-at', cutoff);
  a.allocations[1].startsAt = cutoff;
  const pool = poolOf(config(a), time);
  assert.equal(account(pool).allocations[1].active, false);
  assert.equal(account(pool).allocations[1].remainingEstimate, 0);
  time.ms = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(account(pool).allocations[0].active, false);
  assert.equal(account(pool).allocations[1].active, true);
  assert.equal(account(pool).allocations[1].remainingEstimate, 10);
});

test('Admin changes validate their input', () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')));
  assert.throws(() => pool.disable('nope'), /Unknown account id/);
  assert.throws(() => pool.setSpent('t', 'nope', 1), /Unknown allocation/);
  assert.throws(() => pool.setSpent('t', 'free', Number('x')), /nonnegative/);
  pool.disable('t');
  assert.equal(account(pool).status, 'manual');
  assert.equal(pool.reserve(TAVILY, 1), null);
});

test('Balance checks are stored report-only, and an error replaces nothing but the error', () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')));
  pool.recordBalanceCheck('t', { remaining: 12.3456789, details: { plan: 'x' } });
  pool.recordBalanceCheck('t', new Error('HTTP 429'));
  const a = account(pool);
  assert.equal(a.providerBalance.remaining, 12.345679);
  assert.equal(a.reconcileError.message, 'HTTP 429');
  assert.equal(a.available, 1000);
});

test('fileStore persists state without keys; a read-only fileStore never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-store-'));
  const path = join(dir, 'state.json');
  try {
    const cfg = config(tavily('t', 'tvly-secret-key'));
    const pool = poolOf(cfg, { ms: DATE }, fileStore(path));
    pool.reserve(TAVILY, 1).settle({ amount: 1, exact: true });
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.includes('tvly-secret-key'));
    assert.equal(account(poolOf(cfg, { ms: DATE }, fileStore(path))).allocations[0].spent, 1, 'state survives a restart');
    const reader = poolOf(cfg, { ms: DATE }, fileStore(path, { readOnly: true }));
    reader.disable('t');
    assert.equal(readFileSync(path, 'utf8'), text, 'offline status never writes');
    writeFileSync(path, JSON.stringify({ version: 99, accounts: {} }));
    assert.throws(() => poolOf(cfg, { ms: DATE }, fileStore(path)), /Unsupported/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Internal seam: the quota retry calendar, as a table.
test('An out-of-credit account is retried at the earliest monthly reset or upcoming promo expiry', () => {
  const now = Date.parse('2026-11-09T06:00:00Z');
  const monthly = (resetDay) => ({ id: `m${resetDay}`, period: 'monthly', limit: 10, resetDay });
  const promo = (expiresAt) => ({ id: `p${expiresAt}`, period: 'once', limit: 10, expiresAt });
  const cases = [
    [[monthly(1)], '2026-12-01T00:00:00.000Z'],
    [[monthly(1), monthly(15)], '2026-11-15T00:00:00.000Z'],
    [[monthly(1), promo('2026-11-20T00:00:00Z')], '2026-11-20T00:00:00.000Z'],
    [[monthly(1), promo('2026-11-01T00:00:00Z')], '2026-12-01T00:00:00.000Z', 'an already-expired promo changes nothing'],
    [[{ id: 'bonus', period: 'once', limit: 10, expires: 'never' }], null]
  ];
  for (const [allocations, expected, why] of cases) {
    const at = nextCreditChange(allocations, now);
    assert.equal(at ? new Date(at).toISOString() : null, expected, why);
  }
});

test('A v1 state.json is upgraded on load: spend, health and balance survive under the v2 names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-store-'));
  const path = join(dir, 'state.json');
  try {
    const cfg = config(tavily('t', 'tvly-aaaaaaaa'));
    writeFileSync(path, JSON.stringify({
      version: 1,
      accounts: { t: {
        buckets: { free: { window: '2026-11-01', spent: 300, exactCalls: 3, estimatedCalls: 0 } },
        disabled: 'quota', blockedUntil: Date.parse('2026-12-01T00:00:00Z'), cooldownUntil: 0, requests: 3, failures: 1,
        reconciled: { at: '2026-11-08T00:00:00.000Z', remaining: 700, details: {} }
      } }
    }));
    const pool = poolOf(cfg, { ms: DATE }, fileStore(path));
    const a = account(pool);
    assert.equal(a.allocations[0].spent, 300);
    assert.equal(a.status, 'quota');
    assert.equal(a.retryAt, '2026-12-01T00:00:00.000Z');
    assert.equal(a.providerBalance.remaining, 700);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.version, 2);
    assert.deepEqual(Object.keys(saved.accounts.t).filter((k) => ['buckets', 'blockedUntil', 'reconciled'].includes(k)), []);
    assert.equal(saved.accounts.t.allocations.free.spent, 300);
    assert.equal(saved.accounts.t.quotaRetryAt, Date.parse('2026-12-01T00:00:00Z'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
