import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import diagnostics_channel from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway.mjs';
import { createBroker } from '../src/broker.mjs';
import { createAccountPool } from '../src/pool.mjs';
import { fileStore, memoryStore } from '../src/pool/store.mjs';
import { ROUTES } from '../src/providers.mjs';
import { validateConfig, secretsOf } from '../src/config.mjs';

export const DATE = Date.parse('2026-11-09T06:00:00Z');
export const secret = 'local-only-secret-with-32-chars-12345';

export const exa = (id, key, promoExpiration = '2026-12-03T00:00:00Z') => ({
  id, provider: 'exa', apiKey: key,
  allocations: [{ id: 'promo', limit: 60, period: 'once', expiresAt: promoExpiration }, { id: 'free', limit: 10, period: 'monthly' }]
});
export const tavily = (id, key) => ({ id, provider: 'tavily', apiKey: key, allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] });
export const config = (...accounts) => validateConfig({
  gateway: { host: '127.0.0.1', port: 19473, token: secret },
  totalTimeoutMs: 50000, accounts
});

export const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
/** The key an upstream request was sent with (Exa header or Tavily bearer). */
export const keyOf = (opts) => opts.headers['x-api-key'] ?? opts.headers.Authorization;

/** A store whose saves fail while `writable` is false, with key material in the error a reply must never echo. */
export function flakyStore() {
  const backing = memoryStore();
  const store = {
    writable: true,
    load: () => backing.load(),
    save: (state) => {
      if (!store.writable) throw new Error('disk failure near tvly-secret-key and exa-secret-key');
      backing.save(state);
    }
  };
  return store;
}

/**
 * The tests' clock adapter (src/clock.mjs has the real one). Time moves only when a test moves it: assign `time.ms`,
 * or advance(ms), which also fires every timeout that is due. sleep() records its duration and returns at once.
 */
export function fakeClock(time = { ms: DATE }) {
  const timers = new Set();
  const sleeps = [];
  return {
    time,
    sleeps,
    now: () => time.ms,
    sleep: async (ms) => { sleeps.push(ms); },
    timeout(ms) {
      const controller = new AbortController();
      timers.add({ at: time.ms + ms, controller });
      return controller.signal;
    },
    advance(ms) {
      time.ms += ms;
      for (const timer of [...timers]) {
        if (timer.at > time.ms) continue;
        timers.delete(timer);
        timer.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      }
    }
  };
}

/**
 * A brokered-request harness: no sockets, an in-memory account pool, a fake clock and recorded sleeps.
 * call(localPath, body, {headers, signal}) -> { status, body }; status() -> the /status snapshot.
 */
export function broker(cfg, fetchImpl, { time = { ms: DATE }, store = memoryStore() } = {}) {
  const clock = fakeClock(time);
  const pool = createAccountPool(cfg.accounts, { store, now: clock.now });
  const b = createBroker({ pool, limits: cfg, secrets: secretsOf(cfg), fetchImpl, clock });
  return {
    call: (path, body, options) => b.execute(ROUTES[path], body, options),
    status: () => pool.snapshot(),
    account: (i) => pool.snapshot().accounts[i],
    sleeps: clock.sleeps,
    time,
    clock
  };
}

/** A real gateway on a free loopback port, for HTTP-level concerns only (auth, routing, admin, persistence). */
export async function serve(cfg, fetchImpl, fn, { time = { ms: DATE }, ...extra } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-search-broker-'));
  const statePath = join(temp, 'state.json');
  const gateway = createGateway(cfg, { store: fileStore(statePath), fetchImpl, clock: fakeClock(time), ...extra });
  const { url: base } = await gateway.start({ port: 0 });
  const post = async (path, body, token = secret, headers = {}, signal = undefined) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal
  });
  try { await fn({ base, post, status: gateway.control.status, control: gateway.control, statePath, time }); }
  finally {
    await gateway.stop();
    rmSync(temp, { recursive: true, force: true });
  }
}

/** A loopback port that was free a moment ago (not `avoid`). */
export async function freePort(avoid = null) {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port === avoid ? freePort(avoid) : port;
}

export async function assertPortAvailable(port, message) {
  await assert.doesNotReject(new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  }), message);
}

/**
 * Call fn({ server, request, socket }) whenever an HTTP server on `port` starts handling a request. Uses Node's public
 * diagnostics channel, so tests observe a Gateway without any back door into it. Returns the unsubscribe function.
 */
export function onServerRequest(port, fn) {
  const channel = diagnostics_channel.channel('http.server.request.start');
  const listener = (message) => { if (message.socket.localPort === port) fn(message); };
  channel.subscribe(listener);
  return () => channel.unsubscribe(listener);
}
