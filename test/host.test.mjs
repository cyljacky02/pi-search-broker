import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { BrokerHost } from '../src/host.mjs';
import { createExtension } from '../extension/index.js';
import { runDoctor, describeKey, piWebSearchConfigPath } from '../src/doctor.mjs';
import { loadConfig } from '../src/config.mjs';
import { offlineControl, connectControl } from '../src/control.mjs';
import { memoryStore } from '../src/pool/store.mjs';
import { freePort, assertPortAvailable, onServerRequest } from './helpers.mjs';

const TOKEN = 'local-only-secret-with-32-chars-12345';

function deferHealthProbe() {
  let resume;
  let signal;
  const started = new Promise((resolve) => { signal = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  let paused = false;
  const fetchImpl = async (url, opts) => {
    if (!paused && String(url).endsWith('/health')) {
      paused = true;
      signal();
      await gate;
    }
    return fetch(url, opts);
  };
  return { started, resume, fetchImpl };
}

async function setup(avoidPort = null) {
  const port = await freePort(avoidPort);
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-host-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    gateway: { host: '127.0.0.1', port, token: TOKEN },
    reconcileIntervalMs: 0,
    accounts: [{ id: 'tavily-1', provider: 'tavily', apiKey: 'tvly-aaaaaaaa', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] }]
  }));
  // Hermetic pi-web-access config dir (pi-web-access honours PI_CODING_AGENT_DIR first).
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  return { dir, configPath, port, agentDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('First host owns the port, a second process is a client, and takes over when the owner leaves', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const envA = { PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY_1: 'tvly-real-pool-key', EXA_API_KEY: 'exa-real' };
  const envB = { PI_CODING_AGENT_DIR: agentDir };
  const time = { ms: Date.now() };
  const a = new BrokerHost({ configPath, env: envA, store: memoryStore() });
  const b = new BrokerHost({ configPath, env: envB, store: memoryStore(), now: () => time.ms });
  try {
    assert.equal((await a.acquire()).role, 'owner');
    assert.equal((await b.acquire()).role, 'client');
    // Environment wiring for pi-web-access in each "process".
    assert.equal(envA.EXA_BASE_URL, `http://127.0.0.1:${port}/exa`);
    assert.equal(envA.TAVILY_BASE_URL, `http://127.0.0.1:${port}/tavily`);
    assert.equal(envA.PI_SEARCH_BROKER_TOKEN, TOKEN);
    // Provider keys are never overridden or removed; wiring problems become warnings instead.
    assert.equal(envA.EXA_API_KEY, 'exa-real');
    assert.equal(envA.TAVILY_API_KEY_1, 'tvly-real-pool-key');
    const notes = a.takeNotes().join('\n');
    assert.match(notes, /exa: key from EXA_API_KEY is NOT the broker token.*"exaApiKey": "\$PI_SEARCH_BROKER_TOKEN"/);
    assert.match(notes, /tavily: no key resolves/);
    assert.match(notes, /TAVILY_API_KEY_n/);
    assert.ok(!notes.includes('exa-real') && !notes.includes(TOKEN));
    // The client controls the owner's gateway over HTTP.
    assert.equal(b.view.control.mode, 'http');
    assert.equal((await b.view.control.status()).accounts[0].id, 'tavily-1');
    await b.view.control.disable('tavily-1');
    assert.equal((await a.view.control.status()).accounts[0].status, 'manual');
    await b.view.control.enable('tavily-1');
    // Owner leaves: env restored, port freed; once the client's probe cache expires, it takes over.
    await a.release();
    assert.equal(envA.EXA_BASE_URL, undefined);
    assert.equal(envA.PI_SEARCH_BROKER_TOKEN, undefined);
    assert.equal((await b.ensure()).role, 'client', 'a recent successful probe is trusted for a few seconds');
    time.ms += 5000;
    assert.equal((await b.ensure()).role, 'owner');
    assert.equal(b.view.control.mode, 'in-process');
    assert.equal((await b.view.control.status()).accounts[0].status, 'active');
  } finally {
    await a.release(); await b.release();
    cleanup();
  }
});

