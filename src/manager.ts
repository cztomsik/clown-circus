import { randomUUID } from 'node:crypto';
import { Session } from './session.ts';
import { HttpError } from './errors.ts';
import { config } from './config.ts';
import { db } from './db.ts';

// SessionManager: the multi-session registry. Loads every session from the DB
// into memory at startup (resetting any in-flight status to idle), and owns
// create/list/get/delete + persist-on-change. The in-memory map is the hot
// state; the DB mirrors it as the system of record.
export class SessionManager {
  sessions: Map<string, Session>;
  constructor() {
    this.sessions = new Map();
    this._load();
  }

  _track(s) {
    if (config.verbose)
      s.emitter.on('event', (rec) => {
        // Transcript events (message/history) can carry MB-scale payloads.
        if (rec.event === 'message' || rec.event === 'history') return;
        console.log(`[${new Date().toISOString()}] session=${s.id} ${rec.event} ${JSON.stringify(rec.data)}`);
      });
  }

  _load() {
    // One pass over the messages table, grouped per session (rowid order =
    // transcript order).
    const bySession = new Map();
    for (const r of db.allMessages()) {
      if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
      bySession.get(r.session_id).push(r);
    }
    for (const row of db.all()) {
      // An in-flight loop can't survive a restart: running/stopped -> idle.
      const status = row.status === 'running' || row.status === 'stopped' ? 'idle' : row.status;
      const s = new Session({ row: { ...row, status }, transcript: bySession.get(row.id) ?? [] });
      s.backfillTitle(); // pre-title DBs: derive from the first user message
      this.sessions.set(s.id, s);
      s.persist(false); // status rewrite is not activity: keep the stored timestamp
      this._track(s);
    }
  }

  create({ cwd, model }) {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      cwd,
      model,
      status: 'idle',
      created_at: now,
      last_activity: now,
      last_error: null,
      total_tokens: 0,
      archived: false,
      title: null,
    };
    const s = new Session({ row });
    s.persist();
    this.sessions.set(s.id, s);
    this._track(s);
    return s;
  }

  // Fork a session: a new session with the same cwd/model/archived, fresh
  // id/timestamps, last_error cleared, and a deep copy of the transcript
  // (the JSON round-trip in importTranscript makes the copy fully independent
  // of the source's message objects). Allowed while the source is running: if
  // the copy ends mid-turn (an assistant tool_calls whose tool results have
  // not all arrived yet — an invalid LLM transcript), settle() strips that
  // message and its partial results; completed transcripts are copied
  // verbatim.
  fork(id) {
    const src = this.require(id);

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      cwd: src.cwd,
      model: src.model,
      status: 'idle',
      created_at: now,
      last_activity: now,
      last_error: null,
      total_tokens: 0,
      archived: src.archived,
      title: src.title, // a fork continues the same conversation
    };
    const s = new Session({ row });
    s.persist(); // the session row must exist before its message rows (FK)
    s.importTranscript(src.messages.slice(1)); // system prompt is re-derived
    s.settle(); // a running source may end with pending tool_calls
    this.sessions.set(s.id, s);
    this._track(s);
    return s;
  }

  // `includeArchived` (default false): when true, archived sessions are included
  // in the result; when false, only non-archived sessions are returned. Mirrors
  // the `?archived` flag on `GET /sessions`.
  list({ cwd, includeArchived = false }: { cwd?: string; includeArchived?: boolean } = {}) {
    return [...this.sessions.values()]
      .filter((s) => (!cwd || s.cwd === cwd) && (includeArchived || !s.archived))
      .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))
      .map((s) => s.meta());
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  require(id) {
    const s = this.get(id);
    if (!s) throw new HttpError(404, 'not_found', 'session not found');
    return s;
  }

  delete(id) {
    const s = this.get(id);
    if (!s) return false;
    s.destroy();
    this.sessions.delete(id);
    db.deleteRow(id);
    return true;
  }
}
