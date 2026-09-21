# Clown-Circus — Specification

A **headless, multi-session** agent server built on **Express**. Clown-Circus
manages any number of independent agent **sessions**, each with its own working
directory, conversation state, and running agent loop, all driven over REST +
Server-Sent Events. All sessions and their conversation state are persisted in a
local **SQLite** database.

- **Target runtime**: the currently installed **Node.js 24.x** (`v24.14.1`),
  TypeScript (`.ts`, ESM). The server has no build step — Node strips the
  types at runtime; the web UI's `.tsx` modules are bundled by esbuild at
  startup (§7.7).
- **Storage**: the builtin **`node:sqlite`** module (no external DB server).
- **No TUI, no terminal.** Everything is an HTTP endpoint.

---

## 1. Goals

- Implement the **agent core** (system-prompt composition, agentic tool loop,
  tools, compaction, retry/undo) in JavaScript.
- Run **many sessions concurrently** in a single long-lived server process.
- **Persist every session** (metadata + full conversation, one row per message) in a local
  SQLite database using Node's builtin `node:sqlite`, so state survives restarts.
- Provide a **headless REST + SSE API** that a client (web UI, CLI, CI, other
  services) can drive entirely over HTTP.
- Provide a **web UI** served at `/` so the server is usable out of the box in
  a browser. It is minimal for now (a thin Preact JSX (`.tsx`) page,
  esbuild-bundled at startup)
  and expected to grow over time — see [WEB_UI.md](WEB_UI.md) for the full
  description.
---

## 2. Non-Goals

- No terminal client.
- No authentication/authorization, rate limiting, or multi-tenancy hardening
  beyond binding to localhost by default (see §14).
- No change to the model provider contract: it still targets an OpenAI-compatible
  `/v1/chat/completions` endpoint (llama.cpp by default).
- No external database server — storage is embedded SQLite only.
- No distributed server / horizontal scaling.

---

## 3. Key Design Decisions

| Concern       | Choice |
|---------------|--------|
| Frontend      | Web UI served at `/` (Tailwind v4, project-grouped sidebar, model picker, full controls — see WEB_UI.md); headless API stays primary |
| Process model | In-process async loop, one active run per session |
| Sessions      | Many, each a `Session` object in a registry |
| Commands      | REST endpoints |
| Streaming     | SSE event stream per session |
| Persistence   | SQLite DB (`<home>/clown.db`), one row per session + one row per message, always written |
| CWD           | Per-session `cwd` (stored per row) |
| Tools         | Built-in tool set (§12) |
| System prompt | Base prompt + project instructions + discovered skills, composed per session cwd (§9) |

The agent loop's contract per session — "run the agent loop, emit messages,
report errors" — is implemented as an async loop plus event emitter. The
SQLite store is the sole system of record.

---

## 4. Architecture Overview

