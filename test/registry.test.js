import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-registry-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'тестовый-ключ-для-прогона';

const hosts = await import('../src/registry/hosts.js');
const connections = await import('../src/registry/connections.js');
const notes = await import('../src/registry/notes.js');
const resolve = await import('../src/registry/resolve.js');
const { db } = await import('../src/registry/db.js');

test('хост заводится и не отдаёт секрет наружу', () => {
  const host = hosts.upsertHost({
    alias: 'demo',
    address: '10.0.0.5',
    user: 'deploy',
    password: 'очень-секретный-пароль',
  });

  assert.equal(host.alias, 'demo');
  assert.equal(host.auth, 'password');
  assert.equal(host.hasSecret, true);
  assert.equal(JSON.stringify(host).includes('очень-секретный-пароль'), false);
  assert.equal(JSON.stringify(hosts.listHosts()).includes('очень-секретный-пароль'), false);
});

test('правка поля не требует повторять пароль', () => {
  hosts.upsertHost({ alias: 'demo', port: 2222 });
  const host = hosts.getHost('demo');
  assert.equal(host.port, 2222);
  assert.equal(host.hasSecret, true);
  assert.equal(host.address, '10.0.0.5');
});

test('секрет в базе лежит зашифрованным', () => {
  const rows = db().prepare('SELECT value FROM secrets').all();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.value.startsWith('v1:'), 'формат пакета');
    assert.equal(row.value.includes('очень-секретный-пароль'), false);
  }
});

test('алиас подключения обязан быть «проект/имя»', () => {
  assert.throws(() => connections.upsertConnection({ alias: 'простоимя', kind: 'shell', host: 'demo' }), /проект\/точка/);
  assert.throws(() => connections.upsertConnection({ alias: 'Проект/Шелл', kind: 'shell', host: 'demo' }), /проект\/точка/);
});

test('shell без хоста не заводится: команды выполняются по SSH', () => {
  assert.throws(
    () => connections.upsertConnection({ alias: 'demo/shell', kind: 'shell', host: null }),
    /нужен хост/,
  );
});

test('подключения ссылаются на один хост', () => {
  connections.upsertConnection({ alias: 'demo/shell', kind: 'shell', host: 'demo', config: { cwd: '/var/www' } });
  connections.upsertConnection({ alias: 'demo/files', kind: 'files', host: 'demo', config: { proto: 'sftp', root: '/var/www' } });
  connections.upsertConnection({
    alias: 'demo/db',
    kind: 'db',
    host: 'demo',
    config: { engine: 'postgres', database: 'shop', username: 'shop' },
    password: 'пароль-базы',
  });

  assert.deepEqual(connections.listConnections().map((c) => c.alias), ['demo/db', 'demo/files', 'demo/shell']);
  assert.deepEqual(hosts.hostUsage('demo'), ['demo/db', 'demo/files', 'demo/shell']);
  assert.equal(JSON.stringify(connections.listConnections()).includes('пароль-базы'), false);
});

test('база без хоста на 127.0.0.1 — это ошибка, а не подключение к самому реестру', () => {
  assert.throws(
    () => connections.upsertConnection({
      alias: 'demo/local',
      kind: 'db',
      host: null,
      config: { engine: 'postgres', database: 'x', username: 'y', address: '127.0.0.1' },
    }),
    /указывает на сам контейнер/,
  );
});

test('хост нельзя убрать, пока на него ссылаются', () => {
  assert.throws(() => hosts.removeHost('demo'), /ссылаются подключения/);
});

test('resolve отдаёт секрет только вызовом функции', () => {
  const resolved = resolve.resolve('demo/db');
  assert.equal(resolved.kind, 'db');
  assert.equal(resolved.host.alias, 'demo');
  assert.equal(resolved.port, 5432, 'порт по умолчанию для postgres');
  assert.equal(typeof resolved.secret, 'function');
  assert.equal(resolved.secret(), 'пароль-базы');
  assert.equal(JSON.stringify(resolved).includes('пароль-базы'), false);
});

test('неизвестный алиас объясняет, какие есть', () => {
  assert.throws(() => resolve.resolve('demo/нет-такого'), /не заведено.*demo\/db/s);
});

test('заметки живут по проектам и ищутся', () => {
  notes.setFact('demo', 'php.version', '8.3');
  notes.setFact('demo', 'deploy.path', '/var/www/shop');
  notes.setText('demo', 'После деплоя дёрнуть очередь: demo/queue restart.');

  const got = notes.getNotes('demo');
  assert.equal(got.facts['php.version'], '8.3');
  assert.ok(got.text.includes('очередь'));

  const found = notes.searchNotes('php');
  assert.equal(found.facts[0].project, 'demo');

  notes.setFact('demo', 'php.version', '8.4');
  assert.equal(notes.getNotes('demo').facts['php.version'], '8.4', 'факт заменяется, а не копится');
});

test('подключение убирается вместе со своим секретом', () => {
  const before = db().prepare('SELECT count(*) AS n FROM secrets').get().n;
  connections.removeConnection('demo/db');
  const after = db().prepare('SELECT count(*) AS n FROM secrets').get().n;
  assert.equal(after, before - 1);
});
