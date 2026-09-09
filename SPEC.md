# Clown-Circus — Specification

A **headless, multi-session** port of [`clown-code`](../clown-code/) exposed as an
**Express-based HTTP server**. Instead of a single terminal TUI bound to one
conversation, Clown-Circus manages any number of independent agent **sessions**,
each with its own working directory, conversation state, and running agent loop,
all driven over REST + Server-Sent Events. All sessions and their conversation
state are persisted in a local **SQLite** database.

- **Historical origin**: `../clown-code/` (Zig + tokamak TUI). **Note**: the
  projects have since **diverged** — Clown-Circus is its own thing now, and
  `../clown-code/` is **no longer a reference point**. Don't go look there for
  behavior; this spec (and the code) is authoritative.
- **Target runtime**: the currently installed **Node.js 24.x** (`v24.14.1`),
  plain JavaScript (ESM). No build step.
- **Storage**: the builtin **`node:sqlite`** module (no external DB server).
- **No TUI, no terminal, no fork/pipe.** Everything that was a keypress or TUI
  command becomes an HTTP endpoint.

---

## 1. Goals

- Port the **agent core** of Clown-Code (system-prompt composition, agentic
  tool loop, tools, compaction, retry/undo) to JavaScript.
- Run **many sessions concurrently** in a single long-lived server process.
- **Persist every session** (metadata + full conversation snapshot) in a local
  SQLite database using Node's builtin `node:sqlite`, so state survives restarts.
- Provide a **headless REST + SSE API** that a client (web UI, CLI, CI, other
  services) can drive entirely over HTTP.
- Provide a **web UI** served at `/` so the server is usable out of the box in
  a browser. It is minimal for now (a thin Preact + htm page, no build step)
  and expected to grow over time — see [WEB_UI.md](WEB_UI.md) for the full
  description.
- Support a **"projects" view**: sessions are grouped by their working directory,
  and `/sessions` can be filtered by path.
- Keep behavior faithful to the original: the same tool set and the same
  prompt-composition rules.

## 2. Non-Goals

- No terminal client.
- No authentication/authorization, rate limiting, or multi-tenancy hardening
  beyond binding to localhost by default (see §16).
- No change to the model provider contract: it still targets an OpenAI-compatible
  `/v1/chat/completions` endpoint (llama.cpp by default).
- No external database server — storage is embedded SQLite only.
- No distributed server / horizontal scaling.

---

## 3. Relationship to Clown-Code

> **Diverged.** Clown-Code was the historical origin of this project, but the
> features have already diverged enough that there is **no point looking in
> `../clown-code/`** anymore. Treat this spec and the code in this repo as the
> single source of truth; the table below is history, not a contract to keep
> honoring.

| Concern                | Clown-Code (source)                     | Clown-Circus (this port)                          |
|------------------------|------------------------------------------|---------------------------------------------------|
| Frontend               | tokamak TUI (`src/tui.zig`)              | Web UI served at `/` (Tailwind v4, project-grouped sidebar, model picker, full controls — see WEB_UI.md); headless API stays primary |
| Process model          | fork-based worker + pipe                 | In-process async loop, one active run per session  |
| Sessions               | Exactly one, bound to the process        | Many, each a `Session` object in a registry        |
| Commands (`/stop` etc.)| TUI slash-commands                       | REST endpoints                                     |
| Streaming to user      | TUI re-render each tick                  | SSE event stream per session                       |
| Persistence            | `session-*.json` in cwd (manual `/save`) | SQLite DB (`~/.clowndb`), one row per session, always written |
| CWD                    | Server process cwd                       | Per-session `cwd` (stored per row)                 |
| Tools                  | `src/tools.zig`                          | `src/tools.js` (behavior preserved)                |
| System prompt          | `PREFIX.md` + `AGENTS.md`/`CLOWN.md`     | Same (loaded per session cwd)                      |

The `Worker` / `WorkerMsg` / pipe machinery in `src/model.zig` is **removed**.
Its observable contract — "run the agent loop, emit snapshots, report errors" —
is preserved as an async loop plus event emitter per session. The manual
`session-*.json` file save/load is **replaced** by the SQLite store, which is
the sole system of record.

---

## 4. Architecture Overview

```
                         ┌──────────────────────────────────────────────┐
                         │              Express app (app.js)             │
                         │                                              │
   HTTP clients ───────▶ │  REST routes  ──▶  SessionManager             │
   (REST + SSE)          │                    │                          │
                         │                    ├─ map<id, Session>        │
                         │                    │   (in-memory, hot state) │
                         │                    └──▶ SQLite (~/.clowndb)   │
                         │                         system of record      │
                         │  ┌───────────────────────────────────────┐     │
                         │  │  Session (one per conversation)       │     │
                         │  │   - id, cwd, model, status            │     │
                         │  │   - messages[], tokens                  │     │
                         │  │   - agent loop (async)                │     │
                         │  │   - EventEmitter (SSE source)         │     │
                         │  └───────────────────────────────────────┘     │
                         │                    │                          │
                         └────────────────────┼──────────────────────────┘
                                              │ tool calls (run in session cwd)
                                              ▼
                                   Filesystem + shell (per-session cwd)
                                              │
                                              ▼
                          LLM: OpenAI-compatible /v1/chat/completions
                          (llama.cpp, default http://127.0.0.1:8080)
```

