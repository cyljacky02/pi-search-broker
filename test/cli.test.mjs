// CLI and the shared account-command parser, through main() with an in-process control and a loopback Gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { main } from '../src/cli.mjs';
import { parseCommand, runCommand, usage } from '../src/commands.mjs';
import { createGateway } from '../src/gateway.mjs';
import { loadConfig } from '../src/config.mjs';
import { tavily, secret, freePort, assertPortAvailable } from './helpers.mjs';
import { memoryStore, fileStore } from '../src/pool/store.mjs';

async function setup({ store, reconcileFetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-cli-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port: 19473, token: secret }, accounts: [tavily('t', 'tvly-aaaaaaaa')] }));
  const gateway = createGateway(loadConfig(configPath), { store: store ?? fileStore(join(dir, 'pool-state.json')), reconcileFetch });
  const { url } = await gateway.start({ port: 0 });
  const lines = { out: [], err: [] };
  const run = (...argv) => main([...argv, '--config', configPath], {
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {}, connect: async () => gateway.control
  });
  const cleanup = async () => { await gateway.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, configPath, gateway, url, lines, run, cleanup };
}

test('The command parser validates arguments the same way for the CLI and /broker', () => {
  const parse = (words) => parseCommand(words, { prefix: '/broker' });
  assert.deepEqual(parse(['set-spent', 't', 'free', '12.5']), { name: 'set-spent', id: 't', allocationId: 'free', amount: 12.5 });
  for (const bad of [['set-spent', 't', 'free', 'NaN'], ['set-spent', 't', 'free', '-1'], ['set-spent', 't', 'free'], ['enable']]) {
    assert.match(parse(bad).error, /^Usage: \/broker /, bad.join(' '));
  }
  assert.deepEqual(parse(['reconcile']), { name: 'reconcile', id: undefined });
  assert.equal(parse(['serve']), null, 'not an account command');
  assert.match(usage('/broker'), /^\/broker status +accounts and remaining credits$/m);
});

test('CLI account commands run against the control and report results', async () => {
  const { run, lines, gateway, cleanup } = await setup();
  try {
    assert.equal(await run('disable', 't'), 0);
    assert.equal(lines.out.at(-1), 'Disabled t');
    assert.equal((await gateway.control.status()).accounts[0].status, 'manual');
    assert.equal(await run('enable', 't'), 0);
    assert.equal(lines.out.at(-1), 'Enabled t');
    assert.equal(await run('set-spent', 't', 'free', '230'), 0);
    assert.equal((await gateway.control.status()).accounts[0].allocations[0].spent, 230);
    assert.equal(await run('status'), 0);
    assert.match(lines.out.at(-1), /^Search broker \(live @ http:\/\/127\.0\.0\.1:19473\)/);
    assert.match(lines.out.at(-1), /t \[tavily\] active/);
  } finally { await cleanup(); }
});

test('CLI inspection and remote Broker control need no Account credentials or credential commands', async () => {
  const { dir, configPath, url, cleanup } = await setup({
    reconcileFetch: async () => Response.json({ account: { plan_usage: 0, plan_limit: 1000 } })
  });
  const marker = join(dir, 'credentials-used');
  const script = join(dir, 'credential.cjs');
  writeFileSync(script, `require('node:fs').writeFileSync(process.argv[2], 'used'); process.stdout.write('provider-key-from-command');`);
  writeFileSync(join(dir, 'web-search.json'), JSON.stringify({
    exaApiKey: '$PI_SEARCH_BROKER_TOKEN', tavilyApiKey: '$PI_SEARCH_BROKER_TOKEN',
    exaBaseUrl: `${url}/exa`, tavilyBaseUrl: `${url}/tavily`
  }));
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  cfg.gateway.port = Number(new URL(url).port);
  try {
    for (const source of ['$MISSING_ACCOUNT_CREDENTIAL', `!"${process.execPath}" "${script}" "${marker}"`]) {
      cfg.accounts[0].apiKey = source;
      writeFileSync(configPath, JSON.stringify(cfg));
      for (const words of [['status'], ['fragment'], ['doctor'], ['disable', 't'], ['enable', 't'], ['set-spent', 't', 'free', '230'], ['reconcile']]) {
        const [command] = words;
        const out = [];
        const err = [];
        const code = await main([...words, '--config', configPath], {
          out: (line) => out.push(line), err: (line) => err.push(line),
          env: { PI_CODING_AGENT_DIR: dir, PI_SEARCH_BROKER_TOKEN: secret }
        });
        assert.equal(code, 0, `${command}: ${err.join('\n')} ${out.join('\n')}`);
        if (command === 'status') assert.match(out.join('\n'), /t \[tavily\] active/);
        if (command === 'fragment') assert.equal(JSON.parse(out[0]).tavilyBaseUrl, `${url}/tavily`);
        if (command === 'doctor') assert.match(out.join('\n'), /Gateway is running/);
        assert.equal(existsSync(marker), false, `${command} must not execute the credential command`);
      }
    }
  } finally { await cleanup(); }
});

