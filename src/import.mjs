// Import Accounts from a key file: one Provider API key per line. The only place that reads key files.
// Keys are copied into the private config as literal sources; the key file itself is never referenced afterwards.
// Nothing here contacts a Provider or the broker, and no message ever contains key material.
import { readFileSync } from 'node:fs';
import {
  PROVIDER_NAMES, readConfigFile, saveConfig, validateConfig, validateAllocation,
  isRealKey, isPlaceholderSource, hasControlCharacters, literalKeyOf, literalSourceOf
} from './config.mjs';

/** Short form for the command list; IMPORT_OPTIONS spells out the options. */
export const IMPORT_ARGS = `<${PROVIDER_NAMES.join('|')}> <key-file> [options]`;
export const IMPORT_OPTIONS = '(--limit <n> --period <monthly|once> [--reset-day <1-28>] [--expires <date|never>] | --like <account>) '
  + '[--prefix <id-prefix>] [--dry-run]';
const ALLOCATION_FLAGS = Object.freeze(['limit', 'period', 'reset-day', 'expires']);
const FLAGS = new Set([...ALLOCATION_FLAGS, 'like', 'prefix']);
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const WHOLE_NUMBER = /^\d+$/;

/** --expires value as an Allocation expiresAt: "2026-12-01" means midnight UTC; other values pass to validation as given. */
const toExpiresAt = (value) => (/^\d{4}-\d\d-\d\d$/.test(value) ? `${value}T00:00:00Z` : value);

/** The Allocation described by the flags, or { error } worded in flag terms. */
function allocationFromFlags(flags) {
  if (!DECIMAL.test(flags.limit) || Number(flags.limit) <= 0) return { error: '--limit must be a positive number (USD for Exa, credits for Tavily)' };
  if (!['monthly', 'once'].includes(flags.period)) return { error: '--period must be monthly or once' };
  const allocation = { id: flags.period, limit: Number(flags.limit), period: flags.period };
  if (flags['reset-day'] !== undefined) {
    if (flags.period !== 'monthly') return { error: '--reset-day only applies to --period monthly' };
    if (!WHOLE_NUMBER.test(flags['reset-day'])) return { error: '--reset-day must be a whole number 1..28' };
    allocation.resetDay = Number(flags['reset-day']);
  }
  if (flags.expires === 'never') allocation.expires = 'never';
  else if (flags.expires !== undefined) allocation.expiresAt = toExpiresAt(flags.expires);
  else if (flags.period === 'once') return { error: '--period once needs --expires <date|never>' };
  try { validateAllocation(allocation, 'the imported Allocation'); } catch (e) { return { error: e.message }; }
  return { allocation };
}

/**
 * Parse the words after "import"; `prefix` is how the caller is invoked, for the usage hint.
 * Returns { provider, keyFile, allocation | like, idPrefix, dryRun } or { error }.
 */
export function parseImportArgs(words, { prefix }) {
  const usageError = { error: `Usage: ${prefix} import ${IMPORT_ARGS.replace(' [options]', '')} ${IMPORT_OPTIONS}` };
  const [provider, keyFile, ...rest] = words;
  const flags = {};
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') { dryRun = true; continue; }
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!FLAGS.has(name) || rest[i + 1] === undefined) return usageError;
    flags[name] = rest[++i];
  }
  if (!PROVIDER_NAMES.includes(provider) || !keyFile) return usageError;
  const request = { provider, keyFile, idPrefix: flags.prefix ?? provider, dryRun };
  if (flags.like !== undefined) {
    if (ALLOCATION_FLAGS.some((f) => flags[f] !== undefined)) {
      return { error: 'Use either --like or --limit/--period/--reset-day/--expires, not both' };
    }
    return { ...request, like: flags.like };
  }
  if (flags.limit === undefined || flags.period === undefined) {
    return { error: 'Give the Allocation for every imported Account: --limit <n> --period <monthly|once>, or --like <account>' };
  }
  const { allocation, error } = allocationFromFlags(flags);
  return error ? { error } : { ...request, allocation };
}

/**
 * Keys of a key file with their 1-based line numbers. Skips blank lines and # comments; tolerates BOM and CRLF.
 * Rejects the whole file if any key is unusable, naming only line numbers.
 */
