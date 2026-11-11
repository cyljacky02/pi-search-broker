# Pi Search Broker — Exa + Tavily Multi-Account Key Pool for pi-web-access

A **local** Exa / Tavily API gateway for [pi-web-access](https://github.com/nicobailon/pi-web-access), plus a pi extension that runs it for you.
It manages the **independent quotas of separate accounts**, without modifying pi-web-access source code.

> Implementation status: zero npm dependencies, Node 20.3+. Covered by an automated test suite against mocked upstreams, and smoke-tested inside a real pi `AgentSession`.
> **It has not yet been integration-tested against the live Exa / Tavily services with real API keys.** Start with a small number of accounts.

The design decisions below are backed by the research notes in [`docs/research/`](docs/research/): [Tavily](docs/research/tavily.md), [Exa](docs/research/exa.md), [pi-web-access wire contract](docs/research/pi-web-access.md), [pi extensions](docs/research/pi-extensions.md).

## Features

- **Key pools for Exa and Tavily.** Within a single request the broker picks the best account, and on account-level failures moves to the next one. pi-web-access sees one ordinary provider.
- **Error handling that follows each provider's documented semantics:**

  | Upstream reply | Broker action |
  |---|---|
  | 401 | Disable the account (`auth`) and try the next one |
  | Exa 402 `NO_MORE_CREDITS` / budget tags; Tavily 432 / 433 | Mark the account `quota` until its next reset or promo change; try the next one |
  | Exa 402 `X402_PAYMENT_REQUIRED` | Treated as a credential problem (`auth`) |
  | Exa 403 `TEAM_BLOCKED` | Disable the account (`blocked`); try the next one |
  | Exa 403 `FEATURE_DISABLED` | Try exactly one other account; disable nobody |
  | **Exa 403 `PROHIBITED_CONTENT` / `CONTENT_FILTER_ERROR`** | **Returned to the client once. Never retried on another account**: Exa counts each retry as a warning against that team |
  | Tavily 403 on `/search` | 10-minute cooldown (undocumented status, so no permanent disable) |
  | 429 | Cool down using `Retry-After` (default 30 s, max 120 s); try the next account. An Exa network-scoped 429 is returned as-is |
  | Tavily 434 (flex capacity) | Try another account without penalty |
  | Exa 503 `SERVICE_OVERLOADED` (not billed) | Back off (250 ms, 500 ms) and retry, **without** cooling the account down |
  | Other 5xx | 10-second cooldown on that account; try the next one |
  | Connection failure proven to precede delivery | 10-second cooldown on that account; try the next one |
  | Ambiguous connection failure | Counted as *possibly billed* at the estimate; never retried on another account |
  | Attempt timeout | Counted as *possibly billed*; **not** retried on another account (that could bill twice). Returns 504 so pi falls back to the other provider |
  | Other 4xx (400, 404, 422…) | Returned to the client with the provider's own message (keys redacted) |

- **No billing surprises:**
  - `stream: true` is rejected up front, because a stream can't be metered and would be retried on every account.
  - The per-attempt timeout is 30 s on every route.
  - A timed-out attempt or an ambiguous connection failure is counted as *possibly billed* and never retried on another account. pi-web-access may still fall back to a different provider on 503/504, which can also bill the search.
  - A 2xx with an unparseable body is never retried on another account.
  - If pi aborts the call, the upstream request is aborted too, including while its reply is being read.
  - If account state cannot be saved, the broker keeps the live accounting and attempt record, reports the failure, and pauses new attempts until it can save the current state. A save failure after an attempt that was billed or possibly billed returns 409 with “Request aborted” so pi-web-access 0.47's sequential search routing does not automatically try another provider; inspect the provider balance before retrying. After an attempt the provider refused, or one that never reached it, nothing was billed, so the broker returns 503 and pi may fall back. Exa content extraction may show only “Aborted”; check `/broker status` for the storage warning. This cannot prevent retries by other clients or concurrent multi-provider requests, and should be re-checked after pi-web-access upgrades.
- **Exact accounting where the provider allows it:**
  - Exa uses `costDollars.total`.
  - Tavily uses `usage.credits`; the broker adds `include_usage: true` upstream and removes `usage` from the reply unless you asked for it.
  - Otherwise it reserves a conservative estimate from the current rate cards. Exa: contents are included on `/search` up to 10 results, and all current search types are covered. Tavily: basic, fast and ultra-fast cost 1 credit; advanced and `auto_parameters` cost 2.
- **Optional, report-only provider balance checks:**
  - Run on demand with `/broker reconcile` or `npm run reconcile`. Periodic checks are off unless `reconcileIntervalMs` is set.
  - Tavily `GET /usage` works with any key, at most once a minute per key (Tavily allows 10 calls per 10 minutes).
  - Exa Team Management `GET /credits` needs a per-account `adminKey`, a service key that Exa support has to enable.
  - The provider-reported balance is shown next to the local estimate. Local accounting never changes automatically; use `set-spent` if the two differ.
- **Account model:**
  - One key per line in a key file is one Account; each key gets the Provider's free plan unless its file says otherwise.
  - One-time promo credits (`once` + `expiresAt`, or `"expires": "never"` for Exa's onboarding bonus) are spent before monthly allowances, earliest expiry first.
  - Monthly allowances support `resetDay` (UTC) and `startsAt`.
- **Safety:**
  - Listens on loopback only, and every request needs the local token.
  - Upstream origins are fixed.
  - Keys never appear in the state file (`pool-state.json`), `/status`, logs, error bodies, pi notifications or the footer.
  - A Tavily body `api_key` is stripped so the local token never leaves the machine.
  - Keys live in private key files, or come from `$ENV` / `!command` sources in `config.json` so they never have to touch disk.
- **Debuggability:** per-account last request id (Exa `requestId`, Tavily `request_id`), the last error tag, and the most recent 50 attempts in `/status`.

## Quick start (recommended: pi extension)

1. Install the extension into pi (Node 20.3+, no `npm install`). It is a pi package: the `pi.extensions` field in `package.json` points at `extension/index.js`.

   ```bash
   pi install /absolute/path/to/pi-search-broker
   ```

2. Start pi. On its first start the extension sets everything up, and never overwrites a file:
   - `~/.config/pi-search-broker/config.json` (mode 0600), holding a random Gateway token and no Accounts
   - `~/.config/pi-search-broker/keys/exa.txt` and `keys/tavily.txt`, which contain only instructions
   - in `~/.pi/agent/web-search.json`, `"exaApiKey"` / `"tavilyApiKey"` set to `"$PI_SEARCH_BROKER_TOKEN"` if they are missing or empty. Values that are already set are never changed; if they would bypass the broker, you get a warning with the fix.

   Set `PI_SEARCH_BROKER_CONFIG` to use another config path. The `keys` folder always sits next to the config.

3. Put your API keys in the key files, one per line, then run `/reload` in pi. The footer shows the remaining credit, for example `search: exa $41.20 (2/3) · tavily 1,840cr (2/2)`.

### Key files

A **key file** is a plain text file in the `keys` folder. Each line holds one API key, and each key is one Account. The key file is the only source of its Accounts: edit it, then `/reload`. The decision record is [docs/adr/0001-key-files-own-their-accounts.md](docs/adr/0001-key-files-own-their-accounts.md).

```text
~/.config/pi-search-broker/keys/
├── tavily.txt        # Tavily keys on the free plan
├── exa.txt           # Exa keys on the free plan
└── exa-promo.txt     # Exa keys that also have promo or trial credit
```

- **File names.** `exa*.txt` and `tavily*.txt`, for example `exa.txt` or `exa-promo.txt`. Use only letters, digits, `-` and `_`. The file name becomes the start of each Account id.
- **Keys.** One key per line. Blank lines and lines starting with `#` are ignored; Windows line endings and a UTF-8 BOM are fine.
- **Free plan by default.** Every key gets the Provider's free plan as a `monthly` Allocation that resets on the 1st (UTC): Tavily 1,000 credits, Exa $10. Exa grants that only to a user's first team (see below).
- **Settings lines** describe extra credit for every key in the file, as `# <allocation>: <limit> <monthly|once> [expires=<YYYY-MM-DD|ISO time|never>] [reset-day=<1-28>]`. The limit is in USD for Exa and credits for Tavily; a bare date means midnight UTC. Use `# free: <limit> monthly` to change the free plan, or `# free: none` to drop it. A `#` line whose text after the colon is not a number or `none` is an ordinary comment.

  ```text
  # promo: 60 once expires=2026-12-01
  exa-xxxxxxxx
  exa-yyyyyyyy  expires=2026-12-15
  ```

- **Per-key expiry.** `expires=` after a key replaces the expiry of the file's `once` Allocations for that key. Trial keys usually expire on different days.
- **Promo first, then free.** Promo (`once`) credit is spent before the monthly allowance, earliest expiry first. When a key's promo credit runs out or expires, the key keeps working on its free plan. Accounts are never deleted automatically.
- **Account ids** are the file name plus the first 8 hex characters of the key's SHA-256, for example `exa-promo-3f9a1c2e`. Removing a line removes its Account, but its saved spend stays in `pool-state.json`; put the key back and the Account continues where it was. Moving a key to another file gives it a new id.
- **Mistakes are skipped, not fatal.** An unusable line (too short, an example value, control characters or a bad `expires=`) is skipped. A file with a bad settings line, or a bad file name, is skipped as a whole. A key that is already listed in an earlier file (by file name), or used by an Account in `config.json`, is skipped too. pi shows each case by file and line number, never the key. The Gateway only refuses to start when there is no Account at all.
- **When they are read.** Key files are read only when a pi process becomes the Port owner and starts the Gateway: at pi startup, `/reload`, or a takeover. Status, `doctor` and joining another process's Gateway never read them, and when a start finds no Account at all, pi waits for `/reload` instead of re-reading them on every search. A starting Gateway then writes `keys.index.json` next to the config, which lists the ids and Allocations of the key-file Accounts it read but no keys (it is emptied when there are none), so offline `status` can show them.
- **Placeholders.** Once key files hold a usable key, Accounts in `config.json` whose key is still an example value (such as `REPLACE_…` from older versions of `init`) are removed from `config.json`. Until then, status lists them as "not set up" and never counts their Allocations as credit.
- Keys stay only in the key files: they are never copied into `config.json`. Keep the folder out of cloud sync and Git.

### What the extension does in every pi session

- **Starts the gateway inside pi**, or joins one already running in another pi process. Only one process per machine owns the port; the others are clients and take over automatically when the owner exits. In-process subagents share the same gateway through reference counting.
- **Points pi-web-access at the broker for this pi process.** It sets `EXA_BASE_URL` and `TAVILY_BASE_URL` (which pi-web-access reads on every request and which win over `web-search.json`) and `PI_SEARCH_BROKER_TOKEN`. It never overrides or removes your provider keys. Everything is restored when the last session ends. Commands the agent runs in bash inherit these variables, but the token only works against the loopback gateway. Set `"pi": { "wireEnvironment": false }` to opt out; then the extension also leaves `web-search.json` alone.
- **Warns at session start** (in the UI) about skipped key-file lines, or if pi-web-access would not authenticate to the broker: wrong key source, or `TAVILY_API_KEY_n` set. It shows the exact fix. It also warns when this process joined a gateway it cannot control (a different gateway token), or could not take the port at all.
- **Shows remaining credits in the footer** while a Gateway serves (` [shared]` when another pi process owns it). When this process cannot run one, the footer says why instead of showing credit: `search: broker not running (no keys yet)`, or `(see /broker doctor)` for any other reason.
- **Adds `/broker`:**

  ```text
  /broker status                                     accounts and remaining credits (the default)
  /broker enable <account>                           re-enable an account
  /broker disable <account>                          park an account
  /broker set-spent <account> <allocation> <amount>  correct local spend to the provider dashboard value
  /broker reconcile [account]                        show provider-reported balances (report-only)
  /broker doctor                                     check that pi-web-access really goes through the broker
  ```

`"exaApiKey": "$PI_SEARCH_BROKER_TOKEN"` in `web-search.json` matters: this explicit source wins over any `EXA_API_KEY` / `TAVILY_API_KEY` you have exported, and without an Exa key pi-web-access would silently use the keyless Exa MCP endpoint and bypass the broker. Run `/broker doctor` to check.

### Accounts in config.json (optional)

Key files cover most needs. For an Account whose key should come from an environment variable or a password manager, or that needs an Exa `adminKey` or a Tavily `projectId`, add it to `config.json` **on your own machine only**. Never paste it into a chat. Example (all keys and dates are fake):

```json
{
  "gateway": { "host": "127.0.0.1", "port": 19473, "token": "the 64-character random token generated on first start" },
  "accounts": [
    {
      "id": "exa-account-1",
      "provider": "exa",
      "apiKey": "$EXA_KEY_ACCOUNT_1",
      "adminKey": "!op read op://Private/exa-account-1/service-key",
      "allocations": [
        { "id": "promo", "limit": 70, "period": "once", "expiresAt": "2026-11-29T00:00:00Z" },
        { "id": "free", "limit": 10, "period": "monthly", "resetDay": 1, "startsAt": "2026-11-29T00:00:00Z" }
      ]
    }
  ]
}
```

Key sources follow pi's own syntax:
- `"$NAME"` or `"${NAME}"` reads an environment variable.
- `"!command"` runs a trusted local command (5 s timeout).
- `"$$..."` escapes a literal leading `$`.
- Anything else is a literal key.

Every `id` must be unique, across `config.json` and key files. Reading config validates its structure and credential source syntax, but never resolves Account credentials. CLI inspection (`status`, `fragment`, `doctor`), remote Broker control and joining an existing Port owner work even when provider credentials are unavailable; `!command` sources are not executed for them. `doctor` checks Gateway access and pi-web-access wiring, not provider credentials, and never starts a Gateway or triggers takeover.

A local Gateway first binds the Port, then reads key files and resolves **all** `config.json` credentials, rejecting missing values, placeholders or duplicate resolved keys before loading or saving Account pool state. This also applies to takeover: a client without usable credentials can inspect the broker but cannot become the Port owner. Failed startup releases the Port without changing saved spend; a later takeover retries the current key files and credential sources. The provider dashboard is the source of truth for limits and expiry dates.

Optional settings:

| Setting | Default | Meaning |
|---|---|---|
| `totalTimeoutMs` | 50000 | Total time budget per request (max 55000), kept below pi-web-access's 60 s timeout |
| `attemptTimeoutMs` | 30 s per route | Global per-attempt override. Remove it if an older config sets it to 10000 |
| `maxTransientRetries` | 2 | Retries on Exa 503 `SERVICE_OVERLOADED` |
| `reconcileIntervalMs` | `0` (off) | Optional periodic balance checks (min 120000) |
| Account `reconcile` | `true` | Set to `false` to skip balance checks for that account |
| Account `projectId` | — | Tavily only: sends `X-Project-ID` |
| `pi.wireEnvironment` | `true` | Whether the extension sets the base URLs and token variable, and fills in `web-search.json` |

After editing `config.json` or key files, run `/reload` in pi. It restarts the extension, which re-reads both.

## Standalone mode (no extension)

1. `npm start` (keep it running), or `node src/cli.mjs serve`. It reads the key files when it starts. Ctrl+C (or SIGTERM) lets in-flight searches finish and saves their spend before the port is released; press Ctrl+C again to quit at once.
2. Run `npm run init` once: it creates the config, the `keys` folder and `web-search.fragment.json`. Put your keys in the key files. Merge the fields from `web-search.fragment.json` (`node src/cli.mjs fragment` prints it) into `~/.pi/agent/web-search.json`. **Merge them; don't overwrite the file.**

   ```json
   {
     "exaApiKey": "$PI_SEARCH_BROKER_TOKEN",
     "exaBaseUrl": "http://127.0.0.1:19473/exa",
     "tavilyApiKey": "$PI_SEARCH_BROKER_TOKEN",
     "tavilyBaseUrl": "http://127.0.0.1:19473/tavily",
     "searchRouting": {
       "providers": ["exa", "tavily"],
       "fallbackOn": ["quota", "transient", "network", "invalid-response", "empty"]
     },
     "workflow": "none"
   }
   ```

3. Export `PI_SEARCH_BROKER_TOKEN` (the `gateway.token` value) in the environment pi starts from.
4. Run `npm run doctor` from that same shell.

**Configuration pitfalls**:

- **Key precedence.** A *plain* `exaApiKey` / `tavilyApiKey` value in `web-search.json` is overridden by an exported `EXA_API_KEY` / `TAVILY_API_KEY`. If those hold real provider keys, pi sends them to the broker, which answers 401, and pi treats 401 as an auth error with **no fallback**. The `"$PI_SEARCH_BROKER_TOKEN"` form is an explicit source that always wins.
- **No Exa key means the broker is bypassed.** If no Exa key resolves, pi-web-access silently uses the keyless Exa MCP endpoint (`mcp.exa.ai`) and never contacts the broker.
- **`TAVILY_API_KEY_1..20` should be unset.** They do not bypass the broker. pi-web-access sends those real keys to `tavilyBaseUrl` first, each gets a 401 from the broker, and only then does pi send the token. That wastes round trips and hands real keys to the local process.
- **`EXA_BASE_URL` / `TAVILY_BASE_URL`** override the config base URLs.
- **A top-level `provider` / `searchProvider`** in `web-search.json` overrides `searchRouting`. When the model explicitly passes `provider: "exa"` or `"tavily"`, there is also no cross-provider fallback: an exhausted broker is then a hard error.
- **Exhaustion replies.** When every account is used up the broker answers **429** (pi: `quota`). When every attempt failed for temporary reasons it answers **503**, or **504** after a timeout (pi: `transient`). Keep both `quota` and `transient` in `searchRouting.fallbackOn` so pi falls back to the other provider.
- **Exa `/contents`** only carries traffic if `fetchRouting.providers` includes `"exa"`. Otherwise only searches use the broker.
- **Loopback only.** pi-web-access allows loopback HTTP base URLs. Never expose the gateway beyond `127.0.0.1`.
- **Shared port, shared gateway token.** Processes joining the same Port owner must use the same gateway token. A different token cannot control the existing gateway and will receive 401; `/broker doctor` reports the mismatch without printing either token.

## Managing accounts (CLI)

```bash
npm run status                                  # live from the gateway, or read-only from pool-state.json if it is down
npm run doctor
node src/cli.mjs reconcile [ACCOUNT_ID]
node src/cli.mjs disable exa-account-1
node src/cli.mjs enable exa-account-1
node src/cli.mjs set-spent exa-account-1 promo 12.50
node src/cli.mjs set-spent tavily-account-1 monthly 230
```

`set-spent` corrects **the amount already spent from an allocation** to match the dashboard: USD for Exa, credits for Tavily. It does not set the remaining balance. It also clears the account's disabled state; any separate cooldown remains in effect.

After changing key files, expiry dates or the account list in `config.json`, run `/reload` in pi, or restart the standalone gateway.

## Security and accuracy limitations

- Real keys never go into `pool-state.json`, `keys.index.json`, `/status`, logs, error bodies or pi session data. **Key files and `config.json` may contain literal keys**, so keep `~/.config/pi-search-broker` out of cloud sync and Git, or use `$ENV` / `!command` sources in `config.json`.
- `gateway.token` is a secret, too. With the extension it lives only in pi's process environment (`PI_SEARCH_BROKER_TOKEN`); in standalone mode protect the shell profile that exports it.
- Gateway discovery does not authenticate the Port owner: another local process that impersonates the broker's `/health` response can receive the gateway token when a client connects. Health checks and authenticated requests do not follow redirects, but that does not prevent direct local impersonation.
- Local numbers are estimates unless the provider reported the cost (`costDollars.total`, `usage.credits`). Balance checks are shown alongside them, never applied automatically.
  - If saving state fails, a running broker pauses new attempts and retries the save before accepting another one. A restart or Port owner takeover can only load the last successful save and cannot reliably detect missing spend. After a storage failure or crash, check the provider dashboards or `/broker reconcile`, then use `set-spent` to correct local figures.
  - Exa's `/credits` can lag by up to 5 minutes.
  - Tavily may report `0` credits for a single call on threshold-billed endpoints.
  - Whether Tavily bills searches that fail or time out is undocumented. Timed-out attempts are counted as possibly billed.
- Exa draws soonest-expiring credits first, which matches the local order. The interaction between the monthly free grant and promo credits is undocumented; near a promo expiry, check the dashboard (or `/broker reconcile`) and use `set-spent`.
- **Account rules:**
  - Exa grants the monthly free $10 **only to a user's first team**, so pooled free accounts only work if they belong to different users.
  - Rate limits are per team (Exa) or per key (Tavily, likely).
  - Do not use rotation to evade either provider's terms of service.
- Months and `resetDay` are UTC.
- One gateway owns `pool-state.json` at a time. The extension enforces this through the port, so do not run a standalone gateway on a different port against the same config. On graceful shutdown the owner cancels balance checks and waits for in-flight searches to settle before releasing the port; an injected fetch that ignores cancellation and timeouts can delay shutdown indefinitely.
- Upgrading from 0.2.x: the first gateway of 0.3 or later starts `pool-state.json` from the old `state.json` and never writes the old file, so 0.2.x pi processes that are still open keep working until you `/reload` them. Spend recorded by those older processes after the upgrade is not carried over; check with `/broker reconcile` and `set-spent` if needed.
- Upgrading from 0.5.x: the config folder is now `~/.config/pi-search-broker` (earlier releases used an older folder name). Move the old folder to that path before starting 0.6; there is no automatic migration. The `import` command is gone: put keys in key files instead. Accounts already in `config.json` keep working.
- Upgrading from 0.3.x or 0.4.x: `/reload` switches to the new extension only when no in-process subagent is still using the broker. Otherwise restart pi, so the new extension does not keep running against the older Port owner module.
- `/status` and `/broker status` show the most recent request metadata (provider, account, status, request id, cost). They never show queries.

## Development

```bash
npm run check
npm test
```

The tests use only the standard library and the built-in test runner. They need no external network access and no real provider credentials. Balance policy is tested through the balance-check module's interface with a real Account pool, `memoryStore`, controlled time and Provider replies; focused HTTP translation and Gateway shutdown tests remain separate.

Layout:

| Path | Purpose |
|---|---|
| `src/config.mjs` | Validated metadata and credential source syntax for inspection (the one owner of `$ENV` / `!command` / literal rules and Allocation checks); creates (with no Accounts), reads and atomically saves the config file, and removes Accounts from it; resolves and validates `config.json` credentials only for local Gateway startup |
| `src/files.mjs` | `atomicWriteJson`: temp file plus rename, mode 0600, shared by the config and pool state writers |
| `src/providers.mjs` | One policy object per provider (routes, headers, request preparation, cost rules, error classification, sanitizing, balance endpoint) plus the shared `ACTION` / `EFFECT` / `EXHAUST` constants |
| `src/broker.mjs` | Brokered request: runs one request across an account pool (attempts, rotation, retries, billing, exhaustion and unsaved-state replies) and returns `{status, body}` |
| `src/gateway.mjs` | Gateway: `start()` binds the Port, reads key files and resolves `config.json` credentials (skipping key-file duplicates, leaving out placeholders that key files replace), records the key-free key index, then loads the Account pool and removes replaced placeholders from `config.json`; any failure releases the Port without writing Account pool state. `stop()` refuses new work, cancels balance checks, lets in-flight work settle and releases the Port. In between: auth, routing, body parsing and replies around the broker |
| `src/pool.mjs` | Account pool: accounts, allocations, health and spend. `attempt()` runs one attempt on a Reservation that ends exactly once (`settle`, `settlePossiblyBilled`, `fail`; credit comes back if it never ends; a save that fails throws `StateNotSaved` with that ending); `recordBalanceCheck()` stores provider balances; keeps the attempt log |
| `src/pool/health.mjs` | Account health: what each failure effect does to an account (disable, quota, cooldowns) and how it recovers |
| `src/pool/allocation.mjs` | Allocation calendar: windows, reset days, spending order, and when an out-of-credit account is worth retrying |
| `src/pool/store.mjs` | Where pool state lives: `fileStore` (`pool-state.json`, optionally read-only; started once from a 0.2.x `state.json`, which is never written) or `memoryStore` |
| `src/reconcile.mjs` | Optional, report-only provider balance checks: one account at a time with a rate gap per account, each result recorded with `pool.recordBalanceCheck`; the Gateway cancels them when it stops |
| `src/format.mjs` | Human-readable status: the footer line and the status report |
| `src/log.mjs` | `quietLogger`: an optional logger that never throws |
| `src/numbers.mjs` | Number helpers (`round6`, `isNonNegativeNumber`) |
| `src/clock.mjs` | Time for the brokered request (`now`, `sleep`, `timeout`: attempt timeouts, the deadline, backoff): `realClock`; tests pass a fake clock that fires timeouts on demand |
| `src/control.mjs` | Broker control: one interface (`health`, `status`, `enable`, `disable`, `setSpent`, `reconcile`) with HTTP and offline (read-only, from the state file plus the key-free `keys.index.json`, never key files) adapters here and an in-process adapter built by the Gateway; `connectControl` picks HTTP or offline for the CLI |
| `src/keys.mjs` | Key files: reads `keys/<provider>*.txt` (one Account per key, Allocations from settings lines, ids from key fingerprints); the key folder a Gateway reads, which saves `keys.index.json` and removes replaced placeholders from `config.json`; reads the index for offline status; creates the key file templates. The only module that reads key files |
| `src/commands.mjs` | Account commands shared by the CLI and `/broker`: parser, usage text, result formatting |
| `src/host.mjs` | Process singleton used by the extension: on first start creates the config and key file templates and fills in missing `web-search.json` key settings; decides with one look at the port whether this process is the Port owner, a client or offline, and hands out one view (`role`, `control`, `issue`, `url`); takeover (not while waiting for keys), environment wiring, and doctor as this process sees it |
| `src/doctor.mjs` | pi-web-access wiring: checks Gateway access and wiring without resolving Account credentials, reading key files or starting a Gateway, and fills in the key settings `web-search.json` lacks (for the host); words broker-control problems for doctor and the host |
| `extension/index.js` | The pi extension |
| `src/cli.mjs` | Standalone CLI (`main(argv)` is exported for tests); `serve` drains on Ctrl+C / SIGTERM |
| `scripts/check.mjs` | Syntax-checks every module (`npm run check`) |

Re-run the pi-web-access audit ([docs/research/pi-web-access.md](docs/research/pi-web-access.md)) whenever pi-web-access is upgraded: a new Exa/Tavily endpoint there would return 404 here, which pi classifies as `unknown` (no fallback).
