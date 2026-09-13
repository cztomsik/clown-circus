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
        if (rec.event === 'snapshot') return;
        console.log(`[${new Date().toISOString()}] session=${s.id} ${rec.event} ${JSON.stringify(rec.data)}`);
      });
  }

  _load() {
    for (const row of db.all()) {
      // An in-flight loop can't survive a restart: running/stopped -> idle.
      const status = row.status === 'running' || row.status === 'stopped' ? 'idle' : row.status;
      const s = new Session({ row: { ...row, status } });
      this.sessions.set(s.id, s);
      s.persist(false); // status rewrite is not activity: keep the stored timestamp
      this._track(s);
    }
  }

  create({ cwd, model }) {
    const now = new Date().toISOString();
    const snap = { messages: [], total_tokens: 0 };
    const row = {
      id: randomUUID(),
      cwd,
      model,
      status: 'idle',
      created_at: now,
      last_activity: now,
      last_error: null,
      snapshot: JSON.stringify(snap),
      archived: false,
    };
    const s = new Session({ row });
    s.persist();
    this.sessions.set(s.id, s);
    this._track(s);
    return s;
  }

  // Fork a session: a new session with the same cwd/model/archived, fresh
  // id/timestamps, last_error cleared, and a deep copy of the transcript
  // (the JSON round-trip in the row makes the copy fully independent of the
  // source's message array). Allowed while the source is running: if the
  // copy ends mid-turn (an assistant tool_calls whose tool results have not
  // all arrived yet — an invalid LLM transcript), settle() strips that
  // message and its partial results; completed transcripts are copied verbatim.
  duplicate(id) {
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
      snapshot: JSON.stringify(src.snapshot()), // JSON round-trip → deep copy
      archived: src.archived,
    };
    const s = new Session({ row });
    s.settle(); // a running source may end with pending tool_calls
    s.persist();
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

  // Projects derived from non-archived sessions only — a project whose
  // sessions are all archived would otherwise list with zero visible sessions.
  projects() {
    const m = new Map();
    for (const s of this.sessions.values()) {
      if (s.archived) continue;
      m.set(s.cwd, (m.get(s.cwd) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([cwd, sessions]) => ({ cwd, sessions }))
      .sort((a, b) => (a.cwd < b.cwd ? -1 : 1));
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
