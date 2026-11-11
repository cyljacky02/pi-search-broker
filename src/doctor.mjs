// pi-web-access wiring: "is pi-web-access actually going through the broker?" checks, and filling in the key settings
// web-search.json lacks (addBrokerKeySources, used by the host on first start).
// Mirrors pi-web-access 0.47.0 resolution rules (docs/research/pi-web-access.md §2-§4).
// Never prints secret values: only "set / not set / matches the broker token".
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_ENV, TAVILY_POOL_VARS, PROVIDER_NAMES, parseEnvSource } from './config.mjs';
import { PROVIDERS } from './providers.mjs';
import { baseUrl } from './control.mjs';
import { atomicWriteJson } from './files.mjs';

/** Same order as pi-web-access getWebSearchConfigDir(). */
export function piWebSearchConfigPath(env = process.env, home = homedir()) {
  if (env.PI_CODING_AGENT_DIR) return join(env.PI_CODING_AGENT_DIR, 'web-search.json');
  const legacy = join(home, '.pi', 'web-search.json');
  if (env.XDG_CONFIG_HOME) {
    const xdg = join(env.XDG_CONFIG_HOME, 'pi', 'web-search.json');
    if (existsSync(xdg)) return xdg;
    if (existsSync(legacy)) return legacy;
    return xdg;
  }
  const agent = join(home, '.pi', 'agent', 'web-search.json');
  if (existsSync(agent)) return agent;
  if (existsSync(legacy)) return legacy;
  return agent;
}