function readKeys(keyFile, provider) {
  let text;
  try { text = readFileSync(keyFile, 'utf8'); } catch { throw new Error(`Unable to read the ${provider} key file; check its path and permissions`); }
  const keys = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((line, i) => ({ key: line.trim(), line: i + 1 }))
    .filter(({ key }) => key && !key.startsWith('#'));
  const bad = keys.filter(({ key }) => !isRealKey(key) || hasControlCharacters(key)).map(({ line }) => line);
  if (bad.length) throw new Error(`${provider} key file: unusable keys on lines ${bad.join(', ')} (too short, an example value, or containing control characters)`);
  if (!keys.length) throw new Error(`The ${provider} key file has no keys`);
  return keys;
}

/** `count` unused ids `<idPrefix>-01`, `-02`, ... (three digits past 99), lowest first. */
function nextIds(taken, idPrefix, count) {
  const ids = [];
  for (let n = 1; ids.length < count; n++) {
    const id = `${idPrefix}-${String(n).padStart(2, '0')}`;
    if (!taken.has(id)) ids.push(id);
  }
  return ids;
}

/**
 * Add one Account per new key in keyFile to the config at configPath.
 * Keys already present as literal sources, or repeated in the file, are skipped; existing Accounts never change.
 * Same-Provider Accounts whose key is still a placeholder are removed.
 * Returns { added: [ids], skipped: [line numbers], removed: [placeholder ids], dryRun }.
 * The config is written atomically, only if it stays valid, only if something changed, and never on a dry run.
 */
export function importKeyFile(configPath, { provider, keyFile, allocation, like, idPrefix = provider, dryRun = false }) {
  const config = readConfigFile(configPath);
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  let allocations = allocation ? [allocation] : null;
  if (like !== undefined) {
    const template = accounts.find((a) => a.id === like && a.provider === provider);
    if (!template) throw new Error(`No ${provider} Account "${like}" to copy Allocations from`);
    allocations = template.allocations;
  }
  const literalKeysInConfig = new Set(accounts.map((a) => literalKeyOf(a.apiKey)).filter(Boolean));
  const newKeys = [];
  const skipped = [];
  for (const entry of readKeys(keyFile, provider)) {
    if (literalKeysInConfig.has(entry.key)) { skipped.push(entry.line); continue; }
    literalKeysInConfig.add(entry.key);
    newKeys.push(entry.key);
  }
  const removed = accounts.filter((a) => a.provider === provider && isPlaceholderSource(a.apiKey)).map((a) => a.id);
  const kept = accounts.filter((a) => !removed.includes(a.id));
  const ids = nextIds(new Set(kept.map((a) => a.id)), idPrefix, newKeys.length);
  const added = newKeys.map((key, i) => ({ id: ids[i], provider, apiKey: literalSourceOf(key), allocations: structuredClone(allocations) }));
  const next = { ...config, accounts: [...kept, ...added] };
  validateConfig(next);
  if (!dryRun && (added.length || removed.length)) saveConfig(configPath, next);
  return { added: ids, skipped, removed, dryRun };
}

/** The lines the CLI prints for an import result. */
export function importReport({ provider, added, skipped, removed, dryRun }) {
  const changed = added.length > 0 || removed.length > 0;
  const [add, skip, remove] = dryRun ? ['Would add', 'Would skip', 'Would remove'] : ['Added', 'Skipped', 'Removed'];
  const lines = [];
  if (dryRun) lines.push('Dry run: nothing was written');
  else if (!changed) lines.push('Nothing to change; the config was not written');
  lines.push(`${add} ${added.length} ${provider} Accounts: ${added.join(', ') || '(none)'}`);
  if (skipped.length) lines.push(`${skip} ${skipped.length} keys already in the config or repeated in the file (lines ${skipped.join(', ')})`);
  if (removed.length) lines.push(`${remove} placeholder Accounts: ${removed.join(', ')}`);
  if (dryRun) return lines;
  if (changed) lines.push('Run /reload in pi (or restart "serve") to apply the changes.');
  lines.push('The keys are stored in the private config; you may delete the key file.');
  return lines;
}
