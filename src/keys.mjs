// Key files: keys/<provider>*.txt next to the config, one Provider API key per line, each key one Account.
// A key file is the only source of its Accounts (docs/adr/0001-key-files-own-their-accounts.md): keys are never copied
// into config.json, and an Account id is the file name plus a fingerprint of its key, so it never changes or gets reused.
// Key files are read only when a local Gateway starts. Warnings name files and line numbers, never key contents.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PROVIDER_NAMES, validateAllocation, isRealKey, hasControlCharacters, removeAccounts } from './config.mjs';
import { PROVIDERS } from './providers.mjs';
import { atomicWriteJson } from './files.mjs';

export const KEY_INDEX_VERSION = 1;
/** The key folder next to a config file. */
export const keysDirOf = (configPath) => join(dirname(configPath), 'keys');
/** The key-free list of key-file Accounts as last read by a starting Gateway, next to a config file. */
export const keyIndexPathOf = (configPath) => join(dirname(configPath), 'keys.index.json');

const ACCOUNT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const FINGERPRINT_LENGTH = 8;
/** "# <allocation>: <limit|none> ..." is a settings line; any other # line is a comment. */
const SETTING = /^#\s*([A-Za-z0-9_-]+)\s*:\s*((?:\d|\.\d|none\b).*)$/i;
const SETTING_FORMAT = '# <name>: <limit> <monthly|once> ...';
const OPTION = /^(expires|reset-day)=(.+)$/;
const KEY_OPTION = /^(expires|admin)=(.+)$/;
/** Settings-line syntax for a limit; validateAllocation then checks its value. */
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/** expires= value: "2026-12-01" means midnight UTC; other values go to validation as given. */
const toExpiresAt = (value) => (/^\d{4}-\d\d-\d\d$/.test(value) ? `${value}T00:00:00Z` : value);
const fingerprint = (key) => createHash('sha256').update(key).digest('hex').slice(0, FINGERPRINT_LENGTH);
const lineList = (numbers) => `${numbers.length === 1 ? 'line' : 'lines'} ${numbers.join(', ')}`;
/** The free-plan hint a key file gives each key unless it says otherwise, or null (Exa: unknown balance). */
const freePlan = (provider) => (PROVIDERS[provider].freePlanLimit
  ? { id: 'free', limit: PROVIDERS[provider].freePlanLimit, period: 'monthly', resetDay: 1 } : null);
const usableKey = (key) => isRealKey(key) && !hasControlCharacters(key);

/** Which Provider a key file belongs to: the file name starts with the Provider name ("exa-promo.txt", "tavily2.txt"). */
const providerOf = (name) => PROVIDER_NAMES.find((p) => name.startsWith(p)) ?? null;

/** One settings line's text after the colon ("60 once expires=2026-12-01") as an Allocation; throws key-free messages. */
function parseAllocation(id, text) {
  const [limit, period, ...options] = text.trim().split(/\s+/);
  if (!DECIMAL.test(limit) || Number(limit) <= 0) throw new Error('limit must be a positive number');
  if (period !== 'monthly' && period !== 'once') throw new Error('period must be monthly or once');
  const allocation = { id, limit: Number(limit), period };
  for (const option of options) {
    const [, name, value] = option.match(OPTION) ?? [];
    if (name === 'expires') {
      if (value === 'never') allocation.expires = 'never';
      else allocation.expiresAt = toExpiresAt(value);
    } else if (name === 'reset-day' && /^\d+$/.test(value)) {
      allocation.resetDay = Number(value);
    } else {
      throw new Error('unknown option (use expires=… or reset-day=…)');
    }
  }
  if (period === 'monthly') allocation.resetDay ??= 1;
  validateAllocation(allocation, `allocation ${id}`);
  return allocation;
}

/**
 * The Allocation hints a file's settings lines describe, the Provider's free plan included unless turned off. May be
 * empty: then the Provider-reported balance (or none: unknown) is all there is. Throws with the line.
 */
