# Clown-Circus — Specification

A **headless, multi-session** agent server built on **Express**, with a
**web UI** as its sole public interface. Clown-Circus manages any number of
independent agent **sessions**, each with its own working directory,
conversation state, and running agent loop, all driven through the web UI
(served at `/`), which is a pure client of the server's internal REST +
Server-Sent Events API. All sessions and their conversation state are
persisted in a local **SQLite** database.

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
- Expose a **REST + SSE HTTP API** as the server's **internal** interface —
  not a stable contract; expect endpoints to change (§7).
- Provide a **web UI** served at `/` — the **sole public interface** — a pure
  client of that internal API (Preact JSX (`.tsx`) modules, esbuild-bundled
  at startup), so the server is usable out of the box in a browser. It is
  expected to grow over time — see [WEB_UI.md](WEB_UI.md) for the full
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
| Frontend      | Web UI served at `/` (Tailwind v4, project-grouped sidebar, model picker, full controls — see WEB_UI.md) is the sole public interface; the headless API is internal (§7) |
| Process model | In-process async loop, one active run per session |
| Sessions      | Many, each a `Session` object in a registry |
| Commands      | REST endpoints |
| Streaming     | SSE event stream per session |
| Persistence   | SQLite DB (`<home>/clown.db`), one row per session + one row per message, always written |
| CWD           | Per-session `cwd` (stored per row): an absolute local path, or an `ssh://` URL for a remote session (§7.2) |
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
   Web UI (browser) ───▶ │  REST routes  ──▶  SessionManager             │
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
                          Filesystem + shell (per-session cwd; over ssh for
                          remote (ssh://) sessions)
                                              │
                                              ▼
                          LLM: OpenAI-compatible /v1/chat/completions
                          (llama.cpp, default http://127.0.0.1:8080)
```

Component responsibilities live one-file-per-concern under `server/` — the file
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
  cwd           TEXT NOT NULL,                  -- absolute working directory (or an ssh:// URL, §7.2)
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

1. **Created** via `POST /sessions` with a `cwd` (absolute local path or an
   `ssh://` URL, §7.2) and a `model` (both required). A row is inserted into
   SQLite and the session is loaded into memory. Status `idle`.
2. **Running** when an agentic loop is active (after a message/retry/compact).
   Every state change is upserted to SQLite.
3. **Idle** again when the loop finishes.
4. **Error** if the loop throws; `last_error` is set and persisted. The session
   remains reusable — a new message starts a fresh run.
5. **Destroyed** via `DELETE /sessions/:id` (aborts any running loop, kills
   any commands the session spawned — in-flight or backgrounded — removes
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
cannot survive a restart. Remote sessions' remote state (their tmux session)
can't be re-attached either, so at startup the remote tmux session of every
loaded remote session is killed — fire-and-forget, best-effort over ssh
(§14).

### ID scheme

UUIDv4, generated by the server. Stable and unique in
the DB. Clients persist the `id` to address a session across requests/restarts.

---

## 7. HTTP API (internal)

> **Internal API.** The web UI (§7.7) is the **sole public interface**; this
> API is its backend and not a stable contract — endpoints, request/response
> shapes, and error codes may change without notice.

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
| `GET`  | `/sessions`          | List sessions as `SessionMeta[]`. Optional `?archived=` flag (see below). |
| `POST` | `/sessions`          | Create a session |
| `GET`  | `/sessions/:id`      | Full session: `SessionMeta` + current `messages` (incl. the derived system prompt) |
| `DELETE`| `/sessions/:id`     | Stop and delete the session (from memory and DB) |

`GET /sessions`:
- Returns non-archived sessions by default.
- `?archived` is a boolean flag:
  - present and `"true"`/`"1"` → **include** archived sessions (the web UI uses
    this to fetch everything, then splits archived/non-archived client-side)
  - absent, `"false"`, or `"0"` → **non-archived only** (the default)

`POST /sessions` body (`cwd` and `model` required):

```json
{
  "cwd": "/abs/path/to/project",
  "model": "llama-3",
  "reasoning_effort": "medium",
  "create": false
}
```

- `cwd` is the session's working directory. It **must** be an absolute local
  path (relative paths are rejected with `400` `bad_request`) or an
  `ssh://[user@]host[:port]/absolute/path` URL — a **remote session**, whose
  working directory lives on the remote host. Remote cwds are validated over
  ssh at create: the host must be reachable and **tmux** must be installed on
  it (the command model needs it, §12). It is stored and used as given.
  Percent-encoding in the URL is decoded, so `ssh://host/my%20path` targets
  the remote directory `/my path`.
  > **TODO**: the remote file ops assume GNU `base64` (`base64 -d` decodes);
  > macOS remotes use BSD `base64` (`-D`), so validation and every file op
  > fail there with misleading errors (an existing dir reads as missing —
  > `404` — and `create` fails `500`). Either document remote sessions as
  > Linux-only or add a decode fallback.
- `model` — the LLM model to run (non-empty string). It is stored as the
  session's **last-used model**: each `POST /sessions/:id/messages` (§7.3)
  specifies the model for its run and the value is persisted — the web UI
  pre-fills its model picker from it, and `retry`/`init`/`compact` reuse it.
  There is no server-side default: the client always says which model to use.
- `reasoning_effort` — **optional** (`low`/`medium`/`high`/`xhigh`); when
  present it is stored as the session's last-used value and sent with every
  LLM call of its runs (§8). Absent or `null` → null (the field is then
  omitted from the LLM request); any other value → `400` `bad_request`.
- `create` — **optional** boolean (default `false`). When `true`, a
  **missing** `cwd` is created (recursively, including absent parents)
  instead of rejected; ignored when the `cwd` already exists. For a remote
  cwd the creation happens on the remote host.
- `201` on success, returning the created session (meta + messages).
- `400` `bad_request` if `cwd` or `model` is missing, `cwd` is not absolute
  (local) or not a well-formed `ssh://` URL (remote), `cwd` exists but is not
  a directory, or `reasoning_effort` is not a known level.
- `404` `not_found` if `cwd` does not exist (unless `create: true`).
- `502` `remote_unavailable` if the remote host is unreachable or tmux is not
  installed on it (create only).
- `500` `internal` if creating the (remote) directory fails (e.g.
  permissions).

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
| `POST` | `/sessions/:id/undo`       | `/undo`        | Pop the last message from history. Returns the popped message text (if any) in `{ "undone": "..." }`. Also clears `last_error` and settles a transient status (`error`/`stopped`) back to `idle` — the popped tail is the completion the error described. |
| `POST` | `/sessions/:id/undo-turn` | `/undo-turn`   | Strip the last **tool-calling turn** — the most recent assistant `tool_calls` message and the tool results answering it — **without re-running**; the rest of the transcript (e.g. a later final reply) is kept. `200` `{ "undone": "name(args) · …" }` — a one-line summary of the stripped turn (the client flashes it). Also clears `last_error` and settles a transient status back to `idle` (same rule as `undo`). `400` if there is no tool-calling turn. |
| `POST` | `/sessions/:id/retry`      | `/retry`       | Strip trailing assistant/tool messages (keep last user message) and re-run. `202` when it starts a run, `409` if busy. |
| `POST` | `/sessions/:id/retry-turn` | `/retry-turn`  | Like `/retry`, but rolls back to just before the **last assistant message** (stripping it, any tool results it spawned, and anything after) instead of the last user message — reaching a poisoned mid-turn response that the `/retry` rollback can't get to. `202` when it starts a run, `409` if busy, `400` if there is no assistant message to retry. |
| `POST` | `/sessions/:id/clear`      | `/clear`       | Stop + clear history (keep system message). Clears `last_error` and settles a transient status back to `idle`. `200`. |
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

`undo`/`undo-turn`/`clear`/`trim` are synchronous state edits; if a
run is in progress they implicitly `stop` first.

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
| `history`  | `{ "messages": <Message[]> }`            | Full transcript (incl. system) after a destructive edit (undo/undo-turn/clear/trim/retry/retry-turn); also sent as a synthetic resume event when the replay ring can't cover the gap (below) |
| `status`   | `{ "status": "running"\|"idle"\|"error"\|"stopped", "last_error": string\|null }` | On state transitions. `last_error` is included so clients update their error banner on the transition itself (a run start clears it; a failed run sets it) |
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
| `400`| `bad_request`     | Malformed body / missing `cwd` or `model` / bad `reasoning_effort` |
| `404`| `not_found`       | Unknown session id / `cwd` missing on create (without `create: true`) |
| `409`| `session_busy`    | Run-starting call while `running` is true |
| `500`| `internal`        | Unhandled server error (incl. DB errors) |
| `502`| `llm_unavailable` | The LLM endpoint is unreachable / returns an error |
| `502`| `remote_unavailable` | The remote host of an `ssh://` cwd is unreachable (create), or tmux is not installed on it |
| `504`| `llm_timeout`     | The LLM request exceeded the configured timeout |

### 7.7 Web UI

The web UI — the **sole public interface** — is served at `GET /` from
`webui/`: a thin `index.html` shell (a single `#root` mount) plus a set of
small **Preact JSX** (`.tsx`) modules and helpers (the file list is in
[AGENTS.md](AGENTS.md)).
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
2. Aborts any in-flight `run_command` — locally, its whole process tree
   (`SIGKILL` to its process group); on a remote session, by killing the
   command's remote tmux window (its whole tree). A command already left
   running in the background past the 60s timeout survives `stop` (both
   local and remote) — stopping it is the agent's job (§12).
3. Checks the signal at the top of each turn and between tool calls.

Because the loop is cooperative, a tool call that ignores the signal is the only
thing that can delay a stop.

---

## 9. System Prompt

Composed **per session, from the session's `cwd`**, at session creation, and
re-composed on `clear`-style resets. It is **never persisted** — it is
re-derived from the on-disk `AGENTS.md` at every server restart as
well, so an out-of-band edit to those files is picked up on the next start:

```
Current date: <YYYY-MM-DD, local>
Current working directory: <realpath of cwd>

<PREFIX>                          (inlined template in ./server/prompt.ts;
                                   its "When Using Skills" section carries
                                   the discovered skill list, §12.1)

<AGENTS.md>                       (from cwd) if present, else omitted
```

- There is no fallback — a missing `AGENTS.md` appends nothing.
- **Remote (ssh://) sessions** differ in exactly two places: the working
  directory line names the remote directory plus the host it is reached on,
  and — since skill discovery and the context file exist only on the local
  machine (§12.1) — the prompt ends with a short **"Remote Session"** section
  instead of the "When Using Skills" section + skill list + context file:
  every path and command runs on the remote host, and backgrounded commands
  are monitored via the log file the tool names and stopped with
  `tmux kill-window` (§12).
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
expands to the user home — the **remote** user's home for remote sessions;
relative paths then resolve against the session's `cwd` (the same directory
`run_command` runs in). There is **no path sandbox**: the agent may read,
write, and execute anywhere the server process — or, for remote sessions,
the remote ssh user — can reach.

| Tool            | Args                                            | Notes |
|-----------------|--------------------------------------------------|-------|
| `read_file`     | `path`, `raw?: bool`                             | Line-number prefix `N:content` unless `raw`. 2MB limit. UTF-8 validated for text. Images (PNG/JPEG/WebP/GIF, detected by magic bytes) are returned as a base64 `image_url` content part so a vision model can see them. Remote: one-shot ssh, the transfer capped before it crosses the wire. |
| `write_file`    | `path`, `content`                                | Creates parent dirs. Remote: content crosses on ssh's stdin (never a command line); the write is an atomic rename. |
| `edit_file`     | `path`, `old_content`, `new_content`, `replace_all?: bool` | Exact-match replace; errors on 0 or >1 matches unless `replace_all`. Exact-string semantics only (no line-range/sed edits). |
| `run_command`   | `command`, `cwd?: string`                        | Runs `sh -c`; abortable on stop. **Both kinds capture stdout and stderr into two log files from the start** (local: `<tmpdir>/clown-cmd-<id>.out`/`.err`, deleted on a clean exit and kept otherwise; remote: `/tmp/clown-<sid>/<token>.out`/`.err` plus the `<token>.exit` file — removed with the session's remote footprint at server (re)boot, session delete, and shutdown). The rendered result is capped at 2MB per stream and sectioned: `Command failed …` + `Stdout:` / `Stderr:` sections on a failure (a local signal death renders `(killed by SIG…)`; a remote one arrives flattened as the shell's 128+N exit code), `<stdout>\n\nStderr:` on a clean run that wrote stderr, bare stdout otherwise. A command still running after 60s is **left alive in the background** — the tool resolves naming both log files and the kill handle (local: the process group, `kill -- -<pid>`; remote: the tmux window, `tmux kill-window -t <win>`); monitoring it and killing it is then the agent's job. **Remote**: each command runs in its own window of the session's remote tmux session (`clown-<sid>`) and a blocking ssh "waiter" polls the window for the exit code; the 60s rule is the same. `stop` kills the in-flight command's whole tree (the local process group / the remote tmux window); a backgrounded command survives `stop`. |
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
home, absolute otherwise); the description is the routing signal. Remote
(ssh://) sessions have no skill discovery — their system prompt omits the
skills section entirely (§9).

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
//   backend: Backend,      // the session's per-session backend — file ops + run_command, local or remote (§12)
//   signal: AbortSignal,   // for run_command (stop)
// }
```

---

## 13. Technology Choices

- **Node.js 24.x** (the currently installed runtime). The server is
  **TypeScript (`.ts`, ESM)** run directly by Node's built-in type stripping
  (`node server/main.ts` — no build step); the web UI is untyped JSX (`.tsx`)
  modules bundled by esbuild at startup (§7.7).
- **`node:sqlite`** (builtin) for storage — no external server, no npm
  dependency. It currently emits an `ExperimentalWarning` (harmless; see §15).
- **Express 5** for the HTTP layer; **SSE** via a minimal helper over the
  Express response.
- **Native `fetch`** for LLM calls (OpenAI-compatible), with an abort signal
  for timeout + stop.
- **`node:child_process`** for `run_command` (abortable child process).
- **`ssh` + remote `tmux`** for remote (ssh://) sessions: one-shot `ssh` for
  file ops and tmux control (requires the `ssh` client locally and `tmux` on
  the remote host); commands run in a per-session remote tmux session — one
  window per command — with a blocking ssh "waiter" for the exit code.
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
- Each `run_command` runs as the leader of its own process group
  (`detached` spawn); every tree — in-flight or backgrounded past the 60s
  timeout — is tracked and group-killed (`SIGKILL`, shell + all descendants)
  on server shutdown (`SIGINT`/`SIGTERM`), so no command outlives the server.
- **Remote sessions** extend the trust boundary to the remote host + user:
  the local user's own ssh credentials decide what is reachable
  (`BatchMode=yes` — never hangs on an auth prompt; 10s connect timeout;
  `StrictHostKeyChecking=accept-new` — first contact auto-trusted, a *changed*
  key is still rejected). Untrusted values (paths, commands, file contents)
  cross ssh only as base64 or on the pipe, never in command text (embedded
  script text is always server-generated). Remote commands run with the
  remote user's permissions and no sandbox. On shutdown each remote session's
  tmux session is killed fire-and-forget (the ssh children outlive
  `process.exit`); the boot-time reap (§6) covers the unreachable.
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
- Structured logging (timestamp, session id, event) to stdout.
- The `node:sqlite` `ExperimentalWarning` is expected and not treated as an
  error.

---

## 16. Out of Scope (explicit)

- A terminal client, or any non-HTTP control surface.
- A **public/stable external API**: the REST + SSE HTTP API (§7) is an
  internal implementation detail of the web UI, not a contract.
- Authentication, multi-user tenancy, TLS termination (use a reverse proxy).
- External database server or any non-SQLite storage.
- Multi-process / concurrent-writer access to the same DB file (single writer).
- Session TTL / garbage collection (sessions persist in the DB until deleted).
- File-based session exports (SQLite is the sole system of record).
- Changes to the LLM provider protocol beyond OpenAI-compatible chat.
- The two-phase **auto**-compact: only the **manual** compact endpoint (§7.4)
  is in scope for v1.

