import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createAccountPool, StateNotSaved } from './pool.mjs';
import { memoryStore } from './pool/store.mjs';
import { SERVICE_NAME, VERSION, TOKEN_ENV, secretsOf } from './config.mjs';
import { ROUTES } from './providers.mjs';
import { createBalanceChecks } from './reconcile.mjs';
import { createBroker, CLIENT_CLOSED } from './broker.mjs';
import { baseUrl, inProcessControl, serveAdmin } from './control.mjs';
import { quietLogger } from './log.mjs';
import { realClock } from './clock.mjs';

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
function replyHealth(res) {
  return reply(res, 200, { ok: true, service: SERVICE_NAME, version: VERSION, pid: process.pid });
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

const SHUTTING_DOWN = 'Gateway is shutting down';
const shuttingDown = () => Object.assign(new Error(SHUTTING_DOWN), { statusCode: 503 });

/**
 * Admission for everything the Gateway does: run() admits a task and keeps it until it settles; close() refuses new
 * work at once and resolves when everything admitted has settled, including work admitted while it waits.
 */
function createGate() {
  const inFlight = new Set();
  let open = true;
  return {
    get open() { return open; },
    run(task) {
      if (!open) return Promise.reject(shuttingDown());
      const work = Promise.resolve().then(task);
      const forget = () => inFlight.delete(work);
      inFlight.add(work);
      work.then(forget, forget);
      return work;
    },
    async close() {
      open = false;
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    }
  };
}

/**
 * The loopback HTTP endpoint pi-web-access sends Exa and Tavily requests to. A Gateway serves once:
 *   start({ port?, host?, unref? }) -> { port, url }   bind the Port, then load the Account pool and serve
 *   stop()                                           refuse new work, cancel balance checks, let in-flight work
 *                                                    settle, release the Port
 *   control                                          broker control for this process (see control.mjs)
 *
 * @param store           account pool state store (default: in memory; the host and CLI pass a fileStore)
 * @param reconcileFetch  fetch for provider balance endpoints (default: the real fetch)
 * @param clock           { now, sleep, timeout } (see clock.mjs) for everything the Gateway builds
 * @param logger          optional (line) => void
 */
export function createGateway(config, {
  store = memoryStore(), fetchImpl = fetch, reconcileFetch = fetch, clock = realClock, logger = null
} = {}) {
  const log = quietLogger(logger);
  const now = () => clock.now();
  const gate = createGate();
  const cancelChecks = new AbortController(); // balance checks are report-only, so stopping cancels them
  let serving = null; // what the Gateway runs once it owns the Port: { pool, broker, balanceChecks, control }
  let timer = null;
  let starting = null;
  let stopping = null;

  // Pool construction loads and saves state, so this runs only after the Port is bound.
  function assemble() {
    const pool = createAccountPool(config.accounts, { store, now, logger });
    const balanceChecks = createBalanceChecks({ accounts: config.accounts, pool, fetchImpl: reconcileFetch, now, signal: cancelChecks.signal });
    const broker = createBroker({ pool, limits: config, secrets: secretsOf(config), fetchImpl, clock });
    return { pool, broker, balanceChecks, control: inProcessControl({ pool, reconciler: { reconcile: (id) => balanceChecks.run(id) } }) };
  }

  // Broker control for this process: usable once the Gateway serves, refused once it stops.
  const control = {
    mode: 'in-process',
    ...Object.fromEntries(['health', 'status', 'enable', 'disable', 'setSpent', 'reconcile'].map((name) => [
      name, (...args) => {
        if (!serving) return Promise.reject(gate.open ? new Error('Gateway has not acquired the Port') : shuttingDown());
        return gate.run(() => serving.control[name](...args));
      }
    ]))
  };

  async function proxy(req, res, route) {
    const body = await readBody(req);
    // The body can finish arriving after stop() began: start no new Attempt then.
    if (!gate.open) return reply(res, 503, { error: SHUTTING_DOWN });
    // Stop spending upstream credits once the client has gone away.
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
    const result = await serving.broker.execute(route, body, { headers: req.headers, signal: clientGone.signal });
    if (result.status !== CLIENT_CLOSED) reply(res, result.status, result.body);
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      // Disallow query strings: no need to forward any untrusted host / URL fields.
      if (url.search) return reply(res, 400, { error: 'Query parameters are not supported' });
      if (url.pathname === '/health' && req.method === 'GET') return replyHealth(res);
      if (!isAuthorized(req, config.gateway.token)) return reply(res, 401, { error: unauthorizedHint(req) });
      if (url.pathname === '/status' && req.method === 'GET') return reply(res, 200, await control.status());
      if (url.pathname.startsWith('/admin/') && req.method === 'POST') {
        const body = await readBody(req);
        try { return reply(res, 200, await serveAdmin(control, url.pathname.slice('/admin/'.length), body)); }
        catch (err) { return reply(res, err instanceof StateNotSaved ? 503 : err.statusCode || 400, { error: err.message }); }
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
  }

  const server = createServer((req, res) => {
    if (!gate.open) {
      // A stopping Gateway still identifies the Port owner, but accepts no more work.
      if (req.method === 'GET' && req.url === '/health') return replyHealth(res);
      return reply(res, 503, { error: SHUTTING_DOWN });
    }
    // Admit before any asynchronous step: stop() waits for this request even if its socket closes.
    gate.run(() => handle(req, res)).catch(() => reply(res, 503, { error: SHUTTING_DOWN }));
  });
  // Never keep idle sockets open forever.
  server.requestTimeout = 60000;
  server.headersTimeout = 65000;

  function bind(port, host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        // From now on a server error (e.g. EMFILE on accept) is logged; with no listener it would crash the process.
        server.on('error', (err) => log(`Gateway server error: ${err?.code ?? err?.name ?? 'Error'}`));
        resolve();
      });
    });
  }

  function release() {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  /**
   * Bind the Port, load the Account pool, and serve. Resolves with the bound { port, url }. Rejects with the Port
   * released and nothing written when the Port is taken, the Account pool cannot load or save, or stop() began.
   */
  function start({ port = config.gateway.port, host = config.gateway.host, unref = false } = {}) {
    if (!gate.open) return Promise.reject(shuttingDown());
    starting ??= (async () => {
      await bind(port, host);
      try {
        if (!gate.open) throw shuttingDown();
        serving = assemble();
      } catch (err) {
        await release();
        throw err;
      }
      if (config.reconcileIntervalMs) {
        timer = setInterval(() => { gate.run(() => serving.balanceChecks.run()).catch(() => {}); }, config.reconcileIntervalMs);
        timer.unref();
      }
      if (unref) server.unref();
      const bound = { host, port: server.address().port };
      return { port: bound.port, url: baseUrl({ gateway: bound }) };
    })();
    return starting;
  }

  /**
   * Stop for good, in this order: refuse new work, cancel balance checks (report-only), let in-flight work settle
   * (Brokered requests must end their Reservations), release the Port. Calling it again returns the same promise.
   */
  function stop() {
    stopping ??= (async () => {
      const settled = gate.close();
      cancelChecks.abort();
      clearInterval(timer);
      await starting?.catch(() => {}); // a start in progress sees the closed gate and releases the Port itself
      await settled;
      await release();
    })();
    return stopping;
  }

  return { start, stop, control };
}
