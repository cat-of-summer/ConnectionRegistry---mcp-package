import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Сквозной прогон против живых мишеней из docker-compose.test.yml: сервер с SSH и
// две базы за ним, в сеть реестра не выставленные. Включается CR_E2E=1, потому что
// без поднятых мишеней он не значит ничего.
//
//   docker compose -f docker-compose.test.yml up -d
//   docker compose exec node env CR_E2E=1 npm test

const enabled = process.env.CR_E2E === '1';
const BASE = process.env.CR_E2E_URL || `http://127.0.0.1:${process.env.MCP_PORT || 8932}`;
const HOST_PASSWORD = 'tester-пароль-стенда';
const DB_PASSWORD = 'shop-пароль-стенда';

/**
 * @param t      контекст теста: клиент закрывается в t.after, даже если тест упал
 * @param answer 'accept' | 'decline' | null — null означает клиента, который
 *               спрашивать не умеет: тогда заявка уходит в веб-очередь.
 */
async function connect(t, answer = 'accept') {
  const capabilities = answer === null ? {} : { elicitation: {} };
  const client = new Client({ name: 'e2e', version: '0' }, { capabilities });

  const asked = [];
  if (answer !== null) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return answer === 'accept'
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' };
    });
  }

  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  t.after(() => client.close().catch(() => {}));
  return { client, asked };
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((part) => part.text).join('\n');
  return { isError: Boolean(res.isError), text, json: parse(text) };
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

test('реестр отдаёт алиасы и ни одного секрета', { skip: !enabled }, async (t) => {
  const { client } = await connect(t);
  const res = await call(client, 'conn_list');

  const aliases = res.json.connections.map((c) => c.alias);
  assert.deepEqual(aliases.sort(), ['demo/db', 'demo/docker', 'demo/files', 'demo/mysql', 'demo/shell']);
  assert.equal(res.text.includes(HOST_PASSWORD), false, 'пароль хоста не утёк в список');
  assert.equal(res.text.includes(DB_PASSWORD), false, 'пароль базы не утёк в список');

  const info = await call(client, 'conn_info', { alias: 'demo/db' });
  assert.equal(info.text.includes(DB_PASSWORD), false);
  assert.equal(info.json.hasSecret, true, 'факт наличия секрета виден, сам секрет — нет');
});

test('команда выполняется после согласия человека', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'accept');
  const res = await call(client, 'ssh_exec', { alias: 'demo/shell', command: 'id -un && pwd' });

  assert.equal(res.isError, false, res.text);
  assert.equal(res.json.exitCode, 0);
  assert.match(res.json.stdout, /tester/);
  // Первая запись в свежей сессии: вопрос про сессию и вопрос про проект, оба с командой в тексте.
  assert.equal(asked.length, 2, asked.join(' | '));
  assert.match(asked[0], /этой сессии/);
  assert.match(asked[0], /id -un/, 'человеку показали само действие');
  assert.match(asked[1], /проект «demo»/);

  const again = await call(client, 'ssh_exec', { alias: 'demo/shell', command: 'echo second' });
  assert.equal(again.isError, false, again.text);
  assert.equal(asked.length, 2, 'внутри разрешённого проекта вопросов больше нет');
});

test('отказ человека — это отказ, а не выполнение', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'decline');
  const res = await call(client, 'ssh_exec', { alias: 'demo/shell', command: 'touch /config/не-должно-появиться' });

  assert.equal(res.isError, true);
  assert.match(res.text, /запись в этой сессии запрещена/);

  const { client: second } = await connect(t, 'accept');
  const check = await call(second, 'files_list', { alias: 'demo/files', path: '.' });
  const names = check.json.entries.map((e) => e.name);
  assert.equal(names.includes('не-должно-появиться'), false, 'отказанная команда не выполнилась');

});