test('A client can control the Port owner without credentials but must resolve them before takeover', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const owner = new BrokerHost({ configPath, env: {}, store: memoryStore() });
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const time = { ms: Date.now() };
  const store = memoryStore();
  const seen = [];
  const client = new BrokerHost({ configPath, env, store, now: () => time.ms, fetchImpl: async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1')) return fetch(url, options);
    seen.push(options.headers.Authorization);
    return Response.json({ results: [], usage: { credits: 1 } });
  } });
  try {
    assert.equal((await owner.acquire()).role, 'owner');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.accounts[0].apiKey = '$ACCOUNT_CREDENTIAL';
    writeFileSync(configPath, JSON.stringify(cfg));
    const joined = await client.acquire();
    assert.equal(joined.role, 'client');
    await joined.control.disable('tavily-1');
    assert.equal((await owner.view.control.status()).accounts[0].status, 'manual');
    await joined.control.enable('tavily-1');
    assert.equal(store.load(), null, 'a client never constructs a writing Account pool');

    await owner.release();
    time.ms += 5000;
    const failed = await client.ensure();
    assert.equal(failed.role, 'offline');
    assert.match(failed.issue.message, /ACCOUNT_CREDENTIAL.*empty or unset/);
    assert.equal(store.load(), null, 'failed credential resolution writes no Account pool state');
    assert.equal((await failed.control.status()).accounts[0].id, 'tavily-1', 'offline inspection still works');
    await assertPortAvailable(port, 'failed takeover releases the Port');

    env.ACCOUNT_CREDENTIAL = 'account-secret-without-prefix';
    assert.equal((await client.ensure()).role, 'owner', 'a later takeover retries the current credential source');
    const response = await fetch(`http://127.0.0.1:${port}/tavily/search`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ['Bearer account-secret-without-prefix']);
    assert.equal((await client.view.control.status()).accounts[0].allocations[0].spent, 1);
  } finally {
    await client.release(); await owner.release(); cleanup();
  }
});

test('Doctor on an idle process neither starts a Gateway nor caches configuration for the next session', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const host = new BrokerHost({ configPath, env: { PI_CODING_AGENT_DIR: agentDir }, store: memoryStore() });
  try {
    const checks = await host.doctor();
    assert.ok(checks.some((c) => /Gateway is not running/.test(c.message)));
    assert.equal(host.view.role, 'idle');
    await assertPortAvailable(port);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.accounts[0].id = 'replacement-account';
    writeFileSync(configPath, JSON.stringify(cfg));
    const view = await host.acquire();
    assert.equal(view.role, 'owner');
    assert.equal((await view.control.status()).accounts[0].id, 'replacement-account');
  } finally { await host.release(); cleanup(); }
});

test('A client doctor inspects the Gateway without running credentials or taking over', async () => {
  const { configPath, port, dir, agentDir, cleanup } = await setup();
  writeFileSync(join(agentDir, 'web-search.json'), JSON.stringify({
    exaApiKey: '$PI_SEARCH_BROKER_TOKEN', tavilyApiKey: '$PI_SEARCH_BROKER_TOKEN'
  }));
  const owner = new BrokerHost({ configPath, env: {}, store: memoryStore() });
  const time = { ms: Date.now() };
  const client = new BrokerHost({ configPath, env: { PI_CODING_AGENT_DIR: agentDir }, now: () => time.ms });
  const marker = join(dir, 'credentials-used');
  const script = join(dir, 'credential.cjs');
  writeFileSync(script, `require('node:fs').writeFileSync(process.argv[2], 'used'); process.stdout.write('provider-key-from-command');`);
  try {
    assert.equal((await owner.acquire()).role, 'owner');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.accounts[0].apiKey = `!"${process.execPath}" "${script}" "${marker}"`;
    writeFileSync(configPath, JSON.stringify(cfg));
    assert.equal((await client.acquire()).role, 'client');
    assert.equal(existsSync(marker), false, 'joining does not unlock Account credentials');
    assert.ok((await client.doctor()).some((c) => c.level === 'ok' && /Gateway is running/.test(c.message)));
    await owner.release();
    time.ms += 5000;
    const checks = await client.doctor();
    assert.ok(checks.some((c) => /Gateway is not running/.test(c.message)));
    assert.equal(existsSync(marker), false, 'doctor must not execute a credential command');
    assert.equal(client.view.role, 'client', 'inspection must not change the Port owner decision');
    await assertPortAvailable(port, 'doctor must not start a local Gateway');
  } finally {
    await client.release(); await owner.release(); cleanup();
  }
});

