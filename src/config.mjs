import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

export const APP_NAME = 'pi-dual-key-manager';
export const VERSION = '0.2.0';
/** Environment variable that carries the local gateway token to pi-web-access ("exaApiKey": "$PI_SEARCH_BROKER_TOKEN"). */
export const TOKEN_ENV = 'PI_SEARCH_BROKER_TOKEN';
/** Optional override for the broker config path (used by the CLI default and the pi extension). */
export const CONFIG_ENV = 'PI_SEARCH_BROKER_CONFIG';
export const DEFAULT_DIR = join(homedir(), '.config', APP_NAME);
export const DEFAULT_CONFIG = join(DEFAULT_DIR, 'config.json');

/** pi-web-access's built-in Tavily key pool (TAVILY_API_KEY_1..20). */
export const TAVILY_POOL_VARS = Object.freeze(Array.from({ length: 20 }, (_, i) => `TAVILY_API_KEY_${i + 1}`));

export const DEFAULTS = Object.freeze({
  totalTimeoutMs: 50000,
  maxTransientRetries: 2,
  reconcileIntervalMs: 0 // balance checks are optional: off unless configured
});

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const goodDate = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && /(?:Z|[+-]\d\d:\d\d)$/.test(s);
const PLACEHOLDER = /REPLACE|CHANGE_ME|YOUR_KEY/i;
const ENV_SOURCE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

/** Environment variable name of a "$NAME" / "${NAME}" source, or null. Same syntax as pi and pi-web-access. */
export function parseEnvSource(source) {
  const match = typeof source === 'string' ? source.trim().match(ENV_SOURCE) : null;
  return match ? match[1] ?? match[2] : null;
}

/** Every secret the broker holds, for redaction. */
export function secretsOf(config) {
  return [config.gateway.token, ...config.accounts.flatMap((a) => [a.apiKey, a.adminKey].filter(Boolean))];
}

export function defaultConfigPath(env = process.env) {
  return env[CONFIG_ENV] || DEFAULT_CONFIG;
}

