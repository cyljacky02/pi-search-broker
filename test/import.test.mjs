// Importing Accounts from a key file (one API key per line), through the CLI's main(). Every key here is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';
import { secret } from './helpers.mjs';

function setup(accounts) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-broker-import-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { host: '127.0.0.1', port: 19473, token: secret }, accounts }));
  const lines = { out: [], err: [] };
  const keyFile = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const run = (...argv) => main([...argv, '--config', configPath], {
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), env: {},
    connect: async () => { throw new Error('import must not contact the broker'); }
  });
  const accountsNow = () => JSON.parse(readFileSync(configPath, 'utf8')).accounts;
  return { dir, configPath, lines, keyFile, run, accountsNow, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const placeholderTavily = { id: 'tavily-free-01', provider: 'tavily', apiKey: 'REPLACE_TAVILY_KEY', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] };
const placeholderExa = { id: 'exa-promo-01', provider: 'exa', apiKey: 'REPLACE_EXA_KEY', allocations: [{ id: 'free', limit: 10, period: 'monthly' }] };

test('Importing a Tavily key file adds one Account per key with the given Allocation and drops Tavily placeholders', async () => {
  const s = setup([placeholderTavily, placeholderExa]);
  try {
    const file = s.keyFile('tavily.txt', '\uFEFF# my tavily keys\r\ntvly-fake-key-aaaa\r\n\r\n  tvly-fake-key-bbbb  \r\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', '1000', '--period', 'monthly', '--reset-day', '1'), 0, s.lines.err.join('\n'));
    assert.deepEqual(s.accountsNow(), [
      placeholderExa,
      { id: 'tavily-01', provider: 'tavily', apiKey: 'tvly-fake-key-aaaa', allocations: [{ id: 'monthly', limit: 1000, period: 'monthly', resetDay: 1 }] },
      { id: 'tavily-02', provider: 'tavily', apiKey: 'tvly-fake-key-bbbb', allocations: [{ id: 'monthly', limit: 1000, period: 'monthly', resetDay: 1 }] }
    ]);
    assert.equal(loadConfig(s.configPath).gateway.token, secret);
    const printed = s.lines.out.join('\n');
    assert.match(printed, /Added 2 tavily Accounts: tavily-01, tavily-02/);
    assert.match(printed, /Removed placeholder Accounts: tavily-free-01/);
    assert.match(printed, /\/reload/);
    assert.match(printed, /you may delete the key file/);
    assert.doesNotMatch(printed, /fake-key/);
  } finally { s.cleanup(); }
});

test('Re-importing adds only new keys, keeps existing Accounts unchanged and continues the numbering', async () => {
  const existing = { id: 'tavily-01', provider: 'tavily', apiKey: 'tvly-fake-key-aaaa', allocations: [{ id: 'free', limit: 500, period: 'monthly' }] };
  const fromEnv = { id: 'tavily-03', provider: 'tavily', apiKey: '$TAVILY_KEY_THREE', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] };
  const s = setup([existing, fromEnv]);
  try {
    const file = s.keyFile('tavily.txt', 'tvly-fake-key-aaaa\ntvly-fake-key-bbbb\ntvly-fake-key-bbbb\ntvly-fake-key-cccc\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', '1000', '--period', 'monthly'), 0, s.lines.err.join('\n'));
    const allocations = [{ id: 'monthly', limit: 1000, period: 'monthly' }];
    assert.deepEqual(s.accountsNow(), [
      existing, fromEnv,
      { id: 'tavily-02', provider: 'tavily', apiKey: 'tvly-fake-key-bbbb', allocations },
      { id: 'tavily-04', provider: 'tavily', apiKey: 'tvly-fake-key-cccc', allocations }
    ]);
    const printed = s.lines.out.join('\n');
    assert.match(printed, /Added 2 tavily Accounts: tavily-02, tavily-04/);
    assert.match(printed, /Skipped 2 keys already in the config or repeated in the file \(lines 1, 3\)/);
    assert.doesNotMatch(printed, /fake-key/);
  } finally { s.cleanup(); }
});