function allocationsOf(settings, provider) {
  const allocations = [];
  let free = freePlan(provider);
  for (const { id, text, number } of settings) {
    try {
      if (/^none$/i.test(text.trim())) {
        if (id !== 'free') throw new Error('only the free plan can be set to none');
        free = null;
      } else if (id === 'free') {
        free = parseAllocation(id, text);
      } else {
        if (allocations.some((a) => a.id === id)) throw new Error(`allocation ${id} is set twice`);
        allocations.push(parseAllocation(id, text));
      }
    } catch (err) {
      throw new Error(`line ${number} is a settings line (${SETTING_FORMAT}), but ${err.message}`);
    }
  }
  if (free) allocations.push(free);
  return allocations;
}

/**
 * A key line ("<key> [expires=…] [admin=…]") with the file's Allocations; null when the line is unusable.
 * expires= sets this key's expiry for the file's `once` hints; admin= is an Exa service key for exact balances.
 */
function accountOf(line, prefix, provider, allocations) {
  const [key, ...options] = line.split(/\s+/);
  if (!usableKey(key)) return null;
  const set = {};
  for (const option of options) {
    const [, name, value] = option.match(KEY_OPTION) ?? [];
    if (!name || name in set) return null;
    set[name] = value;
  }
  let own = allocations;
  if (set.expires !== undefined) {
    if (!own.some((a) => a.period === 'once')) return null;
    own = own.map((a) => (a.period !== 'once' ? a : set.expires === 'never'
      ? { id: a.id, limit: a.limit, period: a.period, expires: 'never' }
      : { id: a.id, limit: a.limit, period: a.period, expiresAt: toExpiresAt(set.expires) }));
    try { for (const a of own) validateAllocation(a, a.id); } catch { return null; }
  }
  if (set.admin !== undefined && (provider !== 'exa' || !usableKey(set.admin))) return null;
  const account = { id: `${prefix}-${fingerprint(key)}`, provider, apiKey: key, ...(set.admin ? { adminKey: set.admin } : {}), allocations: structuredClone(own) };
  return { key, account };
}

/**
 * Read every key file in `dir`, in file-name order. Returns { accounts, warnings, origins }: one Account per usable
 * key, key-free warnings for skipped files and lines, and where each Account came from ("keys/exa.txt line 2").
 * A missing folder has no Accounts. The first copy of a repeated key wins.
 */
export function readKeyFolder(dir) {
  let names;
  try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.txt')).sort(); }
  catch (err) { if (err.code === 'ENOENT') return { accounts: [], warnings: [], origins: new Map() }; throw new Error(`Unable to list the key folder ${dir}`); }
  const accounts = [];
  const warnings = [];
  const origins = new Map();
  const seen = new Set();
  for (const name of names) {
    const where = `keys/${name}`;
    const provider = providerOf(name);
    const prefix = name.slice(0, -'.txt'.length);
    if (!provider) { warnings.push(`${where} skipped: name it ${PROVIDER_NAMES.map((p) => `${p}*.txt`).join(' or ')}`); continue; }
    if (!ACCOUNT_ID.test(`${prefix}-${'0'.repeat(FINGERPRINT_LENGTH)}`)) {
      warnings.push(`${where} skipped: use only letters, digits, - and _ in the file name (at most ${63 - FINGERPRINT_LENGTH} characters)`);
      continue;
    }
    let text;
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { warnings.push(`${where} skipped: it cannot be read`); continue; }
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((raw, i) => ({ text: raw.trim(), number: i + 1 }));
    const settings = lines.filter((l) => SETTING.test(l.text)).map((l) => {
      const [, id, rest] = l.text.match(SETTING);
      return { id, text: rest, number: l.number };
    });
    let allocations;
    try { allocations = allocationsOf(settings, provider); }
    catch (err) { warnings.push(`${where} skipped: ${err.message}`); continue; }
    const bad = [];
    const repeated = [];
    for (const l of lines) {
      if (!l.text || l.text.startsWith('#')) continue;
      const parsed = accountOf(l.text, prefix, provider, allocations);
      if (!parsed) { bad.push(l.number); continue; }
      if (seen.has(parsed.key)) { repeated.push(l.number); continue; }
      seen.add(parsed.key);
      accounts.push(parsed.account);
      origins.set(parsed.account.id, `${where} line ${l.number}`);
    }
    if (bad.length) warnings.push(`${where}: ${lineList(bad)} skipped (not a usable key, or a bad expires= or admin=)`);
    if (repeated.length) warnings.push(`${where}: ${lineList(repeated)} skipped (key already listed)`);
  }
  return { accounts, warnings, origins };
}

