# Pi extension system: research notes for pi-search-broker

Researched against **pi-coding-agent 1.5.0** (local install) and **pi-web-access 0.47.0** (user install). Last checked: July 2026.

Path abbreviations used in citations:

| Alias | Path |
|---|---|
| `$PI` | `~/AppData/Local/nvm/v24.14.0/node_modules/@earendil-works/pi-coding-agent` |
| `$DOCS` | `$PI/docs` |
| `$EX` | `$PI/examples/extensions` |
| `$TYPES` | `$PI/dist/core/extensions/types.d.ts` (the public extension API types) |
| `$PWA` | `~/.pi/agent/npm/node_modules/pi-web-access` |
| `$AGENT` | `~/.pi/agent` (the pi agent directory) |

Every claim cites a source. Claims marked **[impl]** come from pi's compiled `dist/` source, not its documentation. They describe how pi 1.5.0 behaves but are not documented contracts, so a future release could change them. Claims marked **[inference]** are design conclusions I drew from the cited facts.

---

## TL;DR

1. **An extension can do everything the broker currently needs from the user by hand.**
   - Start and stop the gateway with the session: start it on `session_start`, stop it on an idempotent `session_shutdown` handler.
   - `pi.registerCommand("broker", …)` with argument completion.
   - `ctx.ui.setStatus("broker", "exa 42$ · tavily 1.7k")` shows remaining credits in the footer.
   - Optional `pi.registerTool(...)` for an LLM-visible status tool.
   - Ship it as a pi package (`"pi": { "extensions": [...] }`) installed with `pi install npm:…`, `git:…`, or a local path.

   Sources: `$DOCS/extensions.md` §Long-lived resources and shutdown (l.252), §pi.registerCommand (l.1735), §Widgets, Status, and Footer (l.2871); `$DOCS/packages.md`.
2. **Background servers are allowed, but pi does not manage them.** The docs require three things:
   - Do not start processes, sockets, or timers in the factory.
   - Start them on `session_start` or on first use.
   - Close them in `session_shutdown`.

   `session_shutdown` also fires on `/reload`, `/new`, `/resume`, and `/fork`, not only on quit. Pi has no process-wide "runtime shutdown" event. Sources: `$DOCS/extensions.md` l.252-256, the lifecycle diagram (l.366-391), and l.393; upstream issue earendil-works/pi#5687.
