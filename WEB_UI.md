# Clown-Circus — Web UI

The web UI is a **first-class part of Clown-Circus**. It is minimal today (a
thin shell page plus a small set of Preact ES modules, bundled at server
startup by esbuild) and is
expected to grow;
this file is the authoritative
description of what the UI is, what it uses, and the constraints it must keep
satisfying. The REST + SSE API ([SPEC.md](SPEC.md) §7) remains the complete,
primary interface — the UI is just one client of it.

## What it is

- **`webui/index.html`** — a thin page shell, served at `GET /` via
  `express.static` in `src/app.js`. The `<head>` holds a
  `<style type="text/tailwindcss">` block, and styling is **Tailwind CSS v4**
  via the `@tailwindcss/browser` JIT (bundled into `/vendor/bundle.js` — see
  **esbuild bundle**) with the colour palette as
  `--color-*` tokens in an `@theme` block (the default **dark** theme). It also
  holds a plain `<style>` block with the **light** palette (overriding the same
  tokens under `:root[data-theme="light"]`), the `dot-bounce` keyframes behind
  the transcript's working indicator (see `webui/Message.js`), the `.md`
  typography rules behind Markdown message rendering (see `webui/md.js`), and
  a tiny
  inline `<script>` that
  re-applies the saved theme before first paint (no flash on reload). The
  `<body>` contains only a single `<div id="root">` mount point plus
  `<script type="module" src="/vendor/bundle.js">` — no static UI markup (the
  whole UI is rendered by Preact at runtime).
- **esbuild bundle** — `src/main.js` runs an esbuild build (runtime
  `dependency`, not dev-only) **at server startup**: entry `webui/app.js`,
  `bundle: true`, `format: esm`, `target: es2022`, outfile
  `webui/vendor/bundle.js`. An initial blocking build runs before `listen`,
  then `ctx.watch()` (no await) keeps the bundle fresh in the background as
  `webui/*.js` changes; `ctx.dispose()` runs on shutdown. The modules keep
  bare imports (`import { h } from "preact"`, `import { useState } from
  "preact/hooks"`, `import htm from "htm"`, `import { marked } from "marked"`,
  `import DOMPurify from "dompurify"`); esbuild resolves and inlines them from
  `node_modules` at build time — **no network, fully offline**. The Tailwind
  browser JIT is in the bundle too: `webui/app.js`'s first line is
  `import "@tailwindcss/browser"` (a side-effect IIFE, not ESM), so the JIT is
  installed before the UI renders. The packages
  are real `dependencies` in `package.json`: esbuild bundles them at runtime,
  and `tsc --noEmit` resolves the bare imports for the check-only type
  declarations. `webui/vendor/` is generated output (git-ignored, excluded
  from the tsconfig).
- **`webui/app.js`** — the entry module (bundled to
  `webui/vendor/bundle.js`, served at `/vendor/bundle.js`). Holds **only**
  the stateful `App`
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
  session is open), a **model `<select>`** (client-side: picks the model for
  the next send; see **Header**), a `⋮` dropdown holding
  the session-level actions (see **Header** under Features), and the theme toggle. All of this shares one row, so it
  stays compact on mobile.
