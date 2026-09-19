import { z } from 'zod';
import { pick, LANG } from '../i18n.js';
import { cfg } from '../config.js';
import { DIRS } from '../paths.js';
import { keyState } from '../registry/crypto.js';
import { listHosts } from '../registry/hosts.js';
import { listConnections, projects } from '../registry/connections.js';
import { logSize } from '../audit/log.js';
import { pendingCount } from '../approve/queue.js';
import { snapshot } from '../approve/grants.js';
import { policy } from '../approve/policy.js';
import { upgradeSteps } from '../update.js';
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
      '  3. Каждое действие целиком пишется в журнал, а разрешения выдаёт человек — что именно',
      `     спрашивается, зависит от политики (сейчас ${policy.title}): подробности в help approvals.`,
      '',
      'Разделы help: aliases, approvals, files, db, docker, notes, audit, security.',
    ].join('\n'),
    en: [
      'Connection registry: the agent works with aliases like "project/entry", not with addresses and passwords.',
      '',
      'A usual task:',
      '  1. conn_list — what aliases exist. notes_get — what is already known about the project.',
      '  2. A tool for the connection kind: ssh_exec (shell), files_* (files), docker_* (docker), db_* (db).',
      `  3. Every action is journalled in full; what gets confirmed depends on the policy (${policy.name}) —`,
      '     see help approvals.',
      '',
      'help topics: aliases, approvals, files, db, docker, notes, audit, security.',
    ].join('\n'),
  }),

  aliases: pick({
    ru: [
      'Реестр двухуровневый, и оба уровня живут в проекте: алиас — всегда «проект/имя».',
      '',
      'Хост — сервер и способ войти: адрес, пользователь, ключ или пароль, отпечаток хост-ключа.',
      'Подключение — точка входа поверх хоста: shell, files, docker, db.',
      '',
      'Один сервер держит сколько угодно подключений: myproject/shell, myproject/files,',
      'myproject/db, myproject/queue — все они ссылаются на один хост myproject/srv и один',
      'набор кредов. Подключение может сослаться и на хост чужого проекта, если сервер общий;',
      'host_list показывает такие ссылки в usedBy.',
      '',
      'Подключение без хоста ходит по сети напрямую — так заводят базу, доступную снаружи.',
      'Всё остальное (shell, docker, sftp) без хоста не бывает.',
    ].join('\n'),
    en: [
      'The registry has two levels, and both live in a project: an alias is always "project/name".',
      '',
      'A host is a server and a way in: address, user, key or password, host key fingerprint.',
      'A connection is an entry point on top of a host: shell, files, docker, db.',
      '',
      'One server carries any number of connections, all pointing at the same credentials.',
      'A connection may reference a host of another project when the server is shared; host_list',
      'shows such references under usedBy.',
      '',
      'A connection without a host goes over the network directly.',
    ].join('\n'),
  }),

  approvals: pick({
    ru: [
      `Человека спрашивают редко и по делу. Действует ${policy.title} политика (CR_POLICY=${policy.name}).`,
      '',
      ...policy.help.ru,
      '',
      'Сначала спрашивает сам клиент (elicitation MCP). Если клиент этого не умеет, заявка встаёт',
      `в очередь на странице ${cfg.publicBaseUrl}/approvals и вызов ждёт до`,
      `${Math.round(cfg.approveTimeoutMs / 1000)} с. Не дождался — отказ, и это тоже запись в журнале.`,
      '',
      'Что уже разрешено этой сессии, показывает registry_info.',
    ].join('\n'),
    en: [
      `The human is asked rarely and only where it matters. The ${policy.name} policy is active (CR_POLICY).`,
      '',
      ...policy.help.en,
      '',
      `If the client cannot ask, the request waits in the queue at ${cfg.publicBaseUrl}/approvals for`,
      `${Math.round(cfg.approveTimeoutMs / 1000)}s. A timeout is a refusal, and it is journalled too.`,
      '',
      'What this session is already allowed to do is shown by registry_info.',
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
      'Запись входит в разрешение на проект — отдельно о каждой заметке не спрашивают.',
      'Узнали, что факт устарел, — заменяйте значение, а не дописывайте второй ключ рядом.',
    ].join('\n'),
    en: [
      'Notes hold technical knowledge about a project: server paths, versions, container names, deploy order.',
      '',
      'Two kinds: key–value facts and free-form text per project. The project key is the left part of an alias.',
      '',
      'Writing falls under the project grant. Replace an outdated fact instead of adding a second key next to it.',
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
      'Хост-ключ SSH проверяется строго. Ключ, увиденный впервые, закрепляется молча — сверять',
      'его не с чем, — а расхождение с закреплённым отклоняется без вопросов: так выглядит',
      'и подмена сервера, и честная переустановка, и разобраться должен человек.',
    ].join('\n'),
    en: [
      'Secrets never leave the server. No tool returns a password, a key or a connection string.',
      '',
      'Secrets are stored encrypted (AES-256-GCM, key derived from CR_MASTER_KEY). The key sits next to',
      'the database, so encryption protects a copy of the volume and a backup, not a live host.',
      '',
      'SSH host keys are verified strictly: a first-seen key is pinned silently — there is nothing to',
      'compare it against — and a mismatch with a pinned key is refused outright.',
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
      ru: 'Версия и доступность обновления с порядком его установки, пути, поднятый набор '
        + 'инструментов, состояние мастер-ключа, что уже разрешено этой сессии, сколько заведено '
        + 'хостов и подключений, размер журнала, висящие подтверждения. Сюда идут, когда инструмент '
        + 'ответил странно: часто ответ в том, что реестр заперт или подтверждение ждёт человека.',
      en: 'Version and available update with upgrade steps, paths, active tool set, master key state, '
        + 'what this session is already allowed to do, how many hosts and connections exist, journal '
        + 'size, pending approvals. Check here when a tool answers oddly.',
    }),
    input: {},
    run: (_args, { ctx }) => {
      const key = keyState();
      const caps = ctx?.server?.server?.getClientCapabilities?.();

      return {
        data: {
          версия: cfg.version,
          // Порядок обновления кладём прямо сюда: уведомление без инструкции заставляет
          // агента гадать или искать документацию снаружи.
          обновление: ctx?.update
            ? { ...ctx.update, upgrade: ctx.update.upgrade || upgradeSteps(ctx.update.latest) }
            : { updateAvailable: null, unavailable: 'проверка не выполнялась' },
          язык: LANG,
          инструменты: { группы: ctx?.groups || ['все'], сколько: ctx?.toolCount ?? null },
          мастерКлюч: key.unlocked ? 'есть' : `нет (${key.reason})`,
          реестр: {
            хостов: listHosts().length,
            подключений: listConnections().length,
            проектов: projects().length,
          },
          подтверждения: {
            политика: `${policy.title} (CR_POLICY=${policy.name})`,
            выданоВЭтойСессии: snapshot(ctx?.sessionId),
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