/**
 * The key folder a Gateway reads when it starts, next to the config at `configPath`. Each write returns key-free notes.
 *   dir                       where key files live
 *   read()                    readKeyFolder(dir)
 *   saveIndex(accounts)       record the key-file Accounts just read (id, provider, allocations) for offline status
 *   removePlaceholders(ids)   key files replaced these example Accounts: remove them from config.json
 */
export function keyFolderAt(configPath) {
  const dir = keysDirOf(configPath);
  return {
    dir,
    read: () => readKeyFolder(dir),
    saveIndex(accounts) {
      try {
        atomicWriteJson(keyIndexPathOf(configPath), {
          version: KEY_INDEX_VERSION, accounts: accounts.map(({ id, provider, allocations }) => ({ id, provider, allocations }))
        });
        return [];
      } catch { return ['Could not save keys.index.json; offline status may list outdated key-file Accounts.']; }
    },
    removePlaceholders(ids) {
      if (!ids.length) return [];
      try {
        removeAccounts(configPath, ids);
        return [`Removed placeholder Accounts from config.json: ${ids.join(', ')}`];
      } catch { return [`Could not remove placeholder Accounts from config.json: ${ids.join(', ')}`]; }
    }
  };
}

/** No key folder: a Gateway uses config.json Accounts only (tests, and callers that pass no keyFolder). */
export const noKeyFolder = Object.freeze({
  dir: null,
  read: () => ({ accounts: [], warnings: [], origins: new Map() }),
  saveIndex: () => [],
  removePlaceholders: () => []
});

/**
 * The key-file Accounts (id, provider, allocations; never keys) as last read by a starting Gateway, for offline status.
 * Missing or unreadable index: none.
 */
export function readKeyIndex(indexPath) {
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    return index?.version === KEY_INDEX_VERSION && Array.isArray(index.accounts) ? index.accounts : [];
  } catch {
    return [];
  }
}

const TEMPLATE_TEXT = Object.freeze({
  tavily: [
    '# Tavily API keys for the search broker, one key per line.',
    '# Then run /reload in pi (or restart the standalone gateway).',
    '# The broker asks Tavily for each key\'s balance, so nothing else is needed here.',
    '# More files work too, for example tavily-team.txt. Keep this folder private.'
  ],
  exa: [
    '# Exa API keys for the search broker, one key per line.',
    '# Then run /reload in pi (or restart the standalone gateway).',
    '# A normal Exa key cannot read its balance: the broker uses it until Exa says it is out of credit,',
    '# then waits for the monthly reset. For exact balances and promo expiry dates, add the team\'s service key:',
    '#     exa-xxxxxxxx  admin=<service key>',
    '# Without one, you can still tell the broker about promo credit with a settings line such as',
    '#     # promo: 60 once expires=2026-12-01',
    '# More files work too, for example exa-promo.txt. Keep this folder private.'
  ]
});

/**
 * Create the key folder with one instructions-only key file per Provider. Never overwrites a file.
 * Returns the key folder path.
 */
export function writeKeyFileTemplates(configPath) {
  const dir = keysDirOf(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const provider of PROVIDER_NAMES) {
    const text = [...TEMPLATE_TEXT[provider], ''].join('\n');
    try { writeFileSync(join(dir, `${provider}.txt`), text, { flag: 'wx', mode: 0o600 }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  return dir;
}
