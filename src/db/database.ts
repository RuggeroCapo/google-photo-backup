import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT    NOT NULL UNIQUE,
    filename        TEXT    NOT NULL,
    size            INTEGER NOT NULL,
    mtime           INTEGER NOT NULL,
    sha256          TEXT    NOT NULL,
    mime_type       TEXT    NOT NULL,
    status          TEXT    NOT NULL
                    CHECK (status IN ('pending','uploading','uploaded','failed','ignored')),
    retry_count     INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    ignored_reason  TEXT,
    duplicate_of    TEXT,
    remote_path     TEXT,
    next_attempt_at INTEGER,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    uploaded_at     TEXT
  );
  CREATE INDEX idx_files_status ON files (status, next_attempt_at, id);
  CREATE INDEX idx_files_sha256 ON files (sha256);
  CREATE INDEX idx_files_uploaded_at ON files (uploaded_at);

  -- Ledger of every content hash ever uploaded. Survives renames, moves and
  -- deletions of the local file, and is the source of truth for deduplication.
  CREATE TABLE uploaded_hashes (
    sha256      TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    remote_path TEXT,
    uploaded_at TEXT NOT NULL
  );

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
