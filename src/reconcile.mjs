// Provider balance syncs (docs/research/tavily.md §5, docs/research/exa.md §5): Tavily /usage for every key, Exa
// /credits with a service key. Each result becomes the Account's credit in the Account pool
// (docs/adr/0002-provider-balances-are-the-source-of-truth.md); the Gateway decides when to sync.
import { PROVIDERS } from './providers.mjs';
import { canSyncBalance } from './pool/credit.mjs';

const SHUTDOWN = Object.freeze({ skipped: 'shutdown' });
const throwUnknownAccount = () => { throw new Error('Unknown account id'); };

/** Fetch one account's balance. Throws an Error with a key-free message on failure. */
export async function fetchBalance(account, { fetchImpl = fetch, timeoutMs = 10000, signal } = {}) {
  if (!canSyncBalance(account)) throw new Error('Balance sync not available for this account');
  const balance = PROVIDERS[account.provider].balance;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(balance.url, { method: 'GET', headers: balance.headers(account), redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  } catch {
    throw new Error('Balance request failed (network/timeout)');
  }
  if (!res.ok) throw new Error(`Balance request failed: HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('Balance response was not JSON'); }
  return balance.parse(data);
}

/**
 * Balance syncs for the configured `accounts`, each result applied to the Account `pool`. A minimum gap per account
 * keeps repeated requests within Tavily's /usage rate limit; a sync asked for too soon (soon) runs once the gap has
 * passed. Once `signal` aborts (the Gateway is stopping), syncs stop: one in flight is abandoned, since an adapter may
 * ignore the signal, nothing more is recorded, and pending ones are dropped.
 * fetchImpl defaults to the real fetch: balance endpoints are different hosts from the search routes.
 * @param spacingMs  pause between accounts when syncing all of them, to spread the requests out
 */
export function createBalanceChecks({
  accounts, pool, fetchImpl = fetch, now = () => Date.now(), minGapMs = 60000, spacingMs = 0, signal = new AbortController().signal
}) {
  const lastAttempt = new Map();
  const pending = new Map(); // accountId -> timer for a sync asked for too soon

  /** One account's balance sync: { remaining, details }, an Error with a key-free message, or { skipped: reason }. */
  async function check(account, { force = false } = {}) {
    if (signal.aborted) return SHUTDOWN;
    if (!canSyncBalance(account)) return { skipped: 'not-supported' };
    if (!force && now() - (lastAttempt.get(account.id) ?? -Infinity) < minGapMs) return { skipped: 'too-soon' };
    lastAttempt.set(account.id, now());
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => resolve(SHUTDOWN);
      signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const result = await Promise.race([fetchBalance(account, { fetchImpl, signal }), cancelled]);
      return signal.aborted ? SHUTDOWN : result;
    } catch (err) {
      if (signal.aborted) return SHUTDOWN;
      return err instanceof Error ? err : new Error('Balance check failed');
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  /**
   * Check one account (`accountId`) or all of them, one at a time (gentle on rate limits), and apply every balance or
   * record every error; a skipped check records nothing. Results: { id, remaining } | { id, skipped } | { id, error }.
   */
  async function run(accountId, { force = false } = {}) {
    // The account itself (with its keys) is needed before any request, and the pool hands out no accounts.
    const targets = accountId ? [accounts.find((a) => a.id === accountId) ?? throwUnknownAccount()] : accounts;
    const results = [];
    for (const [i, account] of targets.entries()) {
      if (i && spacingMs && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, spacingMs).unref?.());
      const outcome = await check(account, { force });
      if (outcome.skipped) { results.push({ id: account.id, skipped: outcome.skipped }); continue; }
      pool.recordBalanceCheck(account.id, outcome);
      results.push(outcome instanceof Error ? { id: account.id, error: outcome.message } : { id: account.id, remaining: outcome.remaining });
    }
    return results;
  }

  /**
   * Sync one account as soon as its rate gap allows: now, or once the minimum gap has passed (one pending sync per
   * account). Resolves with the immediate results.
   */
  async function soon(accountId) {
    const results = await run(accountId);
    if (results[0]?.skipped === 'too-soon' && !pending.has(accountId) && !signal.aborted) {
      const wait = Math.max(0, (lastAttempt.get(accountId) ?? 0) + minGapMs - now());
      const timer = setTimeout(() => {
        pending.delete(accountId);
        run(accountId, { force: true }).catch(() => {});
      }, wait);
      timer.unref?.();
      pending.set(accountId, timer);
    }
    return results;
  }
  signal.addEventListener('abort', () => { for (const timer of pending.values()) clearTimeout(timer); pending.clear(); }, { once: true });

  return { run, soon };
}
