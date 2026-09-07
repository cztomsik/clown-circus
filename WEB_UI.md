# Clown-Circus — Web UI

The web UI is a **first-class part of Clown-Circus**. It is minimal today (a
thin shell page plus a small set of Preact ES modules, no build step) and is
expected to grow;
this file is the authoritative
description of what the UI is, what it uses, and the constraints it must keep
satisfying. The REST + SSE API ([SPEC.md](SPEC.md) §7) remains the complete,
primary interface — the UI is just one client of it.

## What it is

- **`webui/index.html`** — a thin page shell, served at `GET /` via
  `express.static` in `src/app.js`. The `<head>` holds the import map, a
  `<style type="text/tailwindcss">` block, and styling is **Tailwind CSS v4**
  from the Play CDN (`@tailwindcss/browser@4`) with the colour palette as
  `--color-*` tokens in an `@theme` block (the default **dark** theme). It also
  holds a plain `<style>` block with the **light** palette (overriding the same
  tokens under `:root[data-theme="light"]`), the `dot-bounce` keyframes behind
  the transcript's working indicator (see `webui/Message.js`), the `.md`
  typography rules behind Markdown message rendering (see `webui/md.js`), and
  a tiny
  inline `<script>` that
  re-applies the saved theme before first paint (no flash on reload). The
  `<body>` contains only a single `<div id="root">` mount point plus
  `<script type="module" src="/app.js">` — no static UI markup (the whole UI is
  rendered by Preact at runtime).
- **Import map** — `index.html` declares a `<script type="importmap">` in the
  `<head>` (before any module script) that maps `preact`, `preact/`, `htm`,
  `marked`, and `dompurify` to pinned **esm.sh** CDN URLs
  (`preact@10.29.8`, `htm@3.1.1`, `marked@18.0.11`, `dompurify@3.4.14`). This
  makes them importable as bare specifiers in ES modules
  (`import { h } from "preact"`, `import { useState } from "preact/hooks"`,
  `import htm from "htm"`, `import { marked } from "marked"`,
  `import DOMPurify from "dompurify"`), the same way Tailwind is pulled from a
  CDN — no local copy, no bundling. (`marked`/`dompurify` are also present in
  `devDependencies`, check-only, purely for `tsc --noEmit` to resolve them —
  they are never emitted or imported by the server.)
- **`webui/app.js`** — the entry module (loaded via
  `<script type="module" src="/app.js">`). Holds **only** the stateful `App`
  root component and its mount: all state and side effects live here as
  `useState`/`useEffect`/`useRef` (`preact/hooks`) — the config/models boot, the
  10s session poll, theme, the SSE subscription (via `openSessionEvents`), and
  the send/stop/undo/delete handlers plus the composer `/cmd` dispatch
  (`runCommand`) — then it composes the presentational
  modules below and mounts into `#root` via Preact's `render`. Markup is
  written with **htm** bound to Preact's `h` through the shared `html`
  (see `ui.js`).
- **`webui/ui.js`** — the one shared **`htm`→`h`** binding
  (`export const html = htm.bind(h)`) plus the shared Tailwind class tokens
  (`BTN`, `PRE`). Every component module imports `html` (and, where needed,
  `BTN`/`PRE`) from here, so the 3-line binding prelude lives in exactly one
  place instead of being repeated per file.
- **`webui/api.js`** — all client → server traffic, kept apart from the
  components (no DOM, no Preact, no htm): the JSON `api()`/`post()` REST helpers
  and `openSessionEvents(id, handlers)`, which opens the per-session SSE
  `EventSource`, fans its events out to a `{snapshot, status, done,
  error}` handler map (each `data` JSON-parsed), swallows connection failures,
  and returns a `close()` used as the effect cleanup.