```
                         ┌──────────────────────────────────────────────┐
                         │                 Express app                  │
                         │                                              │
   HTTP clients ───────▶ │  REST routes  ──▶  SessionManager             │
   (REST + SSE)          │                    │                          │
                         │                    ├─ map<id, Session>        │
                         │                    │   (in-memory, hot state) │
                         │               └──▶ SQLite (~/.clown/clown.db)│
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

Component responsibilities live one-file-per-concern under `src/` — the file
list is in [AGENTS.md](AGENTS.md) (Source Structure).

### Concurrency model

The core constraints: **do not block the event loop** and **do not let two
runs of the same session interleave**.

- The agent loop is an in-process `async` loop; each `Session` has a
  single-flight `running` flag. Run-starting calls (`send`/`retry`/`compact`,
  §7.3–§7.4) reject (HTTP 409) while `running` is true unless the caller
  issues `stop` first.
- `stop` is cooperative cancellation: the loop checks the abort signal between
  turns and between tool calls, and in-flight LLM fetches / `run_command`
  child processes are aborted via the shared signal.
- Sessions are independent; a slow session never blocks others.

---

## 5. Data Model

### 5.1 Transcript (conversation content)

The per-session conversation is persisted **one message per row** in the
`messages` table: `data` is the JSON of one OpenAI chat message (`role`;
`content` as a string or an array of content parts; `tool_calls` on assistant
messages; `tool_call_id` on tool-result messages). A user message carrying
images is an array of content parts with base64 data-URLs. Rows are in
transcript order by rowid. It is an internal format and may evolve freely as
the tool grows — no DB migration is required.

The **system prompt is not stored**: it is derived from the session's `cwd`
at load time and at `clear` (§9), lives in memory as `messages[0]`, and is
included in `GET /sessions/:id` and `history` events so the web UI can show
it. `total_tokens` (the last LLM `usage.total_tokens`) is a column on the
`sessions` row.

### 5.2 SQLite schema

A single database **file**: `<home>/clown.db` in the clown home dir (default
`~/.clown`), which also holds the built-in skills (§12.1). Home is overridable
via `--home`/`CLOWN_HOME`. Created/migrated on startup
(`CREATE TABLE IF NOT EXISTS` ...); a legacy `~/.clowndb` is moved in on the
first run with the default home (§10.1).

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,               -- UUIDv4
  cwd           TEXT NOT NULL,                  -- absolute working directory
  model         TEXT NOT NULL,                    -- last model used (set on send); the web UI pre-fills its picker from it
  reasoning_effort TEXT,                          -- nullable; last-used 'low'|'medium'|'high'|'xhigh' (set on send); sent with every LLM call when set
  status        TEXT NOT NULL DEFAULT 'idle',   -- idle | running | error | stopped
  created_at    TEXT NOT NULL,                  -- ISO 8601
  last_activity TEXT NOT NULL,                  -- ISO 8601
  last_error    TEXT,                           -- nullable
  total_tokens  INTEGER NOT NULL DEFAULT 0,     -- last LLM usage.total_tokens
  archived      INTEGER NOT NULL DEFAULT 0,     -- 0/1; hidden from the default list
  title         TEXT                            -- nullable; auto-set from the first user-sent message
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- global; per-session order = order of id (gaps after deletes are fine)
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  data       TEXT NOT NULL                      -- JSON message (the system prompt is never stored)
);

CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions (cwd);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id);
```

> `archived` (schema v2) is a plain boolean flag: archived sessions persist in
> the DB and stay in the in-memory registry, but are excluded from the default
> `GET /sessions` list (§7.2). Adding the
> column to a v1 database is the v2 migration (`ALTER TABLE ... ADD COLUMN`,
> §10.2). The `messages` table, the `total_tokens` column, and the removal of
> the old `snapshot` column are the v3 migration (§10.2).
>
> `title` (schema v4) is the session's human-readable name: set **once**, from
> the first user-*sent* message (whitespace collapsed, capped at 80 chars), so
> internal prompts that go through `run()` (compact) can never claim it.
> `clear` resets it to null (a fresh conversation titles itself anew);
> `compact` keeps it across its internal clear (a continuation of the same
> conversation); `fork` copies it; an image-only first send leaves it null.
>
> `reasoning_effort` (schema v5) rides along with `model`: it is the
> `reasoning_effort` field sent in every `/v1/chat/completions` request of a
> run (both vLLM and llama.cpp accept it), one of `low`/`medium`/`high`/`xhigh`,
> or null (unset — the field is then omitted from the request entirely, so
> backends without it are never affected). Like the last-used model, `retry`/
> `init`/`compact` reuse it and `fork` copies it.
> Sessions persisted before v4 are backfilled at startup from their first user
> message. The web UI falls back to the `cwd` basename when it is null.

### 5.3 Runtime model

A `Session` object (in memory) = the DB row's fields + the transcript loaded
from the session's `messages` rows (with the derived system prompt prepended) +
runtime state (`running`, `abortController`, `EventEmitter`, LLM client).

A **`SessionMeta`** is what the API exposes for listing (derived from the row;
the raw `messages` are not included in list responses):

