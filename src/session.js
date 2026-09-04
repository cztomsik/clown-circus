import { EventEmitter } from 'node:events';
import { buildSystemPrompt } from './prompt.js';
import { runLoop } from './loop.js';
import { HttpError } from './errors.js';

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
// list, todos, token counter, the agentic loop, an event emitter (SSE source),
// and persistence. The fork/pipe worker is replaced by an in-process async loop
// guarded by the `running` single-flight flag.
export class Session {
  constructor({ row, db, llm, tools, toolSchemas, config }) {
    this.id = row.id;
    this.cwd = row.cwd;
    this.model = row.model ?? config.model;
    this.status = row.status ?? 'idle';
    this.createdAt = row.created_at ?? new Date().toISOString();
    this.lastActivity = row.last_activity ?? this.createdAt;
    this.lastError = row.last_error ?? null;

    this.db = db;
    this.llm = llm;
    this.tools = tools;
    this.toolSchemas = toolSchemas;
    this.config = config;

    const snap = row.snapshot ? JSON.parse(row.snapshot) : {};
    this.messages = Array.isArray(snap.messages) ? snap.messages : [];
    this.todos = Array.isArray(snap.todos) ? snap.todos : [];
    this.totalTokens = snap.total_tokens ?? 0;
    if (this.messages.length === 0) this.messages = [{ role: 'system', content: buildSystemPrompt(this.cwd, this.config.autoTruncate) }];

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
    return { messages: this.messages, todos: this.todos, total_tokens: this.totalTokens };
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
      todo_count: this.todos.length,
      total_tokens: this.totalTokens,
      last_error: this.lastError,
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
    };
  }

  persist() {
    this.db.upsert(this.row());
  }

  touch() {
    this.lastActivity = new Date().toISOString();
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
    this.touch();
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

  // Auto-truncation (see AUTO_TRUNCATE.md). Non-destructive to the transcript:
  // the DB / web UI keep the full content forever; only the copy handed to the
  // LLM has the *history gap's* (messages before the latest user turn) stale
  // oversized tool results stubbed to `<truncated N bytes>`. The latest
  // user-assistant turn (the tail) is never trimmed.

  // End of the gap = start of the latest user turn (the sacrosanct tail).
  gapEnd() {
    const i = lastIndexOf(this.messages, (m) => m.role === 'user');
    return i === -1 ? this.messages.length : i; // single turn -> empty gap
  }

  // Bytes of the full history gap. The system prompt is excluded — it is
  // constant context, not history — so the mark is a pure ceiling on how much
  // history to trim.
  gapBytes() {
    const end = this.gapEnd();
    return this.messages.slice(0, end).reduce((n, m) =>
      m.role === 'system'
        ? n
        : n + Buffer.byteLength(typeof m.content === 'string' ? m.content : String(m.content), 'utf8'), 0);
  }

  // The transcript as the LLM should see it: when the gap is over the mark,
  // return a shallow copy with each oversized gap tool result replaced by a
  // stub. this.messages is never mutated, so persistence + the web UI keep the
  // full content. Pure and idempotent.
  truncatedMessages() {
    if (!this.config.autoTruncate) return this.messages;
    if (this.gapBytes() <= this.config.truncateGap) return this.messages; // history under the mark
    const budget = this.config.truncateBytes;
    const end = this.gapEnd(); // everything from here on is the tail
    const out = this.messages.slice(); // same refs except the stubbed tool msgs
    for (let i = 0; i < end; i++) {
      const m = out[i];
      if (m.role !== 'tool') continue;
      const n = Buffer.byteLength(m.content, 'utf8');
      if (n <= budget) continue; // small enough, leave it
      out[i] = { ...m, content: `<truncated ${n} bytes>` }; // new object; original untouched
    }
    return out;
  }

  async next() {
    const messages = this.truncatedMessages(); // LLM-bound view (stubbed iff gap over mark)
    let attempts = 2; // auto_retry (1) + 1, as in the source
    while (attempts-- > 0) {
      const { message, usage } = await this.llm.chat({
        model: this.model,
        messages,
        tools: this.toolSchemas,
        maxCompletionTokens: 32 * 1024,
        timeoutMs: this.config.timeoutMs,
        signal: this.signal,
      });
      if (usage.total_tokens) this.totalTokens = usage.total_tokens;
      const empty = (message.content == null || message.content === '') && !message.tool_calls?.length;
      if (empty) continue; // retry on empty choice
      this.messages.push(message); // record the real response in the full transcript
      return message.tool_calls ?? null;
    }
    throw new Error('LLM returned no usable completion');
  }

  async accept(tc) {
    const t = this.tools.get(tc.function.name);
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
      timeoutMs: this.config.timeoutMs,
      todos: this.todos,
      emit: (e, d) => this.emit(e, d),
      setTodos: (todos) => {
        this.todos = todos;
        this.emit('todo', todos);
        this.touch();
        this.persist();
      },
    };
  }

  // --- Operations (port of Clown methods) -----------------------------------

  // Append a user message and push a snapshot so the live transcript shows it
  // immediately (before the loop's first LLM turn) — same pattern as undo/clear.
  appendUser(text) {
    this.messages.push({ role: 'user', content: text });
    this.touch();
    this.emit('snapshot', this.snapshot());
    this.persist();
  }

  // Append a user message and start the loop (fire-and-forget; the caller gets 202).
  send(text) {
    this.assertIdle();
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
    this.touch();
    this.emit('snapshot', this.snapshot());
    this.persist();
    return undone;
  }

  clear() {
    if (this.running) this.stop();
    this.messages = [{ role: 'system', content: buildSystemPrompt(this.cwd, this.config.autoTruncate) }];
    this.todos = [];
    this.touch();
    this.emit('todo', this.todos);
    this.emit('snapshot', this.snapshot());
    this.persist();
  }

  clearTools() {
    if (this.running) this.stop();
    this.messages = this.messages.filter((m) => m.role !== 'tool');
    this.touch();
    this.emit('snapshot', this.snapshot());
    this.persist();
  }

  // Switch the session's model. Allowed while running: the loop reads
  // this.model on every turn (see next()), so the change takes effect from the
  // next LLM call — no stop/restart required.
  setModel(model) {
    this.model = model;
    this.touch();
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
      this.touch();
      this.emit('error', { message: this.lastError });
      this.persist();
    } finally {
      this.compacting = false;
    }
  }
}
