// Account pool: every configured account, its allocations, health and spend. Callers get credit one attempt at a
// time through a Reservation that ends exactly once; everything else (allocation windows, promo-first ordering,
// reserved credit, cooldowns, quota re-opening, persistence, the attempt log) stays behind this interface.
// Never exposes key material in persisted state or user-facing status.
import { PROVIDERS, EFFECT } from './providers.mjs';
import { round6, isNonNegativeNumber } from './numbers.mjs';
import { quietLogger } from './log.mjs';
import { STATE_VERSION } from './pool/store.mjs';
import { windowOf, isActive, remainingOf, spendingOrder } from './pool/allocation.mjs';
import { applyFailure, recover, isUsable } from './pool/health.mjs';

/** Why an attempt is possibly billed: it reached the provider, but whether it was billed is unknown. */
export const POSSIBLY_BILLED = Object.freeze({
  TIMEOUT: 'timeout',                  // the provider did not answer in time
  CLIENT_CLOSED: 'client-closed',      // the client went away mid-attempt
  INVALID_RESPONSE: 'invalid-response' // a 2xx whose body could not be read
});
const POSSIBLY_BILLED_REASONS = new Set(Object.values(POSSIBLY_BILLED));
const RECENT_LIMIT = 50;
const totalRemaining = (allocations) => allocations.reduce((sum, a) => sum + a.remaining, 0);

/** Split `amount` across `ordered` allocations, each taking at most capacityOf(allocation). */
function spread(amount, ordered, capacityOf) {
  const parts = [];
  let left = amount;
  for (const allocation of ordered) {
    if (left < 1e-9) break;
    const used = Math.min(left, capacityOf(allocation));
    parts.push([allocation, used]);
    left -= used;
  }
  return { parts, left };
}

/**
 * @param accounts  validated config accounts (with resolved keys; the keys never leave this process)
 * @param store     { load() -> state | null, save(state) } (see pool/store.mjs)
 * @param logger    optional (line) => void for one line per attempt
 */
