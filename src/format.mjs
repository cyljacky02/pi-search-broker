// Human-readable views of a status snapshot (shared by the CLI and the pi extension). Never includes keys.
import { PROVIDERS } from './providers.mjs';

const formatters = Object.freeze({
  USD: (n) => `$${n.toFixed(n < 10 ? 3 : 2)}`,
  credits: (n) => `${Math.round(n).toLocaleString('en-US')}cr`
});
const amount = (provider, n) => formatters[PROVIDERS[provider].unit](n);

/** Per Provider: usable/total Accounts, the known credit of usable ones, and how many usable ones have an unknown balance. */
export function providerTotals(snapshot) {
  const totals = {};
  for (const a of snapshot.accounts) {
    const t = (totals[a.provider] ??= { available: 0, usable: 0, total: 0, unknown: 0 });
    t.total++;
    if (a.status !== 'active') continue;
    t.usable++;
    if (a.available === null || a.available === undefined) t.unknown++;
    else t.available += a.available;
  }
  return totals;
}

/** "$41.20", "$41.20+?" when some usable Accounts have an unknown balance, or "?" when all of them do. */
function creditText(provider, t) {
  if (t.unknown && t.unknown === t.usable) return '?';
  return `${amount(provider, t.available)}${t.unknown ? '+?' : ''}`;
}

/** How long before `now` an ISO time was, roughly. */
function ago(at, now) {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(at)) / 60000));
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

const day = (iso) => iso.slice(0, 10);

/** Where an Account's credit comes from, what is left, and how fresh that is. */
function balanceText(a, now) {
  const b = a.balance;
  if (!b || b.source === 'hint') return `~${amount(a.provider, a.available ?? 0)} left (estimate from Allocations)`;
  if (b.source === 'unknown') return `balance unknown; ${amount(a.provider, b.spentThisMonth ?? 0)} spent this month`;
  // "688 of 1,000cr left": the unit once, after the limit ("$8.00 of $10.00" keeps its leading $).
  const used = PROVIDERS[a.provider].unit === 'credits' ? Math.round(b.remaining).toLocaleString('en-US') : amount(a.provider, b.remaining);
  const left = b.limit !== null ? `${used} of ${amount(a.provider, b.limit)} left` : `${amount(a.provider, b.remaining)} left`;
  const expiring = b.expiring.map((e) => `, ${amount(a.provider, e.amount)} expires ${day(e.expiresAt)}`).join('');
  return `${left}${expiring} (${PROVIDERS[a.provider].label}-reported ${ago(b.reportedAt, now)})`;
}

/** An Account's health, e.g. "active", "cooldown (rate-limit) until …", "parked until 2026-12-01 (out of credit)". */
function healthText(a) {
  if (a.status === 'quota') return `parked${a.retryAt ? ` until ${day(a.retryAt)}` : ''} (out of credit)`;
  const why = a.cooldownReason ? ` (${a.cooldownReason})` : a.lastErrorTag && a.status !== 'active' ? ` (${a.lastErrorTag})` : '';
  return `${a.status}${why}${a.retryAt ? ` until ${a.retryAt}` : ''}`;
}

// Footer suffix by broker control mode: another process owns the gateway.
const FOOTER_MODE = Object.freeze({ http: ' [shared]' });

/** Why this process could not start a Gateway (the host's offline view carries one as issue.reason). */
export const OFFLINE_REASON = Object.freeze({ NO_ACCOUNTS: 'no-accounts', PORT_TAKEN: 'port-taken', START_FAILED: 'start-failed' });
const OFFLINE_FOOTER = Object.freeze({
  [OFFLINE_REASON.NO_ACCOUNTS]: 'no keys yet',
  [OFFLINE_REASON.PORT_TAKEN]: 'port in use, see /broker doctor',
  [OFFLINE_REASON.START_FAILED]: 'see /broker doctor'
});

/** Footer when nobody serves the Gateway: searches cannot use any credit, so say why instead of showing it. */
export function offlineLine(reason) {
  return `search: broker not running (${OFFLINE_FOOTER[reason] ?? OFFLINE_FOOTER[OFFLINE_REASON.START_FAILED]})`;
}

/** One-line footer text, e.g. "search: exa $41.20+? (2/3) · tavily 1,840cr (2/2)". */
export function statusLine(snapshot, { mode } = {}) {
  const parts = Object.entries(providerTotals(snapshot))
    .map(([p, t]) => `${p} ${creditText(p, t)} (${t.usable}/${t.total})`);
  return `search: ${parts.join(' · ') || 'no accounts'}${snapshot.persistence?.state === 'unavailable' ? ' [storage error; paused]' : ''}${FOOTER_MODE[mode] ?? ''}`;
}

export function statusReport(snapshot, { mode, url } = {}) {
  const lines = [];
  lines.push(`Search broker${mode ? ` (${mode}${url ? ` @ ${url}` : ''})` : ''} as of ${snapshot.updatedAt}`);
  if (snapshot.persistence?.state === 'unavailable') {
    lines.push('WARNING: Account pool state could not be saved; new attempts are paused until storage recovers. After a restart or takeover, check provider balances and correct spend.');
  }
  for (const a of snapshot.accounts) {
    lines.push(`${a.id} [${a.provider}] ${healthText(a)} | ok ${a.requests}, failed ${a.failures}${a.possiblyBilled ? `, possibly billed ${a.possiblyBilled}` : ''} | ${balanceText(a, snapshot.updatedAt)}`);
    // Allocations matter only while they are the estimate.
    if (!a.balance || a.balance.source === 'hint') {
      for (const b of a.allocations) {
        lines.push(`  ${b.id}: ~${amount(a.provider, b.remainingEstimate)} of ${amount(a.provider, b.limit)} left (${b.period}${b.window && b.window !== 'once' ? ` from ${b.window}` : ''}${b.expiresAt ? `, expires ${b.expiresAt}` : ''}${b.active ? '' : ', inactive'})`);
      }
    }
    const syncError = a.balance?.syncError ?? a.reconcileError;
    if (syncError) lines.push(`  balance sync failed at ${syncError.at}: ${syncError.message}`);
    if (a.lastRequestId) lines.push(`  last request id: ${a.lastRequestId}`);
  }
  for (const p of snapshot.placeholders ?? []) {
    lines.push(`${p.id} [${p.provider}] not set up: its key in config.json is still an example value. Put real keys in key files, or remove it.`);
  }
  return lines.join('\n');
}