- **`webui/Sidebar.js`** — `Sidebar` + `SessionList`/`SessionItem`: the
  project-grouped session list and the new-session form (a `cwd` input + a
  "new session" button; the model is picked in the header's select).
- **`webui/Message.js`** — `Messages` + `Message` (and the `Pre` leaf): the flat
  transcript, roles distinguished by colour/weight/tint, plus the `Working`
  indicator (three staggered-bouncing dim dots, optionally labelling the
  in-flight tool, and a live elapsed-time clock) shown after the last message
  while a run is in flight.
  The list **auto-scrolls to the newest turn only while the reader is
  "pinned"** near the bottom (within 80px); once scrolled up, incoming
  snapshots leave the view alone and a floating bottom-centre `↓ latest` pill
  smooth-scrolls back down and re-pins. `Messages` is keyed by session id
  (in `Main.js`), so a session switch remounts it and lands at the bottom of
  the new transcript.
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
  (`baseName`, `parseCommand`, `modelId`, `isVisionModel`, `reasoningText`,
  `timeAgo`, `prettyArgs`, `parseArgs`, `parseTodos`, `extractTodos`), exported
  by name and pulled in with `import { … } from './util.js'`. `parseCommand(text)`
  parses a composer `/cmd [arg]` line (returns `null` for a plain message),
  `modelId(m)` normalises a `/models` entry to a plain id, and `isVisionModel(m)`
  decides whether an entry accepts image input — honours
  `architecture.input_modalities` when the provider exposes it (llama.cpp),
  otherwise assumes vision-capable. `reasoningText(m)`
  reads the assistant chain-of-thought from whichever field the provider used
  (`reasoning_content` or `reasoning`). `extractTodos(messages)`
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
- Bundled at server startup (consistent with SPEC §14). The modules are plain
  static files in `webui/`; esbuild bundles `webui/app.js` + its deps
  (**Preact + htm + marked + DOMPurify + the Tailwind browser JIT**) into
  `webui/vendor/bundle.js` from `node_modules` at startup (see **esbuild
  bundle** above). Nothing is fetched from a network CDN, so the UI works
  offline.
- The UI is a **pure client**: every action goes through the existing REST +
  SSE endpoints (the lone exception is `open in vscode`, a local `vscode://`
  URI). It adds no server-side logic, routes, or dependencies.

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
  (`base_url · db file`, when none is), then the **model
  `<select>`**, then the theme toggle. When a session is open, a `⋮` button
  (between the summary and the model select) opens a dropdown of the
  **session-level** actions only — `open in vscode`, `archive` (which flips to
  `unarchive` when the open session is archived), and `delete` last,
  separated by a rule. Conversation manipulation (`retry`, `retry-turn`,
  `init`, `compact`, `undo`, `clear`, `duplicate`, `trim`) is not in the menu —
  it lives in the composer as slash commands (see **Commands**). `open in
  vscode` is the only non-REST item: it hands the session `cwd` to the local
  `vscode://file/` URI handler via `window.open` (the browser shows its
  external-app prompt; VS Code must be the `vscode://` protocol handler).
  Archiving hides the session from the default sidebar list (see **Sidebar**);
  the toggle is reflected in the open session's state immediately. The summary is `flex-1 min-w-0 truncate`,
  so on narrow viewports it truncates to one line instead of pushing the
  buttons off-screen. The menu closes on outside-tap (a full-viewport backdrop),
  on Escape, or when the selected session changes.

  The **model `<select>`** is pure client state — it picks the model for the
  *next* send. Populated from `GET /models`; there is no "default" option,
  the server has no default model of its own. Whenever the list is non-empty
  the select **always points at a real model**: pre-filled from the open
  session's **last-used model** on `select()` (the value the server persisted
  from the previous send), and when that value has no matching option (stale
  — removed from the backend) or nothing is selected yet, it falls back to
  the **first model in the list**. The selected model is sent in the body of
  every `POST …/messages` (required field) and of `POST /sessions`, where
  the server pins it for the whole run and persists it as the session's
  last-used model. Only when `/models` is empty (LLM unreachable) can the
  select be valueless — creating a session and sending then flash
  "no models available".
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
  consecutive assistant turns (one agent run's worth of LLM calls, ending
  in the tool-less final turn) are grouped into a single tight-spacing
  unit (`gap-1` inside, `gap-3` between runs) so a run reads as one
  continuous flow;
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
  `<pre>`; a turn that carries the provider's chain-of-thought
  (llama.cpp's `reasoning_content` or vLLM's `reasoning`, read via
  `reasoningText`) shows it as a collapsed dim italic `reasoning` details
  above the visible response;
  **system** = collapsed dim italic details (the prompt);
  **tool** results = collapsed dim details on a faint panel wash, first line
  as the summary. While the session is running, a **working indicator** —
  three small dim dots bouncing on a staggered `dot-bounce` cycle (keyframes
  in `index.html`) — renders after the last message; when the latest
  assistant turn ends with a tool call whose result hasn't arrived yet, the
  tool's `name()` is shown next to the dots as a quiet hint of what's
  executing. Next to that, a **live elapsed-time clock** (`45s`,
  `2m 05s`, tabular nums) ticks once a second, measured client-side from
  when the indicator mounted (≈ when the UI observed the run start) and
  recomputed from `Date.now()` each tick, so a backgrounded tab's throttled
  interval can't drift it. The indicator's *visibility* is purely derived
  from the existing SSE-driven `status` (no new polling), so it disappears
  immediately on `done`/`error`/`stop`. Todos rendered from the last `write_todos` tool call found
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
  remove (×) button — always visible below `md` (touch never fires `:hover`),
  hover-revealed on desktop. On send, images are sent as OpenAI `ContentPart[]`
  (`{type:"image_url", image_url:{url:"data:…"}}`) alongside the text part.
  **Vision gating**: on boot, the UI builds a `visionModels` set from
  `GET /models` via `isVisionModel()` (`webui/util.js`). Only an entry that
  **explicitly declares modalities** (llama.cpp's `architecture.input_modalities`)
  can be marked non-vision; providers with no such field (e.g. vLLM) — and
  models not present in the `/models` list at all — are assumed vision-capable.
  The entire image affordance (picker, paste handler, drop zone, thumbnail strip)
  is hidden when the current session's model is known to be non-vision. The
  transcript renders `image_url` parts as inline `<img>` thumbnails in user
  messages.
- **Commands** — typing a `/cmd` line in the composer dispatches a control
  instead of sending a message. On
  Enter, `send()` runs `parseCommand()` first: if the trimmed text starts with
  `/`, the command (lowercased, first whitespace-delimited token) is dispatched
  by `runCommand()`; otherwise it is a normal message. The commands map 1:1 to
  the §7.5 control endpoints and reuse the existing handlers (no new endpoint):
  `/stop`, `/retry`, `/retry-turn`, `/init`, `/compact`, `/clear`,
  `/trim [turns]`, `/undo`, `/duplicate` →
  the matching `POST /sessions/:id/…` (`/undo` restores the popped message into
  the composer; `/duplicate` opens the new fork; `/trim` takes an optional
  `<turns>` arg (how many trailing turns — assistant LLM calls, each with its
  tool results — to leave untouched) that the ⋮
  menu's entries can't carry, so it lives in the composer: with no arg it keeps
  the last 5,
  and a non-numeric/negative arg flashes `usage: /trim [turns]` and keeps the
  text in the box). A command is parsed **before** the running no-op
  guard, so
  `/stop` and the implicit-stop commands (`/undo`, `/clear`, `/trim`)
  work while a run is in flight; plain messages still no-op while running
  (type-ahead preserved). The command text is cleared on a recognized command
  (and re-filled for `/undo`); an unknown `/…` keeps the text in the box so it
  can be edited and is reported in the error banner.
- **Controls** — split by surface:
  - **Session-level** — the `⋮` dropdown in the unified header (see
    **Header**): `open in vscode` (client-side only — a
    `vscode://file/<cwd>` URI, no REST call), `archive`/`unarchive`, and
    `delete` (with `confirm()`). Deliberately short: everything that edits
    the conversation is a composer slash command, so the menu is only what
    the composer can't reach.
  - **Conversation** — the composer (see **Commands**): `/retry`,
    `/retry-turn`, `/init` (fire-and-forget, 202, start the loop),
    `/compact` (starts the loop), `/undo` (synchronous; restores the popped
    user message into the composer from the response's `undone` field and
    returns focus, so you can edit and re-send), `/clear`, `/trim [turns]`,
    and `/duplicate` (`POST …/duplicate` forks the session — same `cwd` +
    history, copied verbatim unless the running source ends with pending
    `tool_calls`, in which case the dangling tail is stripped; 201 — and
    immediately **selects the copy**, so the diverging conversation can
    start right away; the source stays open in the sidebar).
  - **Send/stop** — the composer's send button (`POST …/messages`, with the
    model `<select>`'s value as the required `model` body field — see
    **Header**) and the running state's `stop`. All control endpoints are
    from SPEC §7.5.
