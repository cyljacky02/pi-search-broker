# pi-web-access (v0.47.0): Exa and Tavily wire contract, for pi-search-broker

Researched 2026-11 against the installed package and upstream `main`.

Citation conventions:

- `PWA/<file>:<line>` = `~/.pi/agent/npm/node_modules/pi-web-access/<file>` (TypeScript source, v0.47.0).
- `broker/<file>:<line>` = this repository.
- Upstream = https://github.com/nicobailon/pi-web-access.

Pi actually loads the bundled `./dist` build (`PWA/package.json` `"pi": { "extensions": ["./dist"] }`). The bundle has the same constants as the TS source: `x-exa-integration` at `PWA/dist/index.js:4180`, `TAVILY_API_BASE_URL` at `:14160`, and `TAVILY_KEY_POOL_RETRIES` at `:14187`. The installed `exa.ts` and `tavily.ts` match upstream tag `v0.47.0` byte for byte (checked with `git show v0.47.0:exa.ts | diff`).

---

## TL;DR

- **pi-web-access 0.47.0 makes exactly three keyed HTTP calls that a gateway can intercept:** Exa `POST {exaBaseUrl}/search`, Exa `POST {exaBaseUrl}/contents`, and Tavily `POST {tavilyBaseUrl}/search`. **The broker already serves all three.** No keyed code path calls Exa `/answer`, `/research`, `/context`, or `/findSimilar`, or Tavily `/extract`, `/crawl`, `/map`, or `/research`. Exa `/answer` was removed (`PWA/CHANGELOG.md:336`) and `code_search` was removed (`PWA/CHANGELOG.md:812`). **No routes are missing today.**
- The only other Exa call goes to the keyless MCP endpoint `https://mcp.exa.ai/mcp`. That URL is hardcoded and ignores `exaBaseUrl` (`PWA/exa.ts:10`, `PWA/exa.ts:246`, `PWA/README.md:767`). It runs only when no Exa key resolves. If the broker token is missing from pi's config, Exa searches silently go to the free MCP endpoint and skip the broker.
- **Exhaustion contract:** pi turns a non-2xx reply into `"Exa API error <status>: <body[:300]>"` or `"Tavily API error <status>: ..."`. `searchRouting` checks credential and abort errors before status; otherwise **402/429 (and 432 for Tavily) → `quota`; 408/425/≥500 → `transient`; 401/403 → `auth`; 400/422 → `invalid-request`** (`PWA/gemini-search.ts:415-474`). `aborted`, `auth` and `invalid-request` can never be listed in `fallbackOn`. The broker's normal exhaustion reply (HTTP 429, or 503 after transient failures, with a JSON body) is correct.
- **pi-web-access ignores `Retry-After` for Exa and Tavily.** Only Brave reads it (`PWA/brave-rate-limit.ts:58`).
- **pi-web-access rotates keys itself, for Tavily only:** `TAVILY_API_KEY_1..20`, retried on 401/402/403/429/432 (`PWA/tavily.ts:63-74`, `PWA/tavily.ts:204-222`). When those variables are set, pi sends the real pool keys **to the broker**, because the base URL still applies. The broker rejects them with 401 and pi falls through to the broker token last. This works, but it wastes round trips and hands real keys to the local process. The broker README says the pool "may bypass this gateway"; that is inaccurate.
- **Credential precedence trap:** a plain `exaApiKey`/`tavilyApiKey` in `web-search.json` is **overridden by the `EXA_API_KEY`/`TAVILY_API_KEY` environment variables** (`PWA/credential-source.ts:241`). A shell that still exports a real provider key will send that key to the broker. The broker answers 401, pi classifies it as `auth`, and the search does not fall back.
- Broker gaps worth fixing:
  1. Tavily **433** (PayGo limit) and **434** (Flex capacity) are not handled. The broker passes them through, pi classifies them as `unknown`, and neither rotation nor fallback happens.
  2. The default 10 s per-attempt timeout is too short for Exa `/contents` and for Tavily `include_raw_content`. A timeout also puts a healthy account into cooldown.
  3. A request with `stream: true` would burn credits across every account.
  4. Tavily accounting could be exact with `include_usage`.

  See the last section for the full list.
- **Live config:** no `web-search.json` exists at any path pi checks (details in §3.4). pi therefore runs with defaults: `auto` routing and keyless Exa MCP. **The broker is currently not in pi's request path at all.**
- **Upstream:** npm `latest` is 0.47.0 (published 2026-11-05). Upstream `main` (`6dd57b7`, 2026-11-06) has 4 commits after `v0.47.0`: the cloro provider, DuckDuckGo pacing, an AnySearch fix, and answer-mode images. **None of them touch `exa.ts`, `tavily.ts`, credential resolution, or error classification.** The only `gemini-search.ts` diff registers `cloro`.

