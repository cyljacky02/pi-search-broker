// pi extension: runs the search broker inside pi and points pi-web-access at it.
// Lifecycle follows docs/extensions.md "Long-lived resources and shutdown": nothing starts in the factory;
// the gateway is acquired on session_start and released on session_shutdown (ref-counted per process).
// pi's own /reload re-runs shutdown + start, which re-reads the broker config.
import { getHost } from '../src/host.mjs';
import { baseUrl } from '../src/client.mjs';
import { statusLine, statusReport } from '../src/format.mjs';
import { runDoctor, formatChecks } from '../src/doctor.mjs';

const STATUS_KEY = 'search-broker';
// pi-web-access tools that can hit Exa/Tavily.
const SEARCH_TOOLS = new Set(['web_search', 'fetch_content', 'source_check']);
const SUBCOMMANDS = ['status', 'enable', 'disable', 'set-spent', 'doctor', 'reconcile'];
const TAKES_ACCOUNT = new Set(['enable', 'disable', 'set-spent', 'reconcile']);

const USAGE = `/broker [status]                         accounts and remaining credits
/broker enable|disable <account>         re-enable or park an account
/broker set-spent <account> <alloc> <n>  correct local spend to match the provider dashboard
/broker doctor                           check that pi-web-access really goes through the broker
/broker reconcile [account]              show provider-reported balances (report-only)`;

export default function piSearchBroker(pi) {
  let sessionHoldsHost = false;
  let accountIds = [];

  async function refreshFooter(ctx) {
    if (!sessionHoldsHost || !ctx?.hasUI) return;
    const host = getHost();
    let text;
    try {
      const snapshot = await host.status();
      accountIds = snapshot.accounts.map((a) => a.id);
      text = statusLine(snapshot, { mode: host.mode });
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
    description: 'Search broker (Exa/Tavily key pool): status, enable/disable, set-spent, doctor, reconcile',
    getArgumentCompletions: (prefix) => {
      const [action, account, ...rest] = prefix.trimStart().split(/\s+/);
      if (rest.length > 0) return null;
      if (account === undefined) {
        const items = SUBCOMMANDS.filter((s) => s.startsWith(action ?? '')).map((s) => ({ value: `${s} `, label: s }));
        return items.length ? items : null;
      }
      if (!TAKES_ACCOUNT.has(action)) return null;
      const items = accountIds.filter((id) => id.startsWith(account)).map((id) => ({ value: `${action} ${id} `, label: id }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [action = 'status', ...params] = args.trim().split(/\s+/).filter(Boolean);
      const host = getHost();
      try {
        if (action === 'doctor') {
          await host.ensure().catch(() => {});
          say(ctx, formatChecks(await runDoctor({ configPath: host.configPath })));
        } else if (action === 'status') {
          await host.ensure();
          say(ctx, statusReport(await host.status(), { mode: host.mode, url: host.config ? baseUrl(host.config) : undefined }));
        } else if (action === 'reconcile') {
          await host.ensure();
          const { results } = await host.admin('reconcile', params[0] ? { id: params[0] } : {});
          say(ctx, results.map((r) => `${r.id}: ${r.error ?? r.skipped ?? `provider reports ~${r.remaining} remaining`}`).join('\n') || 'No accounts');
        } else if (action === 'enable' || action === 'disable') {
          if (!params[0]) return say(ctx, `Usage: /broker ${action} <account>`, 'warning');
          await host.ensure();
          await host.admin(action, { id: params[0] });
          say(ctx, `${action}d ${params[0]}`);
        } else if (action === 'set-spent') {
          const [id, allocationId, spent] = params;
          if (!id || !allocationId || spent === undefined || !Number.isFinite(Number(spent))) {
            return say(ctx, 'Usage: /broker set-spent <account> <allocation> <amount>', 'warning');
          }
          await host.ensure();
          await host.admin('set-spent', { id, allocationId, spent: Number(spent) });
          say(ctx, `Set ${id}/${allocationId} spent to ${Number(spent)}`);
        } else {
          return say(ctx, USAGE, 'warning');
        }
      } catch (err) {
        say(ctx, `Broker: ${err.message}`, 'error');
      }
      await refreshFooter(ctx);
    }
  });
}
