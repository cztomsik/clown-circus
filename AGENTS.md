# Clown-Circus Project Context

## Available System Tools

- **node** — v24.14.1 (`/Users/cztomsik/.nvm/versions/node/v24.14.1/bin/node`). Use `node -e 'console.log(2+2)'` for quick computations/evaluations.
- **python3** — `/usr/bin/python3` (3.9.6). Use `python3 -c 'print(2+2)'`.
- **uv** — `/Users/cztomsik/.local/bin/uv` (Python package manager).
- **rg** (ripgrep) — `/opt/homebrew/bin/rg` (v15.2.0). Use `rg -o '^\s*(const|class|function|async)\s+\w+' src` for quick code navigation.
- **jq** — `/opt/homebrew/bin/jq` (JSON processing).
- **curl** — `/usr/bin/curl` (HTTP requests). `wget` is **not** installed.

## Project Overview

**Clown-Circus** is a **headless, multi-session** agent server, exposed as an **Express** HTTP app. It runs any number of independent agent **sessions** — each with its own working directory, conversation state, and running agent loop — driven over **REST + Server-Sent Events (SSE)**. All sessions and their conversation snapshots persist in a local **SQLite** file, so state survives restarts.

- **Tech stack**: Node.js 24.x. The **server** is TypeScript (`.ts`, ESM, `"type": "module"`) that Node runs directly via its built-in type stripping (no build step); the **web UI** is Preact **JSX (`.tsx`)** modules that esbuild bundles at startup (the only build step). `tsc` is a **dev-only, check-only** dependency (`tsc --noEmit`, see below) — it is never run or emitted.
- **Run command**: `node src/main.ts` (or `npm start`). esbuild bundles the web UI automatically at startup; type-check via `npm run typecheck`.
- **Dependency**: `express` (v5) for the server, `esbuild` for bundling the web UI at startup, plus the web UI's browser libraries (`preact`, `marked`, `dompurify`, `@tailwindcss/browser`) as runtime deps — esbuild inlines them all into `webui/vendor/bundle.js` from `node_modules` so the UI works offline (no CDN, no `node_modules` static mounts). Dev deps (check-only, never emitted): `typescript`, `@types/node`. Everything else — SQLite, crypto, http, child_process — is built into Node.
- **Storage**: builtin **`node:sqlite`** (`DatabaseSync`), single file `~/.clowndb` by default. Emits a harmless `ExperimentalWarning`.
- **LLM**: OpenAI-compatible `/v1/chat/completions` (llama.cpp by default). Base URL from `--base-url`/`CLOWN_API` (default `http://127.0.0.1:8080`); optional `CLOWN_API_KEY` sent as Bearer.
- **Spec**: the authoritative spec is [`SPEC.md`](SPEC.md) (~20 sections); `SPEC.md` and this repo's code are the source of truth.
- **Web UI**: a first-class feature, described authoritatively in [`WEB_UI.md`](WEB_UI.md). A thin `webui/index.html` shell (Tailwind v4 via the `@tailwindcss/browser` JIT, `@theme` tokens) plus small **Preact JSX (`.tsx`)** modules, esbuild-bundled at startup into `webui/vendor/bundle.js` (served at `/vendor/bundle.js`) — `app.tsx` is the root component (all state + side effects), with `Header/Sidebar/Main/Message/InputBar/Todos/toolcall.tsx` for the components and `api/util/image/ui/md.js` for the API client, pure helpers, image helpers, shared class tokens, and the Markdown component (full list in the Source Structure table). Pure client of the REST + SSE API: project-grouped session sidebar, model picker (`GET /models`), session-level header actions (open-in-vscode, archive, delete) + composer slash commands (retry, init, compact, undo, clear, etc.), live chat over SSE, todos panel.

## Source Structure

The tree is deliberately flat: one file per concern, no per-feature subdirectories. `src/skills/` is the only subdirectory.

