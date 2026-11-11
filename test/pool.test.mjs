// Account pool: reservations, allocation windows over time, health, admin changes and persistence.
// Everything goes through the pool interface with an in-memory store and a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountPool, POSSIBLY_BILLED, ENDING, StateNotSaved } from '../src/pool.mjs';
import { fileStore, memoryStore } from '../src/pool/store.mjs';
import { nextCreditChange } from '../src/pool/allocation.mjs';
import { ROUTES, EFFECT } from '../src/providers.mjs';
import { config, exa, tavily, flakyStore, DATE } from './helpers.mjs';

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

test('A higher actual cost preserves credit held by overlapping Reservations', async () => {
  const a = { ...tavily('a', 'tvly-aaaaaaaa'), allocations: [
    { id: 'promo', period: 'once', limit: 2, expires: 'never' },
    { id: 'monthly', period: 'monthly', limit: 1 }
  ] };
  const pool = poolOf(config(a));
  await pool.attempt(TAVILY, 1, NONE, async (first) => {
    await pool.attempt(TAVILY, 1, NONE, async (second) => {
      first.settle({ amount: 2, exact: true });
      assert.equal(account(pool).available, 0, 'the remaining credit is already reserved');
      assert.equal(await pool.attempt(TAVILY, 1, NONE, () => assert.fail('no credit remains')), null);
      second.settle({ amount: 1, exact: true });
    });
  });
  assert.deepEqual(account(pool).allocations.map((a) => a.spent), [2, 1]);
});

test('A settled Attempt spends promo credit first even if another Reservation later fails', async () => {
  const time = { ms: Date.parse('2026-11-09T23:59:59Z') };
  const a = { ...tavily('a', 'tvly-aaaaaaaa'), allocations: [
    { id: 'promo', period: 'once', limit: 1, expiresAt: '2026-11-10T00:00:00Z' },
    { id: 'monthly', period: 'monthly', limit: 1 }
  ] };
  const pool = poolOf(config(a), time);
  await pool.attempt(TAVILY, 1, NONE, async (settled) => {
    await pool.attempt(TAVILY, 1, NONE, (failed) => {
      settled.settle({ amount: 1, exact: true });
      assert.equal(account(pool).available, 0, 'the other Reservation still holds all unspent credit');
      failed.fail({ status: 400 });
    });
  });
  assert.deepEqual(account(pool).allocations.map((allocation) => allocation.spent), [1, 0]);
  time.ms = Date.parse('2026-11-10T00:00:01Z');
  assert.equal(account(pool).available, 1, 'the unspent monthly credit remains after the promo expires');
});

test('An open Reservation continues to hold credit when its promo Allocation expires', async () => {
  const time = { ms: Date.parse('2026-11-09T23:59:59Z') };
  const a = { ...tavily('a', 'tvly-aaaaaaaa'), allocations: [
    { id: 'promo', period: 'once', limit: 1, expiresAt: '2026-11-10T00:00:00Z' },
    { id: 'monthly', period: 'monthly', limit: 1, startsAt: '2026-11-10T00:00:00Z' }
  ] };
  const pool = poolOf(config(a), time);
  await pool.attempt(TAVILY, 1, NONE, async (reservation) => {
    time.ms = Date.parse('2026-11-10T00:00:01Z');
    assert.equal(account(pool).available, 0, 'the in-flight Attempt still holds the newly active credit');
    assert.equal(await pool.attempt(TAVILY, 1, NONE, () => assert.fail('credit is held')), null);
    reservation.settle({ amount: 1, exact: true });
  });
  assert.equal(account(pool).allocations[1].spent, 1);
});

test('Overage after promo expiry is recorded on an active Allocation even when its credit is reserved', async () => {
  const time = { ms: Date.parse('2026-11-09T23:59:59Z') };
  const a = { ...tavily('a', 'tvly-aaaaaaaa'), allocations: [
    { id: 'promo', period: 'once', limit: 1, expiresAt: '2026-11-10T00:00:00Z' },
    { id: 'monthly', period: 'monthly', limit: 1 }
  ] };
  const pool = poolOf(config(a), time);
  await pool.attempt(TAVILY, 1, NONE, async (first) => {
    await pool.attempt(TAVILY, 1, NONE, async (second) => {
      time.ms = Date.parse('2026-11-10T00:00:01Z');
      first.settle({ amount: 1, exact: true });
      assert.deepEqual(account(pool).allocations.map((allocation) => allocation.spent), [0, 1]);
      assert.equal(await pool.attempt(TAVILY, 1, NONE, () => assert.fail('no credit remains')), null);
      second.settle({ amount: 1, exact: true });
    });
  });
  assert.deepEqual(account(pool).allocations.map((allocation) => allocation.spent), [0, 2]);
});

