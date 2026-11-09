import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { monthlyWindow } from './config.mjs';
import { EFFECT, PROVIDERS } from './providers.mjs';
import { round6, isNonNegativeNumber } from './numbers.mjs';

const capAtZero = (n) => Math.max(0, n);
const COOLDOWN_MS = Object.freeze({ [EFFECT.FORBIDDEN]: 10 * 60 * 1000, [EFFECT.UPSTREAM]: 10 * 1000 });
const RECENT_LIMIT = 50;

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* no-op */ }
    throw err;
  }
}

const expiryOf = (b) => (b.expiresAt ? Date.parse(b.expiresAt) : Infinity);

// Never exposes key material in persisted state or user-facing status.
export class AccountManager {
  constructor(config, { statePath, now = () => Date.now(), readOnly = false } = {}) {
    this.config = config;
    this.statePath = statePath;
    this.now = now;
    this.readOnly = readOnly;
    this.pending = new Map();
    this.recent = [];
    this.state = { version: 1, accounts: {} };
    if (statePath && existsSync(statePath)) {
      const stored = JSON.parse(readFileSync(statePath, 'utf8'));
      if (stored.version !== 1 || !stored.accounts || typeof stored.accounts !== 'object') {
        throw new Error('Unsupported/corrupt state version');
      }
      this.state = stored;
    }
    this.sync();
    this.save();
  }