function defaultRunCommand(command) {
  return execSync(command, {
    encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

/**
 * Resolve a secret using the same source syntax as pi and pi-web-access:
 * "$NAME" / "${NAME}" reads an environment variable, "!command" runs a trusted local command,
 * "$$..." / "$!..." escape a literal leading "$" / "!", anything else is a literal.
 * Errors never include the secret value or the command text.
 */
export function resolveSecret(value, label, { env = process.env, runCommand = defaultRunCommand } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`);
  const source = value.trim();
  if (source.startsWith('$$') || source.startsWith('$!')) return source.slice(1);
  if (source.startsWith('!')) {
    const command = source.slice(1).trim();
    if (!command) throw new Error(`Empty command source for ${label}`);
    let out;
    try { out = runCommand(command); } catch { throw new Error(`Command source for ${label} failed`); }
    const resolved = String(out ?? '').trim();
    if (!resolved || /[\0-\x1f\x7f]/.test(resolved)) throw new Error(`Command source for ${label} produced no usable single-line value`);
    return resolved;
  }
  if (source.startsWith('$')) {
    const name = parseEnvSource(source);
    if (!name) throw new Error(`Malformed environment source for ${label}`);
    const resolved = env[name]?.trim();
    if (!resolved) throw new Error(`Environment variable ${name} for ${label} is empty or unset`);
    return resolved;
  }
  return source;
}

function intInRange(value, name, min, max, fallback, { allowZero = false } = {}) {
  if (value === undefined) return fallback;
  if (allowZero && value === 0) return 0;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer ${allowZero ? '0 or ' : ''}${min}..${max}`);
  }
  return value;
}

export function validateConfig(input, secretOptions = {}) {
  if (!isObj(input)) throw new Error('Config must be an object');
  const gateway = input.gateway;
  if (!isObj(gateway)) throw new Error('Missing gateway settings');
  if (gateway.host !== '127.0.0.1' && gateway.host !== '::1' && gateway.host !== 'localhost') {
    throw new Error('Gateway host must be loopback only');
  }
  if (!Number.isInteger(gateway.port) || gateway.port < 1024 || gateway.port > 65535) {
    throw new Error('Gateway port must be 1024..65535');
  }
  if (typeof gateway.token !== 'string' || gateway.token.length < 24 || /REPLACE|CHANGE_ME/i.test(gateway.token) || /[^\x21-\x7e]/.test(gateway.token)) {
    throw new Error('gateway.token must be a secure random secret of 24+ printable characters');
  }
  if (!Array.isArray(input.accounts) || input.accounts.length === 0) throw new Error('Add at least one account');
  const ids = new Set();
  const keys = new Set();
  const accounts = [];
  for (const account of input.accounts) {
    if (!isObj(account)) throw new Error('Each account must be an object');
    if (typeof account.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(account.id)) {
      throw new Error('Invalid account id: use letters, digits, _, - (max 64)');
    }
    if (ids.has(account.id)) throw new Error(`Duplicate account id: ${account.id}`);
    ids.add(account.id);
    if (!['exa', 'tavily'].includes(account.provider)) throw new Error(`Invalid provider on ${account.id}`);
    const apiKey = resolveSecret(account.apiKey, `apiKey of ${account.id}`, secretOptions);
    if (apiKey.length < 8 || PLACEHOLDER.test(apiKey)) throw new Error(`Missing real apiKey for ${account.id}`);
    if (keys.has(apiKey)) throw new Error(`Duplicate apiKey (possible shared quota) for ${account.id}`);
    keys.add(apiKey);
    let adminKey;
    if (account.adminKey !== undefined) {
      if (account.provider !== 'exa') throw new Error(`adminKey is only supported for Exa accounts (${account.id})`);
      adminKey = resolveSecret(account.adminKey, `adminKey of ${account.id}`, secretOptions);
      if (PLACEHOLDER.test(adminKey)) throw new Error(`Missing real adminKey for ${account.id}`);
    }
    if (account.projectId !== undefined) {
      if (account.provider !== 'tavily') throw new Error(`projectId is only supported for Tavily accounts (${account.id})`);
      if (typeof account.projectId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(account.projectId)) {
        throw new Error(`Invalid projectId on ${account.id}`);
      }
    }
    if (account.reconcile !== undefined && typeof account.reconcile !== 'boolean') {
      throw new Error(`reconcile must be true/false on ${account.id}`);
    }
    if (!Array.isArray(account.allocations) || !account.allocations.length) throw new Error(`Missing allocations for ${account.id}`);
    const bucketIds = new Set();
    for (const bucket of account.allocations) {
      if (!isObj(bucket) || typeof bucket.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(bucket.id)) {
        throw new Error(`Invalid allocation id for ${account.id}`);
      }
      if (bucketIds.has(bucket.id)) throw new Error(`Duplicate allocation ${bucket.id} for ${account.id}`);
      bucketIds.add(bucket.id);
      if (typeof bucket.limit !== 'number' || !Number.isFinite(bucket.limit) || bucket.limit <= 0) {
        throw new Error(`Invalid allocation limit ${account.id}/${bucket.id}`);
      }
      if (!['monthly', 'once'].includes(bucket.period)) throw new Error(`Invalid period on ${account.id}/${bucket.id}`);
      if (bucket.startsAt !== undefined && !goodDate(bucket.startsAt)) {
        throw new Error(`Invalid ISO startsAt on ${account.id}/${bucket.id}`);
      }
      if (bucket.expiresAt !== undefined && !goodDate(bucket.expiresAt)) {
        throw new Error(`Invalid ISO expiresAt on ${account.id}/${bucket.id}`);
      }
      if (bucket.resetDay !== undefined && (bucket.period !== 'monthly' || !Number.isInteger(bucket.resetDay) || bucket.resetDay < 1 || bucket.resetDay > 28)) {
        throw new Error(`resetDay must be 1..28 for monthly allocation ${account.id}/${bucket.id}`);
      }
      if (bucket.period === 'once' && !bucket.expiresAt && bucket.expires !== 'never') {
        throw new Error(`One-time allocation needs expiresAt (or "expires": "never") on ${account.id}/${bucket.id}`);
      }
    }
    accounts.push({ ...account, apiKey, ...(adminKey ? { adminKey } : {}) });
  }
  // attemptTimeoutMs is an optional global override; per-route defaults live in providers.mjs.
  const attemptTimeoutMs = intInRange(input.attemptTimeoutMs, 'attemptTimeoutMs', 1000, 55000, undefined);
  const totalTimeoutMs = intInRange(input.totalTimeoutMs, 'totalTimeoutMs', 1000, 55000, DEFAULTS.totalTimeoutMs);
  const maxTransientRetries = intInRange(input.maxTransientRetries, 'maxTransientRetries', 0, 5, DEFAULTS.maxTransientRetries, { allowZero: true });
  const reconcileIntervalMs = intInRange(input.reconcileIntervalMs, 'reconcileIntervalMs', 120000, 86400000, DEFAULTS.reconcileIntervalMs, { allowZero: true });
  if (input.pi !== undefined && !isObj(input.pi)) throw new Error('pi settings must be an object');
  const pi = { wireEnvironment: true, ...(input.pi ?? {}) };
  if (typeof pi.wireEnvironment !== 'boolean') throw new Error('pi.wireEnvironment must be true/false');
  // One spelling of the loopback host, so listen, wiring, the fragment and doctor all build the same base URL.
  const host = gateway.host === 'localhost' ? '127.0.0.1' : gateway.host;
  return { ...input, gateway: { ...gateway, host }, accounts, attemptTimeoutMs, totalTimeoutMs, maxTransientRetries, reconcileIntervalMs, pi };
}

export function loadConfig(path = defaultConfigPath(), secretOptions = {}) {
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') throw Object.assign(new Error(`Missing config; run npm run init first: ${path}`), { code: 'ENOCONFIG' });
    throw new Error('Unable to read/parse private config; check path, permissions and JSON syntax');
  }
  return validateConfig(config, secretOptions);
}