test('A key file with unusable lines is rejected by line number, without writing the config or printing keys', async () => {
  const s = setup([placeholderTavily]);
  try {
    const before = readFileSync(s.configPath, 'utf8');
    const file = s.keyFile('tavily.txt', 'tvly-fake-key-aaaa\nshort\ntvly-REPLACE_ME\ntvly-fake\x07key-with-bell\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', '1000', '--period', 'monthly'), 1);
    assert.equal(readFileSync(s.configPath, 'utf8'), before);
    assert.match(s.lines.err.join('\n'), /tavily key file: unusable keys on lines 2, 3, 4/);
    assert.doesNotMatch([...s.lines.err, ...s.lines.out].join('\n'), /tvly-|^short$|key-with-bell/m);

    assert.equal(await s.run('import', 'tavily', s.keyFile('empty.txt', '# nothing yet\n\n'), '--limit', '1000', '--period', 'monthly'), 1);
    assert.match(s.lines.err.at(-1), /tavily key file has no keys/);
    assert.equal(readFileSync(s.configPath, 'utf8'), before);
  } finally { s.cleanup(); }
});

test('Exa promo keys get a one-time Allocation with an expiry and a custom id prefix', async () => {
  const s = setup([placeholderExa]);
  try {
    const file = s.keyFile('exa.txt', 'exa-fake-key-0001\nexa-fake-key-0002\n');
    assert.equal(await s.run('import', 'exa', file, '--limit', '20', '--period', 'once', '--expires', '2026-12-01', '--prefix', 'exa-promo'), 0, s.lines.err.join('\n'));
    const allocations = [{ id: 'once', limit: 20, period: 'once', expiresAt: '2026-12-01T00:00:00Z' }];
    assert.deepEqual(s.accountsNow(), [
      { id: 'exa-promo-01', provider: 'exa', apiKey: 'exa-fake-key-0001', allocations },
      { id: 'exa-promo-02', provider: 'exa', apiKey: 'exa-fake-key-0002', allocations }
    ]);
    const never = s.keyFile('exa2.txt', 'exa-fake-key-0003\n');
    assert.equal(await s.run('import', 'exa', never, '--limit', '5', '--period', 'once', '--expires', 'never'), 0, s.lines.err.join('\n'));
    assert.deepEqual(s.accountsNow().at(-1), { id: 'exa-01', provider: 'exa', apiKey: 'exa-fake-key-0003', allocations: [{ id: 'once', limit: 5, period: 'once', expires: 'never' }] });
  } finally { s.cleanup(); }
});

test('--like copies every Allocation of an existing Account; an import without any Allocation is refused', async () => {
  const template = { id: 'exa-main', provider: 'exa', apiKey: '$EXA_MAIN', allocations: [
    { id: 'promo', limit: 60, period: 'once', expiresAt: '2026-12-01T00:00:00Z' },
    { id: 'free', limit: 10, period: 'monthly', resetDay: 1, startsAt: '2026-12-01T00:00:00Z' }
  ] };
  const s = setup([template]);
  try {
    const file = s.keyFile('exa.txt', 'exa-fake-key-0001\n');
    assert.equal(await s.run('import', 'exa', file), 1);
    assert.match(s.lines.err.at(-1), /--limit <n> --period <monthly\|once>.*--like <account>/);
    assert.equal(await s.run('import', 'exa', file, '--like', 'nobody'), 1);
    assert.match(s.lines.err.at(-1), /No exa Account "nobody" to copy Allocations from/);
    assert.equal(s.accountsNow().length, 1);
    assert.equal(await s.run('import', 'exa', file, '--like', 'exa-main'), 0, s.lines.err.join('\n'));
    assert.deepEqual(s.accountsNow().at(-1), { id: 'exa-01', provider: 'exa', apiKey: 'exa-fake-key-0001', allocations: template.allocations });
  } finally { s.cleanup(); }
});

