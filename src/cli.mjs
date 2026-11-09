#!/usr/bin/env node
import { defaultConfigPath, loadConfig, writeFirstConfig, defaultStatePath, webSearchFragment } from './config.mjs';
import { createGateway } from './gateway.mjs';
import { AccountManager } from './manager.mjs';
import { baseUrl } from './host.mjs';
import { statusReport } from './format.mjs';
import { runDoctor, formatChecks } from './doctor.mjs';
import { redact } from './providers.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
function configArg() {
  const i = args.indexOf('--config');
  return i < 0 ? defaultConfigPath() : args[i + 1];
}
const positional = () => {
  const out = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--config') { i++; continue; }
    out.push(args[i]);
  }
  return out;
};
function usage() {
  console.log(`Pi Search Broker (Node 20.3+, no dependencies)
  node src/cli.mjs init [--config /path/to/config.json]
  node src/cli.mjs serve [--config ...]
  node src/cli.mjs status [--config ...]
  node src/cli.mjs doctor [--config ...]           check that pi-web-access really uses the broker
  node src/cli.mjs reconcile [ACCOUNT_ID] [--config ...]
  node src/cli.mjs enable ACCOUNT_ID [--config ...]
  node src/cli.mjs disable ACCOUNT_ID [--config ...]
  node src/cli.mjs set-spent ACCOUNT_ID ALLOCATION_ID AMOUNT [--config ...]
  node src/cli.mjs fragment [--config ...]         print the web-search.json settings for standalone use

The config path defaults to $PI_SEARCH_BROKER_CONFIG or ~/.config/pi-dual-key-manager/config.json.
enable/disable/set-spent/reconcile talk to the running gateway over authenticated loopback HTTP.
Never paste real provider API keys into shell commands or logs.`);
}
async function call(config, method, path, body) {
  const res = await fetch(`${baseUrl(config)}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.gateway.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gateway request failed: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
  return data;
}

let secrets = [];
try {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') usage();
  else if (cmd === 'init') {
    const result = writeFirstConfig(configArg());
    console.log('Created private config:', result.configPath);
    console.log('Created Pi web-search fragment:', result.fragmentPath);
    console.log('Edit the config: replace placeholders, adjust expiry/limits, duplicate account records as needed.');
    console.log('Then install the pi extension (recommended) or run "npm start" and merge the fragment (see README).');
  } else if (cmd === 'doctor') {
    const checks = await runDoctor({ configPath: configArg() });
    console.log(formatChecks(checks));
    if (checks.some((c) => c.level === 'error')) process.exitCode = 1;
  } else {
    const path = configArg();
    const config = loadConfig(path);
    secrets = [config.gateway.token, ...config.accounts.flatMap((a) => [a.apiKey, a.adminKey].filter(Boolean))];
    const [id, allocationId, amount] = positional();
    if (cmd === 'serve') {
      const { server } = createGateway(config, {
        statePath: defaultStatePath(path),
        logger: (line) => console.log(`${new Date().toISOString()} ${line}`)
      });
      server.on('error', (err) => {
        console.error(err.code === 'EADDRINUSE' ? `Port ${config.gateway.port} is already in use (is the broker already running in pi?)` : `Server error: ${err.message}`);
        process.exitCode = 1;
      });
      server.listen(config.gateway.port, config.gateway.host, () => {
        console.log(`Gateway listening on ${config.gateway.host}:${config.gateway.port} (loopback only)`);
        console.log('Exa accounts:', config.accounts.filter((a) => a.provider === 'exa').length);
        console.log('Tavily accounts:', config.accounts.filter((a) => a.provider === 'tavily').length);
      });
    } else if (cmd === 'status') {
      let snapshot;
      let mode = 'live';
      try { snapshot = await call(config, 'GET', '/status'); }
      catch {
        // Gateway not running: read the persisted state without writing to it.
        snapshot = new AccountManager(config, { statePath: defaultStatePath(path), readOnly: true }).snapshot();
        mode = 'offline, from state.json';
      }
      console.log(statusReport(snapshot, { mode, url: baseUrl(config) }));
    } else if (cmd === 'reconcile') {
      const { results } = await call(config, 'POST', '/admin/reconcile', id ? { id } : {});
      for (const r of results) console.log(`${r.id}: ${r.error ?? r.skipped ?? `~${r.remaining} remaining`}`);
    } else if (cmd === 'enable' || cmd === 'disable') {
      if (!id) throw new Error('Account id required');
      await call(config, 'POST', `/admin/${cmd}`, { id });
      console.log(`OK: ${cmd} ${id}`);
    } else if (cmd === 'set-spent') {
      if (!id || !allocationId || amount === undefined) throw new Error('Usage: set-spent ACCOUNT_ID ALLOCATION_ID AMOUNT');
      await call(config, 'POST', '/admin/set-spent', { id, allocationId, spent: Number(amount) });
      console.log(`OK: set-spent ${id}`);
    } else if (cmd === 'fragment') {
      console.log(JSON.stringify(webSearchFragment(config.gateway), null, 2));
    } else usage();
  }
} catch (err) {
  // Config values (including API keys) are never printed here.
  console.error('Error:', redact(err.message, secrets));
  process.exitCode = 1;
}