```js
// SessionMeta
// {
//   id, cwd, model, status, created_at, last_activity, last_error?,
//   message_count,   // = messages.length (incl. the derived system prompt)
//   total_tokens,    // = sessions.total_tokens
//   archived,        // boolean; false by default
//   title            // nullable string; auto-set from the first user-sent message (§5.2)
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
(hide) / `POST /sessions/:id/unarchive` (restore), §7.4. It is a
metadata-only edit — allowed while running (no `409`), it never touches the
conversation — and it survives restarts like every other field. Archived
sessions are excluded from the default `GET /sessions` list, but remain
fully addressable by id (detail, controls, SSE) and deletable.

**Persistence is continuous**: the DB is the system of record, so state is
written on every transition (create, message, tool result, status change, error,
delete) — not just on an explicit save. Each appended message is one `messages`
row written the moment it exists; the `sessions` row is upserted on the other
transitions. This is the natural consequence of SQLite being the store (it is
not an optional "auto-save" feature).

**Restart semantics**: at startup the `SessionManager` loads all rows into
memory. A session whose persisted `status` is `running`/`stopped` (i.e. it was
mid-run when the process died) is reset to `idle`, because an in-flight loop
cannot survive a restart.

### ID scheme

UUIDv4, generated by the server. Stable and unique in
the DB. Clients persist the `id` to address a session across requests/restarts.

---

## 7. HTTP API

Base path: `/`. All bodies are JSON. All responses are JSON except the SSE
endpoint and the static web UI (§7.7). Errors use `4xx`/`5xx` with
`{ "error": { "code", "message" } }`.

### 7.1 Server / models

| Method | Path            | Description |
|--------|-----------------|-------------|
| `GET`  | `/health`       | Liveness probe → `{ "ok": true, "sessions": <n> }` |
| `GET`  | `/models`       | Proxy `GET /v1/models` to the LLM (analog of `/models` command) |
| `GET`  | `/config`       | Read-only effective server config (base_url, home, timeout_ms, host, port) |

### 7.2 Sessions

| Method | Path                 | Description |
|--------|----------------------|-------------|
| `GET`  | `/sessions`          | List sessions as `SessionMeta[]`. Optional `?cwd=<path>` to filter by working directory (exact match), and `?archived=` (see below). |
| `POST` | `/sessions`          | Create a session |
| `GET`  | `/sessions/:id`      | Full session: `SessionMeta` + current `messages` (incl. the derived system prompt) |
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
  "model": "llama-3",
  "reasoning_effort": "medium"
}
```

- `cwd` is the session's working directory. It **must** be an absolute path —
  relative paths are rejected with `400` `bad_request`. It is stored and used
  as given.
- `model` — the LLM model to run (non-empty string). It is stored as the
  session's **last-used model**: each `POST /sessions/:id/messages` (§7.3)
  specifies the model for its run and the value is persisted — the web UI
  pre-fills its model picker from it, and `retry`/`init`/`compact` reuse it.
  There is no server-side default: the client always says which model to use.
- `reasoning_effort` — **optional** (`low`/`medium`/`high`/`xhigh`); when
  present it is stored as the session's last-used value and sent with every
  LLM call of its runs (§8). Absent or `null` → null (the field is then
  omitted from the LLM request); any other value → `400` `bad_request`.
- `201` on success, returning the created session (meta + messages).
- `400` if `cwd` or `model` is missing, `cwd` is not absolute, or
  `reasoning_effort` is not a known level; `500` if the `cwd` path is not a
  directory.

`GET /sessions/:id` response:

```json
{
  "id": "...",
  "cwd": "/abs/path",
  "model": "llama-3",
  "reasoning_effort": "medium",
  "status": "idle",
  "created_at": "2026-09-02T12:00:00.000Z",
  "last_activity": "2026-09-02T12:05:00.000Z",
  "message_count": 42,
  "total_tokens": 18334,
  "last_error": null,
  "archived": false,
  "title": "what is this project about?",
  "messages": [ { "role": "system", "content": "…" }, { "role": "user", "content": "…" } ]
}
```

### 7.3 Sending messages

| Method | Path                            | Description |
|--------|---------------------------------|-------------|
| `POST` | `/sessions/:id/messages`        | Append a user message and start the agent loop |

Body: `{ "message": "help me fix the tests", "model": "llama-3", "reasoning_effort": "medium" }` or
`{ "message": [{"type":"text","text":"describe this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}] }`.