- **Theme toggle** — a compact icon button in the `Header` (top-right)
  switches the `--color-*` palette between the default dark and the light
  theme by setting `data-theme` on `<html>`; the icon shows the theme it
  switches **to** (☀ in dark mode, 🌙 in light mode).
  The choice is persisted in `localStorage` under `clown-circus-theme`, and a
  tiny inline `<script>` in `index.html` re-applies it before first paint so
  reloads open in the right theme.

## Constraints / invariants

- **Static modules, esbuild-bundled at startup.** All UI source lives in
  `webui/` and is served as-is by `express.static`; the only bundled asset is
  the esbuild output `webui/vendor/bundle.js` (rebuilt at every startup +
  background watch — see **esbuild bundle** above). The runtime libraries
  (Preact, htm, marked, DOMPurify, the Tailwind browser JIT) are all inlined
  from `node_modules` by esbuild — no `node_modules` static mounts remain.
  Nothing is fetched from a network CDN, so the UI works fully
  offline; upgrading a UI library means bumping the version in `package.json`
  + `npm install` (esbuild resolves each package's standard ESM entry).
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
- **Styling**: monospace, terminal-ish — it should feel like a client of a
  headless API, not a SaaS dashboard. Implemented with Tailwind v4 utility
  classes; the colour palette is the `--color-*` tokens
  (`--color-bg`, `--color-panel`, `--color-line`, `--color-ink`, `--color-dim`,
  `--color-accent`, `--color-err`, `--color-ok`), defined once as the default
  dark theme in the `@theme` block with the light theme overriding the same
  tokens under `:root[data-theme="light"]` (see **Theme toggle**). Every
  utility references `var(--color-*)`, so flipping the attribute recolours the
  whole UI, including `/opacity` tints.

## Current gaps (intentional — candidates for expansion)

- No syntax highlighting in fenced code blocks (plain mono `<pre><code>`;
  candidates: `highlight.js` via the esbuild bundle, plus a language label /
  copy
  button on the code header).
- No multi-session side-by-side view; one session at a time.
- Image `undo` restores text only (images dropped from the composer); v1
  limitation.
- EXIF orientation is not applied to uploaded JPEGs (needs in-browser
  header-parsing; stretch goal).
- GIF attachments capture only the first frame (canvas limitation).
