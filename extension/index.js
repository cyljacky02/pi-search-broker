// pi extension: runs the search broker inside pi and wires pi-web-access to it.
// Lifecycle follows docs/extensions.md "Long-lived resources and shutdown": nothing starts in the factory;
// the gateway is acquired on session_start and released on session_shutdown (ref-counted per process).
import { getHost, baseUrl } from '../src/host.mjs';
import { statusLine, statusReport } from '../src/format.mjs';
import { runDoctor, formatChecks } from '../src/doctor.mjs';
import { writeFirstConfig } from '../src/config.mjs';

const STATUS_KEY = 'search-broker';
const WIDGET_KEY = 'search-broker';
// pi-web-access tools that can hit Exa/Tavily.
const SEARCH_TOOLS = new Set(['web_search', 'fetch_content', 'source_check']);
const SUBCOMMANDS = ['status', 'doctor', 'reconcile', 'enable', 'disable', 'set-spent', 'widget', 'reload', 'init', 'help'];
const NEEDS_ACCOUNT = new Set(['enable', 'disable', 'set-spent', 'reconcile']);

const HELP = `/broker [status]                         show accounts and remaining credits
/broker doctor                           check that pi-web-access really goes through the broker
/broker reconcile [account]              fetch real balances (Tavily /usage, Exa /credits with adminKey)
/broker enable|disable <account>         re-enable or park an account
/broker set-spent <account> <alloc> <n>  correct local spend to match the provider dashboard
/broker widget [on|off]                  per-account table above the editor
/broker reload                           re-read the broker config
/broker init                             create a starter config (never overwrites)`;

export default function piSearchBroker(pi) {
  let held = false;
  let widget = false;
  let accountIds = [];

  const host = () => getHost();

  async function refresh(ctx) {
    if (!held || !ctx?.hasUI) return;
    const h = host();
    let text;
    let snapshot = null;
    try {
      snapshot = await h.status();
      accountIds = snapshot.accounts.map((a) => a.id);
      text = statusLine(snapshot, { mode: h.mode });
    } catch {
      text = h.mode === 'unconfigured' ? 'search: broker not configured' : 'search: broker offline';
    }
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(STATUS_KEY, theme?.fg ? theme.fg('dim', text) : text);
    if (widget && snapshot) ctx.ui.setWidget(WIDGET_KEY, statusReport(snapshot, { mode: h.mode }).split('\n'));
    else ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function say(ctx, message, type = 'info') {
    if (ctx?.hasUI) ctx.ui.notify(message, type);
    else console.log(message);
  }

  pi.registerFlag('no-search-broker', {
    description: 'Do not start or use the local search broker in this session',
    type: 'boolean',
    default: false
  });

  pi.on('session_start', async (_event, ctx) => {
    if (pi.getFlag('no-search-broker')) return;
    const h = host();
    if (!held) { held = true; await h.acquire(); }
    for (const note of h.takeNotes()) say(ctx, note, 'info');
    if (h.mode === 'unconfigured' || h.mode === 'error') say(ctx, h.lastError, h.mode === 'error' ? 'error' : 'warning');
    await refresh(ctx);
  });

  // Owner takeover: if the process that owned the port exited, the next search makes this process the owner.
  pi.on('tool_call', async (event) => {
    if (held && SEARCH_TOOLS.has(event.toolName)) await host().ensure().catch(() => {});
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    if (held && SEARCH_TOOLS.has(event.toolName)) await refresh(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!held) return;
    held = false;
    try { ctx?.ui?.setStatus(STATUS_KEY, undefined); ctx?.ui?.setWidget(WIDGET_KEY, undefined); } catch { /* UI may be gone */ }
    await host().release();
  });

  pi.registerCommand('broker', {
    description: 'Search broker (Exa/Tavily key pool): status, doctor, reconcile, enable/disable, set-spent',
    getArgumentCompletions: (prefix) => {
      const [action, account, ...rest] = prefix.trimStart().split(/\s+/);
      if (rest.length > 0) return null;
      if (account === undefined) {
        const items = SUBCOMMANDS.filter((s) => s.startsWith(action ?? '')).map((s) => ({ value: `${s} `, label: s }));
        return items.length ? items : null;
      }
      if (!NEEDS_ACCOUNT.has(action)) return null;
      const items = accountIds.filter((id) => id.startsWith(account)).map((id) => ({ value: `${action} ${id} `, label: id }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [action = 'status', ...params] = args.trim().split(/\s+/).filter(Boolean);
      const h = host();
      try {
        if (action === 'help') return say(ctx, HELP);
        if (action === 'init') {
          const r = writeFirstConfig(h.configPath);
          return say(ctx, `Created ${r.configPath}. Edit it outside pi (never paste keys into chat), then run /broker reload.`);
        }
        if (!held && action !== 'doctor') return say(ctx, 'The search broker is disabled in this session (--no-search-broker).', 'warning');
        if (action === 'reload') {
          const mode = await h.reload();
          say(ctx, mode === 'owner' || mode === 'client' ? `Broker ${mode} @ ${baseUrl(h.config)}` : h.lastError, mode === 'error' ? 'error' : 'info');
        } else if (action === 'status') {
          await h.ensure();
          say(ctx, statusReport(await h.status(), { mode: h.mode, url: h.config ? baseUrl(h.config) : undefined }));
        } else if (action === 'doctor') {
          await h.ensure().catch(() => {});
          say(ctx, formatChecks(await runDoctor({ configPath: h.configPath })));
        } else if (action === 'reconcile') {
          await h.ensure();
          const { results } = await h.admin('reconcile', params[0] ? { id: params[0] } : {});
          say(ctx, results.map((r) => `${r.id}: ${r.error ?? r.skipped ?? `~${r.remaining} remaining`}`).join('\n') || 'No accounts');
        } else if (action === 'enable' || action === 'disable') {
          if (!params[0]) return say(ctx, `Usage: /broker ${action} <account>`, 'warning');
          await h.ensure();
          await h.admin(action, { id: params[0] });
          say(ctx, `${action}d ${params[0]}`);
        } else if (action === 'set-spent') {
          const [id, allocationId, spent] = params;
          if (!id || !allocationId || spent === undefined || !Number.isFinite(Number(spent))) {
            return say(ctx, 'Usage: /broker set-spent <account> <allocation> <amount>', 'warning');
          }
          await h.ensure();
          await h.admin('set-spent', { id, allocationId, spent: Number(spent) });
          say(ctx, `Set ${id}/${allocationId} spent to ${Number(spent)}`);
        } else if (action === 'widget') {
          widget = params[0] ? params[0] === 'on' : !widget;
          say(ctx, `Broker widget ${widget ? 'on' : 'off'}`);
        } else {
          return say(ctx, HELP, 'warning');
        }
      } catch (err) {
        say(ctx, `Broker: ${err.message}`, 'error');
      }
      await refresh(ctx);
    }
  });
}
