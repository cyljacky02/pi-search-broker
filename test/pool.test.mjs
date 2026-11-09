// Account pool: reservations, allocation windows over time, health, admin changes and persistence.
// Everything goes through the pool interface with an in-memory store and a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountPool, POSSIBLY_BILLED } from '../src/pool.mjs';
import { fileStore, memoryStore } from '../src/pool/store.mjs';
import { nextCreditChange } from '../src/pool/allocation.mjs';
import { ROUTES, EFFECT } from '../src/providers.mjs';
import { config, exa, tavily, DATE } from './helpers.mjs';

const TAVILY = ROUTES['/tavily/search'];
const EXA = ROUTES['/exa/search'];
const NONE = new Set();
const poolOf = (cfg, time = { ms: DATE }, store = memoryStore()) => createAccountPool(cfg.accounts, { store, now: () => time.ms });
const account = (pool, i = 0) => pool.snapshot().accounts[i];
const withTempDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-store-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('A reservation sets its estimate aside until it ends, then exactly one ending applies', async () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')));
  const result = await pool.attempt(TAVILY, 2, NONE, (r) => {
    assert.equal(r.account.id, 't');
    assert.equal(account(pool).available, 998, 'reserved credit is not available to other requests');
    r.settle({ amount: 1, exact: true, requestId: 'req-1' });
    assert.throws(() => r.settle({ amount: 1, exact: true }), /already ended/);
    assert.throws(() => r.fail({ status: 500 }), /already ended/);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(account(pool).available, 999, 'the reservation is replaced by what was actually billed');
  assert.equal(account(pool).lastRequestId, 'req-1');
});

test('If the attempt throws or returns before the reservation ends, the credit comes back with no penalty', async () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')));
  await assert.rejects(pool.attempt(TAVILY, 2, NONE, () => { throw new Error('could not prepare'); }), /could not prepare/);
  let kept;
  await pool.attempt(TAVILY, 2, NONE, (r) => { kept = r; });
  assert.throws(() => kept.settle({ amount: 2, exact: true }), /already ended/, 'too late once the attempt is over');
  const a = account(pool);
  assert.deepEqual([a.available, a.failures, a.requests, a.status], [1000, 0, 0, 'active']);
  assert.deepEqual(pool.snapshot().recent, [], 'nothing was sent, so there is no attempt to log');
});

test('No reservation when no account of that provider can cover the estimate; excluded accounts are skipped', async () => {
  const small = { ...tavily('small', 'tvly-small'), allocations: [{ id: 'free', limit: 1, period: 'monthly' }] };
  const pool = poolOf(config(small, exa('e', 'exa-key-aaaa')));
  const never = () => assert.fail('use must not run without a reservation');
  assert.equal(await pool.attempt(TAVILY, 2, NONE, never), null);
  await pool.attempt(TAVILY, 1, NONE, async () => {
    assert.equal(await pool.attempt(TAVILY, 1, NONE, never), null, 'the first reservation uses the whole allocation');
  });
  assert.equal(await pool.attempt(TAVILY, 1, new Set(['small']), never), null);
  assert.equal(await pool.attempt(EXA, 0.007, NONE, (r) => r.account.id), 'e');
});

test('Possibly billed outcomes charge the estimate; only a timeout counts as a failure', async () => {
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa'), tavily('b', 'tvly-bbbbbbbb')));
  await pool.attempt(TAVILY, 2, new Set(['b']), (r) => r.settlePossiblyBilled(POSSIBLY_BILLED.TIMEOUT));
  await pool.attempt(TAVILY, 2, new Set(['a']), (r) => r.settlePossiblyBilled(POSSIBLY_BILLED.CLIENT_CLOSED));
  await assert.rejects(pool.attempt(TAVILY, 2, NONE, (r) => r.settlePossiblyBilled('maybe')), /Unknown possibly-billed reason/);
  const [a, b] = pool.snapshot().accounts;
  assert.deepEqual([a.possiblyBilled, a.allocations[0].spent, a.failures, a.requests], [1, 2, 1, 0]);
  assert.deepEqual([b.possiblyBilled, b.allocations[0].spent, b.failures, b.status], [1, 2, 0, 'active']);
});

test('Failure effects: rate limit honours Retry-After within 1-120 s; auth disables until re-enabled', async () => {
  const time = { ms: DATE };
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa'), tavily('b', 'tvly-bbbbbbbb')), time);
  await pool.attempt(TAVILY, 1, new Set(['b']), (r) => r.fail({ status: 429, effect: EFFECT.RATE_LIMIT, retryAfterMs: 600000 }));
  assert.equal(account(pool, 0).retryAt, new Date(DATE + 120000).toISOString(), 'clamped to 120 s');
  await pool.attempt(TAVILY, 1, new Set(['a']), (r) => r.fail({ status: 401, effect: EFFECT.AUTH }));
  time.ms += 121000;
  assert.equal(account(pool, 0).status, 'active');
  assert.equal(account(pool, 1).status, 'auth');
  pool.enable('b');
  assert.equal(account(pool, 1).status, 'active');
});

