// Account commands shared by the CLI (`node src/cli.mjs <command>`) and pi's `/broker <command>`: one parser, one
// usage text, one way to print results. Both run them against a broker control (control.mjs).
import { statusReport } from './format.mjs';
import { baseUrl } from './control.mjs';

const COMMANDS = Object.freeze([
  { name: 'status', args: '', help: 'accounts and remaining credits' },
  { name: 'enable', args: '<account>', help: 're-enable an account' },
  { name: 'disable', args: '<account>', help: 'park an account' },
  { name: 'set-spent', args: '<account> <allocation> <amount>', help: 'correct local spend to the provider dashboard value' },
  { name: 'reconcile', args: '[account]', help: 'show provider-reported balances (report-only)' },
  { name: 'doctor', args: '', help: 'check that pi-web-access really goes through the broker' }
]);
export const COMMAND_NAMES = Object.freeze(COMMANDS.map((c) => c.name));
/** Commands whose first argument is an account id (for completion). */
export const TAKES_ACCOUNT = Object.freeze(new Set(['enable', 'disable', 'set-spent', 'reconcile']));

/** Usage lines, e.g. usage('/broker') or usage('node src/cli.mjs', cliOnlyCommands). */
export function usage(prefix, extra = []) {
  const rows = [...extra, ...COMMANDS].map((c) => [`${prefix} ${c.name}${c.args ? ` ${c.args}` : ''}`, c.help]);
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, help]) => left.padEnd(width) + help).join('\n');
}

/**
 * Parse the words after the command prefix. Returns { name, id?, allocationId?, amount? }, or { error } with a
 * one-line usage hint, or null when the first word is not an account command.
 */
export function parseCommand(words) {
  const [name, ...args] = words;
  const spec = COMMANDS.find((c) => c.name === name);
  if (!spec) return null;
  const hint = () => ({ error: `Usage: ${spec.name} ${spec.args}`.trim() });
  if (name === 'enable' || name === 'disable') return args[0] ? { name, id: args[0] } : hint();
  if (name === 'set-spent') {
    const [id, allocationId, raw] = args;
    const amount = Number(raw);
    if (!id || !allocationId || raw === undefined || !Number.isFinite(amount) || amount < 0) return hint();
    return { name, id, allocationId, amount };
  }
  if (name === 'reconcile') return { name, id: args[0] };
  return { name };
}

/** Run a parsed account command (not doctor) against a control and return the text to show. */
export async function runCommand(control, command, { config } = {}) {
  switch (command.name) {
    case 'status':
      return statusReport(await control.status(), { mode: control.mode, url: config ? baseUrl(config) : undefined });
    case 'enable':
      await control.enable(command.id);
      return `Enabled ${command.id}`;
    case 'disable':
      await control.disable(command.id);
      return `Disabled ${command.id}`;
    case 'set-spent':
      await control.setSpent(command.id, command.allocationId, command.amount);
      return `Set ${command.id}/${command.allocationId} spent to ${command.amount}`;
    case 'reconcile': {
      const results = await control.reconcile(command.id);
      return results.map((r) => `${r.id}: ${r.error ?? r.skipped ?? `provider reports ~${r.remaining} remaining`}`).join('\n') || 'No accounts';
    }
    default:
      throw new Error(`Not an account command: ${command.name}`);
  }
}
