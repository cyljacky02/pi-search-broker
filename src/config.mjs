import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { atomicWriteJson } from './files.mjs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

/** Product name, reported as the gateway's /health service id. */
export const SERVICE_NAME = 'pi-search-broker';
/** The broker's folder inside pi's agent dir: config.json, key files and saved state live there. */
export const CONFIG_DIR_NAME = SERVICE_NAME;
export const VERSION = '0.6.2';
/** Environment variable that carries the local gateway token to pi-web-access ("exaApiKey": "$PI_SEARCH_BROKER_TOKEN"). */
export const TOKEN_ENV = 'PI_SEARCH_BROKER_TOKEN';
/** Optional override for the broker config path (used by the CLI default and the pi extension). */
export const CONFIG_ENV = 'PI_SEARCH_BROKER_CONFIG';
/** pi's own override for its agent dir (default ~/.pi/agent), which also holds web-search.json. */
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** The Providers the broker can forward to. */
export const PROVIDER_NAMES = Object.freeze(['exa', 'tavily']);

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

/** Whether a resolved key could be a real Provider key: long enough and not an example value. */
export function isRealKey(key) {
  return typeof key === 'string' && key.length >= 8 && !PLACEHOLDER.test(key);
}

/** Whether a value contains control characters, so it cannot be a single-line secret. */
export const hasControlCharacters = (value) => /[\0-\x1f\x7f]/.test(value);

/**
 * The key a literal source stands for ("$$x" -> "$x", "$!x" -> "!x", "x" -> "x"), or null for an
 * environment or command source, which only resolveSecret may resolve.
 */
export function literalKeyOf(source) {
  if (typeof source !== 'string') return null;
  const s = source.trim();
  if (s.startsWith('$$') || s.startsWith('$!')) return s.slice(1);
  return /^[$!]/.test(s) ? null : s;
}

/** The literal source for a key, escaping a leading $ or ! so it is never read as an env or command source. */
export const literalSourceOf = (key) => (/^[$!]/.test(key) ? `$${key}` : key);

/** Whether a credential source is still an unedited example value, such as the REPLACE_… keys older `init`s wrote. */
export function isPlaceholderSource(source) {
  const key = literalKeyOf(source);
  return key !== null && PLACEHOLDER.test(key);
}

/** Every secret the broker holds, for redaction. */
export function secretsOf(config) {
  return [config.gateway.token, ...config.accounts.flatMap((a) => [a.apiKey, a.adminKey].filter(Boolean))];
}

/** $PI_SEARCH_BROKER_CONFIG, else <pi agent dir>/pi-search-broker/config.json (pi's agent dir: ~/.pi/agent). */
export function defaultConfigPath(env = process.env) {
  if (env[CONFIG_ENV]) return env[CONFIG_ENV];
  return join(env[PI_AGENT_DIR_ENV] || join(homedir(), '.pi', 'agent'), CONFIG_DIR_NAME, 'config.json');
}

