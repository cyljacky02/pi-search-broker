# Exa API research for pi-search-broker

Researched 2026-11-09. Sources: the official OpenAPI specs, docs at `exa.ai/docs` (the old `docs.exa.ai` host now serves the same content under `https://exa.ai/docs/...`), the official SDKs (`exa-js` v2.28.0, `exa-py`), the official `exa-mcp-server`, and `exa.ai/pricing`. A few behaviours were checked with **unauthenticated** live probes against `api.exa.ai` (no key, or the literal string `invalid`). They are marked "observed" and are not documented contract.

Code in this repo that was checked against these sources: `src/gateway.mjs` (routes, headers, failover status list) and `src/manager.mjs` (`quote()`, `actualCost()`, `fail()`). The client was also checked: `pi-web-access` 0.47.0, installed at `~/.pi/agent/npm/node_modules/pi-web-access/exa.ts`.

---

## TL;DR

- **Spec location.** `https://exa.ai/docs/exa-spec.yaml` and `https://exa.ai/docs/team-management-spec.yaml` are the declared source of truth ([llms.txt](https://exa.ai/docs/llms.txt)). A near-identical, slightly older copy lives in [exa-labs/openapi-spec](https://github.com/exa-labs/openapi-spec) (`info.version: 2.0.0`, last commit 2026-11-02).
- **Search types changed.** The recommended types are now `lite`, `auto`, and `deep`, plus `deep-lite`. `instant`, `fast`, and `deep-reasoning` are "legacy" but still work at their old prices. `neural` and `keyword` are no longer documented ([changelog 2026-10-19](https://exa.ai/docs/changelog), [search quickstart](https://exa.ai/docs/search/quickstart)).
- **Pricing changed on 2026-03-03.** Text and highlights are **included** in the `/search` base price for the first 10 results. Only results above 10 (+$1/1k) and AI summaries (+$1/1k pages) cost extra. `quote()` still charges $0.001 per result per content type on `/search`. That over-reserves the typical pi-web-access call (auto, 5 results, highlights) at $0.012 against a real $0.007. With text plus highlights it reserves $0.017.
- **`costDollars` changed.** It is now `{ total, search?: {neural?, keyword?}, summary?, contents?: {text?, highlights?, summary?} }`. It is "estimated … not an invoice record" and is **not** a required field in any response schema. The old `breakDown`, `perRequestPrices`, and `perPagePrices` fields are gone. `total` is the only field to rely on.
- **Retired endpoints.** `/research/v1` returns **410** (retired; use the Agent API). `/findSimilar` is deprecated. No `/context` endpoint is documented. "Exa Code" in the official MCP is now just `/search` with `type: "lite"`.
- **Real balance API.** The Team Management API (`https://admin-api.exa.ai/team-management`) has `GET /credits`, which returns `credits_usd` plus `expiring_credits[]`, and `GET /api-keys/{id}/usage`. It needs a per-team **service key** and is enabled per team on request.
- **Error semantics.** Errors use the envelope `{requestId, error, tag}`. **403 is not always an account problem.** `PROHIBITED_CONTENT` and `CONTENT_FILTER_ERROR` are request-specific. Today `fail()` marks the account `disabled = 'auth'` on any 403, so one moderated query can disable the whole pool one account at a time. **This is the most important bug.**
- **Rate limits are per team (= per account)**, across all of its keys: 10 QPS for `/search` and `/answer`, 5 QPS for deep types, 100 QPS for `/contents`. Only `Retry-After` is documented. Requests may also be queued (`x-exa-queued`, `x-exa-queue-ms`) instead of rejected.
- **Free tier.** $10 at signup, reset (not accumulated) to $10 on the 1st of every calendar month. There is also a one-time, **non-expiring** $10 onboarding bonus. "Only a user's first team receives the monthly grant" ([billing](https://exa.ai/docs/admin/billing)). Usage draws the soonest-expiring credits first ([team-management spec](https://exa.ai/docs/team-management-spec.yaml)).

---

## 1. OpenAPI specs: where they live

| Spec | URL | Notes |
|---|---|---|
| Public API (canonical) | `https://exa.ai/docs/exa-spec.yaml` | Declared "source of truth for request and response schemas" ([llms.txt](https://exa.ai/docs/llms.txt), [OpenAPI page](https://exa.ai/docs/admin/openapi-spec)). OpenAPI 3.1.0, `info.title: Exa Public API`, `info.version: 2.0.0`, `servers: https://api.exa.ai`. |
| Public API (GitHub mirror) | `https://github.com/exa-labs/openapi-spec/blob/master/exa-openapi-spec.yaml` (raw: `https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-openapi-spec.yaml`) | About 11.5k lines. Last updated 2026-11-02 (commit `ebdf275`). |
| Websets | `https://github.com/exa-labs/openapi-spec/blob/master/exa-websets-spec.yaml` | Server `https://api.exa.ai/websets`. Also merged into the public spec under `/v0/...`. |
| Team Management (admin) | `https://exa.ai/docs/team-management-spec.yaml` | Server `https://admin-api.exa.ai/team-management`. Authenticated with a service key. |

**Differences between the docs copy and the GitHub copy** (diff of the two files fetched on 2026-11-09):

- The docs copy says `outputSchema` "works with every search type **except `lite`**". The GitHub copy says "every search type".
- The docs copy raises `text.maxCharacters` max to 5,000,000 (default 5,000,000) on `/contents`. GitHub says max 1,000,000.
- The docs copy marks monitor `livecrawl` deprecated and drops `highlightScores` from `FindSimilarResult`.
- The docs copy describes `publishedDate` as full ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`). GitHub still says `YYYY-MM-DD`.
- The docs copy's `costDollars.contents` reads "Cost breakdown for `/contents` requests" and `costDollars.summary` reads "per-result summaries requested with `contents.summary` on `/search` and `/findSimilar`".
- The GitHub copy's `/v0/teams/me` has no `servers` override; the docs copy routes it to `https://api.exa.ai/websets`. Observed: `GET https://api.exa.ai/websets/v0/teams/me` returns 401 without a key (route exists), and `GET https://api.exa.ai/v0/teams/me` returns 404.

**Spec summary.** Paths in the public spec:

| Area | Paths |
|---|---|
| Core | `POST /search`, `POST /contents`, `POST /answer`, `POST /findSimilar` (deprecated) |
| Monitors | `POST/GET /monitors`, `POST /monitors/batch`, `GET/PATCH/DELETE /monitors/{id}`, `POST /monitors/{id}/trigger`, `GET /monitors/{id}/runs`, `GET /monitors/{id}/runs/{runId}` |
| Agent | `POST/GET /agent/runs`, `GET/DELETE /agent/runs/{id}`, `POST /agent/runs/{id}/cancel`, `POST /agent/runs/{id}/stop`, `GET /agent/runs/{id}/events` |
| Batches (beta) | `POST/GET /batches`, `GET/DELETE /batches/{id}`, `POST /batches/{id}/cancel` (requires `Exa-Beta: batches-2026-06-06`) |
| Team info | `GET /v0/teams/me` (concurrency only, no credits) |
| Websets | `/v0/websets…`, `/v0/monitors…`, `/v0/imports…`, `/v0/webhooks…`, `/v0/events…` (server `https://api.exa.ai/websets`) |

`/search` and `/contents` carry `x-payment-info` (x402/MPP pay-per-call without a key): search `min "0.007"`, `max "0.015"`; contents `min "0.001"`, `max "0.010"` ([spec](https://github.com/exa-labs/openapi-spec/blob/master/exa-openapi-spec.yaml)).

---

## 2. Endpoints

### 2.1 `POST /search`

Request schema `SearchRequest` ([spec](https://exa.ai/docs/exa-spec.yaml), [reference](https://exa.ai/docs/reference/search)). Only `query` is required. Nearly every field also accepts `null`, which counts as unset.

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string, minLength 1 | required | |
| `type` | string (open enum, `x-exa-enum-open`) | `auto` | See the type table below. "Other values" are schema-valid. |
| `numResults` | int 1–100 | 10 | "The maximum public limit is 100." See §10 for contradictions. |
| `category` | string (open) | — | Enum `company`, `publication`, `news`, `personal site`, `financial report`, `people`. "Other strings are accepted and used as category hints." `company`/`people` reject published-date filters; `people` also rejects `excludeDomains` (400). |
| `includeDomains` / `excludeDomains` | string[] ≤ 1200 | — | Hostname, hostname+path prefix, or `*.sub` wildcard. |
| `startPublishedDate` / `endPublishedDate` | ISO 8601 date-time | — | |
| `userLocation` | string (ISO 3166-1 alpha-2) or `{country}` or `{latitude, longitude, country?}` | — | |
| `moderation` | boolean | false | Filter unsafe content. |
| `contents` | `ContentsOptions` | — | Text, highlights, summary, extras, freshness. See §2.2. |
| `additionalQueries` | string[] 1–10 | — | Deep types only. |
| `outputSchema` | `{type: "text", description?}` or `{type: "object", properties, required, …}` | — | Max 10 properties and 2 nesting levels. Adds about 2 s. Not with `lite` (docs copy). |
| `systemPrompt` | string | — | Guides synthesized output. |
| `stream` | boolean | false | SSE **only when `outputSchema` is set**. Otherwise plain JSON. |
| `objective` | string ≤ 4096 | — | The broader goal of the agent's task. Recommended for agent tools. |
| `userIdentifier` | string 1–64 `[A-Za-z0-9_-]` | — | End-user attribution. Telemetry only. |
| `compliance` | `"hipaa"` | — | Enterprise only. |
| `startCrawlDate` / `endCrawlDate` | date-time | — | **Deprecated, ignored.** Produces an `IGNORED_FIELD` warning. |
| `includeText` / `excludeText` | string[] ≤ 50 | — | **Deprecated.** |
| `context` | bool or `{maxCharacters}` | — | **Deprecated**; use highlights or text. |

**`type` values** ([spec](https://exa.ai/docs/exa-spec.yaml), [search quickstart](https://exa.ai/docs/search/quickstart), [pricing](https://exa.ai/docs/admin/pricing)):

| Value | Status | Latency | Price / 1k (≤10 results) | Notes |
|---|---|---|---|---|
| `auto` | recommended, default | ~1 s | $7 | Accepts every parameter. |
| `lite` | recommended (new 2026-10-19) | ~450 ms | $4 | **Cache only.** Accepts only `query`, `objective`, `userIdentifier`, `metadata`, `category`, `numResults`, `contents.highlights`, `contents.text`, `contents.snapshotAsOf`, `userLocation`, include/exclude domains, published dates, `moderation`, `compliance`. Anything else, including `maxAgeHours: -1`, `livecrawl`, `summary`, `outputSchema`, or `stream`, returns `400 INVALID_REQUEST_BODY`. Results with no cached copy are dropped when text or highlights are requested. |
| `deep-lite` | current | ~4 s | $12 | Lightweight synthesis. |
| `deep` | recommended | 4–15 s | $12 | Multi-step research and synthesis. |
| `instant` | legacy → `lite` | — | $4 | Accepts every parameter. |
| `fast` | legacy → `lite` (or `auto`) | — | $7 | "`lite` … runs the same search as `fast`." |
| `deep-reasoning` | legacy → `deep` or Agent | 12–40 s | $15 | |
| `neural`, `keyword` | **undocumented** | — | — | Dropped from the enum. A PR "deprecate neural search type" exists ([PRs](https://github.com/exa-labs/openapi-spec/pulls)). `costDollars.search` still has `neural`/`keyword` keys, and the live x402 challenge metadata still lists "auto, keyword, neural, deep-lite, deep, deep-reasoning" (observed). Treat as accepted-but-unsupported. |

**Response** `SearchResponse = SearchResultsResponse | SearchSynthesisResponse`. Both are `additionalProperties: false` ([spec](https://exa.ai/docs/exa-spec.yaml)).

| Field | Type | Notes |
|---|---|---|
| `requestId` | string | Also sent as the `x-request-id` header. |
| `results[]` | `SearchResultOutput` | `title`, `url` (required), `publishedDate`, `author`, `id`, `image`, `favicon`, `text`, `highlights[]`, `summary`, `subpages[]`, `entities[]` (company/person/publication), `extras{links, imageLinks, richImageLinks, richLinks, codeBlocks}`. |
| `costDollars` | `CostDollarsOutput` | Optional in the schema. See §4.3. |
| `searchTime` | number (ms) | |
| `warnings[]` | `{code, path, message}` | e.g. `IGNORED_FIELD`. "Log them; do not pass them to a model." Omitted when empty. |
| `notices[]` | `{code, path, message, details?}` | e.g. `RESTRICTIONS_RELAXED`. Meant for the model. Omitted when empty. |
| `output` | `{content: string\|object, grounding[{field, citations[{url,title}], confidence}]}` | Required only in the synthesis variant (`outputSchema`). |
| `resolvedSearchType` | string | **Deprecated.** "May be an empty string. Do not branch on this value." The changelog said it would be removed on 2026-05-01, but it is still emitted as `""` in the doc example ([quickstart](https://exa.ai/docs/search/quickstart)). |
| `context` | string | Deprecated. |

`searchType` is **not** in the current response schema. It existed only in the old (April 2026) spec's `/research` objects. The `highlightScores` and `score` fields have been removed ([changelog 2026-04-01](https://exa.ai/docs/changelog)).

**Streaming** (`stream: true` with `outputSchema`): `text/event-stream`. Each event is `data: <json>` with `type` ∈ `text-delta`, `grounding`, `results`, `stream-reset`, `done`, `error`, and the stream ends with `data: [DONE]`. `costDollars` arrives on the `done` chunk; warnings and notices arrive on the `results` chunk ([spec `SearchStreamChunk`](https://exa.ai/docs/exa-spec.yaml), [best practices](https://exa.ai/docs/search/best-practices)).

### 2.2 `ContentsOptions` (under `/search` `contents`, and top-level on `/contents`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `text` | bool or `{maxCharacters (1–1e6; 5e6 on /contents per docs copy), includeHtmlTags (false), verbosity: compact\|standard\|full (compact), includeSections[], excludeSections[]}` | false | Section enum: `header`, `navigation`, `banner`, `body`, `sidebar`, `footer`, `metadata`. |
| `highlights` | bool or `{query, maxCharacters, verbosity: low\|medium\|high (beta), dynamic (beta), numSentences (deprecated), highlightsPerUrl (deprecated, ignored)}` | false | `verbosity` and `dynamic` require `Exa-Beta: dynamic-highlights-2026-08-28`, otherwise 400. |
| `summary` | `{query?, schema?}` | — | One extra LLM call per page, billed. |
| `extras` | `{links, imageLinks, richImageLinks (0–1000), richLinks, codeBlocks}` | 0 | `richLinks` and `codeBlocks` are deprecated on `/search`. |
| `maxAgeHours` | int −1…720 | omitted = cache if present, else live | `0` = always fresh, `-1` = cache only. |
| `livecrawlTimeout` | int ms, 1–90000 | 10000 | |
| `snapshotAsOf` | ISO date or date-time | — | Historical version. Not on the Free tier ([billing](https://exa.ai/docs/admin/billing)). |
| `livecrawl` | `never\|always\|fallback\|preferred` | — | **Deprecated** → `maxAgeHours`. Cannot be combined with it. |
| `crawledBeforeDate` | date-time | — | **Deprecated** alias of `snapshotAsOf`. |
| `subpages` / `subpageTarget` | int 0–100 / string or string[] | 0 | **Deprecated on `/search`** (use `/contents`). Still supported on `/contents`. |
| `context` | bool or `{maxCharacters}` | — | **Deprecated.** |

### 2.3 `POST /contents`

Request `ContentsRequest`: exactly one of `ids` or `urls` (string[] 1–100, each ≤ 2048 chars), plus top-level `text`, `highlights`, `summary`, `extras`, `livecrawlTimeout`, `maxAgeHours`, `snapshotAsOf`, `subpages`, `subpageTarget`, `compliance`, `userIdentifier`, and the deprecated `context`, `livecrawl`, `crawledBeforeDate` ([spec](https://exa.ai/docs/exa-spec.yaml)). The behaviour when no content type is given is **undocumented**.

Response `ContentsResponse`: `requestId`, `results[]` (`SearchResultOutput`), `statuses[]`, `costDollars`, `searchTime`, `context` (deprecated).

`statuses[]` items are `{id, status: "success"|"error", source?: "cached"|"crawled", error?: {tag, httpStatusCode|null}}`. Per-URL failures are reported **inside a 200**; the `httpStatusCode` "describes the target page, not the /contents response" ([error codes](https://exa.ai/docs/admin/error-codes)).

| `statuses[].error.tag` | Meaning / handling ([error codes](https://exa.ai/docs/admin/error-codes)) |
|---|---|
| `CRAWL_NOT_FOUND` | Target not found. |
| `CRAWL_HTTP_{status}` (e.g. `CRAWL_HTTP_403`) | Target returned that HTTP error. |
| `CRAWL_TIMEOUT` | Crawl timed out; retry later. |
| `CRAWL_LIVECRAWL_TIMEOUT` | Exceeded `livecrawlTimeout`; raise it or adjust `maxAgeHours`. |
| `SOURCE_NOT_AVAILABLE` | Forbidden or unavailable source. |
| `UNSUPPORTED_URL` | Non-HTTP(S) scheme. |
| `CRAWL_UNKNOWN_ERROR` | Other; retry. |

The docs do not say whether failed URLs are billed. Rely on `costDollars.total`.

### 2.4 `POST /answer`

Request `AnswerRequest` ([spec](https://exa.ai/docs/exa-spec.yaml), [reference](https://exa.ai/docs/reference/answer)):

| Field | Type | Default |
|---|---|---|
| `query` | string | required |
| `stream` | bool | false (true gives SSE) |
| `text` | bool | false (include source text in citations) |
| `model` | `exa` \| `exa-pro` \| `exa-research` \| `exa-fast` | `exa` |
| `systemPrompt` | string | — |
| `userLocation` | as on `/search` | — |
| `outputSchema` | JSON Schema draft-7 object | — (answer becomes an object) |
| `userIdentifier` | string | — |

Response: `requestId`, `answer` (string or object, required), `citations[]` (`title`, `url`, `publishedDate`, `author`, `id`, `image`, `favicon`, `text`), `costDollars`. The SSE stream emits OpenAI-style `{choices[{index, delta{role, content}, finish_reason}]}`, then `{citations}`, `{costDollars, requestId}`, or error `{tag: "ERROR", payload{error{code, message}, requestId}}` ([spec `AnswerStreamChunk`](https://exa.ai/docs/exa-spec.yaml)). Price: $5 / 1k requests, flat ([pricing](https://exa.ai/docs/admin/pricing)). Default rate limit is 10 QPS.

### 2.5 `POST /findSimilar` (deprecated)

Marked `deprecated: true` with `x-exa-lifecycle: deprecated` and returns a `Deprecation` response header. "Prefer `/search` with a query describing the source." Request fields: `url` (required, minLength 3), `numResults`, `includeDomains`/`excludeDomains`, published dates, `category`, `excludeSourceDomain`, `contents`, plus the deprecated `startCrawlDate`/`endCrawlDate`/`includeText`/`excludeText` ([spec](https://exa.ai/docs/exa-spec.yaml)). Response: `requestId`, `results[]`, `costDollars`, `searchTime`, `context`. It is not listed on the pricing page.

### 2.6 `/research` (retired)

- 2026-04-01: "`/research` endpoint: replaced by `/search` with `type: "deep-reasoning"`" ([changelog](https://exa.ai/docs/changelog)).
- The current spec has no `/research` paths. The April 2026 spec had `/research/v0/tasks` and `/research/v0/tasks/{id}` ([old spec, commit 57d9178](https://github.com/exa-labs/openapi-spec/blob/57d917823aa0cec02385104dc3bb795cdf5d7da8/exa-openapi-spec.yaml)).
- exa-js now throws locally: "The Exa Research API has been retired … Use the Agent API (exa.agent.runs.create)", with `statusCode` 410, "the status the API answers Research paths with" ([exa-js research/base.ts](https://github.com/exa-labs/exa-js/blob/master/src/research/base.ts)).
- Observed: `GET/POST https://api.exa.ai/research/v1` returns **410** with "The Exa Research API has been retired and is no longer available."
- **Replacement:** the Agent API (`POST /agent/runs`, async with poll/SSE). Effort `minimal|low|medium|high|xhigh` costs $0.012/$0.025/$0.10/$0.50/$1.00 per run. `auto` and `ultra` are metered at $0.10/ACU + $0.005/search + $0.02/email + $0.07/phone, capped at $5 and $20 by default ([pricing](https://exa.ai/docs/admin/pricing)). The response carries its own `costDollars` shape `{total, agentCompute, search, emails, phoneNumbers, dataSources?}` and `usage`. Errors use a different envelope: `{error: {type, code, message}}`, e.g. `CONCURRENCY_LIMIT_REACHED` on 429 ([spec `AgentErrorResponse`](https://exa.ai/docs/exa-spec.yaml)).

### 2.7 `/context` (Exa Code)

**Not documented anywhere current**: not in the spec, not in [llms.txt](https://exa.ai/docs/llms.txt), not in the changelog. The official MCP tool `get_code_context_exa` now calls `POST /search` with `type: "lite"`, `contents.highlights.query`, and `text.maxCharacters: 300` ([exa-mcp-server exaCode.ts](https://github.com/exa-labs/exa-mcp-server/blob/main/src/tools/exaCode.ts)). Observed: `POST https://api.exa.ai/context` without a key returns 401 "Authentication required", while an unknown path returns 404 `NOT_FOUND`. The route still exists behind auth, but its contract and price are undocumented. Do not depend on it.

### 2.8 Websets, Monitors, Batches, Team info

- Websets have a separate spec and server (`https://api.exa.ai/websets/v0/...`), a credit and plan system ([Websets](https://exa.ai/docs/websets/quickstart)), and a 20 QPS limit ([billing](https://exa.ai/docs/admin/billing)). Not relevant to a search proxy.
- Monitors cost $2 / 1k runs, with a minimum interval of 1 hour ([changelog 2026-03-30](https://exa.ai/docs/changelog)).
- Batches are beta, POST only, and target `/search` or `/agent/runs`, with `stream: true` disallowed ([spec `BatchRequestItem`](https://exa.ai/docs/exa-spec.yaml)).
- `GET /v0/teams/me` (Websets server) returns `{object: "team", id, name, concurrency{active, queued}, limits{maxConcurrent, maxQueued}}`. It has **no credit or balance data** ([spec `WebsetsTeamInfo`](https://exa.ai/docs/exa-spec.yaml)).

---

## 3. Authentication and headers

| Header | Status | Source |
|---|---|---|
| `x-api-key: <key>` | Documented (`securitySchemes.apiKey`) | [spec](https://exa.ai/docs/exa-spec.yaml) |
| `Authorization: Bearer <key>` | Documented and equivalent (`securitySchemes.bearer`); the docs now show Bearer first | [spec](https://exa.ai/docs/exa-spec.yaml), [llms.txt](https://exa.ai/docs/llms.txt) |
| `Exa-Beta: <token,…>` | Documented opt-in for beta features: `dynamic-highlights-2026-08-28`, `batches-2026-06-06`. Missing token → 400 `INVALID_REQUEST`. | [spec](https://exa.ai/docs/exa-spec.yaml), [error codes](https://exa.ai/docs/admin/error-codes) |
| `Accept: text/event-stream` | Documented for `/agent/runs` and their events | [spec](https://exa.ai/docs/exa-spec.yaml) |
| `x-exa-integration` | **Not in the public spec or docs.** The official MCP server sends it for attribution (`"x-exa-integration": tool` or `tool:source`) along with `x-exa-mcp-session-id` and `x-exa-mcp-client`. | [exa-mcp-server config.ts](https://github.com/exa-labs/exa-mcp-server/blob/main/src/tools/config.ts) |
| `User-Agent` | The SDKs send `exa-node <version>` and `exa-py/<version>`. No other tracking header. Neither SDK sends `x-exa-integration`. | [exa-js index.ts](https://github.com/exa-labs/exa-js/blob/master/src/index.ts), [exa-py api.py](https://github.com/exa-labs/exa-py/blob/master/exa_py/api.py) |

Response headers in the spec: `x-request-id`, `x-exa-queued` (`"true"`/`"false"`, "waited in the customer rate-limit queue"), `x-exa-queue-ms`, and `Deprecation` (on `/findSimilar`). Observed `access-control-expose-headers` also lists `x-exa-region`, `x-exa-processing-region`, `Sunset`, `Retry-After`, `X-RateLimit-Scope`, and the x402/MPP payment headers. **`X-RateLimit-Scope` is undocumented.**

Keyless calls: `/search` and `/contents` without a key return **402 `X402_PAYMENT_REQUIRED`** with an x402 challenge (observed; [spec 402 description](https://exa.ai/docs/exa-spec.yaml)). An invalid key returns 401 `INVALID_API_KEY` with the message "Provide a valid key using 'Authorization: Bearer <key>' or 'x-api-key: <key>'" (observed).

---

## 4. Pricing

### 4.1 Current rate card ([pricing](https://exa.ai/docs/admin/pricing), matches [exa.ai/pricing](https://exa.ai/pricing))

"Each endpoint has a base price per request that includes up to 10 results. Additional results and Exa-generated page summaries are billed on top."

| Endpoint / type | Base (≤10 results) | Each result >10 | AI page summary |
|---|---|---|---|
| `/search` `lite` | $4 / 1k req | $1 / 1k results | — (not allowed) |
| `/search` `instant` (legacy) | $4 / 1k | $1 / 1k | $1 / 1k pages |
| `/search` `auto`, `fast` (legacy) | $7 / 1k | $1 / 1k | $1 / 1k pages |
| `/search` `deep-lite`, `deep` | $12 / 1k | $1 / 1k | $1 / 1k pages |
| `/search` `deep-reasoning` (legacy) | $15 / 1k | $1 / 1k | $1 / 1k pages |
| `/answer` | $5 / 1k | — | — |
| `/monitors` | $2 / 1k | $1 / 1k | $1 / 1k pages |
| `/contents` | $1 / 1k pages **per content type** (text, highlights, summary each count) | — | $1 / 1k pages |

- **Text and highlights on `/search` are included** in the base price: "Search with contents: $7 per 1k requests (10 results, text + highlights included)" ([changelog 2026-03-03](https://exa.ai/docs/changelog)). The content-options table also says `highlights` and `text` are "Included" on Search while `summary` is $1/1k pages ([Exa skill](https://exa.ai/docs/skill)).
- The old 1–25 / 26–100 result tiers (e.g. `neuralSearch_1_25_results` $0.005, `neuralSearch_26_100_results` $0.025, `deepSearch_1_25_results` $0.015) **no longer exist**. They appear only in the April 2026 spec ([old spec](https://github.com/exa-labs/openapi-spec/blob/57d917823aa0cec02385104dc3bb795cdf5d7da8/exa-openapi-spec.yaml)).
- **Ambiguity:** the [contents quickstart](https://exa.ai/docs/contents/quickstart) says contents on Search are free "up to 10 results per search ($1/1000 pages afterwards)". The pricing page lists only "$1 / 1k results" above 10. It is unclear whether a result above 10 that has both text and highlights costs $0.001 or $0.001 per type.
- The docs give no separate price for `outputSchema` synthesis on `auto`. It is undocumented whether it adds cost.
- 503 `SERVICE_OVERLOADED`: "The request was not processed and is not billed" ([error codes](https://exa.ai/docs/admin/error-codes)).

### 4.2 Credits, the free tier, and promotional credits

- **Free tier:** "$10 in credits, available in full the day you sign up … resets to $10 on the first day of every calendar month. The grant does not accumulate … Only a user's first team receives the monthly grant" ([billing](https://exa.ai/docs/admin/billing)). The timezone of the reset is undocumented.
- **Onboarding bonus:** "A user's first team also earns a one-time $10 bonus when that user completes onboarding … The bonus does not expire" ([billing](https://exa.ai/docs/admin/billing)).
- **Other promotions:** startup and education grants of "up to $1000 worth of free credits" ([exa.ai/pricing](https://exa.ai/pricing)). The terms and expiry of such grants are not documented. The `/credits` API exposes them as `expiring_credits[{amount_usd, expires_at}]`, and "Usage draws from the soonest-expiring credits first" ([team-management spec](https://exa.ai/docs/team-management-spec.yaml)).
- It is **undocumented** how the monthly free grant interacts with expiring promo credits: whether the grant appears in `expiring_credits`, and which bucket is drawn first.
- Out of credits returns `402 NO_MORE_CREDITS`. A key past its own budget returns `402 API_KEY_BUDGET_EXCEEDED` ([billing](https://exa.ai/docs/admin/billing), [error codes](https://exa.ai/docs/admin/error-codes)).
- Free tier: 10 QPS, no Exa Snapshot. Pay-as-you-go: 10 QPS, automatically raised to 25 QPS for 90 days after $1,000 of purchases within 30 days ([billing](https://exa.ai/docs/admin/billing)).

### 4.3 `costDollars` schema

Current `CostDollarsOutput` ([spec](https://exa.ai/docs/exa-spec.yaml)), `additionalProperties: false`, described as "Estimated dollar cost of the request. Which fields appear depends on the endpoint.":

| Field | Type | Description |
|---|---|---|
| `total` | number | "Estimated total dollar cost for the completed request. This response value is not an invoice record." |
| `search` | `{neural?: number, keyword?: number}` | "Estimated search cost by retrieval mode. **Some search types report their cost only in `total`.**" |
| `summary` | number | Per-result summaries requested via `contents.summary` on `/search` and `/findSimilar`. |
| `contents` | `{text?, highlights?, summary?}` | Breakdown for `/contents`. |

Examples: auto search gives `{"total": 0.007, "search": {"neural": 0.007}}` ([search quickstart](https://exa.ai/docs/search/quickstart)), and a single-page `/contents` call gives `{"total": 0.001}` ([contents quickstart](https://exa.ai/docs/contents/quickstart)).

**Presence:** `costDollars` is listed under `properties` but is in **no** response's `required` list: not `SearchResultsResponse`, `SearchSynthesisResponse`, `ContentsResponse`, `AnswerResponse`, or `FindSimilarResponse`. On streams it is on the `done` chunk (search) or a dedicated cost chunk (answer). The Agent API uses a different `AgentCostDollars` shape (required). **It is therefore not guaranteed on every response**, and a fallback estimate is still needed.

**Removed shape** (April 2026 spec): `total`, `breakDown[{search, contents, breakdown{neuralSearch, deepSearch, contentText, contentHighlight, contentSummary}}]`, `perRequestPrices{neuralSearch_1_25_results, …}`, `perPagePrices{contentText, contentHighlight, contentSummary}` ([old spec](https://github.com/exa-labs/openapi-spec/blob/57d917823aa0cec02385104dc3bb795cdf5d7da8/exa-openapi-spec.yaml)). The task brief's "perPageContentsPrices" matches `perPagePrices` in that version. None of these exist now.

---

## 5. Account, usage, and balance APIs

The **Team Management API** has base `https://admin-api.exa.ai/team-management`, authenticated with `x-api-key: <service key>`. "The API is enabled per team. Contact support@exa.ai to request access." Service keys are created from the **Service keys** tab once the feature is enabled ([team-management spec](https://exa.ai/docs/team-management-spec.yaml), [Get team credits](https://exa.ai/docs/reference/team-management/get-team-credits)).

| Method & path | Purpose | Key response fields |
|---|---|---|
| `GET /credits` | Remaining prepaid balance | `credits_usd` ("including granted credits … Requests are refused once it reaches 0 unless overage is enabled"), `expiring_credits[{amount_usd, expires_at}]` (soonest first), `metadata.generated_at`. **Can lag usage by up to 5 minutes.** Errors: 401, 404 (no billing account), 429 with `Retry-After`, 500. |
| `GET /api-keys/{id}/usage?start_date&end_date` | Cost per key over a window (default 30 days, ≤ 180 days back; `group_by` has no effect) | `id` (publicId), `api_key_name`, `team_id`, `period{start, end}`, `total_cost_usd`, `cost_breakdown[{price_id, price_name, quantity, amount_usd}]` |
| `POST /api-keys` | Create a key | Body `{name?, rateLimit? (QPS), budgetCents? (per billing period)}` → `apiKey{publicId, secret, rateLimit, budgetCents, isOverBudget, …}` |
| `GET /api-keys`, `GET/PUT/DELETE /api-keys/{id}` | List, get, update (name, rateLimit, budget), delete | |
| `POST /api-keys/{id}/rotate`, `POST /api-keys/{id}/revoke-previous` | Rotate the secret with a grace period | |

There is no balance endpoint on `api.exa.ai` itself. `GET /v0/teams/me` only reports concurrency. Without a service key, the only per-request signal is `costDollars.total`.

---

## 6. Rate limits

"Rate limits are measured in queries per second (QPS) and apply to your team as a whole, across all of its API keys. You can give an individual key a lower limit … but its traffic still counts toward the team limit" ([billing](https://exa.ai/docs/admin/billing)).

| Endpoint | Default limit |
|---|---|
| `/search`, `/answer`, `/chat/completions` | 10 QPS |
| `/search` with `deep-lite`, `deep`, `deep-reasoning` | 5 QPS |
| `/contents` | 100 QPS |
| `/agent/runs`, `/responses` | 5 QPS and 50 active runs (a run start counts as 2 requests; polling GETs are free) |
| `/websets/*` | 20 QPS |

- Plans: Free 10 QPS; pay-as-you-go 10 QPS, or 25 QPS for 90 days after $1k purchased in 30 days; Enterprise custom (the $12k/yr plan gives 25 QPS).
- "Some endpoints share rate limit capacity. Limits are subject to change."
- On 429: "Wait for the `Retry-After` header when present, or retry with exponential backoff" ([billing](https://exa.ai/docs/admin/billing)).
- 429 scope: "Your API key, team, or network exceeded a rate or concurrency limit" ([error codes](https://exa.ai/docs/admin/error-codes)). A **network**-scoped 429 would affect every account behind the same IP.
- No `X-RateLimit-Limit`, `X-RateLimit-Remaining`, or similar headers are documented. Only `X-RateLimit-Scope` shows up in CORS exposure (observed, undocumented).
- The spec's `x-exa-queued` and `x-exa-queue-ms` headers show that Exa may **queue** requests in a "customer rate-limit queue" rather than reject them, which adds latency.
- Exa MCP keyless free tier: 3 QPS, 150 calls/day ([changelog 2026-02-02](https://exa.ai/docs/changelog)).

---

## 7. Error semantics

Envelope ([spec `ErrorResponse`](https://exa.ai/docs/exa-spec.yaml), [error codes](https://exa.ai/docs/admin/error-codes)):

```json
{ "requestId": "67207943fab9832d162b5317f4cca830", "error": "Invalid request body | Validation error: Invalid value for type", "tag": "INVALID_REQUEST_BODY" }
```

"The set of tags is open-ended … Branch on the HTTP status code first and treat unrecognized tags as additional detail." The Agent endpoints use `{error: {type, code, message}}` instead. The Team Management API uses `{error: "<string>"}`.

| HTTP | Tags | Meaning | Rotate key? (broker view) |
|---|---|---|---|
| 400 | `INVALID_REQUEST_BODY`, `INVALID_REQUEST` (also a missing `Exa-Beta`), `INVALID_NUM_RESULTS`, `NUM_RESULTS_EXCEEDED`, `INVALID_JSON_SCHEMA`, `SUBPAGES_LIMIT_EXCEEDED` | Bad request | **No.** `NUM_RESULTS_EXCEEDED` ("exceeds your plan's limit") is plan-dependent; rare. |
| 401 | `INVALID_API_KEY` | Missing or invalid key | **Yes**, and disable the account. |
| 402 | `NO_MORE_CREDITS`, `TEAM_BUDGET_EXCEEDED`, `API_KEY_BUDGET_EXCEEDED`; keyless: `X402_PAYMENT_REQUIRED` | Credits exhausted or budget hit | **Yes**, and mark quota-blocked. |
| 403 | `TEAM_BLOCKED` | Team access revoked | **Yes**, and disable. |
| 403 | `FEATURE_DISABLED` | Option or type not on this plan (e.g. Snapshot on Free) | Maybe (another plan might allow it). Do **not** disable the account. |
| 403 | `PROHIBITED_CONTENT`, `CONTENT_FILTER_ERROR` | Content-safety rejection of *this request* ([content policy](https://exa.ai/docs/reference/content-policy)) | **No.** Return to the client. Never disable. |
| 404 | `NOT_FOUND` | Route or resource missing | No |
| 409 | — | Conflict (Websets, batches) | No |
| 410 | (observed) | Retired route (`/research/v1`) | No |
| 422 | — | Websets preview only | No |
| 429 | `RATE_LIMIT_EXCEEDED`; Agent `CONCURRENCY_LIMIT_REACHED`; x402 `X402_TOO_MANY_UNPAID`, `X402_WALLET_RATE_LIMITED` | Rate or concurrency limit | **Yes**: limits are per team, so another account helps, unless the scope is network. |
| 500 | `X402_INTERNAL_ERROR`, generic | Unexpected | Retry after a brief delay (same or other key). |
| 503 | `SERVICE_OVERLOADED` | Exa over capacity. Not processed, **not billed**. "Independent of your request rate … retrying does [help]." | Retry with backoff. Rotating gives nothing, but it is harmless. Do not penalise the account. |
| 504 | — | Processing deadline exceeded | Retry or reduce scope (e.g. `livecrawlTimeout`, `numResults`, type). |

The spec lists only 400/401/402/403/429/500/503 on the core endpoints. 404, 409, 422, and 504 come from the error-codes page. **501 and 502 are not documented anywhere**; a 502 would most likely come from Cloudflare (the observed `Server: cloudflare`). **432 is not an Exa code**; it is Tavily's.

Per-URL `/contents` failures arrive in `statuses` inside a 200 (§2.3) and are not key problems.

---

## 8. Best practices for agent and LLM use

From the [best practices](https://exa.ai/docs/search/best-practices), [search quickstart](https://exa.ai/docs/search/quickstart), and [contents quickstart](https://exa.ai/docs/contents/quickstart) pages:

- **Baseline:** a natural-language `query` + `contents: { highlights: true }`. "Exa sizes each result's excerpts to its relevance, so there is no character budget to tune." Set `highlights.maxCharacters` only when a fixed per-page limit is required.
- **Highlights vs. text:** use highlights for token-efficient evidence, and fetch full text (Search, then Contents) only for a few useful pages. "Full text for every result" is listed as the thing to avoid. Requesting `highlights`, `text`, and `summary` together "returns and bills each view separately". On `/search`, text and highlights are free within 10 results but still inflate context.
- **Search type:** start with `auto`. Use `lite` when cost or latency matters and cached content is acceptable. Use `deep` for multi-step synthesis or `outputSchema` with 3+ fields. Use the Agent API for long-running research. "Change the search mode last … A different mode cannot repair an underspecified query."
- **numResults:** default 10, max 100, no pagination. Results above 10 cost extra.
- **objective:** pass the agent's task goal. The recommended tool description, verbatim, is "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them."
- **Freshness:** "Most requests should omit [`maxAgeHours`]." Use it only when stale content would be unusable (prices, availability), paired with `livecrawlTimeout` (default 10000 ms; 12000–15000 for slow sites). Use published-date filters for "newer publications", not `maxAgeHours`.
- **Domain filters:** use `includeDomains` and `excludeDomains` instead of `site:` in the query, and only for hard constraints.
- **Warnings and notices:** log `warnings` and never pass them to the model. Pass `notices` to the model.
- **`userIdentifier`:** an opaque per-end-user id for abuse attribution. Never PII.
- **Deprecated or removed parameters** ("Common mistakes" table):

| Instead of | Use |
|---|---|
| `useAutoprompt` | Remove it (removed from all responses since the Oct 2025 SDK release) |
| `includeUrls`/`excludeUrls` | `includeDomains`/`excludeDomains` |
| Top-level `text`/`highlights`/`summary` on `/search` | Nest them under `contents` (top-level gets an `IGNORED_FIELD` warning) |
| `numSentences`, `highlightsPerUrl` | `highlights: true` (+ `maxCharacters`) |
| `tokensNum` | `contents.text.maxCharacters` |
| `livecrawl: "always"` | `maxAgeHours: 0`. Mapping: `never`→`-1`, `fallback`→omit, `preferred`→a low value such as `1`. Never send both. |
| `crawledBeforeDate` | `snapshotAsOf` |
| `contents.context` | highlights or text |
| `includeText`/`excludeText` | Put the terms in the query |
| `startCrawlDate`/`endCrawlDate` | Published-date filters (crawl dates are ignored) |
| Categories `research paper`, `linkedin`, `pdf`, `github`, `tweet` | `publication`, `people`; the rest are deprecated ([changelog](https://exa.ai/docs/changelog)). Unknown strings are still accepted as hints ([spec](https://exa.ai/docs/exa-spec.yaml)). |

- **SDK timeouts and retries:**
  - **exa-js** has no default timeout ("Unset by default, in which case the SDK imposes no timeout of its own") and **no retries** ([exa-js index.ts](https://github.com/exa-labs/exa-js/blob/master/src/index.ts)).
  - **exa-py** defaults to `DEFAULT_REQUEST_TIMEOUT = 600.0` s, also with no retry logic. If `contents` is omitted on `search`, it adds `text: {max_characters: 10000}` by default ([exa-py api.py](https://github.com/exa-labs/exa-py/blob/master/exa_py/api.py)).
  - The **official MCP server** retries only `{500, 502, 503, 504}`, twice, with backoff of 1 s then 2 s. Its tool timeouts are 60 s for search and fetch and 300 s for advanced search ([exa-mcp-server errorHandler.ts](https://github.com/exa-labs/exa-mcp-server/blob/main/src/utils/errorHandler.ts), [config.ts](https://github.com/exa-labs/exa-mcp-server/blob/main/src/tools/config.ts)).

---

## 9. Recent changes and deprecations ([changelog](https://exa.ai/docs/changelog))

| Date | Change |
|---|---|
| 2026-10-19 | New `lite` type ($4/1k, cache only, strict parameter set → 400). `fast`/`instant`/`deep-reasoning` become legacy. `warnings[]` and `notices[]` added to `/search`. SDK 2.26.0 logs warnings. |
| 2026-09-24 | Agent `ultra` effort, `budget.maxDurationSeconds`, `POST /agent/runs/{id}/stop`. |
| 2026-08-28 | Dynamic Highlights (beta; `Exa-Beta: dynamic-highlights-2026-08-28`). |
| 2026-07-23 | `publication` category replaces `research paper`. `pdf`/`github`/`tweet` categories deprecated. `startCrawlDate`/`endCrawlDate` ignored for all teams. |
| 2026-06-16 / 06-24 / 07-01 | Exa Agent API, Exa Connect data sources, Agent in MCP. |
| 2026-04-01 | `/research` retired (now 410). `resolvedSearchType` and `highlightScores` → null from 04-15, "removed May 1" (the spec still lists `resolvedSearchType` as deprecated and possibly empty). |
| 2026-03-30 | Monitors API. |
| 2026-03-04 | Deep revamp: `outputSchema` with `output.content`/`output.grounding`, `deep` 20% cheaper, new `deep-reasoning`. |
| 2026-03-03 | **Pricing simplification:** text and highlights included for the first 10 results. Summaries $1/1k. Deep $12/1k, deep-reasoning $15/1k. Contents $1/1k pages per type. |
| 2026-02-05 | `instant` type. |
| 2026-02-02 | `highlights.maxCharacters` preferred (`numSentences`/`highlightsPerUrl` deprecated). `maxAgeHours` replaces `livecrawl`. Keyless MCP free tier. |
| 2025-12-19 | `people` category replaces `linkedin`. |
| 2025-10-28 | `use_autoprompt` deprecated and removed from responses. |
| 2025-05-22 | `/contents` per-URL `statuses` instead of HTTP errors. |

Lifecycle markers in the spec: `x-exa-lifecycle: deprecated | legacy | beta`, `x-exa-replacement`, and the `Deprecation`/`Sunset` response headers (observed in CORS exposure).

---

## 10. Contradictions and undocumented points

1. **Result limits.** The spec says `numResults` max 100 ("maximum public limit"). The pricing page lists "requests above 25 results" and "up to 1,000 results" as Enterprise features. The error table has `NUM_RESULTS_EXCEEDED` ("exceeds your plan's limit") and `INVALID_NUM_RESULTS` ("must be ≤ 100 when highlights are requested"). Whether a Free or pay-as-you-go key can actually request 26–100 results is unclear.
2. **Contents billing above 10 results** on `/search` (§4.1).
3. **`neural`/`keyword` types:** not documented, but still present in `costDollars.search` keys and the live x402 metadata.
4. **`resolvedSearchType`:** the changelog says it was removed on 2026-05-01, but the spec and the docs example still return it (as `""`).
5. **`/context`:** the route exists behind auth (observed 401 vs. 404) but is undocumented.
6. **`costDollars` presence:** optional in the schema, and the docs never promise it on every response.
7. **Billing of failed `/contents` URLs, `subpages`, and `outputSchema` synthesis:** undocumented.
8. **Free-grant reset timezone**, and the draw order between the monthly grant and expiring promo credits: undocumented.
9. **`x-exa-integration`:** used by Exa's own MCP server, absent from the public spec and docs.
10. **501/502 status codes:** not documented by Exa.

---

## 11. Implications for pi-search-broker

### 11.1 Which endpoints to proxy

- **Keep `POST /exa/search` and `POST /exa/contents`.** They are the only endpoints pi-web-access 0.47.0 calls with a key (`exa.ts`: `${apiBaseUrl}/search` and `${apiBaseUrl}/contents`). Its CHANGELOG notes that keyed searches no longer use `/answer` and that a custom `exaBaseUrl` gateway "must support `/search`".
- **Optional: `POST /exa/answer`.** Flat $0.005 and synchronous, so it fits the same reserve/commit loop. Reject `stream: true` unless SSE pass-through is implemented.
- **Do not add** `/research/*` (410, retired), `/findSimilar` (deprecated), `/context` (undocumented), Websets, or Monitors.
- **Do not add** `/agent/runs` or `/batches` without account affinity: follow-up `GET /agent/runs/{id}` must hit the same team that created the run, and metered runs can cost up to $5–$20 each.
- **Streaming guard.** `gateway.mjs` always calls `upstreamResponse.json()`. A `/search` body with `stream: true` + `outputSchema` returns `text/event-stream` and would be counted as a 502 against the account. Either reject `stream: true` with a 400, or detect `content-type: text/event-stream` and pipe it, taking the cost from the `done` chunk.

### 11.2 Fixing the estimate table in `quote()` (`src/manager.mjs`)

| Case | Current `quote()` | Correct (per [pricing](https://exa.ai/docs/admin/pricing)) |
|---|---|---|
| Base `lite`, `instant` | 0.004 | 0.004 |
| Base `auto`, `fast`, unknown or `neural`/`keyword` | 0.007 | 0.007 |
| Base `deep-lite`, `deep` | 0.012 | 0.012 (`deep-lite` currently falls to 0.007) |
| Base `deep-reasoning` | 0.007 (wrong) | 0.015 |
| Results above 10 | +0.001 each | +0.001 each (keep; conservatively +0.001 per content type per result above 10 given the ambiguity in §4.1) |
| `contents.text` / `contents.highlights` on `/search` | +0.001 × results × types | **0** within the first 10 results |
| `contents.summary` on `/search` | ignored | +0.001 × results |
| Missing `numResults` | assumes 5 | Exa default is 10 (no cost difference at ≤10) |
| `/contents` pages | `urls.length` only | `(urls ?? ids).length` (`ids` is ignored today) × (1 + `subpages`, as an upper bound) |
| `/contents` content types | text + highlights | text + highlights + **summary**; if none is given, assume 1 (undocumented default) |
| `/answer` | — | 0.005 |

For example, pi-web-access's default call (`type: "auto"`, `numResults: 5`, `contents: {highlights: true}`) costs **$0.007**. Today's `quote()` reserves $0.012, or $0.017 with `includeContent` (text + highlights). That makes small remaining balances look exhausted too early. An optional safety ceiling for unknown future types is the spec's `x-payment-info` max ($0.015 for search, $0.010 for contents).

`actualCost()`: keep preferring `costDollars.total`. It is "estimated … not an invoice record" and optional, so keep the fallback. Ignore `search`/`contents` sub-objects ("some search types report their cost only in total").

### 11.3 Which status codes should rotate keys (`gateway.mjs` + `manager.fail()`)

Read the JSON body's `tag`, which is small and contains no secrets, before deciding. The current logic keys only on the HTTP status.

| Upstream | Recommended action |
|---|---|
| 401 `INVALID_API_KEY` | Rotate; `disabled = 'auth'` (as today). |
| 402 `NO_MORE_CREDITS` / `TEAM_BUDGET_EXCEEDED` / `API_KEY_BUDGET_EXCEEDED` | Rotate; `disabled = 'quota'` until the next monthly reset or promo change (as today). Optionally set the local bucket `spent = limit` to resync. |
| 402 `X402_PAYMENT_REQUIRED` | Means no key reached Exa, i.e. a broker bug or a header strip. Treat like auth/config, log loudly. |
| 403 `TEAM_BLOCKED` | Rotate; disable. |
| 403 `FEATURE_DISABLED` | Try another account once; **do not disable**. |
| 403 `PROHIBITED_CONTENT`, `CONTENT_FILTER_ERROR`, unknown 403 tags | **Do not rotate, do not disable.** Return 403 to the client. Today every account in the pool gets `disabled = 'auth'` in turn, so one moderated query takes the whole pool offline until manual `enable`. |
| 429 `RATE_LIMIT_EXCEEDED` | Rotate (limits are per team); cool down that account using `Retry-After` (as today). If `X-RateLimit-Scope` indicates network scope, back off globally instead of burning through accounts. |
| 500, 502, 504 | Retry with backoff (another account is fine). Short or no account cooldown: these are not account faults. |
| 503 `SERVICE_OVERLOADED` | Not billed, not key-related. Retry with exponential backoff; **do not** put the account in the 10 s cooldown, or a brief Exa-wide overload can mark every account unavailable at once. |
| 400, 404, 409, 410, 422 | Pass through (as today). Consider relaying Exa's `error` and `tag` fields verbatim: they are actionable (e.g. "Not supported with type "lite": contents.summary") and never contain the key. Today the gateway replaces them with a generic message. |
| 432 | Keep for Tavily only; Exa never sends it. |
| 200 with `statuses[].status == "error"` | Not a key problem; pass through unchanged. |

### 11.4 Headers

- **Keep `x-api-key`**; it is fully supported. `Authorization: Bearer` is equivalent if ever needed.
- **`x-exa-integration`:** keep it. It is undocumented but used by Exa's own MCP for attribution, and pi-web-access already sends `pi-web-access`. Better: forward the client's value instead of hard-coding it, falling back to `pi-web-access`.
- **Forward `Exa-Beta`** from the client when present. Dynamic highlights and batches return 400 without it.
- Never forward the client's `Authorization` or `x-api-key`; they carry the local gateway token.
- Log upstream `x-request-id` per attempt, plus `x-exa-queued`/`x-exa-queue-ms`. Exa support asks for `requestId`, and queue time explains latency.

### 11.5 Real balances instead of guesses

- If each account's team gets Team Management API access (request it from support@exa.ai, then create a service key per team), poll `GET https://admin-api.exa.ai/team-management/credits` every few minutes. Use `credits_usd` as the authoritative remaining balance and `expiring_credits[].expires_at` to replace the hand-configured promo `expiresAt`. Remember the up-to-5-minute lag, and keep local reservations for in-flight requests on top.
- `GET /api-keys/{publicId}/usage` gives `total_cost_usd` per key for reconciling local `spent` against Exa's numbers.
- Without service keys, `costDollars.total` plus 402 handling is the best available signal.
- Exa enforces a hard per-key cap via `budgetCents` (per billing period). Setting it in the dashboard or API turns overspend into a clean `402 API_KEY_BUDGET_EXCEEDED`. That is useful if any account has auto-recharge enabled.

### 11.6 Accounting model alignment

- Exa draws "soonest-expiring credits first", which matches the broker's promo-first and earliest-deadline ordering.
- The free grant resets to $10 on the **1st** of each calendar month and does not accumulate, so `period: 'monthly'` with `resetDay: 1` and `limit: 10` is right. The timezone is undocumented; allow a grace window around midnight UTC or confirm via `/credits`. The onboarding bonus does not expire: model it as `period: 'once'` with no `expiresAt`.
- "Only a user's first team receives the monthly grant." Pooled free-tier accounts only get the monthly allowance if each belongs to a distinct user. Check Exa's terms for multi-account use.

### 11.7 Deprecated parameters pi-web-access might send

pi-web-access 0.47.0 sends:
- `/search`: `query`, `type: "auto"`, `numResults` (default 5), `includeDomains`/`excludeDomains`, `category`, `startPublishedDate`, `contents: {highlights: true}` or `{text: true, highlights: true}`.
- `/contents`: `urls: [url]`, `text: true` (top-level, which is correct for `/contents`).

None of these is deprecated. Remaining risks:

- `category` is free-form in the tool. Older values such as `research paper`, `pdf`, `github`, `tweet`, or `linkedin` are deprecated but still accepted as hints. `company`/`people` combined with `startPublishedDate` (from `recencyFilter`) return **400**; `people` with `excludeDomains` also returns 400. Pass these through as 400 and do not rotate.
- If a future version switches to `type: "lite"`, any `maxAgeHours`, `livecrawl`, `summary`, or `outputSchema` returns 400.
- Older configs or other clients may still send `useAutoprompt`, `livecrawl`, `numSentences`, `highlightsPerUrl`, `startCrawlDate`/`endCrawlDate`, `contents.context`, or top-level `text`/`highlights` on `/search`. Most are silently ignored or produce `warnings[]`; `livecrawl` together with `maxAgeHours` is a 400. The broker could log `warnings[].message` to help keep clients current, never forwarding warnings into model context.

### 11.8 Timeouts

pi-web-access aborts after 60 s for both search and contents (`requestSignal()`, `CONTENTS_TIMEOUT_MS = 60_000`). Keep `config.totalTimeoutMs` < 60 s so the broker can return a structured error first. Latency budgets: `deep` up to about 15 s, `deep-reasoning` up to about 40 s, live crawls up to `livecrawlTimeout` (default 10 s, max 90 s), plus possible rate-limit queueing. A per-attempt timeout of around 25–30 s leaves room for one failover. Since a timed-out attempt may still be billed upstream, consider keeping the reservation as "estimated spent" rather than releasing it on abort.
