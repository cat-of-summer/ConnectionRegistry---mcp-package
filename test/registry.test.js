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
const projects = await import('../src/registry/projects.js');
const resolve = await import('../src/registry/resolve.js');
const { db } = await import('../src/registry/db.js');
const { cfg } = await import('../src/config.js');

test('проект заводится явно и только с рабочей директорией', () => {
  assert.throws(() => projects.upsertProject({ project: 'demo' }), /хотя бы с одной рабочей директорией/);
  assert.throws(() => projects.upsertProject({ project: 'demo', dirs: [{ path: '/srv/demo' }] }), /комментарий/);
  assert.throws(() => projects.upsertProject({ project: 'Demo', dirs: [{ path: '/srv/demo', comment: 'код' }] }), /строчными/);

  const made = projects.upsertProject({ project: 'demo', comment: 'магазин', dirs: [{ path: '/srv/demo', comment: 'код, git' }] });
  assert.equal(made.project, 'demo');
  assert.deepEqual(made.dirs.map((d) => d.path), ['/srv/demo']);
  assert.deepEqual(projects.projects(), ['demo']);
});

test('хост и подключение без заведённого проекта не заводятся', () => {
  assert.throws(() => hosts.upsertHost({ alias: 'ghost/srv', address: '10.0.0.9', user: 'x', password: 'y' }), /не заведён.*project_set/);
  assert.throws(() => notes.setFact('ghost', 'php.version', '8.3'), /не заведён/);
});

test('директории сливаются по пути, последняя не убирается', () => {
  projects.upsertProject({ project: 'demo', dirs: [{ path: '/srv/demo-front', comment: 'фронтенд, git' }] });
  projects.upsertProject({ project: 'demo', dirs: [{ path: '/srv/demo', comment: 'код Laravel, git' }] });

  const got = projects.getProject('demo');
  assert.equal(got.comment, 'магазин', 'комментарий проекта без правки остаётся');
  assert.deepEqual(got.dirs.map((d) => [d.path, d.comment]), [['/srv/demo', 'код Laravel, git'], ['/srv/demo-front', 'фронтенд, git']]);

  projects.removeDir('demo', '/srv/demo-front');
  assert.throws(() => projects.removeDir('demo', '/srv/demo'), /единственная директория/);
});

test('хост заводится и не отдаёт секрет наружу', () => {
  const host = hosts.upsertHost({
    alias: 'demo/srv',
    address: '10.0.0.5',
    user: 'deploy',
    password: 'очень-секретный-пароль',
  });

  assert.equal(host.alias, 'demo/srv');
  assert.equal(host.auth, 'password');
  assert.equal(host.hasSecret, true);
  assert.equal(JSON.stringify(host).includes('очень-секретный-пароль'), false);
  assert.equal(JSON.stringify(hosts.listHosts()).includes('очень-секретный-пароль'), false);
});

