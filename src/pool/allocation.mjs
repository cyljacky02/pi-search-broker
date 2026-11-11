// Allocation calendar: when an allocation is spendable, which window its spend belongs to, what is left in it, and
// when it next changes. Pure functions of (allocation, now). Months and resetDay are UTC.

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

/** What is left in an allocation once `used` (spent, plus anything reserved) is taken out. Never negative. */
export const remainingOf = (allocation, used) => Math.max(0, allocation.limit - used);

/**
 * Allocations that can be spent now, in spending order, each with `remaining` (after `spentOf` and `reservedOf`)
 * and `deadline` (when it next resets or expires). One-time promo grants come before recurring allowances,
 * then the soonest deadline (Exa also draws soonest-expiring credit first), then the most remaining.
 */
export function spendingOrder(allocations, now, { spentOf, reservedOf }) {
  return allocations
    .filter((a) => isActive(a, now))
    .map((a) => ({ ...a, remaining: remainingOf(a, spentOf(a.id) + reservedOf(a.id)), deadline: Math.min(nextResetOf(a, now), expiryOf(a)) }))
    .filter((a) => a.remaining > 1e-9)
    .sort((a, b) => Number(b.period === 'once') - Number(a.period === 'once') || a.deadline - b.deadline || b.remaining - a.remaining);
}

/**
 * When an out-of-credit account is worth trying again: the next monthly reset or upcoming promo expiry, whichever
 * is first (a promo expiring can activate a free allowance that starts then), and at the latest the 1st of next
 * month (UTC), when Provider free credit resets even if no Allocation says so.
 */
export function nextCreditChange(allocations, now) {
  const promoExpiries = allocations.filter((a) => a.period === 'once' && a.expiresAt && expiryOf(a) > now).map(expiryOf);
  const resets = allocations.filter((a) => a.period === 'monthly').map((a) => nextResetOf(a, now));
  return Math.min(...resets, ...promoExpiries, monthlyWindow(now, 1).nextReset);
}
