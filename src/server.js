import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cfg } from './config.js';
import { pick } from './i18n.js';
import { select } from './tools/groups.js';
import { wrap } from './tools/shared.js';
import { TOPICS } from './tools/help.js';
import * as query from './audit/query.js';
import { listConnections } from './registry/connections.js';

// Инструкции клиент показывает модели при подключении. Здесь не список
// инструментов — его модель и так видит, — а то, чего в списке не видно:
// откуда начинать и что произойдёт при изменяющем вызове.
function instructions(groups) {
  return pick({
    ru: [
      'Реестр подключений: доступы к серверам, базам, контейнерам и FTP заведены заранее и живут',
      'под алиасами вида «проект/точка». Пароли, ключи и строки подключения не покидают сервер —',
      'запрашивать их у человека не нужно и бесполезно: ни один инструмент их не возвращает.',
      '',
      'Начинайте с conn_list (какие алиасы есть) и notes_get (что уже известно про проект).',
      'Дальше инструмент по типу подключения: ssh_exec, files_*, docker_*, db_*.',
      '',
      'Изменяющее действие сначала спрашивает разрешение у человека и целиком попадает в журнал.',
      'Отказ и таймаут — обычный исход, а не сбой: сообщите о нём и предложите, что делать.',
      '',
      `Подробности — help (разделы: ${Object.keys(TOPICS).join(', ')}), состояние — registry_info.`,
      `Поднятые группы инструментов: ${groups.join(', ')}.`,
    ].join('\n'),
    en: [
      'Connection registry: access to servers, databases, containers and FTP is registered in advance',
      'and lives under aliases like "project/entry". Passwords, keys and connection strings never leave',
      'the server — asking the human for them is pointless: no tool returns them.',
      '',
      'Start with conn_list and notes_get, then use the tool for the connection kind:',
      'ssh_exec, files_*, docker_*, db_*.',
      '',
      'A mutating action asks the human first and is journalled in full. A refusal or a timeout is a',
      'normal outcome, not a failure.',
      '',
      `Details — help (topics: ${Object.keys(TOPICS).join(', ')}), state — registry_info.`,
      `Active tool groups: ${groups.join(', ')}.`,
    ].join('\n'),
  });
}

export function createServer({ spec = 'all' } = {}) {
  const { groups, tools } = select(spec);

  const server = new McpServer(
    { name: 'connection-registry', version: cfg.version },
    { instructions: instructions(groups) },
  );

  const ctx = { server, groups, toolCount: tools.length };

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: def.mutating === false,
          destructiveHint: def.mutating === true,
        },
      },
      wrap(def, ctx),
    );
  }

  registerResources(server);
  registerPrompts(server);

  return { server, ctx, groups, tools };
}

// Ресурсы дают клиенту закрепить справку и список алиасов в контексте,
// не тратя на это вызов инструмента.
function registerResources(server) {
  server.registerResource(
    'connections',
    'cr://connections',
    {
      title: pick({ ru: 'Заведённые подключения', en: 'Registered connections' }),
      description: pick({ ru: 'Алиасы, типы и хосты — без секретов', en: 'Aliases, kinds and hosts — no secrets' }),
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'cr://connections',
        mimeType: 'application/json',
        text: JSON.stringify(listConnections(), null, 2),
      }],
    }),
  );

  server.registerResource(
    'journal',
    'cr://audit/recent',
    {
      title: pick({ ru: 'Последние действия', en: 'Recent actions' }),
      description: pick({ ru: 'Сводка последних записей журнала', en: 'Summary of the latest journal entries' }),
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'cr://audit/recent',
        mimeType: 'application/json',
        text: JSON.stringify(query.list({ limit: 20 }), null, 2),
      }],
    }),
  );

  for (const [name, text] of Object.entries(TOPICS)) {
    server.registerResource(
      `help-${name}`,
      `cr://help/${name}`,
      { title: `help: ${name}`, mimeType: 'text/markdown' },
      async () => ({ contents: [{ uri: `cr://help/${name}`, mimeType: 'text/markdown', text }] }),
    );
  }
}

function registerPrompts(server) {
  server.registerPrompt(
    'deploy-check',
    {
      title: pick({ ru: 'Проверить проект на сервере', en: 'Inspect a project on the server' }),
      description: pick({
        ru: 'Сверить, что развёрнуто на сервере, с тем, что записано в заметках проекта',
        en: 'Compare what is deployed on the server with what the project notes claim',
      }),
      argsSchema: {},
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: pick({
            ru: 'Возьми заметки проекта (notes_get) и проверь по ним состояние сервера: версии, пути, '
              + 'контейнеры. Расхождения перечисли и предложи, какие факты в заметках обновить. '
              + 'Изменяющих действий не делай.',
            en: 'Take the project notes (notes_get) and verify the server against them: versions, paths, '
              + 'containers. List the differences and suggest which facts to update. Do not change anything.',
          }),
        },
      }],
    }),
  );
}
