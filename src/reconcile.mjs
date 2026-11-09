// Provider-authoritative balance checks.
//  Tavily: GET https://api.tavily.com/usage (Bearer key; 10 requests / 10 minutes per key)
//  Exa:    GET https://admin-api.exa.ai/team-management/credits (service key; must be enabled by Exa support;
//          may lag usage by up to 5 minutes)
// See docs/research/tavily.md §5 and docs/research/exa.md §5.

export const BALANCE_ENDPOINTS = Object.freeze({
  tavily: 'https://api.tavily.com/usage',
  exa: 'https://admin-api.exa.ai/team-management/credits'
});

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** Whether this account can be reconciled against the provider at all. */
export function canReconcile(account) {
  if (account.reconcile === false) return false;
  return account.provider === 'tavily' || (account.provider === 'exa' && Boolean(account.adminKey));
}

export function parseTavilyUsage(data) {
  const key = data?.key ?? {};
  const acct = data?.account ?? {};
  const planUsage = num(acct.plan_usage);
  const planLimit = num(acct.plan_limit);
  if (planUsage === null || planLimit === null) throw new Error('Unexpected /usage response shape');
  const paygoUsage = num(acct.paygo_usage) ?? 0;
  const paygoLimit = num(acct.paygo_limit);
  const accountRemaining = Math.max(0, planLimit - planUsage) + (paygoLimit !== null ? Math.max(0, paygoLimit - paygoUsage) : 0);
  const keyUsage = num(key.usage);
  const keyLimit = num(key.limit);
  const keyRemaining = keyLimit !== null && keyUsage !== null ? Math.max(0, keyLimit - keyUsage) : Infinity;
  return {
    remaining: Math.min(accountRemaining, keyRemaining),
    monthlyUsed: planUsage,
    details: {
      plan: typeof acct.current_plan === 'string' ? acct.current_plan.slice(0, 64) : null,
      planUsage, planLimit, paygoUsage, paygoLimit, keyUsage, keyLimit
    }
  };
}

export function parseExaCredits(data) {
  const credits = num(data?.credits_usd);
  if (credits === null) throw new Error('Unexpected /credits response shape');
  const expiring = Array.isArray(data?.expiring_credits) ? data.expiring_credits.slice(0, 10)
    .map((c) => ({ amountUsd: num(c?.amount_usd), expiresAt: typeof c?.expires_at === 'string' ? c.expires_at : null }))
    .filter((c) => c.amountUsd !== null) : [];
  return {
    remaining: Math.max(0, credits),
    details: { creditsUsd: credits, expiringCredits: expiring, generatedAt: typeof data?.metadata?.generated_at === 'string' ? data.metadata.generated_at : null }
  };
}

/** Fetch one account's balance. Throws an Error with a key-free message on failure. */
export async function fetchBalance(account, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!canReconcile(account)) throw new Error('Reconciliation not available for this account');
  const isTavily = account.provider === 'tavily';
  const headers = isTavily ? { Authorization: `Bearer ${account.apiKey}` } : { 'x-api-key': account.adminKey };
  let res;
  try {
    res = await fetchImpl(BALANCE_ENDPOINTS[account.provider], { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Balance request failed (network/timeout)');
  }
  if (!res.ok) throw Object.assign(new Error(`Balance request failed: HTTP ${res.status}`), { status: res.status });
  let data;
  try { data = await res.json(); } catch { throw new Error('Balance response was not JSON'); }
  return isTavily ? parseTavilyUsage(data) : parseExaCredits(data);
}

/**
 * Periodic + on-demand reconciler bound to an AccountManager.
 * Enforces a minimum gap per account so on-demand calls cannot exhaust Tavily's /usage rate limit.
 */
export function createReconciler(manager, config, { fetchImpl = fetch, now = () => Date.now(), minGapMs = 60000 } = {}) {
  const lastAttempt = new Map();
  let timer = null;

  async function reconcileOne(account, { force = false } = {}) {
    if (!canReconcile(account)) return { id: account.id, skipped: 'not-supported' };
    const last = lastAttempt.get(account.id) ?? -Infinity;
    if (!force && now() - last < minGapMs) return { id: account.id, skipped: 'too-soon' };
    lastAttempt.set(account.id, now());
    try {
      const result = await fetchBalance(account, { fetchImpl });
      manager.applyReconciliation(account.id, result);
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
    for (const account of targets) results.push(await reconcileOne(account)); // sequential: gentle on rate limits
    return results;
  }

  function start() {
    if (timer || !config.reconcileIntervalMs) return;
    const run = () => { reconcile().catch(() => {}); };
    const first = setTimeout(run, 2000);
    first.unref?.();
    timer = setInterval(run, config.reconcileIntervalMs);
    timer.unref?.();
    timer.first = first;
  }
  function stop() {
    if (!timer) return;
    clearTimeout(timer.first);
    clearInterval(timer);
    timer = null;
  }
  return { reconcile, reconcileOne, start, stop };
}
