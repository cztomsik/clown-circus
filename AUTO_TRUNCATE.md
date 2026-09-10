# Clown-Circus — Auto-Truncation

**Status**: implemented (server-side).
**Flag**: `--trunc` (on by default; disable with `--no-trunc`).
**Provenance**: net-new to clown-circus. `clown-code` (the source of truth) has
no truncation at all, so this adds a server-side context guard rather than
porting one.

Auto-truncation is an **on-by-default, server-side pre-process** (disable with
`--no-trunc`) that bounds what each LLM request *sees* by shrinking *stale,
oversized* tool results to a one-line `<truncated N bytes>` stub just before the
request is built. It is **non-destructive to the stored transcript**: the DB and
the web UI always keep the full content; only the copy handed to `llm.chat()` is
trimmed. It is a gentler cousin of `clear-tools` (SPEC §7.5): instead of dropping
tool messages it keeps them, but in the *LLM-bound view* replaces the body of
each oversized *stale* result with a marker that records how big the original
was — so the model still knows a large result happened there and can re-read or
re-run for the full content.

**The core rule: the latest user–assistant turn is always intact.** Everything
else — the *gap* between that turn and the beginning of the conversation — is
"history," and it is what the guard bounds and shrinks *in the LLM-bound view*.

## What it does

- Before each LLM call the session splits its transcript at the latest user turn:
  the **tail** (that turn, onward) is sacrosanct; everything before it is the
  **gap** (the history).
- It measures the **gap's size** in bytes. Once the gap is larger than the
  mark (`truncateGap`, bytes), it builds a **trimmed view** for the LLM: every
  *stale* tool result inside the gap that is larger than `truncateBytes` bytes
  is replaced, in that view, by `<truncated N bytes>` where N is the original
  result's byte length. The stored message is left intact.
- The tail is never touched. A conversation with only one turn has an empty gap,
  so the view is a no-op until a second turn exists.

## How it triggers (the gap, not a level)

This is **not** a classic high-water mark on the total. The total is dominated
by whatever the model is doing *right now*; a large in-flight turn would trip a
level threshold for the wrong reason. Instead we measure the **gap** — the bytes
of history *before* the latest user turn — so a big current turn is irrelevant
to the trigger.

Measured synchronously from the messages we are about to send, not from the
LLM's reported `total_tokens` (so a chatty completion can't trip it, and there's
no rebase / "one turn late"). A single constant, the **gap mark** `truncateGap`:

```
truncatedMessages():                 # what llm.chat() receives
    if autoTruncate and gapBytes() > truncateGap:
        return a copy with the gap's oversized results stubbed
    return this.messages             # under the mark: send as-is (no copy)
```

The stored transcript is never mutated, so the gap only grows as turns
accumulate. Once it crosses the mark, every subsequent LLM call sends a trimmed
view (the trigger simply skips that work while history is still small). No
cadence, no reference, no ratcheting — and nothing is ever lost, so there is no
"re-accumulation" to speak of.

The gap size is `Σ bytesOf(m, 'utf8')` over the messages before the latest user
turn, where `bytesOf` measures the message **as the LLM sees it**: the content
(string, or the JSON of a content-parts array — base64 image payloads
included), plus `tool_calls` JSON (names + arguments), plus any provider
reasoning field (`reasoning_content` / `reasoning`). The system prompt and the
latest turn are both excluded — the mark is purely a ceiling on *history*
(tune it to how much history you want the model to keep reading in full).

The gap is measured in bytes, not from the LLM's reported `usage.total_tokens`,
on purpose:

- `truncatedMessages()` runs *before* the request, so only the *previous*
  response's usage is available ("one turn late").
- `total_tokens` is the whole request (system prompt + tool schemas + the
  in-flight turn) — exactly what the gap mark is meant to exclude.
- Once truncation is active, the previous call's usage reflects the *stubbed*
  view, so a usage-based mark would oscillate (stub → usage drops → unstub →
  usage spikes → stub…). Measuring the never-mutated `this.messages` is
  monotonic; usage is a moving target (and provider-dependent).

## Where it runs

A single call: at the **top of `Session.next()`** in `src/session.js`,
`truncatedMessages()` builds the LLM-bound view, immediately before `llm.chat()`.
That *is* the "server-side pre-process, just before sending the request." The
view is passed to the LLM, but `this.messages` (the source of truth) is **never
mutated** — so `persist()` and the web UI keep the full content. All logic lives
on the `Session`; `src/llm.js` and `src/loop.js` are untouched (the original
sketch showed `next()` as a free function in `loop.js`, but in this codebase
`next()` is a `Session` method).

```js
// session.js — next()
async next() {
  const messages = this.truncatedMessages(); // LLM-bound view (stubbed iff gap over mark)
  let attempts = 2;                          // auto_retry (1) + 1
  while (attempts-- > 0) {
    const { message, usage } = await this.llm.chat({ model, messages, tools, ... });
    // ...
    this.messages.push(message);             // record the real response in the full transcript
  }
}
```

