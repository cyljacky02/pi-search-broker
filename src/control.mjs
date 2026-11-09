// Broker control: inspect and change the broker from the CLI, the pi extension and doctor, whoever owns the gateway.
// One interface, three adapters:
//   in-process  this process owns the gateway (pi extension owner, tests)
//   http        another process owns it; authenticated loopback HTTP
//   offline     nobody runs it; status is read from state.json, and changes are refused so that only the running
//               gateway ever writes account state
// Every adapter: { mode, health(), status(), enable(id), disable(id), setSpent(id, allocationId, amount), reconcile(id?) }
// health() -> { state: 'running', version } | { state: 'other' } (something else owns the port) | { state: 'down' }
import { APP_NAME, VERSION } from './config.mjs';
import { createAccountPool } from './pool.mjs';
import { fileStore } from './pool/store.mjs';

const HEALTH_TIMEOUT_MS = 1500;

/** Loopback base URL of the gateway (validateConfig already turned "localhost" into 127.0.0.1). */
export function baseUrl(config) {
  const { host } = config.gateway;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.gateway.port}`;
}

/** Ask whatever listens on the gateway port who it is. Never throws. */
export async function probeHealth(config, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl(config)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const data = res.ok ? await res.json() : null;
    return data?.service === APP_NAME ? { state: 'running', version: data.version ?? null } : { state: 'other' };
  } catch {
    return { state: 'down' };
  }
}

export function inProcessControl({ pool, reconciler }) {
  return {
    mode: 'in-process',
    health: async () => ({ state: 'running', version: VERSION }),
    status: async () => pool.snapshot(),
    enable: async (id) => pool.enable(id),
    disable: async (id) => pool.disable(id),
    setSpent: async (id, allocationId, amount) => pool.setSpent(id, allocationId, amount),
    reconcile: async (id) => reconciler.reconcile(id)
  };
}

export function httpControl(config, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  async function request(method, path, body) {
    const res = await fetchImpl(`${baseUrl(config)}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.gateway.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gateway request failed: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
    return data;
  }
  return {
    mode: 'http',
    health: () => probeHealth(config, { fetchImpl }),
    status: () => request('GET', '/status'),
    enable: async (id) => { await request('POST', '/admin/enable', { id }); },
    disable: async (id) => { await request('POST', '/admin/disable', { id }); },
    setSpent: async (id, allocationId, amount) => { await request('POST', '/admin/set-spent', { id, allocationId, spent: amount }); },
    reconcile: async (id) => (await request('POST', '/admin/reconcile', id ? { id } : {})).results
  };
}

export function offlineControl(config, { statePath }) {
  const refuse = async () => { throw new Error('The broker gateway is not running. Start pi with the extension installed, or run "npm start".'); };
  return {
    mode: 'offline',
    health: async () => ({ state: 'down' }),
    status: async () => createAccountPool(config.accounts, { store: fileStore(statePath, { readOnly: true }) }).snapshot(),
    enable: refuse, disable: refuse, setSpent: refuse, reconcile: refuse
  };
}

/**
 * The right control for this process: in-process when it owns the gateway (`gateway` is that gateway's control),
 * else HTTP when a broker answers on the port, else offline (read-only status from `statePath`).
 */
export async function connectControl({ config, statePath, gateway = null, fetchImpl = fetch }) {
  if (gateway) return gateway;
  if ((await probeHealth(config, { fetchImpl })).state === 'running') return httpControl(config, { fetchImpl });
  return offlineControl(config, { statePath });
}