/** Parsed web-search.json ({} when missing); throws on invalid JSON. */
export function readPiWebSearchConfig(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

/**
 * Point pi-web-access's missing (absent, null or empty) Exa / Tavily key settings at the broker token
 * ("$PI_SEARCH_BROKER_TOKEN"), creating web-search.json if needed. A setting that has a value is never changed. Returns the names it added; throws on
 * invalid JSON without writing.
 */
export function addBrokerKeySources(path) {
  const pi = readPiWebSearchConfig(path);
  const missing = KEY_FIELDS.map((f) => f.cfgKey).filter((name) => pi[name] === undefined || pi[name] === null || (typeof pi[name] === 'string' && !pi[name].trim()));
  if (!missing.length) return [];
  atomicWriteJson(path, { ...pi, ...Object.fromEntries(missing.map((name) => [name, `$${TOKEN_ENV}`])) });
  return missing;
}

/** Describe how pi-web-access would resolve a provider key, without revealing it. */
export function describeKey(configValue, envName, env, token) {
  const value = typeof configValue === 'string' ? configValue.trim() : '';
  if (value.startsWith('$$') || value.startsWith('$!')) {
    return { source: 'escaped literal in web-search.json', matches: value.slice(1) === token };
  }
  if (value.startsWith('!')) return { source: 'command source in web-search.json', matches: null };
  if (value.startsWith('$')) {
    const name = parseEnvSource(value);
    if (!name) return { source: 'malformed $ source in web-search.json', matches: false };
    const resolved = env[name]?.trim();
    return { source: `environment variable ${name}`, matches: resolved ? resolved === token : false, unset: !resolved };
  }
  const fromEnv = env[envName]?.trim();
  if (fromEnv) {
    return { source: value ? `${envName} (overrides the plain value in web-search.json)` : envName, matches: fromEnv === token };
  }
  if (value) return { source: 'plain value in web-search.json', matches: value === token };
  return { source: 'none', matches: false, unset: true };
}

const KEY_FIELDS = Object.freeze([
  { provider: 'exa', envKey: 'EXA_API_KEY', cfgKey: 'exaApiKey' },
  { provider: 'tavily', envKey: 'TAVILY_API_KEY', cfgKey: 'tavilyApiKey' }
]);

/**
 * Key-resolution and key-pool problems that keep pi-web-access from authenticating to the broker.
 * Shared by `doctor` and the pi extension's startup warnings.
 */
export function piWiringIssues(pi, env, token) {
  const issues = [];
  for (const { provider, envKey, cfgKey } of KEY_FIELDS) {
    const key = describeKey(pi[cfgKey], envKey, env, token);
    const fix = `set "${cfgKey}": "$${TOKEN_ENV}" in web-search.json`;
    if (key.matches === true) continue;
    if (key.matches === null) issues.push({ level: 'info', message: `${provider}: key comes from a ${key.source}; make sure it prints the broker token` });
    else if (key.unset && provider === 'exa') issues.push({ level: 'error', message: `${provider}: no key resolves (${key.source}); pi-web-access will silently use the keyless Exa MCP endpoint and bypass the broker. Fix: ${fix}` });
    else if (key.unset) issues.push({ level: 'error', message: `${provider}: no key resolves (${key.source}); Tavily will be unavailable. Fix: ${fix}` });
    else issues.push({ level: 'error', message: `${provider}: key from ${key.source} is NOT the broker token; the broker will answer 401 and pi will not fall back. Fix: ${fix}` });
  }
  const pool = TAVILY_POOL_VARS.filter((name) => env[name]);
  if (pool.length) issues.push({ level: 'warn', message: `${pool.length} TAVILY_API_KEY_n variable(s) set; pi-web-access sends those real keys to the broker first (each gets 401). Unset them.` });
  return issues;
}

/** Explain an identified Broker whose authenticated control cannot be used, without exposing credentials. */
export function gatewayControlIssue(health, base, mode) {
  if (health.state !== 'running') return null;
  if (mode === 'offline') {
    return `Gateway at ${base} identifies as the Broker, but this control is offline. Reconnect and retry.`;
  }
  if (health.control === 'unauthorized') {
    return `Gateway at ${base} identifies as the Broker but rejected this process's Gateway token. Make gateway.token match the port owner's trusted config, then reload or restart the client.`;
  }
  if (health.control === 'unavailable') {
    return `Gateway at ${base} identifies as the Broker, but authenticated control is unavailable. Check the Gateway and retry.`;
  }
  return null;
}

/**
 * Check the broker config, the running gateway and pi-web-access's wiring, as seen from `env`.
 * @param config       the loaded broker config, or undefined when loading failed (then pass configError)
 * @param control      a broker control (control.mjs) used for the gateway health check
 * @param startFailure the issue from this process's failed Gateway start ({ level, message }), if any
 */
export async function runDoctor({ config, configError, control, env = process.env, home = homedir(), startFailure = null }) {
  const checks = [];
  const add = (level, message) => checks.push({ level, message });

  if (!config) {
    add('error', `Broker config: ${configError ?? 'not loaded'}`);
    return checks;
  }
  const inConfig = PROVIDER_NAMES.map((p) => `${config.accounts.filter((a) => a.provider === p).length} ${PROVIDERS[p].label}`).join(' and ');
  add('ok', `Broker config structure valid: ${inConfig} account(s) in config.json`);
  add('info', 'Key files and provider credentials are read only at local Gateway startup; doctor reads neither.');
  if (config.attemptTimeoutMs !== undefined && config.attemptTimeoutMs < 20000) {
    add('warn', `attemptTimeoutMs is ${config.attemptTimeoutMs} ms; slow searches will time out. Remove it to use the 30 s per-route default.`);
  }

  const base = baseUrl(config);
  const health = await control.health();
  const controlIssue = gatewayControlIssue(health, base, control.mode);
  if (controlIssue) add('error', controlIssue);
  else if (health.state === 'running') add('ok', `Gateway is running at ${base} (version ${health.version ?? '?'})`);
  else if (health.state === 'other') add('error', `Something else answers on ${base}; change gateway.port`);
  else if (startFailure) add(startFailure.level === 'error' ? 'error' : 'warn', `This pi process could not start the Gateway: ${startFailure.message}`);
  else add('warn', `Gateway is not running at ${base}. Start pi with the extension installed, or run "npm start".`);
  try {
    const { accounts } = await control.status();
    const counts = PROVIDER_NAMES.map((p) => `${accounts.filter((a) => a.provider === p).length} ${PROVIDERS[p].label}`).join(' and ');
    const when = health.state === 'running' ? 'serving now' : 'as of the last Gateway start';
    add('info', `Accounts including key files (${when}): ${counts}`);
  } catch { /* status needs a reachable, authorized Gateway or a readable state file */ }

  const piPath = piWebSearchConfigPath(env, home);
  let pi;
  try { pi = readPiWebSearchConfig(piPath); }
  catch { add('error', `pi-web-access config is not valid JSON: ${piPath}`); return checks; }
  add(existsSync(piPath) ? 'ok' : 'info', existsSync(piPath) ? `pi-web-access config: ${piPath}` : `No pi-web-access config at ${piPath}; pi uses defaults.`);

  for (const provider of ['exa', 'tavily']) {
    const envBase = `${provider.toUpperCase()}_BASE_URL`;
    const cfgBase = `${provider}BaseUrl`;
    const expected = `${base}/${provider}`;
    const effective = (env[envBase] ?? pi[cfgBase] ?? '').replace(/\/+$/, '');
    const where = env[envBase] !== undefined ? envBase : pi[cfgBase] ? `${cfgBase} in web-search.json` : 'default';
    if (effective === expected) add('ok', `${provider}: base URL points at the broker (${where})`);
    else add('error', `${provider}: base URL does not point at the broker (${where}); expected ${expected}`);
  }
  const issues = piWiringIssues(pi, env, config.gateway.token);
  for (const { provider } of KEY_FIELDS) {
    if (!issues.some((i) => i.message.startsWith(`${provider}:`))) add('ok', `${provider}: key resolves to the broker token`);
  }
  for (const issue of issues) add(issue.level, issue.message);

  const top = pi.searchProvider ?? pi.provider;
  if (top !== undefined && top !== 'auto') add('warn', `Top-level "${pi.searchProvider !== undefined ? 'searchProvider' : 'provider'}" is set; it overrides searchRouting and disables cross-provider fallback.`);
  const fallbackOn = pi.searchRouting?.fallbackOn;
  if (Array.isArray(fallbackOn)) {
    const missing = ['quota', 'transient'].filter((k) => !fallbackOn.includes(k));
    if (missing.length) add('warn', `searchRouting.fallbackOn lacks ${missing.join(' and ')}; broker exhaustion (429/503/504) will not fall back to the other provider.`);
  }
  const fetchProviders = pi.fetchRouting?.providers;
  if (!Array.isArray(fetchProviders) || !fetchProviders.includes('exa')) {
    add('info', 'fetch_content does not use Exa /contents (fetchRouting.providers lacks "exa"); only search traffic goes through the broker.');
  }
  if (!env[TOKEN_ENV] && [pi.exaApiKey, pi.tavilyApiKey].some((v) => typeof v === 'string' && v.includes(TOKEN_ENV))) {
    add('warn', `web-search.json references $${TOKEN_ENV}, but it is not set in this shell (the pi extension sets it inside pi).`);
  }
  return checks;
}

export function formatChecks(checks) {
  const tag = { ok: '[ok]   ', info: '[info] ', warn: '[warn] ', error: '[FAIL] ' };
  return checks.map((c) => `${tag[c.level] ?? ''}${c.message}`).join('\n');
}
