import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cfg } from './config.js';
import { pick } from './i18n.js';
import { select } from './tools/groups.js';
import { wrap } from './tools/shared.js';
import { TOPICS } from './tools/help.js';
import { policy } from './approve/policy.js';
import * as query from './audit/query.js';
import { listConnections } from './registry/connections.js';
import { checkForUpdate, updateNotice } from './update.js';

// Инструкции клиент показывает модели при подключении. Здесь не список
// инструментов — его модель и так видит, — а то, чего в списке не видно:
// откуда начинать и что произойдёт при изменяющем вызове.
function instructions(groups, notice) {
  const text = pick({
    ru: [
      'Реестр подключений: доступы к серверам, базам, контейнерам и FTP заведены заранее и живут',
      'под алиасами вида «проект/точка». Пароли, ключи и строки подключения не покидают сервер —',
      'запрашивать их у человека не нужно и бесполезно: ни один инструмент их не возвращает.',
      '',
      'Начинайте с project_list (какие проекты есть и где на этой машине их папки), conn_list (какие',
      'алиасы) и notes_get (ключи фактов; значения нужных — тем же инструментом с keys).',
      'Дальше инструмент по типу подключения: ssh_exec, files_*, docker_*, db_*.',
      'Новый проект заводится project_set с рабочей директорией — раньше хостов и подключений.',
      'Вскрылся постоянный путь (гит фронтенда, каталог compose) — допишите его в project_set.',
      '',
      ...policy.short.ru,
      'Всё целиком попадает в журнал.',
      'Отказ и таймаут — обычный исход, а не сбой: сообщите о нём и предложите, что делать.',
      'Если человек в чём-то отказал, не пытайтесь обойти это другим инструментом.',
      '',
      `Подробности — help (разделы: ${Object.keys(TOPICS).join(', ')}), состояние — registry_info.`,
      `Поднятые группы инструментов: ${groups.join(', ')}.`,
    ].join('\n'),
    en: [
      'Connection registry: access to servers, databases, containers and FTP is registered in advance',
      'and lives under aliases like "project/entry". Passwords, keys and connection strings never leave',
      'the server — asking the human for them is pointless: no tool returns them.',
      '',
      'Start with project_list (projects and their folders on this machine), conn_list (aliases) and',
      'notes_get (fact keys; values of the needed ones — same tool with keys). Then use the tool for',
      'the connection kind: ssh_exec, files_*, docker_*, db_*.',
      'A new project is registered with project_set and a working directory — before hosts and',
      'connections. Found another permanent path (frontend git, compose folder) — add it there too.',
      '',
      ...policy.short.en,
      'Everything is journalled in full. A refusal or a timeout is a normal outcome, not a failure.',
      'If the human refused something, do not try to route around it with another tool.',
      '',
      `Details — help (topics: ${Object.keys(TOPICS).join(', ')}), state — registry_info.`,
      `Active tool groups: ${groups.join(', ')}.`,
    ].join('\n'),
  });

  // Уведомление об обновлении — частью инструкций, а не отдельным инструментом: агент должен
  // увидеть его при подключении, не вызывая ничего.
  return notice ? `${text}\n\n${notice}` : text;
}

/*
 * Проверка обновлений запускается один раз на процесс и переживает переподключения: спрашивать
 * GitHub на каждой новой сессии незачем. Упасть она не может — внутри таймаут и перехват любых
 * отказов, — но и задержать запуск надолго тоже.
 */
let updatePromise = null;
export const update = () => (updatePromise ??= checkForUpdate().catch(() => null));

export async function createServer({ spec = 'all' } = {}) {
  const { groups, tools } = select(spec);
  const updateState = await update();

  const server = new McpServer(
    { name: 'connection-registry', version: cfg.version },
    { instructions: instructions(groups, updateNotice(updateState)) },
  );

  const ctx = { server, groups, toolCount: tools.length, update: updateState };

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
            ru: 'Возьми ключи фактов проекта (notes_get), прочитай значения тех, что про сервер (notes_get '
              + 'с keys), и проверь по ним его состояние: версии, пути, контейнеры. Расхождения перечисли '
              + 'и предложи, какие факты обновить. Изменяющих действий не делай.',
            en: 'Take the project fact keys (notes_get), read the values of those about the server (notes_get '
              + 'with keys) and verify the server against them: versions, paths, containers. List the '
              + 'differences and suggest which facts to update. Do not change anything.',
          }),
        },
      }],
    }),
  );
}