test('--dry-run reports what an import would do without writing the config', async () => {
  const s = setup([placeholderTavily]);
  try {
    const before = readFileSync(s.configPath, 'utf8');
    const file = s.keyFile('tavily.txt', 'tvly-fake-key-aaaa\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', '1000', '--period', 'monthly', '--dry-run'), 0, s.lines.err.join('\n'));
    assert.equal(readFileSync(s.configPath, 'utf8'), before);
    const printed = s.lines.out.join('\n');
    assert.match(printed, /^Dry run: nothing was written/m);
    assert.match(printed, /Would add 1 tavily Accounts: tavily-01/);
    assert.match(printed, /Would remove placeholder Accounts: tavily-free-01/);
    assert.doesNotMatch(printed, /\/reload/);
  } finally { s.cleanup(); }
});

test('An import that would make the config invalid writes nothing', async () => {
  const s = setup([placeholderTavily]);
  try {
    const before = readFileSync(s.configPath, 'utf8');
    const file = s.keyFile('tavily.txt', 'tvly-fake-key-aaaa\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', '-5', '--period', 'monthly'), 1);
    assert.match(s.lines.err.at(-1), /--limit must be a positive number/);
    assert.equal(await s.run('import', 'tavily', file, '--limit', '5', '--period', 'once', '--expires', 'soon'), 1);
    assert.match(s.lines.err.at(-1), /Invalid ISO expiresAt/);
    assert.equal(readFileSync(s.configPath, 'utf8'), before);
  } finally { s.cleanup(); }
});

test('Keys that start with $ or ! are stored as literal keys, never as environment or command sources', async () => {
  const s = setup([]);
  try {
    // An empty accounts list is invalid for loadConfig but fine for import, which then adds the first Accounts.
    const file = s.keyFile('tavily.txt', '$tvly-fake-key\n!tvly-fake-key\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', '1000', '--period', 'monthly'), 0, s.lines.err.join('\n'));
    assert.deepEqual(s.accountsNow().map((a) => a.apiKey), ['$$tvly-fake-key', '$!tvly-fake-key']);
  } finally { s.cleanup(); }
});

test('A key with inner spaces is accepted as a literal key; only control characters are rejected', async () => {
  const s = setup([]);
  try {
    const file = s.keyFile('tavily.txt', 'tvly-fake key-with-space\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', '1000', '--period', 'monthly'), 0, s.lines.err.join('\n'));
    assert.deepEqual(s.accountsNow().map((a) => a.apiKey), ['tvly-fake key-with-space']);
  } finally { s.cleanup(); }
});

test('An import that adds and removes nothing leaves the config untouched, but still checks its flags', async () => {
  const existing = { id: 'tavily-01', provider: 'tavily', apiKey: 'tvly-fake-key-aaaa', allocations: [{ id: 'free', limit: 1000, period: 'monthly' }] };
  const s = setup([existing]);
  try {
    const before = readFileSync(s.configPath, 'utf8');
    const file = s.keyFile('tavily.txt', 'tvly-fake-key-aaaa\n');
    assert.equal(await s.run('import', 'tavily', file, '--limit', 'abc', '--period', 'monthly'), 1);
    assert.match(s.lines.err.at(-1), /--limit must be a positive number/);
    assert.equal(await s.run('import', 'tavily', file, '--limit', '1000', '--period', 'monthly'), 0, s.lines.err.join('\n'));
    assert.equal(readFileSync(s.configPath, 'utf8'), before);
    const printed = s.lines.out.join('\n');
    assert.match(printed, /Nothing to change; the config was not written/);
    assert.match(printed, /Skipped 1 keys already in the config or repeated in the file \(lines 1\)/);
    assert.doesNotMatch(printed, /\/reload/);
  } finally { s.cleanup(); }
});

