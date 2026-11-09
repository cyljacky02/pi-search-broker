// Provider wire policy for Exa and Tavily: one object per provider, so callers never branch on the provider name.
// Sources for every rule here are cited in docs/research/exa.md and docs/research/tavily.md.
import { round6, isNonNegativeNumber } from './numbers.mjs';

/** What to do after an upstream failure. */
export const ACTION = Object.freeze({
  ROTATE: 'rotate',          // try another account (this one is excluded for the request)
  RETRY: 'retry',            // provider-wide transient problem: back off and retry, no account penalty
  PASSTHROUGH: 'passthrough' // the request itself was rejected: return it to the client
});
/** How a failure changes the account's state (consumed by AccountManager.recordFailure). */
export const EFFECT = Object.freeze({
  AUTH: 'auth',             // disabled until re-enabled
  BLOCKED: 'blocked',       // provider revoked access; disabled until re-enabled
  QUOTA: 'quota',           // out of credit until the next reset / promo change
  RATE_LIMIT: 'rate-limit', // cooldown from Retry-After
  FORBIDDEN: 'forbidden',   // 10-minute cooldown
  UPSTREAM: 'upstream'      // 10-second cooldown after a 5xx or network failure
});
/** How a failure is reported if every account ends up failing. */
export const EXHAUST = Object.freeze({
  QUOTA: 'quota',         // HTTP 429 (pi-web-access: "quota", falls back)
  TRANSIENT: 'transient', // HTTP 503 (pi-web-access: "transient", falls back)
  REQUEST: 'request'      // return this upstream error as-is
});

/**
 * Local routes. pi-web-access 0.47.0 only calls these three (docs/research/pi-web-access.md §1).
 * timeoutMs is the default per-attempt timeout (~30 s per route, under the 55 s total cap).
 */
export const ROUTES = Object.freeze({
  '/exa/search': Object.freeze({ provider: 'exa', path: '/search', timeoutMs: 30000 }),
  '/exa/contents': Object.freeze({ provider: 'exa', path: '/contents', timeoutMs: 30000 }),
  '/tavily/search': Object.freeze({ provider: 'tavily', path: '/search', timeoutMs: 30000 })
});

const HEADER_TOKEN = /^[A-Za-z0-9._:\-]{1,64}$/;
const HEADER_LIST = /^[A-Za-z0-9._:\-]{1,64}(?:\s*,\s*[A-Za-z0-9._:\-]{1,64}){0,7}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const verdict = (action, effect, exhaust, tag = null, extra = {}) => ({ action, effect, exhaust, tag, ...extra });

/** Replace any configured secret (and key-shaped strings) with [redacted]. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  return out.replace(/\b(tvly-[A-Za-z0-9_-]{8,}|exa-[A-Za-z0-9_-]{16,})\b/g, '[redacted]');
}
const clip = (s, secrets) => redact(s, secrets).slice(0, 500);

/** Rules shared by both providers; returns null when the provider-specific rules decide. */
function commonVerdict(status, tag) {
  if (status === 401) return verdict(ACTION.ROTATE, EFFECT.AUTH, EXHAUST.QUOTA, tag);
  if (status === 429) return verdict(ACTION.ROTATE, EFFECT.RATE_LIMIT, EXHAUST.QUOTA, tag);
  if (status >= 500) return verdict(ACTION.ROTATE, EFFECT.UPSTREAM, EXHAUST.TRANSIENT, tag);
  return null;
}

// Exa rate card (https://exa.ai/docs/admin/pricing): base price includes up to 10 results;
// text + highlights on /search are included; summaries and results above 10 are billed on top.
const EXA_SEARCH_BASE = Object.freeze({
  lite: 0.004, instant: 0.004,
  auto: 0.007, fast: 0.007, neural: 0.007, keyword: 0.007,
  'deep-lite': 0.012, deep: 0.012,
  'deep-reasoning': 0.015
});
const EXA_UNKNOWN_TYPE = 0.015; // the spec's x-payment-info ceiling for /search
const exaTag = (parsed) => (typeof parsed?.tag === 'string' && /^[A-Z0-9_]{1,64}$/.test(parsed.tag) ? parsed.tag : null);

