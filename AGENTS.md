# Clown-Circus Project Context

## Available System Tools

- **node** — v24.14.1 (`/Users/cztomsik/.nvm/versions/node/v24.14.1/bin/node`). Use `node -e 'console.log(2+2)'` for quick computations/evaluations.
- **python3** — `/usr/bin/python3` (3.9.6). Use `python3 -c 'print(2+2)'`.
- **uv** — `/Users/cztomsik/.local/bin/uv` (Python package manager).
- **rg** (ripgrep) — `/opt/homebrew/bin/rg` (v15.2.0). Use `rg -o '^\s*(const|class|function|async)\s+\w+' src` for quick code navigation.
- **jq** — `/opt/homebrew/bin/jq` (JSON processing).
- **curl** — `/usr/bin/curl` (HTTP requests). `wget` is **not** installed.

## Project Overview

**Clown-Circus** is a **headless, multi-session** port of [`clown-code`](../clown-code/) (Zig + tokamak TUI), exposed as an **Express** HTTP server. Instead of a single terminal TUI bound to one conversation, it runs any number of independent agent **sessions** — each with its own working directory, conversation state, and running agent loop — driven over **REST + Server-Sent Events (SSE)**. All sessions and their conversation snapshots persist in a local **SQLite** file, so state survives restarts.

- **Tech stack**: Node.js 24.x, plain JavaScript (ESM, `"type": "module"`), no build step. TypeScript is a **dev-only, check-only** dependency (`tsc --noEmit`, see below) — it is never run or emitted.
- **Run command**: `node src/main.js` (or `npm start`). No build/test toolchain; type-check via `npm run typecheck`.
- **Dependency**: `express` only (v5) at runtime. Dev deps (check-only, never emitted): `typescript`, `@types/node`, `preact`, `htm` — the latter two are installed purely for type declarations; the web UI still loads Preact/htm from the CDN import map. Everything else — SQLite, crypto, http, child_process — is built into Node.
- **Storage**: builtin **`node:sqlite`** (`DatabaseSync`), single file `~/.clowndb` by default. Emits a harmless `ExperimentalWarning`.
- **LLM**: OpenAI-compatible `/v1/chat/completions` (llama.cpp by default). Base URL from `--base-url`/`CLOWN_API` (default `http://127.0.0.1:8080`); optional `CLOWN_API_KEY` sent as Bearer.
- **Spec**: the authoritative spec is [`SPEC.md`](SPEC.md) (~20 sections). Behavior is ported faithfully from `../clown-code/src/`.
- **Web UI**: a first-class feature, described authoritatively in [`WEB_UI.md`](WEB_UI.md). Two static files served at `/` — a thin `webui/index.html` shell (Tailwind v4 Play CDN, `@theme` tokens) plus `webui/app.js`, the whole UI as a **Preact + htm** ES module (import-map → esm.sh). Pure client of the REST + SSE API: project-grouped session sidebar, model picker (`GET /models`), full control toolbar (retry, init, compact, undo, clear-tools, clear, delete, stop, send), live chat over SSE, todos panel.

## Source Structure

The tree is deliberately flat: one file per concern, no per-feature subdirectories. `src/skills/` is the only subdirectory (mirrors the source).

| File | Purpose |
|------|---------|
| `src/main.js` | Bootstrap: parse config → open DB → build LLM client + tools → create SessionManager → build Express app → listen + SIGINT/SIGTERM shutdown. |
| `src/config.js` | Resolve config from CLI flags with env fallbacks, then defaults (`port`, `host`, `dbFile`, `baseUrl`, `model`, `timeoutMs`, `maxSessions`, `verbose`). |
| `src/app.js` | Express app factory: all REST routes, the SSE endpoint, 404 fallback, and the error-mapping middleware. |
| `src/db.js` | Thin `node:sqlite` wrapper: opens/migrates the DB (idempotent DDL + `user_version`) and exposes `upsert/get/list/all/projects/deleteRow`. |
| `src/manager.js` | `SessionManager` registry: loads all sessions from the DB at startup (resetting `running`/`stopped` → `idle`), owns create/list/get/delete and the in-memory hot state. |
| `src/session.js` | `Session` — the port of the `Clown` struct (`model.zig`). Owns messages/todos/tokens, the single-flight `running` flag, an `AbortController`, an `EventEmitter` (SSE source) with a bounded seq ring buffer, and all operations (`send/retry/undo/clear/clearTools/compact/stop/destroy`) + persistence. |
| `src/loop.js` | `runLoop` — the agent loop (port of `workerInner`): `next()` → execute tool calls → emit snapshot → repeat; converts every outcome to a terminal status and never throws. |
| `src/llm.js` | OpenAI-compatible chat client: `chat()` + `listModels()`. Distinguishes stop-abort from timeout (504) / network-HTTP (502) via `LlmError.kind`. |
| `src/prompt.js` | `buildSystemPrompt(cwd)`: `PREFIX.md` + `AGENTS.md`→`CLOWN.md` fallback (1MB cap) + date + realpath (port of `loadSystemPrompt`). |
| `src/tools.js` | All tools + `buildTools()`/`toolSchemas()`. Path-sandboxed to the session cwd. |
| `src/errors.js` | `HttpError` + `mapError()` (thrown errors → the §7.7 status/code table). Small module added to keep the import graph cycle-free. |
| `src/PREFIX.md` | Base system prompt with guidelines (copied verbatim from the source). |
| `src/skills/init.md` | Built-in `/init` skill (copied from the source): explore the project and write an `AGENTS.md`. |
| `webui/index.html` | Web UI shell served at `/`. Thin page: Tailwind v4 Play CDN + import map (Preact/htm → esm.sh) + a `#root` mount — no static UI markup. |
| `webui/app.js` | The web UI as a Preact + htm ES module: project-grouped sidebar, model picker, full control toolbar, chat over SSE, todos. No build step. |
| `WEB_UI.md` | Authoritative description of the web UI: features, constraints/invariants, and current gaps (it is a scoped feature, expected to grow). |