## The truncation pass

`truncatedMessages()` is **pure**: when the gap is over the mark it returns a
shallow copy of the transcript with each oversized gap tool result replaced by a
stub; otherwise it returns `this.messages` as-is (the same array — no copy, no
work). The copy stubs the gap only; the latest user–assistant turn is never
touched, and the original message objects are left intact.

```js
truncatedMessages() {
  if (!this.config.autoTruncate) return this.messages;
  if (this.gapBytes() <= this.config.truncateGap) return this.messages; // history under the mark
  const budget = this.config.truncateBytes;
  const end = this.gapEnd();                // everything from here on is the tail
  const out = this.messages.slice();        // shallow copy: same refs except the stubs
  for (let i = 0; i < end; i++) {
    const m = out[i];
    if (m.role !== 'tool') continue;
    const n = Buffer.byteLength(m.content, 'utf8');
    if (n <= budget) continue;             // small enough, leave it
    out[i] = { ...m, content: `<truncated ${n} bytes>` }; // new object; original untouched
  }
  return out;
}

// end of the gap = start of the latest user turn (the sacrosanct tail)
gapEnd() {
  const i = lastIndexOf(this.messages, (m) => m.role === 'user');
  return i === -1 ? this.messages.length : i; // single turn -> empty gap
}

// Bytes of a message as the LLM sees it: content (string, or the JSON of a
// content-parts array), plus tool-call JSON, plus any reasoning field.
bytesOf(m) {
  let n = 0;
  if (m.content != null)
    n += Buffer.byteLength(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), 'utf8');
  if (m.tool_calls?.length) n += Buffer.byteLength(JSON.stringify(m.tool_calls), 'utf8');
  n += Buffer.byteLength(m.reasoning_content ?? m.reasoning ?? '', 'utf8');
  return n;
}

gapBytes() {
  const end = this.gapEnd();
  return this.messages.slice(0, end)
    .filter((m) => m.role !== 'system') // the system prompt is constant context, not history
    .reduce((n, m) => n + bytesOf(m), 0);
}
```

- **Only** `role: 'tool'` messages with a string body are stubbed (tool results
  are always strings — `accept()` stringifies non-strings).
- **The latest turn is sacrosanct.** Only tool results in the gap (before the
  latest user turn) are stubbed; the current turn is never shrunk. A one-turn
  conversation has an empty gap, so nothing is ever stubbed until a second turn
  exists.
- **Non-destructive to the store.** The stub lives only in the returned copy;
  `this.messages[i]` still points at the full original. The DB row and the web
  UI therefore always show the full content — only the model sees the stub.
- **Stub format**: the whole body is replaced (in the view) by `<truncated N
  bytes>` where **N is the original result's byte length**. No head is kept, no
  line counting.
- **Threshold is bytes.** A gap result is stubbed only if it is larger than
  `truncateBytes` bytes, so tiny results are left alone (`--truncate-bytes 1`
  stubs every stale result in the view).
- **Pure / idempotent**: it never mutates state, so calling it repeatedly yields
  the same view; a stub is ~20 bytes (≤ `truncateBytes`) and would not be
  re-stubbed even if it appeared in the gap.

## Config

| Flag / env | Default | Meaning |
|---|---|---|
| `--trunc` / `--no-trunc` · `CLOWN_TRUNC` | `true` | Feature flag — master on/off (on by default) |
| `--truncate-gap <n>` · `CLOWN_TRUNC_GAP` | `100000` | **Bytes** — build a trimmed view once the *history* gap (before the latest turn) exceeds this |
| `--truncate-bytes <n>` · `CLOWN_TRUNC_BYTES` | `256` | A *gap* tool result larger than this many **bytes** is replaced by `<truncated N bytes>` (in the LLM view) |

Defaults are suggested starting points, not tuned values. `--truncate-gap` is how
much *history* you want the model to keep reading in full before old tool output
gets stubbed. Surfaced read-only in `GET /config` as `auto_truncate`,
`truncate_gap`, `truncate_bytes`.

## Files touched

| File | Change |
|---|---|
| `src/config.js` | 3 new entries — a small `bool` helper for the `--trunc` / `--no-trunc` flag (defaults true) plus the two numbers. |
| `src/session.js` | `truncatedMessages()` (pure); `gapEnd()`; `gapBytes()`; and the single call at the top of `next()`, which passes the view to `llm.chat()`. |
| `src/loop.js` | **Unchanged** — `runLoop` calls `session.next()`, which owns the call. |
| `src/app.js` | Add the 3 keys to the `GET /config` response. |
| `src/prompt.js` *(optional)* | When on, append a one-line system-prompt note that (older) tool results may appear truncated to `<truncated N bytes>` and to re-read/re-run for the full content. Update the 2 `buildSystemPrompt` call sites in `session.js`. |
| `webui/` | **Unchanged** — the web UI renders the *stored* transcript, which keeps the full content; a stub never reaches the client. |