---

## 1. Wire contract

### 1.1 Exa

| # | Endpoint | Method | Headers sent | Request body (and conditions) | Timeout | Response fields read | Triggered by | Broker support |
|---|---|---|---|---|---|---|---|---|
| E1 | `{exaBaseUrl}/search` (`PWA/exa.ts:511`) | POST | `x-api-key: <key>`, `Content-Type: application/json`, `x-exa-integration: pi-web-access` (`PWA/exa.ts:94-100`). No custom User-Agent; Node's default fetch headers apply. | `query`; `type: "auto"` (always); `numResults` (= `options.numResults ?? 5`, not clamped here; the tool schema bounds it to 1-20); `includeDomains` / `excludeDomains` (only when non-empty; `-` prefix means exclude; values are trimmed only); `category` (only if passed); `startPublishedDate` (only with `recencyFilter`: now minus 1/7/30/365 days, ISO). Sources: `PWA/exa.ts:107-144`. `contents: { highlights: true }`, or `{ text: true, highlights: true }` when `includeContent` (`PWA/exa.ts:514-519`). Never sends `stream`, `userLocation`, `livecrawl`, `maxAgeHours`, or `summary`. | 60 s, combined with the caller's signal (`PWA/exa.ts:102-105`) | `results[]` with `.url`, `.title`, `.text`, `.highlights` (strings only), `.publishedDate`, `.author`, and `.entities[]` where `type=="publication"`: `.properties.{date,year,authors[].name,citationCount,doi}` (`PWA/exa.ts:146-230`). Not read: `costDollars`, `requestId`, `searchTime`, `highlightScores` (declared but unused, `PWA/exa.ts:29`). | `web_search`, `source_check`, curator / `/websearch`, `provider:"all"`, and `auto` routing | **Yes**: `/exa/search` (`broker/src/gateway.mjs:6-10`) |
| E2 | `{exaBaseUrl}/contents` (`PWA/exa.ts:571`) | POST | Same as E1 | `{ "urls": [<one url>], "text": true }`, exactly this shape (`PWA/exa.ts:574`) | `options.timeoutMs ?? 60 s` (`PWA/exa.ts:14`, `PWA/exa.ts:561-562`) | `results[0].text`, `results[0].title`; `statuses[]` where `status=="error"` → `.error.tag`, `.error.httpStatusCode`, raised as `"Exa could not read <url>: <tag> (HTTP n)"` (`PWA/exa.ts:580-602`). A body without a `results` array is an error (`PWA/exa.ts:581-583`). | `fetch_content`, and the `includeContent` / `source_check` page fetches that go through `fetchAllContent`. Runs **only if** `fetchRouting.providers` contains `"exa"`, **and** an Exa key exists (`PWA/extract.ts:1110-1125`), **and**, for remote URLs, `fetchRouting.allowRemoteHostedProviders: true` (`PWA/extract.ts:832-837`). Not in the default order (`PWA/extract.ts:77`). SSRF validation of the target URL happens client-side first (`PWA/exa.ts:565-570`). | **Yes**: `/exa/contents` |
| E3 | `https://mcp.exa.ai/mcp?tools=<web_search_exa\|web_search_advanced_exa>` (`PWA/exa.ts:10-13`, `PWA/exa.ts:246`) | POST (JSON-RPC `tools/call`) | `Content-Type`, `Accept: application/json, text/event-stream`, `x-exa-source: pi-web-access`; **no key** (`PWA/exa.ts:248-253`) | Basic: `{query (+ site:/recency/category words), numResults}`. Advanced: E1 args plus `enableHighlights`, `textMaxCharacters` 3000/50000 (`PWA/exa.ts:385-465`) | 60 s | SSE `data:` lines or JSON `result.content[].text`, `result._meta["ai.exa/rateLimited"]`, `result.isError` (`PWA/exa.ts:276-336`) | Exa search **only when no Exa key resolves** (`PWA/exa.ts:502-505`) | **N/A**: hardcoded host and not configurable, so a broker cannot intercept it |

There are **no** Exa calls for answer, research, code search, or similar-links. A code search tool existed and was removed (`PWA/CHANGELOG.md:812`, `:850`, `:871`). Keyed `/answer` was replaced by `/search` (`PWA/CHANGELOG.md:336`, which says *"If you route Exa through a custom `exaBaseUrl` gateway, it must support `/search`"*). `fetch_content` answer mode and extract mode use Pi or Cloudflare models, not Exa (`PWA/page-query.ts:1-7`, `PWA/README.md:276`). The Tabstack research URL (`PWA/tabstack.ts:8`) belongs to a different provider.