## Architecture Notes

- **Source of truth**: `../clown-code/` (Zig). The `Worker`/`WorkerMsg`/fork/pipe machinery in `model.zig` is **removed**; its contract ("run the loop, emit snapshots, report errors") is preserved as an in-process async loop + event emitter per session.
- **Concurrency (replaces fork/pipe)**: the agent loop is a plain `async` function on the event loop. A single-flight `running` flag per session rejects overlapping runs with `409 session_busy`. `stop` sets an `AbortController` (checked between turns and to abort the in-flight LLM `fetch` / `run_command` child) — a cooperative replacement for the source's `SIGKILL`.
- **Persistence**: the SQLite DB is the **system of record** — a one-row upsert on every transition (create, message, tool result, status change, error, delete), not an optional autosave. On restart, `running`/`stopped` sessions reset to `idle` (an in-flight loop can't survive).
- **Snapshot**: the `snapshot` column stores `{ messages, todos, total_tokens }` — the internal conversation format, persisted per session. It may evolve freely as the tool grows.
- **Tools & sandboxing**: every file tool resolves its target against the session `cwd` and **rejects path traversal** (closes the source's `TODO: Check for path traversal`). Tool errors are returned to the model as text (loop continues), matching the source's `tk.ai.fmt()` behavior.
- **SSE**: one `text/event-stream` per session. Events: `snapshot`, `todo`, `status`, `error`, `done`, `pong`. Each carries a monotonic `id:` (seq); reconnect with `?since=<seq>` / `Last-Event-ID` to replay (bounded ring buffer). 15s `: keep-alive` heartbeat.
- **Agent-loop detail**: `next()` makes one LLM call with `messages` + tool schemas (`max_completion_tokens: 32768`), retries up to once on an empty choice, appends the assistant message, and returns `tool_calls`; the loop ends when a turn has no tool calls. `total_tokens` is the last response's `usage.total_tokens`.
- **Error mapping**: LLM timeout → `504 llm_timeout`; unreachable/HTTP error → `502 llm_unavailable`; unknown id → `404`; busy → `409`; malformed/missing `cwd` → `400`; bad `cwd` dir + unhandled → `500`.

## Working conventions

- **Type-check**: `npm run typecheck` (i.e. `tsc --noEmit`, config in `tsconfig.json`: `checkJs`+`allowJs`+`noEmit`, `strict:false`, `types:["node"]`). Dev deps `typescript`/`@types/node`/`preact`/`htm` are check-only — never emitted (the web UI still loads Preact/htm from the CDN import map). **Current state: the server (`src/`) is clean; the web UI (`webui/`) has just 2 errors left** — `webui/app.js` reads `Event.data` where it should be `MessageEvent` (SSE `onmessage`). Not fixed yet; tracked for a follow-up.
- **No test framework.** Verify by running the server and exercising the API (e.g. `node src/main.js --port 8899 --db-file /tmp/x.clowndb`, then `curl`). Keep the default DB `~/.clowndb` clean by using a throwaway `--db-file` during dev.
- **Code style** (see SPEC §15): ESM import/export only; `async`/`await` (no `.then`); arrow fns assigned to `const`; `const` > `let` > never `var`; terse (early returns, spread, optional chaining, template literals).
- **Config precedence**: CLI flag > env var > default.
- **Localhost by default** (`127.0.0.1`), no auth — single-user local tool, same posture as `clown-code`.