| File | Purpose |
|------|---------|
| `src/main.ts` | Bootstrap: wire the import-time config/db/llm/tools singletons → create SessionManager → build Express app → listen + SIGINT/SIGTERM shutdown. |
| `src/config.ts` | Resolve config from CLI flags with env fallbacks, then defaults (`port`, `host`, `dbFile`, `baseUrl`, `model`, `timeoutMs`, `verbose`). |
| `src/app.ts` | Express app factory: all REST routes, the SSE endpoint, 404 fallback, and the error-mapping middleware. |
| `src/db.ts` | Thin `node:sqlite` wrapper: opens/migrates the DB (idempotent DDL + `user_version`) and exposes the helpers the manager/session use — `upsert`, `all` (startup load), `deleteRow`, `close`. Listing + project grouping are done in memory by the manager, not in SQL. |
| `src/manager.ts` | `SessionManager` registry: loads all sessions from the DB at startup (resetting `running`/`stopped` → `idle`), owns create/list/get/delete and the in-memory hot state. |
| `src/session.ts` | `Session`. Owns messages/todos/tokens, the single-flight `running` flag, an `AbortController`, an `EventEmitter` (SSE source) with a bounded seq ring buffer, and all operations (`send/retry/retryTurn/undo/clear/trim/compact/init/stop/destroy`) + persistence. |
| `src/loop.ts` | `runLoop` — the agent loop: `next()` → execute tool calls → emit snapshot → repeat; converts every outcome to a terminal status and never throws. |
| `src/llm.ts` | OpenAI-compatible chat client: `chat()` + `listModels()`. Distinguishes stop-abort from timeout (504) / network-HTTP (502) via `LlmError.kind`. |
| `src/prompt.ts` | `buildSystemPrompt(cwd)`: `PREFIX.md` + `AGENTS.md`→`CLOWN.md` fallback (1MB cap) + date + realpath. |
| `src/tools.ts` | All tools + `tools`/`toolSchemas` singletons. Relative paths resolve against the session cwd (no path sandbox). |
| `src/errors.ts` | `HttpError` + `mapError()` (thrown errors → the §7.6 status/code table). Small module added to keep the import graph cycle-free. |
| `src/PREFIX.md` | Base system prompt with guidelines. |
| `src/skills/init.md` | Built-in `/init` skill: explore the project and write an `AGENTS.md`. |
| `webui/index.html` | Web UI shell served at `/`. Thin page: Tailwind v4 `@theme` tokens + a `<style type="text/tailwindcss">` block, a `#root` mount, and `<script type="module" src="/vendor/bundle.js">` — no static UI markup. |
| `webui/app.tsx` | Root Preact component (bundle entry): owns all state + side effects (config/models fetch, 10s poll, SSE, per-session drafts, actions) and composes the layout. |
| `webui/Header.tsx` | Unified top bar: sidebar toggle, session status, model picker, theme toggle, and the ⋮ actions menu (open-in-vscode/archive/delete; open-in-vscode is a client-side `vscode://` URI, not a REST call). |
| `webui/Sidebar.tsx` | Project-grouped session list + new-session form + the "show archived" toggle. |
| `webui/Main.tsx` | Right-hand pane composition (error banner, todos, transcript, composer). |
| `webui/Message.tsx` | Transcript rendering: user/assistant/tool blocks, collapsible tool-call pairs, reasoning. |
| `webui/toolcall.tsx` | Per-tool argument views (collapsible tool-call bodies) + the collapsed-summary title. |
| `webui/InputBar.tsx` | Composer: textarea, send/stop, slash commands, image attachments (paste + drag). |
| `webui/Todos.tsx` | Floating collapsible todo panel. |
| `webui/api.js` | REST + SSE client helpers (no Preact/DOM). |
| `webui/util.js` | Pure helpers (no DOM/Preact): baseName, parseCommand, modelId, isVisionModel, reasoningText, timeAgo, prettyArgs, parseArgs, parseTodos, extractTodos. |
| `webui/image.js` | Client-side image helpers (FileReader read, canvas downscale). |
| `webui/md.js` | Markdown component (marked + DOMPurify → `dangerouslySetInnerHTML`); the sole `dangerouslySetInnerHTML` in the UI. |
| `webui/ui.js` | Shared Tailwind class tokens (`BTN`, `PRE`). |
| `WEB_UI.md` | Authoritative description of the web UI: features, constraints/invariants, and current gaps (it is a scoped feature, expected to grow). |

## Architecture Notes

