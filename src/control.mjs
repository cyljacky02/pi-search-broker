// Broker control: inspect and change the broker from the CLI, the pi extension and doctor, whoever owns the gateway.
// One interface, three adapters:
//   in-process  this process owns the gateway (pi extension owner, tests)
//   http        another process owns it; authenticated loopback HTTP
//   offline     nobody runs it; status is read from the state file, and changes are refused so that only the running
//               gateway ever writes account state
// Every adapter: { mode, health(), status(), enable(id), disable(id), setSpent(id, allocationId, amount), reconcile(id?) }
// health() -> { state: 'running', version } | { state: 'other' } (something else owns the port) | { state: 'down' }
// HTTP health also reports control: 'ready' | 'unauthorized' | 'unavailable' when the Broker is identified.
import { SERVICE_NAME, LEGACY_SERVICE_NAMES, VERSION } from './config.mjs';
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
    const ours = data?.service === SERVICE_NAME || LEGACY_SERVICE_NAMES.includes(data?.service);
    return ours ? { state: 'running', version: data.version ?? null } : { state: 'other' };
  } catch {
    return { state: 'down' };
  }
}

/**
 * The HTTP wire format for the control methods that change things: POST /admin/<op> with a JSON body.
 * Shared by the gateway (serveAdmin) and the http adapter, so the two cannot drift apart.
 */
const WIRE = Object.freeze({
  enable: { op: 'enable', body: (id) => ({ id }), call: (control, b) => control.enable(b.id) },
  disable: { op: 'disable', body: (id) => ({ id }), call: (control, b) => control.disable(b.id) },
  setSpent: {
    op: 'set-spent',
    body: (id, allocationId, amount) => ({ id, allocationId, spent: amount }),
    call: (control, b) => control.setSpent(b.id, b.allocationId, b.spent)
  },
  reconcile: { op: 'reconcile', body: (id) => (id ? { id } : {}), call: (control, b) => control.reconcile(b.id) }
});
const WIRE_BY_OP = new Map(Object.values(WIRE).map((w) => [w.op, w]));

/** Gateway side of the wire format: run POST /admin/<op> against a control. Reconcile replies { ok, results }. */
export async function serveAdmin(control, op, body) {
  const wire = WIRE_BY_OP.get(op);
  if (!wire) throw new Error('Unknown operation');
  if (op === 'reconcile') {
    if (body.id !== undefined && typeof body.id !== 'string') throw new Error('id must be a string');
  } else if (typeof body.id !== 'string') throw new Error('Account id required');
  const results = await wire.call(control, body);
  return results === undefined ? { ok: true } : { ok: true, results };
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
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gateway request failed: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
    return data;
  }
  async function health() {
    const identity = await probeHealth(config, { fetchImpl });
    if (identity.state !== 'running') return identity;
    try {
      // /health establishes port ownership only; /status requires the Gateway token. Never follow redirects with it.
      const res = await fetchImpl(`${baseUrl(config)}/status`, {
        headers: { authorization: `Bearer ${config.gateway.token}` },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'error'
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ...identity, control: res.status === 401 ? 'unauthorized' : 'unavailable' };
      }
      const status = await res.json();
      return { ...identity, control: Array.isArray(status?.accounts) ? 'ready' : 'unavailable' };
    } catch {
      return { ...identity, control: 'unavailable' };
    }
  }
  const changes = Object.fromEntries(Object.entries(WIRE).map(([method, wire]) => [
    method, async (...args) => (await request('POST', `/admin/${wire.op}`, wire.body(...args))).results
  ]));
  return {
    mode: 'http',
    health,
    status: () => request('GET', '/status'),
    ...changes
  };
}

export function offlineControl(config, { statePath, fetchImpl = fetch }) {
  const refuse = async () => { throw new Error('The broker gateway is not running. Start pi with the extension installed, or run "npm start".'); };
  return {
    mode: 'offline',
    // Re-probe identity; if a Broker appears later, this adapter remains offline until the caller reconnects.
    health: () => probeHealth(config, { fetchImpl }),
    status: async () => createAccountPool(config.accounts, { store: fileStore(statePath, { readOnly: true }) }).snapshot(),
    enable: refuse, disable: refuse, setSpent: refuse, reconcile: refuse
  };
}

/**
 * The right control for this process: `inProcess` when it owns the gateway (pass that gateway's control), else HTTP
 * when a broker answers on the port, else offline (read-only status from `statePath`).
 */
export async function connectControl({ config, statePath, inProcess = null, fetchImpl = fetch }) {
  if (inProcess) return inProcess;
  if ((await probeHealth(config, { fetchImpl })).state === 'running') return httpControl(config, { fetchImpl });
  return offlineControl(config, { statePath, fetchImpl });
}
