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
  | Other 5xx / network errors | 10-second cooldown on that account; try the next one |
  | Attempt timeout | Counted as *possibly billed*; **not** retried on another account (that could bill twice). Returns 504 so pi falls back to the other provider |
  | Other 4xx (400, 404, 422…) | Returned to the client with the provider's own message (keys redacted) |

- **No billing surprises:**
  - `stream: true` is rejected up front, because a stream can't be metered and would be retried on every account.
  - The per-attempt timeout is 30 s on every route.
  - A timed-out attempt is counted as *possibly billed* and never retried on another account.
  - A 2xx with an unparseable body is never retried on another account.
  - If pi aborts the call, the upstream request is aborted too.
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
  - One-time promo credits (`once` + `expiresAt`, or `"expires": "never"` for Exa's onboarding bonus) are spent before monthly allowances, earliest expiry first.
  - Monthly allowances support `resetDay` (UTC) and `startsAt`.
- **Safety:**
  - Listens on loopback only, and every request needs the local token.
  - Upstream origins are fixed.
  - Keys never appear in `state.json`, `/status`, logs, error bodies, pi notifications or the footer.
  - A Tavily body `api_key` is stripped so the local token never leaves the machine.
  - Account keys can come from `$ENV` / `!command` sources, so they never have to touch disk.
- **Debuggability:** per-account last request id (Exa `requestId`, Tavily `request_id`), the last error tag, and the most recent 50 attempts in `/status`.

## Quick start (recommended: pi extension)

1. Create the private broker config (Node 20.3+, no `npm install`):

   ```bash
   npm run init
   ```

   This creates the following files and **never overwrites** existing ones:
   - `~/.config/pi-dual-key-manager/config.json` (mode 0600)
   - `web-search.fragment.json` next to it, used only for standalone mode

   Set `PI_SEARCH_BROKER_CONFIG` to use another path.

2. Edit `config.json` **on your own machine only**. Never paste it into a chat. Example (all keys and dates are fake):

   ```json
   {
     "gateway": { "host": "127.0.0.1", "port": 19473, "token": "use the 64-character random token generated by init" },
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
       },
       {
         "id": "tavily-account-1",
         "provider": "tavily",
         "apiKey": "tvly-REPLACE_WITH_REAL_KEY",
         "allocations": [{ "id": "monthly", "limit": 1000, "period": "monthly", "resetDay": 1 }]
       }
     ]
   }
   ```

   Key sources follow pi's own syntax:
   - `"$NAME"` or `"${NAME}"` reads an environment variable.
   - `"!command"` runs a trusted local command (5 s timeout).
   - `"$$..."` escapes a literal leading `$`.
   - Anything else is a literal key.

   Every `id` must be unique, and duplicate keys are rejected. The provider dashboard is the source of truth for limits and expiry dates.

   Optional settings:

   | Setting | Default | Meaning |
   |---|---|---|
   | `totalTimeoutMs` | 50000 | Total time budget per request (max 55000), kept below pi-web-access's 60 s timeout |
   | `attemptTimeoutMs` | 30 s per route | Global per-attempt override. Remove it if an older config sets it to 10000 |
   | `maxTransientRetries` | 2 | Retries on Exa 503 `SERVICE_OVERLOADED` |
   | `reconcileIntervalMs` | `0` (off) | Optional periodic balance checks (min 120000) |
   | Account `reconcile` | `true` | Set to `false` to skip balance checks for that account |
   | Account `projectId` | — | Tavily only: sends `X-Project-ID` |
   | `pi.wireEnvironment` | `true` | Whether the extension sets the base URLs and token variable (see below) |

3. Install the extension into pi. It is a pi package: the `pi.extensions` field in `package.json` points at `extension/index.js`.

   ```bash
   pi install /absolute/path/to/pi-search-broker
   ```

   On every pi session the extension:
   - **starts the gateway inside pi**, or joins one already running in another pi process. Only one process per machine owns the port; the others are clients and take over automatically when the owner exits. In-process subagents share the same gateway through reference counting.
   - **points pi-web-access at the broker for this pi process.** It sets `EXA_BASE_URL` and `TAVILY_BASE_URL` (which pi-web-access reads on every request and which win over `web-search.json`) and `PI_SEARCH_BROKER_TOKEN`. It never overrides or removes your provider keys. Everything is restored when the last session ends. Commands the agent runs in bash inherit these variables, but the token only works against the loopback gateway. Set `"pi": { "wireEnvironment": false }` to opt out.
   - **warns at session start** if pi-web-access would not authenticate to the broker: wrong or missing key source, or `TAVILY_API_KEY_n` set. It shows the exact fix.
   - **shows remaining credits in the footer**, for example `search: exa $41.20 (2/3) · tavily 1,840cr (2/2)`.
   - **adds `/broker`:**

     ```text
     /broker [status]                         accounts and remaining credits
     /broker enable|disable <account>
     /broker set-spent <account> <alloc> <n>  correct local spend to the dashboard value
     /broker doctor                           check that pi-web-access really goes through the broker
     /broker reconcile [account]              show provider-reported balances (report-only)
     ```

4. Tell pi-web-access to authenticate with the broker token. Add these two keys to `~/.pi/agent/web-search.json` (create the file if needed):

   ```json
   { "exaApiKey": "$PI_SEARCH_BROKER_TOKEN", "tavilyApiKey": "$PI_SEARCH_BROKER_TOKEN" }
   ```

   This explicit source wins over any `EXA_API_KEY` / `TAVILY_API_KEY` you have exported. Without an Exa key, pi-web-access would silently use the keyless Exa MCP endpoint and bypass the broker. Run `/broker doctor` to check.

5. After editing `config.json`, run pi's `/reload`. It restarts the extension, which re-reads the broker config.

## Standalone mode (no extension)

1. `npm start` (keep it running), or `node src/cli.mjs serve`.
2. Merge the fields from `web-search.fragment.json` (`npm run init` creates it; `node src/cli.mjs fragment` prints it) into `~/.pi/agent/web-search.json`. **Merge them; don't overwrite the file.**

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

## Managing accounts (CLI)

```bash
npm run status                                  # live from the gateway, or read-only from state.json if it is down
npm run doctor
node src/cli.mjs reconcile [ACCOUNT_ID]
node src/cli.mjs disable exa-account-1
node src/cli.mjs enable exa-account-1
node src/cli.mjs set-spent exa-account-1 promo 12.50
node src/cli.mjs set-spent tavily-account-1 monthly 230
```

`set-spent` corrects **the amount already spent from an allocation** to match the dashboard: USD for Exa, credits for Tavily. It does not set the remaining balance.

After changing keys, expiry dates or the account list in `config.json`, run `/reload` in pi, or restart the standalone gateway.

## Security and accuracy limitations

- Real keys never go into `state.json`, `/status`, logs, error bodies or pi session data. **`config.json` itself may contain literal keys**, so keep it out of cloud sync and Git, or use `$ENV` / `!command` sources.
- `gateway.token` is a secret, too. With the extension it lives only in pi's process environment (`PI_SEARCH_BROKER_TOKEN`); in standalone mode protect the shell profile that exports it.
- Local numbers are estimates unless the provider reported the cost (`costDollars.total`, `usage.credits`). Balance checks are shown alongside them, never applied automatically.
  - Exa's `/credits` can lag by up to 5 minutes.
  - Tavily may report `0` credits for a single call on threshold-billed endpoints.
  - Whether Tavily bills searches that fail or time out is undocumented. Timed-out attempts are counted as possibly billed.
- Exa draws soonest-expiring credits first, which matches the local order. The interaction between the monthly free grant and promo credits is undocumented; near a promo expiry, check the dashboard (or `/broker reconcile`) and use `set-spent`.
- **Account rules:**
  - Exa grants the monthly free $10 **only to a user's first team**, so pooled free accounts only work if they belong to different users.
  - Rate limits are per team (Exa) or per key (Tavily, likely).
  - Do not use rotation to evade either provider's terms of service.
- Months and `resetDay` are UTC.
- One gateway owns `state.json` at a time. The extension enforces this through the port, so do not run a standalone gateway on a different port against the same config.
- `/status` and `/broker status` show the most recent request metadata (provider, account, status, request id, cost). They never show queries.

## Development

```bash
npm run check
npm test
```

The tests use only the standard library and the built-in test runner. They need no network access and no real API keys.

Layout:

| Path | Purpose |
|---|---|
| `src/providers.mjs` | One policy object per provider (routes, headers, request preparation, cost rules, error classification, sanitizing, balance endpoint) plus the shared `ACTION` / `EFFECT` / `EXHAUST` constants |
| `src/broker.mjs` | Brokered request: runs one request across an account pool (attempts, rotation, retries, billing, exhaustion replies) and returns `{status, body}` |
| `src/gateway.mjs` | HTTP server: auth, routing, body parsing and replies around the broker |
| `src/pool.mjs` | Account pool: accounts, allocations, health and spend. Hands out reservations that end exactly once (`settle`, `settleUncertain`, `fail`, `abandon`) and keeps the attempt log |
| `src/pool/store.mjs` | Where pool state lives: `fileStore` (`state.json`, optionally read-only) or `memoryStore` |
| `src/reconcile.mjs` | Optional, report-only provider balance checks |
| `src/client.mjs` | Authenticated loopback client for a running gateway (CLI and non-owner pi processes) |
| `src/host.mjs` | Process singleton, port ownership, takeover and environment wiring, used by the extension |
| `src/doctor.mjs` | Checks that pi-web-access really uses the broker |
| `extension/index.js` | The pi extension |
| `src/cli.mjs` | Standalone CLI |
| `scripts/check.mjs` | Syntax-checks every module (`npm run check`) |

Re-run the pi-web-access audit ([docs/research/pi-web-access.md](docs/research/pi-web-access.md)) whenever pi-web-access is upgraded: a new Exa/Tavily endpoint there would return 404 here, which pi classifies as `unknown` (no fallback).