### 1.2 Tavily

| # | Endpoint | Method | Headers sent | Request body (and conditions) | Timeout | Response fields read | Triggered by | Broker support |
|---|---|---|---|---|---|---|---|---|
| T1 | `{tavilyBaseUrl}/search` (`PWA/tavily.ts:76-84`) | POST | `Authorization: Bearer <key>`, `Content-Type: application/json` (`PWA/tavily.ts:226-235`). No other headers. | `query`; `search_depth: "basic"` (always); `max_results` (clamped to 1-20, default 5: `PWA/search-result-count-normalization.ts:1-4`); `include_answer: "basic"` (always); `include_raw_content: "markdown"` when `includeContent`, else `false`; `time_range: "day"\|"week"\|"month"\|"year"` (only with `recencyFilter`); `include_domains` / `exclude_domains` (normalized to bare hostnames, deduplicated, and invalid entries dropped: `PWA/domain-filter-normalization.ts:1-14`, `PWA/tavily.ts:99-113`). Sources: `PWA/tavily.ts:160-171`. Never sends `topic`, `chunks_per_source`, `include_usage`, `auto_parameters`, `country`, or `include_images`. | 60 s shared across all pool retries (`PWA/tavily.ts:12`, `PWA/tavily.ts:115-118`, `PWA/tavily.ts:174`) | `answer` (string), `results[]` with `.url`, `.title`, `.content` (snippet, whitespace collapsed), `.raw_content` (only when `includeContent`) (`PWA/tavily.ts:124-150`, `PWA/tavily.ts:189-197`). Not read: `usage`, `request_id`, `response_time`, `images`. A body that fails to parse becomes `"Tavily API returned invalid JSON"` (`PWA/tavily.ts:250-254`). | `web_search`, `source_check`, curator, `all`, and `auto` routing | **Yes**: `/tavily/search` |

Tavily is not a `fetch_content` provider (`PWA/extract.ts:74`), so nothing calls `/extract`, `/crawl`, or `/map`.

### 1.3 Things that never reach the broker

- **Query strings:** pi never puts a query string on Exa or Tavily REST calls (`PWA/exa.ts:511`, `PWA/exa.ts:571`, `PWA/tavily.ts:84`). It also refuses a base URL that contains one (`PWA/utils.ts:103-105`). The broker's 400 on `url.search` (`broker/src/gateway.mjs:56-57`) therefore never fires for pi traffic.
- **Redirects:** pi follows up to 5 redirects manually and strips `x-api-key`/`Authorization` on a cross-origin hop (`PWA/utils.ts:137-180`, `PWA/exa.ts:521`, `PWA/tavily.ts:235`). The broker never redirects, which is fine.
- **Methods:** only POST. There are no GET or health probes. Availability is decided locally from credentials: `isExaAvailable()` is always `true` (`PWA/exa.ts:489-491`), and `isTavilyAvailable()` checks for a key or a pool (`PWA/tavily.ts:152-158`).

---

## 2. Base URL resolution

`resolveApiBaseUrl` (`PWA/utils.ts:79-111`), called by `getApiBaseUrl` in `PWA/exa.ts:84-92` and `getApiUrl` in `PWA/tavily.ts:76-84`:

1. **Precedence:** the environment variable (`EXA_BASE_URL` / `TAVILY_BASE_URL`) wins over the config key whenever it is defined, even if empty, in which case it throws. Config (`exaBaseUrl` / `tavilyBaseUrl`) comes next, then the default (`https://api.exa.ai`, `https://api.tavily.com`) (`PWA/utils.ts:80-82`, `PWA/exa.ts:9`, `PWA/tavily.ts:10`).
2. **Validation:** the value must be an absolute URL. It must be HTTPS, unless it is HTTP **and** either the host is loopback (`localhost`, `::1`, or any `127.0.0.0/8`: `PWA/utils.ts:47-52`) or `allowHttpBaseUrls: true` / `PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS=true|1` (`PWA/utils.ts:58-77`, `PWA/utils.ts:97-99`). Userinfo, query strings, and fragments are rejected (`PWA/utils.ts:100-105`). An invalid override throws. It never falls back to the official endpoint (`PWA/README.md:767`).
3. **Path joining:** trailing slashes are stripped (`PWA/utils.ts:109-110`) and the code appends `"/search"` or `"/contents"` literally. **No `/v1` or anything else is added.** `http://127.0.0.1:19473/exa/` becomes `http://127.0.0.1:19473/exa/search`. A base without the `/exa` or `/tavily` prefix would hit the broker's `/search`, get a 404, and pi would classify it as `unknown` (§4).
4. **Proxy interplay:** a config-level `proxy` (optionally with `lockProxy`) reroutes the extension's fetches through curl, but **loopback hosts are always bypassed**: `localhost`, `*.localhost`, `127.0.0.1`, `::1`, and `NO_PROXY` matches (`PWA/utils.ts:369-378`, `PWA/README.md:466`). Only `127.0.0.1` exactly is bypassed, not all of `127/8`. The broker's host whitelist (`broker/src/config.mjs:17-19`) is compatible.

