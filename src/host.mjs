// Process-wide broker host used by the pi extension.
//
// Why this exists (docs/research/pi-extensions.md §3.3): pi loads an extension once per session, in-process
// subagents load it again inside the same process, and every terminal is another process. So:
//  - one host object per process (globalThis singleton survives /reload re-imports), reference-counted
//    by session_start / session_shutdown;
//  - one gateway owner per machine (the fixed loopback port); other processes act as clients;
//  - a client takes over the port when the owner exits (ensure() is called before each search tool call).
import { createGateway } from './gateway.mjs';
import { fileStore } from './pool/store.mjs';
import { VERSION, TOKEN_ENV, defaultConfigPath, defaultStatePath, loadConfig } from './config.mjs';
import { baseUrl, probeHealth, connectControl } from './control.mjs';
import { piWebSearchConfigPath, readPiWebSearchConfig, piWiringIssues } from './doctor.mjs';

const HOST_KEY = Symbol.for('pi-search-broker.host');
const PROBE_CACHE_MS = 3000;

export class BrokerHost {
  // Latest zero-reference cleanup, chained after any earlier cleanup.
  #releasing = null;

  /**
   * Everything the host creates (the gateway, its upstream and balance calls, health probes) uses these.
   * @param store  account pool store for an owned gateway (default: pool-state.json next to the config)
   */
  constructor({ configPath = defaultConfigPath(), env = process.env, fetchImpl = fetch, now = () => Date.now(), store = null, logger = null } = {}) {
    this.version = VERSION;
    this.configPath = configPath;
    this.statePath = defaultStatePath(configPath);
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.store = store;
    this.logger = logger;
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
        ? `No broker config at ${this.configPath}. Run "npm run init" in the pi-search-broker folder and add accounts, then /reload.`
        : `Broker config error: ${err.message}`;
      return null;
    }
  }

  async acquire() {
    const first = ++this.refs === 1;
    if (this.#releasing) await this.#releasing;
    if (this.refs === 0) return this.mode; // This session was released while cleanup was pending.
    if (first) {
      if (!this.loadConfig()) return this.mode;
      this.wireEnvironment();
    }
    await this.ensure();
    return this.mode;
  }

  /** At zero references: stop serving, restore the environment, and forget the config (pi /reload re-reads it). */
  async release() {
    if (this.refs === 0) return;
    this.refs--;
    if (this.refs > 0) return;
    const previous = this.#releasing;
    const releasing = (async () => {
      if (previous) await previous;
      if (this.ensuring) await this.ensuring;
      await this.stopServer();
      this.restoreEnvironment();
      this.config = null;
      this.mode = 'idle';
    })();
    this.#releasing = releasing;
    try {
      await releasing;
    } finally {
      if (this.#releasing === releasing) this.#releasing = null;
    }
  }

  /** While sessions hold the host, make sure some process serves the gateway; take over if nobody does. */
  ensure() {
    if (this.refs === 0) return Promise.resolve(this.mode); // A late tool call must not resurrect a released host.
    if (this.#releasing) return this.#releasing.then(() => this.ensure());
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.#ensure().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  async #ensure() {
    const config = this.loadConfig();
    if (!config) return this.mode;
    if (this.mode === 'owner' && this.gateway?.server.listening) return this.mode;
    if (this.mode === 'client' && this.now() - this.lastProbeOk < PROBE_CACHE_MS) return this.mode;
    if (await this.probe()) { this.mode = 'client'; return this.mode; }
    if (this.refs === 0) return this.mode;
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
    const ok = (await probeHealth(this.config, { fetchImpl: this.fetchImpl })).state === 'running';
    if (ok) this.lastProbeOk = this.now();
    return ok;
  }

  listen(config) {
    const gateway = createGateway(config, {
      store: this.store ?? fileStore(this.statePath), fetchImpl: this.fetchImpl, reconcileFetch: this.fetchImpl,
      now: this.now, logger: this.logger
    });
    return new Promise((resolve, reject) => {
      const onError = (err) => { gateway.shutdown().catch(() => {}); reject(err); };
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
    if (!gateway) return;
    await gateway.shutdown();
    if (this.gateway === gateway) this.gateway = null;
  }

  /**
   * Point pi-web-access at the gateway for this process: EXA_BASE_URL / TAVILY_BASE_URL (env wins over
   * web-search.json and is read per request) and PI_SEARCH_BROKER_TOKEN (for "exaApiKey": "$PI_SEARCH_BROKER_TOKEN").
   * Provider keys are never overridden; problems are reported as notes instead.
   * Child processes spawned by pi (e.g. bash tool calls) inherit these values.
   */
  wireEnvironment() {
    if (!this.config?.pi.wireEnvironment || this.savedEnv) return;
    const base = baseUrl(this.config);
    const wanted = { EXA_BASE_URL: `${base}/exa`, TAVILY_BASE_URL: `${base}/tavily`, [TOKEN_ENV]: this.config.gateway.token };
    this.savedEnv = Object.fromEntries(Object.keys(wanted).map((name) => [name, this.env[name]]));
    const overridden = ['EXA_BASE_URL', 'TAVILY_BASE_URL'].filter((n) => this.savedEnv[n] !== undefined && this.savedEnv[n] !== wanted[n]);
    Object.assign(this.env, wanted);
    if (overridden.length) this.notes.push(`Search broker overrides ${overridden.join(', ')} in this pi process.`);
    try {
      const pi = readPiWebSearchConfig(piWebSearchConfigPath(this.env));
      for (const issue of piWiringIssues(pi, this.env, this.config.gateway.token)) this.notes.push(`Search broker: ${issue.message}`);
    } catch {
      this.notes.push('Search broker: pi-web-access web-search.json is not valid JSON.');
    }
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

  /**
   * Broker control for this process: in-process when it owns the gateway, HTTP when another process does, offline
   * (read-only) when nobody does. Throws when there is no usable config.
   */
  async control() {
    if (!this.config) throw new Error(this.lastError || 'Broker is not configured');
    return connectControl({ config: this.config, statePath: this.statePath, inProcess: this.gateway?.control, fetchImpl: this.fetchImpl });
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
