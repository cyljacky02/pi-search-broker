// Process-wide broker host used by the pi extension.
//
// Why this exists (docs/research/pi-extensions.md §3.3): pi loads an extension once per session, in-process
// subagents load it again inside the same process, and every terminal is another process. So:
//  - one host object per process (globalThis singleton survives /reload re-imports), reference-counted
//    by session_start / session_shutdown;
//  - one gateway owner per machine (the fixed loopback port); other processes act as clients;
//  - a client takes over the port when the owner exits (ensure() is called before each search tool call).
import { createGateway } from './gateway.mjs';
import { APP_NAME, VERSION, TOKEN_ENV, defaultConfigPath, defaultStatePath, loadConfig } from './config.mjs';

const HOST_KEY = Symbol.for('pi-search-broker.host');
const PROBE_CACHE_MS = 3000;
const POOL_VARS = Array.from({ length: 20 }, (_, i) => `TAVILY_API_KEY_${i + 1}`);

export function baseUrl(config) {
  const h = config.gateway.host === 'localhost' ? '127.0.0.1' : config.gateway.host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${config.gateway.port}`;
}

export class BrokerHost {
  constructor({ configPath = defaultConfigPath(), env = process.env, fetchImpl = fetch, logger = null, gatewayOptions = {} } = {}) {
    this.version = VERSION;
    this.configPath = configPath;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.gatewayOptions = gatewayOptions;
    this.refs = 0;
    this.mode = 'idle'; // idle | unconfigured | owner | client | error
    this.config = null;
    this.gateway = null;
    this.lastError = null;
    this.savedEnv = null;
    this.notes = [];
    this.lastProbeOk = 0;
    this.ensuring = null;
  }

  loadConfig() {
    if (this.config) return this.config;
    try {
      this.config = loadConfig(this.configPath, { env: this.env });
      return this.config;
    } catch (err) {
      this.mode = 'unconfigured';
      this.lastError = err.code === 'ENOCONFIG'
        ? `No broker config at ${this.configPath}. Run "/broker init" (or "npm run init") and add accounts.`
        : `Broker config error: ${err.message}`;
      return null;
    }
  }

  async acquire() {
    this.refs++;
    if (this.refs === 1) {
      if (!this.loadConfig()) return this.mode;
      this.wireEnvironment();
    }
    await this.ensure();
    return this.mode;
  }

  async release() {
    if (this.refs === 0) return;
    this.refs--;
    if (this.refs > 0) return;
    await this.stopServer();
    this.restoreEnvironment();
    this.mode = 'idle';
  }

  /** Re-read config (e.g. after /broker init or editing accounts). Only meaningful when this process owns the gateway. */
  async reload() {
    await this.stopServer();
    this.restoreEnvironment();
    this.config = null;
    this.mode = 'idle';
    this.lastError = null;
    if (!this.loadConfig()) return this.mode;
    if (this.refs > 0) this.wireEnvironment();
    await this.ensure();
    return this.mode;
  }

  /** Make sure some process serves the gateway; become the owner if nobody does. */
  ensure() {
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.#ensure().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  async #ensure() {
    const config = this.loadConfig();
    if (!config) return this.mode;
    if (this.mode === 'owner' && this.gateway?.server.listening) return this.mode;
    if (this.mode === 'client' && Date.now() - this.lastProbeOk < PROBE_CACHE_MS) return this.mode;
    if (await this.probe()) { this.mode = 'client'; return this.mode; }
    try {
      await this.listen(config);
      this.mode = 'owner';
      this.lastError = null;
    } catch (err) {
      if (err.code === 'EADDRINUSE' && await this.probe()) { this.mode = 'client'; return this.mode; }
      this.mode = 'error';
      this.lastError = err.code === 'EADDRINUSE'
        ? `Port ${config.gateway.port} is used by another program (not the broker). Change gateway.port.`
        : `Could not start the broker gateway: ${err.message}`;
    }
    return this.mode;
  }

  async probe() {
    try {
      const res = await this.fetchImpl(`${baseUrl(this.config)}/health`, { signal: AbortSignal.timeout(1500) });
      const data = res.ok ? await res.json() : null;
      const ok = data?.service === APP_NAME;
      if (ok) this.lastProbeOk = Date.now();
      return ok;
    } catch {
      return false;
    }
  }

  listen(config) {
    const gateway = createGateway(config, { statePath: defaultStatePath(this.configPath), logger: this.logger, ...this.gatewayOptions });
    return new Promise((resolve, reject) => {
      const onError = (err) => { gateway.server.close(); reject(err); };
      gateway.server.once('error', onError);
      gateway.server.listen(config.gateway.port, config.gateway.host, () => {
        gateway.server.off('error', onError);
        gateway.server.unref(); // never keep pi alive
        this.gateway = gateway;
        resolve();
      });
    });
  }

  async stopServer() {
    const gateway = this.gateway;
    this.gateway = null;
    if (!gateway) return;
    gateway.reconciler.stop();
    await new Promise((resolve) => {
      gateway.server.close(() => resolve());
      gateway.server.closeAllConnections?.();
    });
  }

  /**
   * Point pi-web-access at the gateway for this process (env vars win over web-search.json and are read per request):
   * EXA_BASE_URL / TAVILY_BASE_URL -> gateway; EXA_API_KEY / TAVILY_API_KEY / PI_SEARCH_BROKER_TOKEN -> token
   * (a plain-literal or missing key in web-search.json then resolves to the token); TAVILY_API_KEY_n are removed
   * because pi-web-access would otherwise send real keys to the gateway first.
   * Note: child processes spawned by pi (e.g. bash tool calls) inherit these values.
   */
  wireEnvironment() {
    if (!this.config?.pi.wireEnvironment || this.savedEnv) return;
    const base = baseUrl(this.config);
    const token = this.config.gateway.token;
    const wanted = {
      EXA_BASE_URL: `${base}/exa`, TAVILY_BASE_URL: `${base}/tavily`,
      EXA_API_KEY: token, TAVILY_API_KEY: token, [TOKEN_ENV]: token
    };
    const saved = {};
    for (const name of [...Object.keys(wanted), ...POOL_VARS]) saved[name] = this.env[name];
    this.savedEnv = saved;
    const overridden = ['EXA_BASE_URL', 'TAVILY_BASE_URL', 'EXA_API_KEY', 'TAVILY_API_KEY']
      .filter((name) => saved[name] !== undefined && saved[name] !== wanted[name]);
    const pool = POOL_VARS.filter((name) => saved[name] !== undefined);
    Object.assign(this.env, wanted);
    for (const name of pool) delete this.env[name];
    if (overridden.length) this.notes.push(`Search broker overrides ${overridden.join(', ')} in this pi process.`);
    if (pool.length) this.notes.push(`Search broker removed ${pool.length} TAVILY_API_KEY_n variable(s) from this pi process so real keys are not sent to the gateway.`);
  }

  restoreEnvironment() {
    if (!this.savedEnv) return;
    for (const [name, value] of Object.entries(this.savedEnv)) {
      if (value === undefined) delete this.env[name];
      else this.env[name] = value;
    }
    this.savedEnv = null;
  }

  takeNotes() {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  async request(method, path, body) {
    const res = await this.fetchImpl(`${baseUrl(this.config)}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.config.gateway.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Broker request failed: HTTP ${res.status}`);
    return data;
  }

  async status() {
    if (this.mode === 'owner' && this.gateway) return this.gateway.manager.snapshot();
    if (this.mode === 'client') return this.request('GET', '/status');
    throw new Error(this.lastError || 'Broker is not running');
  }

  async admin(op, body) {
    if (this.mode === 'owner' && this.gateway) {
      if (op === 'reconcile') return { ok: true, results: await this.gateway.reconciler.reconcile(body.id) };
      this.gateway.manager.change(body.id, op, body);
      return { ok: true };
    }
    if (this.mode === 'client') return this.request('POST', `/admin/${op}`, body);
    throw new Error(this.lastError || 'Broker is not running');
  }
}

/** The per-process host. A newer module version replaces an idle older host after /reload. */
export function getHost(options) {
  const existing = globalThis[HOST_KEY];
  if (existing && (existing.version === VERSION || existing.refs > 0)) return existing;
  const host = new BrokerHost(options);
  globalThis[HOST_KEY] = host;
  return host;
}

/** Test helper: forget the process singleton. */
export function resetHost() { delete globalThis[HOST_KEY]; }
