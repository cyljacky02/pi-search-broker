// Key files: one Provider API key per line in keys/<provider>*.txt, each line one Account. Every key here is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKeyFolder, keyFolderAt } from '../src/keys.mjs';
import { createGateway } from '../src/gateway.mjs';
import { loadConfig } from '../src/config.mjs';
import { memoryStore } from '../src/pool/store.mjs';
import { secret, json, keyOf, freePort, assertPortAvailable } from './helpers.mjs';

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-keys-'));
  const keys = join(dir, 'keys');
  mkdirSync(keys);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(keys, name), text);
  return { keys, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tavilyFree = [{ id: 'free', limit: 1000, period: 'monthly', resetDay: 1 }];

test('Each key becomes one Account: Tavily keys start from the free plan, Exa keys from an unknown balance; settings lines and per-key expiry add hints', () => {
  const f = folder({
    'tavily.txt': '\uFEFF# my Tavily keys\r\ntvly-fake-key-aaaa\r\n\r\n  tvly-fake-key-bbbb  \r\n',
    'exa-promo.txt': '# promo: 60 once expires=2026-12-01\nexa-fake-key-0001\nexa-fake-key-0002  expires=2026-12-15\n'
  });
  try {
    const { accounts, warnings } = readKeyFolder(f.keys);
    assert.deepEqual(warnings, []);
    assert.deepEqual(accounts, [
      { id: 'exa-promo-45422472', provider: 'exa', apiKey: 'exa-fake-key-0001', allocations: [
        { id: 'promo', limit: 60, period: 'once', expiresAt: '2026-12-01T00:00:00Z' }] },
      { id: 'exa-promo-1978b537', provider: 'exa', apiKey: 'exa-fake-key-0002', allocations: [
        { id: 'promo', limit: 60, period: 'once', expiresAt: '2026-12-15T00:00:00Z' }] },
      { id: 'tavily-78809fd3', provider: 'tavily', apiKey: 'tvly-fake-key-aaaa', allocations: tavilyFree },
      { id: 'tavily-310f38f5', provider: 'tavily', apiKey: 'tvly-fake-key-bbbb', allocations: tavilyFree }
    ]);
  } finally { f.cleanup(); }
});

test('Unusable lines and files are skipped with key-free warnings; the rest still load', () => {
  const f = folder({
    'exa.txt': 'exa-fake-key-0001\nshort\nexa-REPLACE_ME\nexa-fake-key-0002 expires=2026-12-01\nexa-fake-key-0003 colour=blue\n',
    'exa-bad.txt': '# promo: 0x10 once\nexa-fake-key-0004\n',
    'exa-dup.txt': 'exa-fake-key-0001\n',
    'notes.txt': 'whatever\n',
    'tavily paid.txt': 'tvly-fake-key-cccc\n',
    'tavily-promo.txt': '# promo: 500 once expires=2026-13-40\ntvly-fake-key-dddd\n',
    'tavily2.txt': '# a note\n# Note: 5 keys from Bob\ntvly-fake-key-eeee\n'
  });
  try {
    const { accounts, warnings } = readKeyFolder(f.keys);
    // File-name order: exa-bad, exa-dup, exa ("-" sorts before "."), so exa-dup.txt holds the first copy.
    assert.deepEqual(accounts.map((a) => a.id), ['exa-dup-45422472']);
    assert.deepEqual(warnings, [
      'keys/exa-bad.txt skipped: line 1 is a settings line (# <name>: <limit> <monthly|once> ...), but limit must be a positive number',
      'keys/exa.txt: lines 2, 3, 4, 5 skipped (not a usable key, or a bad expires= or admin=)',
      'keys/exa.txt: line 1 skipped (key already listed)',
      'keys/notes.txt skipped: name it exa*.txt or tavily*.txt',
      'keys/tavily paid.txt skipped: use only letters, digits, - and _ in the file name (at most 55 characters)',
      'keys/tavily-promo.txt skipped: line 1 is a settings line (# <name>: <limit> <monthly|once> ...), but Invalid ISO expiresAt on allocation promo',
      'keys/tavily2.txt skipped: line 2 is a settings line (# <name>: <limit> <monthly|once> ...), but period must be monthly or once'
    ]);
    assert.doesNotMatch(warnings.join('\n'), /fake-key|short|REPLACE_ME/);
  } finally { f.cleanup(); }
});

test('The Tavily free plan can be changed or turned off per file; a missing key folder has no Accounts', () => {
  const f = folder({
    'tavily-paid.txt': '# free: none\n# plan: 4000 monthly reset-day=15\ntvly-fake-key-aaaa\n',
    'tavily-team.txt': '# free: 500 monthly\ntvly-fake-key-bbbb\n',
    'tavily-zero.txt': '# free: none\ntvly-fake-key-cccc\n'
  });
  try {
    const { accounts, warnings } = readKeyFolder(f.keys);
    assert.deepEqual(accounts.map((a) => [a.id, a.allocations]), [
      ['tavily-paid-78809fd3', [{ id: 'plan', limit: 4000, period: 'monthly', resetDay: 15 }]],
      ['tavily-team-310f38f5', [{ id: 'free', limit: 500, period: 'monthly', resetDay: 1 }]],
      ['tavily-zero-a17541e6', []]
    ]);
    assert.deepEqual(warnings, [], 'no hint at all is fine: Tavily reports the balance');
    const missing = readKeyFolder(join(f.keys, 'missing'));
    assert.deepEqual([missing.accounts, missing.warnings], [[], []]);
  } finally { f.cleanup(); }
});

test('An Exa key line can carry its service key (admin=) for exact balances; it is checked like a key and never shown', () => {
  const f = folder({
    'exa.txt': 'exa-fake-key-0001  admin=exa-fake-admin-0001\nexa-fake-key-0002  admin=short\nexa-fake-key-0003  admin=exa-fake-admin-0003  expires=2026-12-01\n',
    'tavily.txt': 'tvly-fake-key-aaaa  admin=tvly-fake-admin-aaaa\n'
  });
  try {
    const { accounts, warnings } = readKeyFolder(f.keys);
    assert.deepEqual(accounts, [
      { id: 'exa-45422472', provider: 'exa', apiKey: 'exa-fake-key-0001', adminKey: 'exa-fake-admin-0001', allocations: [] }
    ]);
    assert.deepEqual(warnings, [
      'keys/exa.txt: lines 2, 3 skipped (not a usable key, or a bad expires= or admin=)',
      'keys/tavily.txt: line 1 skipped (not a usable key, or a bad expires= or admin=)'
    ]);
    assert.doesNotMatch(warnings.join('\n'), /fake/);
  } finally { f.cleanup(); }
});

// ---------- a Gateway starting with key files ----------

/** A private config dir with config.json (given Accounts) and keys/ (given files). */
function brokerDir(accounts, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-keys-gw-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port: 19473, token: secret }, accounts }));
  mkdirSync(join(dir, 'keys'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'keys', name), text);
  const readJson = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return { dir, configPath, readJson, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tavilyRequest = (url) => fetch(`${url}/tavily/search`, {
  method: 'POST', headers: { 'x-api-key': secret, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q' })
});

test('A Gateway serves the Accounts in key files, reports skipped lines and leaves a key-free index for offline status', async () => {
  const b = brokerDir([], { 'tavily.txt': 'tvly-fake-key-aaaa\nshort\n' });
  const sent = [];
  const gateway = createGateway(loadConfig(b.configPath), {
    store: memoryStore(), keyFolder: keyFolderAt(b.configPath),
    fetchImpl: async (_url, options) => { sent.push(keyOf(options)); return json({ results: [], usage: { credits: 1 } }); }
  });
  try {
    const { url, notes } = await gateway.start({ port: 0 });
    assert.deepEqual(notes, ['keys/tavily.txt: line 2 skipped (not a usable key, or a bad expires= or admin=)']);
    assert.equal((await tavilyRequest(url)).status, 200);
    assert.deepEqual(sent, ['Bearer tvly-fake-key-aaaa']);
    assert.deepEqual((await gateway.control.status()).accounts.map((a) => a.id), ['tavily-78809fd3']);
    assert.deepEqual(b.readJson('keys.index.json'), { version: 1, accounts: [
      { id: 'tavily-78809fd3', provider: 'tavily', allocations: [{ id: 'free', limit: 1000, period: 'monthly', resetDay: 1 }] }
    ] });
    assert.doesNotMatch(readFileSync(join(b.dir, 'keys.index.json'), 'utf8'), /fake-key/);
    assert.deepEqual(b.readJson('config.json').accounts, [], 'keys are never copied into config.json');
  } finally { await gateway.stop(); b.cleanup(); }
});

test('Without any Account in config.json or key files a Gateway does not start, and says where keys go', async () => {
  const b = brokerDir([], { 'tavily.txt': '# paste Tavily keys here\n' });
  const port = await freePort();
  const gateway = createGateway(loadConfig(b.configPath), { store: memoryStore(), keyFolder: keyFolderAt(b.configPath) });
  try {
    await assert.rejects(gateway.start({ port }), (err) => {
      assert.equal(err.code, 'ENOACCOUNTS');
      assert.ok(err.message.includes(join(b.dir, 'keys')), err.message);
      return true;
    });
    await assertPortAvailable(port, 'a Gateway without Accounts releases the Port');
    assert.deepEqual(b.readJson('keys.index.json'), { version: 1, accounts: [] });
  } finally { await gateway.stop(); b.cleanup(); }
});

test('Emptied key files also empty the index, so offline status stops listing their Accounts', async () => {
  const b = brokerDir([], { 'tavily.txt': 'tvly-fake-key-aaaa\n' });
  const first = createGateway(loadConfig(b.configPath), { store: memoryStore(), keyFolder: keyFolderAt(b.configPath) });
  try {
    await first.start({ port: 0 });
    assert.equal(b.readJson('keys.index.json').accounts.length, 1);
  } finally { await first.stop(); }
  writeFileSync(join(b.dir, 'keys', 'tavily.txt'), '# no keys any more\n');
  const second = createGateway(loadConfig(b.configPath), { store: memoryStore(), keyFolder: keyFolderAt(b.configPath) });
  try {
    await assert.rejects(second.start({ port: 0 }), { code: 'ENOACCOUNTS' });
    assert.deepEqual(b.readJson('keys.index.json'), { version: 1, accounts: [] });
  } finally { await second.stop(); b.cleanup(); }
});

test('Placeholders never serve or block startup, and stay in config.json until a key file adds an Account', async () => {
  const placeholder = { id: 'exa-promo-01', provider: 'exa', apiKey: 'REPLACE_EXA_KEY', allocations: [{ id: 'free', limit: 10, period: 'monthly' }] };
  const handWritten = { id: 'tavily-main', provider: 'tavily', apiKey: 'tvly-fake-key-aaaa', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] };
  const b = brokerDir([placeholder, handWritten], { 'tavily.txt': 'tvly-fake-key-aaaa\n' });
  const gateway = createGateway(loadConfig(b.configPath), { store: memoryStore(), keyFolder: keyFolderAt(b.configPath) });
  try {
    const { notes } = await gateway.start({ port: 0 });
    assert.deepEqual(notes, [
      'keys/tavily.txt line 1 skipped: its key is already used by tavily-main in config.json',
      'exa-promo-01 in config.json is not set up: its key is still an example value'
    ]);
    assert.deepEqual((await gateway.control.status()).accounts.map((a) => a.id), ['tavily-main']);
    assert.deepEqual(b.readJson('config.json').accounts, [placeholder, handWritten], 'no key-file Account replaced them');
  } finally { await gateway.stop(); b.cleanup(); }
});

test('Key files replace the placeholder Accounts init used to write; config.json keys win over key-file duplicates', async () => {
  const placeholders = [
    { id: 'exa-promo-01', provider: 'exa', apiKey: 'REPLACE_EXA_KEY', allocations: [{ id: 'free', limit: 10, period: 'monthly' }] },
    { id: 'tavily-free-01', provider: 'tavily', apiKey: 'REPLACE_TAVILY_KEY', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] }
  ];
  const handWritten = { id: 'tavily-main', provider: 'tavily', apiKey: 'tvly-fake-key-bbbb', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] };
  const b = brokerDir([...placeholders, handWritten], { 'tavily.txt': 'tvly-fake-key-aaaa\ntvly-fake-key-bbbb\n' });
  const gateway = createGateway(loadConfig(b.configPath), { store: memoryStore(), keyFolder: keyFolderAt(b.configPath) });
  try {
    const { notes } = await gateway.start({ port: 0 });
    assert.deepEqual(notes, [
      'keys/tavily.txt line 2 skipped: its key is already used by tavily-main in config.json',
      'Removed placeholder Accounts from config.json: exa-promo-01, tavily-free-01'
    ]);
    assert.deepEqual((await gateway.control.status()).accounts.map((a) => a.id), ['tavily-main', 'tavily-78809fd3']);
    const saved = b.readJson('config.json');
    assert.deepEqual(saved.accounts, [handWritten]);
    assert.equal(saved.gateway.token, secret);
  } finally { await gateway.stop(); b.cleanup(); }
});
