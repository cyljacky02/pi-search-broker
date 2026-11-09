// Human-readable views of a status snapshot (shared by the CLI and the pi extension). Never includes keys.
import { PROVIDERS } from './providers.mjs';

const formatters = Object.freeze({
  USD: (n) => `$${n.toFixed(n < 10 ? 3 : 2)}`,
  credits: (n) => `${Math.round(n).toLocaleString('en-US')}cr`
});
const amount = (provider, n) => formatters[PROVIDERS[provider].unit](n);

export function providerTotals(snapshot) {
  const totals = {};
  for (const a of snapshot.accounts) {
    const t = (totals[a.provider] ??= { available: 0, usable: 0, total: 0 });
    t.total++;
    if (a.status === 'active') { t.usable++; t.available += a.available ?? 0; }
  }
  return totals;
}

// Footer suffix by broker control mode: another process owns the gateway, or nobody runs it.
const FOOTER_MODE = Object.freeze({ http: ' [shared]', offline: ' [offline]' });

/** One-line footer text, e.g. "search: exa $41.20 (2/3) · tavily 1,840cr (2/2)". */
export function statusLine(snapshot, { mode } = {}) {
  const parts = Object.entries(providerTotals(snapshot))
    .map(([p, t]) => `${p} ${amount(p, t.available)} (${t.usable}/${t.total})`);
  return `search: ${parts.join(' · ') || 'no accounts'}${FOOTER_MODE[mode] ?? ''}`;
}

export function statusReport(snapshot, { mode, url } = {}) {
  const lines = [];
  lines.push(`Search broker${mode ? ` (${mode}${url ? ` @ ${url}` : ''})` : ''} - local estimates as of ${snapshot.updatedAt}`);
  for (const a of snapshot.accounts) {
    const retry = a.retryAt ? ` until ${a.retryAt}` : '';
    const why = a.cooldownReason ? ` (${a.cooldownReason})` : a.lastErrorTag && a.status !== 'active' ? ` (${a.lastErrorTag})` : '';
    lines.push(`${a.id} [${a.provider}] ${a.status}${why}${retry} | ok ${a.requests}, failed ${a.failures}${a.possiblyBilled ? `, possibly billed ${a.possiblyBilled}` : ''} | local estimate ~${amount(a.provider, a.available ?? 0)}`);
    for (const b of a.allocations) {
      lines.push(`  ${b.id}: ~${amount(a.provider, b.remainingEstimate)} of ${amount(a.provider, b.limit)} left (${b.period}${b.window && b.window !== 'once' ? ` from ${b.window}` : ''}${b.expiresAt ? `, expires ${b.expiresAt}` : ''}${b.active ? '' : ', inactive'})`);
    }
    if (a.providerBalance) lines.push(`  provider-reported balance @ ${a.providerBalance.at}: ${amount(a.provider, a.providerBalance.remaining)}`);
    if (a.reconcileError) lines.push(`  balance check failed @ ${a.reconcileError.at}: ${a.reconcileError.message}`);
    if (a.lastRequestId) lines.push(`  last request id: ${a.lastRequestId}`);
  }
  return lines.join('\n');
}