  get accounts() { return this.config.accounts; }
  save() {
    if (this.statePath && !this.readOnly) atomicWriteJson(this.statePath, this.state);
  }
  sync() {
    for (const account of this.accounts) {
      const entry = this.state.accounts[account.id] ?? { buckets: {}, disabled: null, cooldownUntil: 0, blockedUntil: 0, requests: 0, failures: 0 };
      entry.buckets ??= {};
      entry.possiblyBilled ??= 0;
      for (const bucket of account.allocations) {
        const window = bucket.period === 'monthly' ? monthlyWindow(this.now(), bucket.resetDay ?? 1).key : 'once';
        if (entry.buckets[bucket.id]?.window !== window) {
          entry.buckets[bucket.id] = { window, spent: 0, exactCalls: 0, estimatedCalls: 0 };
          if (entry.disabled === 'quota') { entry.disabled = null; entry.blockedUntil = 0; }
        }
      }
      if (entry.disabled === 'quota' && entry.blockedUntil && this.now() >= entry.blockedUntil) {
        entry.disabled = null;
        entry.blockedUntil = 0;
      }
      if (entry.cooldownUntil && entry.cooldownUntil <= this.now()) { entry.cooldownUntil = 0; entry.cooldownReason = null; }
      this.state.accounts[account.id] = entry;
    }
  }
  activeBuckets(account) {
    const state = this.state.accounts[account.id];
    return account.allocations
      .filter((b) => expiryOf(b) > this.now() && (!b.startsAt || Date.parse(b.startsAt) <= this.now()))
      .map((b) => {
        const nextReset = b.period === 'monthly' ? monthlyWindow(this.now(), b.resetDay ?? 1).nextReset : Infinity;
        const deadline = Math.min(nextReset, expiryOf(b));
        const remaining = capAtZero(b.limit - (state.buckets[b.id]?.spent || 0) - this.held(account.id, b.id));
        return { ...b, remaining, deadline };
      })
      .filter((b) => b.remaining > 1e-9)
      // Spend short-lived one-time promo grants before recurring free allowances (Exa also draws soonest-expiring first).
      .sort((a, b) => Number(b.period === 'once') - Number(a.period === 'once') || a.deadline - b.deadline || b.remaining - a.remaining);
  }
  held(accountId, bucketId) {
    let n = 0;
    for (const p of this.pending.values()) if (p.accountId === accountId) n += p.allocations[bucketId] || 0;
    return n;
  }
  available(account) {
    return this.activeBuckets(account).reduce((s, b) => s + b.remaining, 0);
  }
  choose(provider, amount, excluded = new Set()) {
    this.sync();
    const options = [];
    for (const account of this.accounts) {
      if (account.provider !== provider || excluded.has(account.id)) continue;
      const state = this.state.accounts[account.id];
      if (state.disabled || (state.cooldownUntil && state.cooldownUntil > this.now())) continue;
      const buckets = this.activeBuckets(account);
      const available = buckets.reduce((s, b) => s + b.remaining, 0);
      if (!buckets.length || available + 1e-9 < amount) continue;
      options.push({ account, promoFirst: buckets[0].period === 'once', deadline: buckets[0].deadline, available });
    }
    options.sort((a, b) => Number(b.promoFirst) - Number(a.promoFirst) || a.deadline - b.deadline || b.available - a.available || a.account.id.localeCompare(b.account.id));
    return options[0]?.account ?? null;
  }
  reserve(account, requested) {
    this.sync();
    const allocations = {};
    let toReserve = requested;
    for (const b of this.activeBuckets(account)) {
      const used = Math.min(b.remaining, toReserve);
      allocations[b.id] = round6(used);
      toReserve -= used;
      if (toReserve < 1e-9) break;
    }
    if (toReserve > 1e-8) throw new Error('Insufficient estimated budget');
    const token = randomBytes(12).toString('hex');
    this.pending.set(token, { accountId: account.id, allocations });
    return token;
  }
  release(token) { this.pending.delete(token); }
  /**
   * Record spend for a reservation.
   * meta.requestId: provider request id for support tickets; meta.possiblyBilled: the attempt timed out or the
   * client left after the request was sent, so the provider may or may not have billed it.
   */
  commit(token, amount, exact = false, meta = {}) {
    const reservation = this.pending.get(token);
    if (!reservation) throw new Error('Unknown reservation');
    this.pending.delete(token);
    const account = this.accounts.find((a) => a.id === reservation.accountId);
    const entry = this.state.accounts[account.id];
    let left = amount;
    for (const b of this.activeBuckets(account)) {
      const bucket = entry.buckets[b.id];
      const used = Math.min(left, capAtZero(b.limit - bucket.spent));
      bucket.spent = round6(bucket.spent + used);
      left -= used;
      if (left < 1e-8) break;
    }
    if (left > 1e-8) {
      // A provider can bill more than our estimate. Attribute the overage; never pretend it vanished.
      const fallback = account.allocations.find((b) => b.id in entry.buckets);
      entry.buckets[fallback.id].spent = round6(entry.buckets[fallback.id].spent + left);
    }
    const first = account.allocations.find((b) => b.id in entry.buckets);
    if (meta.possiblyBilled) {
      entry.possiblyBilled++;
    } else {
      // Exact vs estimated counts are request-level provenance, not provider account balances.
      entry.buckets[first.id][exact ? 'exactCalls' : 'estimatedCalls']++;
      entry.requests++;
      entry.lastSuccessAt = new Date(this.now()).toISOString();
    }
    if (meta.requestId) entry.lastRequestId = meta.requestId;
    this.save();
  }
  /** Apply the effect of a classified upstream failure (an EFFECT value from providers.mjs, or null). */
  recordFailure(account, { status, effect = null, retryAfterMs = 0, tag = null } = {}) {
    const state = this.state.accounts[account.id];
    state.failures++;
    state.lastFailureAt = new Date(this.now()).toISOString();
    state.lastStatus = status;
    state.lastErrorTag = tag;
    if (effect === EFFECT.AUTH || effect === EFFECT.BLOCKED) {
      state.disabled = effect; // Explicit unblocking required after fixing credentials / contacting the provider.
    } else if (effect === EFFECT.QUOTA) {
      state.disabled = 'quota';
      // Promo expiry may activate the account's free allowance before the next monthly reset.
      const upcomingPromoExpiry = account.allocations
        .filter((b) => b.period === 'once' && b.expiresAt && Date.parse(b.expiresAt) > this.now())
        .map((b) => Date.parse(b.expiresAt));
      const upcomingMonthlyReset = account.allocations.filter((b) => b.period === 'monthly')
        .map((b) => monthlyWindow(this.now(), b.resetDay ?? 1).nextReset);
      const nextTry = Math.min(...upcomingMonthlyReset, ...upcomingPromoExpiry);
      state.blockedUntil = Number.isFinite(nextTry) ? nextTry : 0;
    } else if (effect === EFFECT.RATE_LIMIT) {
      state.cooldownUntil = this.now() + Math.max(1000, Math.min(120000, retryAfterMs || 30000));
      state.cooldownReason = effect;
    } else if (effect in COOLDOWN_MS) {
      state.cooldownUntil = this.now() + COOLDOWN_MS[effect];
      state.cooldownReason = effect;
    }
    this.save();
  }
  /** Store a provider-reported balance for display. Report-only: local accounting is not changed. */
  recordProviderBalance(accountId, result) {
    const entry = this.state.accounts[accountId];
    if (!entry) throw new Error('Unknown account id');
    entry.reconciled = { at: new Date(this.now()).toISOString(), remaining: round6(result.remaining), details: result.details ?? {} };
    delete entry.reconcileError;
    this.save();
  }
  noteReconcileError(accountId, message) {
    const entry = this.state.accounts[accountId];
    if (!entry) return;
    entry.reconcileError = { at: new Date(this.now()).toISOString(), message };
    this.save();
  }
  /** In-memory request log for /status (no keys, no queries). */
  log(item) {
    this.recent.push({ at: new Date(this.now()).toISOString(), ...item });
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
  }
  change(accountId, op, data = {}) {
    this.sync();
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error('Unknown account id');
    const entry = this.state.accounts[account.id];
    if (op === 'enable') { entry.disabled = null; entry.blockedUntil = 0; entry.cooldownUntil = 0; entry.cooldownReason = null; }
    else if (op === 'disable') entry.disabled = 'manual';
    else if (op === 'set-spent') {
      const b = account.allocations.find((x) => x.id === data.allocationId);
      if (!b) throw new Error('Unknown allocation');
      if (!isNonNegativeNumber(data.spent)) throw new Error('spent must be nonnegative number');
      entry.buckets[b.id].spent = round6(data.spent);
      entry.disabled = null;
      entry.blockedUntil = 0;
    } else throw new Error('Unknown operation');
    this.save();
  }
  snapshot() {
    this.sync();
    return {
      updatedAt: new Date(this.now()).toISOString(),
      note: 'Local accounting. Exa uses costDollars.total and Tavily uses usage.credits when reported; otherwise estimates. "providerBalance" is the last report-only balance check, if any.',
      accounts: this.accounts.map((account) => {
        const entry = this.state.accounts[account.id];
        const cooling = entry.cooldownUntil > this.now();
        return {
          id: account.id, provider: account.provider, unit: PROVIDERS[account.provider].unit,
          status: entry.disabled || (cooling ? 'cooldown' : 'active'),
          cooldownReason: cooling ? entry.cooldownReason ?? null : null,
          retryAt: entry.disabled === 'quota' ? (entry.blockedUntil ? new Date(entry.blockedUntil).toISOString() : null) : (cooling ? new Date(entry.cooldownUntil).toISOString() : null),
          requests: entry.requests, failures: entry.failures, possiblyBilled: entry.possiblyBilled,
          lastStatus: entry.lastStatus ?? null, lastErrorTag: entry.lastErrorTag ?? null, lastRequestId: entry.lastRequestId ?? null,
          available: round6(this.available(account)),
          providerBalance: entry.reconciled ?? null,
          reconcileError: entry.reconcileError ?? null,
          allocations: account.allocations.map((b) => {
            const expired = expiryOf(b) <= this.now();
            const used = entry.buckets[b.id]?.spent ?? 0;
            const active = !expired && (!b.startsAt || Date.parse(b.startsAt) <= this.now());
            return { id: b.id, period: b.period, limit: b.limit, spent: used,
              remainingEstimate: active ? round6(capAtZero(b.limit - used)) : 0,
              expiresAt: b.expiresAt || null, startsAt: b.startsAt || null, active,
              window: entry.buckets[b.id]?.window ?? null };
          })
        };
      }),
      recent: [...this.recent]
    };
  }
}