test('Import flags are checked strictly and in flag terms, before any Account id exists', async () => {
  const s = setup([{ id: 'exa-main', provider: 'exa', apiKey: '$EXA_MAIN', allocations: [{ id: 'free', limit: 10, period: 'monthly' }] }]);
  try {
    const before = readFileSync(s.configPath, 'utf8');
    const file = s.keyFile('exa.txt', 'exa-fake-key-0001\n');
    const cases = [
      [['--limit', '0x10', '--period', 'monthly'], /--limit must be a positive number/],
      [['--limit', '1e3', '--period', 'monthly'], /--limit must be a positive number/],
      [['--limit', '0', '--period', 'monthly'], /--limit must be a positive number/],
      [['--limit', '10', '--period', 'weekly'], /--period must be monthly or once/],
      [['--limit', '10', '--period', 'monthly', '--reset-day', '1.5'], /--reset-day must be a whole number/],
      [['--limit', '10', '--period', 'monthly', '--reset-day', '29'], /resetDay must be 1\.\.28/],
      [['--limit', '10', '--period', 'once', '--expires', 'never', '--reset-day', '1'], /--reset-day only applies to --period monthly/],
      [['--limit', '10', '--period', 'once'], /--period once needs --expires <date\|never>/],
      [['--limit', '10', '--period', 'once', '--expires', 'soon'], /Invalid ISO expiresAt/],
      [['--like', 'exa-main', '--limit', '7', '--period', 'once'], /Use either --like or --limit/],
      [['--like', 'exa-main', '--expires', 'never'], /Use either --like or --limit/]
    ];
    for (const [flags, message] of cases) {
      assert.equal(await s.run('import', 'exa', file, ...flags), 1, flags.join(' '));
      assert.match(s.lines.err.at(-1), message, flags.join(' '));
      assert.doesNotMatch(s.lines.err.at(-1), /exa-01/, 'errors must not name an Account that does not exist yet');
    }
    assert.equal(readFileSync(s.configPath, 'utf8'), before);
    assert.equal(await s.run('import', 'exa', file, '--limit', '12.5', '--period', 'monthly', '--expires', '2027-01-01T00:00:00Z'), 0, s.lines.err.join('\n'));
    assert.deepEqual(s.accountsNow().at(-1).allocations, [{ id: 'monthly', limit: 12.5, period: 'monthly', expiresAt: '2027-01-01T00:00:00Z' }]);
  } finally { s.cleanup(); }
});

test('Ids continue past 99 and a custom prefix continues after its existing ids', async () => {
  const many = Array.from({ length: 99 }, (_, i) => ({
    id: `tavily-${String(i + 1).padStart(2, '0')}`, provider: 'tavily', apiKey: `$TAVILY_${i + 1}`,
    allocations: [{ id: 'free', limit: 1000, period: 'monthly' }]
  }));
  const promo = { id: 'exa-promo-01', provider: 'exa', apiKey: 'exa-fake-key-0001', allocations: [{ id: 'free', limit: 10, period: 'monthly' }] };
  const s = setup([...many, promo]);
  try {
    const tavilyFile = s.keyFile('tavily.txt', 'tvly-fake-key-aaaa\ntvly-fake-key-bbbb\n');
    assert.equal(await s.run('import', 'tavily', tavilyFile, '--limit', '1000', '--period', 'monthly'), 0, s.lines.err.join('\n'));
    assert.match(s.lines.out.join('\n'), /Added 2 tavily Accounts: tavily-100, tavily-101/);
    const exaFile = s.keyFile('exa.txt', 'exa-fake-key-0002\n');
    assert.equal(await s.run('import', 'exa', exaFile, '--limit', '10', '--period', 'monthly', '--prefix', 'exa-promo'), 0, s.lines.err.join('\n'));
    assert.equal(s.accountsNow().at(-1).id, 'exa-promo-02');
  } finally { s.cleanup(); }
});
