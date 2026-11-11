# Provider balances are the source of truth; configured Allocations are hints

Users should not have to describe each key's credit by hand, so the broker now treats a provider-reported balance as an account's credit: Tavily `GET /usage` (any key) and Exa `GET /credits` (only with a team service key) are synced at Gateway startup, every `reconcileIntervalMs` (default one hour) and when an account runs out, and the broker subtracts its own spend since the report. Allocations from `config.json` or key-file settings lines are only hints for accounts without a valid report. An Exa key without a service key has an unknown balance: it is used until Exa answers 402 (not billed) and is then parked until the 1st of next month (UTC). This reverses the earlier rule that provider balances were report-only and never applied.

## Considered options

- **Keep balances report-only, configure every key's credit.** Rejected: users had to know and maintain limits and promo expiry dates per key, and stale hand-written limits either wasted credit or caused avoidable 402/432 replies.
- **Assume Exa's $10 free plan for every Exa key.** Rejected: it only applies to a user's first team, and a wrong limit hides a key's real state. An unknown balance plus 402 handling costs at most one unbilled refusal per key per month.

## Consequences

- A report is valid until the next monthly reset (the 1st, UTC); after that the account falls back to its hints until the next report.
- Reports lag behind billed searches: Exa `/credits` by up to 5 minutes (documented), Tavily `/usage` by more than 16 minutes (observed live, undocumented; one hour is assumed). Spend inside that window before a report is subtracted again: the broker errs on the side of less credit.
- Tavily keys from the same account share one plan, which `/usage` cannot reveal; the broker assumes one key per Tavily account.
- `reconcileIntervalMs: 0` turns automatic syncing off; `"reconcile": false` keeps one account on its Allocations.
