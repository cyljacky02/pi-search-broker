// Process-wide broker host used by the pi extension.
//
// Why this exists (docs/research/pi-extensions.md §3.3): pi loads an extension once per session, in-process
// subagents load it again inside the same process, and every terminal is another process. So:
//  - one host object per process (globalThis singleton survives /reload re-imports), reference-counted
//    by session_start / session_shutdown;
//  - one Port owner per machine (the fixed loopback port); other processes are its clients;
//  - a client takes over the port when the owner exits (ensure() is called before each search tool call).
//
// What the host has decided is one view: { role, control, issue, url }
//   role     'owner' | 'client' | 'offline' (nobody serves and this process could not) | 'unconfigured' | 'idle'
//   control  the broker control for that role (in-process / HTTP / offline adapter), null when unconfigured or idle
//   issue    { level: 'warning' | 'error', message } already worded for the user, or null
//   url      the gateway's base URL, null when unconfigured or idle
import { createGateway } from './gateway.mjs';
import { fileStore } from './pool/store.mjs';
import { VERSION, TOKEN_ENV, defaultConfigPath, defaultStatePath, loadConfig, secretsOf } from './config.mjs';
import { redact } from './providers.mjs';
import { baseUrl, httpControl, offlineControl } from './control.mjs';
import { piWebSearchConfigPath, readPiWebSearchConfig, piWiringIssues, gatewayControlIssue, runDoctor } from './doctor.mjs';
import { realClock } from './clock.mjs';

const HOST_KEY = Symbol.for('pi-search-broker.host');
const PROBE_CACHE_MS = 3000;
const IDLE = Object.freeze({ role: 'idle', control: null, issue: null, url: null });

export class BrokerHost {
  #configPath;
  #statePath;
  #env;
  #fetchImpl;
  #now;
  #store;
  #logger;
  #config = null;
  #view = IDLE;
  #gateway = null;      // this process's Gateway while it is the Port owner
  #checkedAt = 0;       // when a client last saw the Port owner answer
  #ensuring = null;
  #releasing = null;    // latest zero-reference cleanup, chained after any earlier cleanup
  #savedEnv = null;
  #notes = [];

  /**
   * Everything the host creates (the gateway, its upstream and balance calls, health probes) uses these.
   * @param store  account pool store for an owned gateway (default: pool-state.json next to the config)
   */
  constructor({ configPath = defaultConfigPath(), env = process.env, fetchImpl = fetch, now = () => Date.now(), store = null, logger = null } = {}) {
    // getHost() reads these two on host objects from any module version, so they stay public.
    this.version = VERSION;
    this.refs = 0;
    this.#configPath = configPath;
    this.#statePath = defaultStatePath(configPath);
    this.#env = env;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#store = store;
    this.#logger = logger;
  }