---

## 3. Credential resolution and key rotation

### 3.1 Single key (Exa and Tavily)

`resolveCredential` (`PWA/credential-source.ts:202-242`), called from `PWA/exa.ts:75-82` and `PWA/tavily.ts:54-61`:

| Config value form | Result |
|---|---|
| `"$$..."` / `"$!..."` | Literal value with the escape removed (`:205`) |
| `"!command"` | Run through Git Bash or `cmd` with a 5 s timeout, 16 KB cap, and a filtered environment. Stdout is trimmed. Failures raise `CredentialResolutionError` (`:206-232`). |
| `"$NAME"` / `"${NAME}"` | Read that environment variable. If it is empty, raise `CredentialResolutionError("environment-empty")` (`:234-240`). |
| Plain literal | **`EXA_API_KEY` / `TAVILY_API_KEY` wins if set**, otherwise the literal is used (`:241`) |

Consequences for the broker:

- **Recommended pi config:** `"exaApiKey": "$PI_SEARCH_BROKER_TOKEN"` (or `"!<command that prints the token>"`). An explicit source beats a stray `EXA_API_KEY` that holds a real key.
- If an explicit source fails, `CredentialResolutionError` is classified as `credential` (`PWA/gemini-search.ts:438-439`). That kind is never fall-back-able, and `auto` mode rethrows it (`PWA/gemini-search.ts:878-880`).
- If Exa resolves no key at all, the search silently goes to the keyless MCP endpoint (E3) instead of the broker (`PWA/exa.ts:502-505`).

### 3.2 Tavily key pool (built-in rotation)

- `TAVILY_API_KEY_1`…`TAVILY_API_KEY_20` are read and deduplicated. The starting slot is `TAVILY_API_KEY_INDEX` (default 1) and the order wraps around (`PWA/tavily.ts:65-74`).
- The order is: every pool key once, then the standalone `tavilyApiKey` / `TAVILY_API_KEY`, but only after every pool key has failed and only if it is not already in the pool (`PWA/tavily.ts:204-222`, `PWA/README.md:829`).
- A key moves to the next one only on HTTP **401, 402, 403, 429, 432** (`PWA/tavily.ts:63`, `PWA/tavily.ts:210`). The status is parsed from `^Tavily API error (\d{3}):` (`PWA/tavily.ts:200-202`). Network errors and 5xx are not retried.
- Every attempt shares one 60 s deadline (`PWA/tavily.ts:174`).
- **Exa has no pool and no rotation.** Each Exa call makes one attempt with one key.

**Conflict analysis.** pi's pool and the broker do not double-rotate the same upstream key, because pi only ever talks to `tavilyBaseUrl`. When the pool is set and points at the broker:

- each pool key reaches the broker, gets 401 (`broker/src/gateway.mjs:61`), and pi moves to the next one;
- finally the token gets through and the broker does its own rotation;
- the cost is N wasted loopback round trips, and real Tavily keys are exposed to the broker process (it does not log them);
- if the user put the broker token itself in a pool slot, Set deduplication prevents repeats.

The correct statement for the broker README is: "pool keys are sent to whatever `tavilyBaseUrl` points at; unset them". It is not true that they "bypass this gateway" (`broker/README.md`, "Configuration notes").

### 3.3 auth-fetch and feature-config

`auth-fetch.ts` only manages browser-cookie `authFetch` profiles for `fetch_content` page fetches. Those require HTTPS target URLs and a host allow-list (`PWA/auth-fetch.ts:22-58`), and are unrelated to provider API keys. `feature-config.ts` only reads `image.enabled` (`PWA/feature-config.ts:6-29`). Neither file affects Exa or Tavily.

### 3.4 The user's live config

