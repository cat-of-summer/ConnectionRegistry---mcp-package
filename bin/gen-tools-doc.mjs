#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Справочник инструментов для человека собирается из самого сервера: описания
// живут в коде и уходят агенту по протоколу, а рукописная копия разъехалась бы
// с ними на первой же правке. Падает, если у инструмента пустое название или
// описание, — поэтому стоит в сборке как проверка.

process.env.CR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-docs-'));
process.env.CR_MASTER_KEY = process.env.CR_MASTER_KEY || 'docs';
// Сборка не ходит в интернет за версиями: справочник от этого не зависит.
process.env.CR_UPDATE_CHECK = '0';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import('../src/server.js');
const { ALL, GROUPS, ALIASES } = await import('../src/tools/groups.js');
const { policy, isSurvey, REMOTE_GROUPS } = await import('../src/approve/policy.js');
const { LANG } = await import('../src/i18n.js');

const { server } = await createServer({ spec: 'all' });
const client = new Client({ name: 'docs', version: '0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const { tools } = await client.listTools();

const byName = Object.fromEntries(ALL.map((tool) => [tool.name, tool]));
const en = LANG === 'en';

const t = (ru, enText) => (en ? enText : ru);

function typeOf(schema) {
  if (!schema) return '';
  if (schema.enum) return schema.enum.map((v) => `\`${v}\``).join(' \\| ');
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' \\| ');
  if (schema.type === 'array') return `${typeOf(schema.items)}[]`;
  return schema.type || 'object';
}

function params(tool) {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const names = Object.keys(props);
  if (!names.length) return t('_Без параметров._', '_No parameters._');

  const rows = names.map((name) => {
    const schema = props[name];
    const flag = required.has(name) ? t('да', 'yes') : t('нет', 'no');
    return `| \`${name}\` | ${typeOf(schema)} | ${flag} | ${(schema.description || '').replace(/\|/g, '\\|')} |`;
  });

  return [
    t('| Параметр | Тип | Обязателен | Описание |', '| Parameter | Type | Required | Description |'),
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

// Класс подтверждения зависит от политики: справочник собирается под ту, что задана
// в CR_POLICY, и не должен описывать чужую.
function confirm(def) {
  if (policy.name === 'loyal') {
    if (isSurvey({ tool: def.name, group: def.group })) return t('нет', 'no');

    const project = t('по доступу к проекту', 'under the project access');
    if (typeof def.mutating === 'function') {
      return t(`${project}, плюс запись на хост для изменяющего запроса`,
        `${project}, plus host write access when the statement mutates`);
    }
    if (def.mutating && REMOTE_GROUPS.includes(def.group)) {
      return t(`${project} и разрешению на запись на хост`, `${project} and the host write grant`);
    }
    return project;
  }

  if (def.everyTime) return t('каждый раз', 'every call');
  if (typeof def.mutating === 'function') {
    return t('по разрешению на проект, если запрос изменяющий', 'under the project grant when the statement mutates');
  }
  return def.mutating ? t('по разрешению на сессию и проект', 'under the session and project grants') : t('нет', 'no');
}

const lines = [
  t('# Инструменты реестра подключений', '# Connection registry tools'),
  '',
  t(
    'Файл собран из сервера командой `npm run docs` и в git не хранится. Описания правятся в `src/tools/`.',
    'Generated from the server by `npm run docs`; not stored in git. Edit descriptions in `src/tools/`.',
  ),
  '',
  t('## Группы', '## Groups'),
  '',
  t(
    'Набор выбирается адресом подключения: `/mcp` — всё, `/mcp/db+audit` — названные группы. Псевдонимы:',
    'The set is chosen by the connection URL: `/mcp` — everything, `/mcp/db+audit` — the named groups. Aliases:',
  ),
  '',
  ...Object.entries(ALIASES).map(([name, groups]) => `- \`${name}\` — ${groups.join(', ')}`),
  '',
  ...Object.entries(GROUPS).map(([group, names]) => `- **${group}**: ${names.map((n) => `\`${n}\``).join(', ')}`),
  '',
];

for (const tool of tools) {
  const def = byName[tool.name];
  if (!tool.title || !tool.description) {
    console.error(`у инструмента ${tool.name} пустое название или описание`);
    process.exit(1);
  }

  lines.push(
    `## ${tool.name}`,
    '',
    `**${tool.title}** · ${t('группа', 'group')} \`${def.group}\` · ${t('подтверждение', 'confirmation')}: ${confirm(def)}`,
    '',
    tool.description,
    '',
    params(tool),
    '',
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'docs', en ? 'tools.en.md' : 'tools.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`${path.relative(process.cwd(), out)}: ${tools.length} ${t('инструментов', 'tools')}`);

await client.close();
fs.rmSync(process.env.CR_ROOT, { recursive: true, force: true });
