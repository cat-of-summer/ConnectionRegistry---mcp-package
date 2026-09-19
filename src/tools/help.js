import { z } from 'zod';
import { pick, LANG } from '../i18n.js';
import { cfg } from '../config.js';
import { DIRS } from '../paths.js';
import { keyState } from '../registry/crypto.js';
import { listHosts } from '../registry/hosts.js';
import { listConnections, projects } from '../registry/connections.js';
import { logSize } from '../audit/log.js';
import { pendingCount } from '../approve/queue.js';
import { poolState } from '../transport/ssh.js';

const GROUP = 'service';

export const TOPICS = {
  index: pick({
    ru: [
      'Реестр подключений: агент работает с алиасами вида «проект/точка», а не с адресами и паролями.',
      '',
      'Порядок обычной задачи:',
      '  1. conn_list — какие алиасы есть. notes_get — что уже известно про проект.',
      '  2. Инструмент по типу подключения: ssh_exec (shell), files_* (files), docker_* (docker), db_* (db).',
      '  3. Изменяющее действие спрашивает подтверждение у человека и целиком пишется в журнал.',
      '',
      'Разделы help: aliases, approvals, files, db, docker, notes, audit, security.',
    ].join('\n'),
    en: [
      'Connection registry: the agent works with aliases like "project/entry", not with addresses and passwords.',
      '',
      'A usual task:',
      '  1. conn_list — what aliases exist. notes_get — what is already known about the project.',
      '  2. A tool for the connection kind: ssh_exec (shell), files_* (files), docker_* (docker), db_* (db).',
      '  3. A mutating action asks the human for confirmation and is journalled in full.',
      '',
      'help topics: aliases, approvals, files, db, docker, notes, audit, security.',
    ].join('\n'),
  }),

  aliases: pick({
    ru: [
      'Реестр двухуровневый.',
      '',
      'Хост — сервер и способ войти: адрес, пользователь, ключ или пароль, отпечаток хост-ключа.',
      'Подключение — точка входа поверх хоста: shell, files, docker, db. Алиас вида «проект/имя».',
      '',
      'Один сервер держит сколько угодно подключений: myproject/shell, myproject/files,',
      'myproject/db, myproject/queue — все они ссылаются на один хост и один набор кредов.',
      '',
      'Подключение без хоста ходит по сети напрямую — так заводят базу, доступную снаружи.',
      'Всё остальное (shell, docker, sftp) без хоста не бывает.',
    ].join('\n'),
    en: [
      'The registry has two levels.',
      '',
      'A host is a server and a way in: address, user, key or password, host key fingerprint.',
      'A connection is an entry point on top of a host: shell, files, docker, db. Alias is "project/name".',
      '',
      'One server carries any number of connections, all pointing at the same credentials.',
      '',
      'A connection without a host goes over the network directly.',
    ].join('\n'),
  }),

  approvals: pick({
    ru: [
      'Изменяющее действие выполняется только после разрешения человека.',
      '',
      'Сначала спрашивает сам клиент (elicitation MCP). Если клиент этого не умеет, заявка встаёт',
      `в очередь на странице ${cfg.publicBaseUrl}/approvals и вызов ждёт до`,
      `${Math.round(cfg.approveTimeoutMs / 1000)} с. Не дождался — отказ, и это тоже запись в журнале.`,
      '',
      'Что спрашивается: ssh_exec, ssh_script, docker_exec/restart/compose, files_put/move/remove/mkdir/chmod,',
      'изменяющий db_query, любая правка реестра и заметок, а также первый хост-ключ.',
      'Что не спрашивается: чтение — conn_list, files_list/read/get, docker_ps/logs, SELECT, журнал.',
      '',
      'У подключения бывает своя политика: always — спрашивать даже на чтении, never — не спрашивать',
      'вовсе (для локальных и тестовых), writes — по умолчанию.',
    ].join('\n'),
    en: [
      'A mutating action runs only after the human allows it.',
      '',
      'The client is asked first (MCP elicitation). If it cannot ask, the request goes to the queue at',
      `${cfg.publicBaseUrl}/approvals and the call waits up to ${Math.round(cfg.approveTimeoutMs / 1000)}s.`,
      '',
      'Per-connection policy: always, writes (default), never.',
    ].join('\n'),
  }),

  files: pick({
    ru: [
      'Файлы ходят мимо MCP: содержимое не протаскивается через контекст модели.',
      '',
      'На сервер:  curl -F file=@путь ' + cfg.publicBaseUrl + '/upload  →  в ответе cr://uploads/…',
      '            дальше files_put с source: "cr://uploads/…".',
      'Маленький текстовый файл можно положить и параметром content.',
      '',
      'С сервера:  files_read — текст в ответ (обрезается по потолку),',
      '            files_get — файл в артефакты реестра, в ответе ссылка.',
      '',
      'Путь без ведущего «/» считается от root подключения, абсолютный уходит как есть.',
      'Рекурсивного удаления нет: снести дерево — это ssh_exec, где команда видна человеку целиком.',
    ].join('\n'),
    en: [
      'Files bypass MCP: contents never travel through the model context.',
      '',
      `To the server:  curl -F file=@path ${cfg.publicBaseUrl}/upload  →  cr://uploads/… , then files_put.`,
      'From the server: files_read for text, files_get for a link to an artifact.',
      '',
      'A relative path is resolved against the connection root.',
    ].join('\n'),
  }),

  db: pick({
    ru: [
      'База обычно слушает только 127.0.0.1 на своём сервере — и правильно делает.',
      'Поэтому подключение к базе идёт через SSH-туннель к хосту: реестр поднимает локальный порт,',
      'и драйвер вместе с pg_dump ходят уже на него. Порт базы наружу открывать не нужно.',
      '',
      'db_query разбирает SQL сам: SELECT выполняется сразу, изменяющий запрос спрашивает человека.',
      'Несколько запросов через «;» в одном вызове отклоняются — человек должен подтвердить ровно то,',
      'что уйдёт в базу. Параметры передавайте в params, а не склейкой строк.',
      '',
      `Строки ответа обрезаются по CR_DB_MAX_ROWS (${cfg.dbMaxRows}). Большая выборка — это db_dump.`,
    ].join('\n'),
    en: [
      'Databases usually listen on 127.0.0.1 only, so the registry tunnels through SSH and opens a local port.',
      '',
      'db_query parses the SQL: SELECT runs immediately, a mutating statement asks the human.',
      `Rows are capped at CR_DB_MAX_ROWS (${cfg.dbMaxRows}); large extracts belong in db_dump.`,
    ].join('\n'),
  }),

  docker: pick({
    ru: [
      'Docker удалённого сервера водится его же CLI по SSH: ни сокета наружу, ни второго набора кредов.',
      'Контейнер по умолчанию задан в настройках алиаса, поэтому обычно хватает самого алиаса.',
      'composeFile и workdir в настройках делают docker_compose вызовом из нужного каталога.',
      '',
      'Локального docker у реестра нет намеренно: сокет хоста в контейнер не монтируется.',
    ].join('\n'),
    en: [
      'Remote docker is driven by its own CLI over SSH: no exposed socket, no second credential set.',
      'The default container and compose file come from the alias settings.',
      '',
      'The registry has no access to a local docker socket on purpose.',
    ].join('\n'),
  }),

  notes: pick({
    ru: [
      'Заметки — технические знания о проекте, которые иначе выясняются заново каждую сессию:',
      'путь до кода на сервере, версия PHP, имя контейнера с очередью, порядок деплоя.',
      '',
      'Два вида: факты «ключ — значение» (php.version = 8.3) и свободный текст на проект.',
      'Ключ проекта — левая часть алиаса, поэтому знание и доступ лежат под одним именем.',
      '',
      'Запись всегда спрашивает человека: заметки — его знание, а не вывод модели.',
      'Узнали, что факт устарел, — заменяйте значение, а не дописывайте второй ключ рядом.',
    ].join('\n'),
    en: [
      'Notes hold technical knowledge about a project: server paths, versions, container names, deploy order.',
      '',
      'Two kinds: key–value facts and free-form text per project. The project key is the left part of an alias.',
      '',
      'Writing always asks the human. Replace an outdated fact instead of adding a second key next to it.',
    ].join('\n'),
  }),

  audit: pick({
    ru: [
      'Записывается каждое действие: время, алиас, инструмент, аргументы, команда, код возврата,',
      'решение по подтверждению, stdout и stderr целиком. Секреты маскируются.',
      '',
      'Журнал лежит файлами JSONL в томе logs; крупный вывод уезжает в отдельный файл рядом.',
      `Потолок общего размера — CR_LOG_MAX_BYTES (${Math.round(cfg.logMaxBytes / 1024 / 1024)} МБ),`,
      'при переполнении удаляются самые старые файлы целиком.',
      '',
      'audit_tail — что было недавно, audit_query — выборка, audit_show — запись целиком.',
    ].join('\n'),
    en: [
      'Every action is recorded: time, alias, tool, arguments, command, exit code, approval decision,',
      'full stdout and stderr. Secrets are masked.',
      '',
      `JSONL files in the logs volume, capped at CR_LOG_MAX_BYTES (${Math.round(cfg.logMaxBytes / 1024 / 1024)} MB).`,
    ].join('\n'),
  }),

  security: pick({
    ru: [
      'Секреты не покидают сервер. Ни один инструмент не возвращает пароль, ключ или строку подключения:',
      'conn_info отдаёт способ входа и отпечаток хоста, но не сам секрет.',
      '',
      'В реестре секреты лежат зашифрованными (AES-256-GCM, ключ выводится из CR_MASTER_KEY).',
      'Ключ лежит рядом с базой, поэтому шифрование защищает копию тома и бэкап, а не живой хост.',
      '',
      'Хост-ключ SSH проверяется строго. Первый ключ закрепляется с подтверждением человека,',
      'расхождение с закреплённым — отказ без вопросов: так выглядит и подмена сервера,',
      'и честная переустановка, и разобраться должен человек.',
    ].join('\n'),
    en: [
      'Secrets never leave the server. No tool returns a password, a key or a connection string.',
      '',
      'Secrets are stored encrypted (AES-256-GCM, key derived from CR_MASTER_KEY). The key sits next to',
      'the database, so encryption protects a copy of the volume and a backup, not a live host.',
      '',
      'SSH host keys are verified strictly: the first key is pinned after human confirmation, a mismatch',
      'is refused outright.',
    ].join('\n'),
  }),
};

