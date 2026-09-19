import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-manifest-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-для-манифеста';
process.env.CR_UPDATE_CHECK = '0';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import('../src/server.js');
const { ALL, GROUPS, select } = await import('../src/tools/groups.js');

// Манифест агент вычитывает при каждом подключении, до первого полезного действия.
// Тест держит верхнюю границу и заодно ловит схему, которая не сворачивается в
// JSON Schema: без него опечатка в описании инструмента валит сервер при зелёных тестах.
const MANIFEST_BUDGET = 30_000;

async function connect(spec) {
  const { server } = await createServer({ spec });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('сервер поднимается и отдаёт все инструменты', async () => {
  const { client } = await connect('all');
  const { tools } = await client.listTools();

  assert.equal(tools.length, ALL.length, 'в манифесте столько же инструментов, сколько объявлено');

  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 40, `${tool.name}: описание пустое или куцее`);
    assert.ok(tool.inputSchema, `${tool.name}: схема не свернулась`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('имена инструментов уникальны', () => {
  const names = ALL.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, `дубли: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
});

test('манифест помещается в бюджет', async () => {
  const { client } = await connect('all');
  const { tools } = await client.listTools();
  const size = Buffer.byteLength(JSON.stringify(tools));

  const heaviest = tools
    .map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool)) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  assert.ok(
    size <= MANIFEST_BUDGET,
    `манифест ${size} Б при потолке ${MANIFEST_BUDGET}. Самые тяжёлые: ${JSON.stringify(heaviest)}`,
  );
});

test('адрес сокращает набор, но служебные остаются', async () => {
  const { client } = await connect('db+audit');
  const names = (await client.listTools()).tools.map((tool) => tool.name);

  assert.ok(names.includes('db_query'));
  assert.ok(names.includes('audit_query'));
  assert.ok(names.includes('registry_info'), 'registry_info есть на любом адресе');
  assert.ok(names.includes('help'), 'help есть на любом адресе');
  assert.equal(names.includes('ssh_exec'), false);
});

test('псевдонимы раскрываются, порядок не важен', () => {
  assert.deepEqual(select('audit+db').groups.sort(), select('db+audit').groups.sort());
  assert.ok(select('core').groups.includes('files'));
  assert.ok(select('ops').groups.includes('docker'));
});

test('неизвестная группа называет существующие', () => {
  assert.throws(() => select('нетакой'), new RegExp(Object.keys(GROUPS)[0]));
});

test('у каждого изменяющего инструмента есть текст для человека', () => {
  for (const tool of ALL) {
    if (!tool.mutating && !tool.everyTime) continue;
    if (typeof tool.mutating === 'function') {
      assert.ok(tool.summary, `${tool.name}: нет summary, человеку нечего показать`);
      continue;
    }
    assert.ok(tool.summary, `${tool.name}: нет summary, человеку нечего показать`);
  }
});

test('инструменты, требующие подключения, объявляют допустимые типы', () => {
  for (const tool of ALL) {
    if (!tool.needsConnection) continue;
    if (tool.name === 'conn_check') continue; // работает со всеми типами
    assert.ok(Array.isArray(tool.kinds) && tool.kinds.length, `${tool.name}: не сказано, с какими типами работает`);
  }
});
