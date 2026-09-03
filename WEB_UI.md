# Clown-Circus — Web UI

The web UI is a **first-class part of Clown-Circus**. It is minimal today (a
thin shell page plus one Preact module, no build step) and is expected to grow;
this file is the authoritative
description of what the UI is, what it uses, and the constraints it must keep
satisfying. The REST + SSE API ([SPEC.md](SPEC.md) §7) remains the complete,
primary interface — the UI is just one client of it.

## What it is

- **`webui/index.html`** — a thin page shell, served at `GET /` via
  `express.static` in `src/app.js`. The `<head>` holds the `<style
  type="text/tailwindcss">` block and the import map; styling is **Tailwind
  CSS v4** from the Play CDN (`@tailwindcss/browser@4`) with custom design
  tokens (colours) in an `@theme` block. The `<body>` contains only a single
  `<div id="root">` mount point plus `<script type="module" src="/app.js">`
  — no static UI markup (the whole UI is rendered by Preact at runtime).
- **Import map** — `index.html` declares a `<script type="importmap">` in the
  `<head>` (before any module script) that maps `preact`, `preact/`, and
  `htm` to pinned **esm.sh** CDN URLs (`preact@10.29.8`, `htm@3.1.1`). This
  makes **Preact + htm** importable as bare specifiers in ES modules
  (`import { h } from "preact"`, `import { useState } from "preact/hooks"`,
  `import htm from "htm"`), the same way Tailwind is pulled from a CDN — no
  local copy, no bundling.
- **`webui/app.js`** — the entire UI as a **Preact** ES module
  (`type="module"`, loaded via `<script type="module" src="/app.js">`).
  JSX-style markup is written with **htm** bound to Preact's `h`
  (`const html = htm.bind(h)`); a single `App` component owns all state and
  mounts into `#root` via Preact's `render`. Presentational components:
  `Header`, `Sidebar` (with `SessionList`/`SessionItem`), `Main`, `Toolbar`,
  `Todos`, `Messages`/`Message`, `InputBar`. API calls, the `EventSource`
  (SSE), the 10s session poll, and the transient error flash live in
  `useState`/`useEffect`/`useRef` (`preact/hooks`) inside `App`.
- No build step, no extra npm dependency (consistent with SPEC §14). The
  whole UI is plain static files in `webui/`; the only runtime UI libraries
  are **Preact + htm** (import-map → esm.sh) plus Tailwind (CDN) — nothing
  is bundled or compiled locally.
- The UI is a **pure client**: every action goes through the existing REST +
  SSE endpoints. It adds no server-side logic, routes, or dependencies.

## Features

- **Sidebar** — sessions from `GET /sessions`, **grouped by project** (cwd):
  each group has a sticky-style header showing the project basename and
  session count, followed by its sessions (status dot colored by
  `idle`/`running`/`error`/`stopped`, pulsing while running; cwd basename,
  last-activity, message/token counts). Refreshed on SSE `status` events and
  every 10s. New-session form (`cwd` required, **model picker** — a
  `<select>` populated from `GET /models` with the default model pre-labelled)
  → `POST /sessions`.
- **Session view** — full detail from `GET /sessions/:id`. Messages rendered
  from the snapshot: system prompt collapsed, tool results collapsed (first
  line as the summary), assistant `tool_calls` shown as chips
  (`name(args)`). Todos panel rendered from the snapshot's `todos`.
- **Live updates** — browser `EventSource` on `GET /sessions/:id/events`:
  - `snapshot` → re-render messages, todos, token count
  - `todo` → re-render todos
  - `status` → update badge, swap send↔stop, refresh the sidebar
  - `error` → transient error banner
  - `done` → update token count
  - `EventSource` auto-reconnects and sends `Last-Event-ID`, so the server's
    replay ring (SPEC §7.6) covers brief disconnects.
- **Composer** — textarea, Enter to send, Shift+Enter for newline; disabled
  while the session is running (single-flight, matches `409 session_busy`).
- **Controls** — toolbar with three logical groups (separated by thin
  vertical rules):
  - **Agent actions**: `retry`, `init` — fire-and-forget (202),
    start the loop.
  - **History editing**: `compact`, `undo`, `clear-tools`, `clear` —
    `compact` starts the loop; the rest are synchronous and re-render the
    snapshot after the call.
  - **Destructive**: `delete` (with `confirm()`).
  Plus the composer: send (`POST …/messages`) and `stop`.
  All endpoints are from SPEC §7.5.

## Constraints / invariants

- **Static files, no build step, no npm dependencies.** All UI assets live
  in `webui/` and are served as-is by `express.static`. No bundler, no
  transpiler, no extra npm dependency. The only runtime libraries (Tailwind,
  Preact, htm) are loaded from CDNs — Preact + htm through the import map,
  Tailwind through the Play CDN script.
- **No HTML injection**: all session/model/tool content is rendered as Preact
  text (htm template interpolations become text nodes / `textContent`), never
  `innerHTML` or `dangerouslySetInnerHTML`. LLM output is untrusted and must
  never be parsed as HTML.
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
- **Styling**: dark, monospace, terminal-ish — it should feel like a client of
  the CLI-era tool, not a SaaS dashboard. Implemented with Tailwind v4
  utility classes; the colour palette is defined once in the `@theme` block
  (`--color-bg`, `--color-panel`, `--color-line`, `--color-ink`, `--color-dim`,
  `--color-accent`, `--color-err`, `--color-ok`, `--color-chip`).

## Current gaps (intentional — candidates for expansion)

- No snapshot import/export from the UI (SPEC §10.3).
- No markdown/code rendering of assistant content (plain `<pre>`).
- No multi-session side-by-side view; one session at a time.
