// Account pool: every configured account, its allocations, health and spend. Callers get credit through a
// Reservation, which ends exactly once; everything else (allocation windows, promo-first ordering, held credit,
// cooldowns, quota re-opening, persistence, the attempt log) stays behind this interface.
// Never exposes key material in persisted state or user-facing status.
import { PROVIDERS } from './providers.mjs';
import { round6, isNonNegativeNumber } from './numbers.mjs';
import { STATE_VERSION } from './pool/store.mjs';
import { windowOf, isActive, spendingOrder } from './pool/allocation.mjs';
import { applyFailure, recover, isUsable } from './pool/health.mjs';

const capAtZero = (n) => Math.max(0, n);
const RECENT_LIMIT = 50;

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
      const entry = state.accounts[account.id] ?? { allocations: {}, disabled: null, cooldownUntil: 0, quotaRetryAt: 0, requests: 0, failures: 0 };
      entry.allocations ??= {};
      entry.possiblyBilled ??= 0;
      let newWindow = false;
      for (const allocation of account.allocations) {
        const window = windowOf(allocation, now());
        if (entry.allocations[allocation.id]?.window !== window) {
          entry.allocations[allocation.id] = { window, spent: 0, exactCalls: 0, estimatedCalls: 0 };
          newWindow = true;
        }
      }
      recover(entry, now(), { newWindow });
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
    return spendingOrder(account.allocations, now(), {
      spentOf: (id) => entry.allocations[id]?.spent || 0,
      heldOf: (id) => held(account.id, id)
    });
  }
  const available = (account) => activeAllocations(account).reduce((s, a) => s + a.remaining, 0);

  function choose(provider, amount, excluded) {
    const options = [];
    for (const account of accounts) {
      if (account.provider !== provider || excluded.has(account.id)) continue;
      if (!isUsable(state.accounts[account.id], now())) continue;
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
      const spent = entry.allocations[a.id];
      const used = Math.min(left, capAtZero(a.limit - spent.spent));
      spent.spent = round6(spent.spent + used);
      left -= used;
      if (left < 1e-8) break;
    }
    const first = account.allocations.find((a) => a.id in entry.allocations);
    // A provider can bill more than our estimate. Attribute the overage; never pretend it vanished.
    if (left > 1e-8) entry.allocations[first.id].spent = round6(entry.allocations[first.id].spent + left);
    if (possiblyBilled) {
      entry.possiblyBilled++;
    } else {
      // Exact vs estimated counts are request-level provenance, not provider account balances.
      entry.allocations[first.id][exact ? 'exactCalls' : 'estimatedCalls']++;
      entry.requests++;
      entry.lastSuccessAt = new Date(now()).toISOString();
    }
    if (requestId) entry.lastRequestId = requestId;
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
          if (reason === 'timeout') applyFailure(state.accounts[account.id], account, { status: reason }, now());
        });
      },
      fail({ status, effect = null, tag = null, retryAfterMs = 0, requestId = null }) {
        end(status, defined({ tag, requestId }), () => applyFailure(state.accounts[account.id], account, { status, effect, tag, retryAfterMs }, now()));
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
          retryAt: entry.disabled === 'quota' ? (entry.quotaRetryAt ? new Date(entry.quotaRetryAt).toISOString() : null) : (cooling ? new Date(entry.cooldownUntil).toISOString() : null),
          requests: entry.requests, failures: entry.failures, possiblyBilled: entry.possiblyBilled,
          lastStatus: entry.lastStatus ?? null, lastErrorTag: entry.lastErrorTag ?? null, lastRequestId: entry.lastRequestId ?? null,
          available: round6(available(account)),
          providerBalance: entry.providerBalance ?? null,
          reconcileError: entry.reconcileError ?? null,
          allocations: account.allocations.map((a) => {
            const used = entry.allocations[a.id]?.spent ?? 0;
            const active = isActive(a, now());
            return { id: a.id, period: a.period, limit: a.limit, spent: used,
              remainingEstimate: active ? round6(capAtZero(a.limit - used)) : 0,
              expiresAt: a.expiresAt || null, startsAt: a.startsAt || null, active,
              window: entry.allocations[a.id]?.window ?? null };
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
    enable: (id) => change(id, (_a, entry) => { entry.disabled = null; entry.quotaRetryAt = 0; entry.cooldownUntil = 0; entry.cooldownReason = null; }),
    disable: (id) => change(id, (_a, entry) => { entry.disabled = 'manual'; }),
    /** Correct local spend for one allocation to match the provider dashboard. Also re-enables the account. */
    setSpent: (id, allocationId, amount) => change(id, (account, entry) => {
      if (!account.allocations.some((a) => a.id === allocationId)) throw new Error('Unknown allocation');
      if (!isNonNegativeNumber(amount)) throw new Error('spent must be nonnegative number');
      entry.allocations[allocationId].spent = round6(amount);
      entry.disabled = null;
      entry.quotaRetryAt = 0;
    }),
    /** Store a provider balance check: a { remaining, details } result, or an Error. Report-only. */
    recordBalanceCheck: (id, outcome) => change(id, (_a, entry) => {
      const at = new Date(now()).toISOString();
      if (outcome instanceof Error) { entry.reconcileError = { at, message: outcome.message }; return; }
      entry.providerBalance = { at, remaining: round6(outcome.remaining), details: outcome.details ?? {} };
      delete entry.reconcileError;
    })
  };
}