**Untouched**: `src/tools.js` (truncation is a session-layer concern; tools stay
faithful to the source), `src/llm.js`, `src/db.js`, `webui/`.

## Constraints / invariants

- **On by default; `--no-trunc` = byte-identical.** With the flag disabled,
  `truncatedMessages()` returns `this.messages` as-is (the same array) and the
  LLM request is exactly as it would be without the feature.
- **The latest user–assistant turn is never touched.** Only tool results in the
  gap (before it) are ever stubbed, and only in the LLM-bound view; the tail is
  sacrosanct.
- **The trigger is the gap, not the total.** A large current turn cannot, by
  itself, trip the guard — only accumulated history can.
- **Non-destructive to the DB / web UI; destructive only to the LLM.** The stored
  `this.messages` is never mutated, so the DB row and the web UI always show the
  full content — only the model sees the stub. The model must re-read / re-run to
  recover content it was shown truncated; the full bytes remain in the transcript
  the client can see.
- **No new dependency, no LLM dependency.** Uses only the message bytes (builtin
  `Buffer.byteLength`) and the fixed `truncateGap` — not the model's reported
  `total_tokens`.
- **Single call site.** `truncatedMessages()` is invoked exactly once per LLM
  turn, at the top of `Session.next()`. Every agent-loop LLM call goes through
  `next()` — `send`, `retry`, and `compact` (the latter runs its
  summarize/replace turns through `runLoop` → `next()` too) — so all of them use
  the same guard. There is no separate "direct" `llm.chat()` to special-case.
- **Leaves `meta()` alone; `total_tokens` reflects the view.** The feature is
  fully independent of the token accounting; `session.total_tokens` still tracks
  the last response's `usage.total_tokens`, which now reflects the *trimmed* view
  the model actually processed.

## Known simplifications

- **The mark is on history bytes, not the whole request.** `gapBytes()` excludes
  the system prompt and the latest turn, so `truncateGap` is a ceiling on how
  much *history* to trim — not a ceiling on the literal request size. Tune it to
  taste, not to the model window.
- **The gap is measured up to the latest user turn, which is also the view
  boundary.** So the tail is excluded from both the trigger and the stubbing by
  construction; there is no separate "protect recent N" knob.
- **One turn = no gap.** Until the user sends a second message the gap is empty,
  so nothing is ever stubbed — including a very long first turn. (That turn is
  the model's active context and is exactly what we don't want to shave.)
- **Whole-body replacement (in the view).** Nothing of the original is kept in
  what the model sees (not even a head); it must re-read / re-run to recover the
  content. The full bytes remain in the stored transcript, which the client can
  see but the model does not.

## Verification (no test framework)

- `npm run typecheck` stays clean on `src/`.
- **Off regression**: `--no-trunc` makes `truncatedMessages()` return the same
  array, so the LLM request (and the snapshot) are byte-identical to today.
- **On — no live LLM**: a throwaway `node -e` harness builds a `Session` (fake
  `llm` / tools) and asserts:
  (a) with a large *history* (several old turns, big `role:'tool'` bodies) and a
  small latest turn, `truncatedMessages()` returns a **copy** in which the gap's
  oversized results are `<truncated N bytes>` (N = original byte length) while the
  latest turn and small results stay full — and `this.messages` is left
  byte-identical (non-destructive);
  (b) it fires (returns a copy) only when `gapBytes() > truncateGap`, else it
  returns the same array;
  (c) a large *latest* turn with a small gap does **not** trigger;
  (d) a single-turn conversation never triggers (empty gap);
  (e) repeated calls are pure (same view, store never mutated);
  (g) integration: a fake `llm.chat` that records its input proves the **LLM saw
  the stub** while `session.messages` keeps the **full** original and the
  assistant reply is still appended.
- **Live smoke**: `node src/main.js --port 8899 --db-file /tmp/x.clowndb
  --truncate-gap 2000 --truncate-bytes 200`; drive a session with a large
  `run_command` / `read_file` result on the *first* prompt, then send a second
  prompt, and read the persisted DB to confirm the first prompt's tool message is
  still the **full** content (never stubbed in the store) while `GET /config`
  reflects the flags.

## Build order

1. `src/config.js` (3 entries) + `src/app.js` (`GET /config`).
2. `src/session.js`: `truncatedMessages()` + `gapEnd()` + `gapBytes()`, and the
   one call in `next()`.
3. `src/loop.js`: unchanged.
4. Verification (typecheck, off-regression, on-harness, live smoke).
5. Optional: `src/prompt.js` system-prompt note.
6. Docs: cross-link this file from `AGENTS.md` and `SPEC.md` (config table + a
   pointer to the truncation section).
