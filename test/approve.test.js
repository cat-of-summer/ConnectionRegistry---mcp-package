import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Спецификация базовой политики. Лояльная — в approve.loyal.test.js: политика выбирается
// один раз при загрузке модулей, поэтому каждая живёт в своём файле и своём процессе.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-approve-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-подтверждений';
process.env.CR_APPROVE_TIMEOUT = '1';
process.env.CR_POLICY = 'base';

const gate = await import('../src/approve/gate.js');
const grants = await import('../src/approve/grants.js');
const queue = await import('../src/approve/queue.js');
const { ALL } = await import('../src/tools/groups.js');

/** Клиент, который на всё отвечает одинаково, и счётчик заданных вопросов. */
function human(answer, sessionId = 'session-1') {
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

const write = (over = {}) => ({ tool: 'ssh_exec', alias: 'shop/prod', project: 'shop', mutating: true, summary: 'echo 1', ...over });

test('чтение не спрашивают никогда', async () => {
  const { ctx, asked } = human('decline');
  const res = await gate.authorize(ctx, { tool: 'files_list', alias: 'shop/files', project: 'shop', mutating: false, summary: 'ls' });
  assert.equal(res.required, false);
  assert.equal(asked.length, 0);
});

test('первая запись спрашивает дважды: про сессию и про проект', async () => {
  const { ctx, asked } = human('accept', 'A');
  await gate.authorize(ctx, write());

  assert.equal(asked.length, 2, asked.join(' | '));
  assert.match(asked[0], /этой сессии/);
  assert.match(asked[1], /проект «shop»/);
});

test('дальше внутри проекта не спрашивают вовсе', async () => {
  const { ctx, asked } = human('accept', 'A');
  await gate.authorize(ctx, write({ tool: 'files_put', alias: 'shop/files', summary: 'put x' }));
  await gate.authorize(ctx, write({ tool: 'notes_set', alias: null, summary: 'note' }));

  assert.equal(asked.length, 0, 'разрешение выдано в прошлом тесте на ту же сессию');
});

test('другой проект спрашивает только про себя', async () => {
  const { ctx, asked } = human('accept', 'A');
  await gate.authorize(ctx, write({ alias: 'blog/prod', project: 'blog' }));

  assert.equal(asked.length, 1);
  assert.match(asked[0], /проект «blog»/);
});

test('отказ по проекту оставляет его только на чтение и больше не спрашивает', async () => {
  const { ctx: yes } = human('accept', 'B');
  const { ctx: no, asked: askedNo } = human('decline', 'B');

  // Сессии разрешение уже выдано другим вопросом, чтобы проверить именно проект.
  grants.set('B', 'session', true);

  await assert.rejects(gate.authorize(no, write({ project: 'shop', alias: 'shop/prod' })), /только на чтение/);
  assert.equal(askedNo.length, 1);
  assert.equal(grants.get('B', 'project:shop'), 'denied');

  // Второй раз вопроса нет — сразу отказ, даже клиенту, который согласился бы.
  const before = queue.recent(1)[0];
  await assert.rejects(gate.authorize(yes, write({ project: 'shop', alias: 'shop/prod' })), /только на чтение/);
  assert.equal(queue.recent(1)[0].id, before.id, 'новых заявок не появилось');

  // Чтение того же проекта по-прежнему свободно.
  const read = await gate.authorize(yes, { tool: 'files_list', project: 'shop', mutating: false, summary: 'ls' });
  assert.equal(read.required, false);
});

test('отказ по сессии запрещает запись во все проекты', async () => {
  const { ctx, asked } = human('decline', 'C');
  await assert.rejects(gate.authorize(ctx, write({ project: 'shop' })), /запись в этой сессии запрещена/);
  assert.equal(asked.length, 1, 'про проект уже не спрашивали');

  await assert.rejects(gate.authorize(ctx, write({ project: 'blog', alias: 'blog/prod' })), /запись в этой сессии запрещена/);
  assert.equal(asked.length, 1, 'и второй раз тоже не спрашивали');
});

test('сессии не наследуют разрешения друг друга', async () => {
  const { ctx, asked } = human('accept', 'D');
  await gate.authorize(ctx, write());
  assert.equal(asked.length, 2, 'новая сессия спрашивает заново');
});

test('доступы спрашиваются каждый раз, даже когда всё разрешено', async () => {
  const { ctx, asked } = human('accept', 'A');
  await gate.authorize(ctx, { tool: 'host_set', alias: 'demo', project: null, mutating: true, everyTime: true, summary: 'завести хост' });
  await gate.authorize(ctx, { tool: 'conn_set', alias: 'shop/x', project: 'shop', mutating: true, everyTime: true, summary: 'завести подключение' });

  assert.equal(asked.length, 2, 'оба вопроса заданы, хотя сессия и проект shop уже разрешены');
});

test('инструменты объявляют, что спрашивается каждый раз', () => {
  for (const name of ['host_set', 'host_remove', 'secret_set', 'conn_set', 'conn_remove']) {
    assert.equal(ALL.find((t) => t.name === name)?.everyTime, true, `${name} — доступ, спрашивается каждый раз`);
  }
  for (const name of ['notes_set', 'notes_remove', 'ssh_exec', 'files_put', 'docker_restart']) {
    assert.notEqual(ALL.find((t) => t.name === name)?.everyTime, true, `${name} — работа внутри проекта`);
  }
  for (const name of ['conn_list', 'conn_info', 'host_list', 'notes_get', 'audit_query', 'help', 'registry_info']) {
    assert.equal(ALL.find((t) => t.name === name)?.mutating, false, `${name} — чтение`);
  }
});

test('без ответа человека вызов отказывает по таймауту', async () => {
  const ctx = { sessionId: 'E', server: { server: { getClientCapabilities: () => ({}) } } };
  await assert.rejects(gate.authorize(ctx, write({ project: 'timeout' })), (err) => {
    assert.equal(err.name, 'Declined');
    assert.equal(err.decision.status, 'timeout');
    return true;
  });
  assert.equal(queue.recent(1)[0].status, 'timeout');
});

test('решение человека на странице будит ждущий вызов', async () => {
  const ctx = { sessionId: 'F', server: { server: { getClientCapabilities: () => ({}) } } };
  const pending = gate.authorize(ctx, write({ project: 'web' }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const waiting = queue.pending();
  assert.equal(waiting.length, 1);
  assert.match(waiting[0].summary, /этой сессии/);

  queue.decide(waiting[0].id, 'approved', 'web');
  await new Promise((resolve) => setTimeout(resolve, 20));
  queue.decide(queue.pending()[0].id, 'approved', 'web');

  const decision = await pending;
  assert.equal(decision.status, 'approved');
  assert.equal(decision.scope, 'project');
});

test('вопрос привязан к вызову: иначе клиент его не получит', async () => {
  const seen = [];
  const ctx = {
    sessionId: 'G',
    requestId: 42,
    server: {
      server: {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: async (_request, options) => {
          seen.push(options?.relatedRequestId);
          return { action: 'accept', content: { approve: true } };
        },
      },
    },
  };

  await gate.authorize(ctx, write({ project: 'related' }));
  assert.deepEqual(seen, [42, 42], 'оба вопроса ушли в поток ответа на вызов инструмента');
});