`getWebSearchConfigDir` checks `$PI_CODING_AGENT_DIR`, then `$XDG_CONFIG_HOME/pi`, then `~/.pi/agent`, then `~/.pi` (`PWA/utils.ts:11-37`). On this machine, `PI_CODING_AGENT_DIR` and `XDG_CONFIG_HOME` are unset, and neither `~/.pi/agent/web-search.json` nor `~/.pi/web-search.json` exists. No `EXA_*`, `TAVILY_*`, or `PI_WEB_ACCESS_*` variables are set in the agent's shell. The user's interactive shell may differ.

pi is therefore on defaults: `searchProvider: "auto"`, no `searchRouting`, and keyless Exa MCP. `~/.pi/agent/settings.json` lists `npm:pi-web-access` at 0.47.0. A `web-search-cache/` directory exists; it holds the `fetch_content` cache (§6), and its contents were not inspected. **To use the broker, the fragment from `npm run init` must be merged into `~/.pi/agent/web-search.json`.**

---

## 4. Error classification and `searchRouting.fallbackOn`

### 4.1 Where errors come from

| Call | Thrown message on non-2xx |
|---|---|
| Exa search | `Exa API error <status>: <body, key-redacted, first 300 chars>` (`PWA/exa.ts:523-526`) |
| Exa contents | `Exa contents error <status>: ...` (`PWA/exa.ts:577-579`). The fetch path stops on an abort message; otherwise it records the error and moves on to the next fetch provider (`PWA/extract.ts:1119-1124`). |
| Tavily search | `Tavily API error <status>: ...` (`PWA/tavily.ts:245-248`) |

### 4.2 Classifier (`classifyProviderError`, `PWA/gemini-search.ts:421-474`)

The status is the first `\b(error|status|http)\s+(\d{3})\b` match in the message (`PWA/gemini-search.ts:415-419`). For the messages above, that is always pi's own status, never a number inside the broker's body. The rules are evaluated in order:

| Order | Condition | Kind | Can be in `fallbackOn`? |
|---|---|---|---|
| 1 | `CredentialResolutionError`, or text contains "api key not found/missing" or "credential resolution" | `credential` | no |
| 2 | Message contains "abort". **This includes pi's own 60 s `TimeoutError` ("The operation was aborted due to timeout")** and `searchRouting.timeoutMs` (`PWA/gemini-search.ts:358-360`). | `aborted` | no |
| 3 | 401 / 403 | `auth` | no |
| 4 | 400 / 422 | `invalid-request` | no |
| 5 | **402 / 429, plus 432 for Tavily only** (`PWA/gemini-search.ts:452-453`) | **`quota`** | yes |
| 6 | 408 / 425 / ≥500 (`:454-455`) | **`transient`** | yes |
| 7 | Text matches `rate limit\|quota\|too many requests` | `quota` | yes |
| 8 | Text matches `unauthorized\|forbidden\|permission denied` | `auth` | no |
| 9 | Text matches `bad request\|invalid request` | `invalid-request` | no |
| 10 | Text matches `invalid json\|no parseable response\|no parseable results\|invalid response\|returned empty response` | `invalid-response` | yes |
| 11 | Text matches `temporar\|service unavailable\|server error` | `transient` | yes |
| 12 | `TypeError`, or text matches `fetch failed\|network\|econnreset\|econnrefused\|enotfound\|etimedout\|timed out\|socket` | `network` | yes |
| 13 | Text matches config-ish words | `config` | no |
| — | Anything else, e.g. **404, 409, 433, 434** with no keyword match | `unknown` | no |

Valid `fallbackOn` values: `transient`, `quota`, `network`, `invalid-response`, `unsupported`, `empty`, `domain-miss`, `off-topic` (`PWA/gemini-search.ts:136`, `PWA/gemini-search.ts:209-219`).

**A failed state save after a possibly billed Attempt:** The broker returns HTTP 409 with an error message, in the provider's error shape, beginning `Request aborted`. After an Attempt that was refused or never delivered, nothing was billed: it returns 503 without the word, so fallback stays possible. In v0.47.0, both configured sequential routing and default `auto` treat the resulting Provider error as aborted before considering the status, and Exa content extraction also stops on an abort message (`PWA/gemini-search.ts:358-360, 440-441, 813-818, 875-881`; `PWA/extract.ts:1118-1121`). HTTP 500 alone does not stop fallback: it is transient. This is a version-specific text contract, not a guarantee for arbitrary clients or concurrent multi-provider requests; re-check it on upgrades.

- **`empty`:** a 200 response with no results **and** a blank answer (`PWA/gemini-search.ts:746-756`). For Exa, results without a `url` are dropped (`PWA/exa.ts:210-223`).
- **`domain-miss`:** an include-domain filter matched no result.
- **`invalid-response` for Exa REST:** effectively unreachable. A JSON `SyntaxError` reads "...is not valid JSON" or "Unexpected end of JSON input", matches no rule, and becomes `unknown`. A 200 without `results` reads as `empty`.
- **Tavily invalid JSON:** maps to `invalid-response` through the explicit wrapper (`PWA/tavily.ts:253`).