- **`webui/Header.js`** — the **unified top bar**: sidebar toggle, brand, the
  session status badge + live summary (or the live config summary when no
  session is open), a **model `<select>`** (context-aware — seeds new sessions
  or switches the open session's model; see **Header**), a `⋮` dropdown holding
  the session actions, and the theme toggle. All of this shares one row, so it
  stays compact on mobile.
- **`webui/Sidebar.js`** — `Sidebar` + `SessionList`/`SessionItem`: the
  project-grouped session list and the new-session form (a `cwd` input + a
  "new session" button; the model is picked in the header's select).
- **`webui/Message.js`** — `Messages` + `Message` (and the `Pre` leaf): the flat
  transcript, roles distinguished by colour/weight/tint, plus the `Working`
  indicator (three staggered-bouncing dim dots, optionally labelling the
  in-flight tool) shown after the last message while a run is in flight.
  User and assistant **text** renders through the `Markdown` component
  (`webui/md.js`); reasoning, system and tool content stay plain `<pre>`.
- **`webui/md.js`** — `Markdown({ text, cls })`: the single component that
  turns message text into HTML. `marked` (GFM, `breaks: true` so single
  newlines break — chat feel) parses the text, **DOMPurify** sanitises the
  result (agent output is untrusted; a hook forces `target="_blank"
  rel="noopener"` on links and strips `javascript:` URLs), and the output is
  injected into one `<div class="md …">` via `dangerouslySetInnerHTML` — the
  **only** `dangerouslySetInnerHTML` in the UI. One parse per text change
  (re-parsing on each SSE snapshot is cheap at transcript scale). Typography
  lives in the `.md` rules in `index.html`, which reference the `--color-*`
  tokens so theming is free.
- **`webui/toolcall.js`** — bespoke rendering of a tool **call** (the
  arguments only; the tool **result** stays a plain dim `<pre>` in
  `Message.js`). One view per registered tool: `read_file`/`write_file`/
  `edit_file` show the path (`edit_file` as a stacked red-gutter old over
  green-gutter new diff), `run_command` as a `$`-prompt line (+ cwd),
  `write_todos` as a count + the parsed checkbox list, and `load_skill` as the
  skill name. Exports `ToolCall({ name, args, raw })` (the body; unknown tools
  or an unparseable `arguments` string fall back to the generic pretty-JSON
  `<pre>`) and `toolCallTitle(name, args)` (the short collapsed-summary title,
  or `null` when the tool has none).
- **`webui/Todos.js`** — the live todo panel: a **collapsible, floating**
  overlay anchored top-right inside the main pane (`<main>` is `relative`;
  the panel is `absolute`, semi-transparent `bg-panel/95` + backdrop blur,
  `z-20`). It renders only while a `write_todos` tool call is found in the
  session's messages (the markdown is derived client-side via
  `extractTodos`); its header row (a `Todos` label + rotating chevron)
  toggles the block, which scrolls internally when long (`max-h-64`). The
  string is parsed **best-effort** by `parseTodos` (in `webui/util.js`):
  checkbox lines
  (`- [x]`, `- [ ] … (in progress)`, `- [ ]`) render as a styled list — dim
  strikethrough = done, accent bold = in progress — with a `done/total` count
  in the header,
  while any non-checkbox lines are shown as-is (dim). When there are no
  checkbox lines at all the raw string is shown preformatted.
- **`webui/InputBar.js`** — the composer; owns its `useRef`/`useLayoutEffect`
  autofocus and its `SEND_BTN` class string. Handles the image attachment
  affordance (file picker, paste, drag-drop, thumbnail strip) gated on the
  current model's vision capability.
- **`webui/Main.js`** — the right-hand pane: composes `ErrorBox`, `Todos`,
  `Messages`, and `InputBar` (or a "select a session" placeholder when none is
  selected). The session status/actions no longer live here — they moved into
  the unified `Header`.
- **`webui/util.js`** — a small module of pure, dependency-free helpers
  (`baseName`, `parseCommand`, `modelId`, `timeAgo`, `prettyArgs`,
  `parseArgs`, `parseTodos`, `extractTodos`), exported by
  name and pulled in with `import { … } from './util.js'`. `parseCommand(text)`
  parses a composer `/cmd [arg]` line (returns `null` for a plain message), and
  `modelId(m)` normalises a `/models` entry to a plain id. `extractTodos(messages)`
  derives the todo markdown from the last `write_todos` tool call in the
  messages array; `parseTodos(md)` parses it into structured entries.
- **`webui/image.js`** — client-side image helpers for the composer's
  attachment feature: `fileToDataURL(file)` (FileReader → base64 data-URL),
  `prepareImageDataURL(dataUrl)` (decode to validate the bytes, downscale via
  canvas if the image exceeds a 4 MP cap, and re-encode to a sendable format —
  JPEG/PNG/WebP/GIF — if the source isn't one, e.g. an iOS HEIC/HEIF camera
  capture → PNG; passthrough if already small *and* sendable), and
  `isImageFile(file)` (the accept predicate: any `image/*` except SVG, plus an
  empty/unknown type — iOS Safari reports no MIME for a pasted image, so the
  real validation is the decode in `prepareImageDataURL`). Pure DOM, no
  Preact — kept separate from the no-DOM `util.js`.
- No build step, no runtime npm dependency (consistent with SPEC §14). The
  whole UI is plain static files in `webui/`; the only runtime UI libraries
  are **Preact + htm + marked + DOMPurify** (import-map → esm.sh) plus
  Tailwind (CDN) — nothing is bundled or compiled locally.
- The UI is a **pure client**: every action goes through the existing REST +
  SSE endpoints. It adds no server-side logic, routes, or dependencies.

## Features

- **Sidebar** — sessions from `GET /sessions`, **grouped by project** (cwd):
  each group has a sticky-style header showing the project basename and
  session count, followed by its sessions (status dot colored by
  `idle`/`running`/`error`/`stopped`, pulsing while running; cwd basename,
  last-activity, message/token counts). Refreshed on SSE `status` events and
  every 10s. New-session form (a `cwd` input + a "new session" button — the
  model is chosen in the header's model select, see **Header**) →
  `POST /sessions`. The `cwd` field is **pre-set to the selected session's
  cwd** whenever a session is chosen (state lifted into `App`, written in
  `select()`), so spinning up another session for the same project is one
  click; the field is cleared after a successful create and remains editable.

  **Archived sessions** — the list is fetched as `GET /sessions?archived=1`
  and split client-side, so the "show archived" toggle (a checkbox under the
  new-session form, off by default) is instant and the 10s poll stays
  toggle-agnostic. When off, archived sessions simply don't render. When on,
  they appear in a flat, dimmed **"archived"** section at the bottom of the
  list (server sort order kept), each item dimmed with a small `archived`
  tag. Archived sessions are fully selectable — opening one works exactly
  like any other session.
- **Header (unified top bar)** — one row that merges what used to be a
  separate global header and a per-session toolbar. Left to right: a `☰`
  sidebar-toggle button, the `clown-circus` brand (hidden below `sm` to save
  room), then either the **session** status badge + live summary
  (`cwd · N tok`, when a session is open) or the **config** summary
  (`base_url · default model · db file`, when none is), then the **model
  `<select>`**, then the theme toggle. When a session is open, a `⋮` button
  (between the summary and the model select) opens a dropdown of the session
  **actions** (`retry`, `init`, `compact`, `undo`, `clear-tools`, `clear`,
  `duplicate`, `archive` — which flips to `unarchive` when the open session is
  archived — and `delete` last, separated by a rule). `duplicate` forks the
  session (same `cwd` + history) and immediately opens the copy. Archiving hides the session from
  the default sidebar list (see **Sidebar**); the toggle is reflected in the
  open session's state immediately. The summary is `flex-1 min-w-0 truncate`,
  so on narrow viewports it truncates to one line instead of pushing the
  buttons off-screen. The menu closes on outside-tap (a full-viewport backdrop),
  on Escape, or when the selected session changes.

  The **model `<select>`** is context-aware:
  - **Session open** — mirrors and controls that session's model. Populated
    from `GET /models` (the default model pre-labelled as the `default (…)`
    option, value `""`); seeded to the session's model on `select()`; changing
    it calls `POST /sessions/:id/model` to switch the live session (allowed
    mid-run — the new model takes effect from the next LLM turn).
  - **No session** — inert state that seeds the model for the next
    `POST /sessions` (the sidebar new-session form no longer carries a model
    picker).
- **Sidebar toggle (responsive)** — the `☰` button shows/hides the sidebar.
  The initial state follows the viewport: **open** at ≥ 768px, **collapsed**
  below it (auto-collapsed on mobile). At ≥ 768px the sidebar is an in-flow
  flex column (hiding it widens the main pane); below 768px it renders as a
  fixed full-height overlay drawer (`w-[280px]`, `max-w-[85vw]`, opaque
  `bg-bg` + shadow) over a dimmed backdrop that also closes it on tap.
  Preact renders the single `Sidebar` inside a wrapper
  `div.fixed.inset-0.z-40.flex.md\:contents` — the `md:contents`
  (`display: contents`) makes the wrapper disappear at the desktop
  breakpoint, so the `<aside>` joins the parent flex row. A `matchMedia`
  listener auto-closes the drawer when the viewport shrinks below 768px
  (resize / rotation), and selecting a session on a narrow viewport closes
  the drawer, so one tap on a session lands you in the chat.
- **Session view** — full detail from `GET /sessions/:id`. Messages rendered
  from the snapshot as a flat transcript — no boxed cards or role headers;
  roles are distinguished by colour / weight / background: **user** = accent
  colour, medium weight, faint accent wash with a thin accent left rule;
  **assistant** = plain ink. Both **user** and **assistant** text is rendered
  as **Markdown** (GFM: headings, lists, tables, blockquotes, links, inline
  and fenced code — see `webui/md.js`; typography in the `.md` rules in
  `index.html`), with the prose in the sans font and code in mono;
  reasoning/system/tool content stays plain `<pre>`. Assistant turns
  additionally show `tool_calls` as collapsible dim
  lines (native `<details>`) whose **call** is rendered per tool (a short
  `tool  path`-style summary title plus a bespoke argument view — see
  `webui/toolcall.js` — e.g. a stacked red/green diff for `edit_file`, a
  `$`-prompt for `run_command`, the parsed list for `write_todos`; unknown
  tools fall back to pretty-JSON) and whose **result** stays a plain dim
  `<pre>`; a turn that carries
  `reasoning_content` (the provider's chain-of-thought) shows it as a collapsed
  dim italic `reasoning` details above the visible response;
  **system** = collapsed dim italic details (the prompt);
  **tool** results = collapsed dim details on a faint panel wash, first line
  as the summary. While the session is running, a **working indicator** —
  three small dim dots bouncing on a staggered `dot-bounce` cycle (keyframes
  in `index.html`) — renders after the last message; when the latest
  assistant turn ends with a tool call whose result hasn't arrived yet, the
  tool's `name()` is shown next to the dots as a quiet hint of what's
  executing. It is purely derived from the existing SSE-driven `status`
  (no new state or polling), so it disappears immediately on
  `done`/`error`/`stop`. Todos rendered from the last `write_todos` tool call found
  in the session's messages (derived client-side via `extractTodos`; best-effort
  checkbox parsing) in a collapsible floating panel overlaying the
  transcript (top-right of the main pane; see `webui/Todos.js`).
- **Live updates** — browser `EventSource` on `GET /sessions/:id/events`:
  - `snapshot` → re-render messages (todos derived from them), token count
  - `status` → update badge, swap send↔stop, refresh the sidebar
  - `error` → transient error banner
  - `done` → update token count
  - `EventSource` auto-reconnects and sends `Last-Event-ID`, so the server's
    replay ring (SPEC §7.6) covers brief disconnects.
- **Composer** — textarea, Enter to send, Shift+Enter for newline; it also
  accepts `/cmd` slash-commands (see **Commands**). The placeholder hints at
  this: `message (Enter to send, / for commands)`. While the
  session is running the box **looks disabled** (faded, `opacity-50`) but stays
  **enabled and editable**, so you keep focus and can type ahead; Enter is a
  no-op until the session is idle (single-flight, so it never fires a second
  message — matching the server's `409 session_busy`). The send button remains
  genuinely `disabled` while running. It is **autofocused** whenever it mounts,
  whenever the active session changes, and whenever its value is set
  programmatically (e.g. undo restoring a message) (a ref + `useLayoutEffect`
  in `InputBar`), so you can type the moment a session opens. It **auto-grows** to fit its text via
  `field-sizing: content` (no JS auto-resize), starting at `min-h-[44px]` and
  capped at `max-h-[33dvh]` (~1/3 of the viewport) — past that it scrolls
  internally (`overflow-y-auto`).
- **Image attachments (vision input)** — the composer accepts images via three
  input methods: a **📎 file-picker button** (hidden `<input type="file"
  accept="image/*" multiple>`), **paste** (Ctrl/Cmd+V pulls image files from
  `clipboardData`), and **drag-drop** (drop image files onto the composer).
  Each image is read client-side via `FileReader` → base64 data-URL, then
  downscaled (canvas) if it exceeds the 4 MP cap before being sent. A
  **thumbnail strip** above the textarea shows attached images with a per-image
  remove (×) button. On send, images are sent as OpenAI `ContentPart[]`
  (`{type:"image_url", image_url:{url:"data:…"}}`) alongside the text part.
  **Vision gating**: on boot, the UI builds a `visionModels` set from
  `GET /models` (`architecture.input_modalities` includes `"image"`). The entire
  image affordance (picker, paste handler, drop zone, thumbnail strip) is hidden
  when the current session's model is known to be non-vision. Models not present
  in the `/models` list are treated optimistically as vision-capable. The
  transcript renders `image_url` parts as inline `<img>` thumbnails in user
  messages.
- **Commands** — typing a `/cmd` line in the composer dispatches a control
  instead of sending a message (a port of the source TUI's `handleCommand`). On
  Enter, `send()` runs `parseCommand()` first: if the trimmed text starts with
  `/`, the command (lowercased, first whitespace-delimited token) is dispatched
  by `runCommand()`; otherwise it is a normal message. The commands map 1:1 to
  the §7.5 control endpoints and reuse the existing handlers (no new endpoint):
  `/stop`, `/retry`, `/init`, `/compact`, `/clear`, `/clear-tools`, `/undo`,
  `/duplicate` →
  the matching `POST /sessions/:id/…` (`/undo` restores the popped message into
  the composer; `/duplicate` opens the new fork). A command is parsed **before** the running no-op guard, so
  `/stop` and the implicit-stop commands (`/undo`, `/clear`, `/clear-tools`)
  work while a run is in flight; plain messages still no-op while running
  (type-ahead preserved). The command text is cleared on a recognized command
  (and re-filled for `/undo`); an unknown `/…` keeps the text in the box so it
  can be edited and is reported in the error banner. Source commands with no
  headless equivalent — `/exit`/`/quit`, `/save`/`/load`, `/continue`, `/sudo` —
  are intentionally not ported.
- **Controls** — the session actions live in the `⋮` dropdown in the unified
  header (see **Header**), in four logical groups (`delete` last, separated
  by a thin rule):
  - **Agent actions**: `retry`, `init` — fire-and-forget (202),
    start the loop.
  - **History editing**: `compact`, `undo`, `clear-tools`, `clear` —
    `compact` starts the loop; the rest are synchronous and re-render the
    snapshot after the call. `undo` restores the popped user message into the
    composer (from the response's `undone` field) and returns focus to it, so
    you can edit and re-send.
  - **Forking**: `duplicate` — `POST …/duplicate` creates a fork (same
    `cwd` + history, copied verbatim unless the running source ends with
    pending `tool_calls`, in which case the dangling tail is stripped; 201)
    and immediately **selects the copy**, so the diverging conversation can
    start right away — the source stays open in the sidebar.
  - **Destructive**: `delete` (with `confirm()`).
  Plus the composer: send (`POST …/messages`) and `stop`. The header's model
  `<select>` additionally drives `POST /sessions/:id/model` (switch a session's
  model; see **Header**). All endpoints are from SPEC §7.5.
- **Theme toggle** — a button in the `Header` (top-right) switches the
  `--color-*` palette between the default dark and the light theme by setting
  `data-theme` on `<html>`; the current state shows as `→ light` / `→ dark`.
  The choice is persisted in `localStorage` under `clown-circus-theme`, and a
  tiny inline `<script>` in `index.html` re-applies it before first paint so
  reloads open in the right theme.

## Constraints / invariants

- **Static files, no build step, no npm dependencies.** All UI assets live
  in `webui/` and are served as-is by `express.static`. No bundler, no
  transpiler, no extra npm dependency. The only runtime libraries (Tailwind,
  Preact, htm) are loaded from CDNs — Preact + htm through the import map,
  Tailwind through the Play CDN script.
- **No un-sanitised HTML injection**: LLM output is untrusted. All content is
  rendered as Preact text (htm template interpolations become text nodes /
  `textContent`) **except** user/assistant message text, which `webui/md.js`
  parses as Markdown and injects via `dangerouslySetInnerHTML` — and only
  *after* DOMPurify sanitisation (with the link / `javascript:`-URL hooks).
  `md.js` is the sole `dangerouslySetInnerHTML` in the UI; new HTML injection
  must not be added, and Markdown output must keep flowing through the same
  sanitizer.
- **htm void elements must self-close.** `htm` has no list of HTML void
  elements — in a template a tag is closed only by an explicit `/>` or a
  matching `</tag>`. So void elements (today `<input>`; and if ever added
  `<img>`/`<br>`/`<hr>`) must be written `<input … />`. A bare `<input …>` is
  treated as an *open* tag, so every sibling after it is re-parented inside it
  and the whole subtree's structure (including sibling `class`es) is silently
  clobbered — this is what once broke the Sidebar (the model `<select>`, the
  "new session" `<button>`, and the `aside`'s `class` all vanished).
  `<textarea>` and `<select>` are *not* void; they keep their `</textarea>` /
  `</select>` closers.
- **The API is the ceiling.** Everything the UI does must be reproducible
  with `curl` against §7; the UI may not require server features the API
  lacks.
- **Routing**: `express.static` is registered before the JSON 404 fallback;
  unknown paths must still return the JSON `404 not_found` error shape.
- **Styling**: monospace, terminal-ish — it should feel like a client of the
  CLI-era tool, not a SaaS dashboard. Implemented with Tailwind v4 utility
  classes; the colour palette is the `--color-*` tokens
  (`--color-bg`, `--color-panel`, `--color-line`, `--color-ink`, `--color-dim`,
  `--color-accent`, `--color-err`, `--color-ok`), defined once as the default
  dark theme in the `@theme` block with the light theme overriding the same
  tokens under `:root[data-theme="light"]` (see **Theme toggle**). Every
  utility references `var(--color-*)`, so flipping the attribute recolours the
  whole UI, including `/opacity` tints.

## Current gaps (intentional — candidates for expansion)

- No syntax highlighting in fenced code blocks (plain mono `<pre><code>`;
  candidates: `highlight.js` via the import map, plus a language label / copy
  button on the code header).
- No multi-session side-by-side view; one session at a time.
- Image `undo` restores text only (images dropped from the composer); v1
  limitation.
- EXIF orientation is not applied to uploaded JPEGs (needs in-browser
  header-parsing; stretch goal).
- GIF attachments capture only the first frame (canvas limitation).
