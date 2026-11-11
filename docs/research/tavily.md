# Tavily API research for pi-search-broker

Retrieved 2026-11-09. Sources are first-party only: docs.tavily.com, the official OpenAPI spec, and the `tavily-python`, `tavily-js`, and `tavily-mcp` repos at the commits listed in [Sources](#sources). Citations are reference-style links like [spec] or [credits]. Every label resolves to a URL in the Sources list at the end.

Notation: **Undocumented** means no first-party source states it. **Conflict** means two first-party sources disagree.

---

## TL;DR

- **Spec location.** The official OpenAPI 3.0.3 spec is `https://docs.tavily.com/documentation/api-reference/openapi.json` [llms]. It covers 10 operations on `https://api.tavily.com/`: `POST /search`, `/extract`, `/crawl`, `/map`, `/research`, `GET /research/{request_id}`, `POST /feedback`, `GET /usage`, `POST /logs`, and `POST /org-usage` [spec]. The Enterprise key APIs live on a separate host, `https://api-key-generator.tavily.com/` [genkeys].
- **Exact credits are available.** Send `include_usage: true` in the body of search, extract, crawl, or map. The response then carries `usage: { credits: N }` [spec][changelog]. For research, call `GET /research/{id}?include_usage=true` [spec]. The broker can stop estimating whenever it sets this flag.
- **Balance reconciliation is possible.** `GET /usage` returns per-key usage and limit, plus account-wide `plan_usage`/`plan_limit` and `paygo_usage`/`paygo_limit` [usage]. It has its own rate limit of **10 requests per 10 minutes** [ratelimits].
- **Three status-code bugs in the current gateway.**
  1. **433 (PayGo limit exceeded)** is account-specific, but the broker treats it as a non-retryable 4xx and returns it to the client.
  2. **403** on `/crawl` and `/map` means "URL is not supported" [spec]. The broker permanently disables the account with `auth` on 403, which is wrong for those endpoints.
  3. **434 (Flex tier capacity exceeded)** is new. It is plan-dependent and only happens when `max_age_hours` is set [ratelimits].
- **Cost rules.** Search costs 1 credit for `basic`, `fast`, and `ultra-fast`, and 2 for `advanced`. `auto_parameters` may upgrade a search to advanced (2 credits) [spec]. Extract costs 1 or 2 credits per 5 *successful* URLs. Map costs 1 or 2 per 10 pages. Crawl costs map plus extract. Research is dynamic: mini 4–110 credits, pro 15–250 [credits]. Failed extractions and failed maps are not charged [credits]. Whether a failed **search** is billed is undocumented.
- **Rate limits.** Dev keys get 100 RPM and prod keys 1,000 RPM. Crawl is 100 RPM and research creation 20 RPM on both key types [ratelimits]. A 429 may carry `Retry-After` in integer seconds. No `X-RateLimit-*` headers are documented [spec][ratelimits].
- **Plans.** The free plan gives 1,000 credits per month and resets on the 1st [credits][faq]. Production keys require a paid plan or PAYGO [ratelimits].
- **SDK behavior.** Neither official SDK retries or backs off; I checked the source [py][js]. The docs recommend application-level exponential backoff of `2**attempt` seconds over 5 attempts [bp-search].

---

## 1. The official OpenAPI spec

- **URL:** `https://docs.tavily.com/documentation/api-reference/openapi.json`. It is linked from the "OpenAPI Specs" section of [llms]. Each API reference page also embeds the relevant fragment as YAML (for example [usage]).
- **Header:** `openapi: 3.0.3`, title "Tavily Search and Extract API", `version: 1.0.0`, single server `https://api.tavily.com/` [spec]. The title is stale because the spec now covers every endpoint.
- **Security schemes** [spec]:
  - `bearerAuth`: HTTP bearer, described as "`Bearer <token>`, where `<token>` is your Tavily API key (e.g., `Bearer tvly-YOUR_API_KEY`)". Used by all data endpoints.
  - `ownerBearerAuth`: the token must be the **organization owner's personal API key**. Used only by `/org-usage`.
- **Shared components** [spec]:
  - `ApiError` = `{ detail: { error: string } }`.
  - `ValidationError` = `{ detail: [{ loc: (string|int)[], msg, type, input, ctx }] }`. This is the FastAPI/Pydantic shape.
  - Header `RetryAfter`: integer ≥ 0, "the number of seconds to wait before retrying".
  - Research schemas `ResearchTaskCompleted` and `ResearchTaskFailed`.
  - Org-usage schemas `UsageMetrics` and `UsageByType`.
- **Not in the main spec.** `/generate-keys`, `/deactivate-keys`, and `/key-info` (Enterprise only) have their own embedded spec on `https://api-key-generator.tavily.com/` [genkeys][keyinfo][deactivate]. The research SSE response (`text/event-stream`) does not appear in the spec at all. It is described only in prose [streaming].

| Method | Path | Documented response codes (from [spec]) |
|---|---|---|
| POST | `/search` | 200, 400, 401, 422, 429, 432, 433, 434, 500 |
| POST | `/extract` | 200, 400, 401, 429, 432, 433, 500 |
| POST | `/crawl` | 200, 400, 401, **403**, 429, 432, 433, 500 |
| POST | `/map` | 200, 400, 401, **403**, 429, 432, 433, 500 |
| POST | `/research` | **201**, 400, 401, 429, 432, 433, 500 |
| GET | `/research/{request_id}` | 200 (completed or failed), **202** (pending or in_progress), 401, 404, 500 |
| POST | `/feedback` | 200, 400, 401, 413, 422, 500 |
| GET | `/usage` | 200, 401, 429 |
| POST | `/logs` | 200, 400, 401, 403, 429, 504 |
| POST | `/org-usage` | 200, 400, 401, 403, 404, 422, 429, 500, 504 |

---

## 2. Endpoints

Fields are condensed from [spec]. `*` marks a required field.

### 2.1 `POST /search`

**Request**

| Field | Type | Default | Allowed / range | Notes |
|---|---|---|---|---|
| `query`* | string | — | — | Keep under 1,500 characters [bp-search]. |
| `search_depth` | string | `basic` | `advanced`, `basic`, `fast`, `ultra-fast` | Cost: basic/fast/ultra-fast = 1, advanced = 2. `ultra-fast` returns one NLP summary per URL. The others return chunks. |
| `chunks_per_source` | int | 3 | 1–3 | About 500 chars per chunk for basic/fast and 800 for advanced. Joined with `[...]`. Applies to advanced, basic, and fast. |
| `max_results` | int | **10** | 0–20 | **Conflict:** [bp-search] says the default is 5. |
| `topic` | string | `general` | `general`, `news`, `finance` | |
| `time_range` | string | null | `day`, `week`, `month`, `year`, `d`, `w`, `m`, `y` | |
| `start_date` / `end_date` | string | null | `YYYY-MM-DD` | |
| `include_published_date` | bool | false | | Beta. Automatically on when `topic=news`. |
| `filter_by_published_date` | bool | false | | Drops results outside the date window and results with no date. |
| `max_age_hours` | int | null | −1 … 720 | 0 = always fetch live. −1 = never fetch live. "Lower values do not cost more credits". Can trigger **434** on non-paying plans. |
| `include_answer` | bool or string | false | `true`, `basic`, `advanced` | LLM answer. No cost effect is documented. |
| `include_raw_content` | bool or string | false | `true`, `markdown`, `text` | No cost effect is documented. |
| `include_images` | bool | false | | Adds a top-level `images` array and per-result `images`. |
| `include_image_descriptions` | bool | false | | Only with `include_images`. |
| `include_favicon` | bool | false | | |
| `include_domains` | string[] | [] | max 300 | |
| `exclude_domains` | string[] | [] | max 150 | |
| `include_domains_mode` | string | `restrict` | `restrict`, `prefer` | Returns 400 if `include_domains` is absent. |
| `country` | string | null | Long enum of lowercase country names, e.g. `united states` | Only when `topic=general`. |
| `language` | string | null | ISO 639-1 code or English name | Boosts results in that language. |
| `filter_by_language` | bool | false | | Requires `language`, otherwise 400. |
| `auto_parameters` | bool | false | | "`search_depth` may be automatically set to advanced… This uses 2 API credits per request. To avoid the extra cost, you can explicitly set `search_depth` to `basic`." |
| `exact_match` | bool | false | | Matches quoted phrases exactly. |
| `include_usage` | bool | false | | Adds `usage.credits` to the response. |
| `safe_search` | bool | false | | Not supported for `fast` or `ultra-fast`. |

Fields the SDKs send that the spec does not list: `days`, `fetch_timeout`, and `cache_fallback`. They appear in `tavily-python` `_search` [py] and in `tavily-js` `parameters.ts` [js-params]. The 434 error example also mentions `fetch_timeout` [spec][ratelimits]. They are **undocumented** in the reference.

**Response 200** fields:

- Required: `query`, `answer`, `images[]` (`{url, description}`), `results[]`, and `response_time`.
- Each item in `results[]` has `title`, `url`, `content`, `score`, `raw_content`, `published_date`, `favicon`, `images[]`, and `id`.
- Optional: `auto_parameters` (the parameters Tavily chose), `usage` (example `{ "credits": 1 }`), and `request_id` [spec].
- Streaming: none.

### 2.2 `POST /extract`

| Field | Type | Default | Allowed / range | Notes |
|---|---|---|---|---|
| `urls`* | string or string[] | — | max 20 | More than 20 URLs or an empty list returns 400. |
| `query` | string | — | | Reranks chunks by intent. |
| `chunks_per_source` | int | 3 | 1–5 | Only with `query`. About 800 chars per chunk. **Conflict:** [changelog] says "up to 500 characters". |
| `extract_depth` | string | `basic` | `basic`, `advanced` | 1 credit per 5 successful URLs for basic, 2 for advanced. |
| `include_images` | bool | false | | |
| `include_favicon` | bool | false | | |
| `format` | string | `markdown` | `markdown`, `text` | |
| `timeout` | number | none | 1–60 s | Server default: 10 s for basic, 30 s for advanced. |
| `include_usage` | bool | false | | "The value may be 0 if the total successful URL extractions has not yet reached 5 calls." |

**Response 200** fields [spec]:

- `results[]` with `{url, raw_content, images[], favicon}`.
- `failed_results[]` with `{url, error}`.
- `response_time`, `usage`, and `request_id`.

A 200 can contain an empty `results` array when every URL failed. When all URLs fail validation, the 400 response includes `detail.failed_results`.

### 2.3 `POST /crawl`

| Field | Type | Default | Range / notes |
|---|---|---|---|
| `url`* | string | — | Root URL. |
| `instructions` | string | — | Mapping cost rises to 2 credits per 10 pages. |
| `chunks_per_source` | int | 3 | 1–5. Only with `instructions`. |
| `max_depth` | int | 1 | 1–5 |
| `max_breadth` | int | 20 | 1–500 |
| `limit` | int | 50 | ≥ 1. Total number of links processed. |
| `select_paths`, `select_domains`, `exclude_paths`, `exclude_domains` | regex[] | null | |
| `allow_external` | bool | true | |
| `include_images` | bool | false | |
| `extract_depth` | string | `basic` | `basic` or `advanced`. 1 or 2 credits per 5 successful extractions. |
| `format` | string | `markdown` | `markdown` or `text` |
| `include_favicon` | bool | false | |
| `timeout` | number | 150 | 10–150 s |
| `include_usage` | bool | false | May be 0 below the minimum thresholds. |

**Response 200** fields: `base_url`, `results[]` with `{url, raw_content, favicon}`, `response_time`, `usage`, and `request_id`. **403** means "URL is not supported" [spec].

### 2.4 `POST /map`

The fields match crawl, minus every extraction-related field:

- `url`*, `instructions`, `max_depth` (1–5, default 1), `max_breadth` (1–500, default 20), `limit` (default 50).
- The `select_*` / `exclude_*` regex filters and `allow_external` (default true).
- `timeout` (10–150 s, default 150) and `include_usage`.

**Response 200** fields: `base_url`, `results: string[]`, `response_time`, `usage`, and `request_id`. **403** means "URL is not supported" [spec].

### 2.5 `POST /research`, `GET /research/{request_id}`, and streaming

**`POST /research` request** [spec]

| Field | Type | Default | Notes |
|---|---|---|---|
| `input`* | string | — | |
| `model` | string | `auto` | `mini`, `pro`, `auto` |
| `stream` | bool | false | `true` returns SSE. |
| `output_schema` | object | null | JSON Schema. Must have `properties` and may have `required`. |
| `citation_format` | string | `numbered` | `numbered`, `mla`, `apa`, `chicago` |
| `include_domains` | string[] | [] | Soft preference. Max 20. |
| `exclude_domains` | string[] | [] | Hard block. Max 20. |
| `output_length` | string | `standard` | `short`, `standard`, `long` |
| `files[]` | `{name*, data* (base64), type: "base64"}` | — | `.txt`, `.md`, `.json` only. Up to 5 files and 80,000 words combined. |

**Responses**

- Non-streaming `POST` returns **201** `{request_id, created_at, status: "pending", input, model, response_time}` [spec].
- `GET /research/{request_id}?include_usage=bool` returns:
  - **202** `{request_id, status: pending|in_progress, response_time}`
  - **200** completed: `{request_id, created_at, status: "completed", content (string, or object if output_schema), sources[{title,url,favicon}], response_time, usage}`
  - **200** failed: `{request_id, status: "failed", response_time, usage}`
  - **404** "Research task not found" [spec]
- The failed example shows `usage: {credits: 0}`. That is only an example, not a stated rule.

**Streaming** (`stream: true`) [streaming]

- The response is `text/event-stream`. Events use an OpenAI `chat.completion.chunk`-style envelope `{id, object, model, created, choices:[{delta}]}`.
- Delta kinds:
  - `tool_calls` of type `tool_call` or `tool_response`. Tool names are `Planning`, `WebSearch`, `ResearchSubtopic` (pro only), and `Generating`.
  - `content` (string, or object with `output_schema`).
  - `sources`.
- The stream ends with `event: done`.
- Errors arrive as `{id, object: "error", error: "..."}`.
- Whether the stream reports credit usage is **undocumented**.

**Undocumented behavior seen in the official MCP server** [mcp]:

- The server falls back to streaming when `POST /research` returns 400 with `detail.error_code === "research_stream_required"`. `error_code` appears nowhere in the docs.
- Polling starts at 2 s and grows ×1.5 up to 10 s. It gives up after 5 minutes for mini and 15 minutes for pro or auto.
- For streams it allows a 30 s header timeout and a 5-minute idle timeout.

### 2.6 `GET /usage`

See [section 5](#5-usage-and-balance-apis).

### 2.7 Other endpoints

- **`POST /feedback`** [spec] (beta per [llms]):
  - Body fields: `request_id` or `session_id` (one is required), `agent_score`, `human_score`, `extra_scores[{label,value}]`, `comment`, `response_delivered`, `used_ids`, `used_urls`, `used_citations`, and `urls_scores[{id|url, agent_score, scores[], comment}]`.
  - Body limit is 256 KB. Larger bodies return 413.
  - 200 returns `{success, feedback_id, response_time}`.
  - No credit cost is documented.
- **`POST /logs`** (paid plans only; free plans get 403) [spec]:
  - Body fields: `limit` (1–10000, default 10), `start_date`, `end_date`, `endpoints[]` (search, extract, map, crawl, research), `project_id`, and `filter_by_api_key` (default false, meaning all keys in the account or org).
  - Returns `logs[{timestamp, endpoint, depth, response_time, credits, api_key (last 4 chars), request_id}]`, plus `count`, `response_time`, and `request_id`. "Log entries never include the input or output."
  - Can time out with 504.
- **`POST /org-usage`** (org owner's personal key only) [spec]:
  - Body fields: `organization_name`* (case-sensitive), `start_date`, `end_date`, `project_id`, and `depth` (`basic`, `advanced`, `fast`, `pro`, `mini`, `auto`, `ultra-fast`).
  - Returns `organization{name, filters}`, `totals{usage, paygo_cost_usd, request_count, by_type{search,crawl,extract,map,research}}`, and `keys[{key (last 5 chars), name, usage, paygo_cost_usd, request_count, by_type}]`.
- **Enterprise only, on `api-key-generator.tavily.com`:**
  - `POST /generate-keys` with `permission_level`* (`admin` or `user`), `name`, `scope` (`api:generate_keys`), `key_type` (`development` or `production`, default development), `key_limit` (1–100000, default 200), `ttl_hours` (1–8760, default 10), and `count` (1–200). Returns `keys[]`, `expires_at`, `created`, `message`, and `request_id` [genkeys].
  - `POST /deactivate-keys`, either by `request_id` or for the key in the `Authorization` header [deactivate].
  - `GET /key-info` returns `{name, created, expires_at|"never", key_type, status: active|deactivated}` [keyinfo].

---

## 3. Authentication and request headers

| Header | Status | Source |
|---|---|---|
| `Authorization: Bearer tvly-…` | **The documented auth method** for all endpoints. | [headers][spec] |
| `Content-Type: application/json` | Required for POST bodies. | [headers] |
| `X-Project-ID: <id>` | Optional. Tags the request to a project so it can be filtered in `/logs` and the dashboard. On `GET /usage` it scopes the usage query to that project. "An API key can be associated with multiple projects." SDKs set it from `project_id` or `projectId`, or from the `TAVILY_PROJECT` environment variable. | [headers][usage][changelog] |
| `X-Session-Id` | Optional opaque session id that groups related calls. The MCP server fills it automatically. It is also used as `session_id` in `/feedback`. | [headers][spec] |
| `X-Human-Id` | Optional opaque end-user id. Tavily hashes it. | [headers] |
| `X-Tavily-Access-Mode: keyless` | Keyless access, `/search` and `/extract` only. When a valid Bearer key is also present, the key wins. | [keyless] |
| `X-Client-Source` | Sent by the SDKs: `tavily-python`, `tavily-js`, `MCP`, or the `-keyless` variants. **Not documented** in the docs. | [py][js][mcp] |
| `X-Client-Name`, `X-Tavily-Orgid` | Sent by the SDKs when configured. **Not documented** in the docs. | [py][js] |

**`api_key` in the JSON body**

- No current documentation mentions it. Every docs example uses the Bearer header [headers].
- The official `tavily-mcp` server still sends `api_key` in the body *in addition to* the Bearer header [mcp].
- Whether body `api_key` is still honored, and which one wins if both are present, is **undocumented**.
- A probe I ran with an invalid body key and no header returned the same 401 as an invalid header key. That is consistent with either reading, so it settles nothing.

**Response headers**

- Only `Retry-After` (on 429) is documented [spec][ratelimits].
- An unauthenticated 401 probe returned only `Date`, `Content-Type`, `Content-Length`, `Connection`, and `content-security-policy`. There were no request-id or rate-limit headers.
- The request id is returned in the JSON body as `request_id` [spec].

---

## 4. Credit costs

From [credits] unless marked otherwise.

| Operation | Cost |
|---|---|
| Search `basic` | 1 credit |
| Search `advanced` | 2 credits |
| Search `fast` / `ultra-fast` | 1 credit [spec][changelog]. **Conflict:** the [credits] page lists only basic and advanced. |
| Search with `auto_parameters: true` | "This uses 2 API credits per request", because depth may be set to advanced. Setting `search_depth` explicitly avoids it [spec][changelog]. Whether it is always 2 or only when advanced is chosen is ambiguous. The response's `auto_parameters.search_depth` shows what was chosen [js-search]. |
| `include_answer`, `include_raw_content`, `include_images`, `max_results`, `chunks_per_source`, `max_age_hours` | No surcharge is documented. For `max_age_hours`, "Lower values do not cost more credits" [spec]. |
| Extract `basic` | 1 credit per 5 **successful** URL extractions. "You never get charged if a URL extraction fails." |
| Extract `advanced` | 2 credits per 5 successful URL extractions. |
| Map | 1 credit per 10 successful pages. 2 per 10 with `instructions`. "You never get charged if a map request fails." |
| Crawl | Mapping cost plus extraction cost. Example: 10 pages at basic = 1 + 2 = 3. At advanced = 1 + 4 = 5. |
| Research `mini` | Dynamic, 4–110 credits per request. |
| Research `pro` | Dynamic, 15–250 credits per request. |
| Research `auto` | **Undocumented.** It is presumably bounded by whichever model runs. |
| `/usage`, `/logs`, `/feedback`, `/org-usage` | Not listed as credit-consuming. |

**Plans and pricing** [credits]:

| Plan | Credits / month | Price | Price / credit |
|---|---|---|---|
| Free (Researcher) | 1,000 | $0, no card required | — |
| Project | 4,000 | $30 | $0.0075 |
| Bootstrap | 15,000 | $100 | $0.0067 |
| Startup | 38,000 | $220 | $0.0058 |
| Growth | 100,000 | $500 | $0.005 |
| Pay as you go | per use | — | $0.008 |
| Enterprise | custom | custom | custom |

PAYGO charges per credit "once your plan's credit limit is reached" [credits].

**Reset timing**

- Credits "reset on the first day of each month, regardless of the billing date" [faq].
- With the monthly-limits setting, key and workspace limits reset "on the 1st of each month, at midnight UTC" [orgs].
- The timezone of the account-level reset is **undocumented**.

**Are failed calls billed?**

- Failed extractions and failed maps are not billed [credits].
- Search, crawl, and research: **undocumented**. A failed research task in the spec example shows `usage.credits: 0` [spec].

**Reported usage**

- `include_usage: true` returns `usage: {credits: <int>}` on search, extract, crawl, and map [spec][changelog].
- For research, use `GET /research/{id}?include_usage=true` [spec].
- For extract, crawl, and map the value "may be 0 if the total successful URL extractions has not yet reached 5". This implies Tavily accumulates fractional units across calls and bills whole credits as thresholds are crossed. The scope of that carry (per key or per account) is **undocumented**.
- No usage is reported in response headers [spec].
- Usage is opt-in, off by default.

---

## 5. Usage and balance APIs

**`GET /usage`** [usage][spec]

- Auth: Bearer key. Optional `X-Project-ID` header to scope to one project.
- Separate rate limit: **10 requests per 10 minutes**, dev or prod [ratelimits].
- Response:

| Field | Meaning |
|---|---|
| `key.usage` | Credits used **by this API key** in the current billing cycle. |
| `key.limit` | The key's usage limit. `null` if unlimited. |
| `key.search_usage`, `extract_usage`, `crawl_usage`, `map_usage`, `research_usage` | Per-endpoint credits for this key. |
| `account.current_plan` | Plan name, e.g. "Bootstrap". |
| `account.plan_usage` / `account.plan_limit` | Credits used and the limit for the **whole plan** (account-wide) this cycle. |
| `account.paygo_usage` / `account.paygo_limit` | Pay-as-you-go usage and cap. |
| `account.search_usage` … `research_usage` | Per-endpoint account totals. |

So one call returns both the key's view and the account's view. That lets the broker compute real remaining capacity per account:
`min(key.limit − key.usage, (plan_limit − plan_usage) + (paygo_limit − paygo_usage))`.
When `key.limit` is null, ignore the key term.

Caveats:

- **Freshness is undocumented.** Observed (not first-party), 2026-11-11, free "Researcher" plan: after a basic search billed 1 credit (`usage.credits: 1`), `GET /usage` for that key still reported `key.usage: 0` and `plan_usage: 0` about 1, 4 and 17 minutes later. Treat `/usage` as lagging by at least that much; the broker assumes one hour.
- Promo or bonus credits are not broken out in this response (**undocumented**).
- Moving a key to another workspace resets the key's own usage to 0 [orgs].
- If a plan's credits run out but PAYGO is enabled, requests keep succeeding at $0.008 per credit [credits].

**Other balance-related APIs**

- `POST /logs` gives exact per-request `credits` keyed by `request_id`. Paid plans only [spec].
- `POST /org-usage` covers an org owner's view [spec].
- `GET /key-info` gives key type and active status. Enterprise only [keyinfo].

---

## 6. Rate limits

From [ratelimits]:

| Scope | Development key | Production key |
|---|---|---|
| Default, all endpoints | 100 RPM | 1,000 RPM |
| `/crawl` | 100 RPM | 100 RPM |
| `POST /research` (creation; polling uses the default limit) | 20 RPM | 20 RPM |
| `/usage` | 10 per 10 min | 10 per 10 min |
| Keyless | separate limits and a different error format [keyless] | — |

- **Production keys** "require either an active Paid Plan or PAYGO enabled" [ratelimits]. A free account therefore has dev keys only.
- **Scope:** the wording "based on the environment associated with your API key" suggests the limits are per key. Whether they are per key or per account is **undocumented**.
- **On 429:** the API returns `429 Too Many Requests`, optionally with `Retry-After: <seconds>`. Tavily says to "use the HTTP status and header for retry handling rather than matching the message text" [ratelimits]. No `X-RateLimit-Limit/Remaining/Reset` headers are documented.
- **Concurrency guidance:** `concurrency ≈ (RPM / 60) × avg_latency_s`, for example 100 RPM × 3 s ≈ 5 in flight [bp-search].

---

## 7. Error semantics

The body is `{"detail": {"error": "<message>"}}` everywhere except 422, which uses the Pydantic `detail[]` array [spec]. Keyless errors use an envelope `{"error": {"code", "message", "window", "retry_after_seconds", "next_actions[]"}}` [py][js-errors][mcp].

| Code | Meaning (first-party) | Key- or account-specific? | Rotate to another account? |
|---|---|---|---|
| 400 | Invalid request (bad topic or model, too many URLs, `include_domains_mode` without `include_domains`, etc.) [spec]. Also `research_stream_required` (MCP only, undocumented) [mcp]. | No | **No.** Return to client. |
| 401 | "Unauthorized: missing or invalid API key." [spec] | Key | Yes. Disable the key until fixed. |
| 402 | Not documented on `api.tavily.com`. It is used by x402 on the separate host `x402.tavily.com` [x402]. | — | Harmless to keep in the rotate set. Not expected. |
| 403 | `/crawl` and `/map`: "URL is not supported" (request-specific) [spec]. `/logs`: logs only for paying customers. `/generate-keys`: key not in Default workspace [genkeys]. **Not listed for `/search` or `/extract`.** The Python SDK maps 403, 432, and 433 to `ForbiddenError` [py]. | Depends on endpoint | **No** for crawl and map. For search and extract it is undocumented, so treat it as a short cooldown, not a permanent auth disable. |
| 404 | `GET /research/{id}`: "Research task not found" [spec]. | Possibly account-scoped (**undocumented**) | No. Route polls to the account that created the task. |
| 413 | `/feedback` body over 256 KB [spec]. | No | No. |
| 422 | Pydantic validation failure (`/search`, `/feedback`, `/org-usage`) [spec]. | No | No. |
| 429 | Rate limit exceeded. Optional `Retry-After` in seconds [spec][ratelimits]. The SDK names this `UsageLimitExceededError` [py], but the docs define it as rate limiting. | Key (probably) | Yes. Cool down for `Retry-After`. |
| 432 | "Key limit or Plan Limit exceeded" [spec]. Also used for **workspace credit limit reached** and **workspace disabled** [orgs]. Messages distinguish plan, key, workspace limit, and workspace disabled [orgs]. | Key or account | Yes. Mark exhausted until the reset; workspace-disabled needs manual action. |
| 433 | "PayGo limit exceeded… You can increase your limit on the Tavily dashboard." [spec] | Account | **Yes.** The broker currently does not rotate on it. |
| 434 | "Flex tier capacity exceeded". Only for search with `max_age_hours` on **non-paying plans** under heavy load. "Retry shortly, or omit max_age_hours" [spec][ratelimits]. | Plan (free tier) | Optional: rotate to a paid account, otherwise return to client. Don't penalize the account. |
| 500 | Server error [spec] | No | Yes, with a short cooldown. Billing of failed calls is undocumented. |
| 504 | `/logs` or `/org-usage` query timeout [spec] | No | No. Not a proxied data path. |

---

## 8. Best practices from Tavily

- **Query length.** Keep the query under 1,500 characters and split multi-topic questions into separate queries [bp-search].
- **Recommended agent defaults** [llms]:
  - `search_depth="advanced"`
  - `chunks_per_source=3`
  - `max_results=5` (10 for broad research)
  - "avoid `include_answer` unless you need a quick answer seed"
- **Depth choice.** `ultra-fast` returns an NLP summary. `fast`, `basic`, and `advanced` return reranked chunks. Use `advanced` for niche, very recent, or multi-faceted queries [bp-search].
- **`max_results`.** "Setting too high may return lower-quality results" [bp-search].
- **Date filters.** Use `time_range` or `start_date`/`end_date`. `filter_by_published_date` also drops undated results. `max_age_hours` is about cache freshness, not publish date [bp-search].
- **`topic`.** Use `news` for current events. It auto-includes `published_date` [bp-search][spec].
- **Domain filters.** Keep `include_domains` and `exclude_domains` lists short. Use `include_domains_mode: "prefer"` to avoid empty results [bp-search]. `country` works only with `topic=general` [spec].
- **`auto_parameters`.** Set `search_depth` explicitly to control cost [bp-search].
- **Two-step pattern.** Search first, then call `/extract` on chosen URLs instead of `include_raw_content` for heavy extraction [bp-search].
- **Credit tracking.** "Pass `include_usage=True` and sum the `usage` from each response" [bp-search].
- **Timeouts.**
  - The docs checklist says "Cap each search (e.g. `timeout=10`)" [bp-search].
  - SDK defaults [py][js]:
    - Python: search 60 s, capped at 120; extract 30 s; crawl and map 150 s; research none.
    - JS: 60 s for everything except research, which has none.
  - Server-side extract defaults are 10 s for basic and 30 s for advanced. Crawl and map default to 150 s [spec].
- **Retry and backoff.**
  - **Neither SDK implements retries or backoff.** Grepping both SDKs' source for `retry`/`backoff`/`sleep` finds only keyless `retry_after_seconds` parsing [py][js].
  - The docs recommend app-level retries: 5 attempts with `sleep(2 ** attempt)` seconds, bounded concurrency through a semaphore, and per-query failure tagging [bp-search].
  - On 429, honor `Retry-After` [ratelimits].
- **Key hygiene.** Rotate keys about every 90 days. Revoke leaked keys in the dashboard [keymgmt].

---

## 9. Key types

- **Development keys:** 100 RPM. **Production keys:** 1,000 RPM, and they require a paid plan or PAYGO [ratelimits].
  - The key type can be read via `GET /key-info` (Enterprise only) [keyinfo].
  - Generated dev keys have the prefix `tvly-dev-` [genkeys].
  - The production prefix is **undocumented**.
- **Per-key limits.** A key can carry its own credit limit. Exceeding it returns 432 "This request exceeds this API key's set usage limit" [orgs]. `/usage` reports this as `key.limit` [usage].
- **Projects** are **not** a key type. They are a tag carried in the `X-Project-ID` header, and one key can serve many projects [headers]. Whether a project ID is valid across different Tavily accounts is **undocumented**.
- **Workspaces** (organizations) [orgs]:
  - Each workspace has its own keys and its own credit limit. Billing stays at the org level.
  - Workspace refusals arrive as 432.
  - Workspaces are managed in the dashboard only.
- **Enterprise generated keys** [genkeys][deactivate]:
  - Each has a `key_type`, a credit limit (`key_limit`), and a TTL (`ttl_hours`). They are deactivated automatically after the TTL.
  - They can be deactivated in bulk by generation `request_id`.

---

## Implications for pi-search-broker

These recommendations are based on `src/gateway.mjs` and `src/manager.mjs` as they stand.

### Which endpoints to proxy

1. **Keep `POST /tavily/search`.** It is the only Tavily endpoint pi-web-access calls. Its `tavily.ts` sends `search_depth: "basic"`, `max_results`, `include_answer: "basic"`, `include_raw_content`, `time_range`, and the include/exclude domain lists, with a 60 s client timeout.
2. **Add `POST /tavily/extract` next.** It has the same auth, error set, and `include_usage` support. Note that it bills only *successful* URLs [credits].
3. **Add `/crawl` and `/map` only with per-endpoint timeouts.** They run up to 150 s server-side, while the gateway caps `server.requestTimeout` at 60 s and `totalTimeoutMs` at 55 s or less.
4. **Treat `/research` as a separate design.**
   - It is asynchronous (201, then poll `GET /research/{id}`) or SSE.
   - It has its own 20 RPM limit, and costs range from 4 to 250 credits.
   - Polls must go to the account that created the task (sticky `request_id → account` map). Otherwise expect 404.
   - SSE needs streaming passthrough. The current gateway buffers and parses JSON.
5. **Do not expose `/usage`, `/logs`, or `/org-usage` to clients.** Use them internally for reconciliation.

### Fixing cost estimation (`quote()` / `actualCost()`)

1. **Inject `include_usage: true` into every forwarded search, extract, crawl, and map body.** On success, read `data.usage.credits` and commit it as `exact: true` in `actualCost()`.
   - Optionally delete `usage` from the response if the client did not ask for it. pi-web-access ignores it, so leaving it in is harmless.
   - This removes estimation for the only path in use today.
2. **Update the reservation estimate in `quote()` to reserve the worst case:**
   - **search:** `search_depth === 'advanced'` → 2. Otherwise, if `auto_parameters === true` and `search_depth` is unset → 2. Otherwise (basic, fast, ultra-fast, or unset) → 1. No surcharge for `include_answer` or `include_raw_content` [credits][spec].
   - **extract:** `ceil(urls.length / 5) × (extract_depth === 'advanced' ? 2 : 1)`, where `urls` is at most 20.
   - **map:** `ceil(limit / 10) × (instructions ? 2 : 1)`, with `limit` defaulting to 50.
   - **crawl:** map cost + `ceil(limit / 5) × (advanced ? 2 : 1)`. At defaults that is 5 + 10 = 15.
   - **research:** reserve the maximum (mini 110, pro or auto 250). Commit the value from `GET /research/{id}?include_usage=true`.
3. **Expect `usage.credits` to be 0 sometimes.** For extract, crawl, and map, Tavily bills whole credits when cumulative thresholds are crossed, so a single request can report 0 [spec]. Summing the reported values is still correct over time. Do not fall back to the estimate when a reported 0 is present.

### Reconciling with `/usage`

1. **Add a reconcile job.** Call `GET https://api.tavily.com/usage` with one key per account.
   - Stay well under 10 calls per 10 minutes per key, for example on demand from `/status`, every 5–10 minutes, or right after a 432 or 433.
   - Do not route this through `manager.fail()`. `/usage` has its own rate-limit bucket, so a 429 from `/usage` does not mean search is rate-limited.
2. **Map the fields to state.**
   - Map `account.plan_usage`/`plan_limit` onto the monthly bucket. The provider is authoritative because other clients may share the account.
   - Map `account.paygo_usage`/`paygo_limit` onto a PAYGO bucket if one is configured.
   - Respect `key.limit` (non-null) as an extra per-key cap.
   - This could reuse the existing `set-spent` admin operation.
3. **Keep local promo or `once` buckets as local bookkeeping.** `/usage` does not break out bonus credits (undocumented).

### Status codes that should rotate the key (gateway and `manager.fail()`)

| Status | Current behavior | Recommended |
|---|---|---|
| 401 | rotate, disable `auth` | Keep. |
| 402 | rotate, disable `quota` | Keep (harmless). Not documented on api.tavily.com [x402]. |
| 403 | rotate, disable `auth` permanently | `/crawl` and `/map`: **do not rotate**. Pass through as a client error ("URL is not supported"). `/search` and `/extract`: undocumented, so rotate with a cooldown (for example 10 minutes) rather than a permanent disable. |
| 429 | rotate, cooldown from Retry-After (default 30 s, clamped 1–120 s) | Keep. `Retry-After` is integer seconds [spec]. |
| 432 | rotate, disable `quota` until the next reset | Keep. The causes are plan limit, key limit, workspace limit, or workspace disabled [orgs]. Optionally parse the message to flag "workspace … disabled" as needing manual action. Tavily only advises against message parsing for 429s. |
| **433** | **non-retryable, returned to client** | **Rotate and mark `quota`.** PAYGO is exhausted for that account [spec]. |
| **434** | non-retryable, returned to client | Rotate to another account without penalizing this one (a paid account is not on the flex tier [ratelimits]). Otherwise return 434. pi-web-access never sets `max_age_hours`, so this is low priority. |
| 400 / 404 / 413 / 422 | non-retryable | Keep. Consider passing through Tavily's `detail.error` text, which contains no secrets, so clients can fix their query. |
| 5xx / network | rotate, 10 s cooldown | Keep, but see the double-billing note below. |

**Double-billing risk.** The default `attemptTimeoutMs` is 10 s, which is aggressive.

- Tavily's own SDKs default to 60 s for search.
- Advanced extract defaults to 30 s server-side.
- Advanced search and `include_raw_content` can be slow.

When the broker aborts locally and retries on another account, the first request may still complete and be billed upstream. Whether aborted or failed searches are billed is undocumented. Recommendations:

- Raise the search attempt timeout to about 30 s.
- On timeout, charge the estimate to the first account as "possibly spent" until `/usage` reconciliation.

### Headers to forward, set, or strip

- **Never forward client auth.** The gateway already builds fresh headers, which is good.
- **Strip `api_key` from the forwarded JSON body.**
  - Today the body is forwarded verbatim. A client that copies the official MCP habit of putting `api_key` in the body would send the **gateway token** to Tavily.
  - Whether Tavily prefers body `api_key` over the Bearer header is undocumented.
- **Never forward `X-Tavily-Access-Mode`.** Keyless mode would bypass the account pool.
- **Optional pass-through:** `X-Session-Id` and `X-Human-Id` are documented and harmless [headers].
- **Optional per-account `X-Project-ID` from config.** It tags broker traffic in Tavily's dashboard, `/logs`, and `/usage` [headers][usage]. Forward a client-supplied project ID only if it is known to be valid for the chosen account; cross-account validity is undocumented.
- **Optional `X-Client-Source: pi-search-broker`.** It is SDK convention and undocumented, so this is cosmetic.

### Other notes

- The 55 s `totalTimeoutMs` cap plus the 60 s pi-web-access client timeout is fine for search. It is not enough for crawl, map, or research.
- Monthly reset on UTC day 1 matches [faq] and [orgs] for monthly plans. Annual plans reset yearly unless the monthly-limits switch is on [orgs].
- Free accounts only have dev keys at 100 RPM each [ratelimits]. With N free accounts, the pool's aggregate ceiling is about N×100 RPM if limits are per key. Per-key versus per-account scope is undocumented.

---

## Sources

- [llms]: https://docs.tavily.com/llms.txt
- [spec]: https://docs.tavily.com/documentation/api-reference/openapi.json
- [headers]: https://docs.tavily.com/documentation/api-headers
- [credits]: https://docs.tavily.com/documentation/api-credits
- [ratelimits]: https://docs.tavily.com/documentation/rate-limits
- [usage]: https://docs.tavily.com/documentation/api-reference/endpoint/usage
- [streaming]: https://docs.tavily.com/documentation/api-reference/endpoint/research-streaming
- [keyless]: https://docs.tavily.com/documentation/keyless
- [bp-search]: https://docs.tavily.com/documentation/best-practices/best-practices-search
- [keymgmt]: https://docs.tavily.com/documentation/best-practices/api-key-management
- [changelog]: https://docs.tavily.com/changelog
- [faq]: https://docs.tavily.com/faq/faq
- [orgs]: https://docs.tavily.com/documentation/platform/managing-organizations
- [genkeys]: https://docs.tavily.com/documentation/enterprise/generate-keys
- [deactivate]: https://docs.tavily.com/documentation/enterprise/deactivate-keys
- [keyinfo]: https://docs.tavily.com/documentation/enterprise/key-info
- [x402]: https://docs.tavily.com/documentation/machine-payments/x402
- [py]: https://github.com/tavily-ai/tavily-python/blob/46505f119e6ac0f30d63a4dce0ed9f923705ad97/tavily/tavily.py (headers L82–91, error mapping L133–143, search params and timeout L168–240)
- [js]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/utils.ts (headers L16–40, timeouts L50 and L89)
- [js-params]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/parameters.ts
- [js-search]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/search.ts
- [js-errors]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/errors.ts
- [mcp]: https://github.com/tavily-ai/tavily-mcp/blob/ff166aa86e6dff08dea47d22fee4c9b8371ffec2/src/index.ts (headers L96–106, body `api_key` L733+, research polling and `research_stream_required` L788–860, SSE L863+)

[llms]: https://docs.tavily.com/llms.txt
[spec]: https://docs.tavily.com/documentation/api-reference/openapi.json
[headers]: https://docs.tavily.com/documentation/api-headers
[credits]: https://docs.tavily.com/documentation/api-credits
[ratelimits]: https://docs.tavily.com/documentation/rate-limits
[usage]: https://docs.tavily.com/documentation/api-reference/endpoint/usage
[streaming]: https://docs.tavily.com/documentation/api-reference/endpoint/research-streaming
[keyless]: https://docs.tavily.com/documentation/keyless
[bp-search]: https://docs.tavily.com/documentation/best-practices/best-practices-search
[keymgmt]: https://docs.tavily.com/documentation/best-practices/api-key-management
[changelog]: https://docs.tavily.com/changelog
[faq]: https://docs.tavily.com/faq/faq
[orgs]: https://docs.tavily.com/documentation/platform/managing-organizations
[genkeys]: https://docs.tavily.com/documentation/enterprise/generate-keys
[deactivate]: https://docs.tavily.com/documentation/enterprise/deactivate-keys
[keyinfo]: https://docs.tavily.com/documentation/enterprise/key-info
[x402]: https://docs.tavily.com/documentation/machine-payments/x402
[py]: https://github.com/tavily-ai/tavily-python/blob/46505f119e6ac0f30d63a4dce0ed9f923705ad97/tavily/tavily.py
[js]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/utils.ts
[js-params]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/parameters.ts
[js-search]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/search.ts
[js-errors]: https://github.com/tavily-ai/tavily-js/blob/7c75755eed04a1955478d23e876d90c441bc3721/src/errors.ts
[mcp]: https://github.com/tavily-ai/tavily-mcp/blob/ff166aa86e6dff08dea47d22fee4c9b8371ffec2/src/index.ts