- `message` is a **non-empty string** (text-only, the common case) or a
  **non-empty `ContentPart[]`** (multimodal; OpenAI content-parts shape).
  Image data is carried as base64 data-URLs inside the JSON body (no multipart
  upload). The JSON body limit is **25 MB** to accommodate a few capped images.
- `model` is **required**: the model to run this send on (non-empty string;
  `400` `bad_request` if missing or empty). It is pinned for the whole run and
  persisted as the session's last-used model (the value the web UI pre-fills
  its picker from; `retry`/`init`/`compact` reuse it).
- `reasoning_effort` is **optional** (`low`/`medium`/`high`/`xhigh`). When
  present (including explicit `null`) it pins the run's value and overwrites
  the session's last-used one; when absent the session's stored value is kept.
  It is sent in the LLM request body of every call of the run (omitted when
  null); any other value → `400` `bad_request`.
- `202 Accepted` immediately: `{ "id", "status": "running" }`. The run is
  asynchronous; progress is delivered over the SSE stream (§8) and reflected in
  `GET /sessions/:id`.
- `409 Conflict` if the session is already `running` (client should `stop` first
  or wait).
- `404` if the session does not exist.

### 7.4 Session controls

All of these operate on a single session. The `Slash cmd` column is the web
UI's composer command that dispatches the same action.

| Method | Path                       | Slash cmd      | Behavior |
|--------|----------------------------|----------------|----------|
| `POST` | `/sessions/:id/stop`       | `/stop`        | Cooperatively abort the running loop. `200` `{ "status": "stopped" }`. No-op (still `200`) if idle. |
| `POST` | `/sessions/:id/undo`       | `/undo`        | Pop the last message from history. Returns the popped message text (if any) in `{ "undone": "..." }`. |
| `POST` | `/sessions/:id/retry`      | `/retry`       | Strip trailing assistant/tool messages (keep last user message) and re-run. `202` when it starts a run, `409` if busy. |
| `POST` | `/sessions/:id/retry-turn` | `/retry-turn`  | Like `/retry`, but rolls back to just before the **last assistant message** (stripping it, any tool results it spawned, and anything after) instead of the last user message — reaching a poisoned mid-turn response that the `/retry` rollback can't get to. `202` when it starts a run, `409` if busy, `400` if there is no assistant message to retry. |
| `POST` | `/sessions/:id/clear`      | `/clear`       | Stop + clear history (keep system message). `200`. |
| `POST` | `/sessions/:id/trim`       | `/trim [n]`     | Trim the transcript, **keeping the last n assistant turns untouched**: in every earlier turn, truncate long `role=tool` results and delete assistant reasoning. User text, assistant text, and tool-call invocations (name + arguments) are untouched. `n` may exceed the turn count (a no-op) or be `0` (trim everything); idempotent. Body `{ "keep": n }` with `n` a non-negative integer — `400` otherwise. `200` `{ "keep", "trimmed", "truncatedResults", "reasoningRemoved" }`. |
| `POST` | `/sessions/:id/compact`    | `/compact`     | Run the two-phase summarize-then-replace compaction. `202` (starts a run). |
| `POST` | `/sessions/:id/init`       | `/init`        | Convenience: send the prompt that triggers the built-in `init` skill ("Could you /init this project?"). `202`. |
| `POST` | `/sessions/:id/fork`     | `/fork`        | Fork the session into a new one: same `cwd`, `model`, and archived flag; fresh id/timestamps; `last_error` cleared; a **deep copy** of the transcript (independent of the source). If the source is running and the copy ends mid-turn (an assistant `tool_calls` whose tool results have not all arrived yet — an invalid LLM transcript), that message and its partial results are stripped; a completed transcript is copied verbatim. Allowed while the source is running. `201`, returning the new session (meta + messages). `404` if the source is unknown. |
| `POST` | `/sessions/:id/archive`    | —              | Mark the session as archived: kept in the DB but hidden from the default `GET /sessions` list. No body. `200` `{ "id", "archived": true }`. |
| `POST` | `/sessions/:id/unarchive`  | —              | Restore an archived session to the default list. No body. `200` `{ "id", "archived": false }`. |