test('Spend is charged to the allocation window current when the reservation ends (month rollover)', async () => {
  const time = { ms: Date.parse('2026-11-30T23:59:59Z') };
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')), time);
  pool.setSpent('t', 'free', 400);
  await pool.attempt(TAVILY, 2, NONE, (r) => {
    time.ms = Date.parse('2026-12-01T00:00:02Z');
    r.settle({ amount: 2, exact: true });
  });
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

test('Admin changes validate their input', async () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')));
  assert.throws(() => pool.disable('nope'), /Unknown account id/);
  assert.throws(() => pool.setSpent('t', 'nope', 1), /Unknown allocation/);
  assert.throws(() => pool.setSpent('t', 'free', Number('x')), /nonnegative/);
  pool.disable('t');
  assert.equal(account(pool).status, 'manual');
  assert.equal(await pool.attempt(TAVILY, 1, NONE, () => assert.fail('disabled')), null);
});

test('Balance checks are stored report-only; skips store nothing; unknown ids throw', async () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa'), tavily('u', 'tvly-bbbbbbbb')));
  const results = await pool.checkBalances(undefined, async (a) => (a.id === 't' ? { remaining: 12.3456789, details: { plan: 'x' } } : { skipped: 'too-soon' }));
  assert.deepEqual(results, [{ id: 't', remaining: 12.3456789 }, { id: 'u', skipped: 'too-soon' }]);
  assert.deepEqual(await pool.checkBalances('t', async () => { throw new Error('HTTP 429'); }), [{ id: 't', error: 'HTTP 429' }]);
  const [t, u] = pool.snapshot().accounts;
  assert.equal(t.providerBalance.remaining, 12.345679, 'an error keeps the last good balance');
  assert.equal(t.reconcileError.message, 'HTTP 429');
  assert.equal(t.available, 1000, 'local accounting is untouched');
  assert.equal(u.providerBalance, null);
  await assert.rejects(pool.checkBalances('nope', async () => ({ remaining: 1 })), /Unknown account id/);
});

test('fileStore persists state without keys; a read-only fileStore never writes', () => withTempDir(async (dir) => {
  const path = join(dir, 'pool-state.json');
  const cfg = config(tavily('t', 'tvly-secret-key'));
  const pool = poolOf(cfg, { ms: DATE }, fileStore(path));
  await pool.attempt(TAVILY, 1, NONE, (r) => r.settle({ amount: 1, exact: true }));
  const text = readFileSync(path, 'utf8');
  assert.ok(!text.includes('tvly-secret-key'));
  assert.equal(account(poolOf(cfg, { ms: DATE }, fileStore(path))).allocations[0].spent, 1, 'state survives a restart');
  poolOf(cfg, { ms: DATE }, fileStore(path, { readOnly: true })).disable('t');
  assert.equal(readFileSync(path, 'utf8'), text, 'offline status never writes');
  writeFileSync(path, JSON.stringify({ version: 99, accounts: {} }));
  assert.throws(() => poolOf(cfg, { ms: DATE }, fileStore(path)), /Unsupported/);
}));

test('A 0.2.x state.json is upgraded into the new state file and left untouched for 0.2.x processes', () => withTempDir((dir) => {
  const v1Path = join(dir, 'state.json');
  const path = join(dir, 'pool-state.json');
  const v1 = JSON.stringify({
    version: 1,
    accounts: { t: {
      buckets: { free: { window: '2026-11-01', spent: 300, exactCalls: 3, estimatedCalls: 0 } },
      disabled: 'quota', blockedUntil: Date.parse('2026-12-01T00:00:00Z'), cooldownUntil: 0, requests: 3, failures: 1,
      reconciled: { at: '2026-11-08T00:00:00.000Z', remaining: 700, details: {} }
    } }
  });
  writeFileSync(v1Path, v1);
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa')), { ms: DATE }, fileStore(path));
  const a = account(pool);
  assert.equal(a.allocations[0].spent, 300);
  assert.equal(a.status, 'quota');
  assert.equal(a.retryAt, '2026-12-01T00:00:00.000Z');
  assert.equal(a.providerBalance.remaining, 700);
  assert.equal(readFileSync(v1Path, 'utf8'), v1, 'an older pi process can still read its own state');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.version, 2);
  assert.deepEqual(Object.keys(saved.accounts.t).filter((k) => ['buckets', 'blockedUntil', 'reconciled'].includes(k)), []);
  assert.equal(saved.accounts.t.allocations.free.spent, 300);
  assert.equal(saved.accounts.t.quotaRetryAt, Date.parse('2026-12-01T00:00:00Z'));
  assert.ok(existsSync(path));
}));

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
