import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Спецификация лояльной политики. Базовая — в approve.test.js: политика выбирается один раз
// при загрузке модулей, поэтому каждая живёт в своём файле и своём процессе.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-approve-loyal-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-лояльной-политики';
process.env.CR_APPROVE_TIMEOUT = '1';
process.env.CR_POLICY = 'loyal';

const gate = await import('../src/approve/gate.js');
const grants = await import('../src/approve/grants.js');
const hosts = await import('../src/registry/hosts.js');
const connections = await import('../src/registry/connections.js');

// Реестр, на который опирается политика: проект считается заведённым, если у него есть
// подключение или заметка. Без этого любой проект выглядел бы новым и доступ выдавался сам.
for (const project of ['shop', 'blog']) {
  hosts.upsertHost({ alias: `${project}/srv`, address: '10.0.0.1', user: 'deploy', password: 'пароль' });
  connections.upsertConnection({ alias: `${project}/prod`, kind: 'shell', host: `${project}/srv`, config: { cwd: '/srv' } });
  connections.upsertConnection({
    alias: `${project}/files`,
    kind: 'files',
    host: `${project}/srv`,
    config: { proto: 'sftp', root: '/srv' },
  });
}

/** Клиент, который на всё отвечает одинаково, и счётчик заданных вопросов. */
function human(answer, sessionId) {
  const asked = [];
  return {
    asked,
    ctx: {
      sessionId,
      requestId: 1,
      server: {
        server: {
          getClientCapabilities: () => ({ elicitation: {} }),
          elicitInput: async (request) => {
            asked.push(request.message.split('\n')[0]);
            return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
          },
        },
      },
    },
  };
}

const read = (over = {}) => ({
  tool: 'files_list', group: 'files', alias: 'shop/files', project: 'shop',
  host: 'shop/srv', mutating: false, summary: 'ls', ...over,
});

const exec = (over = {}) => ({
  tool: 'ssh_exec', group: 'shell', alias: 'shop/prod', project: 'shop',
  host: 'shop/srv', mutating: true, summary: 'echo 1', ...over,
});

test('чтение через подключение проекта спрашивает доступ — один раз', async () => {
  const { ctx, asked } = human('accept', 'A');

  const first = await gate.authorize(ctx, read());
  assert.equal(first.status, 'approved');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /доступ к проекту «shop»/);

  await gate.authorize(ctx, read({ tool: 'files_read', summary: 'cat' }));
  assert.equal(asked.length, 1, 'второй раз о том же проекте не спрашивают');
});

test('работа с реестром внутри проекта входит в доступ к нему', async () => {
  const { ctx, asked } = human('accept', 'A');

  await gate.authorize(ctx, {
    tool: 'notes_set', group: 'notes', alias: null, project: 'shop', host: null,
    mutating: true, summary: 'записать факт',
  });
  await gate.authorize(ctx, {
    tool: 'secret_set', group: 'registry', alias: 'shop/prod', project: 'shop', host: 'shop/prod',
    mutating: true, everyTime: true, summary: 'положить пароль',
  });

  assert.equal(asked.length, 0, 'доступ к проекту выдан в прошлом тесте на ту же сессию');
});

test('первая запись на сервер спрашивает хост и покрывает все его подключения', async () => {
  const { ctx, asked } = human('accept', 'A');

  await gate.authorize(ctx, exec());
  assert.equal(asked.length, 1);
  assert.match(asked[0], /запись на хост «shop\/srv»/);

  await gate.authorize(ctx, exec({ tool: 'files_put', group: 'files', alias: 'shop/files', summary: 'put x' }));
  await gate.authorize(ctx, exec({ tool: 'db_query', group: 'db', alias: 'shop/db', summary: 'update' }));
  assert.equal(asked.length, 1, 'одно разрешение на весь сервер: shell, файлы, база');
});

test('другой сервер спрашивает заново — и свой проект, и свою запись', async () => {
  const { ctx, asked } = human('accept', 'A');

  await gate.authorize(ctx, exec({ alias: 'blog/prod', project: 'blog', host: 'blog/srv' }));

  assert.equal(asked.length, 2);
  assert.match(asked[0], /проекту «blog»/);
  assert.match(asked[1], /хост «blog\/srv»/);
});

