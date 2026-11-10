import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createAccountPool, StateNotSaved } from './pool.mjs';
import { memoryStore } from './pool/store.mjs';
import { SERVICE_NAME, VERSION, TOKEN_ENV, secretsOf, resolveAccountCredentials, isPlaceholderSource } from './config.mjs';
import { noKeyFolder } from './keys.mjs';
import { ROUTES, redact } from './providers.mjs';
import { createBalanceChecks } from './reconcile.mjs';
import { createBroker, CLIENT_CLOSED } from './broker.mjs';
import { baseUrl, serveAdmin } from './control.mjs';
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

/**
 * Every Account a starting Gateway serves: config.json Accounts with resolved credentials, then key-file Accounts.
 * A key-file key already used in config.json is skipped. Once key files add an Account, placeholder Accounts in
 * config.json are left out (`placeholders`); otherwise they still fail credential checks. Records the key-file Accounts
 * in the key index, and throws ENOACCOUNTS when there is nothing to serve.
 * Returns { accounts, placeholders, notes } (notes are key-free).
 */
function accountsToServe(config, keyFolder, secretOptions) {
  const files = keyFolder.read();
  const candidates = files.accounts.length ? config.accounts.filter((a) => isPlaceholderSource(a.apiKey)).map((a) => a.id) : [];
  const fromConfig = resolveAccountCredentials({ ...config, accounts: config.accounts.filter((a) => !candidates.includes(a.id)) }, secretOptions).accounts;
  const owners = new Map(fromConfig.map((a) => [a.apiKey, a.id]));
  const ids = new Set(fromConfig.map((a) => a.id));
  const notes = [...files.warnings];
  const fromKeyFiles = [];
  for (const account of files.accounts) {
    const origin = files.origins.get(account.id);
    if (owners.has(account.apiKey)) notes.push(`${origin} skipped: its key is already used by ${owners.get(account.apiKey)} in config.json`);
    else if (ids.has(account.id)) notes.push(`${origin} skipped: config.json already has an Account named ${account.id}`);
    else fromKeyFiles.push(account);
  }
  // Placeholders are only replaced by key-file Accounts that are actually served; else they fail as before.
  if (candidates.length && !fromKeyFiles.length) resolveAccountCredentials(config, secretOptions);
  const accounts = [...fromConfig, ...fromKeyFiles];
  if (!accounts.length) {
    notes.push(...keyFolder.saveIndex([]));
    const where = keyFolder.dir ? ` in ${keyFolder.dir} (exa.txt, tavily.txt)` : ' to config.json';
    throw Object.assign(new Error(`No search Accounts yet: put your API keys${where}, one per line, then /reload in pi (or restart the standalone gateway)`), { code: 'ENOACCOUNTS' });
  }
  notes.push(...keyFolder.saveIndex(fromKeyFiles));
  return { accounts, placeholders: candidates, notes };
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
 *   start({ port?, host?, unref? }) -> { port, url, notes }
 *                                                    bind the Port, read key files and resolve credentials, load the
 *                                                    Account pool and serve; notes are key-free messages for the user
 *   stop()                                           refuse new work, cancel balance checks, let in-flight work
 *                                                    settle, release the Port
 *   control                                          broker control for this process (see control.mjs)
 *
 * @param store           account pool state store (default: in memory; the host and CLI pass a fileStore)
 * @param reconcileFetch  fetch for provider balance endpoints (default: the real fetch)
 * @param clock           { now, sleep, timeout } (see clock.mjs) for everything the Gateway builds
 * @param secretOptions   environment and command runner for Account credentials, resolved only after binding the Port
 * @param keyFolder       key files to read after binding the Port (keys.mjs keyFolderAt; default: none)
 * @param logger          optional (line) => void
 */
export function createGateway(config, {
  store = memoryStore(), fetchImpl = fetch, reconcileFetch = fetch, clock = realClock, secretOptions = {}, keyFolder = noKeyFolder, logger = null
} = {}) {
  const log = quietLogger(logger);
  const now = () => clock.now(); // called through the clock, so an adapter's methods may rely on `this`
  const gate = createGate();
  const cancelChecks = new AbortController(); // balance checks are report-only, so stopping cancels them
  let serving = null; // what the Gateway runs once it owns the Port: { pool, broker, balanceChecks }
  let timer = null;
  let starting = null;
  let stopping = null;

  // Read key files, resolve credentials and construct the writing Account pool only after the Port is bound.
  function assemble() {
    const { accounts, placeholders, notes } = accountsToServe(config, keyFolder, secretOptions);
    const secrets = secretsOf({ ...config, accounts });
    try {
      const pool = createAccountPool(accounts, { store, now, logger });
      const balanceChecks = createBalanceChecks({ accounts, pool, fetchImpl: reconcileFetch, now, signal: cancelChecks.signal });
      const broker = createBroker({ pool, limits: config, secrets, fetchImpl, clock });
      // The Account pool loaded and saved: only now do placeholders leave config.json for good.
      notes.push(...keyFolder.removePlaceholders(placeholders));
      return { pool, broker, balanceChecks, notes };
    } catch (err) {
      // Only the Gateway holds resolved credentials; callers cannot redact them after a startup failure.
      if (err instanceof Error) {
        err.message = redact(err.message, secrets);
        err.stack = redact(err.stack, secrets);
      }
      throw err;
    }
  }

  /** Run a broker-control task once the Gateway serves; refuse it before that, and once it stops. */
  function admitted(task) {
    if (!serving) return Promise.reject(gate.open ? new Error('Gateway has not acquired the Port') : shuttingDown());
    return gate.run(task);
  }

  // The in-process adapter of broker control (the interface is in control.mjs). health() never rejects: a stopping
  // Gateway is reported the way the HTTP adapter sees a draining Port owner.
  const control = Object.freeze({
    mode: 'in-process',
    async health() {
      if (!serving || !server.listening) return { state: 'down' };
      return { state: 'running', version: VERSION, control: gate.open ? 'ready' : 'unavailable' };
    },
    status: () => admitted(() => serving.pool.snapshot()),
    enable: (id) => admitted(() => serving.pool.enable(id)),
    disable: (id) => admitted(() => serving.pool.disable(id)),
    setSpent: (id, allocationId, amount) => admitted(() => serving.pool.setSpent(id, allocationId, amount)),
    reconcile: (id) => admitted(() => serving.balanceChecks.run(id))
  });

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
    // Admit before any asynchronous step: stop() waits for this request even if its socket closes. The gate is open
    // in this tick, so a rejection here can only be handle() itself failing.
    gate.run(() => handle(req, res)).catch((err) => {
      log(`internal error: ${err?.name ?? 'Error'}`);
      reply(res, 500, { error: 'Gateway internal error; inspect local logs' });
    });
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
   * Bind the Port, read key files and resolve all Account credentials, load the Account pool, and serve. Resolves with
   * the bound { port, url, notes }. Rejects with the Port released when the Port is taken,
   * credentials cannot resolve or validate, there are no Accounts at all (ENOACCOUNTS: the key index is then emptied),
   * the Account pool cannot load or save, or stop() began. Account pool state is never written on failure.
   * A Gateway serves once: a second call returns the first call's promise (its options are ignored).
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
      return { port: bound.port, url: baseUrl({ gateway: bound }), notes: serving.notes };
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
