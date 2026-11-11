// Account pool: every account, its credit (pool/credit.mjs: Provider-reported, hinted by Allocations, or unknown),
// health and spend. Callers get credit one attempt at a time through a Reservation that ends exactly once; everything
// else (credit sources, spending order, reserved credit, cooldowns, quota re-opening, persistence, the attempt log)
// stays behind this interface.
// Never exposes key material in persisted state or user-facing status.
import { PROVIDERS } from './providers.mjs';
import { round6, isNonNegativeNumber } from './numbers.mjs';
import { quietLogger } from './log.mjs';
import { STATE_VERSION } from './pool/store.mjs';
import { windowOf, isActive, remainingOf, spendingOrder } from './pool/allocation.mjs';
import {
  SOURCE, sourceOf, creditSlices, drawDown, spendAgainstReport, addMonthSpend, monthSpentOf, canSyncBalance, nextMonthlyReset
} from './pool/credit.mjs';
import { PROVIDERS as PROVIDER_POLICIES } from './providers.mjs';
import { applyFailure, recover, isUsable, healthStatus, enable as enableHealth, disable as disableHealth } from './pool/health.mjs';

/** Why an attempt is possibly billed: it may have reached the provider, but whether it was billed is unknown. */
export const POSSIBLY_BILLED = Object.freeze({
  TIMEOUT: 'timeout',                  // the provider did not answer in time
  CLIENT_CLOSED: 'client-closed',      // the client went away mid-attempt
  INVALID_RESPONSE: 'invalid-response', // a 2xx whose body could not be read
  AMBIGUOUS_NETWORK: 'ambiguous-network' // delivery could not be determined
});
const POSSIBLY_BILLED_REASONS = new Set(Object.values(POSSIBLY_BILLED));

/** How a Reservation ended: the ending a failed save leaves live but unsaved (see StateNotSaved). */
export const ENDING = Object.freeze({ BILLED: 'billed', POSSIBLY_BILLED: 'possibly-billed', FAILED: 'failed' });

/**
 * The Account pool could not save its state. The change is live in this process, and new Attempts are paused until a
 * save succeeds. `ending` is the Reservation ending that is live but unsaved (an ENDING), or null when no Attempt ended:
 * an admin change, or the save retried before a new Attempt. Never carries the storage error's text.
 */
export class StateNotSaved extends Error {
  constructor(ending = null) {
    super('Account pool state could not be saved; new attempts are paused until storage recovers');
    this.name = 'StateNotSaved';
    this.ending = ending;
  }
}
const RECENT_LIMIT = 50;
/** The set-spent target for this month's spend on any Account, beside its hint Allocations. */
export const MONTH = 'month';
const totalRemaining = (slices) => slices.reduce((sum, a) => sum + a.remaining, 0);
/** Ascending order that also handles Infinity (Infinity - Infinity is NaN). */
const compare = (x, y) => (x === y ? 0 : x < y ? -1 : 1);


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
 * @param requestBalanceSync  optional (accountId) => void, called when an Account runs out of credit or its out-of-credit
 *                            park ends, so the Gateway can ask the Provider for its balance
 */