Rules common to the run-starting controls (`retry`, `retry-turn`, `compact`,
`init`, `messages`): reject with `409` if `running` is already true. Only
`stop` and the `archive`/`unarchive` flags are allowed while running —
metadata-only edits that never touch the conversation — and `fork`
deep-copies the transcript into an independent session (the source is never
touched, even while it runs).

`undo`/`clear`/`trim` are synchronous state edits; if a run is in
progress they implicitly `stop` first.

### 7.5 Events (SSE)

| Method | Path                          | Description |
|--------|-------------------------------|-------------|
| `GET`  | `/sessions/:id/events`        | Server-Sent Events stream of session activity |

Clients connect with `Accept: text/event-stream` (e.g. a browser `EventSource`) and receive
incremental updates in real time.

Event types (SSE `event:` field):

| Event      | Data (JSON)                              | Emitted when |
|------------|------------------------------------------|--------------|
| `message`  | `{ "message": <Message> }`               | Every appended message (user, assistant turn, tool result) |
| `history`  | `{ "messages": <Message[]> }`            | Full transcript (incl. system) after a destructive edit (undo/clear/trim/retry/retry-turn); also sent as a synthetic resume event when the replay ring can't cover the gap (below) |
| `status`   | `{ "status": "running"\|"idle"\|"error"\|"stopped" }` | On state transitions |
| `error`    | `{ "message": "..." }`                   | On a loop error |
| `done`     | `{ "total_tokens": n }`                  | When a run completes |
| `pong`     | `{}`                                     | In response to a client `ping` (keepalive) |

- The stream supports an optional `?since=<seq>` query (monotonic per-session
  sequence number) to replay missed events after a reconnect. Each event carries
  an incremental `id:` (the seq) for `Last-Event-ID` resume.
- **Gap recovery**: the replay ring is bounded. If the client's `since` is
  older than the ring's oldest event, a partial replay of granular `message`
  events would desync the transcript — instead the server sends a single
  synthetic `history` event (id = current seq) with the full transcript and no
  ring replay follows; the client replaces its state.
- A **fresh** connection (no `?since` and no `Last-Event-ID`) does **not**
  replay the backlog — it streams live events only. A client loads the current
  transcript from `GET /sessions/:id` and uses the (bounded) ring buffer purely
  to catch up after a brief disconnect; replaying the whole history on first
  connect would just make it re-render / flicker through every past transition.
- The connection stays open until the client disconnects or the session is
  destroyed (server sends a final `status: stopped` + close).
- Heartbeat: an SSE comment line (`: keep-alive`) every 15s to keep proxies open.

> **Rationale**: a single SSE stream per session keeps clients simple. WebSockets
> are a non-goal; SSE is sufficient for one-way server→client streaming.

### 7.6 Errors

| HTTP | `code`            | Meaning |
|------|-------------------|---------|
| `400`| `bad_request`     | Malformed body / missing `cwd` or `model` / bad `reasoning_effort` / empty `cwd` filter |
| `404`| `not_found`       | Unknown session id |
| `409`| `session_busy`    | Run-starting call while `running` is true |
| `500`| `internal`        | Unhandled server error (incl. DB errors) |
| `502`| `llm_unavailable` | The LLM endpoint is unreachable / returns an error |
| `504`| `llm_timeout`     | The LLM request exceeded the configured timeout |

### 7.7 Web UI

A web UI is served at `GET /` from `webui/`: a thin `index.html` shell
(a single `#root` mount) plus a set of small **Preact JSX**
(`.tsx`) modules and helpers (the file list is in [AGENTS.md](AGENTS.md)).
At server startup, esbuild bundles the modules and their browser dependencies
(from `node_modules`) into `webui/vendor/bundle.js`, the only `<script>` in
the shell, and `@tailwindcss/cli` compiles `webui/styles.css` (Tailwind v4 +
the colour tokens + plain CSS) into `webui/vendor/tailwind.css`, the shell's
one `<link>`; background watches keep both fresh. No network CDNs, no
`node_modules` static mounts — the UI works fully offline. It is a **pure
client** of the API in this section — it adds no server logic, routes, or
dependencies.