const exa = Object.freeze({
  name: 'exa',
  unit: 'USD',
  origin: 'https://api.exa.ai',

  prepare(body, account, clientHeaders = {}) {
    const integration = clientHeaders['x-exa-integration'];
    const headers = {
      'x-api-key': account.apiKey,
      'Content-Type': 'application/json',
      'x-exa-integration': typeof integration === 'string' && HEADER_TOKEN.test(integration) ? integration : 'pi-web-access'
    };
    const beta = clientHeaders['exa-beta'];
    if (typeof beta === 'string' && HEADER_LIST.test(beta)) headers['Exa-Beta'] = beta;
    return { headers, body: JSON.stringify(body), clientWantsUsage: true };
  },
  finalize: (data) => data,

  /** Reservation estimate in USD; errs on the high side. */
  quote(path, body) {
    if (path === '/contents') {
      const list = Array.isArray(body.urls) ? body.urls : Array.isArray(body.ids) ? body.ids : [];
      const subpages = Number.isInteger(body.subpages) && body.subpages > 0 ? body.subpages : 0;
      const types = Math.max(1, Number(Boolean(body.text)) + Number(Boolean(body.highlights)) + Number(Boolean(body.summary)));
      return round6(Math.max(1, list.length) * (1 + subpages) * types * 0.001);
    }
    const base = EXA_SEARCH_BASE[typeof body.type === 'string' ? body.type : 'auto'] ?? EXA_UNKNOWN_TYPE;
    const results = Number.isFinite(body.numResults) ? Math.max(1, Math.ceil(body.numResults)) : 10;
    const c = body.contents && typeof body.contents === 'object' ? body.contents : {};
    const pageTypes = Math.max(1, Number(Boolean(c.text)) + Number(Boolean(c.highlights)));
    // Conservative: whether a result above 10 with text+highlights costs $0.001 or $0.001 per type is ambiguous.
    const extra = Math.max(0, results - 10) * 0.001 * pageTypes;
    return round6(base + extra + (c.summary ? results * 0.001 : 0));
  },
  reportedCost: (data) => (isNonNegativeNumber(data?.costDollars?.total) ? data.costDollars.total : null),
  requestId(data, headers) {
    const raw = data?.requestId ?? headers?.get?.('x-request-id');
    return typeof raw === 'string' && REQUEST_ID.test(raw) ? raw : null;
  },

  classify(path, status, parsed, headers) {
    const tag = exaTag(parsed);
    if (status === 503) return verdict(ACTION.RETRY, null, EXHAUST.TRANSIENT, tag); // SERVICE_OVERLOADED: not billed
    if (status === 429 && String(headers?.get?.('x-ratelimit-scope') || '').toLowerCase() === 'network') {
      // A network-scoped limit hits every account behind this IP; rotating would just burn through them.
      return verdict(ACTION.PASSTHROUGH, null, EXHAUST.QUOTA, tag);
    }
    const common = commonVerdict(status, tag);
    if (common) return common;
    if (status === 402) {
      // X402_PAYMENT_REQUIRED means no key reached Exa at all: a broker/config problem, not an empty balance.
      return verdict(ACTION.ROTATE, tag === 'X402_PAYMENT_REQUIRED' ? EFFECT.AUTH : EFFECT.QUOTA, EXHAUST.QUOTA, tag);
    }
    if (status === 403 && tag === 'TEAM_BLOCKED') return verdict(ACTION.ROTATE, EFFECT.BLOCKED, EXHAUST.QUOTA, tag);
    // Another plan might allow the feature: try exactly one other account.
    if (status === 403 && tag === 'FEATURE_DISABLED') return verdict(ACTION.ROTATE, null, EXHAUST.REQUEST, tag, { once: true });
    // PROHIBITED_CONTENT / CONTENT_FILTER_ERROR / unknown 403 / other 4xx: request-specific. Exa's content policy
    // says never retry refused requests (each retry counts as a warning against the team).
    return verdict(ACTION.PASSTHROUGH, null, EXHAUST.REQUEST, tag);
  },

  errorBody: (message, extra = {}) => ({ error: message, ...extra }),
  sanitizeError(status, parsed, secrets) {
    const out = { error: typeof parsed?.error === 'string' ? clip(parsed.error, secrets) : `Exa returned HTTP ${status}` };
    const tag = exaTag(parsed);
    if (tag) out.tag = tag;
    if (typeof parsed?.requestId === 'string' && REQUEST_ID.test(parsed.requestId)) out.requestId = parsed.requestId;
    return out;
  },

  /** Team Management API: needs a service key that Exa support enables; may lag usage by up to 5 minutes. */
  balance: Object.freeze({
    url: 'https://admin-api.exa.ai/team-management/credits',
    supports: (account) => Boolean(account.adminKey),
    headers: (account) => ({ 'x-api-key': account.adminKey }),
    parse(data) {
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
  })
});

const tavily = Object.freeze({
  name: 'tavily',
  unit: 'credits',
  origin: 'https://api.tavily.com',

  prepare(body, account) {
    // A body api_key (the official MCP server still sends one) would carry the local gateway token upstream.
    const { api_key: _dropped, ...rest } = body;
    const clientWantsUsage = rest.include_usage === true;
    const headers = { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json' };
    if (account.projectId) headers['X-Project-ID'] = account.projectId;
    // include_usage makes Tavily report exact credits in usage.credits.
    return { headers, body: JSON.stringify({ ...rest, include_usage: true }), clientWantsUsage };
  },
  finalize(data, clientWantsUsage) {
    if (!clientWantsUsage) delete data.usage;
    return data;
  },

  /** Reservation estimate in credits. */
  quote(_path, body) {
    if (body.search_depth === 'advanced') return 2;
    if (body.auto_parameters === true && body.search_depth === undefined) return 2; // may auto-select advanced
    return 1; // basic, fast, ultra-fast
  },
  // A reported 0 is still exact (threshold-billed endpoints).
  reportedCost: (data) => (isNonNegativeNumber(data?.usage?.credits) ? data.usage.credits : null),
  requestId: (data) => (typeof data?.request_id === 'string' && REQUEST_ID.test(data.request_id) ? data.request_id : null),

  classify(_path, status) {
    const common = commonVerdict(status, null);
    if (common) return common;
    if (status === 402 || status === 432 || status === 433) return verdict(ACTION.ROTATE, EFFECT.QUOTA, EXHAUST.QUOTA);
    // Undocumented for /search: short cooldown rather than a permanent disable.
    if (status === 403) return verdict(ACTION.ROTATE, EFFECT.FORBIDDEN, EXHAUST.QUOTA);
    if (status === 434) return verdict(ACTION.ROTATE, null, EXHAUST.TRANSIENT); // flex-tier capacity, not the account's fault
    return verdict(ACTION.PASSTHROUGH, null, EXHAUST.REQUEST);
  },

  errorBody: (message) => ({ detail: { error: message } }),
  sanitizeError(status, parsed, secrets) {
    const detail = parsed?.detail;
    let message;
    if (typeof detail?.error === 'string') message = detail.error;
    else if (typeof detail === 'string') message = detail;
    else if (Array.isArray(detail)) {
      message = 'Validation failed: ' + detail.slice(0, 5)
        .map((d) => `${Array.isArray(d?.loc) ? d.loc.join('.') : '?'}: ${typeof d?.msg === 'string' ? d.msg : 'invalid'}`)
        .join('; ');
    } else message = `Tavily returned HTTP ${status}`;
    return { detail: { error: clip(message, secrets) } };
  },

  /** GET /usage works with any key; its own rate limit is 10 requests per 10 minutes. */
  balance: Object.freeze({
    url: 'https://api.tavily.com/usage',
    supports: () => true,
    headers: (account) => ({ Authorization: `Bearer ${account.apiKey}` }),
    parse(data) {
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
        details: {
          plan: typeof acct.current_plan === 'string' ? acct.current_plan.slice(0, 64) : null,
          planUsage, planLimit, paygoUsage, paygoLimit, keyUsage, keyLimit
        }
      };
    }
  })
});

export const PROVIDERS = Object.freeze({ exa, tavily });
