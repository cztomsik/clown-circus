import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

const SCHEMA_VERSION = 2;

// Open (creating parents if needed) the SQLite file, run idempotent DDL and
// versioned migrations, and return a small query-helper object. The
// `snapshot` column is a JSON string.
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
      status        TEXT NOT NULL DEFAULT 'idle',
      created_at    TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error    TEXT,
      snapshot      TEXT NOT NULL,
      archived      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions (cwd);
  `);
  // Versioned migrations: user_version tracks the schema. A fresh DB is born
  // at 0 and already matches SCHEMA_VERSION (the DDL above), so it only needs
  // the bump; v1 DBs get the `archived` column added.
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v === 1) db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);

  const upsert = (r) =>
    db
      .prepare(
        `INSERT INTO sessions (id, cwd, model, status, created_at, last_activity, last_error, snapshot, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           model = excluded.model,
           status = excluded.status,
           last_activity = excluded.last_activity,
           last_error = excluded.last_error,
           snapshot = excluded.snapshot,
           archived = excluded.archived`,
      )
      .run(r.id, r.cwd, r.model, r.status, r.created_at, r.last_activity, r.last_error ?? null, r.snapshot, r.archived ? 1 : 0);

  // The SessionManager lists/projects from its in-memory map (which applies the
  // archived filter); only `all` (startup load) and `deleteRow` are needed here.
  const all = () => db.prepare('SELECT * FROM sessions').all();

  const deleteRow = (id) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

  return { close: () => db.close(), upsert, all, deleteRow };
};

// One connection for the whole process — opened (and migrated) at import time.
export const db = openDb(config.dbFile);