  /** The latest decision, without looking at the port again. */
  get view() { return this.#view; }

  /** A session starts using the broker: the first one loads the config and wires pi's environment. Resolves the view. */
  async acquire() {
    const first = ++this.refs === 1;
    if (this.#releasing) await this.#releasing;
    if (this.refs === 0) return this.#view; // This session was released while cleanup was pending.
    if (first) {
      if (!this.#loadConfig()) return this.#view;
      this.#wireEnvironment();
    }
    return this.ensure();
  }

  /** At zero references: stop serving, restore the environment, and forget the config (pi /reload re-reads it). */
  async release() {
    if (this.refs === 0) return;
    this.refs--;
    if (this.refs > 0) return;
    const previous = this.#releasing;
    const releasing = (async () => {
      if (previous) await previous;
      if (this.#ensuring) await this.#ensuring;
      await this.#stopGateway();
      this.#restoreEnvironment();
      this.#config = null;
      this.#view = IDLE;
    })();
    this.#releasing = releasing;
    try {
      await releasing;
    } finally {
      if (this.#releasing === releasing) this.#releasing = null;
    }
  }

  /** While sessions hold the host, make sure some process serves the gateway, taking over if nobody does. Resolves the view. */
  ensure() {
    if (this.refs === 0) return Promise.resolve(IDLE); // A late tool call must not resurrect a released host.
    if (this.#releasing) return this.#releasing.then(() => this.ensure());
    if (this.#ensuring) return this.#ensuring;
    this.#ensuring = this.#ensure().then(() => this.#view).finally(() => { this.#ensuring = null; });
    return this.#ensuring;
  }

  takeNotes() {
    const notes = this.#notes;
    this.#notes = [];
    return notes;
  }

  /** Inspect wiring and Gateway access without starting a Gateway or resolving Account credentials. */
  async doctor() {
    let config;
    try { config = this.#config ?? loadConfig(this.#configPath); }
    catch (err) { return runDoctor({ configError: err.message }); }
    const control = this.#gateway?.control ?? httpControl(config, { fetchImpl: this.#fetchImpl });
    return runDoctor({ config, control, env: this.#env });
  }

  #loadConfig() {
    if (this.#config) return this.#config;
    try {
      this.#config = loadConfig(this.#configPath);
      return this.#config;
    } catch (err) {
      const message = err.code === 'ENOCONFIG'
        ? `No broker config at ${this.#configPath}. Run "npm run init" in the pi-search-broker folder and add accounts, then /reload.`
        : `Broker config error: ${err.message}`;
      this.#view = Object.freeze({ role: 'unconfigured', control: null, issue: { level: 'warning', message }, url: null });
      return null;
    }
  }

  #decide(role, control, issue = null) {
    this.#view = Object.freeze({ role, control, issue, url: baseUrl(this.#config) });
  }

  // One look at the port decides the role, and the control chosen with it is the one everybody uses.
  async #ensure() {
    const config = this.#loadConfig();
    if (!config) return;
    if (this.#view.role === 'owner' && this.#gateway) return;
    if (this.#view.role === 'client' && this.#now() - this.#checkedAt < PROBE_CACHE_MS) return;
    const remote = httpControl(config, { fetchImpl: this.#fetchImpl });
    if (await this.#join(remote)) return;
    if (this.refs === 0) return;
    try {
      await this.#listen(config);
      this.#decide('owner', this.#gateway.control);
    } catch (err) {
      if (err.code === 'EADDRINUSE' && await this.#join(remote)) return;
      this.#decide('offline', offlineControl(config, { statePath: this.#statePath, fetchImpl: this.#fetchImpl }), {
        level: 'error',
        message: err.code === 'EADDRINUSE'
          ? `Port ${config.gateway.port} is used by another program (not the broker). Change gateway.port.`
          : `Could not start the broker gateway: ${redact(err.message, secretsOf(config))}`
      });
    }
  }

  /**
   * Become a client if a Broker answers on the port. Its health also says whether this process can control it
   * (/health identifies the Port owner without credentials; only an identified Broker sees the Gateway token).
   */
  async #join(remote) {
    const health = await remote.health();
    if (health.state !== 'running') return false;
    this.#checkedAt = this.#now();
    const issue = gatewayControlIssue(health, baseUrl(this.#config), remote.mode);
    this.#decide('client', remote, issue ? { level: 'warning', message: `Search broker: ${issue}` } : null);
    return true;
  }

  /** Become the Port owner. On failure the Gateway has already released the Port and written nothing. */
  async #listen(config) {
    const gateway = createGateway(config, {
      store: this.#store ?? fileStore(this.#statePath), fetchImpl: this.#fetchImpl, reconcileFetch: this.#fetchImpl,
      clock: { ...realClock, now: this.#now }, secretOptions: { env: this.#env }, logger: this.#logger
    });
    await gateway.start({ unref: true }); // never keep pi alive
    this.#gateway = gateway;
  }

  async #stopGateway() {
    const gateway = this.#gateway;
    if (!gateway) return;
    await gateway.stop();
    if (this.#gateway === gateway) this.#gateway = null;
  }

  /**
   * Point pi-web-access at the gateway for this process: EXA_BASE_URL / TAVILY_BASE_URL (env wins over
   * web-search.json and is read per request) and PI_SEARCH_BROKER_TOKEN (for "exaApiKey": "$PI_SEARCH_BROKER_TOKEN").
   * Provider keys are never overridden; problems are reported as notes instead.
   * Child processes spawned by pi (e.g. bash tool calls) inherit these values.
   */
  #wireEnvironment() {
    if (!this.#config?.pi.wireEnvironment || this.#savedEnv) return;
    const base = baseUrl(this.#config);
    const wanted = { EXA_BASE_URL: `${base}/exa`, TAVILY_BASE_URL: `${base}/tavily`, [TOKEN_ENV]: this.#config.gateway.token };
    this.#savedEnv = Object.fromEntries(Object.keys(wanted).map((name) => [name, this.#env[name]]));
    const overridden = ['EXA_BASE_URL', 'TAVILY_BASE_URL'].filter((n) => this.#savedEnv[n] !== undefined && this.#savedEnv[n] !== wanted[n]);
    Object.assign(this.#env, wanted);
    if (overridden.length) this.#notes.push(`Search broker overrides ${overridden.join(', ')} in this pi process.`);
    try {
      const pi = readPiWebSearchConfig(piWebSearchConfigPath(this.#env));
      for (const issue of piWiringIssues(pi, this.#env, this.#config.gateway.token)) this.#notes.push(`Search broker: ${issue.message}`);
    } catch {
      this.#notes.push('Search broker: pi-web-access web-search.json is not valid JSON.');
    }
  }

  #restoreEnvironment() {
    if (!this.#savedEnv) return;
    for (const [name, value] of Object.entries(this.#savedEnv)) {
      if (value === undefined) delete this.#env[name];
      else this.#env[name] = value;
    }
    this.#savedEnv = null;
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
