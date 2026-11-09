// Provider-specific wire policy for Exa and Tavily.
// Sources for every rule here are cited in docs/research/exa.md and docs/research/tavily.md.

export const UPSTREAM = Object.freeze({ exa: 'https://api.exa.ai', tavily: 'https://api.tavily.com' });

/**
 * Local routes. pi-web-access 0.47.0 only calls these three (docs/research/pi-web-access.md §1).
 * timeoutMs is the default per-attempt timeout; it leaves room for one failover inside totalTimeoutMs.
 */
export const ROUTES = Object.freeze({
  '/exa/search': Object.freeze({ provider: 'exa', path: '/search', timeoutMs: 30000 }),
  '/exa/contents': Object.freeze({ provider: 'exa', path: '/contents', timeoutMs: 40000 }),
  '/tavily/search': Object.freeze({ provider: 'tavily', path: '/search', timeoutMs: 30000 })
});

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const HEADER_TOKEN = /^[A-Za-z0-9._:\-]{1,64}$/;
const HEADER_LIST = /^[A-Za-z0-9._:\-]{1,64}(?:\s*,\s*[A-Za-z0-9._:\-]{1,64}){0,7}$/;

/** Reject request shapes the broker cannot meter or that would be pointlessly retried. Returns an error string or null. */
export function validateRequest(route, body) {
  if (body.stream) {
    // An SSE reply cannot be parsed or metered here, and would be retried (and billed) on every account.
    return 'Streaming responses (stream: true) are not supported by the local search broker';
  }
  return null;
}

