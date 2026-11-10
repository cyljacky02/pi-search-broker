import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { TestHost as BrokerHost } from './helpers.mjs';
import { createExtension } from '../extension/index.js';
import { connectControl, probeHealth } from '../src/control.mjs';
import { SERVICE_NAME } from '../src/config.mjs';
import { createGateway } from '../src/gateway.mjs';
import { runDoctor, formatChecks } from '../src/doctor.mjs';
import { config, serve, tavily, onServerRequest, secret as ownerToken } from './helpers.mjs';

const clientToken = 'different-client-gateway-token-123456';

test('doctor identifies a Broker with a different Gateway token as an unusable control', async () => {
  const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
  await serve(ownerConfig, fetch, async ({ base, statePath, control: ownerControl }) => {
    ownerConfig.gateway.port = Number(new URL(base).port);
    const clientConfig = { ...ownerConfig, gateway: { ...ownerConfig.gateway, token: clientToken } };
    const identity = await probeHealth(clientConfig);
    assert.equal(identity.state, 'running', 'identity remains independent of authentication');
    const control = await connectControl({ config: clientConfig, statePath });
    assert.equal(control.mode, 'http', 'an identified Broker remains the port owner');
    const health = await control.health();
    assert.equal(health.state, 'running');
    assert.equal(health.control, 'unauthorized');
    for (const operation of [() => control.status(), () => control.disable('account-1')]) {
      await assert.rejects(operation(), (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes(ownerToken) && !err.message.includes(clientToken));
        return true;
      });
    }
    assert.equal((await ownerControl.status()).accounts[0].status, 'active');

    const checks = await runDoctor({
      config: clientConfig, control, env: { PI_CODING_AGENT_DIR: dirname(statePath) }, home: dirname(statePath)
    });
    const output = formatChecks(checks);
    assert.ok(checks.some(({ level, message }) => level === 'error' && /gateway.*token.*(match|differ)/i.test(message)), output);
    assert.match(output, /gateway\.token/i, 'diagnosis should explain what to fix');
    assert.ok(!checks.some(({ level, message }) => level === 'ok' && /Gateway is running/.test(message)), output);
    assert.ok(!output.includes(ownerToken) && !output.includes(clientToken), 'diagnosis must not expose Gateway tokens');
  });
});

test('matching Gateway token permits HTTP control and doctor reports a running Gateway', async () => {
  const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
  await serve(ownerConfig, fetch, async ({ base, statePath, control: ownerControl }) => {
    ownerConfig.gateway.port = Number(new URL(base).port);
    const control = await connectControl({ config: ownerConfig, statePath });
    assert.equal(control.mode, 'http');
    const health = await control.health();
    assert.equal(health.state, 'running');
    assert.equal(health.control, 'ready');
    assert.ok(health.version);
    assert.equal((await control.status()).accounts[0].status, 'active');
    await control.disable('account-1');
    assert.equal((await ownerControl.status()).accounts[0].status, 'manual');
    await control.enable('account-1');
    assert.equal((await ownerControl.status()).accounts[0].status, 'active');
    const checks = await runDoctor({
      config: ownerConfig, control, env: { PI_CODING_AGENT_DIR: dirname(statePath) }, home: dirname(statePath)
    });
    assert.ok(checks.some(({ level, message }) => level === 'ok' && /Gateway is running/.test(message)));
    assert.ok(!formatChecks(checks).includes(ownerToken));
  });
});

