import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { BrokerHost } from '../src/host.mjs';
import { createExtension } from '../extension/index.js';
import { runDoctor, describeKey, piWebSearchConfigPath } from '../src/doctor.mjs';
import { loadConfig } from '../src/config.mjs';
import { offlineControl, connectControl } from '../src/control.mjs';
import { memoryStore } from '../src/pool/store.mjs';

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
    assert.equal(await a.acquire(), 'owner');
    assert.equal(await b.acquire(), 'client');
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
    assert.equal((await b.control()).mode, 'http');
    assert.equal((await (await b.control()).status()).accounts[0].id, 'tavily-1');
    await (await b.control()).disable('tavily-1');
    assert.equal((await (await a.control()).status()).accounts[0].status, 'manual');
    await (await b.control()).enable('tavily-1');
    // Owner leaves: env restored, port freed; once the client's probe cache expires, it takes over.
    await a.release();
    assert.equal(envA.EXA_BASE_URL, undefined);
    assert.equal(envA.PI_SEARCH_BROKER_TOKEN, undefined);
    assert.equal(await b.ensure(), 'client', 'a recent successful probe is trusted for a few seconds');
    time.ms += 5000;
    assert.equal(await b.ensure(), 'owner');
    assert.equal((await b.control()).mode, 'in-process');
    assert.equal((await (await b.control()).status()).accounts[0].status, 'active');
  } finally {
    await a.release(); await b.release();
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
    assert.equal(await h.acquire(), 'owner');
    const res = await fetch(`http://127.0.0.1:${port}/tavily/search`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
    });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream, ['https://api.tavily.com/search']);
    assert.equal((await (await h.control()).status()).accounts[0].allocations[0].spent, 1);
  } finally { await h.release(); cleanup(); }
});

test('Reference counting keeps the gateway alive while any session in the process still uses it', async () => {
  const { configPath, cleanup } = await setup();
  const h = new BrokerHost({ configPath, env: {}, store: memoryStore() });
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
  assert.match(h.lastError, /npm run init/);
  assert.deepEqual(env, {});
  await assert.rejects(h.control(), /npm run init/);
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
    assert.equal(host.mode, 'owner');
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
    assert.equal(host.mode, 'idle');
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
