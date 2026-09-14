# Clown-Circus

A **headless, multi-session** port of [`clown-code`](../clown-code/) exposed as an
**Express** HTTP server. Clown-Circus manages any number of independent agent
**sessions** — each with its own working directory, conversation state, and
running agent loop — all driven over **REST + Server-Sent Events**. Every session and its full conversation snapshot are persisted
in a local **SQLite** database, so state survives restarts.

- **Target runtime**: Node.js 24.x, TypeScript (`.ts`, ESM). The server has no build step (Node strips the types at runtime).
- **Storage**: the builtin `node:sqlite` module. No external DB server.
- **Dependencies**: `express` for the server; `esbuild` + the web UI's browser libraries (`preact`, `marked`, `dompurify`, `@tailwindcss/browser`) — esbuild inlines them all into `webui/vendor/bundle.js` at startup, so the UI works offline (no CDN).
- **LLM**: any OpenAI-compatible `/v1/chat/completions` endpoint (llama.cpp by default).

See [`SPEC.md`](SPEC.md) for the full specification.

---

## Quick start

```bash
npm install
npm start                # -> http://127.0.0.1:8790
```

Point it at your LLM (defaults to `http://127.0.0.1:8080`):

```bash
CLOWN_API=http://127.0.0.1:8080 npm start
```

Then create a session and drive it:

```bash
# create a session rooted at some project (cwd + model are required)
curl -s -X POST localhost:8790/sessions \
  -H 'content-type: application/json' \
  -d '{"cwd":"/path/to/project","model":"llama-3"}'

# send a message (202: the run is async); model is required on every send
curl -s -X POST localhost:8790/sessions/<id>/messages \
  -H 'content-type: application/json' \
  -d '{"message":"could you /init this project?","model":"llama-3"}'

# follow progress in real time (SSE)
curl -sN localhost:8790/sessions/<id>/events
```

---

## Configuration

CLI flags take precedence over environment variables, which take precedence over defaults.

| Flag / Env | Env fallback | Default | Meaning |
|---|---|---|---|
| `--port` / `PORT` | `PORT` | `8790` | HTTP listen port |
| `--host` / `HOST` | `HOST` | `127.0.0.1` | Bind address (localhost by default) |
| `--db-file` / `DB_FILE` | `DB_FILE` | `~/.clowndb` | Path to the SQLite database file |
| `--base-url` / `CLOWN_API` | `CLOWN_API` | `http://127.0.0.1:8080` | LLM OpenAI-compatible base URL |
| `--timeout` / `CLOWN_TIMEOUT_MS` | `CLOWN_TIMEOUT_MS` | `900000` | Per-LLM-request timeout (ms) |
| `--verbose` | — | off | Log per-session events to stdout |

`CLOWN_API_KEY` (env, optional) is sent as a Bearer token on every LLM request.

---

## REST API

Base path `/`. JSON bodies/responses everywhere except the SSE endpoint.
Errors: `{ "error": { "code", "message" } }`.

### Server / models

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness → `{ "ok": true, "sessions": <n> }` |
| `GET` | `/models` | Proxy `GET /v1/models` to the LLM |
| `GET` | `/config` | Effective server config (read-only) |

### Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions` | List as `SessionMeta[]`. Optional `?cwd=<path>` (exact match). |
| `POST` | `/sessions` | Create. Body: `{ cwd, model }` (both required) → `201` |
| `GET` | `/sessions/:id` | Full session: `SessionMeta` + `snapshot` |
| `DELETE` | `/sessions/:id` | Stop and delete (memory + DB) → `204` |

`POST /sessions` body — both `cwd` and `model` are required. `cwd` **must** be an
absolute path (relative → `400` `bad_request`); `model` (non-empty string) is the LLM
model to run and is stored as the
session's last-used model (the web UI pre-fills its picker from it; `retry`/`init`/`compact`
reuse it). There is no server-side default:

```json
{ "cwd": "/abs/path", "model": "llama-3" }
```

`SessionMeta`:
```json
{
  "id": "...", "cwd": "/abs/path", "model": "llama-3", "status": "idle",
  "created_at": "2026-09-02T12:00:00.000Z", "last_activity": "2026-09-02T12:05:00.000Z",
  "message_count": 42, "total_tokens": 18334, "last_error": null, "archived": false
}
```

### Messages

| Method | Path | Description |
|---|---|---|
| `POST` | `/sessions/:id/messages` | Append a user message, start the loop → `202 { id, status }`. `409` if busy. |

### Controls