test('Invalid Reservation estimates are rejected before an Attempt starts', async () => {
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')));
  let started = false;
  for (const estimate of [NaN, Infinity, -1]) {
    await assert.rejects(pool.attempt(TAVILY, estimate, NONE, () => { started = true; }), /estimate/i);
  }
  assert.equal(started, false);
  assert.equal(account(pool).available, 1000);
  assert.deepEqual(pool.snapshot().recent, []);
});

test('Invalid billed amounts cannot corrupt Account spend or end a Reservation', async () => {
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')));
  await pool.attempt(TAVILY, 1, NONE, (reservation) => {
    for (const amount of [NaN, Infinity, -1]) {
      assert.throws(() => reservation.settle({ amount, exact: true }), /amount/i);
    }
    reservation.settle({ amount: 1, exact: true });
  });
  assert.equal(account(pool).allocations[0].spent, 1);
  assert.equal(account(pool).available, 999);
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

test('A later upstream failure cannot shorten an overlapping Retry-After cooldown', async () => {
  const time = { ms: DATE };
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')), time);
  await pool.attempt(TAVILY, 1, NONE, async (limited) => {
    await pool.attempt(TAVILY, 1, NONE, (upstream) => {
      limited.fail({ status: 429, effect: EFFECT.RATE_LIMIT, retryAfterMs: 120000 });
      upstream.fail({ status: 500, effect: EFFECT.UPSTREAM });
    });
  });
  assert.equal(account(pool).retryAt, new Date(DATE + 120000).toISOString());
  assert.equal(account(pool).cooldownReason, EFFECT.RATE_LIMIT);
  time.ms += 11000;
  assert.equal(await pool.attempt(TAVILY, 1, NONE, () => assert.fail('Retry-After has not elapsed')), null);
  time.ms = DATE + 120001;
  assert.equal(account(pool).status, 'active');
});

test('An auth-disabled Account reports no automatic retry time after an overlapping rate limit', async () => {
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')));
  await pool.attempt(TAVILY, 1, NONE, async (auth) => {
    await pool.attempt(TAVILY, 1, NONE, (rate) => {
      auth.fail({ status: 401, effect: EFFECT.AUTH });
      rate.fail({ status: 429, effect: EFFECT.RATE_LIMIT, retryAfterMs: 30000 });
    });
  });
  assert.equal(account(pool).status, 'auth');
  assert.equal(account(pool).cooldownReason, null);
  assert.equal(account(pool).retryAt, null, 'the cooldown expiry does not undo the auth disable');
});

test('Correcting spend clears a disable without discarding a concurrent cooldown', async () => {
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')));
  await pool.attempt(TAVILY, 1, NONE, async (auth) => {
    await pool.attempt(TAVILY, 1, NONE, (limited) => {
      auth.fail({ status: 401, effect: EFFECT.AUTH });
      limited.fail({ status: 429, effect: EFFECT.RATE_LIMIT, retryAfterMs: 30000 });
    });
  });
  pool.setSpent('a', 'free', 5);
  assert.equal(account(pool).status, 'cooldown');
  assert.equal(account(pool).retryAt, new Date(DATE + 30000).toISOString());
  pool.enable('a');
  assert.equal(account(pool).status, 'active');
});

test('A later quota failure cannot undo an auth disable from an overlapping Attempt', async () => {
  const time = { ms: DATE };
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')), time);
  await pool.attempt(TAVILY, 1, NONE, async (auth) => {
    await pool.attempt(TAVILY, 1, NONE, (quota) => {
      auth.fail({ status: 401, effect: EFFECT.AUTH });
      quota.fail({ status: 433, effect: EFFECT.QUOTA });
    });
  });
  time.ms = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(account(pool).status, 'auth', 'a reset cannot re-enable an auth-disabled Account');
  pool.enable('a');
  assert.equal(account(pool).status, 'active');
});

test('A later quota failure cannot undo a blocked Account', async () => {
  const time = { ms: DATE };
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')), time);
  await pool.attempt(TAVILY, 1, NONE, async (blocked) => {
    await pool.attempt(TAVILY, 1, NONE, (quota) => {
      blocked.fail({ status: 403, effect: EFFECT.BLOCKED });
      quota.fail({ status: 433, effect: EFFECT.QUOTA });
    });
  });
  time.ms = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(account(pool).status, 'blocked');
});

test('A manual disable survives a later quota failure until set-spent re-enables the Account', async () => {
  const time = { ms: DATE };
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')), time);
  await pool.attempt(TAVILY, 1, NONE, (reservation) => {
    pool.disable('a');
    reservation.fail({ status: 433, effect: EFFECT.QUOTA });
  });
  time.ms = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(account(pool).status, 'manual');
  assert.equal(await pool.attempt(TAVILY, 1, NONE, () => assert.fail('disabled')), null);
  pool.setSpent('a', 'free', 0);
  assert.equal(account(pool).status, 'active');
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

test('Balance checks become the Account credit; an error keeps the last good balance; unknown ids throw', () => {
  const pool = poolOf(config(tavily('t', 'tvly-aaaaaaaa'), tavily('u', 'tvly-bbbbbbbb')));
  pool.recordBalanceCheck('t', { remaining: 12.3456789, details: { plan: 'x' } });
  pool.recordBalanceCheck('t', new Error('HTTP 429'));
  const [t, u] = pool.snapshot().accounts;
  assert.equal(t.providerBalance.remaining, 12.345679, 'an error keeps the last good balance');
  assert.deepEqual(t.providerBalance.details, { plan: 'x' });
  assert.equal(t.reconcileError.message, 'HTTP 429');
  assert.equal(t.available, 12.345679, 'the Provider-reported balance is the credit');
  assert.equal(t.balance.source, 'provider');
  assert.equal(u.providerBalance, null);
  assert.throws(() => pool.recordBalanceCheck('nope', { remaining: 1 }), /Unknown account id/);
  pool.recordBalanceCheck('t', { remaining: 3 });
  assert.equal(account(pool).reconcileError, null, 'a good check clears the last error');
});

const unsaved = (ending) => (err) => err instanceof StateNotSaved && err.ending === ending;

test('Failed persistence preserves billed spend and pauses Attempts until the state can be saved', async () => {
  const store = flakyStore();
  const cfg = config(tavily('a', 'tvly-secret-key'));
  const pool = poolOf(cfg, { ms: DATE }, store);
  store.writable = false;
  await assert.rejects(pool.attempt(TAVILY, 1, NONE, (r) => r.settle({ amount: 2, exact: true })), (err) => {
    assert.ok(unsaved(ENDING.BILLED)(err));
    assert.doesNotMatch(err.message, /secret-key/, 'the storage error never leaves the pool');
    return true;
  });
  let snapshot = pool.snapshot();
  assert.equal(snapshot.accounts[0].allocations[0].spent, 2);
  assert.equal(snapshot.recent.at(-1).cost, 2);
  assert.equal(snapshot.persistence.state, 'unavailable');
  let started = false;
  await assert.rejects(pool.attempt(TAVILY, 1, NONE, () => { started = true; }), unsaved(null), 'Attempts are paused');
  assert.equal(started, false);

  store.writable = true;
  await pool.attempt(TAVILY, 1, NONE, (r) => r.settle({ amount: 1, exact: true }));
  snapshot = pool.snapshot();
  assert.equal(snapshot.persistence.state, 'ok');
  assert.equal(poolOf(cfg, { ms: DATE }, store).snapshot().accounts[0].allocations[0].spent, 3);
});

test('A failed save after a refused Attempt reports the failed ending, with no charge', async () => {
  const store = flakyStore();
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')), { ms: DATE }, store);
  store.writable = false;
  await assert.rejects(pool.attempt(TAVILY, 1, NONE, (r) => r.fail({ status: 'network', effect: EFFECT.UPSTREAM })), unsaved(ENDING.FAILED));
  assert.deepEqual([account(pool).allocations[0].spent, account(pool).possiblyBilled, account(pool).failures], [0, 0, 1]);
  assert.equal(pool.snapshot().persistence.state, 'unavailable');
});

test('Restart after a failed billed save can only load the last successful state', () => withTempDir(async (dir) => {
  const path = join(dir, 'pool-state.json');
  const backing = fileStore(path);
  let writable = true;
  const store = {
    load: () => backing.load(),
    save: (state) => { if (!writable) throw new Error('disk failure'); backing.save(state); }
  };
  const cfg = config(tavily('a', 'tvly-aaaaaaaa'));
  const pool = poolOf(cfg, { ms: DATE }, store);
  writable = false;
  await assert.rejects(pool.attempt(TAVILY, 1, NONE, (reservation) => reservation.settle({ amount: 2, exact: true })), StateNotSaved);
  assert.equal(account(pool).allocations[0].spent, 2);
  assert.equal(pool.snapshot().persistence.state, 'unavailable');

  // The process dies before its live state is saved. Once storage returns, a new pool only sees the old file.
  writable = true;
  const restarted = poolOf(cfg, { ms: DATE }, fileStore(path));
  assert.equal(account(restarted).allocations[0].spent, 0);
  assert.equal(restarted.snapshot().recent.length, 0);
}));

test('A failed save after a possibly billed Attempt keeps its estimate and reason', async () => {
  const store = flakyStore();
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')), { ms: DATE }, store);
  store.writable = false;
  await assert.rejects(pool.attempt(TAVILY, 2, NONE, (r) => r.settlePossiblyBilled(POSSIBLY_BILLED.TIMEOUT)), unsaved(ENDING.POSSIBLY_BILLED));
  assert.equal(account(pool).allocations[0].spent, 2);
  assert.equal(account(pool).possiblyBilled, 1);
  assert.equal(pool.snapshot().recent.at(-1).status, 'timeout');
  store.writable = true;
  await pool.attempt(TAVILY, 1, NONE, (r) => r.fail({ status: 400 }));
  assert.equal(poolOf(config(tavily('a', 'tvly-aaaaaaaa')), { ms: DATE }, store).snapshot().accounts[0].allocations[0].spent, 2);
});

test('A failed admin save keeps its live change and pauses Attempts until the change is durable', async () => {
  const store = flakyStore();
  const pool = poolOf(config(tavily('a', 'tvly-aaaaaaaa')), { ms: DATE }, store);
  store.writable = false;
  assert.throws(() => pool.disable('a'), unsaved(null));
  assert.equal(account(pool).status, 'manual');
  assert.equal(pool.snapshot().persistence.state, 'unavailable');
  await assert.rejects(pool.attempt(TAVILY, 1, NONE, () => assert.fail('paused')), unsaved(null));
  store.writable = true;
  assert.equal(await pool.attempt(TAVILY, 1, NONE, () => assert.fail('disabled')), null);
  assert.equal(pool.snapshot().persistence.state, 'ok');
  assert.equal(poolOf(config(tavily('a', 'tvly-aaaaaaaa')), { ms: DATE }, store).snapshot().accounts[0].status, 'manual');
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
    [[{ id: 'bonus', period: 'once', limit: 10, expires: 'never' }], '2026-12-01T00:00:00.000Z', 'Provider free credit resets on the 1st anyway']
  ];
  for (const [allocations, expected, why] of cases) {
    const at = nextCreditChange(allocations, now);
    assert.equal(at ? new Date(at).toISOString() : null, expected, why);
  }
});

test('set-spent "month" corrects this month\'s spend on any Account, including unknown-balance ones', () => {
  const cfg = config(exa('e', 'exa-real-aaa'));
  cfg.accounts[0].allocations = [];
  const pool = poolOf(cfg);
  pool.setSpent('e', 'month', 1.25);
  const e = pool.snapshot().accounts[0];
  assert.deepEqual([e.balance.source, e.balance.spentThisMonth], ['unknown', 1.25]);
  assert.throws(() => pool.setSpent('e', 'free', 1), /Unknown allocation/);
});