test('A late balance response cannot overwrite spend recorded by a replacement Port owner', async () => {
  const { configPath, port, cleanup } = await setup();
  const store = memoryStore();
  let startBalance;
  let finishBalance;
  let balanceReturned;
  let balanceSignal;
  const started = new Promise((resolve) => { startBalance = resolve; });
  const balanceGate = new Promise((resolve) => { finishBalance = resolve; });
  const returned = new Promise((resolve) => { balanceReturned = resolve; });
  const fetchImpl = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return fetch(url, opts);
    if (String(url).endsWith('/usage')) {
      balanceSignal = opts.signal;
      startBalance();
      await balanceGate; // Deliberately ignore AbortSignal, as an adapter may do.
      balanceReturned();
      return Response.json({ key: { usage: 0, limit: 1000 }, account: {} });
    }
    return Response.json({ results: [], usage: { credits: 1 } });
  };
  const old = new BrokerHost({ configPath, env: {}, store, fetchImpl });
  const replacement = new BrokerHost({ configPath, env: {}, store, fetchImpl });
  let reconcile;
  try {
    assert.equal((await old.acquire()).role, 'owner');
    reconcile = old.view.control.reconcile().then((value) => ({ value }), (error) => ({ error }));
    await started;
    await old.release();
    assert.equal((await replacement.acquire()).role, 'owner');
    const response = await fetch(`http://127.0.0.1:${port}/tavily/search`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
    });
    assert.equal(response.status, 200);
    assert.equal((await replacement.view.control.status()).accounts[0].allocations[0].spent, 1);

    finishBalance();
    await returned;
    await reconcile;
    await new Promise((resolve) => setImmediate(resolve));
    await replacement.release();
    assert.equal((await old.acquire()).role, 'owner');
    assert.equal((await old.view.control.status()).accounts[0].allocations[0].spent, 1, 'the old Account pool must not write after takeover');
    assert.equal(balanceSignal.aborted, true, 'shutdown aborts the obsolete balance request');
  } finally {
    finishBalance();
    await reconcile;
    await old.release();
    await replacement.release();
    cleanup();
  }
});

test('A Port owner drains an in-flight billed search before allowing takeover', async () => {
  const { configPath, port, cleanup } = await setup();
  const store = memoryStore();
  const time = { ms: Date.now() };
  let startSearch;
  let finishSearch;
  let searchCalls = 0;
  const started = new Promise((resolve) => { startSearch = resolve; });
  const searchGate = new Promise((resolve) => { finishSearch = resolve; });
  const fetchImpl = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return fetch(url, opts);
    searchCalls++;
    startSearch();
    await searchGate;
    return Response.json({ results: [], usage: { credits: 2 } });
  };
  const old = new BrokerHost({ configPath, env: {}, store, fetchImpl });
  const replacement = new BrokerHost({ configPath, env: {}, store, fetchImpl, now: () => time.ms });
  const post = () => fetch(`http://127.0.0.1:${port}/tavily/search`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
  });
  let response;
  let releasing;
  let released = false;
  try {
    assert.equal((await old.acquire()).role, 'owner');
    const oldControl = old.view.control;
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json());
    response = post().then((value) => ({ value }), (error) => ({ error }));
    await started;
    releasing = old.release().then(() => { released = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released, false, 'the listening port stays owned while the Provider outcome is pending');
    assert.equal((await replacement.acquire()).role, 'client', 'another process sees the draining Port owner');
    const drainingHealth = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(drainingHealth.status, 200);
    assert.deepEqual(await drainingHealth.json(), health, 'Gateway identity is unchanged while draining');
    assert.equal((await post()).status, 503, 'new searches are refused before dispatch');
    await assert.rejects(oldControl.disable('tavily-1'), /shutting down/i);
    assert.equal(searchCalls, 1);

    finishSearch();
    const finished = await response;
    assert.equal(finished.error, undefined, 'shutdown must not drop an already dispatched search response');
    assert.equal(finished.value.status, 200);
    await releasing;
    time.ms += 5000;
    assert.equal((await replacement.ensure()).role, 'owner');
    assert.equal((await replacement.view.control.status()).accounts[0].allocations[0].spent, 2);
    await assert.rejects(oldControl.setSpent('tavily-1', 'free', 0), /shutting down/i);
    await assert.rejects(oldControl.reconcile(), /shutting down/i);
  } finally {
    finishSearch();
    await response;
    await releasing;
    await old.release();
    await replacement.release();
    cleanup();
  }
});

test('A contender whose health probe fails cannot write the shared store before acquiring the Port', async () => {
  const { configPath, cleanup } = await setup();
  const backing = memoryStore();
  let writes = 0;
  const store = { load: () => backing.load(), save: (state) => { writes++; backing.save(state); } };
  const owner = new BrokerHost({ configPath, env: {}, store });
  const contender = new BrokerHost({ configPath, env: {}, store, fetchImpl: async () => { throw new Error('probe failed'); } });
  try {
    assert.equal((await owner.acquire()).role, 'owner');
    writes = 0;
    const view = await contender.acquire();
    assert.equal(view.role, 'offline');
    assert.equal(view.issue.level, 'error');
    assert.match(view.issue.message, /used by another program/);
    assert.equal(writes, 0, 'a failed bind must not construct a writing Account pool');
  } finally {
    await owner.release();
    await contender.release();
    cleanup();
  }
});

