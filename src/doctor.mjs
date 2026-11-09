// "Is pi-web-access actually going through the broker?" checks.
// Mirrors pi-web-access 0.47.0 resolution rules (docs/research/pi-web-access.md §2-§4).
// Never prints secret values: only "set / not set / matches the broker token".
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_NAME, TOKEN_ENV, TAVILY_POOL_VARS, loadConfig, parseEnvSource } from './config.mjs';
import { baseUrl } from './client.mjs';

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

export async function runDoctor({ configPath, env = process.env, home = homedir(), fetchImpl = fetch } = {}) {
  const checks = [];
  const add = (level, message) => checks.push({ level, message });

  let config;
  try {
    config = loadConfig(configPath, { env });
    const byProvider = (p) => config.accounts.filter((a) => a.provider === p).length;
    add('ok', `Broker config valid: ${byProvider('exa')} Exa and ${byProvider('tavily')} Tavily account(s)`);
  } catch (err) {
    add('error', `Broker config: ${err.message}`);
    return checks;
  }
  if (config.attemptTimeoutMs !== undefined && config.attemptTimeoutMs < 20000) {
    add('warn', `attemptTimeoutMs is ${config.attemptTimeoutMs} ms; slow searches will time out. Remove it to use the 30 s per-route default.`);
  }

  const base = baseUrl(config);
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    const data = res.ok ? await res.json() : null;
    if (data?.service === APP_NAME) add('ok', `Gateway is running at ${base} (version ${data.version ?? '?'})`);
    else add('error', `Something else answers on ${base}; change gateway.port`);
  } catch {
    add('warn', `Gateway is not running at ${base}. Start pi with the extension installed, or run "npm start".`);
  }

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