### 4.3 When routing applies

- `searchWithConfiguredRouting` runs only when the call's provider is omitted or `"auto"`, **and** no top-level `provider`/`searchProvider` is set in config (`PWA/gemini-search.ts:243`, `PWA/gemini-search.ts:836-841`).
- An explicit tool argument such as `provider: "exa"` calls the provider directly. There is no fallback in that case (`PWA/gemini-search.ts:838`).
- A config-level provider list falls back to routing only if every failure kind is in `fallbackOn` (`PWA/gemini-search.ts:692-707`).
- Inside the routing loop, an error whose kind is not in `fallbackOn` is rethrown immediately (`PWA/gemini-search.ts:812-818`).
- Plain `auto` mode without `searchRouting` catches any Exa or Tavily error, except credential errors and aborts, and continues down the chain (`PWA/gemini-search.ts:875-895`).

### 4.4 What the broker should return on exhaustion

- **All accounts quota-exhausted, cooling down after 429, or disabled:** **HTTP 429** with a JSON body. The current reply is fine (`broker/src/gateway.mjs:77`, `broker/src/gateway.mjs:127-129`), and pi classifies it as `quota`.
- **All attempts failed with network errors, timeouts, or 5xx:** **HTTP 503** gives `transient`. The broker's 502 for a bad upstream body also gives `transient`.
- **Never** use 400/401/403/404/422 to signal exhaustion. Those classify as non-fall-back-able kinds. **Never** return 200 with empty `results`: that only falls back if the user listed `empty`, and it hides the failure.
- `Retry-After` is **not read** by pi for Exa or Tavily, so setting it is harmless but has no effect on the client. pi has no client-side backoff. It moves to the next provider immediately.
- **Keep the broker's total time well under pi's 60 s deadline.** The current limit is `totalTimeoutMs ≤ 55000` (`broker/src/config.mjs:68-76`). If pi times out first, the error is `aborted`, there is no fallback, and in `auto` mode the whole search fails. If the user sets `searchRouting.timeoutMs`, the broker's total must be lower than that as well.

---

## 5. Options agents and users can pass through

### 5.1 Tool schemas (Pi extension: `PWA/index.ts`; MCP mode: `PWA/mcp-tool-definitions.ts`)

`web_search` (`PWA/index.ts:1433-1458`):

- `query?`: string.
- `queries?`: string[]. Runs at most 3 at a time (`PWA/web-tool-core.ts:161`, `:189-192`).
- `numResults?`: integer 1-20.
- `includeContent?`: boolean.
- `recencyFilter?`: `day` | `week` | `month` | `year`.
- `domainFilter?`: string[]. A `-` prefix excludes.
- `category?`: string, described as "Exa only, e.g. news". Also exposed over MCP (`PWA/mcp-tool-definitions.ts:60`).
- `model?`: OpenAI, xAI, Mistral, or Gemini only.
- `provider?`: `auto`, `all`, one name, or a comma-separated list.
- `workflow?`: `none` | `summary-review` | `auto-summary`.
- `proxy?`: string.

`source_check` (`PWA/index.ts:1988-2007`): `claim`, `queries?` (at most 8), `numResults?` 1-20, `fetchContent?`, `recencyFilter?`, `domainFilter?`, `provider?`, `proxy?`. It calls `search()` **without** `includeContent` or `category` (`PWA/web-tool-core.ts:925-934`). With `fetchContent`, it fetches the top 5 URLs through `fetchAllContent`, which may hit Exa `/contents` (`PWA/web-tool-core.ts:948-956`).

`fetch_content` (`PWA/index.ts:2009+`): `url`/`urls`, `mode`, `prompt`, and so on. There are no Exa-specific parameters. Whether Exa `/contents` is used is decided only by `fetchRouting` in config.

### 5.2 Mapping to provider fields

| Tool option | Exa `/search` | Tavily `/search` |
|---|---|---|
| `numResults` | `numResults` (raw value) | `max_results` (clamped 1-20) |
| `includeContent` | `contents.text: true` (no `maxCharacters`) | `include_raw_content: "markdown"` |
| `recencyFilter` | `startPublishedDate` (ISO, now minus N days) | `time_range` |
| `domainFilter` | `includeDomains` / `excludeDomains` (trimmed) | `include_domains` / `exclude_domains` (normalized hostnames) |
| `category` | `category` | ignored |

