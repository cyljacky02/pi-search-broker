// Account health: what a failure does to an account, and how it recovers. This is the one place that turns an EFFECT
// (from a provider's classify(), see providers.mjs) into account state.
//
//   AUTH, BLOCKED   disabled until someone re-enables it (fix the key / contact the provider)
//   QUOTA           out of credit ("parked"): until the next monthly reset or promo expiry, a new allocation window,
//                   or a Provider balance with credit; at the latest until the 1st of next month (UTC). A syncable
//                   Account asks for its balance before the park ends (balance-first), with a grace period
//   RATE_LIMIT      cooldown for Retry-After, clamped to 1-120 s (30 s when the provider gave none)
//   FORBIDDEN       10-minute cooldown (Tavily 403 on /search is undocumented; never a permanent disable)
//   UPSTREAM        10-second cooldown after a 5xx or a network failure
//   null            no change beyond the failure counters
import { EFFECT } from '../providers.mjs';
import { nextCreditChange } from './allocation.mjs';
import { nextMonthlyReset } from './credit.mjs';

/** How long a parked Account waits for its balance before the park ends anyway. */
export const BALANCE_GRACE_MS = 5 * 60 * 1000;

/** Park an out-of-credit Account until `until`, unless a human or a permanent effect disabled it. */
function park(entry, until) {
  if (entry.disabled && entry.disabled !== EFFECT.QUOTA) return;
  entry.disabled = EFFECT.QUOTA;
  entry.quotaRetryAt = until;
  delete entry.balanceAsked;
}

export const COOLDOWN_MS = Object.freeze({ [EFFECT.FORBIDDEN]: 10 * 60 * 1000, [EFFECT.UPSTREAM]: 10 * 1000 });
export const RATE_LIMIT_MS = Object.freeze({ min: 1000, max: 120000, fallback: 30000 });

/** An overlapping failure can extend a cooldown, but cannot shorten an existing one. */
function coolDown(entry, reason, until) {
  if (until > (entry.cooldownUntil || 0)) {
    entry.cooldownUntil = until;
    entry.cooldownReason = reason;
  }
}

/** Apply one failed attempt to the account's state entry. */
export function applyFailure(entry, account, { status, effect = null, tag = null, retryAfterMs = 0 }, now) {
  entry.failures++;
  entry.lastFailureAt = new Date(now).toISOString();
  entry.lastStatus = status;
  entry.lastErrorTag = tag;
  if (effect === EFFECT.AUTH || effect === EFFECT.BLOCKED) {
    // A manually parked account stays parked until an explicit administrative action.
    if (entry.disabled !== 'manual') entry.disabled = effect;
  } else if (effect === EFFECT.QUOTA) {
    // A later quota response must not turn a permanent disable into one that recovers on a reset.
    park(entry, nextCreditChange(account.allocations, now) || nextMonthlyReset(now));
  } else if (effect === EFFECT.RATE_LIMIT) {
    coolDown(entry, effect, now + Math.max(RATE_LIMIT_MS.min, Math.min(RATE_LIMIT_MS.max, retryAfterMs || RATE_LIMIT_MS.fallback)));
  } else if (effect in COOLDOWN_MS) {
    coolDown(entry, effect, now + COOLDOWN_MS[effect]);
  }
}

/** Administrative changes share the same health rules as failure and recovery transitions. */
export function enable(entry, { clearCooldown = true } = {}) {
  entry.disabled = null;
  entry.quotaRetryAt = 0;
  delete entry.balanceAsked;
  if (clearCooldown) { entry.cooldownUntil = 0; entry.cooldownReason = null; }
}

export function disable(entry) { entry.disabled = 'manual'; }

/** A Provider balance arrived: `left` is the credit it leaves. Credit ends a park; none parks until the next reset. */
export function applyReportedCredit(entry, left, now) {
  if (left > 1e-9) {
    if (entry.disabled === EFFECT.QUOTA) enable(entry, { clearCooldown: false });
    delete entry.balanceAsked;
  } else {
    park(entry, nextMonthlyReset(now));
  }
}

/**
 * Time-based recovery. `newWindow`: an allocation just started a new window, so an out-of-credit account has credit
 * again. `balanceFirst`: when the park would end, ask for the balance first (returns true: the caller asks) and keep
 * the park for BALANCE_GRACE_MS; it ends then if no balance arrived.
 */
export function recover(entry, now, { newWindow = false, balanceFirst = false } = {}) {
  let askForBalance = false;
  if (entry.disabled === EFFECT.QUOTA && (newWindow || (entry.quotaRetryAt && now >= entry.quotaRetryAt))) {
    if (balanceFirst && !entry.balanceAsked) {
      entry.balanceAsked = true;
      entry.quotaRetryAt = now + BALANCE_GRACE_MS;
      askForBalance = true;
    } else {
      entry.disabled = null;
      entry.quotaRetryAt = 0;
      delete entry.balanceAsked;
    }
  }
  if (entry.cooldownUntil && entry.cooldownUntil <= now) { entry.cooldownUntil = 0; entry.cooldownReason = null; }
  return askForBalance;
}

/** Whether a reservation may be made on this account right now. */
export const isUsable = (entry, now) => !entry.disabled && !(entry.cooldownUntil && entry.cooldownUntil > now);

/** The visible eligibility state and the time at which that state can recover without an admin action. */
export function healthStatus(entry, now) {
  const cooling = entry.cooldownUntil > now;
  const status = entry.disabled || (cooling ? 'cooldown' : 'active');
  const retryAt = entry.disabled === EFFECT.QUOTA ? entry.quotaRetryAt : !entry.disabled && cooling ? entry.cooldownUntil : 0;
  return { status, cooldownReason: !entry.disabled && cooling ? entry.cooldownReason ?? null : null, retryAt: retryAt ? new Date(retryAt).toISOString() : null };
}