/** Build upstream headers and body for one attempt. Never forwards the client's credentials. */
export function prepareRequest(route, body, account, clientHeaders = {}) {
  if (route.provider === 'exa') {
    const integration = typeof clientHeaders['x-exa-integration'] === 'string' && HEADER_TOKEN.test(clientHeaders['x-exa-integration'])
      ? clientHeaders['x-exa-integration'] : 'pi-web-access';
    const headers = { 'x-api-key': account.apiKey, 'Content-Type': 'application/json', 'x-exa-integration': integration };
    const beta = clientHeaders['exa-beta'];
    if (typeof beta === 'string' && HEADER_LIST.test(beta)) headers['Exa-Beta'] = beta;
    return { headers, body: JSON.stringify(body), clientWantsUsage: true };
  }
  // Tavily: a body api_key (the official MCP server still sends one) would carry the local gateway token upstream.
  const { api_key: _dropped, ...rest } = body;
  const clientWantsUsage = rest.include_usage === true;
  const forwarded = { ...rest, include_usage: true }; // exact credits in usage.credits
  const headers = { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json' };
  if (account.projectId) headers['X-Project-ID'] = account.projectId;
  return { headers, body: JSON.stringify(forwarded), clientWantsUsage };
}

/** Undo broker-only additions so the client sees what it asked for. */
export function finalizeResponse(route, data, clientWantsUsage) {
  if (route.provider === 'tavily' && !clientWantsUsage) delete data.usage;
  return data;
}

// Exa rate card (https://exa.ai/docs/admin/pricing): base price includes up to 10 results;
// text + highlights on /search are included; summaries and results above 10 are billed on top.
const EXA_SEARCH_BASE = Object.freeze({
  lite: 0.004, instant: 0.004,
  auto: 0.007, fast: 0.007, neural: 0.007, keyword: 0.007,
  'deep-lite': 0.012, deep: 0.012,
  'deep-reasoning': 0.015
});
const EXA_UNKNOWN_TYPE = 0.015; // spec's x-payment-info ceiling for /search

/** Pre-request reservation estimate (USD for Exa, credits for Tavily). Errs on the high side. */
export function quote(provider, path, body) {
  if (provider === 'tavily') {
    if (path !== '/search') return 1;
    if (body.search_depth === 'advanced') return 2;
    if (body.auto_parameters === true && body.search_depth === undefined) return 2; // may auto-select advanced
    return 1; // basic, fast, ultra-fast
  }
  if (path === '/contents') {
    const list = Array.isArray(body.urls) ? body.urls : Array.isArray(body.ids) ? body.ids : [];
    const pages = Math.max(1, list.length);
    const subpages = Number.isInteger(body.subpages) && body.subpages > 0 ? body.subpages : 0;
    const types = Math.max(1, Number(Boolean(body.text)) + Number(Boolean(body.highlights)) + Number(Boolean(body.summary)));
    return round6(pages * (1 + subpages) * types * 0.001);
  }
  const type = typeof body.type === 'string' ? body.type : 'auto';
  const base = EXA_SEARCH_BASE[type] ?? EXA_UNKNOWN_TYPE;
  const results = Number.isFinite(body.numResults) ? Math.max(1, Math.ceil(body.numResults)) : 10;
  const c = body.contents && typeof body.contents === 'object' ? body.contents : {};
  const pageTypes = Math.max(1, Number(Boolean(c.text)) + Number(Boolean(c.highlights)));
  // Conservative: whether a result above 10 with text+highlights costs $0.001 or $0.001 per type is ambiguous.
  const extra = Math.max(0, results - 10) * 0.001 * pageTypes;
  const summary = c.summary ? results * 0.001 : 0;
  return round6(base + extra + summary);
}

/** Cost actually reported by the provider, if any. */
export function actualCost(provider, data, estimated) {
  if (provider === 'exa') {
    const total = data?.costDollars?.total;
    return finite(total) ? { amount: total, exact: true } : { amount: estimated, exact: false };
  }
  // Tavily may legitimately report 0 for threshold-billed endpoints; a reported 0 is still exact.
  const credits = data?.usage?.credits;
  return finite(credits) ? { amount: credits, exact: true } : { amount: estimated, exact: false };
}

export function requestIdOf(provider, data, headers) {
  const raw = provider === 'exa' ? (data?.requestId ?? headers?.get?.('x-request-id')) : data?.request_id;
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : null;
}

function exaTag(parsed) {
  return typeof parsed?.tag === 'string' && /^[A-Z0-9_]{1,64}$/.test(parsed.tag) ? parsed.tag : null;
}

/**
 * Decide what one upstream failure means.
 *  action:  'rotate'      try another account (this one is excluded for the request)
 *           'retry'       transient upstream problem; back off and retry (no account penalty)
 *           'passthrough' the request itself was rejected; return it to the client unchanged
 *  effect:  account state change: 'auth' | 'blocked' | 'quota' | 'cooldown' | 'forbidden' | null
 *  exhaust: how to report it if every account ends up failing: 'quota' (429), 'transient' (503),
 *           or 'request' (return this upstream error)
 */
export function classifyFailure(provider, path, status, parsed, headers) {
  const tag = provider === 'exa' ? exaTag(parsed) : null;
  if (status >= 500) return { action: 'retry', effect: null, exhaust: 'transient', tag };
  if (status === 401) return { action: 'rotate', effect: 'auth', exhaust: 'quota', tag };
  if (status === 429) {
    if (provider === 'exa' && String(headers?.get?.('x-ratelimit-scope') || '').toLowerCase() === 'network') {
      // Network-scoped limit hits every account behind this IP; rotating would just burn through them.
      return { action: 'passthrough', effect: null, exhaust: 'quota', tag };
    }
    return { action: 'rotate', effect: 'cooldown', exhaust: 'quota', tag };
  }
  if (provider === 'exa') {
    if (status === 402) {
      // X402_PAYMENT_REQUIRED means no key reached Exa at all: a broker/config problem, not an empty balance.
      return { action: 'rotate', effect: tag === 'X402_PAYMENT_REQUIRED' ? 'auth' : 'quota', exhaust: 'quota', tag };
    }
    if (status === 403) {
      if (tag === 'TEAM_BLOCKED') return { action: 'rotate', effect: 'blocked', exhaust: 'quota', tag };
      if (tag === 'FEATURE_DISABLED') return { action: 'rotate', effect: null, exhaust: 'request', tag };
      // PROHIBITED_CONTENT / CONTENT_FILTER_ERROR / unknown: request-specific. Exa's content policy says
      // never retry these (each retry counts as a warning against the team), so never rotate.
      return { action: 'passthrough', effect: null, exhaust: 'request', tag };
    }
    return { action: 'passthrough', effect: null, exhaust: 'request', tag };
  }
  // Tavily
  if (status === 402 || status === 432 || status === 433) return { action: 'rotate', effect: 'quota', exhaust: 'quota', tag };
  if (status === 403) {
    if (path === '/crawl' || path === '/map') return { action: 'passthrough', effect: null, exhaust: 'request', tag };
    // Undocumented for /search: short cooldown rather than a permanent auth disable.
    return { action: 'rotate', effect: 'forbidden', exhaust: 'quota', tag };
  }
  if (status === 434) return { action: 'rotate', effect: null, exhaust: 'transient', tag }; // flex-tier capacity
  return { action: 'passthrough', effect: null, exhaust: 'request', tag };
}

export function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Replace any configured secret (and key-shaped strings) with [redacted]. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  return out.replace(/\b(tvly-[A-Za-z0-9_-]{8,}|exa-[A-Za-z0-9_-]{16,})\b/g, '[redacted]');
}

/** Provider-shaped, key-free error body for passthrough to the client. */
export function sanitizedError(provider, status, parsed, secrets) {
  const clip = (s) => redact(s, secrets).slice(0, 500);
  if (provider === 'exa') {
    const out = { error: typeof parsed?.error === 'string' ? clip(parsed.error) : `Exa returned HTTP ${status}` };
    const tag = exaTag(parsed);
    if (tag) out.tag = tag;
    if (typeof parsed?.requestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(parsed.requestId)) out.requestId = parsed.requestId;
    return out;
  }
  const detail = parsed?.detail;
  let message;
  if (typeof detail?.error === 'string') message = detail.error;
  else if (typeof detail === 'string') message = detail;
  else if (Array.isArray(detail)) {
    message = 'Validation failed: ' + detail.slice(0, 5)
      .map((d) => `${Array.isArray(d?.loc) ? d.loc.join('.') : '?'}: ${typeof d?.msg === 'string' ? d.msg : 'invalid'}`)
      .join('; ');
  } else message = `Tavily returned HTTP ${status}`;
  return { detail: { error: clip(message) } };
}
