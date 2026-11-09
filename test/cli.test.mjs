// CLI and the shared account-command parser, through main() with an in-process control (no process, no port).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { parseCommand, usage } from '../src/commands.mjs';
import { createGateway } from '../src/gateway.mjs';
import { offlineControl } from '../src/control.mjs';
import { loadConfig } from '../src/config.mjs';
import { tavily, secret } from './helpers.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-cli-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port: 19473, token: secret }, accounts: [tavily('t', 'tvly-aaaaaaaa')] }));
  const gateway = createGateway(loadConfig(configPath));
  const lines = { out: [], err: [] };
  const run = (...argv) => main([...argv, '--config', configPath], {
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {}, connect: async () => gateway.control
  });
  return { dir, configPath, gateway, lines, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('The command parser validates arguments the same way for the CLI and /broker', () => {
  assert.deepEqual(parseCommand(['set-spent', 't', 'free', '12.5']), { name: 'set-spent', id: 't', allocationId: 'free', amount: 12.5 });
  for (const bad of [['set-spent', 't', 'free', 'NaN'], ['set-spent', 't', 'free', '-1'], ['set-spent', 't', 'free'], ['enable']]) {
    assert.match(parseCommand(bad).error, /^Usage: /, bad.join(' '));
  }
  assert.deepEqual(parseCommand(['reconcile']), { name: 'reconcile', id: undefined });
  assert.equal(parseCommand(['serve']), null, 'not an account command');
  assert.match(usage('/broker'), /^\/broker status +accounts and remaining credits$/m);
});

test('CLI account commands run against the control and report results', async () => {
  const { run, lines, gateway, cleanup } = setup();
  try {
    assert.equal(await run('disable', 't'), 0);
    assert.equal(lines.out.at(-1), 'Disabled t');
    assert.equal((await gateway.control.status()).accounts[0].status, 'manual');
    assert.equal(await run('set-spent', 't', 'free', '230'), 0);
    assert.equal((await gateway.control.status()).accounts[0].allocations[0].spent, 230);
    assert.equal(await run('status'), 0);
    assert.match(lines.out.at(-1), /^Search broker \(in-process @ http:\/\/127\.0\.0\.1:19473\)/);
    assert.match(lines.out.at(-1), /t \[tavily\] active/);
  } finally { cleanup(); }
});

test('CLI rejects a non-numeric set-spent before contacting the gateway, and unknown commands show help', async () => {
  const { run, lines, gateway, cleanup } = setup();
  try {
    assert.equal(await run('set-spent', 't', 'free', 'lots'), 1);
    assert.equal(lines.err.at(-1), 'Usage: node src/cli.mjs set-spent <account> <allocation> <amount>');
    assert.equal((await gateway.control.status()).accounts[0].allocations[0].spent, 0);
    assert.equal(await run('explode'), 1);
    assert.match(lines.err.at(-1), /^Pi Search Broker/);
  } finally { cleanup(); }
});

test('Offline: status reads state.json, changes are refused so only a running gateway writes state', async () => {
  const { dir, configPath, cleanup } = setup();
  const config = loadConfig(configPath);
  const offline = offlineControl(config, { statePath: join(dir, 'state.json') });
  const lines = { out: [], err: [] };
  const run = (...argv) => main([...argv, '--config', configPath], {
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {}, connect: async () => offline
  });
  try {
    assert.equal(await run('status'), 0);
    assert.match(lines.out.at(-1), /^Search broker \(offline/);
    assert.equal(await run('enable', 't'), 1);
    assert.match(lines.err.at(-1), /gateway is not running/);
  } finally { cleanup(); }
});