test('an unrelated port owner remains offline and never receives a Gateway token', async () => {
  const received = [];
  const server = createServer((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'unrelated-program' }));
  });
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-control-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const clientConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
    clientConfig.gateway.port = server.address().port;
    clientConfig.gateway.token = clientToken;
    const statePath = join(dir, 'state.json');
    assert.equal((await probeHealth(clientConfig)).state, 'other');
    const control = await connectControl({ config: clientConfig, statePath });
    assert.equal(control.mode, 'offline');
    assert.equal((await control.status()).accounts[0].id, 'account-1');
    await assert.rejects(control.disable('account-1'), /not running/);
    const checks = await runDoctor({ config: clientConfig, control, env: { PI_CODING_AGENT_DIR: dir }, home: dir });
    assert.ok(checks.some(({ level, message }) => level === 'error' && /Something else answers.*change gateway\.port/.test(message)));
    assert.ok(received.length > 0 && received.every((request) => request.path === '/health' && !request.authorization && !request.apiKey));
    assert.ok(!formatChecks(checks).includes(clientToken));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a port redirecting health to a Broker is not trusted with the Gateway token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-control-'));
  const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
  const gateway = createGateway(ownerConfig);
  let targetRequests = 0;
  let gatewayPort;
  let stopCounting = () => {};
  const received = [];
  const other = createServer((req, res) => {
    received.push({ path: req.url, authorization: Boolean(req.headers.authorization), apiKey: Boolean(req.headers['x-api-key']) });
    if (req.url === '/health') {
      res.writeHead(302, { location: `http://127.0.0.1:${gatewayPort}/health` });
      res.end();
    } else if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  let host;
  try {
    ({ port: gatewayPort } = await gateway.start({ port: 0 }));
    stopCounting = onServerRequest(gatewayPort, () => { targetRequests++; });
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    ownerConfig.gateway.port = gatewayPort;
    assert.equal((await probeHealth(ownerConfig)).state, 'running', 'the redirect target is a genuine Broker');
    targetRequests = 0;

    const clientConfig = { ...ownerConfig, gateway: { ...ownerConfig.gateway, port: other.address().port, token: clientToken } };
    const identity = await probeHealth(clientConfig);
    const control = await connectControl({ config: clientConfig, statePath: join(dir, 'client-state.json') });
    const health = await control.health();
    const checks = await runDoctor({ config: clientConfig, control, env: { PI_CODING_AGENT_DIR: dir }, home: dir });
    const output = formatChecks(checks);

    assert.deepEqual({
      identity: identity.state,
      selectedControl: control.mode,
      health: health.state,
      doctorReportsOther: checks.some(({ level, message }) => level === 'error' && /Something else answers.*change gateway\.port/.test(message)),
      credentialsDisclosed: received.some(({ authorization, apiKey }) => authorization || apiKey),
      targetRequests
    }, {
      identity: 'other', selectedControl: 'offline', health: 'other', doctorReportsOther: true, credentialsDisclosed: false, targetRequests: 0
    });
    assert.equal((await control.status()).accounts[0].status, 'active');
    await assert.rejects(control.disable('account-1'), /not running/);
    assert.equal((await gateway.control.status()).accounts[0].status, 'active');
    assert.ok(received.length > 0 && received.every(({ path, authorization, apiKey }) => path === '/health' && !authorization && !apiKey));
    assert.equal(targetRequests, 0, 'control and doctor must not follow the redirect');
    const configPath = join(dir, 'client-config.json');
    writeFileSync(configPath, JSON.stringify(clientConfig));
    host = new BrokerHost({ configPath, env: { PI_CODING_AGENT_DIR: dir } });
    const view = await host.acquire();
    assert.equal(view.role, 'offline');
    assert.match(view.issue.message, /port .*another program/i);
    assert.equal((await probeHealth(clientConfig)).state, 'other', 'the unrelated port remains occupied');
    assert.ok(received.every(({ authorization, apiKey }) => !authorization && !apiKey));
    assert.equal(targetRequests, 0, 'the Port owner must not follow the redirect');
    assert.ok(!output.includes(ownerToken) && !output.includes(clientToken));
  } finally {
    stopCounting();
    if (host) await host.release();
    if (other.listening) await new Promise((resolve) => other.close(resolve));
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Broker identified on the configured port permits HTTP control, and /health carries no credentials', async () => {
  const received = [];
  const server = createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${clientToken}`;
    received.push({ path: req.url, authorized, authorization: Boolean(req.headers.authorization), apiKey: Boolean(req.headers['x-api-key']) });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ service: 'pi-search-broker', version: '0.5.0' }));
    else if (req.url === '/status' && authorized) res.end(JSON.stringify({ accounts: [{ id: 'remote-account' }] }));
    else { res.writeHead(401); res.end('{}'); }
  });
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-control-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const clientConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
    clientConfig.gateway.port = server.address().port;
    clientConfig.gateway.token = clientToken;
    assert.deepEqual(await probeHealth(clientConfig), { state: 'running', version: '0.5.0' });
    const control = await connectControl({ config: clientConfig, statePath: join(dir, 'state.json') });
    assert.equal(control.mode, 'http');
    assert.deepEqual(await control.health(), { state: 'running', version: '0.5.0', control: 'ready' });
    assert.equal((await control.status()).accounts[0].id, 'remote-account');
    assert.ok(received.some(({ path, authorized }) => path === '/status' && authorized));
    assert.ok(received.filter(({ path }) => path === '/health').every(({ authorization, apiKey }) => !authorization && !apiKey));
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an identified port owner with an invalid status response is not treated as usable control', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/health' ? { service: SERVICE_NAME, version: 'test' } : { ok: true }));
  });
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-control-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const clientConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
    clientConfig.gateway.port = server.address().port;
    clientConfig.gateway.token = clientToken;
    const control = await connectControl({ config: clientConfig, statePath: join(dir, 'state.json') });
    assert.equal(control.mode, 'http');
    assert.equal((await control.health()).control, 'unavailable');
    const checks = await runDoctor({ config: clientConfig, control, env: { PI_CODING_AGENT_DIR: dir }, home: dir });
    assert.ok(checks.some(({ level, message }) => level === 'error' && /authenticated control is unavailable/.test(message)));
    assert.ok(!formatChecks(checks).includes(clientToken));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authenticated readiness does not follow a redirect or disclose a token to its target', async () => {
  const received = [];
  const target = createServer((req, res) => { received.push(req.headers); res.end('unexpected'); });
  const peer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: SERVICE_NAME, version: 'test' }));
    } else {
      res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/capture` });
      res.end();
    }
  });
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-control-'));
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  try {
    const clientConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
    clientConfig.gateway.port = peer.address().port;
    clientConfig.gateway.token = clientToken;
    const control = await connectControl({ config: clientConfig, statePath: join(dir, 'state.json') });
    const health = await control.health();
    assert.equal(health.state, 'running');
    assert.equal(health.control, 'unavailable');
    const checks = await runDoctor({ config: clientConfig, control, env: { PI_CODING_AGENT_DIR: dir }, home: dir });
    assert.ok(checks.some(({ level, message }) => level === 'error' && /authenticated control is unavailable/.test(message)));
    await assert.rejects(control.status());
    await assert.rejects(control.disable('account-1'));
    assert.deepEqual(received, []);
    assert.ok(!formatChecks(checks).includes(clientToken));
  } finally {
    await Promise.all([new Promise((resolve) => peer.close(resolve)), new Promise((resolve) => target.close(resolve))]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor does not mistake a stale offline control for a usable newly arrived Gateway', async () => {
  const other = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'unrelated-program' }));
  });
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-control-'));
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  let gateway;
  try {
    const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
    ownerConfig.gateway.port = other.address().port;
    const clientConfig = { ...ownerConfig, gateway: { ...ownerConfig.gateway, token: clientToken } };
    const control = await connectControl({ config: clientConfig, statePath: join(dir, 'state.json') });
    assert.equal(control.mode, 'offline');
    await new Promise((resolve) => other.close(resolve));
    gateway = createGateway(ownerConfig);
    await gateway.start();
    assert.equal((await probeHealth(clientConfig)).state, 'running');

    const checks = await runDoctor({ config: clientConfig, control, env: { PI_CODING_AGENT_DIR: dir }, home: dir });
    const output = formatChecks(checks);
    assert.ok(checks.some(({ level, message }) => level === 'error' && /offline.*reconnect/i.test(message)), output);
    assert.ok(!checks.some(({ level, message }) => level === 'ok' && /Gateway is running/.test(message)), output);
    assert.ok(!output.includes(ownerToken) && !output.includes(clientToken));
  } finally {
    await gateway?.stop();
    if (other.listening) await new Promise((resolve) => other.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extension warns when the joined Gateway disappears before control is usable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-control-'));
  const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
  const gateway = createGateway(ownerConfig);
  ({ port: ownerConfig.gateway.port } = await gateway.start({ port: 0 }));
  try {
    const configPath = join(dir, 'client-config.json');
    writeFileSync(configPath, JSON.stringify(ownerConfig));
    writeFileSync(join(dir, 'web-search.json'), JSON.stringify({
      exaApiKey: '$PI_SEARCH_BROKER_TOKEN', tavilyApiKey: '$PI_SEARCH_BROKER_TOKEN'
    }));
    let stopped = false;
    // The real Gateway leaves just after the client discovers it, before control is selected.
    const fetchImpl = async (url, options) => {
      const response = await fetch(url, options);
      if (!stopped && new URL(url).pathname === '/health') {
        stopped = true;
        await gateway.stop();
      }
      return response;
    };
    const host = new BrokerHost({ configPath, env: { PI_CODING_AGENT_DIR: dir }, fetchImpl });
    const handlers = {};
    const notices = [];
    const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand: () => {} };
    const ctx = { hasUI: true, ui: { setStatus: () => {}, notify: (message, level) => notices.push({ message, level }) } };
    createExtension({ getHost: () => host })(pi);
    try {
      await handlers.session_start({}, ctx);
      assert.equal(host.view.role, 'client');
      assert.ok(notices.some(({ level, message }) => level === 'warning' && /Gateway.*(unavailable|unreachable|not running)/i.test(message)), JSON.stringify(notices));
      assert.ok(!JSON.stringify(notices).includes(ownerToken));
    } finally {
      await handlers.session_shutdown({}, ctx);
    }
  } finally {
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extension startup accepts a joined client with the matching Gateway token', async () => {
  const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
  await serve(ownerConfig, fetch, async ({ base, statePath }) => {
    const dir = dirname(statePath);
    ownerConfig.gateway.port = Number(new URL(base).port);
    const configPath = join(dir, 'client-config.json');
    writeFileSync(configPath, JSON.stringify(ownerConfig));
    writeFileSync(join(dir, 'web-search.json'), JSON.stringify({
      exaApiKey: '$PI_SEARCH_BROKER_TOKEN', tavilyApiKey: '$PI_SEARCH_BROKER_TOKEN'
    }));
    const host = new BrokerHost({ configPath, env: { PI_CODING_AGENT_DIR: dir } });
    const handlers = {};
    const notices = [];
    const statuses = [];
    const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand: () => {} };
    const ctx = { hasUI: true, ui: { setStatus: (_key, status) => statuses.push(status), notify: (message, level) => notices.push({ message, level }) } };
    createExtension({ getHost: () => host })(pi);
    try {
      await handlers.session_start({}, ctx);
      assert.equal(host.view.role, 'client');
      assert.deepEqual(notices, []);
      assert.match(statuses.at(-1), /tavily/);
      assert.ok(!JSON.stringify(statuses).includes(ownerToken));
    } finally {
      await handlers.session_shutdown({}, ctx);
    }
  });
});

