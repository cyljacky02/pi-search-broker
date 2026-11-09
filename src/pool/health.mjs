// Account health: what a failure does to an account, and how it recovers. This is the one place that turns an EFFECT
// (from a provider's classify(), see providers.mjs) into account state.
//
//   AUTH, BLOCKED   disabled until someone re-enables it (fix the key / contact the provider)
//   QUOTA           disabled until the next monthly reset or promo expiry, or a new allocation window
//   RATE_LIMIT      cooldown for Retry-After, clamped to 1-120 s (30 s when the provider gave none)
//   FORBIDDEN       10-minute cooldown (Tavily 403 on /search is undocumented; never a permanent disable)
//   UPSTREAM        10-second cooldown after a 5xx or a network failure
//   null            no change beyond the failure counters
import { EFFECT } from '../providers.mjs';
import { nextCreditChange } from './allocation.mjs';

export const COOLDOWN_MS = Object.freeze({ [EFFECT.FORBIDDEN]: 10 * 60 * 1000, [EFFECT.UPSTREAM]: 10 * 1000 });
export const RATE_LIMIT_MS = Object.freeze({ min: 1000, max: 120000, fallback: 30000 });

/** Apply one failed attempt to the account's state entry. */
export function applyFailure(entry, account, { status, effect = null, tag = null, retryAfterMs = 0 }, now) {
  entry.failures++;
  entry.lastFailureAt = new Date(now).toISOString();
  entry.lastStatus = status;
  entry.lastErrorTag = tag;
  if (effect === EFFECT.AUTH || effect === EFFECT.BLOCKED) {
    entry.disabled = effect;
  } else if (effect === EFFECT.QUOTA) {
    entry.disabled = 'quota';
    entry.blockedUntil = nextCreditChange(account.allocations, now);
  } else if (effect === EFFECT.RATE_LIMIT) {
    entry.cooldownUntil = now + Math.max(RATE_LIMIT_MS.min, Math.min(RATE_LIMIT_MS.max, retryAfterMs || RATE_LIMIT_MS.fallback));
    entry.cooldownReason = effect;
  } else if (effect in COOLDOWN_MS) {
    entry.cooldownUntil = now + COOLDOWN_MS[effect];
    entry.cooldownReason = effect;
  }
}

/** Time-based recovery. `newWindow`: an allocation just started a new window, so an out-of-credit account has credit again. */
export function recover(entry, now, { newWindow = false } = {}) {
  if (entry.disabled === 'quota' && (newWindow || (entry.blockedUntil && now >= entry.blockedUntil))) {
    entry.disabled = null;
    entry.blockedUntil = 0;
  }
  if (entry.cooldownUntil && entry.cooldownUntil <= now) { entry.cooldownUntil = 0; entry.cooldownReason = null; }
}

/** Whether a reservation may be made on this account right now. */
export const isUsable = (entry, now) => !entry.disabled && !(entry.cooldownUntil && entry.cooldownUntil > now);