test('A client abort during shutdown settles the possibly billed Attempt before takeover', async () => {
  const { configPath, port, cleanup } = await setup();
  const store = memoryStore();
  let startSearch;
  let abortUpstream;
  const started = new Promise((resolve) => { startSearch = resolve; });
  const aborted = new Promise((resolve) => { abortUpstream = resolve; });
  const fetchImpl = (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return fetch(url, opts);
    startSearch();
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => {
      abortUpstream();
      reject(opts.signal.reason);
    }, { once: true }));
  };
  const old = new BrokerHost({ configPath, env: {}, store, fetchImpl });
  const replacement = new BrokerHost({ configPath, env: {}, store, fetchImpl });
  const client = new AbortController();
  let request;
  let releasing;
  try {
    assert.equal((await old.acquire()).role, 'owner');
    request = fetch(`http://127.0.0.1:${port}/tavily/search`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'q' }), signal: client.signal
    }).catch(() => null);
    await started;
    releasing = old.release();
    client.abort();
    await aborted;
    await request;
    await releasing;
    assert.equal((await replacement.acquire()).role, 'owner');
    const account = (await replacement.view.control.status()).accounts[0];
    assert.equal(account.possiblyBilled, 1);
    assert.equal(account.allocations[0].spent, 1);
  } finally {
    client.abort();
    await request;
    await releasing;
    await old.release();
    await replacement.release();
    cleanup();
  }
});

test('A failed Account pool startup releases the bound Port and reports the error', async () => {
  const { configPath, port, cleanup } = await setup();
  const backing = memoryStore();
  const store = { load: () => backing.load(), save: () => { throw new Error('disk failure'); } };
  const host = new BrokerHost({ configPath, env: {}, store });
  try {
    const view = await host.acquire();
    assert.equal(view.role, 'offline');
    assert.match(view.issue.message, /Could not start the broker gateway/);
    await assertPortAvailable(port, 'failed initialization must release the Port');
  } finally {
    await host.release();
    cleanup();
  }
});

test('An admin request waiting for its body cannot mutate the Account pool after shutdown begins', async () => {
  const { configPath, port, cleanup } = await setup();
  const store = memoryStore();
  const old = new BrokerHost({ configPath, env: {}, store });
  const replacement = new BrokerHost({ configPath, env: {}, store });
  const body = JSON.stringify({ id: 'tavily-1' });
  let request;
  let response;
  let releasing;
  try {
    assert.equal((await old.acquire()).role, 'owner');
    const accepted = new Promise((resolve) => { const stop = onServerRequest(port, () => { stop(); resolve(); }); });
    response = new Promise((resolve, reject) => {
      request = httpRequest(`http://127.0.0.1:${port}/admin/disable`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      request.once('error', reject);
      request.write(body.slice(0, 1));
    });
    await accepted;
    releasing = old.release();
    request.end(body.slice(1));
    assert.equal(await response, 503);
    await releasing;
    assert.equal((await replacement.acquire()).role, 'owner');
    assert.equal((await replacement.view.control.status()).accounts[0].status, 'active');
  } finally {
    request?.destroy();
    await response?.catch(() => {});
    await releasing;
    await old.release();
    await replacement.release();
    cleanup();
  }
});

test('A retained in-process control cannot write after another Port owner takes over', async () => {
  const { configPath, cleanup } = await setup();
  const store = memoryStore();
  const old = new BrokerHost({ configPath, env: {}, store });
  const replacement = new BrokerHost({ configPath, env: {}, store });
  try {
    assert.equal((await old.acquire()).role, 'owner');
    const retained = old.view.control;
    const admitted = retained.disable('tavily-1');
    const releasing = old.release();
    await admitted;
    await releasing;

    assert.equal((await replacement.acquire()).role, 'owner');
    const control = replacement.view.control;
    assert.equal((await control.status()).accounts[0].status, 'manual', 'an admitted operation finishes before takeover');
    await control.enable('tavily-1');
    await control.setSpent('tavily-1', 'free', 4);
    for (const operation of [
      () => retained.enable('tavily-1'),
      () => retained.disable('tavily-1'),
      () => retained.setSpent('tavily-1', 'free', 0),
      () => retained.reconcile('tavily-1')
    ]) await assert.rejects(operation(), /shutting down/i);
    await replacement.release();

    assert.equal((await old.acquire()).role, 'owner');
    const account = (await old.view.control.status()).accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.allocations[0].spent, 4);
  } finally {
    await old.release();
    await replacement.release();
    cleanup();
  }
});

test('An owner host sends searches upstream through its injected fetch', async () => {
  const { configPath, port, cleanup } = await setup();
  const upstream = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return fetch(url, opts); // health probes reach the real gateway
    upstream.push(url);
    return Response.json({ results: [{ title: 'ok' }], usage: { credits: 1 } });
  };
  const h = new BrokerHost({ configPath, env: {}, fetchImpl, store: memoryStore() });
  try {
    assert.equal((await h.acquire()).role, 'owner');
    const res = await fetch(`http://127.0.0.1:${port}/tavily/search`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
    });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream, ['https://api.tavily.com/search']);
    assert.equal((await h.view.control.status()).accounts[0].allocations[0].spent, 1);
  } finally { await h.release(); cleanup(); }
});