3. **Expect many extension instances.**
   - Each pi process loads its own copy of the extension.
   - In-process subagents (the user's `@tintinweb/pi-subagents` uses `createAgentSession` + `DefaultResourceLoader`) load **another** instance inside the same process, with its own `session_start` and `session_shutdown`.
   - So the broker needs a process-level singleton with reference counting, plus a machine-level single owner: a fixed port, a `/health` identity probe, and takeover when the owner dies. **[impl]**/**[inference]**
4. **Cross-extension interaction is limited.**
   - Pi gives you a shared untyped event bus (`pi.events`).
   - `tool_call` can block a call or change its input, including another extension's tool. `tool_result` can rewrite the result. `tool_execution_end` lets you observe every call.
   - **No documented API intercepts another extension's network calls.**
   - pi-web-access emits no `pi.events` and exposes no API.
   - The useful, documented hook is pi-web-access's own config: `EXA_BASE_URL`/`TAVILY_BASE_URL` environment variables override `exaBaseUrl`/`tavilyBaseUrl`, and both are read on every request. A broker extension in the same process can therefore point pi-web-access at itself by setting `process.env` before the first search, with no hand-merged JSON. Sources: `$PWA/README.md` l.731-737; `$PWA/exa.ts` l.84-92; `$PWA/tavily.ts` l.76-84.
5. **Security.**
   - Extensions run with full user permissions and are not sandboxed.
   - Project-level packages load only after project trust is granted (`trust.json`). Global installs need no trust prompt.
   - Pi has no generic secret store for extensions. `auth.json` is for model providers.
   - Keep real keys outside pi's config and session files. Support `$ENV` and `!command` key sources, never put keys in tool results or notifications, and optionally block `read`/`edit`/`write` of the broker config via `tool_call`.
6. **Recommendation: option (b).** Build a pi package whose extension embeds the existing zero-dependency gateway, using `createGateway()` already exported from `src/gateway.mjs`.
   - It runs in-process with a singleton, reference counting, and owner takeover.
   - It sets the pi-web-access base-URL environment variables at runtime.
   - It provides `/broker` and a footer status.
   - Keep the standalone CLI (option a) as a fallback.
   - Do not wrap `globalThis.fetch` (option c) except as an experiment.
   - A skill adds little; tool `promptGuidelines` cover agent guidance more cheaply.

---

## 1. Extension API reference

### 1.1 Entry point and factory

| Item | Exact definition | Source |
|---|---|---|
| Factory type | `export type ExtensionFactory = (pi: ExtensionAPI) => void \| Promise<void>;` | `$TYPES` l.1541 |
| Module shape | `export default function (pi: ExtensionAPI) { … }`. Can be async; pi awaits it before `session_start`. | `$DOCS/extensions.md` §Writing an Extension (l.186-213) |
| Loader | jiti, so TypeScript runs without a compile step. `.ts` or `.js` files. | `$DOCS/extensions.md` l.211 |
| Factory rule | "Extension factories may run in invocations that never start a session. Do not start background resources … from the factory." | `$DOCS/extensions.md` l.252-256 |
| Host imports | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`. Pi maps these to its own copies. Node built-ins are available too. | `$DOCS/extensions.md` §Available Imports (l.155-170) |
| Handler type | `type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R \| void> \| R \| void;` | `$TYPES` l.1205 |

### 1.2 Registration methods on `ExtensionAPI`

All signatures are copied from `$TYPES` l.1209-1430.

| Method | Signature | Notes |
|---|---|---|
| Event subscription | `on(event: "<name>", handler: ExtensionHandler<Event, Result>): () => void` | Returns an unsubscribe function. Handlers run in extension load order, then registration order. `$DOCS/extensions.md` l.1567-1578 |
| Tool | `registerTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): void` | Works after startup too, for example in `session_start` or a command. `$DOCS/extensions.md` l.1580-1590 |
| Command | `registerCommand(name: string, options: Omit<RegisteredCommand, "name" \| "sourceInfo">): void` | `RegisteredCommand` = `{ description?; getArgumentCompletions?: (prefix: string) => AutocompleteItem[] \| null \| Promise<…>; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }` (`$TYPES` l.1194-1200). When names collide, pi suffixes them as `/name:1`, `/name:2` (`$DOCS/extensions.md` l.1739). |
| Shortcut | `registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> \| void }): void` | `$DOCS/keybindings.md` |
| CLI flag | `registerFlag(name, { description?; type: "boolean"; default?: boolean } \| { description?; type: "string"; default?: string }): void` and `getFlag(name): boolean \| string \| undefined` | Read the value in `session_start`. In the factory you only get the default. `$DOCS/extensions.md` l.1862-1879 |
| Renderers | `registerMessageRenderer(customType, MessageRenderer)`, `registerEntryRenderer(customType, EntryRenderer)`, `registerToolRenderer(resolver: ToolRendererResolver)`, `registerMarkdownTransformer(MarkdownTransformer)` | `$TYPES` l.1273-1279 |
| Provider | `registerProvider(provider: Provider): void`, `registerProvider(name: string, config: ProviderConfig): void`, `unregisterProvider(name)` | For model providers. Not relevant to search APIs. `$DOCS/extensions.md` l.1958-2097 |
| Virtual model | `registerVirtualModel(model: ExtensionVirtualModel)`, `unregisterVirtualModel(provider, id)` | `$DOCS/virtual-models.md` |
| MCP server | `registerMcpServer(name, config: McpServerConfig)`, `unregisterMcpServer(name)`, `getMcpServers()` | Session-scoped and not persisted. `$DOCS/extensions.md` §MCP Servers (l.2780) |
| Messages | `sendMessage(message, { triggerTurn?, deliverAs?: "steer" \| "followUp" \| "nextTurn" })`, `sendUserMessage(content, { deliverAs?, expandPromptTemplates? })` | `$DOCS/extensions.md` l.1625-1679 |
| Session data | `appendEntry<T>(customType, data?)`: persisted in the session, never sent to the LLM. Also `setSessionName`, `getSessionName`, `setLabel`. | `$DOCS/extensions.md` l.1681-1733 |
| Process | `exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>` | `ExecOptions = { signal?, timeout?, cwd?, maxBuffer? }`; `ExecResult = { stdout, stderr, code, killed, truncated }` (`$PI/dist/core/exec.d.ts`). It waits for the command to finish, so it does **not** suit a long-lived server. |
| Tools state | `getActiveTools(): string[]`, `getAllTools(): ToolInfo[]`, `setActiveTools(names: string[])` | `ToolInfo` includes `sourceInfo`, `exposure`, and `annotations`. `$DOCS/extensions.md` l.1892-1922 |
| Settings | `getSettings(): Settings` | A copy of the merged settings. `$DOCS/extensions.md` l.2118 |
| Misc | `getCommands()`, `setModel()`, `getThinkingLevel()`, `setThinkingLevel()` | `$TYPES` |
| Event bus | `events: EventBus`, where `interface EventBus { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void }` | `$PI/dist/core/event-bus.d.ts`; `$DOCS/extensions.md` l.1949-1956 |

Important `ToolDefinition` fields (`$TYPES` l.472-536):

```ts
name: string; label: string; description: string;
promptSnippet?: string; promptGuidelines?: string[];
parameters: TParams; outputSchema?: TSchema;
exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
defaultActive?: boolean; executionMode?: "sequential" | "parallel";
prepareArguments?: (args: unknown) => Static<TParams>;
execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
        ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;
renderCall?(...); renderResult?(...); renderShell?: "default" | "self";
```

Tool results must contain `content` and `details`. Throw an error, or return `isError: true`, to signal failure (`$DOCS/extensions.md` l.2265-2275). Output must be truncated to 50 KB / 2000 lines (`$DOCS/extensions.md` §Output Truncation l.2431).

### 1.3 Events and lifecycle

Event names and result types come from `$TYPES` l.1210-1250. The behaviour notes come from `$DOCS/extensions.md` §Events (l.307-1160).

| Group | Event | Can return / effect | Relevance to the broker |
|---|---|---|---|
| Startup | `project_trust` | `{ trusted: "yes" \| "no" \| "undecided"; remember?: boolean }`. Only user/global and CLI extensions get it. | None |
| Resources | `resources_discover` | `{ skillPaths?, promptPaths?, themePaths? }`. Fired after `session_start`. | Could add a skill dynamically (`$EX/dynamic-resources/index.ts`) |
| Session | `session_start` | `reason: "startup" \| "reload" \| "new" \| "resume" \| "fork"`, `previousSessionFile?` | **Acquire the gateway, set status** |
| Session | `session_shutdown` | `reason: "quit" \| "reload" \| "new" \| "resume" \| "fork"`, `targetSessionFile?`. Pi awaits it **[impl]** (`$PI/dist/core/agent-session-runtime.js` `teardownCurrent`/`dispose`). | **Release the gateway** |
| Session | `session_before_switch` / `session_before_fork` / `session_before_compact` / `session_before_tree` | `{ cancel?: boolean, … }` | None |
| Session | `session_compact`, `session_compact_failed`, `session_tree`, `session_info_changed` | Notification only | None |
| Agent | `before_agent_start` | `{ message?, systemPrompt? }`. Can edit `event.systemPromptOptions` in place. | Could add a note such as "search budget low" |
| Agent | `agent_start`, `agent_end`, `agent_before_settle` (`{ entries?, continue? }`), `agent_settled` | `agent_settled` is the final idle signal | Refresh status when idle |
| Turn/message | `turn_start`, `turn_end`, `message_start/update/end`, `context`, `context_with_system` | Various | None |
| Provider (LLM only) | `before_provider_headers`, `before_provider_request`, `after_provider_response`, `provider_stream_event`, `cache_warming_decision` | These cover **model provider** HTTP only, not extension fetches | Not applicable to pi-web-access |
| Tools | `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Notification. `tool_execution_end` fires for every finalised call, including blocked ones. | **Refresh credits after `web_search`/`fetch_content`** |
| Tools | `tool_call` | `{ block?: boolean; reason?: string; terminate?: boolean }`. `event.input` is mutable, and other extensions' tools are included. | Ensure the gateway is up, block when everything is exhausted, steer `provider` |
| Tools | `tool_result` | `{ content?, details?, structuredContent?, isError?, usage? }` partial patch, chained | Optionally annotate results |
| Input | `input` | `{ action: "continue" } \| { action: "transform", text, images? } \| { action: "handled" }` | None |
| Bash | `user_bash` | `{ operations } \| { result }` | None |
| UI | `ui_prompt_start` / `ui_prompt_end` | Notification | None |
| Model | `model_select`, `thinking_level_select` | Notification | None |
| MCP | `mcp_servers_change` | Notification | None |

Lifecycle diagram (`$DOCS/extensions.md` l.366-393):

```
Process startup → project_trust → session_start → resources_discover
/new|/resume → session_before_switch → session_shutdown → (reload extension runtime) → session_start
/fork|/clone → session_before_fork  → session_shutdown → … → session_start
/reload      →                        session_shutdown → … → session_start(reason "reload")
exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM) → session_shutdown(reason "quit") → process exits
```

### 1.4 Context objects

Sources: `$TYPES` l.232-357 and `$DOCS/extensions.md` §ExtensionContext (l.1161-1316).

| Type | Members |
|---|---|
| `ExtensionContext` | `ui: ExtensionUIContext; mode: "tui" \| "rpc" \| "json" \| "print"; hasUI: boolean; cwd: string; sessionManager: ReadonlySessionManager; modelRegistry; model; scopedModels; thinkingLevel?; signal: AbortSignal \| undefined; isIdle(); isProjectTrusted(); abort(); hasPendingMessages(); shutdown(); getContextUsage(); compact(opts?); getSystemPrompt()` |
| `ExtensionToolContext` (inside tool `execute`) | Adds `readonly tools: readonly AgentTool[]; executeTool(name, args, options?): Promise<AgentToolCallOutcome>` |
| `ExtensionCommandContext` (inside command handlers) | Adds `getSystemPromptOptions(); waitForIdle(); newSession(); fork(); navigateTree(); switchSession(); reload()` |

### 1.5 UI API (`ctx.ui: ExtensionUIContext`)

Source: `$TYPES` l.83-215.

| Method | Signature | Use for the broker |
|---|---|---|
| Notification | `notify(message: string, type?: "info" \| "warning" \| "error"): void` | `/broker` feedback, "account X disabled (401)" |
| Footer status | `setStatus(key: string, text: string \| undefined): void` | **Remaining credits in the footer.** Pass `undefined` to clear. Example: `$EX/status-line.ts` |
| Widget | `setWidget(key, content: string[] \| undefined, options?: { placement?: "aboveEditor" \| "belowEditor" })`, or a component factory `(tui, theme) => Component` | A detailed per-account table, toggled on and off |
| Footer replace | `setFooter(factory \| undefined)`. The factory receives `footerData: ReadonlyFooterDataProvider` with `getExtensionStatuses()`, `getGitBranch()`, `onBranchChange()`. | Not recommended: it replaces the whole footer for every extension. `$EX/custom-footer.ts` |
| Dialogs | `select(title, options, opts?)`, `confirm(title, message, opts?)`, `input(title, placeholder?, opts?)`, `editor(title, prefill?)`; `opts = { signal?: AbortSignal; timeout?: number }` | `/broker` interactive mode. **`input` has no masked or secret mode.** |
| Custom | `custom<T>(factory(tui, theme, keybindings, done), { overlay?, overlayOptions?, onHandle?, blocked? }): Promise<T>` | Full TUI dashboard (`$DOCS/tui.md`) |
| Other | `setTitle`, `setWorkingMessage`, `setWorkingIndicator`, `setWorkingVisible`, `setHeader`, `setEditorText`/`getEditorText`/`pasteToEditor`, `addAutocompleteProvider`, `setEditorComponent`, `onTerminalInput`, `theme`, `getAllThemes`/`getTheme`/`setTheme`, `getToolsExpanded`/`setToolsExpanded` | None |

Behaviour by mode (`$DOCS/extensions.md` §Mode Behavior l.3240; `$DOCS/rpc-extension-ui.md`):

- In RPC mode, `notify`, `setStatus`, and `setWidget` are fire-and-forget. `setFooter` and `setHeader` do nothing.
- In print and JSON mode, `hasUI` is false and UI calls do nothing.
- Guard dialogs with `ctx.hasUI`.

### 1.6 Config and storage helpers

| Need | Pi facility | Source |
|---|---|---|
| Agent directory | `getAgentDir()` (exported). It respects `PI_CODING_AGENT_DIR`. | `$PI/dist/index.d.ts` l.2; `$DOCS/environment-variables.md` |
| Project config dir name | `CONFIG_DIR_NAME`. Use it instead of hard-coding `.pi`. | `$DOCS/extensions.md` l.1177-1193 |
| Project trust check | `ctx.isProjectTrusted()` before honouring project-local config | `$DOCS/extensions.md` l.1195-1199 |
| Per-session durable state | `pi.appendEntry(customType, data)`. Read it back via `ctx.sessionManager.getBranch()`. | `$DOCS/extensions.md` §State Management (l.2124-2162) |
| Effective settings | `pi.getSettings()` | `$DOCS/extensions.md` l.2118 |
| Extension-specific config file | No API. The convention is your own JSON file. pi-web-access uses `<agent-dir>/web-search.json`. | `$PWA/utils.ts` l.11-37 |
| Secrets | No API for extensions. `auth.json` holds model-provider credentials only. | §5 below |

Credit accounting is machine-wide, not per session, so it belongs in the broker's own `state.json`, not in session entries.

---

## 2. Packaging

### 2.1 The `pi` manifest in `package.json`

Source: `$DOCS/packages.md` §Create a package (l.46-78), §Declare dependencies (l.100-116).

```json
{
  "name": "pi-search-broker",
  "version": "0.2.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extension/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts/*.md"],
    "changelogPath": "./CHANGELOG.md"
  },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*", "typebox": "*" }
}
```

- Paths are relative to the package root. Arrays accept globs and `!exclusions`.
- Without a `pi` field, pi auto-discovers the `extensions/`, `skills/`, `prompts/`, and `themes/` directories.
- The `pi-package` keyword lists the package in the gallery at https://pi.dev/packages. Optional `pi.image` and `pi.video` add previews.
- Pi shows a changelog after updates for packages that load at least one extension. It reads `CHANGELOG.md` by default, or `pi.changelogPath` (`$DOCS/packages.md` §Show a changelog).
- Real-world example: pi-web-access declares `"pi": { "extensions": ["./dist"], "video": "…" }` and lists the host packages as `peerDependencies` (marked optional) (`$PWA/package.json`).

### 2.2 Dependencies

Source: `$DOCS/packages.md` §Declare dependencies; `$DOCS/extensions.md` l.166-170.

- Runtime imports belong in `dependencies`. `devDependencies` are **not** installed for npm or git sources.
- Do **not** put the host-provided packages (`@earendil-works/pi-ai`, `-agent-core`, `-coding-agent`, `-tui`, `typebox`) in `dependencies`. List them in `peerDependencies` with range `"*"`. Pi warns when it finds them in `dependencies`, because a second copy creates duplicate classes.
- Pi installs managed packages with `--legacy-peer-deps --no-audit --no-fund` (`$PI/dist/core/package-manager.js` `getNpmInstallArgs`). **[impl]**
- Installed packages have separate module roots. Do not rely on two packages sharing one dependency instance (`$DOCS/packages.md` l.116).
- The broker has **zero dependencies**, so it avoids this whole area. Pi's own `proper-lockfile` is not a host-provided module, so a lockfile would need to be hand-rolled (`fs.open(path, "wx")`) or declared as a dependency.

### 2.3 Sources and install flow

| Source | Example | Behaviour | Source |
|---|---|---|---|
| npm | `pi install npm:pi-search-broker@0.2.0` | Installed under `<agent-dir>/npm/` (a shared `package.json` and `node_modules`). Versioned specs are pinned. | `$DOCS/packages.md` §Choose a source; **[impl]** `getNpmInstallRoot()`. Observed: `$AGENT/npm/package.json` lists `pi-web-access`, `@tintinweb/pi-subagents`, … |
| git | `pi install git:github.com/<user>/pi-search-broker@v0.2.0` | Cloned to `<agent-dir>/git/…`. If a `package.json` exists, pi runs npm install inside the clone. | `$DOCS/packages.md`; **[impl]** `installGit()` |
| URL | `https://github.com/<user>/pi-search-broker` | Treated as git | `$DOCS/packages.md` |
| Local | `pi install ./pi-search-broker` | Loaded from that path **without copying, and dependencies are not installed** | `$DOCS/packages.md` l.42-44, l.110 |
| One-off | `pi -e npm:pi-search-broker` or `pi -e ./extension/index.ts` | Not written to settings. Cached under `<agent-dir>/tmp/extensions/`. | `$DOCS/packages.md` l.25-31 |

Package management commands (`$DOCS/cli.md` §Package commands, l.250-299):

- `pi list`, `pi remove <src>` (alias `uninstall`), `pi update --extensions`, `pi update <src>`, and `pi config` (enables or disables individual resources).
- If a configured package fails to install at startup, pi warns, skips it, and keeps running (`$DOCS/packages.md` l.21).

### 2.4 Global vs project scope

Source: `$DOCS/packages.md` l.19-23 and §Understand scope and identity (l.147-151); `$DOCS/settings.md` §Resources.

- `pi install` writes to `~/.pi/agent/settings.json` under `"packages"`. The user's file currently contains `"npm:@tintinweb/pi-subagents"`, `"npm:pi-web-access"`, and `"npm:@indexyz/pi-provider-sub2api"`.
- `pi install -l` writes to `.pi/settings.json` and installs to `.pi/npm` or `.pi/git`. These load **only after project trust**.
- When the same package appears in both scopes, the project entry wins. Package identity is the npm name, the git repo URL without the ref, or the absolute local path.
- Settings can filter a package's resources with the object form: `{ "source": "npm:…", "extensions": [...], "skills": [] }` (`$DOCS/packages.md` §Select package resources).
- **[inference]** The broker manages machine-wide quotas, so install it globally.

### 2.5 Other loading locations

Source: `$DOCS/extensions.md` §Extension Locations (l.123-153).

- Auto-discovered, one level deep: `~/.pi/agent/extensions/*.ts|*.js`, `…/*/index.ts`, and `…/*/package.json` with `pi.extensions`. The same layouts work under `.pi/extensions/` for a trusted project.
- `settings.json` can also list `"extensions": ["/abs/path.ts"]`.
- Only auto-discovered locations hot-reload with `/reload` (l.9).
- The user's `~/.pi/agent/extensions/` currently holds `orca-agent-status.ts`, `orca-prefill.ts`, and `orca-titlebar-spinner.ts`.

---

## 3. Lifecycle, background servers, multiple sessions

### 3.1 What the docs say

- "Do not start background resources such as processes, sockets, file watchers, or timers from the factory. Defer background resource startup until `session_start` or the command/tool/event that needs the resource. Register an idempotent `session_shutdown` handler…" (`$DOCS/extensions.md` l.252-256).
- The reason: commands like `pi list` and `pi update` load extensions but never start a session, and a socket opened in the factory kept them from exiting (earendil-works/pi#5687, closed with this doc change).
  - A maintainer noted: "We currently do not have a `runtime_shutdown` event, just a `session_shutdown` event."
- `session_shutdown` fires on quit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM), `/reload`, `/new`, `/resume`, and `/fork` (`$DOCS/extensions.md` l.393).
- `ctx.shutdown()` requests a graceful exit and emits `session_shutdown` first (l.1257-1273).
- Print mode (`-p`) now emits `session_shutdown(reason "quit")` through `runtimeHost.dispose()` **[impl]** (`$PI/dist/modes/print-mode.js`). Older releases did not, and leftover servers then hung `pi -p` (earendil-works/pi#2584; https://github.com/ndraiman/pi-cursor-provider/issues/6).
- Pi does **not** clean up an extension's children if the process is SIGKILLed or crashes. Upstream reports orphaned detached children (earendil-works/pi#3057).

### 3.2 Real-world precedent: pi-web-access already runs an HTTP server

- `curator-server.ts` calls `http.createServer(...)` and `server.listen(0, bind)`, so it uses an **ephemeral port** and avoids conflicts (`$PWA/curator-server.ts` l.368, l.703).
- `index.ts` closes the server from `session_shutdown` with `closeCurator()`, and also aborts pending fetches and clears widgets (`$PWA/index.ts` l.1422-1431).
- pi-web-access tracks `liveInstances` because "a host may run several at once (one instance per session)" (`$PWA/index.ts` l.743-746, l.811-814).

### 3.3 How many instances will run? **[impl]**

| Scenario | Effect on the broker extension |
|---|---|
| Two terminals running `pi` | Two Node processes, each with its own instance. Both try to bind the same fixed port, giving `EADDRINUSE`. |
| `/new`, `/resume`, `/fork` in the same cwd | Pi emits `session_shutdown`, re-runs the factory, then emits `session_start`. The module is reused from pi's extension cache (`extensionCache` keyed by path; `useExtensionCacheCwd`), so module-level variables survive (`$PI/dist/core/extensions/loader.js` l.89-104, l.465-494). |
| `/reload`, or a session that changes cwd | `clearExtensionCache()` runs and jiti uses `moduleCache: false`, so the module is **re-imported** and module-level state is lost. Only `globalThis` survives (`$PI/dist/core/resource-loader.js` l.370-374). |
| In-process subagents (`@tintinweb/pi-subagents`) | Each subagent creates a session via `createAgentSession` and `DefaultResourceLoader`, so the extension loads and runs again **in the same process** (`$AGENT/npm/node_modules/@tintinweb/pi-subagents/dist/agent-runner.js` l.7, l.734, l.1031). Its `session_shutdown` fires when the subagent ends. |
| `pi -p` / JSON / RPC runs | One short-lived session. `hasUI` is false in print and JSON mode. |

**[inference]** "Start on `session_start`, stop on `session_shutdown`" is wrong for a shared gateway on its own: a finishing subagent, or `/new`, would kill the gateway that the parent session is still using. The broker needs:

1. **A process-level singleton with reference counting.** Store `{ server, manager, refs, version }` under `globalThis[Symbol.for("pi-search-broker")]`.
   - Each instance increments `refs` on `session_start` and decrements it on `session_shutdown`.
   - The server closes when `refs` reaches 0.
   - Use `globalThis` rather than module scope because `/reload` re-imports the module.
   - Store a `version` so a reloaded, newer module can replace an older singleton.
2. **A machine-level single owner.** The README already says "Run only one gateway instance per machine", because `state.json` has a single writer (`README.md` §Security and accuracy limitations).
   - Keep the fixed port (default 19473).
   - On acquire: probe `GET /health`, which returns `{ ok: true, service: "pi-dual-key-manager" }` (`src/gateway.mjs` l.58-60). If a broker answers, run as a **client**. Otherwise call `listen()`. If that fails with `EADDRINUSE`, probe again.
3. **Takeover.** An in-process gateway dies with its owner pi process, so clients need to re-acquire. A good place is the `tool_call` handler for pi-web-access's search and fetch tools, which runs before every call and may be async (`$DOCS/extensions.md` l.971-1011). It can probe the gateway and become the owner if needed.
4. **Do not keep pi alive.** Call `server.unref()` on the server and on any timers, as the upstream workaround in #2584 suggests. Close the server explicitly in `session_shutdown` as well.

### 3.4 Child-process alternative

- `pi.exec` waits for the command to finish, so it cannot host a server (`$DOCS/extensions.md` l.1881-1890).
- A detached `child_process.spawn("node", ["src/cli.mjs", "serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref()` would outlive every pi process. That removes the need for takeover.
- The cost is an orphaned process with no owner. The gateway would need an idle timeout or heartbeat to exit on its own (earendil-works/pi#3057 shows how orphans pile up).
- On Windows, `detached` and process-tree kill behave differently. Pi itself uses `taskkill /F /T` (`$PI/dist/utils/shell.js` l.193).
- **[inference]** The in-process server plus takeover is simpler and leaves no orphans. The detached child only wins if the gateway must keep serving after every pi exits, for example for the standalone CLI.

### 3.5 Sketch: process singleton, documented lifecycle

The doc-backed parts are `session_start`/`session_shutdown`, `ctx.ui.setStatus`, and `ctx.hasUI`. The `globalThis` singleton is **[inference]**.

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireBroker, releaseBroker, formatCredits } from "../src/embed.mjs"; // to be written

export default function (pi: ExtensionAPI) {
  let held = false;                                  // per-instance, so release is idempotent
  const refresh = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("broker", formatCredits(await (await acquireBroker()).status()));
  };
  pi.on("session_start", async (_e, ctx) => {        // never in the factory
    if (!held) { await acquireBroker(); held = true; }   // refcount++ or client mode
    await refresh(ctx);
  });
  pi.on("tool_execution_end", async (e, ctx) => {
    if (e.toolName === "web_search" || e.toolName === "fetch_content") await refresh(ctx);
  });
  pi.on("session_shutdown", async () => {
    if (held) { held = false; await releaseBroker(); }   // close when refcount hits 0
  });
}
```

---

## 4. Interacting with other extensions (pi-web-access)

### 4.1 Mechanisms pi provides

| Mechanism | What it allows | Source |
|---|---|---|
| `pi.events` shared bus | Untyped `emit`/`on` on string channels, shared by all extensions loaded through one resource loader. Subscriptions are dropped when the runtime is invalidated (reload or session replacement). | `$DOCS/extensions.md` l.1949-1956; `$EX/event-bus.ts`; **[impl]** `$PI/dist/core/extensions/loader.js` l.110-165, l.421-430 |
| `tool_call` on any tool name | Block a call (`{ block, reason }`) or mutate `event.input` in place, for example force `provider: "exa"` on `web_search`. There is no re-validation after mutation. | `$DOCS/extensions.md` l.971-1011 |
| `tool_result` | Patch `content`, `details`, or `isError` of any tool's result. Chains like middleware. | `$DOCS/extensions.md` l.1038-1072 |
| `tool_execution_end` | Observe every finalised call: `toolName`, `result`, `isError`, `durationMs` | `$DOCS/extensions.md` l.788-813 |
| `pi.getAllTools()` | See another extension's tools and their `sourceInfo` | `$DOCS/extensions.md` l.1892-1922 |
| Re-registering a tool name | Allowed for **built-in** tools only. A clash between extensions is reported as a conflict diagnostic, and load order decides which wins. | `$DOCS/extensions.md` §Overriding Built-in Tools (l.2342); **[impl]** `$PI/dist/core/resource-loader.js` l.602-607, l.989-1022 |
| Calling another tool | `ctx.executeTool(name, args)` inside your own tool. It goes through the same hooks. | `$DOCS/extensions.md` §Calling Other Tools (l.2770) |
| Provider HTTP hooks | `before_provider_request` and similar fire **only for model provider requests**, not for an extension's `fetch()` | `$DOCS/extensions.md` l.846-908 |

**No documented API intercepts another extension's outbound HTTP.** pi-web-access emits nothing on `pi.events`. A grep of `$PWA/*.ts` for `pi.events` finds no matches. It also exports no API.

A good model for a richer cross-extension protocol is pi-subagents: it implements versioned RPC over `pi.events` (`subagents:rpc:*`) (`@tintinweb/pi-subagents/README.md` l.70-71).

### 4.2 Load order **[impl]**

- Pi documents only "Handlers run in extension load order, then registration order" (`$DOCS/extensions.md` l.414, l.1576).
- The observed order:
  1. CLI `-e` extensions.
  2. Packages, project scope then user scope, in the order they appear in `settings.json`.
  3. Explicit `extensions` entries from settings.
  4. Auto-discovered `extensions/` directories.
  5. Built-ins.

  Sources: `$PI/dist/core/package-manager.js` `resolve()` l.731-772; `resource-loader.js` `loadCurrentExtensionSet()` l.511-537.
- The broker must not depend on running before pi-web-access. The environment-variable approach below works in either order, because pi-web-access reads the environment on each request, not at load.

### 4.3 The practical hook: pi-web-access's documented gateway configuration

- **Base URLs.** "Environment variables take precedence over config", and the relevant variables are `EXA_BASE_URL` (paths `/search` and `/contents`) and `TAVILY_BASE_URL` (path `/search`) (`$PWA/README.md` l.731-737). Both are read on every call through `process.env` (`$PWA/exa.ts` l.84-92; `$PWA/tavily.ts` l.76-84). Loopback `http:` is allowed (`$PWA/utils.ts` l.79-99).
- **Keys.**
  - `exaApiKey` and `tavilyApiKey` in `web-search.json` take precedence over `EXA_API_KEY` and `TAVILY_API_KEY`.
  - They also accept `"$ENV_NAME"` and `"!command"` sources, resolved per request (`$PWA/credential-source.ts` l.202-242; `$PWA/README.md` l.714-729).
  - The Tavily key pool `TAVILY_API_KEY_1…20` takes priority and bypasses a gateway (`$PWA/tavily.ts` l.65-73; broker `README.md` step 4).
  - When there is no Exa key, pi-web-access may fall back to the Exa MCP endpoint `https://mcp.exa.ai/mcp`, which also bypasses the gateway (`$PWA/exa.ts` l.10, l.247).
- **[inference]** A broker extension in the same Node process can set these before the first search, so the user never merges a JSON fragment again:
  - `process.env.EXA_BASE_URL = "http://127.0.0.1:19473/exa"`
  - `process.env.TAVILY_BASE_URL = "http://127.0.0.1:19473/tavily"`
  - `process.env.PI_SEARCH_BROKER_TOKEN = token`

  `web-search.json` then only needs `"exaApiKey": "$PI_SEARCH_BROKER_TOKEN"` and `"tavilyApiKey": "$PI_SEARCH_BROKER_TOKEN"`, with no secret in the file. Alternatively, set `EXA_API_KEY`/`TAVILY_API_KEY` when the config has no key.
  - On startup, warn via `notify` if `TAVILY_API_KEY_n` is set, or if config keys point elsewhere.
- **Side effect.** Changing `process.env` leaks into children: pi's shell tools spawn with `{ ...process.env }` (`$PI/dist/utils/shell.js` l.155). LLM-run `bash` commands would see the gateway URL and token.
  - The token only reaches the loopback gateway, but it does let a process spend credits.
  - To limit exposure, use a dedicated variable name for the token and document the behaviour.
  - An alternative is to keep the token in `web-search.json` as today.

### 4.4 Wrapping `fetch` in-process (not documented)

- Pi installs undici's `fetch` as `globalThis.fetch` and keeps any later override "if a caller replaced fetch after module load" **[impl]** (`$PI/dist/core/http-dispatcher.js` l.85-96).
- pi-web-access calls the global `fetch` for Exa and Tavily (`fetchWithCredentialRedirects`, `$PWA/utils.ts` l.137-149). Only `gemini-web.ts` uses its own undici agent.
- An extension could therefore wrap `globalThis.fetch` and handle `https://api.exa.ai/*` and `https://api.tavily.com/*` in-process, with no port or token.
- This is a process-wide monkey-patch and no pi or pi-web-access doc supports it. See option (c) in §6.

---

## 5. Security model and secrets

### 5.1 Trust model

Sources: `$DOCS/security.md`; `$DOCS/extensions.md` l.5-7 and l.125.

- Extensions run inside the pi process with the user's full OS permissions. They can read prompts, tool calls, files, credentials, and session history. Pi has no sandbox.
- **Project trust** controls whether these load: `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`, and project `.agents/skills`. That includes project-scoped packages, which install only after trust (`$DOCS/security.md` §Resources protected by project trust, l.35-57).
- **Global packages and `~/.pi/agent/extensions` need no trust prompt.**
- Pi resolves trust in this order (`$DOCS/security.md` l.59-73):
  1. A CLI override (`--approve` / `--no-approve`).
  2. A user/global extension's `project_trust` handler.
  3. A saved decision in `~/.pi/agent/trust.json`. The file maps canonical directory paths to `true`/`false` (observed in `$AGENT/trust.json`), and `/trust` writes to it.
  4. The `defaultProjectTrust` setting (`"ask"`, `"always"`, or `"never"`).

  Without a UI, `"ask"` declines.
- Context files (`AGENTS.md`) load regardless of trust (`$DOCS/security.md` l.57).

### 5.2 Secrets: what pi offers and what it does not

| Facility | Scope | Notes |
|---|---|---|
| `~/.pi/agent/auth.json` | **Model providers** (`/login`) | API keys and OAuth tokens. Supports `"key": "!command"`, which pi runs once and caches for the process lifetime (`$DOCS/providers.md` l.12-18, l.71-84). `readStoredCredential(providerId)` is exported (`$PI/dist/core/auth-storage.d.ts` l.70), but using it for non-provider secrets is undocumented. |
| `$ENV` and `!command` value syntax | `models.json` keys and headers, `mcp.json` `env`/`headers` | `$DOCS/models.md` l.65; `$DOCS/mcp.md` §Configuration rules |
| Provider `auth.apiKey.login(interaction)` with `interaction.prompt({ type: "secret" })` | Providers registered via `pi.registerProvider` | `$DOCS/extensions.md` l.1990-2007. Only for the model `/login` flow. |
| `ctx.ui.input()` | Any extension | No masking option (`$TYPES` l.89). A masked prompt needs `ctx.ui.custom()`. |

**No generic extension secret store exists.** Recommended handling, drawn from `$DOCS/security.md` §Reduce impact and the broker README:

1. Keep provider keys in the broker's own `config.json`, outside the pi agent directory and every project. On POSIX, use mode 0600.
   - On Windows `chmod` has little effect. Rely on the user-profile ACL and document it. **[inference]**
2. Let each account `apiKey` accept `"$ENV"` and `"!command"`, mirroring pi's and pi-web-access's conventions. Keys can then come from a password manager and never touch disk.
3. Never put keys or the gateway token in tool results, `notify` text, `appendEntry` data, or status text. **Session files persist all of these** and may be exported or shared (`$DOCS/security.md` l.93; `$DOCS/slash-commands.md` §Export and share).
4. Optionally add a `tool_call` gate that blocks `read`, `edit`, and `write` of the broker config path, as in `$EX/protected-paths.ts`. This is best-effort only: `bash` can still `cat` the file, and security.md says watching or gating is not a boundary.
5. Keep the gateway on loopback with its token check (`src/gateway.mjs` `isAuthorized`).

---

## 6. Agent-facing features: subagents, skills, prompt templates

- **Subagents** are not built into pi ("skips features like sub-agents", https://pi.dev). They come from the example `$EX/subagent/` (spawns separate `pi` processes) or packages such as `@tintinweb/pi-subagents` (in-process sessions; see §3.3).
  - Either way the broker extension loads once per subagent, which is the main reason it needs a singleton.
  - Subagent sessions usually have no UI, so guard calls with `ctx.hasUI`.
- **Skills** are directories with a `SKILL.md`. Only the name and description go into the system prompt; the model loads the full text on demand, or the user runs `/skill:name` (`$DOCS/skills.md`).
  - A package can ship skills via `pi.skills`, or add them at runtime via `resources_discover`.
- **Prompt templates** are Markdown files that become `/name` commands with `$1` and `$@` arguments (`$DOCS/prompt-templates.md`).
- **[inference] Would a skill help?** Only a little.
  - The model cannot run `/broker`. If the agent should know its budget, a small **tool** (`search_broker_status`, read-only, returns remaining credits per provider) with `promptGuidelines` is the cheaper mechanism. Guidelines are injected only while the tool is active (`$DOCS/extensions.md` l.1588, l.2170).
  - `tool_call` can steer or block `web_search` when a provider is exhausted, with no prompt engineering at all.
  - A skill is worth adding only for agent-assisted **setup and troubleshooting**. It would explain how to add an account without pasting keys into chat, what `set-spent` means, and how to read 402/429 states. The quickstart table says to start with the least powerful mechanism that works (`$DOCS/quickstart.md` l.106-118).

---

## 7. Design options for pi-search-broker

### (a) Keep the standalone gateway (status quo plus small improvements)

The user runs `npm start` in a terminal, merges `web-search.fragment.json` by hand, and checks status with `npm run status` (broker `README.md`).

**Pros**
- Already built and tested. No pi coupling, works with any pi-web-access host (including its MCP CLI), and survives pi restarts.
- A single process owns `state.json`, so accounting stays consistent.

**Cons**
- Every manual step remains: a second terminal, a JSON merge, a separate status CLI.
- Searches fail while the gateway is down.
- The `exaApiKey`/`tavilyApiKey` token sits in `web-search.json`.
- No visibility inside pi.

**Cheap improvements, no pi API needed:**
- Document the `"$NAME"` key syntax so `web-search.json` holds `"exaApiKey": "$PI_SEARCH_BROKER_TOKEN"` instead of the token (`$PWA/README.md` l.714-729).
- Make `/health` report version and pid.

### (b) A pi package whose extension manages the gateway, plus `/broker` and a status line (recommended)

How it works:

- An `extension/index.ts` imports the existing `createGateway()` (`src/gateway.mjs` l.51, which returns `{ server, manager }` without listening).
- The extension does the following:
  1. **Lifecycle.** On `session_start`, acquire a reference-counted `globalThis` singleton. Probe `/health` on the fixed port and run as a client if another process owns it. Otherwise `listen` on loopback and call `server.unref()`. On `session_shutdown`, release the reference and close the server at zero. Re-acquire on demand from `tool_call` for takeover (§3.3).
  2. **Wiring.** Set `process.env.EXA_BASE_URL`, `TAVILY_BASE_URL`, and the token variable (§4.3). Warn via `ctx.ui.notify` about bypasses: `TAVILY_API_KEY_n`, a direct `exaBaseUrl` in config, or a missing Exa key that triggers the MCP fallback.
  3. **`/broker` command.**
     - Subcommands: `status | enable <id> | disable <id> | set-spent <id> <allocation> <amount> | widget`.
     - `getArgumentCompletions` supplies subcommands and account ids.
     - In client mode the command uses the existing `/admin/*` and `/status` endpoints. As owner it calls the manager directly.
     - `status` can open `ctx.ui.select` or `ctx.ui.custom` when `ctx.mode === "tui"`.
  4. **Status.** Call `ctx.ui.setStatus("broker", …)` on `session_start`, `tool_execution_end` (for the pi-web-access tool names), and `agent_settled`. Use `setWidget` for an optional per-account table. Never use `setFooter`.
  5. **Optional:** a `search_broker_status` tool, `exposure: "direct"`, with `promptGuidelines`. A `--no-broker` flag via `registerFlag`. A `tool_call` gate that blocks reads of the config file.
- Package it as in §2.1 and install it with `pi install npm:…`, `git:…`, or `./path` for development. Keep `src/cli.mjs` working for headless use.

**Pros**
- Starts automatically, needs no manual JSON merge, and shows status and commands inside pi.
- Uses only documented extension APIs, apart from the `globalThis` singleton and `process.env`, which are plain Node.
- Zero dependencies, so there are no packaging pitfalls (§2.2).
- The in-process server dies with pi, so it cannot leave orphans.

**Cons**
- Concurrency logic is real work: reference counting, owner election, and takeover.
- When the owner pi exits, other sessions wait for the next `tool_call` to take over. The pi-web-access request already in flight fails, and pi-web-access's `searchRouting` fallback across providers softens this.
- `process.env` changes leak into LLM shell commands (§4.3).
- The extension depends on pi-web-access's environment-variable contract. It is documented in its README, so drift risk is low.
- Each subagent instance runs the factory again, so keep the factory cheap and side-effect free.

### (c) In-process interception: wrap `globalThis.fetch` instead of running a server

How it works: the extension replaces `globalThis.fetch` with a wrapper. The wrapper sends `https://api.exa.ai/{search,contents}` and `https://api.tavily.com/search` to the broker's request handler, with key rotation and accounting, and passes everything else to the original `fetch`. The gateway's own upstream calls must use the captured original `fetch` to avoid recursion.

**Pros**
- No port, no token, no `web-search.json` changes beyond a placeholder key, and no takeover problem inside one process.

**Cons**
- **Not documented**: pi offers no hook for extension network calls (§4.1). The approach relies on pi's internal "preserve a deliberate fetch override" logic **[impl]** (`$PI/dist/core/http-dispatcher.js` l.89-96) and on pi-web-access calling the global `fetch` (an implementation detail; `gemini-web.ts` already does not).
- Process-wide: every extension's and pi's own `fetch` calls go through the wrapper. A bug there affects LLM traffic too.
- pi-web-access still needs some Exa or Tavily key, or it takes the Exa MCP path, which the wrapper would not catch (§4.3).
- Accounting across processes still needs a shared, locked `state.json`, because each pi process would hold its own manager. That reintroduces the cross-process coordination that a single owner avoids.
- Wrappers stack badly across `/reload` because the old module's wrapper stays installed, so a `globalThis` guard is required.
- Harder to test, and the existing HTTP gateway tests would no longer cover the production path.

### Comparison

| Criterion | (a) Standalone | (b) Managed extension | (c) fetch interception |
|---|---|---|---|
| Manual steps for the user | Many | `pi install` + one-time account config | `pi install` + config |
| Uses documented pi APIs | n/a | Yes (lifecycle, commands, UI, tool hooks) | No (monkey-patch) |
| Depends on pi-web-access internals | Documented base URL config | Documented environment variables | Global `fetch` usage (undocumented) |
| Multi-session or multi-process safety | Single owner by design | Needs refcount + owner election | Needs a cross-process state lock |
| Visibility in pi | None | Footer status, `/broker`, optional tool | Same as (b) if added |
| Failure blast radius | Search only | Search only | All HTTP in the pi process |
| Implementation effort | None | Medium | Medium-high, fragile |

### Recommendation

Build **(b)**, reusing the existing `createGateway`/`AccountManager` unchanged as the engine, and keep **(a)**'s CLI as the headless and fallback path.

1. Add `package.json` `"pi": { "extensions": ["./extension/index.ts"] }` with `peerDependencies` on the host packages.
2. Implement acquire/release with a `globalThis` refcount and a `/health`-probing owner election on the fixed port. Re-acquire inside `tool_call` for pi-web-access tool names. Use `server.unref()` and an idempotent `session_shutdown`.
3. Set `EXA_BASE_URL`, `TAVILY_BASE_URL`, and a dedicated token variable at `session_start`. Detect and warn about bypass configurations.
4. Ship `/broker` with completions, plus `setStatus` and an optional widget. Defer the LLM tool and any skill until there is a real need.
5. Keep keys in the broker config, with `$ENV` and `!command` support, and never in pi session data.

Skip (c) unless a later spike proves the stability of the `fetch` override across pi releases is worth the risk.