test('правка поля не требует повторять пароль', () => {
  hosts.upsertHost({ alias: 'demo/srv', port: 2222 });
  const host = hosts.getHost('demo/srv');
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

test('алиас хоста обязан быть «проект/имя»: сервер живёт в проекте', () => {
  assert.throws(() => hosts.upsertHost({ alias: 'простоимя', address: '10.0.0.6', user: 'x', password: 'y' }), /проект\/имя/);
  assert.equal(hosts.getHost('demo/srv').project, 'demo');
});

test('алиас подключения обязан быть «проект/имя»', () => {
  assert.throws(() => connections.upsertConnection({ alias: 'простоимя', kind: 'shell', host: 'demo/srv' }), /проект\/точка/);
  assert.throws(() => connections.upsertConnection({ alias: 'Проект/Шелл', kind: 'shell', host: 'demo/srv' }), /проект\/точка/);
});

test('shell без хоста не заводится: команды выполняются по SSH', () => {
  assert.throws(
    () => connections.upsertConnection({ alias: 'demo/shell', kind: 'shell', host: null }),
    /нужен хост/,
  );
});

test('подключения ссылаются на один хост', () => {
  connections.upsertConnection({ alias: 'demo/shell', kind: 'shell', host: 'demo/srv', config: { cwd: '/var/www' } });
  connections.upsertConnection({ alias: 'demo/files', kind: 'files', host: 'demo/srv', config: { proto: 'sftp', root: '/var/www' } });
  connections.upsertConnection({
    alias: 'demo/db',
    kind: 'db',
    host: 'demo/srv',
    config: { engine: 'postgres', database: 'shop', username: 'shop' },
    password: 'пароль-базы',
  });

  assert.deepEqual(connections.listConnections().map((c) => c.alias), ['demo/db', 'demo/files', 'demo/shell']);
  assert.deepEqual(hosts.hostUsage('demo/srv'), ['demo/db', 'demo/files', 'demo/shell']);
  assert.equal(JSON.stringify(connections.listConnections()).includes('пароль-базы'), false);
});

test('hostProjects называет всех, кого задевает правка хоста', () => {
  projects.upsertProject({ project: 'other', dirs: [{ path: '/srv/other', comment: 'код' }] });
  connections.upsertConnection({ alias: 'other/shell', kind: 'shell', host: 'demo/srv', config: { cwd: '/srv' } });

  assert.deepEqual(hosts.hostProjects('demo/srv'), ['demo', 'other'], 'свой проект плюс чужие подключения');
  assert.deepEqual(hosts.listHosts({ project: 'other' }), [], 'хост остаётся в своём проекте');

  connections.removeConnection('other/shell');
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
  assert.throws(() => hosts.removeHost('demo/srv'), /ссылаются подключения/);
});

test('resolve отдаёт секрет только вызовом функции', () => {
  const resolved = resolve.resolve('demo/db');
  assert.equal(resolved.kind, 'db');
  assert.equal(resolved.host.alias, 'demo/srv');
  assert.equal(resolved.port, 5432, 'порт по умолчанию для postgres');
  assert.equal(typeof resolved.secret, 'function');
  assert.equal(resolved.secret(), 'пароль-базы');
  assert.equal(JSON.stringify(resolved).includes('пароль-базы'), false);
});

test('неизвестный алиас объясняет, какие есть', () => {
  assert.throws(() => resolve.resolve('demo/нет-такого'), /не заведено.*demo\/db/s);
});

test('факт — одна короткая строка под ключом', () => {
  assert.throws(() => notes.setFact('demo', 'php version', '8.3'), /без пробелов/);
  assert.throws(() => notes.setFact('demo', 'deploy.steps', 'раз\nдва'), /одна строка/);
  assert.throws(() => notes.setFact('demo', 'deploy.steps', 'x'.repeat(cfg.notesValueMax + 1)), /длиннее/);
  assert.throws(() => notes.setFact('demo', 'deploy.steps', '   '), /должно быть значение/);
});

test('список отдаёт ключи без значений, чтение — значения по ключам', () => {
  notes.setFact('demo', 'php.version', '8.3', 's1');
  notes.setFact('demo', 'deploy.path', '/var/www/shop', 's1');

  const list = notes.listFacts('demo', 's1');
  assert.deepEqual(list.facts.map((f) => f.key).sort(), ['deploy.path', 'php.version']);
  assert.equal(JSON.stringify(list).includes('/var/www/shop'), false, 'значений в списке нет');
  assert.equal(list.facts.some((f) => f.stale), false, 'свежие факты без пометок');

  const read = notes.readFacts('demo', ['php.version', 'нет-такого'], 's1');
  assert.equal(read.facts['php.version'], '8.3');
  assert.deepEqual(read.missing, ['нет-такого']);

  notes.setFact('demo', 'php.version', '8.4', 's1');
  assert.equal(notes.readFacts('demo', ['php.version'], 's1').facts['php.version'], '8.4', 'факт заменяется, а не копится');
});

test('поиск фильтрует по ключу и значению и отдаёт только ключи', () => {
  const byKey = notes.searchNotes('php');
  assert.deepEqual(byKey.facts.map((f) => [f.project, f.key, f.matched]), [['demo', 'php.version', 'key']]);

  const byValue = notes.searchNotes('/var/www', { project: 'demo' });
  assert.deepEqual(byValue.facts.map((f) => f.key), ['deploy.path']);
  assert.equal(byValue.facts[0].matched, 'value');
  assert.equal(JSON.stringify(byValue).includes('/var/www/shop'), false);

  assert.deepEqual(notes.searchNotes('php', { project: 'other' }).facts, []);
  assert.throws(() => notes.searchNotes('  '), /пустой запрос/);
});

test('факт стареет по сессиям без чтения и потом удаляется через журнал', () => {
  const stale = cfg.notesStaleSessions;
  const expire = cfg.notesExpireSessions;
  notes.setFact('demo', 'queue.worker', 'php artisan queue:work --once', 'w');

  // php.version читают каждую сессию, queue.worker — ни разу
  for (let i = 0; i < stale - 2; i++) notes.readFacts('demo', ['php.version'], `сессия-${i}`);
  let list = notes.listFacts('demo', 'обзор-1');
  assert.equal(list.facts.find((f) => f.key === 'queue.worker').stale, undefined, 'до порога пометки нет');
  assert.equal(list.facts[0].key, 'php.version', 'недавно читанное сверху');

  notes.readFacts('demo', ['php.version'], 'обзор-1');
  list = notes.listFacts('demo', 'обзор-2');
  assert.equal(list.facts.find((f) => f.key === 'queue.worker').stale, true, 'порог достигнут — пометка stale');

  // чтение сбрасывает возраст
  notes.readFacts('demo', ['deploy.path'], 'обзор-2');
  list = notes.listFacts('demo', 'обзор-3');
  assert.equal(list.facts.find((f) => f.key === 'deploy.path').stale, undefined);

  for (let i = 0; i < expire; i++) notes.readFacts('demo', ['php.version'], `добор-${i}`);
  list = notes.listFacts('demo', 'финал');
  assert.equal(list.facts.some((f) => f.key === 'queue.worker'), false, 'просроченный факт удалён');
  assert.ok(list.facts.some((f) => f.key === 'deploy.path'), 'прочитанный недавно остался');

  const journal = fs.readdirSync(path.join(root, 'logs')).filter((n) => n.endsWith('.jsonl'))
    .flatMap((n) => fs.readFileSync(path.join(root, 'logs', n), 'utf8').trim().split('\n'))
    .map((line) => JSON.parse(line));
  const expired = journal.filter((r) => r.tool === 'notes_expire');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].alias, 'demo');
  assert.equal(expired[0].args.fact, 'queue.worker');
  assert.equal(expired[0].args.value, 'php artisan queue:work --once', 'значение сохранено в журнале');
});

test('проект не убирается, пока у него есть подключения', () => {
  assert.throws(() => projects.removeProject('demo'), /есть хосты и подключения/);
  projects.removeProject('other');
  assert.deepEqual(projects.projects(), ['demo']);
});

test('подключение убирается вместе со своим секретом', () => {
  const before = db().prepare('SELECT count(*) AS n FROM secrets').get().n;
  connections.removeConnection('demo/db');
  const after = db().prepare('SELECT count(*) AS n FROM secrets').get().n;
  assert.equal(after, before - 1);
});
