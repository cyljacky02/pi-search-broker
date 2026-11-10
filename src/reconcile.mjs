// Optional, report-only provider balance checks (docs/research/tavily.md §5, docs/research/exa.md §5).
// Results are shown next to the local estimate in /status; they never change local accounting.
// Correct local spend with `set-spent` if the two drift apart.
import { PROVIDERS } from './providers.mjs';
import { createPendingWork } from './pending-work.mjs';

const unknown = () => { throw new Error('Unknown account id'); };

/** Whether this account can be checked against the provider at all. */
export function canReconcile(account) {
  return account.reconcile !== false && PROVIDERS[account.provider].balance.supports(account);
}

/** Fetch one account's balance. Throws an Error with a key-free message on failure. */
export async function fetchBalance(account, { fetchImpl = fetch, timeoutMs = 10000, signal } = {}) {
  if (!canReconcile(account)) throw new Error('Balance check not available for this account');
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

const SHUTDOWN = Object.freeze({ skipped: 'shutdown' });

/**
 * On-demand (and, if intervalMs > 0, periodic) balance checks for the configured `accounts`, recorded in the Account
 * pool. A minimum gap per account keeps repeated requests within Tavily's /usage rate limit.
 * fetchImpl defaults to the real fetch: balance endpoints are different hosts from the search routes.
 */
export function createReconciler(accounts, pool, { fetchImpl = fetch, now = () => Date.now(), minGapMs = 60000, intervalMs = 0 } = {}) {
  const lastAttempt = new Map();
  const stopping = new AbortController();
  const pending = createPendingWork();
  let timer = null;

  /** One account's balance: { remaining, details }, an Error with a key-free message, or { skipped: reason }. */
  async function check(account) {
    if (stopping.signal.aborted) return SHUTDOWN;
    if (!canReconcile(account)) return { skipped: 'not-supported' };
    if (now() - (lastAttempt.get(account.id) ?? -Infinity) < minGapMs) return { skipped: 'too-soon' };
    lastAttempt.set(account.id, now());
    // An adapter (or a response body) may ignore AbortSignal: stop waiting for it once shutdown begins.
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => resolve(SHUTDOWN);
      stopping.signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const result = await Promise.race([fetchBalance(account, { fetchImpl, signal: stopping.signal }), cancelled]);
      return stopping.signal.aborted ? SHUTDOWN : result;
    } catch (err) {
      if (stopping.signal.aborted) return SHUTDOWN;
      return err instanceof Error ? err : new Error('Balance check failed');
    } finally {
      stopping.signal.removeEventListener('abort', cancel);
    }
  }

  /**
   * Check one account (`accountId`) or all of them, one at a time (gentle on rate limits), and record every balance
   * or error; a skipped check records nothing. Results: { id, remaining } | { id, skipped } | { id, error }.
   */
  async function run(accountId) {
    const targets = accountId ? [accounts.find((a) => a.id === accountId) ?? unknown()] : accounts;
    const results = [];
    for (const account of targets) {
      const outcome = await check(account);
      if (outcome.skipped) { results.push({ id: account.id, skipped: outcome.skipped }); continue; }
      pool.recordBalanceCheck(account.id, outcome);
      results.push(outcome instanceof Error ? { id: account.id, error: outcome.message } : { id: account.id, remaining: outcome.remaining });
    }
    return results;
  }

  function reconcile(accountId) {
    if (stopping.signal.aborted) return Promise.reject(new Error('Gateway is shutting down'));
    return pending.track(run(accountId));
  }

  function start() {
    if (timer || !intervalMs || stopping.signal.aborted) return;
    timer = setInterval(() => { reconcile().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }
  async function stop() {
    clearInterval(timer);
    timer = null;
    stopping.abort();
    await pending.drain();
  }
  return { reconcile, start, stop };
}