test('порядок вопросов: сначала проект, потом запись на сервер', async () => {
  const { ctx, asked } = human('accept', 'B');

  await gate.authorize(ctx, exec());

  assert.equal(asked.length, 2);
  assert.match(asked[0], /доступ к проекту/);
  assert.match(asked[1], /запись на хост/);
});

test('отказ по проекту закрывает и чтение, и спрашивать перестаёт', async () => {
  const { ctx: no, asked: askedNo } = human('decline', 'C');
  const { ctx: yes } = human('accept', 'C');

  await assert.rejects(gate.authorize(no, read()), /проект «shop» закрыт/);
  assert.equal(askedNo.length, 1);
  assert.equal(grants.get('C', 'project:shop'), 'denied');

  await assert.rejects(gate.authorize(yes, read()), /проект «shop» закрыт/);
  await assert.rejects(gate.authorize(yes, exec()), /проект «shop» закрыт/);
});

test('отказ по хосту оставляет чтение живым', async () => {
  const { ctx: yes, asked: askedYes } = human('accept', 'D');
  const { ctx: no } = human('decline', 'D');

  grants.set('D', 'project:shop', true);

  await assert.rejects(gate.authorize(no, exec()), /хост «shop\/srv».*только на чтение/);
  assert.equal(grants.get('D', 'host:shop/srv'), 'denied');

  const allowed = await gate.authorize(yes, read());
  assert.equal(allowed.status, 'approved');
  assert.equal(askedYes.length, 0, 'чтение проекта уже разрешено, про хост его не спрашивают');
});

test('проект, которого ещё нет, агент заводит сам и получает доступ без вопроса', async () => {
  const { ctx, asked } = human('decline', 'E');

  const decision = await gate.authorize(ctx, {
    tool: 'conn_set', group: 'registry', alias: 'новый/prod', project: 'новый', host: 'новый/prod',
    mutating: true, everyTime: true, summary: 'завести подключение',
  });

  assert.equal(decision.status, 'approved');
  assert.equal(asked.length, 0, 'клиент, который отказал бы, даже не спрошен');
  assert.equal(grants.get('E', 'project:новый'), 'granted');
});

test('обзорные инструменты не спрашивают ничего даже с фильтром по проекту', async () => {
  const { ctx, asked } = human('decline', 'F');

  for (const call of [
    { tool: 'conn_list', group: 'registry', project: 'shop', mutating: false, summary: 'список' },
    { tool: 'host_list', group: 'registry', project: 'shop', mutating: false, summary: 'серверы' },
    { tool: 'notes_search', group: 'notes', project: 'shop', mutating: false, summary: 'поиск' },
    { tool: 'audit_query', group: 'audit', project: 'shop', alias: 'shop/prod', mutating: false, summary: 'журнал' },
    { tool: 'registry_info', group: 'service', mutating: false, summary: 'состояние' },
  ]) {
    assert.equal((await gate.authorize(ctx, call)).required, false, call.tool);
  }

  assert.equal(asked.length, 0);
});

test('правка хоста спрашивает доступ у каждого задетого проекта', async () => {
  connections.upsertConnection({ alias: 'blog/shared', kind: 'shell', host: 'shop/srv', config: { cwd: '/srv' } });

  const { ctx, asked } = human('accept', 'G');
  await gate.authorize(ctx, {
    tool: 'host_set', group: 'registry', alias: 'shop/srv', project: 'shop',
    projects: hosts.hostProjects('shop/srv'), host: 'shop/srv',
    mutating: true, everyTime: true, summary: 'сменить пароль хоста',
  });

  assert.equal(asked.length, 2, asked.join(' | '));
  assert.match(asked[0], /проекту «shop»/);
  assert.match(asked[1], /проекту «blog»/);

  connections.removeConnection('blog/shared');
});

test('снимок разрешений различает доступ к проекту и запись на хост', () => {
  const shot = grants.snapshot('A');
  assert.equal(shot.проекты.shop, 'доступ есть');
  assert.equal(shot.хосты['shop/srv'], 'запись разрешена');
});