test('Reference counting keeps the gateway alive while any session in the process still uses it', async () => {
  const { configPath, port, cleanup } = await setup();
  const h = new BrokerHost({ configPath, env: {}, store: memoryStore() });
  try {
    await h.acquire(); // parent session
    await h.acquire(); // in-process subagent
    await h.release(); // subagent finished
    assert.equal(h.view.role, 'owner');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, 'the Gateway still serves');
    await h.release();
    assert.deepEqual(h.view, { role: 'idle', control: null, issue: null, url: null });
    await assertPortAvailable(port, 'the last release stops the Gateway');
  } finally { cleanup(); }
});

test('Final release while a health probe is pending leaves no Gateway on the port', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, EXA_BASE_URL: 'https://example.test/exa', PI_SEARCH_BROKER_TOKEN: 'previous-token' };
  const env = { ...originalEnv };
  const probe = deferHealthProbe();
  const h = new BrokerHost({ configPath, env, fetchImpl: probe.fetchImpl, store: memoryStore() });
  let acquiring;
  let releasing;
  try {
    acquiring = h.acquire();
    await probe.started;
    releasing = h.release();
    await new Promise((resolve) => setImmediate(resolve));
    probe.resume();
    await Promise.all([acquiring, releasing]);

    assert.deepEqual(env, originalEnv, 'the original pi environment is restored');
    await assertPortAvailable(port, 'the Gateway must not retain the port after final release');
  } finally {
    probe.resume();
    await Promise.allSettled([acquiring, releasing].filter(Boolean));
    // Also clean up the orphaned Gateway when this regression test fails on the old implementation.
    await h.release();
    await h.acquire();
    await h.release();
    cleanup();
  }
});

test('A session arriving during final cleanup keeps a Gateway and its pi environment', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, EXA_BASE_URL: 'https://example.test/exa', PI_SEARCH_BROKER_TOKEN: 'previous-token' };
  const env = { ...originalEnv };
  const h = new BrokerHost({ configPath, env, store: memoryStore() });
  try {
    assert.equal((await h.acquire()).role, 'owner');
    const releasing = h.release();
    const acquiring = h.acquire();
    const [, view] = await Promise.all([releasing, acquiring]);

    assert.equal(view.role, 'owner');
    assert.deepEqual(env, {
      ...originalEnv,
      EXA_BASE_URL: `http://127.0.0.1:${port}/exa`,
      TAVILY_BASE_URL: `http://127.0.0.1:${port}/tavily`,
      PI_SEARCH_BROKER_TOKEN: TOKEN
    }, 'the new session retains the broker environment');
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal((await health.json()).service, 'pi-search-broker');

    await h.release();
    assert.deepEqual(env, originalEnv, 'the last session restores the original environment');
    await assertPortAvailable(port, 'the last session releases the Gateway port');
  } finally {
    await h.release();
    cleanup();
  }
});

test('A session released while waiting for cleanup cannot leave an orphaned Gateway', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, TAVILY_BASE_URL: 'https://example.test/tavily' };
  const env = { ...originalEnv };
  const probe = deferHealthProbe();
  const h = new BrokerHost({ configPath, env, fetchImpl: probe.fetchImpl, store: memoryStore() });
  const operations = [];
  try {
    operations.push(h.acquire());
    await probe.started;
    operations.push(h.release());
    operations.push(h.acquire());
    operations.push(h.release());
    probe.resume();
    await Promise.all(operations);

    await assertPortAvailable(port, 'both released sessions must leave the port available');
    assert.deepEqual(env, originalEnv, 'both released sessions must restore the original environment');
  } finally {
    probe.resume();
    await Promise.allSettled(operations);
    await h.release();
    await h.acquire();
    await h.release();
    cleanup();
  }
});

test('A late ensure during final release cannot restart the Gateway', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, EXA_BASE_URL: 'https://example.test/exa' };
  const env = { ...originalEnv };
  const h = new BrokerHost({ configPath, env, store: memoryStore() });
  try {
    assert.equal((await h.acquire()).role, 'owner');
    const releasing = h.release();
    const ensuring = h.ensure();
    await Promise.all([releasing, ensuring]);

    await assertPortAvailable(port, 'a late ensure must not restart a Gateway after final release');
    assert.deepEqual(env, originalEnv);
  } finally {
    await h.release();
    await h.acquire();
    await h.release();
    cleanup();
  }
});