export function createAccountPool(accounts, { store, now = () => Date.now(), logger = null }) {
  const state = store.load() ?? { version: STATE_VERSION, accounts: {} };
  const reserved = new Set(); // credit set aside by open reservations: { accountId, amounts: { [allocationId]: n } }
  const recent = [];
  const log = quietLogger(logger);
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

  function reservedOn(accountId, allocationId) {
    let n = 0;
    for (const credit of reserved) if (credit.accountId === accountId) n += credit.amounts[allocationId] || 0;
    return n;
  }
  /** Allocations that can be spent now, in spending order, with what is left after open reservations. */
  function activeAllocations(account) {
    const tallies = state.accounts[account.id].allocations;
    return spendingOrder(account.allocations, now(), {
      spentOf: (id) => tallies[id]?.spent || 0,
      reservedOf: (id) => reservedOn(account.id, id)
    });
  }

  function choose(provider, amount, excluded) {
    const options = [];
    for (const account of accounts) {
      if (account.provider !== provider || excluded.has(account.id)) continue;
      if (!isUsable(state.accounts[account.id], now())) continue;
      const usable = activeAllocations(account);
      const total = totalRemaining(usable);
      if (!usable.length || total + 1e-9 < amount) continue;
      options.push({ account, usable, promoFirst: usable[0].period === 'once', deadline: usable[0].deadline, total });
    }
    options.sort((a, b) => Number(b.promoFirst) - Number(a.promoFirst) || a.deadline - b.deadline || b.total - a.total || a.account.id.localeCompare(b.account.id));
    return options[0] ?? null;
  }

  function charge(account, amount, exact, { possiblyBilled = false, requestId = null } = {}) {
    const entry = state.accounts[account.id];
    const tallies = entry.allocations;
    const { parts, left } = spread(amount, activeAllocations(account), (a) => remainingOf(a, tallies[a.id].spent));
    for (const [allocation, used] of parts) tallies[allocation.id].spent = round6(tallies[allocation.id].spent + used);
    const first = account.allocations.find((a) => a.id in tallies);
    // A provider can bill more than our estimate. Attribute the overage; never pretend it vanished.
    if (left > 1e-8) tallies[first.id].spent = round6(tallies[first.id].spent + left);
    if (possiblyBilled) {
      entry.possiblyBilled++;
    } else {
      // Exact vs estimated counts are request-level provenance, not provider account balances.
      tallies[first.id][exact ? 'exactCalls' : 'estimatedCalls']++;
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
   * One attempt: reserve `estimate` on the best account for `route.provider` (skipping `excludedIds`) and call
   * `use(reservation)`. Returns null without calling `use` when no account can cover the estimate; otherwise
   * whatever `use` returns. Inside `use`, the Reservation ends exactly once (a second ending throws):
   *  - settle({status, amount, exact, requestId}): the provider answered and billed `amount`;
   *  - settlePossiblyBilled(reason): sent, outcome unknown (a POSSIBLY_BILLED reason); charged at the estimate;
   *  - fail({status, effect, tag, retryAfterMs, requestId}): the provider refused; credit returns, the effect applies.
   * If `use` returns or throws without ending it, the request was never sent: the credit returns with no penalty.
   */
  async function attempt(route, estimate, excludedIds, use) {
    refresh();
    const choice = choose(route.provider, estimate, excludedIds);
    if (!choice) return null;
    const { account } = choice;
    const { parts } = spread(estimate, choice.usable, (a) => a.remaining);
    const credit = { accountId: account.id, amounts: Object.fromEntries(parts.map(([a, used]) => [a.id, round6(used)])) };
    reserved.add(credit);
    const started = now();
    let open = true;
    const end = (status, extra, apply) => {
      if (!open) throw new Error('Reservation already ended');
      open = false;
      reserved.delete(credit);
      refresh();
      apply();
      save();
      recordAttempt({ provider: route.provider, path: route.path, account: account.id, status, ms: now() - started, ...extra });
    };
    const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

    const reservation = {
      account,
      settle({ status = 200, amount, exact, requestId = null }) {
        end(status, defined({ requestId, cost: amount, exact }), () => charge(account, amount, exact, { requestId }));
      },
      settlePossiblyBilled(reason) {
        if (!POSSIBLY_BILLED_REASONS.has(reason)) throw new Error(`Unknown possibly-billed reason: ${reason}`);
        end(reason, {}, () => {
          charge(account, estimate, false, { possiblyBilled: true });
          // A timeout says something about the account's latency; a client leaving or a bad body does not.
          if (reason === POSSIBLY_BILLED.TIMEOUT) applyFailure(state.accounts[account.id], account, { status: reason }, now());
        });
      },
      fail({ status, effect = null, tag = null, retryAfterMs = 0, requestId = null }) {
        end(status, defined({ tag, requestId }), () => applyFailure(state.accounts[account.id], account, { status, effect, tag, retryAfterMs }, now()));
      }
    };
    try {
      return await use(reservation);
    } finally {
      if (open) { open = false; reserved.delete(credit); }
    }
  }

  function change(id, update) {
    refresh();
    const account = byId(id);
    update(account, state.accounts[account.id]);
    save();
  }

  /**
   * Check provider balances, one account (`accountId`) or all of them, sequentially (gentle on rate limits).
   * `check(account)` returns { remaining, details }, or { skipped: reason } (nothing stored), or throws an Error
   * with a key-free message (stored as the account's balance-check error). Report-only: local spend never changes.
   */
  async function checkBalances(accountId, check) {
    const targets = accountId ? [byId(accountId)] : accounts;
    const results = [];
    for (const account of targets) {
      let outcome;
      try { outcome = await check(account); } catch (err) { outcome = err instanceof Error ? err : new Error(String(err)); }
      if (outcome?.skipped) { results.push({ id: account.id, skipped: outcome.skipped }); continue; }
      const at = new Date(now()).toISOString();
      change(account.id, (_a, entry) => {
        if (outcome instanceof Error) { entry.reconcileError = { at, message: outcome.message }; return; }
        entry.providerBalance = { at, remaining: round6(outcome.remaining), details: outcome.details ?? {} };
        delete entry.reconcileError;
      });
      results.push(outcome instanceof Error ? { id: account.id, error: outcome.message } : { id: account.id, remaining: outcome.remaining });
    }
    return results;
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
          retryAt: entry.disabled === EFFECT.QUOTA ? (entry.quotaRetryAt ? new Date(entry.quotaRetryAt).toISOString() : null) : (cooling ? new Date(entry.cooldownUntil).toISOString() : null),
          requests: entry.requests, failures: entry.failures, possiblyBilled: entry.possiblyBilled,
          lastStatus: entry.lastStatus ?? null, lastErrorTag: entry.lastErrorTag ?? null, lastRequestId: entry.lastRequestId ?? null,
          available: round6(totalRemaining(activeAllocations(account))),
          providerBalance: entry.providerBalance ?? null,
          reconcileError: entry.reconcileError ?? null,
          allocations: account.allocations.map((a) => {
            const tally = entry.allocations[a.id];
            const active = isActive(a, now());
            return { id: a.id, period: a.period, limit: a.limit, spent: tally?.spent ?? 0,
              remainingEstimate: active ? round6(remainingOf(a, tally?.spent ?? 0)) : 0,
              expiresAt: a.expiresAt || null, startsAt: a.startsAt || null, active,
              window: tally?.window ?? null };
          })
        };
      }),
      recent: [...recent]
    };
  }

  refresh();
  save();

  return {
    attempt,
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
    checkBalances
  };
}
