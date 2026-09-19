import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DB_FILE, ensureDirs } from '../paths.js';

let handle = null;

const MIGRATIONS = [
  // 1 — исходная схема
  (db) => {
    db.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Секреты отдельной таблицей: любая выборка метаданных физически не касается
      -- шифротекста, и случайный SELECT * по хостам не вытащит пароль.
      CREATE TABLE secrets (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL,           -- password | private_key | passphrase | dsn
        value      TEXT NOT NULL,           -- v1:<nonce>:<tag>:<ciphertext>, base64
        created_at TEXT NOT NULL
      );

      CREATE TABLE hosts (
        id              INTEGER PRIMARY KEY,
        alias           TEXT NOT NULL UNIQUE,
        address         TEXT NOT NULL,
        port            INTEGER NOT NULL DEFAULT 22,
        username        TEXT NOT NULL,
        auth_kind       TEXT NOT NULL DEFAULT 'password',   -- password | key | agent
        secret_id       INTEGER REFERENCES secrets(id),
        passphrase_id   INTEGER REFERENCES secrets(id),
        host_key_fp     TEXT,
        host_key_status TEXT NOT NULL DEFAULT 'pending',    -- pending | pinned
        note            TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE connections (
        id             INTEGER PRIMARY KEY,
        alias          TEXT NOT NULL UNIQUE,                -- project/name
        project        TEXT NOT NULL,
        kind           TEXT NOT NULL,                       -- shell | files | docker | db
        host_id        INTEGER REFERENCES hosts(id),
        config         TEXT NOT NULL DEFAULT '{}',          -- JSON без секретов
        secret_id      INTEGER REFERENCES secrets(id),
        confirm_policy TEXT NOT NULL DEFAULT 'inherit',     -- inherit | always | writes | never
        note           TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX connections_project ON connections(project);

      CREATE TABLE notes_facts (
        project    TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, key)
      );

      CREATE TABLE notes_text (
        project    TEXT PRIMARY KEY,
        body       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE approvals (
        id          TEXT PRIMARY KEY,
        ts          TEXT NOT NULL,
        tool        TEXT NOT NULL,
        alias       TEXT,
        summary     TEXT NOT NULL,
        details     TEXT,
        status      TEXT NOT NULL,                          -- pending | approved | declined | timeout
        decided_at  TEXT,
        decided_via TEXT                                    -- elicitation | web | timeout
      );
      CREATE INDEX approvals_status ON approvals(status);
    `);
  },
];

export function db() {
  if (handle) return handle;
  ensureDirs();
  handle = new Database(DB_FILE);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  migrate(handle);
  try { fs.chmodSync(DB_FILE, 0o600); } catch { /* windows / чужая fs */ }
  return handle;
}

function migrate(conn) {
  const current = conn.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v];
    conn.transaction(() => {
      step(conn);
      conn.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function close() {
  if (handle) { handle.close(); handle = null; }
}

export const meta = {
  get(key) {
    const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    db().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  },
};

export const now = () => new Date().toISOString();
