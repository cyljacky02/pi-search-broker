#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { defaultConfigPath, loadConfig, writeFirstConfig, defaultStatePath, webSearchFragment, secretsOf } from './config.mjs';
import { createGateway } from './gateway.mjs';
import { fileStore } from './pool/store.mjs';
import { baseUrl, connectControl } from './control.mjs';
import { runDoctor, formatChecks } from './doctor.mjs';
import { usage, parseCommand, runCommand } from './commands.mjs';
import { redact } from './providers.mjs';

const PREFIX = 'node src/cli.mjs';
// How `status` names where the numbers came from, by control mode.
const STATUS_LABEL = Object.freeze({ 'in-process': 'live', http: 'live', offline: 'offline, from the state file' });
const CLI_ONLY = [
  { name: 'init', args: '', help: 'create a private config (never overwrites)' },
  { name: 'serve', args: '', help: 'run the gateway in the foreground (standalone mode)' },
  { name: 'fragment', args: '', help: 'print the web-search.json settings for standalone use' }
];
const HELP = `Pi Search Broker (Node 20.3+, no dependencies)
${usage(PREFIX, CLI_ONLY)}

Every command accepts --config /path/to/config.json. The default is $PI_SEARCH_BROKER_CONFIG or
~/.config/pi-dual-key-manager/config.json. enable/disable/set-spent/reconcile need a running gateway.
Never paste real provider API keys into shell commands or logs.`;

/** Split argv into the --config path and the positional words. */
function parseArgs(argv, env) {
  const words = [];
  let configPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configPath = argv[++i];
    else words.push(argv[i]);
  }
  return { words, configPath: configPath ?? defaultConfigPath(env) };
}

/**
 * Run one CLI invocation. Returns the exit code (serve keeps the process alive and returns 0).
 * @param connect  (options) => broker control; tests pass one that returns an in-process control
 * @param signals  where serve listens for SIGINT / SIGTERM (default: process; tests pass an EventEmitter)
 */
export async function main(argv, {
  out = console.log, err = console.error, env = process.env, fetchImpl = fetch, connect = connectControl, signals = process
} = {}) {
  const { words, configPath } = parseArgs(argv, env);
  const [cmd = 'help'] = words;
  let secrets = [];
  try {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') { out(HELP); return 0; }
    if (cmd === 'init') {
      const result = writeFirstConfig(configPath);
      out(`Created private config: ${result.configPath}`);
      out(`Created Pi web-search fragment: ${result.fragmentPath}`);
      out('Edit the config: replace placeholders, adjust expiry/limits, duplicate account records as needed.');
      out('Then install the pi extension (recommended) or run "npm start" and merge the fragment (see README).');
      return 0;
    }
    const command = parseCommand(words, { prefix: PREFIX });
    if (!command && !['serve', 'fragment'].includes(cmd)) { out(HELP); return 0; }
    if (command?.error) { err(command.error); return 1; }

    if (cmd === 'doctor') {
      let config;
      let configError;
      try { config = loadConfig(configPath); secrets = secretsOf(config); } catch (e) { configError = e.message; }
      const control = config ? await connect({ config, statePath: defaultStatePath(configPath), fetchImpl }) : null;
      const checks = await runDoctor({ config, configError, control, env });
      out(formatChecks(checks));
      return checks.some((c) => c.level === 'error') ? 1 : 0;
    }

    const config = loadConfig(configPath);
    secrets = secretsOf(config);
    if (cmd === 'fragment') { out(JSON.stringify(webSearchFragment(config.gateway), null, 2)); return 0; }
    if (cmd === 'serve') {
      const gateway = createGateway(config, {
        store: fileStore(defaultStatePath(configPath)), fetchImpl, reconcileFetch: fetchImpl, secretOptions: { env },
        logger: (line) => out(`${new Date().toISOString()} ${line}`)
      });
      try {
        await gateway.start();
      } catch (e) {
        err(e.code === 'EADDRINUSE' ? `Port ${config.gateway.port} is already in use (is the broker already running in pi?)` : `Gateway could not start: ${redact(e.message, secrets)}`);
        return 1;
      }
      out(`Gateway listening on ${config.gateway.host}:${config.gateway.port} (loopback only)`);
      out(`Exa accounts: ${config.accounts.filter((a) => a.provider === 'exa').length}`);
      out(`Tavily accounts: ${config.accounts.filter((a) => a.provider === 'tavily').length}`);
      // Ctrl+C / SIGTERM: let in-flight searches end their Reservations (so their spend is saved), then release the
      // Port. The listeners go at the first signal, so a second one gets Node's default handling and exits at once.
      const onSignal = (signal) => {
        signals.off('SIGINT', onSignal);
        signals.off('SIGTERM', onSignal);
        out(`${signal}: finishing in-flight requests before exit (repeat to exit at once)`);
        gateway.stop().then(() => out('Gateway stopped'), (e) => { err(`Gateway shutdown failed: ${redact(e.message, secrets)}`); process.exitCode = 1; });
      };
      signals.on('SIGINT', onSignal);
      signals.on('SIGTERM', onSignal);
      return 0;
    }
    const control = await connect({ config, statePath: defaultStatePath(configPath), fetchImpl });
    out(await runCommand(control, command, { url: baseUrl(config), label: STATUS_LABEL[control.mode] }));
    return 0;
  } catch (e) {
    // Config values (including API keys) are never printed here.
    err(`Error: ${redact(e.message, secrets)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