The authoritative description of the UI — features, constraints/invariants,
and the current gaps it is expected to grow into — lives in
[WEB_UI.md](WEB_UI.md).

---

## 8. Agent Loop

The core loop, once `send` is called, is:

```
running = true; emit status=running; persist(status)
loop:
    turn = await agent.next()        # one LLM chat completion; appends the assistant msg (persist + emit `message`)
    if !turn.tool_calls: break
    for tc in turn.tool_calls:       # cooperative: check the abort signal between calls
        await tools[tc.function.name](tc.function.arguments, sessionCtx)   # appends a role=tool result (persist + emit `message`)
emit status=idle, done; persist(status)
```

- `agent.next()` is one call to the LLM with `model` (plus `reasoning_effort`,
  when the session has one set — the field both vLLM and llama.cpp accept) +
  `messages` + tool definitions. It
  appends the assistant message (with any `tool_calls`) before returning, so the
  turn is already in history by the time the loop advances.
- `acceptAll` = execute every requested tool, append `role=tool` results, and
  loop again so the model can react.
- The loop ends when the model returns a turn with **no** tool calls.
- Each iteration checks the session's `AbortController`; if aborted, it stops
  cleanly, emits `status=stopped`, and persists.
- Token accounting uses the `usage` field from the LLM response
  (analog of `agent.total_tokens`).
- **Persist + emit each appended message the moment it exists.** The assistant
  turn is written to its `messages` row and streamed as a `message` event as
  soon as `next()` returns, *then* the tools run; each tool result is
  persisted + streamed the same way. This makes the model's intent durable and
  visible to the client before any (possibly long or destructive) side effect,
  and keeps the DB current if the process dies mid-run (recoverable as far as
  the last persisted message).

### Cancellation

`stop` calls `session.abortController.abort()`. The loop:
1. Cancels any in-flight LLM `fetch` (via the shared `AbortSignal`).
2. Aborts any in-flight `run_command` child process.
3. Checks the signal at the top of each turn and between tool calls.

Because the loop is cooperative, a tool call that ignores the signal is the only
thing that can delay a stop.

---

## 9. System Prompt

Composed **per session, from the session's `cwd`**, at session creation, and
re-composed on `clear`-style resets. It is **never persisted** — it is
re-derived from the on-disk `AGENTS.md`/`CLOWN.md` at every server restart as
well, so an out-of-band edit to those files is picked up on the next start:

```
Current date: <YYYY-MM-DD, local>
Current working directory: <realpath of cwd>

<PREFIX>                          (inlined template in ./src/prompt.ts;
                                   its "When Using Skills" section carries
                                   the discovered skill list, §12.1)

<AGENTS.md>                       (from cwd) if present,
  else <CLOWN.md>                 (from cwd) if present,
  else (omitted)
```

- The exact fallback chain is `AGENTS.md → CLOWN.md → (none)`.
- The system message is `messages[0]` and is the only message retained by
  `clear`.
- The base guidelines are inlined in `prompt.ts`; their tool names match the
  registered tools.
- The prefix's "When Using Skills" section lists every discovered skill
  (**name**, description, `SKILL.md` path) plus the instruction to load one
  with `read_file` — the description is the routing signal; there is no
  dedicated skill tool (§12.1).

---

## 10. Persistence (SQLite)

### 10.1 Storage

- **Location**: a single database **file** `<home>/clown.db` inside the clown
  home dir (default `~/.clown`), which also holds the built-in skills
  (§12.1). Home is overridable via `--home`/`CLOWN_HOME`.
- **Legacy migration**: on the first run with the **default** home, an
  existing `~/.clowndb` is moved to `<home>/clown.db` (never overwriting an
  existing `clown.db`). An explicit `--home`/`CLOWN_HOME` disables the
  migration.
- **Engine**: Node's builtin `node:sqlite` (`node:sqlite` `DatabaseSync`). No
  external server, no npm dependency.