The following are **not exposed** and are hardcoded:

- Exa: `type` (always `"auto"`).
- Tavily: `search_depth` (always `basic`, so 1 credit), `topic` (Tavily default `general`), and `include_answer` (`"basic"`).

There is no config knob for any of these in `exa.ts` or `tavily.ts` (`PWA/exa.ts:16-19`, `PWA/tavily.ts:14-17`). The broker's `quote()` handles `type`/`search_depth` values that pi never sends today (`broker/src/manager.mjs:211-223`). That is harmless and future-proof.

---

## 6. Other compatibility topics

- **Caching:** pi does **not** cache Exa or Tavily search responses. Each tool call hits the provider. It caches fetched page content: in memory by `responseId`, and on disk under `web-search-cache/` with a 1 h TTL, 128 entries, and 128 MB (`PWA/storage.ts:9-16`, `PWA/storage.ts:81`; root overridable with `PI_WEB_ACCESS_CACHE_ROOT`). A short-TTL response cache in the broker would save credits on repeated identical requests, for example `source_check` re-runs or parallel subagents. It must key on the full body, because recency and domain options change results.
- **MCP server mode:** `pi-web-access-mcp` (`PWA/mcp-cli.ts`, `PWA/mcp-server.ts:31-36`) exposes the same four tools through `createStandaloneWebToolCore`. It reads the same `web-search.json` and environment, so the broker works unchanged. The environment of the MCP host process matters for the credential precedence trap in §3.1. Over MCP, `off-topic` routing is inactive (`PWA/gemini-search.ts:793-795`).
- **Request IDs:** pi reads neither Exa `requestId` / `x-request-id` nor Tavily `request_id`. The broker passes upstream JSON through unchanged, which preserves them. It drops upstream response headers, which pi does not need.
- **Streaming:** pi never requests SSE from the Exa or Tavily REST APIs. The Exa search spec does offer `text/event-stream` (docs.exa.ai/reference/search). Only the keyless MCP path parses SSE, and that path never touches the broker.
- **Concurrency:** up to 3 queries per `web_search` call. `provider: "all"`, or a provider list such as `"searchProvider": ["exa", "tavily"]`, fans out to the providers at once (`PWA/gemini-search.ts:135`, `:674-678`). The fan-out uses `Promise.allSettled`: successes are merged (results deduplicated by URL, one answer section per provider) and failures are appended as "Provider errors"; the search throws only when every provider fails (`PWA/gemini-search.ts:674-743`). A list from the config file (any length) then continues with the untried `searchRouting.providers` if every failure kind is in `fallbackOn` (`PWA/gemini-search.ts:699-711`, `:829-835`). Config values are trimmed and lower-cased; an unknown string becomes `"auto"`, and duplicates or unknown names in a list make the config invalid (`PWA/gemini-search.ts:252-268`, `:288-292`). Setting `searchProvider` or `provider` at all, even to `"auto"`, stops `searchRouting` from driving default searches (`PWA/gemini-search.ts:176-177`, `:838-839`). Verified live with the broker (2026-11-11): with every Exa account disabled, a search still returned Tavily results and listed Exa's broker 429; and the reverse. Parallel Pi subagents add more. The broker's reservation model (`broker/src/manager.mjs:99-114`) is the right design.
- **Request size:** request bodies are small, well under the broker's 1 MB limit (`broker/src/gateway.mjs:34`). Exa `/contents` responses with full text can be large, and the broker buffers them fully. That is acceptable.

---

## 7. Gaps and recommendations for pi-search-broker

Ordered by impact.

1. **Endpoint coverage: complete for 0.47.0.** Keep `/exa/search`, `/exa/contents`, and `/tavily/search`. Unknown routes return 404, which pi classifies as `unknown` (no fallback) (`broker/src/gateway.mjs:70-71`). If a future pi version adds an Exa or Tavily endpoint, the failure will be loud but will not fall back. Re-run this audit on each pi-web-access upgrade, and check `PWA/README.md:736-737` (the gateway path table) first.
2. **Handle Tavily 433 and 434.** The Tavily docs define 433 as "PayGo limit exceeded" and 434 as "Flex tier capacity exceeded" (docs.tavily.com/documentation/api-reference/endpoint/search). Today they fall into the "Provider rejected request" branch (`broker/src/gateway.mjs:108-111`): no rotation, and pi classifies them as `unknown`, so no fallback. Treat **433 like 432** (mark the account quota-exhausted, rotate, return 429 if every account is exhausted) and **434 like 5xx** (cool down, rotate, return 503).
3. **Per-route attempt timeouts.** The default `attemptTimeoutMs` of 10 s (`broker/src/config.mjs:68`) is shorter than Exa's own default livecrawl timeout of 10 s on `/contents`, and close to slow Tavily `include_raw_content: "markdown"` responses. A timeout also calls `manager.fail(account, 0)`, which puts a healthy account into a 10 s cooldown (`broker/src/manager.mjs:142-163`), and may bill the request upstream twice. Suggestions:
   - Allow about 30-45 s for `/exa/contents` and for search with `contents.text`/`include_raw_content`.
   - Do not cool down an account on a client-side timeout.
   - Keep the total under 55 s.
