import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Хосты переехали внутрь проекта: плоский алиас стал «проект/имя». Реестры, заведённые
// до этого, лежат у людей на дисках, поэтому переименование проверяется на такой же
// базе, какой она была до миграции, а не на выдуманной.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-migrate-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-миграции';

const OLD_SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE hosts (
    id INTEGER PRIMARY KEY, alias TEXT NOT NULL UNIQUE, address TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL,
    auth_kind TEXT NOT NULL DEFAULT 'password', secret_id INTEGER, passphrase_id INTEGER,
    host_key_fp TEXT, host_key_status TEXT NOT NULL DEFAULT 'pending', note TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE connections (
    id INTEGER PRIMARY KEY, alias TEXT NOT NULL UNIQUE, project TEXT NOT NULL, kind TEXT NOT NULL,
    host_id INTEGER, config TEXT NOT NULL DEFAULT '{}', secret_id INTEGER, note TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE notes_facts (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (project, key));
  CREATE TABLE notes_text (project TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE approvals (id TEXT PRIMARY KEY, ts TEXT NOT NULL, tool TEXT NOT NULL, alias TEXT,
    summary TEXT NOT NULL, details TEXT, status TEXT NOT NULL, decided_at TEXT, decided_via TEXT);
`;

const TS = '2026-09-19T00:00:00.000Z';

/*
 * Реестр, каким он был до переезда:
 *   adzhubey-dev — приставка совпадает с живым проектом;
 *   bare         — приставки нет, но на хост ссылается подключение проекта shop;
 *   orphan       — не связан ни с чем;
 *   shop/prod    — имя, в которое упрётся переименование shop-prod.
 */
fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
const old = new Database(path.join(root, 'registry', 'registry.sqlite'));
old.exec(OLD_SCHEMA);

const addHost = old.prepare(`INSERT INTO hosts (alias, address, username, created_at, updated_at)
  VALUES (?, '10.0.0.1', 'deploy', '${TS}', '${TS}')`);
for (const alias of ['adzhubey-dev', 'bare', 'orphan', 'shop/prod', 'shop-prod']) addHost.run(alias);

const idOf = (alias) => old.prepare('SELECT id FROM hosts WHERE alias = ?').get(alias).id;
const addConn = old.prepare(`INSERT INTO connections (alias, project, kind, host_id, created_at, updated_at)
  VALUES (?, ?, 'shell', ?, '${TS}', '${TS}')`);

addConn.run('adzhubey/dev-shell', 'adzhubey', idOf('adzhubey-dev'));
addConn.run('shop/files', 'shop', idOf('bare'));

old.pragma('user_version = 2');
old.close();

const { db } = await import('../src/registry/db.js');
const host = (where, ...args) => db().prepare(`SELECT alias, project FROM hosts WHERE ${where}`).get(...args);

test('приставка с именем живого проекта становится проектом', () => {
  const row = host("alias LIKE 'adzhubey/%'");
  assert.deepEqual(row, { alias: 'adzhubey/dev', project: 'adzhubey' });
});

test('хост без приставки берёт проект своих подключений', () => {
  const row = host("alias LIKE '%/bare'");
  assert.deepEqual(row, { alias: 'shop/bare', project: 'shop' });
});

test('хост-сирота заводит собственный проект, а не приписывается к чужому', () => {
  const row = host("project = 'orphan'");
  assert.equal(row.alias, 'orphan/main');
});

test('уже проектный алиас не переименовывается, но получает проект', () => {
  const row = host("alias = 'shop/prod'");
  assert.equal(row.project, 'shop');
});

test('занятое имя получает суффикс, а не затирает чужой хост', () => {
  const row = host("alias = 'shop/prod-2'");
  assert.equal(row.project, 'shop');
  assert.equal(db().prepare('SELECT count(*) AS n FROM hosts').get().n, 5, 'ни один хост не потерялся');
});

test('подключения остаются привязаны к тем же хостам', () => {
  const row = db().prepare(`SELECT h.alias FROM connections c JOIN hosts h ON h.id = c.host_id
                            WHERE c.alias = 'adzhubey/dev-shell'`).get();
  assert.equal(row.alias, 'adzhubey/dev');
});