export const tools = [
  {
    name: 'registry_info',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Состояние реестра', en: 'Registry state' }),
    description: pick({
      ru: 'Версия, пути, поднятый набор инструментов, состояние мастер-ключа, сколько заведено хостов '
        + 'и подключений, размер журнала, висящие подтверждения. Сюда идут, когда инструмент ответил '
        + 'странно: часто ответ в том, что реестр заперт или подтверждение ждёт человека.',
      en: 'Version, paths, active tool set, master key state, how many hosts and connections exist, '
        + 'journal size, pending approvals. Check here when a tool answers oddly.',
    }),
    input: {},
    run: (_args, { ctx }) => {
      const key = keyState();
      const caps = ctx?.server?.server?.getClientCapabilities?.();

      return {
        data: {
          версия: cfg.version,
          язык: LANG,
          инструменты: { группы: ctx?.groups || ['все'], сколько: ctx?.toolCount ?? null },
          мастерКлюч: key.unlocked ? 'есть' : `нет (${key.reason})`,
          реестр: {
            хостов: listHosts().length,
            подключений: listConnections().length,
            проектов: projects().length,
          },
          подтверждения: {
            политикаПоУмолчанию: cfg.defaultConfirmPolicy,
            таймаутСекунд: Math.round(cfg.approveTimeoutMs / 1000),
            ждут: pendingCount(),
            клиентУмеетСпрашивать: Boolean(caps?.elicitation),
            страница: `${cfg.publicBaseUrl}/approvals`,
          },
          журнал: {
            размерБайт: logSize(),
            потолокБайт: cfg.logMaxBytes,
            страница: `${cfg.publicBaseUrl}/audit`,
          },
          соединения: { живыеSSH: poolState() },
          каталоги: DIRS,
          загрузка: `${cfg.publicBaseUrl}/upload`,
        },
      };
    },
  },

  {
    name: 'help',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Справка', en: 'Help' }),
    description: pick({
      ru: 'Как устроен реестр и что где спрашивается. Без параметров — оглавление; topic — раздел '
        + '(aliases, approvals, files, db, docker, notes, audit, security).',
      en: 'How the registry works and what gets confirmed. No arguments — index; topic — a section '
        + '(aliases, approvals, files, db, docker, notes, audit, security).',
    }),
    input: {
      topic: z.enum(Object.keys(TOPICS)).optional(),
    },
    run: (args) => ({ data: TOPICS[args.topic || 'index'] }),
  },
];