- **Journal mode**: use the default rollback journal (do **not** enable WAL).
  WAL would create `-wal`/`-shm` sidecar files next to the DB; staying on the
  default keeps the database a single self-contained file, which is the whole
  point of a single-file home. (The transient `-journal` file only exists mid-write
  and is removed on commit.)
- **Writes**: synchronous — each appended message is one `messages` INSERT (or
  DELETE/UPDATE for the transcript edits), each session state change a
  `sessions` upsert. The DB is owned by exactly one server process
  (single-writer assumption), so WAL's read concurrency benefit is not needed
  here.

### 10.2 Migration

On startup the server runs idempotent DDL (`CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`) against the *current* schema, then applies
versioned migrations gated on the `user_version` pragma. Fresh DBs are born
matching the current version (the DDL already carries every column) and only
get the version bump.

| Version | Change |
|---------|--------|
| 1 | Initial schema |
| 2 | `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0` (§5.2) |
| 3 | `messages` table (one row per message); `sessions.total_tokens` column; v2 `snapshot` blobs imported into `messages` (system prompts dropped) and `ALTER TABLE sessions DROP COLUMN snapshot` (§5.2) |
| 4 | `ALTER TABLE sessions ADD COLUMN title TEXT` — the auto-title column (§5.2) |
| 5 | `ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT` — the last-used reasoning-effort column (§5.2) |

---

## 11. Configuration

Via CLI flags and/or environment variables, resolved at startup into a
`Config` object exposed read-only at `GET /config`.

| Flag / Env                 | Env fallback     | Default                  | Meaning |
|----------------------------|------------------|--------------------------|---------|
| `--port` / `PORT`          | `PORT`           | `8790`                   | HTTP listen port |
| `--host` / `HOST`          | `HOST`           | `127.0.0.1`              | Bind address (localhost default for safety) |
| `--home` / `CLOWN_HOME`    | `CLOWN_HOME`     | `~/.clown`               | Clown home dir — holds `clown.db` + `skills/`; created if missing |
| `--base-url` / `CLOWN_API` | `CLOWN_API`      | `http://127.0.0.1:8080`  | LLM OpenAI-compatible base URL |
| `--timeout` / `CLOWN_TIMEOUT_MS` | `CLOWN_TIMEOUT_MS` | `900000` (15 min)      | Per-LLM-request timeout |

- The home dir is created (with parents) if missing; with the default home
  only, a legacy `~/.clowndb` is migrated in on first run (§10.1).
- LLM auth (`Authorization` header) is passed through from an optional
  `CLOWN_API_KEY` env var, sent with every LLM request.

---

## 12. Tools

Each tool is registered with a **snake_case name**, a one-line description, a
JSON-Schema for args, and an implementation. A leading `~/` (or bare `~`)
expands to the user home; relative paths then resolve against the session's
`cwd` (the same directory `run_command` runs in). There is **no path
sandbox**: the agent may read, write, and execute anywhere the server
process can reach.

| Tool            | Args                                            | Notes |
|-----------------|--------------------------------------------------|-------|
| `read_file`     | `path`, `raw?: bool`                             | Line-number prefix `N:content` unless `raw`. 2MB limit. UTF-8 validated for text. Images (PNG/JPEG/WebP/GIF, detected by magic bytes) are returned as a base64 `image_url` content part so a vision model can see them. |
| `write_file`    | `path`, `content`                                | Creates parent dirs. |
| `edit_file`     | `path`, `old_content`, `new_content`, `replace_all?: bool` | Exact-match replace; errors on 0 or >1 matches unless `replace_all`. Exact-string semantics only (no line-range/sed edits). |
| `run_command`   | `command`, `cwd?: string`                        | Runs `sh -c`; captures stdout+stderr (2MB limits); abortable on stop. |
| `write_todos`  | `content: string (markdown)`                   | No-op: the tool call's presence in the transcript IS the todo list (the web UI derives it from messages). Returns `Todos updated`. |

### 12.1 Skills

Specialized instructions the model loads **with `read_file`** — there is no
dedicated skill tool. Standard layout: `<root>/<name>/SKILL.md` with YAML
frontmatter (`description` required; `name` optional, defaults to the
directory name). Discovery roots, highest precedence first (a same-named
skill in a closer root wins):

