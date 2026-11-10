// CLI and the shared account-command parser, through main() with an in-process control and a loopback Gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { parseCommand, runCommand, usage } from '../src/commands.mjs';
import { createGateway } from '../src/gateway.mjs';
import { offlineControl } from '../src/control.mjs';
import { loadConfig } from '../src/config.mjs';
import { tavily, secret } from './helpers.mjs';
import { memoryStore } from '../src/pool/store.mjs';

async function setup({ store } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-cli-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port: 19473, token: secret }, accounts: [tavily('t', 'tvly-aaaaaaaa')] }));
  const gateway = createGateway(loadConfig(configPath), { store });
  await new Promise((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen(0, '127.0.0.1', () => { gateway.server.off('error', reject); resolve(); });
  });
  const lines = { out: [], err: [] };
  const run = (...argv) => main([...argv, '--config', configPath], {
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {}, connect: async () => gateway.control
  });
  const cleanup = async () => { await gateway.shutdown(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, configPath, gateway, lines, run, cleanup };
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

test('Status warns when Account pool state cannot be saved', async () => {
  const backing = memoryStore();
  let writable = true;
  const store = { load: () => backing.load(), save: (state) => { if (!writable) throw new Error('disk failure'); backing.save(state); } };
  const { configPath, gateway, cleanup } = await setup({ store });
  try {
    const cfg = loadConfig(configPath);
    writable = false;
    await assert.rejects(gateway.control.disable('t'));
    const report = await runCommand(gateway.control, { name: 'status' }, { config: cfg });
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

test('Offline: status reads state.json, changes are refused so only a running gateway writes state', async () => {
  const { dir, configPath, cleanup } = await setup();
  const config = loadConfig(configPath);
  const offline = offlineControl(config, { statePath: join(dir, 'pool-state.json') });
  const lines = { out: [], err: [] };
  const run = (...argv) => main([...argv, '--config', configPath], {
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {}, connect: async () => offline
  });
  try {
    assert.equal(await run('status'), 0);
    assert.match(lines.out.at(-1), /^Search broker \(offline, from the state file/);
    assert.equal(await run('enable', 't'), 1);
    assert.match(lines.err.at(-1), /gateway is not running/);
  } finally { await cleanup(); }
});