test('An ensure during reload uses the replacement session Gateway configuration', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const nextPort = await freePort(port);
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, EXA_BASE_URL: 'https://example.test/exa' };
  const env = { ...originalEnv };
  let holdProbe = false;
  let resumeProbe;
  let signalProbe;
  const probeStarted = new Promise((resolve) => { signalProbe = resolve; });
  const probeGate = new Promise((resolve) => { resumeProbe = resolve; });
  const fetchImpl = async (url, opts) => {
    if (holdProbe && String(url).endsWith('/health')) {
      holdProbe = false;
      signalProbe();
      await probeGate;
    }
    return fetch(url, opts);
  };
  const h = new BrokerHost({ configPath, env, fetchImpl, store: memoryStore() });
  const operations = [];
  try {
    assert.equal((await h.acquire()).role, 'owner');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.gateway.port = nextPort;
    writeFileSync(configPath, JSON.stringify(config));
    holdProbe = true;
    operations.push(h.release());
    operations.push(h.acquire());
    operations.push(h.ensure());
    await probeStarted;
    await operations[0];
    resumeProbe();
    const [, view] = await Promise.all(operations);

    assert.equal(view.role, 'owner');
    assert.equal(env.EXA_BASE_URL, `http://127.0.0.1:${nextPort}/exa`);
    const health = await fetch(`http://127.0.0.1:${nextPort}/health`).then((res) => res.json(), () => null);
    assert.equal(health?.service, 'pi-search-broker', 'the replacement session can reach its configured Gateway');
    await assertPortAvailable(port, 'the old Gateway port is released');

    await h.release();
    assert.deepEqual(env, originalEnv);
  } finally {
    resumeProbe();
    await Promise.allSettled(operations);
    await h.release();
    cleanup();
  }
});

test('Sessions arriving during cleanup share the Gateway until their last release', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, TAVILY_BASE_URL: 'https://example.test/tavily' };
  const env = { ...originalEnv };
  const h = new BrokerHost({ configPath, env, store: memoryStore() });
  try {
    assert.equal((await h.acquire()).role, 'owner');
    const releasing = h.release();
    const first = h.acquire();
    const second = h.acquire();
    const [, firstView, secondView] = await Promise.all([releasing, first, second]);
    assert.equal(firstView.role, 'owner');
    assert.equal(secondView.role, 'owner');

    await h.release();
    assert.equal(env.TAVILY_BASE_URL, `http://127.0.0.1:${port}/tavily`);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).service, 'pi-search-broker');

    await h.release();
    assert.deepEqual(env, originalEnv);
    await assertPortAvailable(port, 'the last session releases the shared Gateway port');
  } finally {
    await h.release();
    await h.release();
    cleanup();
  }
});

test('A live session survives overlapping final cleanups', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, EXA_BASE_URL: 'https://example.test/exa' };
  const env = { ...originalEnv };
  const probe = deferHealthProbe();
  const h = new BrokerHost({ configPath, env, fetchImpl: probe.fetchImpl, store: memoryStore() });
  const operations = [];
  try {
    operations.push(h.acquire());
    await probe.started;
    operations.push(h.release());
    operations.push(h.acquire());
    operations.push(h.release());
    operations.push(h.acquire());
    probe.resume();
    await Promise.all(operations);

    assert.equal(env.EXA_BASE_URL, `http://127.0.0.1:${port}/exa`);
    assert.equal(env.TAVILY_BASE_URL, `http://127.0.0.1:${port}/tavily`);
    assert.equal(env.PI_SEARCH_BROKER_TOKEN, TOKEN);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).service, 'pi-search-broker');

    await h.release();
    assert.deepEqual(env, originalEnv);
    await assertPortAvailable(port, 'the last session releases the Gateway port');
  } finally {
    probe.resume();
    await Promise.allSettled(operations);
    await h.release();
    await h.acquire();
    await h.release();
    cleanup();
  }
});

test('An older cleanup cannot discard a newer live session configuration', async () => {
  const first = await setup();
  const replacement = await setup(first.port);
  const originalEnv = { PI_CODING_AGENT_DIR: first.agentDir, EXA_BASE_URL: 'https://example.test/exa' };
  const env = { ...originalEnv };
  const other = new BrokerHost({ configPath: replacement.configPath, env: {}, store: memoryStore() });
  // Return the real owner's health identity immediately, before the earlier close callback can run.
  // The test separately checks the owner's actual HTTP endpoint below.
  const fetchImpl = (url, opts) => String(url) === `http://127.0.0.1:${replacement.port}/health`
    ? Promise.resolve(Response.json({ service: 'pi-search-broker' }))
    : fetch(url, opts);
  const h = new BrokerHost({ configPath: first.configPath, env, fetchImpl, store: memoryStore() });
  const operations = [];
  try {
    assert.equal((await other.acquire()).role, 'owner');
    assert.equal((await h.acquire()).role, 'owner');
    operations.push(h.release());
    operations.push(h.acquire());
    operations.push(h.release());
    await operations[2];

    const config = JSON.parse(readFileSync(first.configPath, 'utf8'));
    config.gateway.port = replacement.port;
    writeFileSync(first.configPath, JSON.stringify(config));
    operations.push(h.acquire());
    assert.equal((await operations[3]).role, 'client');
    writeFileSync(first.configPath, '{invalid until the next reload');
    await Promise.all(operations);

    assert.equal(env.EXA_BASE_URL, `http://127.0.0.1:${replacement.port}/exa`);
    assert.equal(env.TAVILY_BASE_URL, `http://127.0.0.1:${replacement.port}/tavily`);
    assert.equal(env.PI_SEARCH_BROKER_TOKEN, TOKEN);
    assert.equal(h.view.control.mode, 'http');
    assert.equal((await (await fetch(`http://127.0.0.1:${replacement.port}/health`)).json()).service, 'pi-search-broker');

    await h.release();
    assert.deepEqual(env, originalEnv);
  } finally {
    await Promise.allSettled(operations);
    await h.release();
    await h.release();
    await other.release();
    first.cleanup();
    replacement.cleanup();
  }
});

