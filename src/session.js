import { EventEmitter } from 'node:events';
import { buildSystemPrompt } from './prompt.js';
import { runLoop } from './loop.js';
import { HttpError } from './errors.js';
import { config } from './config.js';
import { db } from './db.js';
import { llm } from './llm.js';
import { tools, toolSchemas } from './tools.js';

const MAX_EVENTS = 200; // bounded per-session replay ring for SSE `?since`

// Extract plain text from a message's content (string | ContentPart[]).
// For arrays, concatenates text parts and drops image_url parts.
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
  return '';
};

// Index of the last element matching pred, or -1 (Array.prototype.lastIndexOf
// has no predicate form).
const lastIndexOf = (arr, pred) => {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
};



// Session: the port of the `Clown` struct (src/model.zig). Owns the message
// list, token counter, the agentic loop, an event emitter (SSE source),
// and persistence. The fork/pipe worker is replaced by an in-process async loop
// guarded by the `running` single-flight flag.
export class Session {
  constructor({ row }) {
    this.id = row.id;
    this.cwd = row.cwd;
    this.model = row.model;
    this.status = row.status ?? 'idle';
    this.createdAt = row.created_at ?? new Date().toISOString();
    this.lastActivity = row.last_activity ?? this.createdAt;
    this.lastError = row.last_error ?? null;
    this.archived = !!row.archived;

    const snap = row.snapshot ? JSON.parse(row.snapshot) : {};
    this.messages = Array.isArray(snap.messages) ? snap.messages : [];
    this.totalTokens = snap.total_tokens ?? 0;
    if (this.messages.length === 0) this.messages = [{ role: 'system', content: buildSystemPrompt(this.cwd) }];

    this.running = false;
    this.compacting = false;
    this.abortController = null;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.seq = 0;
    this.events = [];
  }

  get signal() {
    return this.abortController?.signal ?? null;
  }

  // --- Views / persistence --------------------------------------------------

  snapshot() {
    return { messages: this.messages, total_tokens: this.totalTokens };
  }

