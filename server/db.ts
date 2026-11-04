import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

const SCHEMA_VERSION = 5;

// Open (creating parents if needed) the SQLite file, run idempotent DDL and
// versioned migrations, and return a small query-helper object. Each session
// is one `sessions` row; its transcript is one `messages` row per message
// (JSON in `data`, rowid-ordered). The system prompt is derived at load time
// and never stored.
const openDb = (dbFile) => {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);

  db.exec('PRAGMA journal_mode = DELETE;'); // keep a single self-contained file
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      cwd           TEXT NOT NULL,
      model         TEXT NOT NULL,
      reasoning_effort TEXT,
      status        TEXT NOT NULL DEFAULT 'idle',
      created_at    TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error    TEXT,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      archived      INTEGER NOT NULL DEFAULT 0,
      title         TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions (cwd);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id);
  `);
  // Versioned migrations: user_version tracks the schema. A DB at version v has
  // migrations 1..v applied; apply the pending ones (v+1 .. SCHEMA_VERSION) in
  // order. A fresh DB is v0 and the DDL above already carries every column, so
  // it only needs the bump below.
  const v = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (v >= 1) {
    if (v < 2) db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    if (v < 3) {
      db.exec('BEGIN');
      try {
        db.exec('ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0');
        const upTok = db.prepare('UPDATE sessions SET total_tokens = ? WHERE id = ?');
        const insMsg = db.prepare('INSERT INTO messages (session_id, data) VALUES (?, ?)');
        for (const r of db.prepare('SELECT id, snapshot FROM sessions').all()) {
          const snap = r.snapshot ? JSON.parse(String(r.snapshot)) : {};
          const tokens = snap.total_tokens ?? 0;
          if (tokens) upTok.run(tokens, r.id);
          for (const m of snap.messages ?? []) {
            if (m.role === 'system') continue; // derived at load time, not stored
            insMsg.run(r.id, JSON.stringify(m));
          }
        }
        db.exec('ALTER TABLE sessions DROP COLUMN snapshot');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    if (v < 4) db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
    if (v < 5) db.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT');
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);

  const upsert = (r) =>
    db
      .prepare(
        `INSERT INTO sessions (id, cwd, model, reasoning_effort, status, created_at, last_activity, last_error, total_tokens, archived, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           model = excluded.model,
           reasoning_effort = excluded.reasoning_effort,
           status = excluded.status,
           last_activity = excluded.last_activity,
           last_error = excluded.last_error,
           total_tokens = excluded.total_tokens,
           archived = excluded.archived,
           title = excluded.title`,
      )
      .run(r.id, r.cwd, r.model, r.reasoning_effort ?? null, r.status, r.created_at, r.last_activity, r.last_error ?? null, r.total_tokens ?? 0, r.archived ? 1 : 0, r.title ?? null);

  const insertMessage = (sessionId, data) =>
    Number(db.prepare('INSERT INTO messages (session_id, data) VALUES (?, ?)').run(sessionId, data).lastInsertRowid);

  // One pass over the whole table, rowid-ordered (transcript order within a session).
  const allMessages = () => db.prepare('SELECT session_id, id, data FROM messages ORDER BY id').all();

  const deleteMessages = (ids) => {
    const del = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of ids) del.run(id);
  };

  const updateMessage = (id, data) => db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(data, id);

  const all = () => db.prepare('SELECT * FROM sessions').all();

  // Message rows go with the session (ON DELETE CASCADE, foreign_keys ON).
  const deleteRow = (id) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

  return { close: () => db.close(), upsert, all, allMessages, insertMessage, deleteMessages, updateMessage, deleteRow };
};

// One connection for the whole process — opened (and migrated) at import time.
export const db = openDb(config.dbFile);
