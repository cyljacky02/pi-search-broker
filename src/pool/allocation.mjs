// Allocation calendar: when an allocation is spendable, which window its spend belongs to, and when it next changes.
// Pure functions of (allocation, now). Months and resetDay are UTC.

/** The monthly window containing nowMs: its key (start date) and the next reset. */
export function monthlyWindow(nowMs, resetDay = 1) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const thisReset = Date.UTC(y, m, resetDay);
  const currentStart = nowMs >= thisReset ? thisReset : Date.UTC(y, m - 1, resetDay);
  const nextReset = nowMs >= thisReset ? Date.UTC(y, m + 1, resetDay) : thisReset;
  return { key: new Date(currentStart).toISOString().slice(0, 10), nextReset };
}

export const expiryOf = (allocation) => (allocation.expiresAt ? Date.parse(allocation.expiresAt) : Infinity);
const nextResetOf = (allocation, now) => (allocation.period === 'monthly' ? monthlyWindow(now, allocation.resetDay ?? 1).nextReset : Infinity);

/** The window that spend at `now` is charged to: 'once' for one-time grants, else the monthly window key. */
export const windowOf = (allocation, now) => (allocation.period === 'monthly' ? monthlyWindow(now, allocation.resetDay ?? 1).key : 'once');

/** Started and not yet expired. */
export const isActive = (allocation, now) => expiryOf(allocation) > now && (!allocation.startsAt || Date.parse(allocation.startsAt) <= now);

/**
 * Allocations that can be spent now, in spending order, each with `remaining` (after `spentOf` and `heldOf`)
 * and `deadline` (when it next resets or expires). One-time promo grants come before recurring allowances,
 * then the soonest deadline (Exa also draws soonest-expiring credit first), then the most remaining.
 */
export function spendingOrder(allocations, now, { spentOf, heldOf }) {
  return allocations
    .filter((a) => isActive(a, now))
    .map((a) => ({ ...a, remaining: Math.max(0, a.limit - spentOf(a.id) - heldOf(a.id)), deadline: Math.min(nextResetOf(a, now), expiryOf(a)) }))
    .filter((a) => a.remaining > 1e-9)
    .sort((a, b) => Number(b.period === 'once') - Number(a.period === 'once') || a.deadline - b.deadline || b.remaining - a.remaining);
}

/**
 * When an out-of-credit account is worth trying again: the next monthly reset or upcoming promo expiry, whichever
 * is first (a promo expiring can activate a free allowance that starts then). 0 when nothing will change.
 */
export function nextCreditChange(allocations, now) {
  const promoExpiries = allocations.filter((a) => a.period === 'once' && a.expiresAt && expiryOf(a) > now).map(expiryOf);
  const resets = allocations.filter((a) => a.period === 'monthly').map((a) => nextResetOf(a, now));
  const next = Math.min(...resets, ...promoExpiries);
  return Number.isFinite(next) ? next : 0;
}