test('A joining client decides its role with one look at the port and reuses the control it chose', async () => {
  const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
  await serve(ownerConfig, fetch, async ({ base, statePath }) => {
    const dir = dirname(statePath);
    ownerConfig.gateway.port = Number(new URL(base).port);
    const configPath = join(dir, 'client-config.json');
    writeFileSync(configPath, JSON.stringify(ownerConfig));
    writeFileSync(join(dir, 'web-search.json'), JSON.stringify({
      exaApiKey: '$PI_SEARCH_BROKER_TOKEN', tavilyApiKey: '$PI_SEARCH_BROKER_TOKEN'
    }));
    const requests = [];
    const fetchImpl = (url, options) => { requests.push(new URL(url).pathname); return fetch(url, options); };
    const host = new BrokerHost({ configPath, env: { PI_CODING_AGENT_DIR: dir }, fetchImpl });
    const handlers = {};
    const statuses = [];
    const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand: () => {} };
    const ctx = { hasUI: true, ui: { setStatus: (_key, status) => statuses.push(status), notify: () => {} } };
    createExtension({ getHost: () => host })(pi);
    try {
      await handlers.session_start({}, ctx);
      assert.equal(host.view.role, 'client');
      assert.equal(host.view.control.mode, 'http');
      assert.deepEqual(requests, ['/health', '/status', '/status'], 'one identity probe, one readiness check, one footer status');
      assert.match(statuses.at(-1), /tavily .*\[shared\]/);
    } finally {
      await handlers.session_shutdown({}, ctx);
    }
  });
});

