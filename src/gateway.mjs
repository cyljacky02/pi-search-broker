import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AccountManager } from './manager.mjs';
import { APP_NAME, VERSION } from './config.mjs';
import {
  UPSTREAM, ROUTES, validateRequest, prepareRequest, finalizeResponse, quote, actualCost,
  requestIdOf, classifyFailure, parseJsonSafe, sanitizedError
} from './providers.mjs';
import { createReconciler } from './reconcile.mjs';

const MAX_ERROR_BODY = 64 * 1024;

function suppliedToken(req) {
  const headerKey = req.headers['x-api-key'];
  const headerAuth = req.headers.authorization;
  return (typeof headerKey === 'string' ? headerKey : typeof headerAuth === 'string' ? headerAuth.replace(/^Bearer\s+/i, '') : '').trim();
}
function isAuthorized(req, secret) {
  const expected = Buffer.from(secret);
  const actual = Buffer.from(suppliedToken(req));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function unauthorizedHint(req) {
  // pi-web-access classifies 401 as "auth" (no fallback). Explain the usual cause without echoing anything back.
  return /^(tvly-|exa-)/i.test(suppliedToken(req)) || suppliedToken(req).length === 36
    ? 'A provider API key was sent to the local broker. Configure pi-web-access with the broker token instead (e.g. "exaApiKey": "$PI_SEARCH_BROKER_TOKEN"), and unset EXA_API_KEY / TAVILY_API_KEY / TAVILY_API_KEY_n.'
    : 'Missing or wrong local broker token.';
}
function reply(res, code, data) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}
function retryAfterMs(value, now) {
  if (typeof value !== 'string') return 0;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value.trim()) * 1000);
  const d = Date.parse(value);
  return Number.isFinite(d) ? Math.max(0, d - now) : 0;
}
async function readBody(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected JSON object');
    return body;
  } catch {
    throw Object.assign(new Error('Expected valid JSON object'), { statusCode: 400 });
  }
}
async function readErrorText(response) {
  try { return (await response.text()).slice(0, MAX_ERROR_BODY); } catch { return ''; }
}
const isTimeout = (err) => err?.name === 'TimeoutError';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGateway(config, {
  statePath, fetchImpl = fetch, now = () => Date.now(), sleep = defaultSleep, logger = null, reconcileFetch = fetchImpl
} = {}) {
  const manager = new AccountManager(config, { statePath, now });
  const reconciler = createReconciler(manager, config, { fetchImpl: reconcileFetch, now });
  const secrets = [config.gateway.token, ...config.accounts.flatMap((a) => [a.apiKey, a.adminKey].filter(Boolean))];
  const log = (line) => { try { logger?.(line); } catch { /* logging must never break a request */ } };

  async function proxy(req, res, route) {
    const { provider, path } = route;
    const body = await readBody(req);
    const invalid = validateRequest(route, body);
    if (invalid) return reply(res, 400, provider === 'exa' ? { error: invalid, tag: 'BROKER_UNSUPPORTED' } : { detail: { error: invalid } });
    const estimate = quote(provider, path, body);
    const deadline = now() + config.totalTimeoutMs;
    const attempted = new Set();
    const outcome = { quota: false, transient: false, request: null };
    let transientRetries = 0;

    // Stop spending upstream credits once the client has gone away.
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });

    while (now() < deadline && !clientGone.signal.aborted) {
      const account = manager.choose(provider, estimate, attempted);
      if (!account) break;
      const reservation = manager.reserve(account, estimate);
      const prepared = prepareRequest(route, body, account, req.headers);
      const attemptMs = Math.max(1, Math.min(config.attemptTimeoutMs ?? route.timeoutMs, deadline - now()));
      const started = now();
      const record = (status, extra = {}) => {
        const item = { provider, path, account: account.id, status, ms: now() - started, ...extra };
        manager.log(item);
        log(`${item.provider}${item.path} ${item.account} -> ${status}${extra.requestId ? ` req=${extra.requestId}` : ''}${extra.tag ? ` tag=${extra.tag}` : ''}${extra.cost !== undefined ? ` cost=${extra.cost}${extra.exact ? '' : '~'}` : ''}`);
      };
      let upstream;
      try {
        upstream = await fetchImpl(`${UPSTREAM[provider]}${path}`, {
          method: 'POST', headers: prepared.headers, body: prepared.body, redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(attemptMs), clientGone.signal])
        });
      } catch (err) {
        if (clientGone.signal.aborted) {
          // The request may already be billed upstream; count it conservatively.
          manager.commit(reservation, estimate, false, { possiblyBilled: true });
          record('client-closed');
          return;
        }
        if (isTimeout(err)) {
          // The provider may still finish (and bill) the request. Do not cool the account down.
          manager.commit(reservation, estimate, false, { possiblyBilled: true });
          manager.recordFailure(account, { status: 'timeout' });
          record('timeout');
          attempted.add(account.id);
          outcome.transient = true;
          continue;
        }
        // Connection-level failure (DNS, reset, refused). Usually not account-specific: retry with backoff.
        manager.release(reservation);
        manager.recordFailure(account, { status: 'network' });
        record('network');
        outcome.transient = true;
        if (transientRetries++ < config.maxTransientRetries) { await sleep(Math.min(250 * 2 ** (transientRetries - 1), Math.max(0, deadline - now()))); continue; }
        break;
      }

      if (!upstream.ok) {
        manager.release(reservation);
        const status = upstream.status;
        const parsed = parseJsonSafe(await readErrorText(upstream));
        const verdict = classifyFailure(provider, path, status, parsed, upstream.headers);
        manager.recordFailure(account, {
          status, effect: verdict.effect, tag: verdict.tag,
          retryAfterMs: retryAfterMs(upstream.headers.get('retry-after'), now())
        });
        record(status, { tag: verdict.tag ?? undefined, requestId: requestIdOf(provider, parsed, upstream.headers) ?? undefined });
        if (verdict.action === 'passthrough') {
          return reply(res, status >= 400 && status < 500 ? status : 502, sanitizedError(provider, status, parsed, secrets));
        }
        if (verdict.exhaust === 'request') outcome.request = { status, body: sanitizedError(provider, status, parsed, secrets) };
        else outcome[verdict.exhaust] = true;
        if (verdict.action === 'rotate') { attempted.add(account.id); continue; }
        // 'retry': transient provider-side failure (5xx, Exa 503 SERVICE_OVERLOADED is not billed).
        if (transientRetries++ < config.maxTransientRetries) { await sleep(Math.min(250 * 2 ** (transientRetries - 1), Math.max(0, deadline - now()))); continue; }
        break;
      }

      let data;
      try {
        data = await upstream.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid JSON');
      } catch {
        // A 2xx was probably billed. Do not retry on another account (it would bill again); let pi fall back.
        manager.commit(reservation, estimate, false, { possiblyBilled: true });
        record('invalid-response');
        return reply(res, 502, provider === 'exa'
          ? { error: 'Exa returned an invalid response body via the local broker' }
          : { detail: { error: 'Tavily returned an invalid response body via the local broker' } });
      }
      const bill = actualCost(provider, data, estimate);
      const requestId = requestIdOf(provider, data, upstream.headers);
      manager.commit(reservation, bill.amount, bill.exact, { requestId });
      record(upstream.status, { requestId: requestId ?? undefined, cost: bill.amount, exact: bill.exact });
      return reply(res, 200, finalizeResponse(route, data, prepared.clientWantsUsage));
    }

    if (clientGone.signal.aborted) return;
    // pi-web-access maps 429 -> "quota" and 503 -> "transient"; both can trigger cross-provider fallback.
    // Quota wins so the outcome does not depend on attempt order.
    if (outcome.quota) {
      return reply(res, 429, { error: `No available ${provider} account: all exhausted, rate limited, disabled or cooling down (local broker)` });
    }
    if (outcome.transient) {
      return reply(res, 503, { error: `${provider} is temporarily unavailable through the local broker; upstream failures or timeouts on every attempt` });
    }
    if (outcome.request) return reply(res, outcome.request.status, outcome.request.body);
    return reply(res, 429, { error: `No available ${provider} account: all exhausted, disabled or cooling down (local broker)` });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      // Disallow query strings: no need to forward any untrusted host / URL fields.
      if (url.search) return reply(res, 400, { error: 'Query parameters are not supported' });
      if (url.pathname === '/health' && req.method === 'GET') {
        return reply(res, 200, { ok: true, service: APP_NAME, version: VERSION, pid: process.pid });
      }
      if (!isAuthorized(req, config.gateway.token)) return reply(res, 401, { error: unauthorizedHint(req) });
      if (url.pathname === '/status' && req.method === 'GET') return reply(res, 200, manager.snapshot());
      if (url.pathname === '/admin/reconcile' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.id !== undefined && typeof body.id !== 'string') return reply(res, 400, { error: 'id must be a string' });
        return reply(res, 200, { ok: true, results: await reconciler.reconcile(body.id) });
      }
      if (url.pathname.startsWith('/admin/') && req.method === 'POST') {
        const op = url.pathname.slice('/admin/'.length);
        const body = await readBody(req);
        if (typeof body.id !== 'string') return reply(res, 400, { error: 'Account id required' });
        try { manager.change(body.id, op, body); }
        catch (err) { return reply(res, 400, { error: err.message }); }
        return reply(res, 200, { ok: true });
      }
      const route = ROUTES[url.pathname];
      if (!route || req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
      await proxy(req, res, route);
    } catch (err) {
      const code = err.statusCode || 500;
      // Never include upstream response bodies, key strings or raw exception traces.
      reply(res, code, { error: code === 500 ? 'Gateway internal error; inspect local logs' : err.message });
      if (code === 500) log(`internal error: ${err?.name ?? 'Error'}`);
    }
  });
  // Never keep idle sockets open forever.
  server.requestTimeout = 60000;
  server.headersTimeout = 65000;
  server.on('listening', () => reconciler.start());
  server.on('close', () => reconciler.stop());
  return { server, manager, reconciler };
}
