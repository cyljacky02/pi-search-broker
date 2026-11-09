// Optional, report-only provider balance checks (docs/research/tavily.md §5, docs/research/exa.md §5).
// Results are shown next to the local estimate in /status; they never change local accounting.
// Correct local spend with `set-spent` if the two drift apart.
import { PROVIDERS } from './providers.mjs';

/** Whether this account can be checked against the provider at all. */
export function canReconcile(account) {
  return account.reconcile !== false && PROVIDERS[account.provider].balance.supports(account);
}

/** Fetch one account's balance. Throws an Error with a key-free message on failure. */
export async function fetchBalance(account, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!canReconcile(account)) throw new Error('Balance check not available for this account');
  const balance = PROVIDERS[account.provider].balance;
  let res;
  try {
    res = await fetchImpl(balance.url, { method: 'GET', headers: balance.headers(account), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Balance request failed (network/timeout)');
  }
  if (!res.ok) throw new Error(`Balance request failed: HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('Balance response was not JSON'); }
  return balance.parse(data);
}

/**
 * On-demand (and, if reconcileIntervalMs > 0, periodic) balance checks bound to an AccountManager.
 * A minimum gap per account keeps repeated requests within Tavily's /usage rate limit.
 */
export function createReconciler(manager, config, { fetchImpl = fetch, now = () => Date.now(), minGapMs = 60000 } = {}) {
  const lastAttempt = new Map();
  let timer = null;

  async function checkAccount(account) {
    if (!canReconcile(account)) return { id: account.id, skipped: 'not-supported' };
    if (now() - (lastAttempt.get(account.id) ?? -Infinity) < minGapMs) return { id: account.id, skipped: 'too-soon' };
    lastAttempt.set(account.id, now());
    try {
      const result = await fetchBalance(account, { fetchImpl });
      manager.recordProviderBalance(account.id, result);
      return { id: account.id, remaining: result.remaining };
    } catch (err) {
      manager.noteReconcileError(account.id, err.message);
      return { id: account.id, error: err.message };
    }
  }

  async function reconcile(accountId) {
    const targets = accountId ? config.accounts.filter((a) => a.id === accountId) : config.accounts;
    if (accountId && !targets.length) throw new Error('Unknown account id');
    const results = [];
    for (const account of targets) results.push(await checkAccount(account)); // sequential: gentle on rate limits
    return results;
  }

  function start() {
    if (timer || !config.reconcileIntervalMs) return;
    timer = setInterval(() => { reconcile().catch(() => {}); }, config.reconcileIntervalMs);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }
  return { reconcile, start, stop };
}
