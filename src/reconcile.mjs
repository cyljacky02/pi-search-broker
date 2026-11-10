// Optional, report-only provider balance checks (docs/research/tavily.md §5, docs/research/exa.md §5).
// Results are shown next to the local estimate in /status; they never change local accounting.
// Correct local spend with `set-spent` if the two drift apart.
import { PROVIDERS } from './providers.mjs';

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

/**
 * On-demand (and, if intervalMs > 0, periodic) balance checks for the accounts in an account pool.
 * A minimum gap per account keeps repeated requests within Tavily's /usage rate limit.
 * fetchImpl defaults to the real fetch: balance endpoints are different hosts from the search routes.
 */
export function createReconciler(pool, { fetchImpl = fetch, now = () => Date.now(), minGapMs = 60000, intervalMs = 0 } = {}) {
  const lastAttempt = new Map();
  const stopping = new AbortController();
  const active = new Set();
  let timer = null;

  /** One account's check, for pool.checkBalances: a balance, a skip reason, or a thrown key-free Error. */
  async function check(account) {
    if (stopping.signal.aborted) return { skipped: 'shutdown' };
    if (!canReconcile(account)) return { skipped: 'not-supported' };
    if (now() - (lastAttempt.get(account.id) ?? -Infinity) < minGapMs) return { skipped: 'too-soon' };
    lastAttempt.set(account.id, now());
    // An adapter (or response body) may ignore AbortSignal. Detach it from the pool on shutdown, and
    // return a skip rather than throwing: checkBalances persists thrown errors as well as balances.
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => resolve({ skipped: 'shutdown' });
      stopping.signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const result = await Promise.race([fetchBalance(account, { fetchImpl, signal: stopping.signal }), cancelled]);
      return stopping.signal.aborted ? { skipped: 'shutdown' } : result;
    } catch (err) {
      if (stopping.signal.aborted) return { skipped: 'shutdown' };
      throw err;
    } finally {
      stopping.signal.removeEventListener('abort', cancel);
    }
  }

  /** Results per account: { id, remaining } | { id, skipped } | { id, error }. Unknown ids throw. */
  function reconcile(accountId) {
    if (stopping.signal.aborted) return Promise.reject(new Error('Gateway is shutting down'));
    const work = pool.checkBalances(accountId, check);
    active.add(work);
    work.then(() => active.delete(work), () => active.delete(work));
    return work;
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
    await Promise.allSettled([...active]);
  }
  return { reconcile, start, stop };
}