function defaultRunCommand(command) {
  return execSync(command, {
    encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

function secretSource(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`);
  const source = value.trim();
  if (source.startsWith('!') && !source.slice(1).trim()) throw new Error(`Empty command source for ${label}`);
  if (source.startsWith('$') && !source.startsWith('$$') && !source.startsWith('$!') && !parseEnvSource(source)) {
    throw new Error(`Malformed environment source for ${label}`);
  }
  return source;
}

/**
 * Resolve a secret using the same source syntax as pi and pi-web-access:
 * "$NAME" / "${NAME}" reads an environment variable, "!command" runs a trusted local command,
 * "$$..." / "$!..." escape a literal leading "$" / "!", anything else is a literal.
 * Errors never include the secret value or the command text.
 */
export function resolveSecret(value, label, { env = process.env, runCommand = defaultRunCommand } = {}) {
  const source = secretSource(value, label);
  const literal = literalKeyOf(source);
  if (literal !== null) return literal;
  if (source.startsWith('!')) {
    const command = source.slice(1).trim();
    let out;
    try { out = runCommand(command); } catch { throw new Error(`Command source for ${label} failed`); }
    const resolved = String(out ?? '').trim();
    if (!resolved || hasControlCharacters(resolved)) throw new Error(`Command source for ${label} produced no usable single-line value`);
    return resolved;
  }
  const name = parseEnvSource(source);
  const resolved = env[name]?.trim();
  if (!resolved) throw new Error(`Environment variable ${name} for ${label} is empty or unset`);
  return resolved;
}

function intInRange(value, name, min, max, fallback, { allowZero = false } = {}) {
  if (value === undefined) return fallback;
  if (allowZero && value === 0) return 0;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer ${allowZero ? '0 or ' : ''}${min}..${max}`);
  }
  return value;
}

/**
 * Validate one Allocation's limit, period and dates (not its id). `where` names it in errors:
 * "exa-1/promo" in config.json, or "allocation promo" on a key file's settings line.
 */
export function validateAllocation(bucket, where) {
  if (typeof bucket.limit !== 'number' || !Number.isFinite(bucket.limit) || bucket.limit <= 0) {
    throw new Error(`Invalid allocation limit ${where}`);
  }
  if (!['monthly', 'once'].includes(bucket.period)) throw new Error(`Invalid period on ${where}`);
  if (bucket.startsAt !== undefined && !goodDate(bucket.startsAt)) throw new Error(`Invalid ISO startsAt on ${where}`);
  if (bucket.expiresAt !== undefined && !goodDate(bucket.expiresAt)) throw new Error(`Invalid ISO expiresAt on ${where}`);
  if (bucket.resetDay !== undefined && (bucket.period !== 'monthly' || !Number.isInteger(bucket.resetDay) || bucket.resetDay < 1 || bucket.resetDay > 28)) {
    throw new Error(`resetDay must be 1..28 for monthly allocation ${where}`);
  }
  if (bucket.period === 'once' && !bucket.expiresAt && bucket.expires !== 'never') {
    throw new Error(`One-time allocation needs expiresAt (or "expires": "never") on ${where}`);
  }
}

/** Validate and normalize metadata and credential source syntax, without reading secrets or running commands. */
export function validateConfig(input) {
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
  // Accounts may also come from key files (keys.mjs), so config.json may list none.
  if (input.accounts !== undefined && !Array.isArray(input.accounts)) throw new Error('accounts must be a list');
  const ids = new Set();
  const accounts = [];
  for (const account of input.accounts ?? []) {
    if (!isObj(account)) throw new Error('Each account must be an object');
    if (typeof account.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(account.id)) {
      throw new Error('Invalid account id: use letters, digits, _, - (max 64)');
    }
    if (ids.has(account.id)) throw new Error(`Duplicate account id: ${account.id}`);
    ids.add(account.id);
    if (!PROVIDER_NAMES.includes(account.provider)) throw new Error(`Invalid provider on ${account.id}`);
    const apiKey = secretSource(account.apiKey, `apiKey of ${account.id}`);
    let adminKey;
    if (account.adminKey !== undefined) {
      if (account.provider !== 'exa') throw new Error(`adminKey is only supported for Exa accounts (${account.id})`);
      adminKey = secretSource(account.adminKey, `adminKey of ${account.id}`);
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
      validateAllocation(bucket, `${account.id}/${bucket.id}`);
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

/** Resolve and validate all Account credentials for local Gateway startup; inspection never calls this. */
export function resolveAccountCredentials(config, secretOptions = {}) {
  const keys = new Set();
  const accounts = config.accounts.map((account) => {
    const apiKey = resolveSecret(account.apiKey, `apiKey of ${account.id}`, secretOptions);
    if (!isRealKey(apiKey)) throw new Error(`Missing real apiKey for ${account.id}`);
    if (keys.has(apiKey)) throw new Error(`Duplicate apiKey (possible shared quota) for ${account.id}`);
    keys.add(apiKey);
    if (account.adminKey === undefined) return { ...account, apiKey };
    const adminKey = resolveSecret(account.adminKey, `adminKey of ${account.id}`, secretOptions);
    if (PLACEHOLDER.test(adminKey)) throw new Error(`Missing real adminKey for ${account.id}`);
    return { ...account, apiKey, adminKey };
  });
  return { ...config, accounts };
}

/** The config file as written, before validation and defaults: what saveConfig should write back. */
export function readConfigFile(path = defaultConfigPath()) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') throw Object.assign(new Error(`Missing config; run npm run init first: ${path}`), { code: 'ENOCONFIG' });
    throw new Error('Unable to read/parse private config; check path, permissions and JSON syntax');
  }
}

/** Read validated metadata. Provider credentials remain sources until a local Gateway starts. */
export function loadConfig(path = defaultConfigPath()) {
  return validateConfig(readConfigFile(path));
}

/** Replace the config file atomically (mode 0600), only if `config` is valid. Never resolves credentials. */
export function saveConfig(path, config) {
  validateConfig(config);
  atomicWriteJson(path, config);
}

/** Remove the given Accounts from the config file, keeping everything else as written. */
export function removeAccounts(path, ids) {
  const config = readConfigFile(path);
  saveConfig(path, { ...config, accounts: (config.accounts ?? []).filter((a) => !ids.includes(a?.id)) });
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

/** The loopback port a new config uses. */
export const DEFAULT_PORT = 19473;

/**
 * Create a private config (mode 0600) with a fresh Gateway token and no Accounts: Accounts come from key files.
 * Never overwrites. `port` is for tests that must not use the real one. Returns the new config.
 */
export function createConfig(path = defaultConfigPath(), { port = DEFAULT_PORT } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const config = { gateway: { host: '127.0.0.1', port, token: randomBytes(32).toString('hex') }, accounts: [] };
  try { writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (err) { throw err.code === 'EEXIST' ? new Error(`Config already exists: ${path}. Refusing to overwrite.`) : err; }
  chmodSync(path, 0o600);
  return config;
}

/** `init`: create the config and the standalone-mode web-search fragment that matches its token. Never overwrites. */
export function writeFirstConfig(path = defaultConfigPath()) {
  if (existsSync(path)) throw new Error(`Config already exists: ${path}. Refusing to overwrite.`);
  const out = join(dirname(path), 'web-search.fragment.json');
  if (existsSync(out)) {
    throw new Error('Existing web-search.fragment.json found; refusing to generate mismatched token. Move it safely first.');
  }
  const config = createConfig(path);
  writeFileSync(out, JSON.stringify(webSearchFragment(config.gateway), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  chmodSync(out, 0o600);
  return { configPath: path, fragmentPath: out };
}

/** Account pool state next to the config. 0.2.x kept v1 state in state.json; see pool/store.mjs for the upgrade. */
export function defaultStatePath(configPath = defaultConfigPath()) { return join(dirname(configPath), 'pool-state.json'); }