test('Final release during a client takeover probe leaves the Gateway port free', async () => {
  const { configPath, port, agentDir, cleanup } = await setup();
  const originalEnv = { PI_CODING_AGENT_DIR: agentDir, TAVILY_BASE_URL: 'https://example.test/tavily' };
  const env = { ...originalEnv };
  let holdProbe = false;
  let resumeProbe;
  let signalProbe;
  const probeStarted = new Promise((resolve) => { signalProbe = resolve; });
  const probeGate = new Promise((resolve) => { resumeProbe = resolve; });
  const fetchImpl = async (url, opts) => {
    if (holdProbe && String(url).endsWith('/health')) {
      holdProbe = false;
      signalProbe();
      await probeGate;
    }
    return fetch(url, opts);
  };
  const time = { ms: Date.now() };
  const owner = new BrokerHost({ configPath, env: {}, store: memoryStore() });
  const client = new BrokerHost({ configPath, env, fetchImpl, store: memoryStore(), now: () => time.ms });
  const operations = [];
  try {
    assert.equal((await owner.acquire()).role, 'owner');
    assert.equal((await client.acquire()).role, 'client');
    await owner.release();
    time.ms += 5000;
    holdProbe = true;
    operations.push(client.ensure());
    await probeStarted;
    operations.push(client.release());
    await new Promise((resolve) => setImmediate(resolve));
    resumeProbe();
    await Promise.all(operations);

    await assertPortAvailable(port, 'a released client must not leave a takeover Gateway behind');
    assert.deepEqual(env, originalEnv);
  } finally {
    resumeProbe();
    await Promise.allSettled(operations);
    await client.release();
    await client.acquire();
    await client.release();
    await owner.release();
    cleanup();
  }
});

test('Missing config leaves the host unconfigured with an actionable message and no env changes', async () => {
  const env = {};
  const h = new BrokerHost({ configPath: join(tmpdir(), 'definitely-missing-broker', 'config.json'), env });
  const view = await h.acquire();
  assert.equal(view.role, 'unconfigured');
  assert.equal(view.control, null, 'nothing to control without a config');
  assert.equal(view.issue.level, 'warning');
  assert.match(view.issue.message, /npm run init/);
  assert.deepEqual(env, {});
  await h.release();
});

