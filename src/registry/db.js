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

  // 2 — разрешения перестали быть свойством подключения: теперь их даёт человек на
  // сессию и на проект, и живут они в памяти, а не в реестре.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(connections)').all().map((c) => c.name);
    if (columns.includes('confirm_policy')) db.exec('ALTER TABLE connections DROP COLUMN confirm_policy');
  },

  // 3 — хост переехал внутрь проекта: алиас стал «проект/имя», как у подключения.
  // До этого хост был общей величиной без владельца, и разрешение на проект его не
  // покрывало по построению. Теперь проект выводится из алиаса одинаково везде.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(hosts)').all().map((c) => c.name);
    if (!columns.includes('project')) db.exec('ALTER TABLE hosts ADD COLUMN project TEXT');

    for (const host of db.prepare('SELECT id, alias FROM hosts ORDER BY id').all()) {
      const alias = host.alias.includes('/') ? host.alias : projectizeHostAlias(db, host);
      db.prepare('UPDATE hosts SET alias = ?, project = ? WHERE id = ?')
        .run(alias, alias.split('/')[0], host.id);
    }

    db.exec('CREATE INDEX IF NOT EXISTS hosts_project ON hosts(project)');
  },
];

/**
 * Переименовывает плоский алиас хоста в «проект/имя». Проект ищется там, где он
 * действительно есть: в имени самого хоста («adzhubey-dev» при живом проекте adzhubey)
 * либо в подключениях, которые на хост ссылаются. Хост, не связанный ни с чем, заводит
 * собственный проект: выдумывать ему чужой владелец было бы хуже, чем назвать вещи как есть.
 */
function projectizeHostAlias(db, host) {
  const projects = new Set(db.prepare('SELECT DISTINCT project FROM connections').all().map((r) => r.project));

  let candidate = null;
  const cut = host.alias.search(/[-._]/);
  if (cut > 0) {
    const head = host.alias.slice(0, cut);
    const tail = host.alias.slice(cut + 1);
    if (projects.has(head) && /^[a-z0-9]/.test(tail)) candidate = `${head}/${tail}`;
  }

  if (!candidate) {
    const used = db.prepare(`SELECT DISTINCT c.project FROM connections c
                             WHERE c.host_id = ? ORDER BY c.project`).all(host.id);
    candidate = used.length ? `${used[0].project}/${host.alias}` : `${host.alias}/main`;
  }

  const taken = (alias) => db.prepare('SELECT 1 FROM hosts WHERE alias = ? AND id != ?').get(alias, host.id);
  if (!taken(candidate)) return candidate;

  for (let n = 2; ; n++) {
    const next = `${candidate}-${n}`;
    if (!taken(next)) return next;
  }
}

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
