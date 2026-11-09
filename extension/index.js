// pi extension: runs the search broker inside pi and points pi-web-access at it.
// Lifecycle follows docs/extensions.md "Long-lived resources and shutdown": nothing starts in the factory;
// the gateway is acquired on session_start and released on session_shutdown (ref-counted per process).
// pi's own /reload re-runs shutdown + start, which re-reads the broker config.
import { getHost as processHost } from '../src/host.mjs';
import { statusLine } from '../src/format.mjs';
import { runDoctor, formatChecks } from '../src/doctor.mjs';
import { COMMAND_NAMES, TAKES_ACCOUNT, usage, parseCommand, runCommand } from '../src/commands.mjs';

const STATUS_KEY = 'search-broker';
// pi-web-access tools that can hit Exa/Tavily.
const SEARCH_TOOLS = new Set(['web_search', 'fetch_content', 'source_check']);
const PREFIX = '/broker';
const USAGE = usage(PREFIX);
// How /broker status names where the numbers came from, by control mode.
const STATUS_LABEL = Object.freeze({ 'in-process': 'owner', http: 'client', offline: 'offline, from the state file' });

/** Build the extension. `getHost` returns the process's broker host (tests pass their own). */
export function createExtension({ getHost = processHost } = {}) {
  return function piSearchBroker(pi) {
    let sessionHoldsHost = false;
    let accountIds = [];

    async function refreshFooter(ctx) {
      if (!sessionHoldsHost || !ctx?.hasUI) return;
      const host = getHost();
      let text;
      try {
        const control = await host.control();
        const snapshot = await control.status();
        accountIds = snapshot.accounts.map((a) => a.id);
        text = statusLine(snapshot, { mode: control.mode });
      } catch {
        text = host.mode === 'unconfigured' ? 'search: broker not configured' : 'search: broker offline';
      }
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme?.fg ? ctx.ui.theme.fg('dim', text) : text);
    }

    function say(ctx, message, type = 'info') {
      if (ctx?.hasUI) ctx.ui.notify(message, type);
      else console.log(message);
    }

    pi.on('session_start', async (_event, ctx) => {
      const host = getHost();
      if (!sessionHoldsHost) { sessionHoldsHost = true; await host.acquire(); }
      if (ctx?.hasUI) {
        for (const note of host.takeNotes()) ctx.ui.notify(note, 'warning');
        if (host.mode === 'unconfigured' || host.mode === 'error') ctx.ui.notify(host.lastError, host.mode === 'error' ? 'error' : 'warning');
      }
      await refreshFooter(ctx);
    });

    // Owner takeover: if the process that owned the port exited, the next search makes this process the owner.
    pi.on('tool_call', async (event) => {
      if (sessionHoldsHost && SEARCH_TOOLS.has(event.toolName)) await getHost().ensure().catch(() => {});
    });

    pi.on('tool_execution_end', async (event, ctx) => {
      if (sessionHoldsHost && SEARCH_TOOLS.has(event.toolName)) await refreshFooter(ctx);
    });

    pi.on('session_shutdown', async (_event, ctx) => {
      if (!sessionHoldsHost) return;
      sessionHoldsHost = false;
      try { ctx?.ui?.setStatus(STATUS_KEY, undefined); } catch { /* UI may be gone */ }
      await getHost().release();
    });

    pi.registerCommand('broker', {
      description: 'Search broker (Exa/Tavily account pools): status, enable/disable, set-spent, reconcile, doctor',
      getArgumentCompletions: (prefix) => {
        const [action, account, ...rest] = prefix.trimStart().split(/\s+/);
        if (rest.length > 0) return null;
        if (account === undefined) {
          const items = COMMAND_NAMES.filter((s) => s.startsWith(action ?? '')).map((s) => ({ value: `${s} `, label: s }));
          return items.length ? items : null;
        }
        if (!TAKES_ACCOUNT.has(action)) return null;
        const items = accountIds.filter((id) => id.startsWith(account)).map((id) => ({ value: `${action} ${id} `, label: id }));
        return items.length ? items : null;
      },
      handler: async (args, ctx) => {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const command = parseCommand(words.length ? words : ['status'], { prefix: PREFIX });
        if (!command) return say(ctx, USAGE, 'warning');
        if (command.error) return say(ctx, command.error, 'warning');
        const host = getHost();
        try {
          if (command.name === 'doctor') {
            await host.ensure().catch(() => {});
            const control = host.config ? await host.control() : null;
            say(ctx, formatChecks(await runDoctor({ config: host.config, configError: host.lastError, control, env: host.env })));
          } else {
            await host.ensure();
            const control = await host.control();
            say(ctx, await runCommand(control, command, { config: host.config, label: STATUS_LABEL[control.mode] }));
          }
        } catch (err) {
          say(ctx, `Broker: ${err.message}`, 'error');
        }
        await refreshFooter(ctx);
      }
    });
  };
}

export default createExtension();
