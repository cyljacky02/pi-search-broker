// Account pool: every configured account, its allocations, health and spend. Callers get credit through a
// Reservation, which ends exactly once; everything else (allocation windows, promo-first ordering, held credit,
// cooldowns, quota re-opening, persistence, the attempt log) stays behind this interface.
// Never exposes key material in persisted state or user-facing status.
import { monthlyWindow } from './config.mjs';
import { EFFECT, PROVIDERS } from './providers.mjs';
import { round6, isNonNegativeNumber } from './numbers.mjs';
import { STATE_VERSION } from './pool/store.mjs';

const capAtZero = (n) => Math.max(0, n);
const COOLDOWN_MS = Object.freeze({ [EFFECT.FORBIDDEN]: 10 * 60 * 1000, [EFFECT.UPSTREAM]: 10 * 1000 });
const RECENT_LIMIT = 50;
const expiryOf = (a) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity);

/**
 * @param accounts  validated config accounts (with resolved keys; the keys never leave this process)
 * @param store     { load() -> state | null, save(state) } (see pool/store.mjs)
 * @param logger    optional (line) => void for one line per attempt
 */
export function createAccountPool(accounts, { store, now = () => Date.now(), logger = null }) {
  const state = store.load() ?? { version: STATE_VERSION, accounts: {} };
  const holds = new Set(); // credit held by open reservations: { accountId, allocations: { [allocationId]: amount } }
  const recent = [];
  const log = (line) => { try { logger?.(line); } catch { /* logging must never break a request */ } };
  const save = () => store.save(state);
  const byId = (id) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new Error('Unknown account id');
    return account;
  };

  /** Lazy time-based transitions: new allocation windows, quota re-opening, expired cooldowns. Runs at every entry point. */
  function refresh() {
    for (const account of accounts) {
      const entry = state.accounts[account.id] ?? { buckets: {}, disabled: null, cooldownUntil: 0, blockedUntil: 0, requests: 0, failures: 0 };
      entry.buckets ??= {};
      entry.possiblyBilled ??= 0;
      for (const allocation of account.allocations) {
        const window = allocation.period === 'monthly' ? monthlyWindow(now(), allocation.resetDay ?? 1).key : 'once';
        if (entry.buckets[allocation.id]?.window !== window) {
          entry.buckets[allocation.id] = { window, spent: 0, exactCalls: 0, estimatedCalls: 0 };
          if (entry.disabled === 'quota') { entry.disabled = null; entry.blockedUntil = 0; }
        }
      }
      if (entry.disabled === 'quota' && entry.blockedUntil && now() >= entry.blockedUntil) {
        entry.disabled = null;
        entry.blockedUntil = 0;
      }
      if (entry.cooldownUntil && entry.cooldownUntil <= now()) { entry.cooldownUntil = 0; entry.cooldownReason = null; }
      state.accounts[account.id] = entry;
    }
  }

  function held(accountId, allocationId) {
    let n = 0;
    for (const h of holds) if (h.accountId === accountId) n += h.allocations[allocationId] || 0;
    return n;
  }
  /** Allocations that can be spent now, in spending order, with what is left after open reservations. */
  function activeAllocations(account) {
    const entry = state.accounts[account.id];
    return account.allocations
      .filter((a) => expiryOf(a) > now() && (!a.startsAt || Date.parse(a.startsAt) <= now()))
      .map((a) => {
        const nextReset = a.period === 'monthly' ? monthlyWindow(now(), a.resetDay ?? 1).nextReset : Infinity;
        const deadline = Math.min(nextReset, expiryOf(a));
        const remaining = capAtZero(a.limit - (entry.buckets[a.id]?.spent || 0) - held(account.id, a.id));
        return { ...a, remaining, deadline };
      })
      .filter((a) => a.remaining > 1e-9)
      // Spend short-lived one-time promo grants before recurring free allowances (Exa also draws soonest-expiring first).
      .sort((a, b) => Number(b.period === 'once') - Number(a.period === 'once') || a.deadline - b.deadline || b.remaining - a.remaining);
  }
  const available = (account) => activeAllocations(account).reduce((s, a) => s + a.remaining, 0);

  function choose(provider, amount, excluded) {
    const options = [];
    for (const account of accounts) {
      if (account.provider !== provider || excluded.has(account.id)) continue;
      const entry = state.accounts[account.id];
      if (entry.disabled || (entry.cooldownUntil && entry.cooldownUntil > now())) continue;
      const usable = activeAllocations(account);
      const total = usable.reduce((s, a) => s + a.remaining, 0);
      if (!usable.length || total + 1e-9 < amount) continue;
      options.push({ account, usable, promoFirst: usable[0].period === 'once', deadline: usable[0].deadline, total });
    }
    options.sort((a, b) => Number(b.promoFirst) - Number(a.promoFirst) || a.deadline - b.deadline || b.total - a.total || a.account.id.localeCompare(b.account.id));
    return options[0] ?? null;
  }

  function charge(account, amount, exact, { possiblyBilled = false, requestId = null } = {}) {
    const entry = state.accounts[account.id];
    let left = amount;
    for (const a of activeAllocations(account)) {
      const spent = entry.buckets[a.id];
      const used = Math.min(left, capAtZero(a.limit - spent.spent));
      spent.spent = round6(spent.spent + used);
      left -= used;
      if (left < 1e-8) break;
    }
    const first = account.allocations.find((a) => a.id in entry.buckets);
    // A provider can bill more than our estimate. Attribute the overage; never pretend it vanished.
    if (left > 1e-8) entry.buckets[first.id].spent = round6(entry.buckets[first.id].spent + left);
    if (possiblyBilled) {
      entry.possiblyBilled++;
    } else {
      // Exact vs estimated counts are request-level provenance, not provider account balances.
      entry.buckets[first.id][exact ? 'exactCalls' : 'estimatedCalls']++;
      entry.requests++;
      entry.lastSuccessAt = new Date(now()).toISOString();
    }
    if (requestId) entry.lastRequestId = requestId;
  }

  function applyFailure(account, { status, effect = null, retryAfterMs = 0, tag = null }) {
    const entry = state.accounts[account.id];
    entry.failures++;
    entry.lastFailureAt = new Date(now()).toISOString();
    entry.lastStatus = status;
    entry.lastErrorTag = tag;
    if (effect === EFFECT.AUTH || effect === EFFECT.BLOCKED) {
      entry.disabled = effect; // Explicit unblocking required after fixing credentials / contacting the provider.
    } else if (effect === EFFECT.QUOTA) {
      entry.disabled = 'quota';
      // Promo expiry may activate the account's free allowance before the next monthly reset.
      const upcomingPromoExpiry = account.allocations
        .filter((a) => a.period === 'once' && a.expiresAt && Date.parse(a.expiresAt) > now())
        .map((a) => Date.parse(a.expiresAt));
      const upcomingMonthlyReset = account.allocations.filter((a) => a.period === 'monthly')
        .map((a) => monthlyWindow(now(), a.resetDay ?? 1).nextReset);
      const nextTry = Math.min(...upcomingMonthlyReset, ...upcomingPromoExpiry);
      entry.blockedUntil = Number.isFinite(nextTry) ? nextTry : 0;
    } else if (effect === EFFECT.RATE_LIMIT) {
      entry.cooldownUntil = now() + Math.max(1000, Math.min(120000, retryAfterMs || 30000));
      entry.cooldownReason = effect;
    } else if (effect in COOLDOWN_MS) {
      entry.cooldownUntil = now() + COOLDOWN_MS[effect];
      entry.cooldownReason = effect;
    }
  }

  function recordAttempt(item) {
    recent.push({ at: new Date(now()).toISOString(), ...item });
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
    log(`${item.provider}${item.path} ${item.account} -> ${item.status}${item.requestId ? ` req=${item.requestId}` : ''}${item.tag ? ` tag=${item.tag}` : ''}${item.cost !== undefined ? ` cost=${item.cost}${item.exact ? '' : '~'}` : ''}`);
  }

  /**
   * Hold `estimate` on the best account for `route.provider`, skipping `excludedIds`. Returns null when no account
   * can cover the estimate. The returned Reservation must end exactly once:
   *  - settle({status, amount, exact, requestId}): the provider answered and billed `amount`;
   *  - settleUncertain(reason): sent but the outcome is unknown ('timeout' | 'client-closed' | 'invalid-response');
   *    charged at the estimate as possibly billed;
   *  - fail({status, effect, tag, retryAfterMs, requestId}): the provider refused; credit returns, the effect applies;
   *  - abandon(): never sent; credit returns with no penalty.
   */
  function reserve(route, estimate, excludedIds = new Set()) {
    refresh();
    const choice = choose(route.provider, estimate, excludedIds);
    if (!choice) return null;
    const { account } = choice;
    const allocations = {};
    let toHold = estimate;
    for (const a of choice.usable) {
      const used = Math.min(a.remaining, toHold);
      allocations[a.id] = round6(used);
      toHold -= used;
      if (toHold < 1e-9) break;
    }
    const hold = { accountId: account.id, allocations };
    holds.add(hold);
    const started = now();
    let open = true;

    const end = (status, extra, change) => {
      if (!open) throw new Error('Reservation already ended');
      open = false;
      holds.delete(hold);
      refresh();
      change?.();
      if (change) save();
      recordAttempt({ provider: route.provider, path: route.path, account: account.id, status, ms: now() - started, ...extra });
    };
    const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

    return {
      account,
      get open() { return open; },
      settle({ status = 200, amount, exact, requestId = null }) {
        end(status, defined({ requestId, cost: amount, exact }), () => charge(account, amount, exact, { requestId }));
      },
      settleUncertain(reason) {
        end(reason, {}, () => {
          charge(account, estimate, false, { possiblyBilled: true });
          // A timeout says something about the account's latency; a client leaving or a bad body does not.
          if (reason === 'timeout') applyFailure(account, { status: reason });
        });
      },
      fail({ status, effect = null, tag = null, retryAfterMs = 0, requestId = null }) {
        end(status, defined({ tag, requestId }), () => applyFailure(account, { status, effect, tag, retryAfterMs }));
      },
      abandon() { end('abandoned', {}, null); }
    };
  }

  function change(id, update) {
    refresh();
    const account = byId(id);
    update(account, state.accounts[account.id]);
    save();
  }

  function snapshot() {
    refresh();
    return {
      updatedAt: new Date(now()).toISOString(),
      note: 'Local accounting. Exa uses costDollars.total and Tavily uses usage.credits when reported; otherwise estimates. "providerBalance" is the last report-only balance check, if any.',
      accounts: accounts.map((account) => {
        const entry = state.accounts[account.id];
        const cooling = entry.cooldownUntil > now();
        return {
          id: account.id, provider: account.provider, unit: PROVIDERS[account.provider].unit,
          status: entry.disabled || (cooling ? 'cooldown' : 'active'),
          cooldownReason: cooling ? entry.cooldownReason ?? null : null,
          retryAt: entry.disabled === 'quota' ? (entry.blockedUntil ? new Date(entry.blockedUntil).toISOString() : null) : (cooling ? new Date(entry.cooldownUntil).toISOString() : null),
          requests: entry.requests, failures: entry.failures, possiblyBilled: entry.possiblyBilled,
          lastStatus: entry.lastStatus ?? null, lastErrorTag: entry.lastErrorTag ?? null, lastRequestId: entry.lastRequestId ?? null,
          available: round6(available(account)),
          providerBalance: entry.reconciled ?? null,
          reconcileError: entry.reconcileError ?? null,
          allocations: account.allocations.map((a) => {
            const expired = expiryOf(a) <= now();
            const used = entry.buckets[a.id]?.spent ?? 0;
            const active = !expired && (!a.startsAt || Date.parse(a.startsAt) <= now());
            return { id: a.id, period: a.period, limit: a.limit, spent: used,
              remainingEstimate: active ? round6(capAtZero(a.limit - used)) : 0,
              expiresAt: a.expiresAt || null, startsAt: a.startsAt || null, active,
              window: entry.buckets[a.id]?.window ?? null };
          })
        };
      }),
      recent: [...recent]
    };
  }

  refresh();
  save();

  return {
    /** Configured accounts (with keys: for in-process callers such as the reconciler only; never serialize). */
    accounts,
    reserve,
    snapshot,
    enable: (id) => change(id, (_a, entry) => { entry.disabled = null; entry.blockedUntil = 0; entry.cooldownUntil = 0; entry.cooldownReason = null; }),
    disable: (id) => change(id, (_a, entry) => { entry.disabled = 'manual'; }),
    /** Correct local spend for one allocation to match the provider dashboard. Also re-enables the account. */
    setSpent: (id, allocationId, amount) => change(id, (account, entry) => {
      if (!account.allocations.some((a) => a.id === allocationId)) throw new Error('Unknown allocation');
      if (!isNonNegativeNumber(amount)) throw new Error('spent must be nonnegative number');
      entry.buckets[allocationId].spent = round6(amount);
      entry.disabled = null;
      entry.blockedUntil = 0;
    }),
    /** Store a provider balance check: a { remaining, details } result, or an Error. Report-only. */
    recordBalanceCheck: (id, outcome) => change(id, (_a, entry) => {
      const at = new Date(now()).toISOString();
      if (outcome instanceof Error) { entry.reconcileError = { at, message: outcome.message }; return; }
      entry.reconciled = { at, remaining: round6(outcome.remaining), details: outcome.details ?? {} };
      delete entry.reconcileError;
    })
  };
}
