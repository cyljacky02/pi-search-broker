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
  let pool;
  let reconciler;
  let broker;
  let internalControl;
  let draining = false;
  let shutdownPromise = null;
  const active = new Set();
  function track(work) {
    active.add(work);
    work.then(() => active.delete(work), () => active.delete(work));
    return work;
  }

  // Pool construction writes state, so initialize only after binding the Port.
  function initialize() {
    if (pool) return;
    pool = createAccountPool(config.accounts, { store, now, logger });
    reconciler = createReconciler(pool, { fetchImpl: reconcileFetch, now, intervalMs: config.reconcileIntervalMs });
    broker = createBroker({ pool, limits: config, secrets: secretsOf(config), fetchImpl, now, sleep });
    internalControl = inProcessControl({ pool, reconciler });
  }

  const control = {
    mode: 'in-process',
    ...Object.fromEntries(['health', 'status', 'enable', 'disable', 'setSpent', 'reconcile'].map((name) => [
      name, (...args) => {
        if (draining) return Promise.reject(Object.assign(new Error('Gateway is shutting down'), { statusCode: 503 }));
        if (!pool) return Promise.reject(new Error('Gateway has not acquired the Port'));
        return track(internalControl[name](...args));
      }
    ]))
  };

  async function proxy(req, res, route) {
    const body = await readBody(req);
    if (draining) return reply(res, 503, { error: 'Gateway is shutting down' });
    // Stop spending upstream credits once the client has gone away.
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
    const result = await broker.execute(route, body, { headers: req.headers, signal: clientGone.signal });
    if (result.status !== CLIENT_CLOSED) reply(res, result.status, result.body);
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      // Disallow query strings: no need to forward any untrusted host / URL fields.
      if (url.search) return reply(res, 400, { error: 'Query parameters are not supported' });
      if (url.pathname === '/health' && req.method === 'GET') {
        return reply(res, 200, { ok: true, service: SERVICE_NAME, version: VERSION, pid: process.pid });
      }
      if (draining) return reply(res, 503, { error: 'Gateway is shutting down' });
      if (!isAuthorized(req, config.gateway.token)) return reply(res, 401, { error: unauthorizedHint(req) });
      if (url.pathname === '/status' && req.method === 'GET') return reply(res, 200, await control.status());
      if (url.pathname.startsWith('/admin/') && req.method === 'POST') {
        const body = await readBody(req);
        try { return reply(res, 200, await serveAdmin(control, url.pathname.slice('/admin/'.length), body)); }
        catch (err) { return reply(res, err.statusCode || 400, { error: err.message }); }
      }
      const route = ROUTES[url.pathname];
      if (!route || req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
      await proxy(req, res, route);
    } catch (err) {
      const code = err.statusCode || 500;
      // Never include upstream response bodies, key strings or raw exception traces. Preserve the pool's
      // sanitized persistence message and status, including its post-Attempt "Request aborted" diagnostic
      // so pi-web-access does not fall back after a possibly billed Attempt.
      const message = err.persistenceFailure ? err.message : code === 500 ? 'Gateway internal error; inspect local logs' : err.message;
      reply(res, code, { error: message });
      if (code === 500) log(`internal error: ${err?.name ?? 'Error'}`);
    }
  }
  const server = createServer((req, res) => {
    // The draining Gateway still identifies the Port owner, but never accepts more mutating work.
    if (draining) {
      if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, service: SERVICE_NAME, version: VERSION, pid: process.pid });
      return reply(res, 503, { error: 'Gateway is shutting down' });
    }
    // Register before entering any asynchronous handler. Closing a socket alone does not finish its work.
    track(Promise.resolve().then(() => handle(req, res)));
  });
  // Never keep idle sockets open forever.
  server.requestTimeout = 60000;
  server.headersTimeout = 65000;
  function activate() {
    if (draining) throw new Error('Gateway is shutting down');
    if (!server.listening) throw new Error('Gateway has not acquired the Port');
    initialize();
    reconciler.start();
  }
  let startupError = null;
  server.on('listening', () => {
    if (draining) return;
    try { activate(); }
    catch (err) {
      startupError = err;
      // Report initialization failure as a server error, but do not leave the port bound.
      shutdown().then(
        () => process.nextTick(() => server.emit('error', err)),
        () => { log('Gateway shutdown failed'); process.nextTick(() => server.emit('error', err)); }
      );
    }
  });
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    if (draining) throw new Error('Gateway is shutting down');
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const callback = args[last];
      args[last] = (...values) => { if (!startupError && !draining) callback.apply(server, values); };
    }
    return listen(...args);
  };

  const close = server.close.bind(server);
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    shutdownPromise = Promise.resolve().then(async () => {
      // Reconciliation is report-only and can be cancelled; brokered requests must finish settlement.
      if (reconciler) await reconciler.stop();
      await Promise.allSettled([...active]);
      await new Promise((resolve, reject) => close((err) => err ? reject(err) : resolve()));
    });
    return shutdownPromise;
  }
  // Preserve server.close(callback) for standalone and existing callers, but drain before unbinding.
  server.close = (callback) => {
    const work = shutdown();
    if (callback) work.then(() => process.nextTick(callback), (err) => process.nextTick(callback, err));
    else work.catch(() => log('Gateway shutdown failed'));
    return server;
  };
  return { server, control, shutdown };
}