1. `<cwd>/.agents/skills/` — project
2. `~/.agents/skills/` — user
3. `<home>/skills/` — clown home (built-ins)

Built-in skills live at `<home>/skills/<name>/SKILL.md` and are seeded on
startup when missing; the user may edit or delete the seeded files. There are
two: `init` (explore the project and write an `AGENTS.md`) and `make_skill`
(meta: how to author a new skill). Discovered skills are listed in the system
prompt (§9) — one bullet per skill: **name**, description, and its
`SKILL.md` path (shortened: `./` under the session cwd, `~` under the user
home, absolute otherwise); the description is the routing signal.

Tool result values are returned to the model as text (strings / structured
values serialized to JSON). A tool may instead return an OpenAI content-part
array, which is stored and sent verbatim as the tool message's `content` —
`read_file` on an image returns a `text` caption + `image_url` (data-URL)
part. `trim` counts such results at their serialized size and truncates them
like any bulky tool result.

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

## 13. Technology Choices

- **Node.js 24.x** (the currently installed runtime). The server is
  **TypeScript (`.ts`, ESM)** run directly by Node's built-in type stripping
  (`node src/main.ts` — no build step); the web UI is untyped JSX (`.tsx`)
  modules bundled by esbuild at startup (§7.7).
- **`node:sqlite`** (builtin) for storage — no external server, no npm
  dependency. It currently emits an `ExperimentalWarning` (harmless; see §15).
- **Express 5** for the HTTP layer; **SSE** via a minimal helper over the
  Express response.
- **Native `fetch`** for LLM calls (OpenAI-compatible), with an abort signal
  for timeout + stop.
- **`node:child_process`** for `run_command` (abortable child process).
- Minimal dependencies: `express`, `esbuild`, `@tailwindcss/cli` (builds the
  web-UI stylesheet at startup), and the web UI's browser libraries
  (`preact`, `marked`, `dompurify`) —
  everything else is built into Node. `typescript` + `@types/node` are
  dev-only and check-only (`npm run typecheck` → `tsc --noEmit`, config in
  `tsconfig.json`); they never emit and are not part of the runtime or build.

---

## 14. Security & Safety

- Bind to `127.0.0.1` by default; the server is not assumed to be public.
- **No path sandbox**: file and shell tools expand a leading `~/` to the user
  home, resolve relative paths against the session `cwd`, and otherwise run
  with the server process's own permissions, so
  the agent can reach any path it can address. The trust boundary is
  the local user plus the `127.0.0.1` bind.
- `run_command` runs with the session `cwd` as the working directory; no
  privilege escalation.
- **DB isolation**: the SQLite file defaults to `~/.clown/clown.db` (user-scoped).
  No cross-user access by default; `0600` on the file is recommended.
- No auth by design (single-user, local tool).
- LLM key never logged; request bodies are not logged by default.

---

## 15. Error Handling & Logging

- All async routes wrapped in an Express error middleware that maps thrown
  errors to the §7.6 table (LLM errors → 502/504; unknown id → 404; busy → 409;
  DB errors → 500).
- Per-session errors are captured in `SessionMeta.last_error` (persisted to the
  DB), emitted as an `error` SSE event, and the session returns to `idle` so it
  stays reusable.
- Structured logging (timestamp, session id, event) to stdout. A `--verbose`
  flag enables debug logging.
- The `node:sqlite` `ExperimentalWarning` is expected and not treated as an
  error.

---

## 16. Out of Scope (explicit)

- A terminal client, or any non-HTTP control surface.
- Authentication, multi-user tenancy, TLS termination (use a reverse proxy).
- External database server or any non-SQLite storage.
- Multi-process / concurrent-writer access to the same DB file (single writer).
- Session TTL / garbage collection (sessions persist in the DB until deleted).
- File-based session exports (SQLite is the sole system of record).
- Changes to the LLM provider protocol beyond OpenAI-compatible chat.
- The two-phase **auto**-compact: only the **manual** compact endpoint (§7.4)
  is in scope for v1.

