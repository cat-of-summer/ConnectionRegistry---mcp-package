import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Секрет на сервер едет ссылкой, а не значением: агент его не видит, в журнале — ссылка.
// Проверяется через ту же обёртку wrap, что оборачивает настоящие инструменты, с
// подменённым run: транспорт тут ни при чём, важно, что до него доходит и что ложится
// в журнал.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-secretref-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-для-ссылок';
process.env.CR_UPDATE_CHECK = '0';

const hosts = await import('../src/registry/hosts.js');
const connections = await import('../src/registry/connections.js');
const projects = await import('../src/registry/projects.js');
const { readSecretRef, projectSecretValues, isSecretRef } = await import('../src/registry/resolve.js');
const { wrap } = await import('../src/tools/shared.js');
const query = await import('../src/audit/query.js');
const { tools: registryTools } = await import('../src/tools/registry.js');

const KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

for (const project of ['shop', 'blog']) {
  projects.upsertProject({ project, dirs: [{ path: `/srv/${project}`, comment: 'код' }] });
  hosts.upsertHost({ alias: `${project}/srv`, address: '10.0.0.1', user: 'deploy', privateKey: KEY, auth: 'key' });
  connections.upsertConnection({ alias: `${project}/shell`, kind: 'shell', host: `${project}/srv`, config: { cwd: '/srv' } });
}
connections.upsertConnection({
  alias: 'shop/db',
  kind: 'db',
  host: 'shop/srv',
  password: 'db-пароль-магазина',
  config: { engine: 'postgres', database: 'shop', username: 'shop' },
});

// Человек, который на всё соглашается: здесь проверяется не политика, а то, что идёт после неё.
const ctx = {
  sessionId: 'test',
  requestId: 1,
  server: {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => ({ action: 'accept', content: { approve: true } }),
    },
  },
};

/** Инструмент-заглушка с той же декларацией, что у ssh_exec. */
function fakeExec(seen) {
  return wrap({
    name: 'ssh_exec',
    group: 'shell',
    needsConnection: true,
    kinds: ['shell'],
    mutating: false,
    scan: ['command', 'stdin'],
    secretRefs: ['stdin'],
    run: async (args) => {
      seen.push(args);
      return { data: { ok: true }, ok: true, command: args.command, stdout: `эхо: ${args.stdin ?? ''}`, stderr: '' };
    },
  }, ctx);
}

const last = () => query.list({ limit: 1 }).entries[0];

test('ссылка разворачивается в значение, а в журнал уходит ссылка', async () => {
  const seen = [];
  const res = await fakeExec(seen)({ alias: 'shop/shell', command: 'cat > key', stdin: 'cr://secret/shop/srv#private_key' });

  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  assert.equal(seen[0].stdin, KEY, 'run получил само значение');

  const record = query.get(last().id);
  assert.equal(record.args.stdin, 'cr://secret/shop/srv#private_key');
  assert.equal(JSON.stringify(record).includes('BEGIN OPENSSH'), false, 'ключ в журнале');
  assert.equal(record.stdout.includes('BEGIN OPENSSH'), false, 'ключ, отражённый в выводе, не вычищен');
});

test('секрет чужого проекта не подставляется', async () => {
  const seen = [];
  const res = await fakeExec(seen)({ alias: 'shop/shell', command: 'cat > key', stdin: 'cr://secret/blog/srv#private_key' });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /чужого проекта/);
  assert.equal(seen.length, 0, 'до run не дошло');
});

test('ссылка на то, чего нет, отказывает внятно', () => {
  assert.throws(() => readSecretRef('cr://secret/shop/srv', { project: 'shop' }), /без вида секрета/);
  assert.throws(() => readSecretRef('cr://secret/shop/srv#token', { project: 'shop' }), /не бывает/);
  assert.throws(() => readSecretRef('cr://secret/shop/srv#passphrase', { project: 'shop' }), /не заведён секрет.*secret_set/);
  assert.throws(() => readSecretRef('cr://secret/shop/srv#password', { project: 'shop' }), /лежит «private_key»/);
  assert.throws(() => readSecretRef('cr://secret/shop/db#private_key', { project: 'shop' }), /только пароль/);
  assert.throws(() => readSecretRef('cr://secret/shop/nope#password', { project: 'shop' }), /нет такого/);

  assert.equal(readSecretRef('cr://secret/shop/db#password', { project: 'shop' }), 'db-пароль-магазина');
  assert.equal(isSecretRef('cr://uploads/x'), false);
});

test('ключ открытым текстом отклоняется до выполнения и с подсказкой', async () => {
  const seen = [];
  const res = await fakeExec(seen)({ alias: 'shop/shell', command: `echo '${KEY}' > key` });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /«command».*private_key openssh/);
  assert.match(res.content[0].text, /secret_set/);
  assert.match(res.content[0].text, /cr:\/\/secret\/shop\/srv#/);
  assert.equal(seen.length, 0);

  const record = query.get(last().id);
  assert.equal(record.ok, false);
  assert.equal(JSON.stringify(record).includes('BEGIN OPENSSH'), false, 'ключ в записи об отказе');
});

test('эвристика не блокирует: PGPASSWORD маскируется, команда выполняется', async () => {
  const seen = [];
  const res = await fakeExec(seen)({ alias: 'shop/shell', command: 'PGPASSWORD=hunter2 psql -c "select 1"' });

  assert.equal(res.isError, undefined);
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(query.get(last().id)).includes('hunter2'), false);
});

test('вывод чистится от всех секретов проекта, не только от кредов подключения', async () => {
  assert.deepEqual(projectSecretValues(['shop']).sort(), [KEY, 'db-пароль-магазина'].sort());

  const seen = [];
  // Без «PASSWORD=» рядом: эвристика тут не поможет, вычистить может только знание значения.
  await fakeExec(seen)({ alias: 'shop/shell', command: 'cat .env', stdin: 'в дампе: db-пароль-магазина' });

  const record = query.get(last().id);
  assert.equal(record.stdout.includes('db-пароль-магазина'), false, 'пароль базы того же проекта в stdout');
});

test('secret_set не принимает ссылку: перекладывать секрет незачем', async () => {
  const secretSet = wrap(registryTools.find((t) => t.name === 'secret_set'), ctx);
  const res = await secretSet({ target: 'host', alias: 'shop/srv', kind: 'password', value: 'cr://secret/blog/srv#private_key' });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /само значение/);
});

test('secret_set: значение в журнале — примета, а не ключ', async () => {
  const secretSet = wrap(registryTools.find((t) => t.name === 'secret_set'), ctx);
  const res = await secretSet({ target: 'host', alias: 'blog/srv', kind: 'private_key', value: KEY });

  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  const record = query.get(last().id);
  assert.match(record.args.value, /^••••\[private_key openssh, \d+ Б, sha256:[0-9a-f]{8}\]$/);
});