  meta() {
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      status: this.status,
      created_at: this.createdAt,
      last_activity: this.lastActivity,
      message_count: this.messages.length,
      total_tokens: this.totalTokens,
      last_error: this.lastError,
      archived: this.archived,
    };
  }

  detail() {
    return { ...this.meta(), snapshot: this.snapshot() };
  }

  row() {
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      status: this.status,
      created_at: this.createdAt,
      last_activity: this.lastActivity,
      last_error: this.lastError,
      snapshot: JSON.stringify(this.snapshot()),
      archived: this.archived,
    };
  }

  // Persist the row to SQLite, bumping last_activity first — a persist IS
  // activity. `touch: false` for writes that aren't (the startup reload that
  // rewrites a pre-restart status must not clobber the stored timestamp).
  persist(touch = true) {
    if (touch) this.lastActivity = new Date().toISOString();
    db.upsert(this.row());
  }

  // --- Events (SSE source) --------------------------------------------------

  emit(event, data) {
    this.seq += 1;
    const rec = { seq: this.seq, event, data };
    this.events.push(rec);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emitter.emit('event', rec);
  }

  eventsSince(seq) {
    return this.events.filter((e) => e.seq > seq);
  }

  // --- Lifecycle ------------------------------------------------------------

  busy() {
    return this.running || this.compacting;
  }

  assertIdle() {
    if (this.busy()) throw new HttpError(409, 'session_busy', 'session is busy; stop it first');
  }

  begin() {
    this.abortController = new AbortController();
    this.running = true;
    this.lastError = null;
    this.setStatus('running');
  }

  end(status, error) {
    this.running = false;
    this.abortController = null;
    if (error !== undefined) this.lastError = error;
    this.setStatus(status);
  }

  setStatus(status) {
    const changed = this.status !== status;
    this.status = status;
    if (changed) this.emit('status', { status });
    this.persist();
  }

  stop() {
    if (!this.running || !this.abortController) return;
    this.setStatus('stopped'); // immediate + truthful for the caller
    this.abortController.abort('stop');
  }

  destroy() {
    this.stop();
    this.running = false;
    this.emit('status', { status: 'stopped' });
    this.emitter.emit('end');
  }

  // --- Agent loop pieces (used by loop.js) ----------------------------------

  async next() {
    const messages = this.messages;
    let attempts = 2; // auto_retry (1) + 1, as in the source
    while (attempts-- > 0) {
      const { message, usage } = await llm.chat({
        model: this.model,
        messages,
        tools: toolSchemas,
        maxCompletionTokens: 32 * 1024,
        timeoutMs: config.timeoutMs,
        signal: this.signal,
      });
      if (usage.total_tokens) this.totalTokens = usage.total_tokens;
      const empty = (message.content == null || message.content === '') && !message.tool_calls?.length;
      // A truncated completion can yield tool_calls whose `arguments` is not
      // valid JSON (the string cut off mid-value). Persisting that message
      // would poison the transcript: the provider 400s on it in every
      // subsequent request. Treat it like an empty choice — retry, and if it
      // persists fall through to the "no usable completion" error below.
      const corrupt = (message.tool_calls ?? []).some((tc) => {
        const args = tc.function?.arguments;
        if (!args) return false; // absent/empty = no params, fine
        try { JSON.parse(args); return false; } catch { return true; }
      });
      if (empty || corrupt) continue; // retry on empty or corrupt choice
      this.messages.push(message); // record the real response in the full transcript
      return message.tool_calls ?? null;
    }
    throw new Error('LLM returned no usable completion');
  }

  async accept(tc) {
    const t = tools.get(tc.function.name);
    let content;
    if (!t) {
      content = `Unknown tool: ${tc.function.name}`;
    } else {
      let args = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      try {
        const result = await t.run(this.toolContext(), args);
        content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      } catch (err) {
        content = `Error: ${err?.message ?? err}`; // tool errors become content, loop continues
      }
    }
    this.messages.push({ role: 'tool', content, tool_call_id: tc.id });
  }

  toolContext() {
    return {
      cwd: this.cwd,
      signal: this.signal,
      timeoutMs: config.timeoutMs,
      emit: (e, d) => this.emit(e, d),
    };
  }

  // --- Operations (port of Clown methods) -----------------------------------

  // Append a user message and push a snapshot so the live transcript shows it
  // immediately (before the loop's first LLM turn) — same pattern as undo/clear.
  appendUser(text) {
    this.messages.push({ role: 'user', content: text });
    this.emit('snapshot', this.snapshot());
    this.persist();
  }

  // Append a user message and start the loop (fire-and-forget; the caller gets 202).
  // `model` (optional) is the model the client wants for this run: it is pinned
  // for the whole run and persisted as the session's "last used" model, which is
  // what the web UI pre-fills the picker from (and what retry/init/compact reuse).
  send(text, model) {
    this.assertIdle();
    if (model) {
      this.model = model;
      this.persist();
    }
    this.appendUser(text);
    void runLoop(this);
  }

  // Append a user message and await the loop to finish (used by compact).
  async run(text) {
    this.appendUser(text);
    await runLoop(this);
  }

  popTrailing() {
    while (this.messages.length) {
      const m = this.messages.at(-1);
      if (m.role !== 'assistant' && m.role !== 'tool') break;
      this.messages.pop();
    }
  }

  retry() {
    this.assertIdle();
    this.popTrailing();
    void runLoop(this);
  }

  // Roll the transcript back to just before the LAST assistant message — strip
  // that message and everything after it (any tool results it spawned and any
  // later user nudge) — then re-run the loop from there. Unlike retry() (which
  // rolls back to the last user message), this reaches a poisoned mid-turn
  // assistant response (e.g. a truncated tool call) that is followed by a tool
  // result + user message, which popTrailing() can't get to. The new tail is
  // the message before the stripped assistant — always a valid user/tool
  // resume point for the loop.
  retryTurn() {
    this.assertIdle();
    const i = lastIndexOf(this.messages, (m) => m.role === 'assistant');
    if (i === -1) throw new HttpError(400, 'bad_request', 'no assistant message to retry');
    this.messages.length = i; // strip the last assistant msg and everything after it
    this.emit('snapshot', this.snapshot());
    this.persist();
    void runLoop(this);
  }

  // Roll a mid-turn transcript back to a valid boundary. The loop appends an
  // assistant tool_calls message before executing its tools, so a copy taken
  // while the source is running can end with calls that lack tool results —
  // invalid to send back to the LLM. If (and only if) the trailing assistant
  // tool_calls is not fully answered by the tool messages after it, strip
  // that message and its (partial) results. Completed transcripts are
  // untouched — a fork of an idle session keeps the final assistant reply.
  settle() {
    let i = this.messages.length - 1;
    while (i >= 0 && this.messages[i].role === 'tool') i--;
    const a = this.messages[i];
    if (!a || a.role !== 'assistant' || !a.tool_calls?.length) return;
    const answered = new Set(this.messages.slice(i + 1).map((m) => m.tool_call_id));
    if (a.tool_calls.some((tc) => !answered.has(tc.id))) this.messages.length = i;
  }

  init() {
    this.send('Could you /init this project?');
  }

  undo() {
    if (this.running) this.stop();
    this.popTrailing();
    let undone = '';
    if (this.messages.length && this.messages.at(-1).role === 'user') {
      undone = textOf(this.messages.pop().content);
    }
    this.emit('snapshot', this.snapshot());
    this.persist();
    return undone;
  }

  clear() {
    if (this.running) this.stop();
    this.messages = [{ role: 'system', content: buildSystemPrompt(this.cwd) }];
    this.emit('snapshot', this.snapshot());
    this.persist();
  }

  clearTools() {
    if (this.running) this.stop();
    this.messages = this.messages.filter((m) => m.role !== 'tool');
    this.emit('snapshot', this.snapshot());
    this.persist();
  }

  // Flag the session as archived (or not). A metadata-only edit: allowed while
  // running, it never touches the conversation. Archived sessions persist but
  // are hidden from the default
  // `GET /sessions` list.
  setArchived(archived) {
    this.archived = !!archived;
    this.persist();
  }

  // Two-phase summarize-then-replace compaction (port of compact/finishCompact).
  // Synchronous entry point so assertIdle() propagates to the HTTP layer (409).
  compact() {
    this.assertIdle();
    this.compacting = true;
    void this.doCompact();
  }

  async doCompact() {
    try {
      await this.run(
        'Please provide a concise summary of the conversation so far.\n' +
          'Include:\n' +
          '- Current state of any ongoing tasks\n' +
          '- Key decisions and their rationale\n' +
          '- Important file paths and code snippets\n' +
          '- Anything that is absolutely neccessary in order to continue the work\n' +
          'Keep it under 2000 characters. After providing the summary, stop.',
      );
      const last = this.messages[this.messages.length - 1];
      if (!last || last.role !== 'assistant') return;
      const fmt =
        'The conversation history has been compacted to save context space. Acknowledge this and ask user what they want to do next.\n\n' +
        `<compacted summary>\n${last.content ?? ''}\n</compacted summary>`;
      this.clear();
      await this.run(fmt);
    } catch (err) {
      this.status = 'error';
      this.lastError = err?.message ?? String(err);
      this.emit('error', { message: this.lastError });
      this.persist();
    } finally {
      this.compacting = false;
    }
  }
}
