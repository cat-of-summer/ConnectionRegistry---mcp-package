import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Журнал для разбора: форма вызова и трение вокруг него — без содержимого. Проверяется через
// ту же обёртку wrap, что у настоящих инструментов, с подменённым run.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-insights-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-для-разбора';
process.env.CR_UPDATE_CHECK = '0';
process.env.CR_INSIGHTS = '1';
process.env.CR_MAX_TEXT_BYTES = '2000';

const hosts = await import('../src/registry/hosts.js');
const connections = await import('../src/registry/connections.js');
const projects = await import('../src/registry/projects.js');
const { wrap } = await import('../src/tools/shared.js');
const insights = await import('../src/audit/insights.js');
const { DIRS } = await import('../src/paths.js');

projects.upsertProject({ project: 'shop', dirs: [{ path: '/srv/shop', comment: 'код' }] });
hosts.upsertHost({ alias: 'shop/srv', address: '10.0.0.1', user: 'deploy', password: 'пароль-хоста-магазина' });
connections.upsertConnection({ alias: 'shop/shell', kind: 'shell', host: 'shop/srv' });
connections.upsertConnection({
  alias: 'shop/db', kind: 'db', host: 'shop/srv', password: 'пароль-базы-магазина',
  config: { engine: 'mysql', database: 'shop', username: 'shop' },
});

const ctx = {
  sessionId: 'сессия-разбора',
  requestId: 1,
  server: {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      getClientVersion: () => ({ name: 'claude-code', version: '9.9' }),
      elicitInput: async () => ({ action: 'accept', content: { approve: true } }),
    },
  },
};

let failNext = true;
const exec = wrap({
  name: 'ssh_exec',
  group: 'shell',
  needsConnection: true,
  kinds: ['shell'],
  mutating: true,
  summary: (args) => args.command,
  run: async (args) => {
    if (args.command === 'flaky' && failNext) { failNext = false; throw new Error('connect ETIMEDOUT 10.0.0.1:22'); }
    if (args.command === 'cat .env') return { data: { stdout: 'DB_PASSWORD=пароль-базы-магазина' }, command: args.command };
    if (args.command === 'big') return { data: { stdout: 'x'.repeat(5000), truncated: true }, command: args.command };
    return { data: { stdout: 'вывод-команды-разбора' }, command: args.command };
  },
}, ctx);

const read = () => fs.readdirSync(path.join(DIRS.logs, 'insights'))
  .flatMap((name) => fs.readFileSync(path.join(DIRS.logs, 'insights', name), 'utf8').trim().split('\n'))
  .map((line) => JSON.parse(line));

test('вызов пишется формой: поля и размеры, без значений и без вывода', async () => {
  await exec({ alias: 'shop/shell', command: 'ls -la', stdin: 'секретный-ввод-агента' });
  const events = read();

  const session = events.find((e) => e.type === 'session');
  assert.deepEqual(session.client, { name: 'claude-code', version: '9.9' });
  assert.equal(session.elicitation, true);

  const call = events.find((e) => e.type === 'call' && e.command === 'ls -la');
  assert.equal(call.tool, 'ssh_exec');
  assert.equal(call.host, 'shop/srv');
  assert.deepEqual(call.args, { command: '6 Б', stdin: `${Buffer.byteLength('секретный-ввод-агента')} Б` });
  assert.equal(call.approval.asked, 2, 'первая запись в сессии: вопрос про сессию и про проект');
  assert.equal(JSON.stringify(events).includes('секретный-ввод-агента'), false, 'значение аргумента в журнале');
  assert.equal(JSON.stringify(events).includes('вывод-команды-разбора'), false, 'вывод команды в журнале');
});

test('повтор после сбоя, обход после отказа, дочитанный секрет и потолок ответа', async () => {
  await exec({ alias: 'shop/shell', command: 'flaky' });
  await exec({ alias: 'shop/shell', command: 'flaky' });
  await exec({ alias: 'shop/shell', command: 'cat .env' });
  await exec({ alias: 'shop/shell', command: 'big' });

  const calls = read().filter((e) => e.type === 'call');
  const [failed, retried] = calls.filter((e) => e.command === 'flaky');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.class, 'timeout');
  assert.equal(retried.retry, true);
  assert.equal(retried.afterFailure.class, 'timeout');

  const env = calls.find((e) => e.command === 'cat .env');
  assert.equal(env.secretHits, 1, 'агент дочитался до пароля базы руками');
  assert.equal(JSON.stringify(calls).includes('пароль-базы-магазина'), false);

  const big = calls.find((e) => e.command === 'big');
  assert.equal(big.limits.response, true);
  assert.equal(big.limits.output, true);
  assert.equal(big.approval.asked, 0, 'внутри разрешённого проекта вопросов нет');
});

test('секрет в команде — в журнале маска, а не значение', async () => {
  await exec({ alias: 'shop/shell', command: 'mysql -u shop -pпароль-базы-магазина -e "select 1"' });
  const call = read().filter((e) => e.type === 'call').at(-1);
  assert.equal(call.command.includes('пароль-базы-магазина'), false);
  assert.match(call.command, /••••/);
});

test('сводка собирает то, с чего начинать разбор', () => {
  const report = insights.summary({ days: 1 });
  assert.equal(report.calls, 6);
  assert.deepEqual(report.sessions, [{ key: 'claude-code 9.9', count: 1 }]);
  assert.deepEqual(report.errors, [{ key: 'ssh_exec: timeout', count: 1 }]);
  assert.deepEqual(report.retries, [{ key: 'ssh_exec: timeout', count: 1 }]);
  assert.deepEqual(report.secretReads, [{ key: 'ssh_exec @ shop/srv', count: 1 }]);
  assert.ok(report.limits.some((l) => l.key === 'ssh_exec: response'));
  assert.equal(report.questions.asked, 2, 'сессия и проект — по разу');
});

test('класс ошибки: код реестра важнее текста', () => {
  const err = new Error('что угодно');
  err.code = 'host_key';
  assert.equal(insights.errorClass(err), 'host_key');
  assert.equal(insights.errorClass(new Error('хост не открыл канал до 127.0.0.1:3306')), 'tunnel_closed');
  assert.equal(insights.errorClass(new Error('ERROR 1064 (42000): You have an error in your SQL syntax')), 'sql');
});
