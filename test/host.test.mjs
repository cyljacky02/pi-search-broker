import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { BrokerHost, getHost, resetHost } from '../src/host.mjs';
import { runDoctor, describeKey, piWebSearchConfigPath } from '../src/doctor.mjs';
import { CONFIG_ENV } from '../src/config.mjs';

const TOKEN = 'local-only-secret-with-32-chars-12345';
async function freePort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function setup() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-host-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    gateway: { host: '127.0.0.1', port, token: TOKEN },
    reconcileIntervalMs: 0,
    accounts: [{ id: 'tavily-1', provider: 'tavily', apiKey: 'tvly-aaaaaaaa', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] }]
  }));
  return { dir, configPath, port, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('First host owns the port, a second process is a client, and takes over when the owner leaves', async () => {
  const { configPath, port, cleanup } = await setup();
  const envA = { TAVILY_API_KEY_1: 'tvly-real-pool-key', EXA_API_KEY: 'exa-real' };
  const envB = {};
  const a = new BrokerHost({ configPath, env: envA });
  const b = new BrokerHost({ configPath, env: envB });
  try {
    assert.equal(await a.acquire(), 'owner');
    assert.equal(await b.acquire(), 'client');
    // Environment wiring for pi-web-access in each "process".
    assert.equal(envA.EXA_BASE_URL, `http://127.0.0.1:${port}/exa`);
    assert.equal(envA.TAVILY_BASE_URL, `http://127.0.0.1:${port}/tavily`);
    assert.equal(envA.EXA_API_KEY, TOKEN);
    assert.equal(envA.PI_SEARCH_BROKER_TOKEN, TOKEN);
    assert.equal(envA.TAVILY_API_KEY_1, undefined, 'pool keys are removed so pi does not send real keys to the broker');
    assert.equal(a.takeNotes().length, 2);
    // Client mode works over HTTP.
    assert.equal((await b.status()).accounts[0].id, 'tavily-1');
    await b.admin('disable', { id: 'tavily-1' });
    assert.equal((await a.status()).accounts[0].status, 'manual');
    await b.admin('enable', { id: 'tavily-1' });
    // Owner leaves: env restored, port freed; client takes over on next ensure().
    await a.release();
    assert.equal(envA.EXA_API_KEY, 'exa-real');
    assert.equal(envA.TAVILY_API_KEY_1, 'tvly-real-pool-key');
    assert.equal(envA.EXA_BASE_URL, undefined);
    b.lastProbeOk = 0;
    assert.equal(await b.ensure(), 'owner');
    assert.equal((await b.status()).accounts[0].status, 'active');
  } finally {
    await a.release(); await b.release();
    cleanup();
  }
});

test('Reference counting keeps the gateway alive while any session in the process still uses it', async () => {
  const { configPath, cleanup } = await setup();
  const h = new BrokerHost({ configPath, env: {} });
  try {
    await h.acquire(); // parent session
    await h.acquire(); // in-process subagent
    await h.release(); // subagent finished
    assert.equal(h.mode, 'owner');
    assert.ok(h.gateway?.server.listening);
    await h.release();
    assert.equal(h.mode, 'idle');
    assert.equal(h.gateway, null);
  } finally { cleanup(); }
});

test('Missing config leaves the host unconfigured with an actionable message and no env changes', async () => {
  const env = {};
  const h = new BrokerHost({ configPath: join(tmpdir(), 'definitely-missing-broker', 'config.json'), env });
  assert.equal(await h.acquire(), 'unconfigured');
  assert.match(h.lastError, /broker init/);
  assert.deepEqual(env, {});
  await h.release();
});

test('pi extension: registers /broker, shows a footer status, and releases on shutdown', async () => {
  const { configPath, cleanup } = await setup();
  const saved = process.env[CONFIG_ENV];
  process.env[CONFIG_ENV] = configPath;
  resetHost();
  const handlers = {};
  const commands = {};
  const statuses = [];
  const notes = [];
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: (name, opts) => { commands[name] = opts; },
    registerFlag: () => {},
    getFlag: () => false
  };
  const ctx = { hasUI: true, ui: { setStatus: (k, t) => statuses.push([k, t]), setWidget: () => {}, notify: (m, t) => notes.push([m, t]), theme: null } };
  try {
    const { default: extension } = await import('../extension/index.js');
    extension(pi);
    assert.equal(statuses.length, 0, 'the factory must not start anything');
    await handlers.session_start({ reason: 'startup' }, ctx);
    assert.equal(getHost().mode, 'owner');
    assert.match(statuses.at(-1)[1], /^search: tavily 1,000cr \(1\/1\)/);
    assert.equal(process.env.TAVILY_BASE_URL?.endsWith('/tavily'), true);
    assert.deepEqual(commands.broker.getArgumentCompletions('re').map((i) => i.value), ['reconcile ', 'reload ']);
    assert.deepEqual(commands.broker.getArgumentCompletions('enable ta').map((i) => i.value), ['enable tavily-1 ']);
    await commands.broker.handler('status', ctx);
    assert.match(notes.at(-1)[0], /tavily-1 \[tavily\] active/);
    await commands.broker.handler('disable tavily-1', ctx);
    assert.match(statuses.at(-1)[1], /\(0\/1\)/);
    await commands.broker.handler('enable tavily-1', ctx);
    await handlers.tool_execution_end({ toolName: 'web_search' }, ctx);
    assert.ok(!JSON.stringify([statuses, notes]).includes('tvly-aaaaaaaa'));
    await handlers.session_shutdown({ reason: 'quit' }, ctx);
    assert.equal(statuses.at(-1)[1], undefined);
    assert.equal(getHost().mode, 'idle');
    assert.equal(process.env.TAVILY_BASE_URL, undefined);
  } finally {
    if (saved === undefined) delete process.env[CONFIG_ENV]; else process.env[CONFIG_ENV] = saved;
    resetHost();
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
    const checks = await runDoctor({ configPath, env, home, fetchImpl: async () => { throw new Error('down'); } });
    const text = JSON.stringify(checks);
    assert.match(text, /Gateway is not running/);
    assert.match(text, /exa: no key resolves.*keyless Exa MCP/);
    assert.match(text, /tavily: base URL does not point at the broker/);
    assert.match(text, /tavily: key from TAVILY_API_KEY \(overrides the plain value in web-search.json\) is NOT the broker token/);
    assert.match(text, /TAVILY_API_KEY_n/);
    assert.match(text, /searchProvider/);
    assert.match(text, /lacks transient/);
    assert.ok(!text.includes('tvly-real-key-in-shell') && !text.includes(TOKEN));
  } finally { cleanup(); }
});

test('doctor helpers mirror pi-web-access resolution rules', () => {
  const env = { PI_SEARCH_BROKER_TOKEN: TOKEN, EXA_API_KEY: 'other' };
  assert.equal(describeKey('$PI_SEARCH_BROKER_TOKEN', 'EXA_API_KEY', env, TOKEN).matches, true);
  assert.equal(describeKey(TOKEN, 'EXA_API_KEY', env, TOKEN).matches, false, 'plain value loses to EXA_API_KEY');
  assert.equal(describeKey('!op read x', 'EXA_API_KEY', env, TOKEN).matches, null);
  assert.equal(piWebSearchConfigPath({ PI_CODING_AGENT_DIR: '/x' }, '/home'), join('/x', 'web-search.json'));
});