test('extension warns a joined client about a different Gateway token without attempting takeover', async () => {
  const ownerConfig = config(tavily('account-1', 'tvly-owner-provider-key'));
  await serve(ownerConfig, fetch, async ({ base, statePath, control: ownerControl }) => {
    const dir = dirname(statePath);
    ownerConfig.gateway.port = Number(new URL(base).port);
    const clientConfig = { ...ownerConfig, gateway: { ...ownerConfig.gateway, token: clientToken } };
    const configPath = join(dir, 'client-config.json');
    writeFileSync(configPath, JSON.stringify(clientConfig));
    writeFileSync(join(dir, 'web-search.json'), JSON.stringify({
      exaApiKey: '$PI_SEARCH_BROKER_TOKEN', tavilyApiKey: '$PI_SEARCH_BROKER_TOKEN'
    }));
    // A client must not need its own account state while the port owner is present.
    writeFileSync(join(dir, 'pool-state.json'), '{invalid local state');
    let now = Date.now();
    const host = new BrokerHost({ configPath, env: { PI_CODING_AGENT_DIR: dir }, now: () => now });
    const handlers = {};
    const notices = [];
    const pi = { on: (name, fn) => { handlers[name] = fn; }, registerCommand: () => {} };
    const ctx = { hasUI: true, ui: { setStatus: () => {}, notify: (message, level) => notices.push({ message, level }) } };
    createExtension({ getHost: () => host })(pi);
    try {
      await handlers.session_start({}, ctx);
      assert.equal(host.view.role, 'client');
      now += 5000; // An expired identity cache must still not trigger takeover.
      assert.equal((await host.ensure()).role, 'client');
      assert.equal((await ownerControl.status()).accounts[0].id, 'account-1');

      const output = JSON.stringify(notices);
      assert.ok(notices.some(({ level, message }) => level === 'warning' && /gateway.*token.*(match|differ)/i.test(message)), output);
      assert.match(output, /gateway\.token/i);
      assert.ok(!output.includes(ownerToken) && !output.includes(clientToken), 'startup warning must not expose Gateway tokens');
    } finally {
      await handlers.session_shutdown({}, ctx);
    }
  });
});