test('клиент без elicitation ждёт решения на странице подтверждений', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, null);

  // Заявки прошлых прогонов, ещё не дождавшиеся ответа, не должны путаться под ногами.
  const before = new Set((await (await fetch(`${BASE}/api/approvals`)).json()).pending.map((item) => item.id));

  const pending = call(client, 'ssh_exec', { alias: 'demo/shell', command: 'echo из-очереди' });

  // В свежей сессии их две: про саму сессию и про проект. Отвечаем, как человек на странице.
  const seen = [];
  for (let i = 0; i < 60 && seen.length < 2; i++) {
    const list = (await (await fetch(`${BASE}/api/approvals`)).json()).pending
      .filter((item) => !before.has(item.id) && !seen.some((s) => s.id === item.id));

    for (const item of list) {
      seen.push(item);
      await fetch(`${BASE}/api/approvals/${item.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });
    }
    if (seen.length < 2) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(seen.length, 2, seen.map((s) => s.summary).join(' | '));
  assert.match(seen[0].summary, /этой сессии/);
  assert.match(seen[1].summary, /проект «demo»/);

  const res = await pending;
  assert.equal(res.isError, false, res.text);
  assert.match(res.json.stdout, /из-очереди/);
});

test('чтение базы идёт сразу, запись — после согласия, и всё через туннель', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'accept');

  const read = await call(client, 'db_query', { alias: 'demo/db', sql: 'select 1 as one' });
  assert.equal(read.isError, false, read.text);
  assert.deepEqual(read.json.rows, [[1]]);
  assert.match(read.json.via, /demo\/srv → postgres_test:5432/, 'дошли через SSH-туннель');
  assert.equal(asked.length, 0, 'SELECT человека не беспокоит');

  const drop = await call(client, 'db_query', { alias: 'demo/db', sql: 'drop table if exists e2e' });
  assert.equal(drop.isError, false, drop.text);
  assert.equal(asked.length, 2, 'на DROP спросили про сессию и про проект');

  const create = await call(client, 'db_query', { alias: 'demo/db', sql: 'create table e2e (id int)' });
  assert.equal(create.isError, false, create.text);

  await call(client, 'db_query', { alias: 'demo/db', sql: 'insert into e2e values (42)' });
  const back = await call(client, 'db_query', { alias: 'demo/db', sql: 'select id from e2e' });
  assert.deepEqual(back.json.rows, [[42]]);

});

test('несколько запросов в одном вызове отклоняются', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');
  const res = await call(client, 'db_query', { alias: 'demo/db', sql: 'select 1; drop table e2e' });

  assert.equal(res.isError, true);
  assert.match(res.text, /Выполняйте по одному/);
});

test('mysql работает тем же путём', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');
  const res = await call(client, 'db_query', { alias: 'demo/mysql', sql: 'select 7 as seven' });

  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.json.rows, [[7]]);
  assert.match(res.json.via, /demo\/srv → mysql_test:3306/);
});

test('файл кладётся и читается обратно', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');
  const body = 'строка из сквозного прогона\n';

  const put = await call(client, 'files_put', { alias: 'demo/files', dest: 'e2e.txt', content: body });
  assert.equal(put.isError, false, put.text);

  const read = await call(client, 'files_read', { alias: 'demo/files', path: 'e2e.txt' });
  assert.equal(read.json.content, body);

  const list = await call(client, 'files_list', { alias: 'demo/files', path: '.' });
  assert.ok(list.json.entries.some((entry) => entry.name === 'e2e.txt'));

  await call(client, 'files_remove', { alias: 'demo/files', path: 'e2e.txt' });
});

test('файл, загруженный на /upload, доезжает до сервера', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');

  const form = new FormData();
  form.append('file', new Blob(['содержимое загруженного файла']), 'uploaded.txt');
  const uploaded = await (await fetch(`${BASE}/upload`, { method: 'POST', body: form })).json();
  assert.ok(uploaded.uploaded[0].uri.startsWith('cr://uploads/'), JSON.stringify(uploaded));

  const put = await call(client, 'files_put', {
    alias: 'demo/files',
    dest: 'uploaded.txt',
    source: uploaded.uploaded[0].uri,
  });
  assert.equal(put.isError, false, put.text);

  const read = await call(client, 'files_read', { alias: 'demo/files', path: 'uploaded.txt' });
  assert.equal(read.json.content, 'содержимое загруженного файла');

  await call(client, 'files_remove', { alias: 'demo/files', path: 'uploaded.txt' });
});

test('источник за пределами каталогов обмена не принимается', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');
  const res = await call(client, 'files_put', { alias: 'demo/files', dest: 'passwd', source: '/etc/passwd' });

  assert.equal(res.isError, true);
  assert.match(res.text, /вне каталогов обмена/);
});

test('журнал знает всё, что было, и ни одного пароля', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');

  const tail = await call(client, 'audit_query', { alias: 'demo/shell', tool: 'ssh_exec', limit: 10 });
  assert.ok(tail.json.entries.length > 0);

  const entry = tail.json.entries.find((item) => (item.command || '').includes('id -un'));
  assert.ok(entry, 'команда нашлась в журнале');
  assert.equal(entry.approval.required, true);
  assert.equal(entry.approval.status, 'approved');

  const full = await call(client, 'audit_show', { id: entry.id });
  assert.match(full.json.stdout, /tester/, 'вывод сохранён целиком');
  assert.equal(full.text.includes(HOST_PASSWORD), false, 'пароль хоста не попал в журнал');

  const everything = await call(client, 'audit_query', { limit: 200 });
  assert.equal(everything.text.includes(DB_PASSWORD), false, 'пароль базы не попал в журнал');

});

test('первый ключ хоста закреплён, подменённый — отказ', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');

  const before = await call(client, 'host_list');
  const host = before.json.hosts.find((item) => item.alias === 'demo/srv');
  assert.equal(host.hostKeyStatus, 'pinned', 'после первого подключения ключ закреплён');
  assert.match(host.hostKey, /^SHA256:/);

  // Подменяем отпечаток руками — так выглядит смена ключа на той стороне.
  // Настоящий возвращаем в finally: иначе упавший прогон оставит хост сломанным.
  try {
    await call(client, 'host_set', { alias: 'demo/srv', hostKey: 'SHA256:чужой-отпечаток-которого-не-бывает' });
    const refused = await call(client, 'conn_check', { alias: 'demo/shell' });
    assert.equal(refused.isError, true, 'живое соединение из пула не должно обходить проверку');
    assert.match(refused.text, /не совпал с закреплённым/);
  } finally {
    await call(client, 'host_set', { alias: 'demo/srv', hostKey: host.hostKey });
  }

  const ok = await call(client, 'conn_check', { alias: 'demo/shell' });
  assert.equal(ok.isError, false, ok.text);

});

test('заметки пишутся с подтверждением и читаются без него', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'accept');

  await call(client, 'notes_set', { project: 'demo', key: 'php.version', value: '8.3' });
  assert.equal(asked.length, 2, 'первая запись в сессии: про сессию и про проект');

  const read = await call(client, 'notes_get', { project: 'demo' });
  assert.equal(read.json.facts['php.version'], '8.3');
  assert.equal(asked.length, 2, 'на чтение — нет');

  await call(client, 'notes_set', { project: 'demo', key: 'php.version', value: '8.4' });
  assert.equal(asked.length, 2, 'вторая запись в том же проекте проходит молча');
  const updated = await call(client, 'notes_get', { project: 'demo' });
  assert.equal(updated.json.facts['php.version'], '8.4', 'факт заменяется, а не дублируется');

});

test('запертый реестр не мешает читать метаданные', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'accept');
  const info = await call(client, 'registry_info');

  assert.equal(info.json['мастерКлюч'], 'есть');
  assert.ok(info.json['реестр']['подключений'] >= 5);
});

test('у проекта несколько SSH-подключений: prod по паролю, dev по ключу', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'accept');
  const { utils } = (await import('ssh2')).default;

  // Ключ рождается в тесте и на диск не ложится: сначала он попадает в реестр
  // через secret_set, потом публичная часть — на сервер через сам реестр.
  const pair = await new Promise((resolve, reject) => {
    utils.generateKeyPair('ed25519', (err, keys) => (err ? reject(err) : resolve(keys)));
  });

  // Уборка своей сессией: хуки after идут по порядку, и клиент теста к этому моменту закрыт.
  t.after(async () => {
    const janitor = new Client({ name: 'janitor', version: '0' }, { capabilities: { elicitation: {} } });
    janitor.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { approve: true } }));
    await janitor.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    for (const alias of ['shop/prod', 'shop/dev', 'shop/prod-files']) await call(janitor, 'conn_remove', { alias });
    for (const alias of ['shop/srv-prod', 'shop/srv-dev']) await call(janitor, 'host_remove', { alias });
    await janitor.close();
  });

  // Агент заводит хосты и подключения сам — каждый шаг с подтверждением.
  const prodHost = await call(client, 'host_set', {
    alias: 'shop/srv-prod', address: 'sshd_test', port: 2222, user: 'tester', password: HOST_PASSWORD,
  });
  assert.equal(prodHost.isError, false, prodHost.text);
  assert.equal(prodHost.text.includes(HOST_PASSWORD), false, 'пароль не вернулся в ответе');

  const devHost = await call(client, 'host_set', {
    alias: 'shop/srv-dev', address: 'sshd_dev', port: 2222, user: 'deploy', password: 'dev-stand-password',
  });
  assert.equal(devHost.isError, false, devHost.text);

  for (const [alias, host] of [['shop/prod', 'shop/srv-prod'], ['shop/dev', 'shop/srv-dev']]) {
    const res = await call(client, 'conn_set', { alias, kind: 'shell', host, config: { cwd: '/config' } });
    assert.equal(res.isError, false, res.text);
  }
  const files = await call(client, 'conn_set', {
    alias: 'shop/prod-files', kind: 'files', host: 'shop/srv-prod', config: { proto: 'sftp', root: '/config' },
  });
  assert.equal(files.isError, false, files.text);
  assert.equal(asked.length, 5, 'правка доступов спрашивается каждый раз, разрешение проекта её не покрывает');

  const list = await call(client, 'conn_list', { project: 'shop' });
  assert.deepEqual(list.json.connections.map((c) => `${c.alias}→${c.host}`).sort(),
    ['shop/dev→shop/srv-dev', 'shop/prod-files→shop/srv-prod', 'shop/prod→shop/srv-prod']);

  // Публичный ключ уезжает на dev через реестр же — по паролю, который потом не понадобится.
  const install = await call(client, 'ssh_exec', {
    alias: 'shop/dev',
    command: `mkdir -p ~/.ssh && echo '${pair.public.trim()}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`,
  });
  assert.equal(install.isError, false, install.text);
  assert.equal(install.json.exitCode, 0, install.text);

  // Переключаем dev на ключ: пул обязан заметить смену способа входа и переподключиться.
  const toKey = await call(client, 'secret_set', { target: 'host', alias: 'shop/srv-dev', kind: 'private_key', value: pair.private });
  assert.equal(toKey.isError, false, toKey.text);

  const hosts = await call(client, 'host_list');
  const dev = hosts.json.hosts.find((h) => h.alias === 'shop/srv-dev');
  assert.equal(dev.auth, 'key');
  assert.equal(hosts.text.includes('PRIVATE KEY'), false, 'ключ не утёк в список хостов');

  const onDev = await call(client, 'ssh_exec', { alias: 'shop/dev', command: 'id -un && hostname' });
  assert.equal(onDev.isError, false, onDev.text);
  assert.match(onDev.json.stdout, /deploy\s+sshd_dev/);

  const onProd = await call(client, 'ssh_exec', { alias: 'shop/prod', command: 'id -un && hostname' });
  assert.equal(onProd.isError, false, onProd.text);
  assert.match(onProd.json.stdout, /tester\s+sshd_test/);

  // Хост с живыми подключениями убрать нельзя — реестр называет, кто мешает.
  const blocked = await call(client, 'host_remove', { alias: 'shop/srv-dev' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /shop\/dev/);

  const journal = await call(client, 'audit_query', { project: 'shop', limit: 20 });
  assert.ok(journal.json.entries.length >= 3, 'действия по проекту видны в журнале по имени проекта');
  assert.equal(journal.text.includes('PRIVATE KEY'), false, 'ключ не попал в журнал');
});
