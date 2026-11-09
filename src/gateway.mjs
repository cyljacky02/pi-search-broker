import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AccountManager } from './manager.mjs';
import { APP_NAME, VERSION, TOKEN_ENV, secretsOf } from './config.mjs';
import { ROUTES, PROVIDERS, ACTION, EFFECT, EXHAUST, validateRequest, billFor, parseJsonSafe } from './providers.mjs';
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
  const token = suppliedToken(req);
  return /^(tvly-|exa-)/i.test(token) || token.length === 36
    ? `A provider API key was sent to the local broker. Configure pi-web-access with the broker token instead ("exaApiKey": "$${TOKEN_ENV}"), and unset EXA_API_KEY / TAVILY_API_KEY / TAVILY_API_KEY_n.`
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
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGateway(config, {
  statePath, fetchImpl = fetch, now = () => Date.now(), sleep = defaultSleep, logger = null, reconcileFetch = fetchImpl
} = {}) {
  const manager = new AccountManager(config, { statePath, now });
  const reconciler = createReconciler(manager, config, { fetchImpl: reconcileFetch, now });
  const secrets = secretsOf(config);
  const log = (line) => { try { logger?.(line); } catch { /* logging must never break a request */ } };

  /** Admin operations shared by the HTTP API and the in-process pi host. */
  async function admin(op, body = {}) {
    if (op === 'reconcile') {
      if (body.id !== undefined && typeof body.id !== 'string') throw new Error('id must be a string');
      return { ok: true, results: await reconciler.reconcile(body.id) };
    }
    if (typeof body.id !== 'string') throw new Error('Account id required');
    manager.change(body.id, op, body);
    return { ok: true };
  }
  const status = () => manager.snapshot();

  async function proxy(req, res, route) {
    const policy = PROVIDERS[route.provider];
    const body = await readBody(req);
    const invalid = validateRequest(body);
    if (invalid) return reply(res, 400, policy.errorBody(invalid, { tag: 'BROKER_UNSUPPORTED' }));
    const estimate = policy.quote(route.path, body);
    const deadline = now() + config.totalTimeoutMs;
    const attempted = new Set();
    const onceTagsUsed = new Set();
    const outcome = { [EXHAUST.QUOTA]: false, [EXHAUST.TRANSIENT]: false, request: null };
    let transientRetries = 0;

    // Stop spending upstream credits once the client has gone away.
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });

    while (now() < deadline && !clientGone.signal.aborted) {
      const account = manager.choose(policy.name, estimate, attempted);
      if (!account) break;
      const reservation = manager.reserve(account, estimate);
      const prepared = policy.prepare(body, account, req.headers);
      const attemptMs = Math.max(1, Math.min(config.attemptTimeoutMs ?? route.timeoutMs, deadline - now()));
      const started = now();
      const record = (status, extra = {}) => {
        manager.log({ provider: policy.name, path: route.path, account: account.id, status, ms: now() - started, ...extra });
        log(`${policy.name}${route.path} ${account.id} -> ${status}${extra.requestId ? ` req=${extra.requestId}` : ''}${extra.tag ? ` tag=${extra.tag}` : ''}${extra.cost !== undefined ? ` cost=${extra.cost}${extra.exact ? '' : '~'}` : ''}`);
      };
      let upstream;
      try {
        upstream = await fetchImpl(`${policy.origin}${route.path}`, {
          method: 'POST', headers: prepared.headers, body: prepared.body, redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(attemptMs), clientGone.signal])
        });
      } catch (err) {
        if (clientGone.signal.aborted || err?.name === 'TimeoutError') {
          // The request was sent and may still be billed upstream. Count it, never cool the account down, and never
          // retry it on another account (that could bill twice). 504 lets pi fall back to the other provider.
          manager.commit(reservation, estimate, false, { possiblyBilled: true });
          if (clientGone.signal.aborted) { record('client-closed'); return; }
          manager.recordFailure(account, { status: 'timeout' });
          record('timeout');
          return reply(res, 504, policy.errorBody(`${policy.name} did not answer within ${attemptMs} ms via the local broker; not retried to avoid double billing`));
        }
        // Connection-level failure before a response: nothing was billed. Short cooldown, try another account.
        manager.release(reservation);
        manager.recordFailure(account, { status: 'network', effect: EFFECT.UPSTREAM });
        record('network');
        outcome[EXHAUST.TRANSIENT] = true;
        attempted.add(account.id);
        continue;
      }

      if (!upstream.ok) {
        manager.release(reservation);
        const code = upstream.status;
        const parsed = parseJsonSafe(await readErrorText(upstream));
        const verdict = policy.classify(route.path, code, parsed, upstream.headers);
        manager.recordFailure(account, {
          status: code, effect: verdict.effect, tag: verdict.tag,
          retryAfterMs: retryAfterMs(upstream.headers.get('retry-after'), now())
        });
        record(code, { tag: verdict.tag ?? undefined, requestId: policy.requestId(parsed, upstream.headers) ?? undefined });
        const upstreamError = () => reply(res, code >= 400 && code < 500 ? code : 502, policy.sanitizeError(code, parsed, secrets));
        if (verdict.action === ACTION.PASSTHROUGH) return upstreamError();
        if (verdict.once) {
          // e.g. Exa FEATURE_DISABLED: try exactly one other account, then report the provider's answer.
          if (onceTagsUsed.has(verdict.tag)) return upstreamError();
          onceTagsUsed.add(verdict.tag);
        }
        if (verdict.exhaust === EXHAUST.REQUEST) outcome.request = { code, body: policy.sanitizeError(code, parsed, secrets) };
        else outcome[verdict.exhaust] = true;
        if (verdict.action === ACTION.ROTATE) { attempted.add(account.id); continue; }
        // ACTION.RETRY (Exa 503 SERVICE_OVERLOADED, not billed): back off and retry without penalising the account.
        if (transientRetries >= config.maxTransientRetries) break;
        transientRetries++;
        await sleep(Math.min(250 * 2 ** (transientRetries - 1), Math.max(0, deadline - now())));
        continue;
      }

      let data;
      try {
        data = await upstream.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid JSON');
      } catch {
        // A 2xx was probably billed. Do not retry on another account (it would bill again); let pi fall back.
        manager.commit(reservation, estimate, false, { possiblyBilled: true });
        record('invalid-response');
        return reply(res, 502, policy.errorBody(`${policy.name} returned an invalid response body via the local broker`));
      }
      const bill = billFor(policy, data, estimate);
      const requestId = policy.requestId(data, upstream.headers);
      manager.commit(reservation, bill.amount, bill.exact, { requestId });
      record(upstream.status, { requestId: requestId ?? undefined, cost: bill.amount, exact: bill.exact });
      return reply(res, 200, policy.finalize(data, prepared.clientWantsUsage));
    }

    if (clientGone.signal.aborted) return;
    // pi-web-access maps 429 -> "quota" and 503 -> "transient"; both can trigger cross-provider fallback.
    // Quota wins so the outcome does not depend on attempt order.
    if (outcome[EXHAUST.QUOTA]) {
      return reply(res, 429, policy.errorBody(`No available ${policy.name} account: all exhausted, rate limited, disabled or cooling down (local broker)`));
    }
    if (outcome[EXHAUST.TRANSIENT]) {
      return reply(res, 503, policy.errorBody(`${policy.name} is temporarily unavailable through the local broker (upstream failures on every attempt)`));
    }
    if (outcome.request) return reply(res, outcome.request.code, outcome.request.body);
    return reply(res, 429, policy.errorBody(`No available ${policy.name} account: all exhausted, disabled or cooling down (local broker)`));
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
      if (url.pathname === '/status' && req.method === 'GET') return reply(res, 200, status());
      if (url.pathname.startsWith('/admin/') && req.method === 'POST') {
        const body = await readBody(req);
        try { return reply(res, 200, await admin(url.pathname.slice('/admin/'.length), body)); }
        catch (err) { return reply(res, 400, { error: err.message }); }
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
  return { server, manager, status, admin };
}