export function createAccountPool(accounts, { store, now = () => Date.now(), logger = null, requestBalanceSync = () => {} }) {
  const state = store.load() ?? { version: STATE_VERSION, accounts: {} };
  const reserved = new Set(); // open reservations: { accountId, amount }
  const recent = [];
  const log = quietLogger(logger);
  let persistenceUnavailable = false;
  const save = (ending = null) => {
    try {
      store.save(state);
      if (persistenceUnavailable) log('Account pool state storage recovered');
      persistenceUnavailable = false;
    } catch {
      if (!persistenceUnavailable) log('Account pool state could not be saved; new attempts are paused');
      persistenceUnavailable = true;
      throw new StateNotSaved(ending);
    }
  };
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
      const parked = entry.disabled === 'quota';
      recover(entry, now(), { newWindow });
      state.accounts[account.id] = entry;
      if (parked && !entry.disabled && canSyncBalance(account)) requestBalanceSync(account.id);
    }
  }

  /** The Account's credit slices spendable now, with all open Reservations placed on them, in spending order. */
  function activeCredit(account) {
    const entry = state.accounts[account.id];
    const spentOf = (id) => entry.allocations[id]?.spent || 0;
    const slices = creditSlices(account, entry, now(), { spentOf });
    const held = [...reserved].reduce((sum, credit) => sum + (credit.accountId === account.id ? credit.amount : 0), 0);
    // Reservations follow the credit available at settlement, including across an expiry or a new window.
    return drawDown(slices, held).filter((s) => s.remaining > 1e-9);
  }

  /**
   * The Account for the next Attempt: credit that will expire first (soonest), then the most known credit, then
   * unknown-balance Accounts, least recently used first. An Account must be able to cover `amount`.
   */
  function choose(provider, amount, excluded) {
    const options = [];
    for (const account of accounts) {
      if (account.provider !== provider || excluded.has(account.id)) continue;
      const entry = state.accounts[account.id];
      if (!isUsable(entry, now())) continue;
      const credit = activeCredit(account);
      const total = totalRemaining(credit);
      if (!credit.length || total + 1e-9 < amount) continue;
      const expiring = credit.find((s) => s.expires)?.deadline ?? Infinity;
      options.push({ account, expiring, known: Number.isFinite(total), total, lastUsed: entry.lastUsedAt ?? 0 });
    }
    options.sort((a, b) => compare(a.expiring, b.expiring) || Number(b.known) - Number(a.known)
      || (a.known ? compare(b.total, a.total) : compare(a.lastUsed, b.lastUsed)) || a.account.id.localeCompare(b.account.id));
    return options[0] ?? null;
  }

  /** Record spend: against a valid Provider report, this month's total, and the hint Allocations (kept current too). */
  function charge(account, amount, exact, { possiblyBilled = false, requestId = null } = {}) {
    const entry = state.accounts[account.id];
    const at = now();
    spendAgainstReport(account, entry, at, amount);
    addMonthSpend(entry, at, amount);
    if (account.allocations.length) chargeAllocations(account, entry, amount, exact, possiblyBilled);
    if (possiblyBilled) {
      entry.possiblyBilled++;
    } else {
      entry.requests++;
      entry.lastSuccessAt = new Date(at).toISOString();
    }
    if (requestId) entry.lastRequestId = requestId;
  }

  function chargeAllocations(account, entry, amount, exact, possiblyBilled) {
    const tallies = entry.allocations;
    // A completed charge follows the provider's spending order. Other Reservations are re-placed on the
    // credit left afterwards by activeCredit(), so their holds still block later Attempts.
    const spendable = spendingOrder(account.allocations, now(), { spentOf: (id) => tallies[id]?.spent || 0, reservedOf: () => 0 });
    const { parts, left } = spread(amount, spendable, (a) => a.remaining);
    for (const [allocation, used] of parts) tallies[allocation.id].spent = round6(tallies[allocation.id].spent + used);
    const first = account.allocations.find((a) => a.id in tallies);
    // A provider can bill more than our estimate. Attribute the overage to current credit, even when held or spent.
    if (left > 1e-8) {
      const at = now();
      const ordered = spendingOrder(account.allocations, at, { spentOf: (id) => tallies[id]?.spent || 0, reservedOf: () => 0 });
      const overage = ordered[0] ?? account.allocations.find((a) => isActive(a, at)) ?? first;
      tallies[overage.id].spent = round6(tallies[overage.id].spent + left);
    }
    // Exact vs estimated counts are request-level provenance, not provider account balances.
    if (!possiblyBilled) tallies[first.id][exact ? 'exactCalls' : 'estimatedCalls']++;
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
   * Throws StateNotSaved when an ending cannot be saved (with that ending), or when Attempts are paused (ending null).
   */
  async function attempt(route, estimate, excludedIds, use) {
    if (!isNonNegativeNumber(estimate)) throw new Error('estimate must be a nonnegative number');
    // Never send another Attempt while live accounting is newer than the last successful save.
    if (persistenceUnavailable) save();
    refresh();
    const choice = choose(route.provider, estimate, excludedIds);
    if (!choice) return null;
    const { account } = choice;
    state.accounts[account.id].lastUsedAt = now(); // unknown-balance Accounts take turns
    const credit = { accountId: account.id, amount: estimate };
    reserved.add(credit);
    const started = now();
    let open = true;
    const end = (ending, status, extra, apply) => {
      if (!open) throw new Error('Reservation already ended');
      open = false;
      reserved.delete(credit);
      refresh();
      apply();
      recordAttempt({ provider: route.provider, path: route.path, account: account.id, status, ms: now() - started, ...extra });
      save(ending);
    };
    const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

    const reservation = {
      account,
      settle({ status = 200, amount, exact, requestId = null }) {
        if (!isNonNegativeNumber(amount)) throw new Error('amount must be a nonnegative number');
        end(ENDING.BILLED, status, defined({ requestId, cost: amount, exact }), () => charge(account, amount, exact, { requestId }));
      },
      settlePossiblyBilled(reason) {
        if (!POSSIBLY_BILLED_REASONS.has(reason)) throw new Error(`Unknown possibly-billed reason: ${reason}`);
        end(ENDING.POSSIBLY_BILLED, reason, {}, () => {
          charge(account, estimate, false, { possiblyBilled: true });
          // A timeout says something about the account's latency; a client leaving or a bad body does not.
          if (reason === POSSIBLY_BILLED.TIMEOUT) applyFailure(state.accounts[account.id], account, { status: reason }, now());
        });
      },
      fail({ status, effect = null, tag = null, retryAfterMs = 0, requestId = null }) {
        end(ENDING.FAILED, status, defined({ tag, requestId }), () => {
          const entry = state.accounts[account.id];
          applyFailure(entry, account, { status, effect, tag, retryAfterMs }, now());
          if (entry.disabled === 'quota' && canSyncBalance(account)) requestBalanceSync(account.id);
        });
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

  /** Local spend on an Account in recent Attempts at or after `sinceMs` (the attempt log). */
  function recentSpend(accountId, sinceMs) {
    return round6(recent.filter((r) => r.account === accountId && r.cost !== undefined && Date.parse(r.at) >= sinceMs)
      .reduce((sum, r) => sum + r.cost, 0));
  }

  /**
   * Apply one account's balance check: `{ remaining, details }` as the provider reported it becomes the Account's
   * credit (minus local spend since; spend inside the Provider's reporting lag counts again, erring low). No credit
   * left parks the Account until the next reset; credit again ends an out-of-credit park. An Error keeps the last
   * report and its key-free message until the next good check. Unknown ids throw.
   */
  function recordBalanceCheck(accountId, outcome) {
    const at = now();
    change(accountId, (account, entry) => {
      if (outcome instanceof Error) { entry.reconcileError = { at: new Date(at).toISOString(), message: outcome.message }; return; }
      const lagMs = PROVIDER_POLICIES[account.provider].balance.lagMs ?? 0;
      entry.providerBalance = {
        at: new Date(at).toISOString(), remaining: round6(outcome.remaining), details: outcome.details ?? {},
        spentSince: lagMs ? recentSpend(account.id, at - lagMs) : 0
      };
      delete entry.reconcileError;
      const left = totalRemaining(creditSlices(account, entry, at, { spentOf: () => 0 }));
      if (left > 1e-9 && entry.disabled === 'quota') enableHealth(entry, { clearCooldown: false });
      if (left <= 1e-9 && (!entry.disabled || entry.disabled === 'quota')) {
        entry.disabled = 'quota';
        entry.quotaRetryAt = nextMonthlyReset(at);
      }
    });
  }

  /** The Account's balance for status: where it comes from, what is left, and this month's spend. */
  function balanceOf(account, entry, credit) {
    const at = now();
    const source = sourceOf(account, entry, at);
    const total = totalRemaining(credit);
    const report = source === SOURCE.PROVIDER ? entry.providerBalance : null;
    return {
      source,
      remaining: Number.isFinite(total) ? round6(total) : null,
      limit: report ? report.details?.planLimit ?? null : null,
      reportedAt: report ? report.at : null,
      expiring: credit.filter((s) => s.expires && s.expiresAt).map((s) => ({ amount: round6(s.remaining), expiresAt: s.expiresAt })),
      spentThisMonth: monthSpentOf(entry, at),
      syncError: entry.reconcileError ?? null
    };
  }

  function snapshot() {
    refresh();
    return {
      updatedAt: new Date(now()).toISOString(),
      persistence: { state: persistenceUnavailable ? 'unavailable' : 'ok' },
      note: 'Each Account\'s "balance" says where its credit comes from: the last Provider-reported balance minus local spend since (source "provider"), its configured Allocations (source "hint"), or nothing (source "unknown": usable until the Provider says it is out of credit). Local spend uses costDollars.total (Exa) and usage.credits (Tavily) when reported; otherwise estimates.',
      accounts: accounts.map((account) => {
        const entry = state.accounts[account.id];
        return {
          id: account.id, provider: account.provider, unit: PROVIDERS[account.provider].unit,
          ...healthStatus(entry, now()),
          requests: entry.requests, failures: entry.failures, possiblyBilled: entry.possiblyBilled,
          lastStatus: entry.lastStatus ?? null, lastErrorTag: entry.lastErrorTag ?? null, lastRequestId: entry.lastRequestId ?? null,
          ...(() => {
            const credit = activeCredit(account);
            const balance = balanceOf(account, entry, credit);
            return { available: balance.remaining, balance };
          })(),
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
    enable: (id) => change(id, (_a, entry) => enableHealth(entry)),
    disable: (id) => change(id, (_a, entry) => disableHealth(entry)),
    /**
     * Correct local spend to match the provider dashboard: on one hint Allocation, or "month" for this month's spend
     * on any Account (what an unknown-balance Account shows). Also re-enables the account. A later Provider report
     * replaces local figures on synced Accounts.
     */
    setSpent: (id, allocationId, amount) => change(id, (account, entry) => {
      if (allocationId !== MONTH && !account.allocations.some((a) => a.id === allocationId)) throw new Error('Unknown allocation');
      if (!isNonNegativeNumber(amount)) throw new Error('spent must be nonnegative number');
      if (allocationId === MONTH) {
        addMonthSpend(entry, now(), 0);
        entry.month.spent = round6(amount);
      } else {
        entry.allocations[allocationId].spent = round6(amount);
      }
      enableHealth(entry, { clearCooldown: false });
    }),
    recordBalanceCheck
  };
}