test('pi extension: registers /broker, shows a footer status, re-reads config on /reload, and releases on shutdown', async () => {
  const { configPath, agentDir, cleanup } = await setup();
  writeFileSync(join(agentDir, 'web-search.json'), JSON.stringify({ exaApiKey: '$PI_SEARCH_BROKER_TOKEN', tavilyApiKey: '$PI_SEARCH_BROKER_TOKEN' }));
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const host = new BrokerHost({ configPath, env, store: memoryStore() });
  const handlers = {};
  const commands = {};
  const statuses = [];
  const notes = [];
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: (name, opts) => { commands[name] = opts; }
  };
  const ctx = { hasUI: true, ui: { setStatus: (k, t) => statuses.push([k, t]), setWidget: () => {}, notify: (m, t) => notes.push([m, t]), theme: null } };
  try {
    createExtension({ getHost: () => host })(pi);
    assert.equal(statuses.length, 0, 'the factory must not start anything');
    await handlers.session_start({ reason: 'startup' }, ctx);
    assert.equal(host.view.role, 'owner');
    assert.deepEqual(notes, [], 'correct web-search.json wiring produces no warnings');
    assert.match(statuses.at(-1)[1], /^search: tavily 1,000cr \(1\/1\)/);
    assert.equal(env.TAVILY_BASE_URL?.endsWith('/tavily'), true);
    assert.deepEqual(commands.broker.getArgumentCompletions('').map((i) => i.label), ['status', 'enable', 'disable', 'set-spent', 'reconcile', 'doctor']);
    assert.deepEqual(commands.broker.getArgumentCompletions('re').map((i) => i.value), ['reconcile ']);
    assert.deepEqual(commands.broker.getArgumentCompletions('enable ta').map((i) => i.value), ['enable tavily-1 ']);
    await commands.broker.handler('', ctx);
    assert.match(notes.at(-1)[0], /tavily-1 \[tavily\] active/);
    await commands.broker.handler('disable tavily-1', ctx);
    assert.match(statuses.at(-1)[1], /\(0\/1\)/);
    await commands.broker.handler('enable tavily-1', ctx);
    await commands.broker.handler('set-spent tavily-1 free lots', ctx);
    assert.deepEqual(notes.at(-1), ['Usage: /broker set-spent <account> <allocation> <amount>', 'warning']);
    await commands.broker.handler('doctor', ctx);
    assert.match(notes.at(-1)[0], /\[ok\] {3}Gateway is running/);
    assert.match(notes.at(-1)[0], /tavily: base URL points at the broker \(TAVILY_BASE_URL\)/, 'doctor sees the env the host wired');
    await commands.broker.handler('widget', ctx);
    assert.match(notes.at(-1)[0], /^\/broker status/, 'unknown subcommands show usage');
    await handlers.tool_execution_end({ toolName: 'web_search' }, ctx);
    assert.ok(!JSON.stringify([statuses, notes]).includes('tvly-aaaaaaaa'));
    // pi /reload = session_shutdown + session_start: the edited broker config is picked up.
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.accounts.push({ id: 'tavily-2', provider: 'tavily', apiKey: 'tvly-bbbbbbbb', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] });
    writeFileSync(configPath, JSON.stringify(cfg));
    await handlers.session_shutdown({ reason: 'reload' }, ctx);
    await handlers.session_start({ reason: 'reload' }, ctx);
    assert.match(statuses.at(-1)[1], /^search: tavily 2,000cr \(2\/2\)/);
    await handlers.session_shutdown({ reason: 'quit' }, ctx);
    assert.equal(statuses.at(-1)[1], undefined);
    assert.equal(host.view.role, 'idle');
    assert.equal(env.TAVILY_BASE_URL, undefined);
  } finally {
    await host.release();
    cleanup();
  }
});

test('doctor: explains the EXA_API_KEY override trap and the keyless Exa MCP bypass without printing secrets', async () => {
  const { configPath, port, dir, cleanup } = await setup();
  const home = join(dir, 'home');
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(home, '.pi', 'agent', 'web-search.json'), JSON.stringify({
    exaBaseUrl: `http://127.0.0.1:${port}/exa`,
    tavilyApiKey: TOKEN,
    searchProvider: 'tavily',
    searchRouting: { providers: ['exa', 'tavily'], fallbackOn: ['quota'] }
  }));
  const env = { TAVILY_API_KEY: 'tvly-real-key-in-shell', TAVILY_API_KEY_3: 'tvly-pool' };
  try {
    const config = loadConfig(configPath);
    const checks = await runDoctor({ config, control: offlineControl(config, { statePath: join(dir, 'state.json') }), env, home });
    const text = JSON.stringify(checks);
    assert.match(text, /Gateway is not running/);
    assert.match(text, /exa: no key resolves.*keyless Exa MCP/);
    assert.match(text, /tavily: base URL does not point at the broker/);
    assert.match(text, /tavily: key from TAVILY_API_KEY \(overrides the plain value in web-search.json\) is NOT the broker token/);
    assert.match(text, /TAVILY_API_KEY_n/);
    assert.match(text, /searchProvider/);
    assert.match(text, /lacks transient/);
    assert.ok(!text.includes('tvly-real-key-in-shell') && !text.includes(TOKEN));
    assert.deepEqual(await runDoctor({ configError: 'Missing config' }), [{ level: 'error', message: 'Broker config: Missing config' }]);
    // Another program on the gateway port is an error, not "not running".
    const otherProgram = async () => Response.json({ service: 'some-other-app' });
    const control = await connectControl({ config, statePath: join(dir, 'pool-state.json'), fetchImpl: otherProgram });
    assert.equal(control.mode, 'offline');
    const blocked = JSON.stringify(await runDoctor({ config, control, env, home }));
    assert.match(blocked, /"level":"error","message":"Something else answers on http:\/\/127\.0\.0\.1:\d+; change gateway\.port"/);
  } finally { cleanup(); }
});

test('doctor helpers mirror pi-web-access resolution rules', () => {
  const env = { PI_SEARCH_BROKER_TOKEN: TOKEN, EXA_API_KEY: 'other' };
  assert.equal(describeKey('$PI_SEARCH_BROKER_TOKEN', 'EXA_API_KEY', env, TOKEN).matches, true);
  assert.equal(describeKey(TOKEN, 'EXA_API_KEY', env, TOKEN).matches, false, 'plain value loses to EXA_API_KEY');
  assert.equal(describeKey('!op read x', 'EXA_API_KEY', env, TOKEN).matches, null);
  assert.equal(piWebSearchConfigPath({ PI_CODING_AGENT_DIR: '/x' }, '/home'), join('/x', 'web-search.json'));
});