Components (each is a flat file under `src/`):

- **`db.js`** — thin wrapper over `node:sqlite`. Owns the connection, runs the
  schema migration, and exposes the query helpers the manager/session actually
  use: `upsert`, `all` (startup load), `deleteRow`, and `close`. Listing and
  project grouping are done in memory by the `SessionManager`, not in SQL.
- **`manager.js` (SessionManager)** — the multi-session registry. Loads all
  sessions from SQLite into memory at startup, and coordinates create/list/
  retrieve/destroy + persist-on-change. Owns IDs and lifecycle.
- **`session.js` (Session)** — the port of the `Clown` struct (`src/model.zig`).
  Owns the message list, token counter, the agentic loop, and an event
  emitter. Replaces the fork/pipe worker with an in-process async loop guarded
  by a single-flight flag so only one run executes at a time.
- **`loop.js`** — the agent loop (port of `workerInner`), shared by sessions.
- **`tools.js`** — the port of `src/tools.zig`. Each tool is a named function
  with a JSON-schema description (surfaced to the model) and typed args.
- **`llm.js`** — a thin OpenAI-compatible chat client (replaces `tk.ai.Client`),
  used by the agent loop.
- **`prompt.js`** — composes the system prompt (replaces `loadSystemPrompt`).

### Concurrency model (replacing the fork/pipe worker)

Clown-Code forks a child because the TUI must stay responsive while the blocking
agent loop runs. In a Node server the equivalent constraint is: **do not block
the event loop** and **do not let two runs of the same session interleave**.

- The agent loop is a plain `async` function: `send(prompt)` → append user
  message → run loop (`while (turn = await next()) { await acceptAll(turn) }`).
- Each `Session` has `running: boolean`. `send`/`retry`/`compact`
  reject (HTTP 409) if `running` is already true unless the caller issues
  `stop` first. This is the direct analogue of "worker != null → busy".
- `stop` sets a cooperative cancellation token (an `AbortController`) checked
  between turns (replacing `SIGKILL` of the fork). Long-running tool calls
  (e.g. `run_command`) are aborted via the shared `AbortSignal`.
- Sessions are independent; a slow session never blocks others.
- **SQLite writes are synchronous** (`node:sqlite` `DatabaseSync`) and small
  (one row upsert per state change), so they do not meaningfully block the
  event loop. Writes happen on the main thread; the DB is single-writer by
  design (one process owns the file).

---

## 5. Data Model

### 5.1 Snapshot (conversation content)

The per-session conversation content, persisted as JSON in the `snapshot` column.
It is an internal format and may evolve freely as the tool grows.

```js
// Todos
// string   // user-visible markdown; the checkbox convention lives in PREFIX.md

// ContentPart (OpenAI shape; used for multimodal messages)
// { type: "text", text: string }
// { type: "image_url", image_url: { url: string } }   // data-URL (base64)

// Message
// {
//   role: "system" | "user" | "assistant" | "tool",
//   content: string | ContentPart[],
//   tool_calls?: [ { id, type: "function", function: { name, arguments } } ], // assistant
//   tool_call_id?: string,   // tool-result messages reference a call
//   name?: string            // tool name for role=tool
// }

// Snapshot  (stored as a JSON string in the `snapshot` column)
// { messages: Message[], total_tokens: number }
```

> **Multimodal note**: `content` is a plain `string` for text-only messages
> (the common case). A user message that carries images is an array of
> `ContentPart` (OpenAI shape); the array may contain zero or more `image_url`
> parts plus a `text` part. The snapshot is the system of record and may evolve
> freely, so no DB migration is required.

### 5.2 SQLite schema

A single database **file**: `~/.clowndb` by default (a file, not a directory).
Overridable via `--db-file`/`DB_FILE`. Created/migrated on startup
(`CREATE TABLE IF NOT EXISTS` ...).

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,               -- UUIDv4
  cwd           TEXT NOT NULL,                  -- absolute working directory
  model         TEXT NOT NULL,                    -- last model used (set on send); the web UI pre-fills its picker from it
  status        TEXT NOT NULL DEFAULT 'idle',   -- idle | running | error | stopped
  created_at    TEXT NOT NULL,                  -- ISO 8601
  last_activity TEXT NOT NULL,                  -- ISO 8601
  last_error    TEXT,                           -- nullable
  snapshot      TEXT NOT NULL,                  -- JSON: { messages, total_tokens }
  archived      INTEGER NOT NULL DEFAULT 0      -- 0/1; hidden from the default list
);

CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions (cwd);
```

> `archived` (schema v2) is a plain boolean flag: archived sessions persist in
> the DB and stay in the in-memory registry, but are excluded from the default
> `GET /sessions` list and the `/projects` counts (§7.2, §7.3). Adding the
> column to a v1 database is the v2 migration (`ALTER TABLE ... ADD COLUMN`,
> §10.2). No index: low-cardinality flag on a small local table, and the
> manager filters in memory anyway.

### 5.3 Runtime model

A `Session` object (in memory) = the DB row's fields + the parsed `snapshot` +
runtime state (`running`, `abortController`, `EventEmitter`, LLM client).

A **`SessionMeta`** is what the API exposes for listing (derived from the row +
snapshot; the raw `messages` are not included in list responses):

```js
// SessionMeta
// {
//   id, cwd, model, status, created_at, last_activity, last_error?,
//   message_count,   // = snapshot.messages.length
//   total_tokens,    // = snapshot.total_tokens
//   archived         // boolean; false by default
// }
```

---

## 6. Session Lifecycle

1. **Created** via `POST /sessions` with a `cwd` and a `model` (both required).
   A row is inserted into SQLite and the session is loaded into memory.
   Status `idle`.
2. **Running** when an agentic loop is active (after a message/retry/compact).
   Every state change is upserted to SQLite.
3. **Idle** again when the loop finishes.
4. **Error** if the loop throws; `last_error` is set and persisted. The session
   remains reusable — a new message starts a fresh run.
5. **Destroyed** via `DELETE /sessions/:id` (aborts any running loop, removes
   the row from SQLite, drops from memory).

**Archived** is an orthogonal flag, not a status: `POST /sessions/:id/archive`
(hide) / `POST /sessions/:id/unarchive` (restore), §7.5. It is a
metadata-only edit — allowed while running (no `409`), it never touches the
conversation — and it survives restarts like every other field. Archived
sessions are excluded from the default `GET /sessions` list and `/projects`
counts, but remain fully addressable by id (detail, controls, SSE) and
deletable.

**Persistence is continuous**: the DB is the system of record, so state is
written on every transition (create, message, tool result, status change, error,
delete) — not just on an explicit save. This is the natural consequence of
SQLite being the store (it is not an optional "auto-save" feature).

**Restart semantics**: at startup the `SessionManager` loads all rows into
memory. A session whose persisted `status` is `running`/`stopped` (i.e. it was
mid-run when the process died) is reset to `idle`, because an in-flight loop
cannot survive a restart.

### ID scheme

UUIDv4 (`crypto.randomUUID()`), generated by the server. Stable and unique in
the DB. Clients persist the `id` to address a session across requests/restarts.

---

## 7. HTTP API

Base path: `/`. All bodies are JSON. All responses are JSON except the SSE
endpoint and the static web UI (§7.8). Errors use `4xx`/`5xx` with
`{ "error": { "code", "message" } }`.

### 7.1 Server / models

| Method | Path            | Description |
|--------|-----------------|-------------|
| `GET`  | `/health`       | Liveness probe → `{ "ok": true, "sessions": <n> }` |
| `GET`  | `/models`       | Proxy `GET /v1/models` to the LLM (analog of `/models` command) |
| `GET`  | `/config`       | Read-only effective server config (base_url, db_file, timeouts, truncation) |

### 7.2 Sessions

| Method | Path                 | Description |
|--------|----------------------|-------------|
| `GET`  | `/sessions`          | List sessions as `SessionMeta[]`. Optional `?cwd=<path>` to filter by working directory (exact match), and `?archived=` (see below). |
| `POST` | `/sessions`          | Create a session |
| `GET`  | `/sessions/:id`      | Full session: `SessionMeta` + current `snapshot` |
| `DELETE`| `/sessions/:id`     | Stop and delete the session (from memory and DB) |

`GET /sessions`:
- Returns non-archived sessions by default (those matching `?cwd=` if given).
- `?cwd` is an exact, case-sensitive match on the stored absolute `cwd`.
- `?archived` is a boolean flag:
  - present and `"true"`/`"1"` → **include** archived sessions (the web UI uses
    this to fetch everything, then splits archived/non-archived client-side)
  - absent, `"false"`, or `"0"` → **non-archived only** (the default)
- `400` if `cwd` is supplied but empty.

`POST /sessions` body (`cwd` and `model` required):

```json
{
  "cwd": "/abs/path/to/project",
  "model": "llama-3"
}
```

- `cwd` is a filesystem path used as the session's working directory. It is
  normalized to an **absolute** path (resolved against the server process cwd if
  relative) and stored in that form.
- `model` — the LLM model to run (non-empty string). It is stored as the
  session's **last-used model**: each `POST /sessions/:id/messages` (§7.4)
  specifies the model for its run and the value is persisted — the web UI
  pre-fills its model picker from it, and `retry`/`init`/`compact` reuse it.
  There is no server-side default: the client always says which model to use.
- `201` on success, returning the created session (meta + snapshot).
- `400` if `cwd` or `model` is missing; `500` if the `cwd` path is not a
  directory.

`GET /sessions/:id` response:

```json
{
  "id": "...",
  "cwd": "/abs/path",
  "model": "llama-3",
  "status": "idle",
  "created_at": "2026-09-02T12:00:00.000Z",
  "last_activity": "2026-09-02T12:05:00.000Z",
  "message_count": 42,
  "total_tokens": 18334,
  "last_error": null,
  "archived": false,
  "snapshot": { "messages": [], "total_tokens": 18334 }
}
```

### 7.3 Projects

| Method | Path         | Description |
|--------|--------------|-------------|
| `GET`  | `/projects`  | "Projects" view: unique working directories across all sessions |

A project is simply a distinct `cwd`. This is derived directly from the DB
(non-archived sessions only, so a project whose sessions are all archived does
not surface): `SELECT cwd, COUNT(*) AS sessions FROM sessions GROUP BY cwd
ORDER BY cwd`.

Response:

```json
[
  { "cwd": "/Users/cztomsik/Desktop/clown-circus", "sessions": 3 },
  { "cwd": "/Users/cztomsik/projects/other",       "sessions": 1 }
]
```

Clients use this to build a project sidebar; selecting one is equivalent to
`GET /sessions?cwd=<that path>`.

### 7.4 Sending messages

| Method | Path                            | Description |
|--------|---------------------------------|-------------|
| `POST` | `/sessions/:id/messages`        | Append a user message and start the agent loop |

Body: `{ "message": "help me fix the tests", "model": "llama-3" }` or
`{ "message": [{"type":"text","text":"describe this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}] }`.

- `message` is a **non-empty string** (text-only, the common case) or a
  **non-empty `ContentPart[]`** (multimodal; OpenAI content-parts shape).
  Image data is carried as base64 data-URLs inside the JSON body (no multipart
  upload). The JSON body limit is **25 MB** to accommodate a few capped images.
- `model` is **required**: the model to run this send on (non-empty string;
  `400` `bad_request` if missing or empty). It is pinned for the whole run and
  persisted as the session's last-used model (the value the web UI pre-fills
  its picker from; `retry`/`init`/`compact` reuse it).
- `202 Accepted` immediately: `{ "id", "status": "running" }`. The run is
  asynchronous; progress is delivered over the SSE stream (§8) and reflected in
  `GET /sessions/:id`.
- `409 Conflict` if the session is already `running` (client should `stop` first
  or wait).
- `404` if the session does not exist.

### 7.5 Session controls (port of the TUI slash-commands)

All of these operate on a single session and map 1:1 to the original commands in
`src/tui.zig` `handleCommand`.

| Method | Path                       | Original cmd   | Behavior |
|--------|----------------------------|----------------|----------|
| `POST` | `/sessions/:id/stop`       | `/stop`        | Cooperatively abort the running loop. `200` `{ "status": "stopped" }`. No-op (still `200`) if idle. |
| `POST` | `/sessions/:id/undo`       | `/undo`        | Pop the last message from history. Returns the popped message text (if any) in `{ "undone": "..." }`. |
| `POST` | `/sessions/:id/retry`      | `/retry`       | Strip trailing assistant/tool messages (keep last user message) and re-run. `202` when it starts a run, `409` if busy. |
| `POST` | `/sessions/:id/clear`      | `/clear`       | Stop + clear history (keep system message). `200`. |
| `POST` | `/sessions/:id/clear-tools`| `/clear-tools` | Stop + drop all `role=tool` messages, keep system/user/assistant. `200`. |
| `POST` | `/sessions/:id/compact`    | `/compact`     | Run the two-phase summarize-then-replace compaction (as in the source). `202` (starts a run). |
| `POST` | `/sessions/:id/init`       | `/init`        | Convenience: send the prompt that triggers the built-in `init` skill ("Could you /init this project?"). `202`. |
| `POST` | `/sessions/:id/duplicate`  | —              | Fork the session into a new one: same `cwd`, `model`, and archived flag; fresh id/timestamps; `last_error` cleared; a **deep copy** of the transcript (independent of the source). If the source is running and the copy ends mid-turn (an assistant `tool_calls` whose tool results have not all arrived yet — an invalid LLM transcript), that message and its partial results are stripped; a completed transcript is copied verbatim. Allowed while the source is running. `201`, returning the new session (meta + snapshot). `404` if the source is unknown. |
| `POST` | `/sessions/:id/archive`    | —              | Mark the session as archived: kept in the DB but hidden from the default `GET /sessions` list and `/projects` counts. No body. `200` `{ "id", "archived": true }`. |
| `POST` | `/sessions/:id/unarchive`  | —              | Restore an archived session to the default list. No body. `200` `{ "id", "archived": false }`. |

Rules common to the run-starting controls (`retry`, `compact`,
`init`, `messages`): reject with `409` if `running` is already true. Only
`stop` and the `archive`/`unarchive` flags are allowed while running —
metadata-only edits that never touch the conversation — and `duplicate`
deep-copies the transcript into an independent session (the source is never
touched, even while it runs).

`undo`/`clear`/`clear-tools` are synchronous state edits; if a run is in
progress they implicitly `stop` first (matching the original, which calls
`self.stop()` before mutating).

### 7.6 Events (SSE)

| Method | Path                          | Description |
|--------|-------------------------------|-------------|
| `GET`  | `/sessions/:id/events`        | Server-Sent Events stream of session activity |

This is the headless replacement for the TUI re-render loop. Clients connect
with `Accept: text/event-stream` (e.g. a browser `EventSource`) and receive
incremental updates in real time.

Event types (SSE `event:` field):

| Event      | Data (JSON)                              | Emitted when |
|------------|------------------------------------------|--------------|
| `snapshot` | `Snapshot`                               | After each agentic turn / tool batch (replaces the per-tick snapshot the TUI consumed) |
| `status`   | `{ "status": "running"\|"idle"\|"error"\|"stopped" }` | On state transitions |
| `error`    | `{ "message": "..." }`                   | On a loop error |
| `done`     | `{ "total_tokens": n }`                  | When a run completes |
| `pong`     | `{}`                                     | In response to a client `ping` (keepalive) |

- The stream supports an optional `?since=<seq>` query (monotonic per-session
  sequence number) to replay missed events after a reconnect. Each event carries
  an incremental `id:` (the seq) for `Last-Event-ID` resume.
- A **fresh** connection (no `?since` and no `Last-Event-ID`) does **not**
  replay the backlog — it streams live events only. A client loads the current
  snapshot from `GET /sessions/:id` and uses the (bounded) ring buffer purely to
  catch up after a brief disconnect; replaying the whole history on first connect
  would just make it re-render / flicker through every past transition.
- The connection stays open until the client disconnects or the session is
  destroyed (server sends a final `status: stopped` + close).
- Heartbeat: an SSE comment line (`: keep-alive`) every 15s to keep proxies open.

> **Rationale**: a single SSE stream per session keeps clients simple and matches
> the "server pushes rendered state" model of the TUI. WebSockets are a
> non-goal; SSE is sufficient for one-way server→client streaming.

### 7.7 Errors

| HTTP | `code`            | Meaning |
|------|-------------------|---------|
| `400`| `bad_request`     | Malformed body / missing `cwd` or `model` / empty `cwd` filter |
| `404`| `not_found`       | Unknown session id |
| `409`| `session_busy`    | Run-starting call while `running` is true |
| `500`| `internal`        | Unhandled server error (incl. DB errors) |
| `502`| `llm_unavailable` | The LLM endpoint is unreachable / returns an error |
| `504`| `llm_timeout`     | The LLM request exceeded the configured timeout |

### 7.8 Web UI

A web UI is served at `GET /` from `webui/` (via `express.static`): a thin
`index.html` shell (Tailwind v4 via the locally-served `@tailwindcss/browser`
JIT, an import map for Preact/htm/marked/dompurify, and a single `#root`
mount) plus a set of small **Preact + htm** ES modules — `app.js`
holds the root component (all state + side effects), with component modules
(`Header.js`, `Sidebar.js`, `Main.js`, `Message.js`, `InputBar.js`, `Todos.js`)
and non-component helpers (`api.js`, `util.js`, `image.js`, `ui.js`; the full
file list is in §13). It is a **pure client** of the API in this section — it
adds no server logic, routes, or dependencies. No build step: the only
runtime libraries (Tailwind, Preact, htm, marked, DOMPurify) are served from
`node_modules` through `/vendor/*` static mounts in `src/app.js` — no
network CDNs, the UI works fully offline.

The authoritative description of the UI — features, constraints/invariants,
and the current gaps it is expected to grow into — lives in
[WEB_UI.md](WEB_UI.md).

---

## 8. Agent Loop (port of `workerInner`)

The core loop, once `send` is called, is:

```
running = true; emit status=running; persist(status)
loop:
    turn = await agent.next()        # one LLM chat completion; appends the assistant msg
    emit snapshot; persist(snapshot, last_activity)   # persist + stream the assistant turn (incl. tool calls) BEFORE running them
    if !turn.tool_calls: break
    for tc in turn.tool_calls:       # cooperative: check the abort signal between calls
        await tools[tc.function.name](tc.function.arguments, sessionCtx)   # appends a role=tool result
    emit snapshot; persist(snapshot, last_activity)   # persist + stream the tool results
emit status=idle, done; persist(status)
```

- `agent.next()` is one call to the LLM with `messages` + tool definitions. It
  appends the assistant message (with any `tool_calls`) before returning, so the
  turn is already in history by the time we persist.
- `acceptAll` = execute every requested tool, append `role=tool` results, and
  loop again so the model can react.
- The loop ends when the model returns a turn with **no** tool calls.
- Each iteration checks the session's `AbortController`; if aborted, it stops
  cleanly, emits `status=stopped`, and persists.
- Token accounting uses the `usage` field from the LLM response
  (analog of `agent.total_tokens`).
- **Persist + emit the assistant turn before executing its tool calls.** The
  turn is streamed and written to the DB as soon as `next()` returns, *then* the
  tools run. This makes the model's intent durable and visible to the client
  before any (possibly long or destructive) side effect, and keeps the DB current
  if the process dies mid-run (recoverable as far as the last persisted state).
- **Auto-truncation.** At the very top of `next()` — immediately before the LLM
  call — `truncatedMessages()` returns the view the LLM receives, in which stale
  oversized *gap* tool results are stubbed to `<truncated N bytes>` (see
  [AUTO_TRUNCATE.md](AUTO_TRUNCATE.md)). It is **non-destructive**: `this.messages`
  (and thus the DB row and the web UI) are never mutated — the stub exists only in
  the LLM-bound copy. It returns `this.messages` as-is under `--no-trunc` or when
  the gap is under the mark.

### Cancellation (replacing `SIGKILL`)

`stop` calls `session.abortController.abort()`. The loop:
1. Cancels any in-flight LLM `fetch` (via the shared `AbortSignal`).
2. Aborts any in-flight `run_command` child process.
3. Checks the signal at the top of each turn and between tool calls.

Because the loop is cooperative, a tool call that ignores the signal is the only
thing that can delay a stop. This is a deliberate, safer trade-off versus the
source's process kill.

---

## 9. System Prompt (port of `loadSystemPrompt`)

Composed **per session, from the session's `cwd`**, at session creation and
re-composed on `clear`-style resets:

```
<PREFIX.md>                       (from ./src/PREFIX.md, copied from the source)

<AGENTS.md>                       (from cwd, up to 1MB) if present,
  else <CLOWN.md>                 (from cwd, up to 1MB) if present,
  else (omitted)

Current date: <YYYY-MM-DD>
Current working directory: <realpath of cwd>

[when auto-truncation is on] Note: older (stale) tool results may be replaced
  with `<truncated N bytes>` to bound history; re-read the file or re-run the
  command to recover the full content.
```

- The exact fallback chain `AGENTS.md → CLOWN.md → (none)` is preserved.
- The system message is `messages[0]` and is the only message retained by
  `clear`.
- `PREFIX.md` content is copied from the source verbatim (same guidelines), with
  the tool list updated to match the ported tools.
- When auto-truncation is on (default), a trailing one-line note is appended
  telling the model that stale tool results may be stubbed to
  `<truncated N bytes>` and to re-read/re-run for the full content
  (see [AUTO_TRUNCATE.md](AUTO_TRUNCATE.md)).

---

## 10. Persistence (SQLite)

### 10.1 Storage

- **Location**: a single database **file**, `~/.clowndb` by default (a file,
  not a directory). Overridable via `--db-file`/`DB_FILE`.
- **Engine**: Node's builtin `node:sqlite` (`node:sqlite` `DatabaseSync`). No
  external server, no npm dependency.
- **Journal mode**: use the default rollback journal (do **not** enable WAL).
  WAL would create `-wal`/`-shm` sidecar files next to the DB; staying on the
  default keeps the database a single self-contained file, which is the whole
  point of `~/.clowndb`. (The transient `-journal` file only exists mid-write
  and is removed on commit.)
- **Writes**: synchronous, one row upsert per state change. The DB is owned by
  exactly one server process (single-writer assumption), so WAL's read
  concurrency benefit is not needed here.

### 10.2 Migration

On startup, `db.js` runs idempotent DDL (`CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`) against the *current* schema, then applies
versioned migrations gated on the `user_version` pragma. Fresh DBs are born
matching the current version (the DDL already carries every column) and only
get the version bump.

| Version | Change |
|---------|--------|
| 1 | Initial schema |
| 2 | `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0` (§5.2) |

---

## 11. Configuration

Via CLI flags and/or environment variables, resolved at startup into a
`Config` object exposed read-only at `GET /config`.

| Flag / Env                 | Env fallback     | Default                  | Meaning |
|----------------------------|------------------|--------------------------|---------|
| `--port` / `PORT`          | `PORT`           | `8790`                   | HTTP listen port |
| `--host` / `HOST`          | `HOST`           | `127.0.0.1`              | Bind address (localhost default for safety) |
| `--db-file` / `DB_FILE`    | `DB_FILE`        | `~/.clowndb`             | Path to the SQLite database file |
| `--base-url` / `CLOWN_API` | `CLOWN_API`      | `http://127.0.0.1:8080`  | LLM OpenAI-compatible base URL (kept from source) |
| `--timeout` / `CLOWN_TIMEOUT_MS` | `CLOWN_TIMEOUT_MS` | `900000` (15 min)      | Per-LLM-request timeout (matches source's `15*60`) |
| `--trunc` / `--no-trunc` · `CLOWN_TRUNC` | `CLOWN_TRUNC` | `true`                 | Master on/off for auto-truncation (on by default; `--no-trunc` disables) |
| `--truncate-gap` / `CLOWN_TRUNC_GAP`    | `CLOWN_TRUNC_GAP`  | `100000` (bytes)         | Run a truncation pass once the *history gap* (bytes before the latest user turn, system prompt excluded) exceeds this |
| `--truncate-bytes` / `CLOWN_TRUNC_BYTES`| `CLOWN_TRUNC_BYTES`| `256` (bytes)          | A *gap* `role=tool` result larger than this many bytes is rewritten to `<truncated N bytes>` |

- The parent directory of the DB file is created (with parents) if missing.
- LLM auth (`Authorization` header) is passed through from an optional
  `CLOWN_API_KEY` env var, sent with every LLM request.
- **Auto-truncation** (`--trunc`, on by default) is a server-side pre-process that
  trims the *history* the model sees before every LLM call — non-destructive to
  the stored transcript (the DB and web UI keep the full content). The
  gap/threshold semantics, invariants, and verification are documented in
  [AUTO_TRUNCATE.md](AUTO_TRUNCATE.md). The three keys are surfaced read-only in
  `GET /config` as `auto_truncate`, `truncate_gap`, `truncate_bytes`.

---

## 12. Tools (port of `src/tools.zig`)

Each tool is registered with a **snake_case name** (matching the source's tool
naming convention), a one-line description, a JSON-Schema for args, and an
implementation. Relative paths resolve against the session's `cwd` (the same
directory `run_command` runs in). There is **no path sandbox**: the agent may
read, write, and execute anywhere the server process can reach — matching the
source, whose only path-traversal note was an unimplemented `TODO`.

| Tool            | Args                                            | Ported from | Notes |
|-----------------|--------------------------------------------------|-------------|-------|
| `read_file`     | `path`, `raw?: bool`                             | `readFile`  | Line-number prefix `N:content` unless `raw`. 2MB limit. UTF-8 validated. |
| `write_file`    | `path`, `content`                                | `writeFile` | Creates parent dirs. |
| `edit_file`     | `path`, `old_content`, `new_content`, `replace_all?: bool` | `editFile` | Exact-match replace; errors on 0 or >1 matches unless `replace_all`. Exact-string semantics kept (the source evaluated line-range/sed edits and rejected them). |
| `run_command`   | `command`, `cwd?: string`                        | `runCommand`| Runs `sh -c`; captures stdout+stderr (2MB limits); abortable on stop. |
| `write_todos`  | `content: string (markdown)`                   | `writeTodos`| No-op: the tool call's presence in the transcript IS the todo list (the web UI derives it from messages). Returns `Todos updated`. |
| `load_skill`    | `skill_name`                                     | `loadSkill` | Built-in `init` first, else `skills/<name>.md` in cwd (path-validated). |

Tool result values are returned to the model as text (strings / structured
values serialized to JSON), matching the source's `tk.ai.fmt()` behaviour.

### Tool context

Each tool invocation receives a `ToolContext`:

```js
// {
//   cwd: string,           // session cwd (working directory for tools)
//   signal: AbortSignal,   // for run_command
//   emit(event, data),     // e.g. emit("status", { status })
// }
```

---

## 13. Directory Layout (target)

```
clown-circus/
├─ SPEC.md                  # this file
├─ README.md
├─ WEB_UI.md                # web UI description (features, constraints, growth)
├─ AUTO_TRUNCATE.md         # auto-truncation: design, semantics, invariants (server-side history bound)
├─ package.json             # "type": "module"; scripts: start, typecheck
├─ tsconfig.json            # tsc config: checkJs/allowJs/noEmit, strict:false, types:[node] (type-check only)
├─ .gitignore
├─ webui/
│  ├─ index.html            # web UI shell served at / (import map → /vendor/* + #root)
│  ├─ app.js                # the web UI: Preact + htm ES module (root component + state)
│  ├─ ui.js                 # htm→h binding + shared class tokens
│  ├─ api.js                # REST + SSE client helpers
│  ├─ util.js               # pure helpers (no DOM)
│  ├─ image.js              # client-side image helpers (FileReader, canvas)
│  ├─ Header.js             # unified top bar
│  ├─ Sidebar.js            # project-grouped session list + new-session form
│  ├─ Main.js               # right-hand pane composition
│  ├─ Message.js            # transcript (messages + tool pairs)
│  ├─ InputBar.js           # composer (textarea + send/stop + image attachments)
│  └─ Todos.js              # floating todo panel
└─ src/
   ├─ main.js               # bootstrap: parse config, open DB, build app, listen
   ├─ config.js             # Config resolution (flags + env)
   ├─ app.js                # express app factory (all routes wired here)
   ├─ db.js                 # node:sqlite wrapper: connection, migration, queries
   ├─ manager.js            # SessionManager registry (loads from DB, persists changes)
   ├─ session.js            # Session (port of model.zig Clown)
   ├─ loop.js               # agent loop (port of workerInner)
   ├─ llm.js                # OpenAI-compatible chat client
   ├─ prompt.js             # system-prompt composition (port of loadSystemPrompt)
   ├─ tools.js              # all tools + registerAllTools (port of tools.zig)
   ├─ PREFIX.md             # base system prompt (copied from source)
   └─ skills/
      └─ init.md            # built-in init skill (copied from source)
```

The tree is deliberately flat: one file per concern, no per-feature
subdirectories. `webui/` (the static UI) and `src/skills/` are the only
subdirectories.

---

## 14. Technology Choices

- **Node.js 24.x** (the currently installed runtime, `v24.14.1`). Plain
  **JavaScript (ESM, `type: "module"`)**, no TypeScript, no build step. Run
  directly with `node src/main.js`.
- **`node:sqlite`** (builtin) for storage. Available without a flag in Node 24;
  it currently emits an `ExperimentalWarning` — harmless, and we pin to the
  installed major (24) so behavior is stable for our purposes.
- **Express 5** for the HTTP layer (per requirement).
- **`node:fs/promises`**, **`node:child_process`** (`spawn` with `AbortSignal`)
  for tools. No shell injection — `run_command` uses `sh -c` explicitly, same as
  the source.
- **Native `fetch`** for LLM calls (OpenAI-compatible), with `AbortSignal` for
  timeout + stop. Startup patches the built-in global dispatcher
  (`globalThis[Symbol.for('undici.globalDispatcher.1')]`, no dependency) to set
  `headersTimeout`/`bodyTimeout` to `0`: undici bakes in a 300s headers/body
  timeout that cannot be overridden via `fetch` init options and would kill
  slow non-streaming turns with an opaque `"fetch failed"` error.
- **SSE** via a minimal helper over the Express response (no heavy deps).
- **`node:crypto.randomUUID`** for session ids.
- Minimal dependencies: `express` for the server, plus the web UI's browser
  libraries (`preact`, `htm`, `marked`, `dompurify`, `@tailwindcss/browser`) —
  those are `dependencies` because `src/app.js` serves their dist files to the
  browser under `/vendor/*` (offline, no CDN); the server never imports them
  as code. Everything else (SQLite, crypto, http, child_process) is built
  into Node.
- **TypeScript (dev-only, check-only)**: `typescript` and `@types/node` are
  dev dependencies used *solely* to type-check the plain-JS codebase — they
  never emit and are not part of the runtime or build. (The web UI's
  libraries double as type sources: `webui/*.js` imports them as bare
  specifiers, so `tsc --noEmit` resolves them from the same packages the
  server serves to the browser.) Run
  with `npm run typecheck` (i.e. `tsc --noEmit`), configured in `tsconfig.json`:
  `checkJs` + `allowJs` + `noEmit` with `strict: false`, plus `types: ["node"]`
  (the native `tsc` does not auto-include `@types` the way the JS compiler does).
  Both **`src/`** and **`webui/`** are type-clean (the SSE `onmessage`
  handler is cast to `MessageEvent` in `webui/api.js`).

---

## 15. Code Style

House style for the codebase — modern, idiomatic, **terse** JavaScript. These
are conventions, not lint-enforced. Keep the code clean under `npm run typecheck`
(`tsc --noEmit`, see §14) even though it is not lint-gated.

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

---

## 16. Security & Safety

- Bind to `127.0.0.1` by default; the server is not assumed to be public.
- **No path sandbox**: file and shell tools resolve relative paths against the
  session `cwd` and otherwise run with the server process's own permissions, so
  the agent can reach any path it can address (matching the source, whose
  path-traversal guard was only an unimplemented `TODO`). The trust boundary is
  the local user plus the `127.0.0.1` bind.
- `run_command` runs with the session `cwd` as the working directory; no
  privilege escalation.
- **DB isolation**: the SQLite file defaults to `~/.clowndb` (user-scoped).
  No cross-user access by default; `0600` on the file is recommended.
- No auth by design (single-user, local tool) — same posture as Clown-Code.
- LLM key never logged; request bodies are not logged by default.

---

## 17. Error Handling & Logging

- All async routes wrapped in an Express error middleware that maps thrown
  errors to the §7.7 table (LLM errors → 502/504; unknown id → 404; busy → 409;
  DB errors → 500).
- Per-session errors are captured in `SessionMeta.last_error` (persisted to the
  DB), emitted as an `error` SSE event, and the session returns to `idle` so it
  stays reusable.
- Structured logging (timestamp, session id, event) to stdout. A `--verbose`
  flag mirrors the source's debug logging (`src/log.zig`).
- The `node:sqlite` `ExperimentalWarning` is expected and not treated as an
  error.

---

## 18. Out of Scope (explicit)

- A terminal client, or any non-HTTP control surface.
- Authentication, multi-user tenancy, TLS termination (use a reverse proxy).
- External database server or any non-SQLite storage.
- Multi-process / concurrent-writer access to the same DB file (single writer).
- Session TTL / garbage collection (sessions persist in the DB until deleted).
- Writing per-session `session-*.json` files into project dirs (SQLite is the
  sole system of record).
- Changes to the LLM provider protocol beyond OpenAI-compatible chat.
- The two-phase **auto**-compact (still *planned* in the source): only the
  **manual** compact endpoint (§7.5) is in scope for v1.

---

## 19. Milestones (suggested build order)

1. Scaffold ESM/Express; config; `db.js` (open + migrate); `/health`, `/config`,
   `/models`.
2. `SessionManager` + `Session` shell (load-from-DB at startup, persist on
   change); `GET/POST/DELETE /sessions` with `?cwd` filter; `GET /projects`.
3. LLM client + agent loop + `read_file`/`run_command`/`write_todos`;
   `POST /messages`; SSE `events`.
4. Remaining tools (`write_file`, `edit_file`, `load_skill`).
5. Controls: `stop`, `undo`, `retry`, `clear`, `clear-tools`, `compact`,
   `init`.
6. `README.md`.
7. Minimal web UI at `/` (static Preact + htm page; see WEB_UI.md).

---

## 20. Open Questions

- **`cwd` matching**: exact match on the stored absolute path. Should
  `?cwd` support prefix/subtree matching (e.g. all sessions under a dir)?
  Current: exact match only.

(Resolved during review: a session persisted as `running`/`stopped` on restart
is reset to `idle` — no "interrupted" flag. Streaming is SSE, not WebSocket.)