test('Status warns when Account pool state cannot be saved', async () => {
  const backing = memoryStore();
  let writable = true;
  const store = { load: () => backing.load(), save: (state) => { if (!writable) throw new Error('disk failure'); backing.save(state); } };
  const { gateway, cleanup } = await setup({ store });
  try {
    writable = false;
    await assert.rejects(gateway.control.disable('t'));
    const report = await runCommand(gateway.control, { name: 'status' });
    assert.match(report, /state.*could not be saved/i);
    assert.match(report, /paused/i);
  } finally { await cleanup(); }
});

test('CLI rejects a non-numeric set-spent before contacting the gateway, and unknown commands show help', async () => {
  const { run, lines, gateway, cleanup } = await setup();
  try {
    assert.equal(await run('set-spent', 't', 'free', 'lots'), 1);
    assert.equal(lines.err.at(-1), 'Usage: node src/cli.mjs set-spent <account> <allocation> <amount>');
    assert.equal((await gateway.control.status()).accounts[0].allocations[0].spent, 0);
    assert.equal(await run('explode'), 0);
    assert.match(lines.out.at(-1), /^Pi Search Broker/);
  } finally { await cleanup(); }
});

test('serve drains on the first Ctrl+C: an in-flight search finishes and is saved before the Port is released', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-cli-'));
  const configPath = join(dir, 'config.json');
  const port = await freePort();
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port, token: secret }, accounts: [tavily('t', 'tvly-aaaaaaaa')] }));
  let startSearch;
  let finishSearch;
  const started = new Promise((resolve) => { startSearch = resolve; });
  const upstream = new Promise((resolve) => { finishSearch = resolve; });
  const fetchImpl = async () => { startSearch(); await upstream; return Response.json({ results: [], usage: { credits: 1 } }); };
  const signals = new EventEmitter();
  const lines = { out: [], err: [] };
  const search = () => fetch(`http://127.0.0.1:${port}/tavily/search`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
  });
  try {
    const code = await main(['serve', '--config', configPath], {
      out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {}, fetchImpl, signals
    });
    assert.equal(code, 0, lines.err.join('\n'));
    const inFlight = search();
    await started;
    signals.emit('SIGINT', 'SIGINT');
    assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0, 'a second Ctrl+C gets Node\'s default: exit at once');
    assert.equal((await search()).status, 503, 'no new search starts while draining');
    finishSearch();
    assert.equal((await inFlight).status, 200, 'the in-flight search completes');
    for (let i = 0; i < 200 && !lines.out.includes('Gateway stopped'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(lines.out.includes('Gateway stopped'), lines.out.join('\n'));
    await assertPortAvailable(port, 'the Port is released after the drain');
    const state = JSON.parse(readFileSync(join(dir, 'pool-state.json'), 'utf8'));
    assert.equal(state.accounts.t.allocations.free.spent, 1, 'its charge was saved before exit');
  } finally {
    finishSearch();
    if (signals.listenerCount('SIGINT')) signals.emit('SIGINT', 'SIGINT');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Offline CLI inspection needs no Account credentials and never writes the saved state', async () => {
  const { dir, configPath, gateway, url, cleanup } = await setup();
  const lines = { out: [], err: [] };
  const run = (...argv) => main([...argv, '--config', configPath], {
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {}
  });
  try {
    await gateway.control.setSpent('t', 'free', 230);
    await gateway.stop();
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.gateway.port = Number(new URL(url).port);
    cfg.accounts[0].apiKey = '$MISSING_ACCOUNT_CREDENTIAL';
    writeFileSync(configPath, JSON.stringify(cfg));
    const statePath = join(dir, 'pool-state.json');
    const before = readFileSync(statePath, 'utf8');
    assert.equal(await run('status'), 0);
    assert.match(lines.out.at(-1), /^Search broker \(offline, from the state file/);
    assert.match(lines.out.at(-1), /770cr/);
    assert.equal(await run('enable', 't'), 1);
    assert.match(lines.err.at(-1), /gateway is not running/);
    assert.equal(readFileSync(statePath, 'utf8'), before, 'offline control never saves');

    assert.equal(await run('serve'), 1, 'local startup still requires all Account credentials');
    assert.match(lines.err.at(-1), /ACCOUNT_CREDENTIAL.*empty or unset/);
    await assertPortAvailable(cfg.gateway.port, 'a credential failure releases the Port');
    assert.equal(readFileSync(statePath, 'utf8'), before, 'failed startup leaves saved spend unchanged');
  } finally { await cleanup(); }
});

test('CLI inspection still rejects malformed Account metadata', async () => {
  const { configPath, cleanup } = await setup();
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  cfg.accounts[0].apiKey = '$MISSING_ACCOUNT_CREDENTIAL';
  cfg.accounts[0].allocations[0].limit = -1;
  writeFileSync(configPath, JSON.stringify(cfg));
  try {
    for (const command of ['status', 'fragment', 'doctor']) {
      const lines = [];
      const code = await main([command, '--config', configPath], { out: (s) => lines.push(s), err: (s) => lines.push(s), env: {} });
      assert.equal(code, 1);
      assert.match(lines.join('\n'), /Invalid allocation limit/);
      assert.doesNotMatch(lines.join('\n'), /empty or unset/);
    }
  } finally { await cleanup(); }
});

test('Offline status lists key-file Accounts from the key-free index, without reading key files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-cli-offline-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port: await freePort(), token: secret }, accounts: [] }));
  writeFileSync(join(dir, 'keys.index.json'), JSON.stringify({ version: 1, accounts: [
    { id: 'tavily-78809fd3', provider: 'tavily', allocations: [{ id: 'free', limit: 1000, period: 'monthly', resetDay: 1 }] }
  ] }));
  // A file where the key folder should be: anything that tried to read key files would fail.
  writeFileSync(join(dir, 'keys'), 'not a folder');
  const out = [];
  try {
    const code = await main(['status', '--config', configPath], {
      out: (l) => out.push(l), err: (l) => out.push(l), env: {}, fetchImpl: async () => { throw new TypeError('fetch failed'); }
    });
    assert.equal(code, 0, out.join('\n'));
    assert.match(out.join('\n'), /offline, from the state file/);
    assert.match(out.join('\n'), /tavily-78809fd3 \[tavily\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init creates the config and key file templates; there is no import command any more', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-cli-init-'));
  const configPath = join(dir, 'config.json');
  const out = [];
  const run = (...argv) => main([...argv, '--config', configPath], { out: (l) => out.push(l), err: (l) => out.push(l), env: {} });
  try {
    assert.equal(await run('init'), 0, out.join('\n'));
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).accounts, []);
    for (const name of ['exa.txt', 'tavily.txt']) assert.ok(existsSync(join(dir, 'keys', name)), name);
    assert.match(out.join('\n'), /Put your API keys in .*keys/);
    out.length = 0;
    assert.equal(await run('import', 'tavily', join(dir, 'keys', 'tavily.txt')), 0);
    assert.doesNotMatch(out.join('\n'), /import/, 'import is not a command; help is shown');
    assert.match(out.join('\n'), /^Pi Search Broker/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Offline status lists placeholder Accounts as not set up and counts no credit for them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-cli-placeholder-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port: await freePort(), token: secret }, accounts: [
    { id: 'exa-promo-01', provider: 'exa', apiKey: 'REPLACE_EXA_KEY', allocations: [{ id: 'promo', limit: 60, period: 'once', expiresAt: '2099-12-01T00:00:00Z' }] },
    tavily('tavily-real', 'tvly-aaaaaaaa')
  ] }));
  const out = [];
  try {
    const code = await main(['status', '--config', configPath], {
      out: (l) => out.push(l), err: (l) => out.push(l), env: {}, fetchImpl: async () => { throw new TypeError('fetch failed'); }
    });
    assert.equal(code, 0, out.join('\n'));
    const text = out.join('\n');
    assert.match(text, /tavily-real \[tavily\] active/);
    assert.match(text, /exa-promo-01 \[exa\] not set up: its key in config\.json is still an example value/);
    assert.doesNotMatch(text, /\$60/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