| Method | Path | Cmd | Behavior |
|---|---|---|---|
| `POST` | `/sessions/:id/stop` | `/stop` | Abort the running loop → `200 { status }`. No-op if idle; the only control allowed mid-run. |
| `POST` | `/sessions/:id/undo` | `/undo` | Stop (if running) + drop trailing assistant/tool and the last user message → `200 { undone }` (its text; the web UI re-fills it in the composer). |
| `POST` | `/sessions/:id/retry` | `/retry` | Drop trailing assistant/tool, re-run → `202` / `409` if busy. |
| `POST` | `/sessions/:id/retry-turn` | `/retry-turn` | Roll back to just before the last assistant message (and its tool results), re-run → `202` / `409`; `400` if there is no assistant message. |
| `POST` | `/sessions/:id/clear` | `/clear` | Stop (if running) + reset history to the system prompt → `200`. |
| `POST` | `/sessions/:id/trim` | `/trim <keep>` | Truncate bulky tool results + chain-of-thought in older turns, keep the last `keep` turns → `200 { keep, trimmed, truncatedResults, reasoningRemoved }`; `400` if `keep` is not a non-negative integer. |
| `POST` | `/sessions/:id/compact` | `/compact` | Two-phase summarize-then-replace → `202` / `409`. |
| `POST` | `/sessions/:id/init` | `/init` | Send the `/init` prompt → `202` / `409`. |
| `POST` | `/sessions/:id/archive` | ⋮ menu | Metadata only: hide from the default session list (kept for later) → `200 { id, archived }`. Allowed mid-run. |
| `POST` | `/sessions/:id/unarchive` | ⋮ menu | Restore to the default session list → `200 { id, archived }`. Allowed mid-run. |
| `POST` | `/sessions/:id/fork` | `/fork` | Fork: a new session with the same `cwd`/`model` and a deep-copied transcript (settled to a valid turn seam) → `201` with the new session. |

Run-starting controls (`retry`, `retry-turn`, `compact`, `init`) reject with `409` while a
run is active. `stop` (and the metadata-only `archive`/`unarchive`) are allowed mid-run;
`undo`/`clear`/`trim` implicitly stop a running loop first.

### Events (SSE)

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions/:id/events` | `text/event-stream` of session activity |

Event types: `snapshot`, `status`, `error`, `done`, `pong`. Each event carries an
incremental `id:` (a per-session sequence number). Reconnect with `?since=<seq>` (or a
`Last-Event-ID` header) to replay missed events. A `: keep-alive` comment is sent every 15s.

---

## Storage

A single SQLite **file** at `~/.clowndb` (override with `--db-file`/`DB_FILE`). The DB is the
system of record: state is upserted on every transition (create, message, tool result, status
change, error, delete). On startup all sessions are loaded into memory; any session persisted
as `running`/`stopped` (killed mid-run) is reset to `idle`.

The `snapshot` column stores `{ messages, total_tokens }` — the internal
conversation format, persisted per session (the todo list is *not* stored; the
web UI derives it from the last `write_todos` tool call). It may evolve freely as the tool grows.

---

## Tools

Relative paths resolve against the session's `cwd` (the same directory `run_command` runs in).
There is **no path sandbox**: the agent may read, write, and execute anywhere the server process can reach.

| Tool | Args | Notes |
|---|---|---|
| `read_file` | `path`, `raw?` | `N:content` line prefixes unless `raw`. 2MB cap. |
| `write_file` | `path`, `content` | Creates parent dirs. |
| `edit_file` | `path`, `old_content`, `new_content`, `replace_all?` | Exact-match replace. |
| `run_command` | `command`, `cwd?` | `sh -c`; captures stdout+stderr; abortable on stop. |
| `write_todos` | `content: string (markdown)` | No-op: the tool call's presence in the transcript IS the todo list (the web UI derives it from messages); returns "Todos updated". |
| `load_skill` | `skill_name` | Built-in `init`, else `skills/<name>.md` in cwd. |

---

## Project layout

```
src/
├─ main.ts       # bootstrap: config, DB, manager, app, listen
├─ config.ts     # flag + env resolution
├─ app.ts        # Express app (all routes + SSE)
├─ db.ts         # node:sqlite wrapper (open, migrate, queries)
├─ manager.ts    # SessionManager registry (load, create, list, delete, persist)
├─ session.ts    # Session (messages, run loop, SSE events, persistence)
├─ loop.ts       # agent loop
├─ llm.ts        # OpenAI-compatible chat client
├─ prompt.ts     # system-prompt composition
├─ tools.ts      # tools + registration
├─ errors.ts     # HttpError + error mapping
├─ PREFIX.md     # base system prompt
└─ skills/init.md
```

`webui/` — the web UI served at `/` (Preact JSX (`.tsx`) and TypeScript (`.ts`)
modules; esbuild bundles it into `vendor/bundle.js` at server startup):

```
webui/
├─ index.html      # page shell: Tailwind v4 @theme tokens + #root mount + /vendor/bundle.js
├─ app.tsx         # root Preact component (bundle entry): all state + side effects
├─ Header.tsx      # top bar (toggle, status, model picker, theme, actions menu)
├─ Sidebar.tsx     # project-grouped session list + new-session form
├─ Main.tsx        # right-hand pane (error banner, todos, transcript, composer)
├─ Message.tsx     # transcript rendering (user/assistant/tool, reasoning)
├─ ToolCall.tsx    # per-tool argument views (collapsible tool-call bodies)
├─ InputBar.tsx    # composer (textarea, send/stop, slash cmds, image attach)
├─ Todos.tsx       # floating collapsible todo panel
├─ Markdown.tsx    # Markdown component (marked + DOMPurify)
├─ api.ts          # REST + SSE client (no Preact/DOM)
├─ util.ts         # pure helpers (no DOM/Preact)
├─ image.ts        # client-side image helpers (FileReader read, canvas downscale)
└─ ui.ts           # shared Tailwind class tokens (BTN, PRE)
```

See [`WEB_UI.md`](WEB_UI.md) for details.

## Security notes

- Binds to `127.0.0.1` by default; single-user local tool (no auth).
- No path sandbox: file/shell tools can reach any path the server process can. The trust boundary is the local user plus the `127.0.0.1` bind.
- The LLM key is never logged; request bodies are not logged.