4. **Document and steer credential precedence.**
   - In the generated fragment (`broker/src/config.mjs:112-119`), prefer `"exaApiKey": "$PI_SEARCH_BROKER_TOKEN"` (and the same for Tavily), or tell users to unset `EXA_API_KEY`/`TAVILY_API_KEY`. Otherwise an exported real key overrides the token (`PWA/credential-source.ts:241`), the broker returns 401, pi classifies it as `auth`, and the search does not fall back.
   - Optionally, when the supplied credential is not the token and looks like a provider key (for example a `tvly-` prefix), return 401 with a hint such as "a provider key was sent; configure the broker token". Never echo the key back.
5. **Correct the Tavily pool note in `README.md`.** Pool keys are sent to the broker, not around it. Tell users to unset `TAVILY_API_KEY_1..20` so that real keys are not sent to the broker and the extra 401 round trips go away (`PWA/tavily.ts:204-222`).
6. **Exhaustion status: keep 429/503, consider "quota wins".** `lastFailureStatus` takes the status of the *last* failed attempt (`broker/src/gateway.mjs:97`, `:105`, `:120`), so the reply mixes 429 and 503 depending on attempt order. If a user's `fallbackOn` lists only one of `quota` or `transient`, the outcome becomes order-dependent. Either document that both should be listed (the generated fragment already does), or return 429 whenever any account was quota- or rate-limited.
7. **Reject `stream: true`, and any body the broker cannot meter, with 400.** Today an SSE reply fails `.json()`, gets classified as 502, and the broker rotates through *every* account (`broker/src/gateway.mjs:113-121`). Each attempt may be billed upstream. pi never sends `stream`, so rejecting it costs nothing.
8. **Exact Tavily accounting.** Inject `"include_usage": true` upstream and commit `usage.credits` (Tavily docs: `include_usage` → `usage.credits`). pi ignores the extra field (`PWA/tavily.ts:19-28`). This makes `actualCost` exact for Tavily as well (`broker/src/manager.mjs:225-229`).
9. **Surface sanitized upstream errors for non-retryable 4xx.** pi shows up to 300 characters of the body in its diagnostics (`PWA/exa.ts:525`, `PWA/tavily.ts:247`). Passing through Exa's `{error, tag, requestId}` or Tavily's `detail.error` (after key redaction) would make `invalid-request` failures debuggable. Today the broker returns only "verify query options" (`broker/src/gateway.mjs:109-111`). Avoid words in the body such as "rate limit" or "unauthorized" unless they are intended. They only matter when the status code itself matches no rule.
10. **Log request IDs.** Record Exa `requestId` / `x-request-id` and Tavily `request_id` per account in local logs or `/status`, for provider support tickets. pi does not need them.
11. **Optional response cache.** Use a short TTL (for example 5-15 min), keyed on provider, path, and canonical JSON body. Skip it for recency-filtered queries or give those a shorter TTL. Make it opt-in, because results go stale.
12. **Health and "is pi using me?" check.** Because Exa silently falls back to the keyless MCP endpoint when no key resolves (`PWA/exa.ts:502-505`), add a `status` hint showing the last request time per provider, or a CLI `doctor` command that checks `~/.pi/agent/web-search.json` for `exaBaseUrl`, `tavilyBaseUrl`, the key fields, and a conflicting top-level `provider`. Print values only as "set / not set".
13. **Explicit-provider calls bypass routing.** Document that when the model passes `provider: "exa"` or `"tavily"`, an exhausted broker yields a hard error with no fallback (`PWA/gemini-search.ts:838`).
14. **Naming leftovers (resolved in 0.6.0).** The broker's folder (`~/.pi/agent/pi-search-broker`) and the `/health` service name now both use the product name.

### Not needed

- `/v1` path variants.
- GET routes.
- Query-string support.
- SSE.
- Forwarding upstream headers.
- Handling `Retry-After` for pi's sake. pi ignores it; the broker should keep honouring it internally, as it does today in `broker/src/gateway.mjs:28-33` and `:104`.