export function webSearchFragment(gateway) {
  const base = `http://${gateway.host === '::1' ? '[::1]' : gateway.host}:${gateway.port}`;
  return {
    exaApiKey: `$${TOKEN_ENV}`,
    exaBaseUrl: `${base}/exa`,
    tavilyApiKey: `$${TOKEN_ENV}`,
    tavilyBaseUrl: `${base}/tavily`,
    searchRouting: { providers: ['exa', 'tavily'], fallbackOn: ['quota', 'transient', 'network', 'invalid-response', 'empty'] },
    workflow: 'none'
  };
}

export function writeFirstConfig(path = defaultConfigPath()) {
  if (existsSync(path)) throw new Error(`Config already exists: ${path}. Refusing to overwrite.`);
  if (existsSync(join(dirname(path), 'web-search.fragment.json'))) {
    throw new Error('Existing web-search.fragment.json found; refusing to generate mismatched token. Move it safely first.');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const example = {
    gateway: { host: '127.0.0.1', port: 19473, token },
    accounts: [
      { id: 'exa-promo-01', provider: 'exa', apiKey: 'REPLACE_EXA_KEY', allocations: [
        { id: 'promo', limit: 60, period: 'once', expiresAt: '2026-12-01T00:00:00Z' },
        { id: 'free', limit: 10, period: 'monthly', startsAt: '2026-12-01T00:00:00Z' }
      ] },
      { id: 'tavily-free-01', provider: 'tavily', apiKey: 'REPLACE_TAVILY_KEY', allocations: [
        { id: 'free', limit: 1000, period: 'monthly' }
      ] }
    ]
  };
  writeFileSync(path, JSON.stringify(example, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  const out = join(dirname(path), 'web-search.fragment.json');
  writeFileSync(out, JSON.stringify(webSearchFragment(example.gateway), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  chmodSync(out, 0o600);
  return { configPath: path, fragmentPath: out };
}

export function defaultStatePath(configPath = defaultConfigPath()) { return join(dirname(configPath), 'state.json'); }
export function monthlyWindow(nowMs, resetDay = 1) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const thisReset = Date.UTC(y, m, resetDay);
  const currentStart = nowMs >= thisReset ? thisReset : Date.UTC(y, m - 1, resetDay);
  const nextReset = nowMs >= thisReset ? Date.UTC(y, m + 1, resetDay) : thisReset;
  return { key: new Date(currentStart).toISOString().slice(0, 10), nextReset };
}
