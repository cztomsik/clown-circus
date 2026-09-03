import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

// Open (creating parents if needed) the SQLite file, run idempotent DDL,
// and return a small query-helper object. The `snapshot` column is a JSON string.
export const openDb = (dbFile) => {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);

  db.exec('PRAGMA journal_mode = DELETE;'); // keep a single self-contained file
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      cwd           TEXT NOT NULL,
      model         TEXT NOT NULL DEFAULT 'default',
      status        TEXT NOT NULL DEFAULT 'idle',
      created_at    TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error    TEXT,
      snapshot      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions (cwd);
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);

  const upsert = (r) =>
    db
      .prepare(
        `INSERT INTO sessions (id, cwd, model, status, created_at, last_activity, last_error, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           model = excluded.model,
           status = excluded.status,
           last_activity = excluded.last_activity,
           last_error = excluded.last_error,
           snapshot = excluded.snapshot`,
      )
      .run(r.id, r.cwd, r.model, r.status, r.created_at, r.last_activity, r.last_error ?? null, r.snapshot);

  const get = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;

  const list = ({ cwd } = {}) => {
    const sql = cwd
      ? 'SELECT * FROM sessions WHERE cwd = ? ORDER BY last_activity DESC'
      : 'SELECT * FROM sessions ORDER BY last_activity DESC';
    return cwd ? db.prepare(sql).all(cwd) : db.prepare(sql).all();
  };

  const all = () => db.prepare('SELECT * FROM sessions').all();

  const projects = () =>
    db.prepare('SELECT cwd, COUNT(*) AS sessions FROM sessions GROUP BY cwd ORDER BY cwd').all();

  const deleteRow = (id) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

  return { close: () => db.close(), upsert, get, list, all, projects, deleteRow };
};
