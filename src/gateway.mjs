import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createAccountPool } from './pool.mjs';
import { memoryStore } from './pool/store.mjs';
import { SERVICE_NAME, VERSION, TOKEN_ENV, secretsOf } from './config.mjs';
import { ROUTES } from './providers.mjs';
import { createReconciler } from './reconcile.mjs';
import { createBroker, CLIENT_CLOSED } from './broker.mjs';
import { inProcessControl, serveAdmin } from './control.mjs';
import { quietLogger } from './log.mjs';

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

/**
 * @param store           account pool state store (default: in memory; the host and CLI pass a fileStore)
 * @param reconcileFetch  fetch for provider balance endpoints (default: the real fetch)
 */
export function createGateway(config, {
  store = memoryStore(), fetchImpl = fetch, now = () => Date.now(), sleep, logger = null, reconcileFetch = fetch
} = {}) {
  const log = quietLogger(logger);
  const pool = createAccountPool(config.accounts, { store, now, logger });
  const reconciler = createReconciler(pool, { fetchImpl: reconcileFetch, now, intervalMs: config.reconcileIntervalMs });
  const broker = createBroker({ pool, limits: config, secrets: secretsOf(config), fetchImpl, now, sleep });

  const control = inProcessControl({ pool, reconciler });

  async function proxy(req, res, route) {
    const body = await readBody(req);
    // Stop spending upstream credits once the client has gone away.
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
    const result = await broker.execute(route, body, { headers: req.headers, signal: clientGone.signal });
    if (result.status !== CLIENT_CLOSED) reply(res, result.status, result.body);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      // Disallow query strings: no need to forward any untrusted host / URL fields.
      if (url.search) return reply(res, 400, { error: 'Query parameters are not supported' });
      if (url.pathname === '/health' && req.method === 'GET') {
        return reply(res, 200, { ok: true, service: SERVICE_NAME, version: VERSION, pid: process.pid });
      }
      if (!isAuthorized(req, config.gateway.token)) return reply(res, 401, { error: unauthorizedHint(req) });
      if (url.pathname === '/status' && req.method === 'GET') return reply(res, 200, await control.status());
      if (url.pathname.startsWith('/admin/') && req.method === 'POST') {
        const body = await readBody(req);
        try { return reply(res, 200, await serveAdmin(control, url.pathname.slice('/admin/'.length), body)); }
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
  return { server, control };
}