- **Concurrency**: the agent loop is a plain `async` function on the event loop. A single-flight `running` flag per session rejects overlapping runs with `409 session_busy`. `stop` sets an `AbortController` (checked between turns and to abort the in-flight LLM `fetch` / `run_command` child).
- **Persistence**: the SQLite DB is the **system of record** — a one-row upsert on every transition (create, message, tool result, status change, error, delete), not an optional autosave. On restart, `running`/`stopped` sessions reset to `idle` (an in-flight loop can't survive).
- **Snapshot**: the `snapshot` column stores `{ messages, total_tokens }` — the internal conversation format, persisted per session (the todo list is *not* stored — the web UI derives it from the last `write_todos` tool call in `messages`). It may evolve freely as the tool grows.
- **Tools & paths**: every file/shell tool resolves relative paths against the session `cwd` (the `run_command` working dir); there is **no path sandbox**, so the agent can reach any path the server process can. Tool errors are returned to the model as text (loop continues).
- **SSE**: one `text/event-stream` per session. Events: `snapshot`, `status`, `error`, `done`, `pong`. Each carries a monotonic `id:` (seq); reconnect with `?since=<seq>` / `Last-Event-ID` to replay (bounded ring buffer). 15s `: keep-alive` heartbeat.
- **Agent-loop detail**: `next()` makes one LLM call with `messages` + tool schemas (`max_completion_tokens: 32768`), retries up to once on an empty choice, appends the assistant message, and returns `tool_calls`; the loop ends when a turn has no tool calls. `total_tokens` is the last response's `usage.total_tokens`.
- **Error mapping**: LLM timeout → `504 llm_timeout`; unreachable/HTTP error → `502 llm_unavailable`; unknown id → `404`; busy → `409`; malformed/missing `cwd` → `400`; bad `cwd` dir + unhandled → `500`.

## Working conventions

- **Type-check**: `npm run typecheck` (i.e. `tsc --noEmit`, config in `tsconfig.json`: `checkJs`+`allowJs`+`noEmit`+`allowImportingTsExtensions`, `strict:false`, `types:["node"]`). `src/` is `.ts` (type-checked directly); `webui/` mixes `.js`+`.tsx` (checked via `checkJs`/`allowJs`). Dev deps `typescript`/`@types/node` are check-only — never emitted (the web UI's libraries are runtime deps that esbuild bundles into `webui/vendor/bundle.js`, and which `tsc` resolves for the bare imports in `webui/*.{js,tsx}`). **Current state: clean** — both `src/` and `webui/` pass with no errors (the SSE `onmessage` handler is cast to `MessageEvent` in `webui/api.js`).
- **No test framework.** Verify by running the server and exercising the API (e.g. `node src/main.ts --port 8899 --db-file /tmp/x.clowndb`, then `curl`). Keep the default DB `~/.clowndb` clean by using a throwaway `--db-file` during dev.
- **Config precedence**: CLI flag > env var > default.
- **Localhost by default** (`127.0.0.1`), no auth — single-user local tool.

## Code Style

House style for the codebase — modern, idiomatic, **terse** TypeScript
(server `.ts`) and JavaScript/JSX (web UI). These are conventions, not
lint-enforced. Keep the code clean under `npm run typecheck` (`tsc --noEmit`)
even though it is not lint-gated.

- **Modules**: ESM `import`/`export` only. No `require`/`module.exports`.
- **Exports**: one named export per module, imported by name. No `export default`
  for our own modules (a default import is only for CJS externals like `express`).
- **Async**: `async`/`await` throughout. No manual `.then()` chains.
- **Functions**: arrow functions assigned to `const`, not `function` declarations.
- **DRY**: when a block repeats in 2+ places, lift it into a named helper rather
  than copy-pasting the block.
- **Bindings**: `const` by default, `let` only when reassigned, never `var`.
- **Terse**: minimal ceremony. Prefer early returns, spread, optional chaining,
  and template literals over verbose constructs. No abstractions that add no
  behavior.

Prefer:

```js
const readFile = async (io, ctx, args) => {
  const text = await fs.readFile(resolve(ctx.cwd, args.path), 'utf8');
  return args.raw ? text : text.split('\n').map((l, i) => `${i + 1}:${l}`).join('\n');
};
```

Not:

```js
function readFile(io, ctx, args) {
  return fs.readFile(resolve(ctx.cwd, args.path), 'utf8').then((text) => {
    if (args.raw) return text;
    let out = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) out += i + 1 + ':' + lines[i] + '\n';
    return out;
  });
}
```
