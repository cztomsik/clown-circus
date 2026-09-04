import { randomUUID } from 'node:crypto';
import { Session } from './session.js';
import { HttpError } from './errors.js';

// SessionManager: the multi-session registry. Loads every session from the DB
// into memory at startup (resetting any in-flight status to idle), and owns
// create/list/get/delete + persist-on-change. The in-memory map is the hot
// state; the DB mirrors it as the system of record.
export class SessionManager {
  constructor({ db, config, llm, tools, toolSchemas }) {
    this.db = db;
    this.config = config;
    this.llm = llm;
    this.tools = tools;
    this.toolSchemas = toolSchemas;
    this.sessions = new Map();
    this._load();
  }

  _opts() {
    return { db: this.db, llm: this.llm, tools: this.tools, toolSchemas: this.toolSchemas, config: this.config };
  }

  _track(s) {
    if (this.config.verbose)
      s.emitter.on('event', (rec) => {
        if (rec.event === 'snapshot') return;
        console.log(`[${new Date().toISOString()}] session=${s.id} ${rec.event} ${JSON.stringify(rec.data)}`);
      });
  }

  _load() {
    for (const row of this.db.all()) {
      // An in-flight loop can't survive a restart: running/stopped -> idle.
      const status = row.status === 'running' || row.status === 'stopped' ? 'idle' : row.status;
      const s = new Session({ row: { ...row, status }, ...this._opts() });
      this.sessions.set(s.id, s);
      s.persist();
      this._track(s);
    }
  }

  create({ cwd, model }) {
    if (this.config.maxSessions && this.sessions.size >= this.config.maxSessions)
      throw new HttpError(400, 'bad_request', `max sessions (${this.config.maxSessions}) reached`);

    const now = new Date().toISOString();
    const snap = { messages: [], todos: [], total_tokens: 0 };
    const row = {
      id: randomUUID(),
      cwd,
      model: model ?? this.config.model,
      status: 'idle',
      created_at: now,
      last_activity: now,
      last_error: null,
      snapshot: JSON.stringify(snap),
      archived: false,
    };
    const s = new Session({ row, ...this._opts() });
    s.persist();
    this.sessions.set(s.id, s);
    this._track(s);
    return s;
  }

  // `archived` is a tri-state filter, mirroring `GET /sessions?archived=`:
  // undefined/false → non-archived only (the default), true → archived only,
  // 'all' → everything.
  /** @param {{ cwd?: string, archived?: boolean | 'all' }} o */
  list({ cwd, archived } = {}) {
    const keep = (s) =>
      (archived === 'all' ? true : archived ? s.archived : !s.archived);
    return [...this.sessions.values()]
      .filter((s) => (!cwd || s.cwd === cwd) && keep(s))
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
    this.db.deleteRow(id);
    return true;
  }
}
