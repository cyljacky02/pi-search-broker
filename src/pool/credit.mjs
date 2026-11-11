// Account credit: where an Account's remaining credit comes from, and the slices it is spent from, in spending order
// (docs/adr/0002-provider-balances-are-the-source-of-truth.md). Functions of (account, state entry, now); the record*
// ones update the entry's spend fields.
//   provider  the last Provider balance (Tavily /usage, Exa /credits with a service key) minus local spend since that
//             report; valid until the next monthly reset (the 1st, UTC), when Provider credit changes anyway
//   hint      the configured Allocations minus local spend (allocation.mjs), when there is no valid Provider balance
//   unknown   no report and either no Allocations, or a Provider whose normal keys cannot read their balance (Exa
//             without a service key): usable until the Provider says it is out of credit; Allocations still order it
import { PROVIDERS } from '../providers.mjs';
import { round6 } from '../numbers.mjs';
import { monthlyWindow, spendingOrder, expiryOf } from './allocation.mjs';

export const SOURCE = Object.freeze({ PROVIDER: 'provider', HINT: 'hint', UNKNOWN: 'unknown' });

/**
 * Whether the Provider can report this Account's balance (and the Account has not opted out). Offline, key-file
 * Accounts carry `balanceSyncable` from the key index instead of their keys.
 */
export function canSyncBalance(account) {
  return account.reconcile !== false && (account.balanceSyncable ?? PROVIDERS[account.provider].balance.supports(account));
}

/** No report can ever bound this Account's credit, so beyond its Allocations it is unknown (Exa without a service key). */
const openEnded = (account) => account.reconcile !== false && !PROVIDERS[account.provider].balance.anyKey && !canSyncBalance(account);
const UNKNOWN_SLICE = Object.freeze({ id: 'unknown', remaining: Infinity, deadline: Infinity, expires: false });

/** When Provider credit next changes for everyone: the 1st of next month, 00:00 UTC. */
export const nextMonthlyReset = (now) => monthlyWindow(now, 1).nextReset;

/** The Provider balance report that still describes this Account at `now`, or null. */
function validReport(account, entry, now) {
  const report = entry.providerBalance;
  if (!report || !canSyncBalance(account)) return null;
  const at = Date.parse(report.at);
  return Number.isFinite(at) && now < nextMonthlyReset(at) ? report : null;
}

/** Where this Account's credit comes from now: a SOURCE. */
export function sourceOf(account, entry, now) {
  if (validReport(account, entry, now)) return SOURCE.PROVIDER;
  return account.allocations.length && !openEnded(account) ? SOURCE.HINT : SOURCE.UNKNOWN;
}

/** Take `amount` off `slices` in order (each { remaining }), never below zero (Infinity stays Infinity). New slices. */
export function drawDown(slices, amount) {
  let left = amount;
  return slices.map((slice) => {
    const used = Math.min(left, slice.remaining);
    left -= used;
    return { ...slice, remaining: round6(slice.remaining - used) };
  });
}

/** A Provider report as credit slices: expiring grants soonest first, then the rest until the next reset. */
function reportedSlices(report, now) {
  const resetAt = nextMonthlyReset(Date.parse(report.at));
  const grants = (report.details?.expiringCredits ?? [])
    .map((c) => ({ amount: c.amountUsd, deadline: Date.parse(c.expiresAt), expiresAt: c.expiresAt }))
    .filter((c) => Number.isFinite(c.deadline) && c.amount > 0);
  const granted = grants.reduce((sum, c) => sum + c.amount, 0);
  const slices = [
    ...grants.sort((a, b) => a.deadline - b.deadline).map((c, i) => ({
      id: `expiring-${i}`, remaining: c.amount, deadline: c.deadline, expires: true, expiresAt: c.expiresAt
    })),
    { id: 'reported', remaining: Math.max(0, report.remaining - granted), deadline: resetAt, expires: false }
  ];
  // Spend draws the soonest-expiring credit first (Exa documents this); expired grants are gone.
  return drawDown(slices, report.spentSince ?? 0).filter((s) => s.deadline > now);
}

/**
 * The credit slices this Account can spend now, in spending order, before Reservations:
 * [{ id, remaining, deadline, expires, expiresAt? }]. `remaining` is Infinity for an unknown balance.
 * `spentOf(allocationId)` is the local spend on a hint Allocation in its current window.
 */
export function creditSlices(account, entry, now, { spentOf }) {
  const report = validReport(account, entry, now);
  if (report) return reportedSlices(report, now);
  const hints = spendingOrder(account.allocations, now, { spentOf, reservedOf: () => 0 })
    .map((a) => ({ id: a.id, remaining: a.remaining, deadline: a.deadline, expires: a.period === 'once' && Number.isFinite(expiryOf(a)), ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}) }));
  return !account.allocations.length || openEnded(account) ? [...hints, UNKNOWN_SLICE] : hints;
}

/**
 * Record `amount` of local spend: against a valid Provider report, and, for a Provider whose reports lag, in the
 * Account's lag window (kept in saved state, so a report after a restart still counts it). Hint Allocations are
 * tallied by the pool.
 */
export function recordReportSpend(account, entry, now, amount) {
  if (validReport(account, entry, now)) entry.providerBalance.spentSince = round6((entry.providerBalance.spentSince ?? 0) + amount);
  const lagMs = PROVIDERS[account.provider].balance.lagMs;
  if (lagMs) entry.lagSpend = [...(entry.lagSpend ?? []).filter((s) => now - s.at < lagMs), { at: now, amount }];
}

/** Local spend a Provider report made at `at` may not include yet (its reporting lag): it counts against the report. */
export function spendInReportLag(account, entry, at) {
  const lagMs = PROVIDERS[account.provider].balance.lagMs;
  return lagMs ? round6((entry.lagSpend ?? []).filter((s) => s.at >= at - lagMs).reduce((sum, s) => sum + s.amount, 0)) : 0;
}

/** This month's local spend on the Account, whatever its source: { window, spent }. */
export function recordMonthSpend(entry, now, amount) {
  const window = monthlyWindow(now, 1).key;
  if (entry.month?.window !== window) entry.month = { window, spent: 0 };
  entry.month.spent = round6(entry.month.spent + amount);
}

export const monthSpentOf = (entry, now) => (entry.month?.window === monthlyWindow(now, 1).key ? entry.month.spent : 0);
