import { z } from 'zod';
import { pick } from '../i18n.js';
import { listHosts, upsertHost, removeHost, hostUsage } from '../registry/hosts.js';
import { listConnections, getConnection, upsertConnection, removeConnection, projects } from '../registry/connections.js';
import { KINDS, AUTH_KINDS, DB_ENGINES, FILE_PROTOCOLS } from '../registry/schema.js';
import { putSecret, replaceSecret } from '../registry/crypto.js';
import { db } from '../registry/db.js';
import { resolve } from '../registry/resolve.js';
import { connect } from '../transport/ssh.js';
import * as filesTransport from '../transport/files.js';
import * as dbTransport from '../transport/db/index.js';

const GROUP = 'registry';

export const tools = [
  {
    name: 'conn_list',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Список подключений', en: 'List connections' }),
    description: pick({
      ru: 'Какие алиасы заведены: тип, хост, настройки без секретов. С этого начинают работу — '
        + 'дальше все инструменты принимают алиас, а не адрес и пароль.',
      en: 'Registered aliases with kind, host and non-secret settings. Start here: every other tool '
        + 'takes an alias, never an address or a password.',
    }),
    input: {
      project: z.string().optional().describe(pick({ ru: 'только один проект', en: 'single project only' })),
      kind: z.enum(KINDS).optional().describe(pick({ ru: 'только один тип', en: 'single kind only' })),
    },
    run: (args) => ({ data: { connections: listConnections(args), projects: projects() } }),
  },

  {
    name: 'conn_info',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Подробности подключения', en: 'Connection details' }),
    description: pick({
      ru: 'Всё, что известно об алиасе, кроме секретов: адрес, пользователь, способ входа, отпечаток '
        + 'хост-ключа, настройки. Пароль и ключ не отдаёт ни один инструмент.',
      en: 'Everything known about an alias except secrets: address, user, auth kind, host key fingerprint, '
        + 'settings. No tool ever returns a password or a key.',
    }),
    input: { alias: z.string().describe(pick({ ru: 'алиас вида project/name', en: 'alias like project/name' })) },
    run: (args) => {
      const conn = getConnection(args.alias);
      if (!conn) throw new Error(`подключение «${args.alias}» не заведено`);
      return { data: conn };
    },
  },

  {
    name: 'host_list',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Список хостов', en: 'List hosts' }),
    description: pick({
      ru: 'Серверы, на которые ссылаются подключения: адрес, пользователь, способ входа, отпечаток ключа.',
      en: 'Servers behind the connections: address, user, auth kind, host key fingerprint.',
    }),
    input: {},
    run: () => ({ data: { hosts: listHosts().map((h) => ({ ...h, usedBy: hostUsage(h.alias) })) } }),
  },

  {
    name: 'host_set',
    group: GROUP,
    everyTime: true,
    mutating: true,
    title: pick({ ru: 'Завести или изменить хост', en: 'Create or update a host' }),
    description: pick({
      ru: 'Заводит сервер: адрес, пользователь, вход по паролю или ключу. Поля, которых нет во вводе, '
        + 'остаются прежними — сменить порт можно, не повторяя пароль. Требует подтверждения человека.',
      en: 'Registers a server: address, user, password or key auth. Omitted fields keep their previous value, '
        + 'so changing a port does not require repeating the password. Requires human confirmation.',
    }),
    input: {
      alias: z.string().describe(pick({ ru: 'короткое имя сервера', en: 'short server name' })),
      address: z.string().optional(),
      port: z.number().int().positive().optional(),
      user: z.string().optional(),
      auth: z.enum(AUTH_KINDS).optional(),
      password: z.string().optional().describe(pick({ ru: 'пароль входа', en: 'login password' })),
      privateKey: z.string().optional().describe(pick({ ru: 'приватный ключ целиком', en: 'full private key' })),
      passphrase: z.string().optional(),
      hostKey: z.string().optional().describe(pick({ ru: 'отпечаток SHA256:…', en: 'SHA256:… fingerprint' })),
      note: z.string().optional(),
    },
    summary: (args) => `Завести или изменить хост «${args.alias}» в реестре`,
    details: (args) => ({
      адрес: args.address,
      пользователь: args.user,
      вход: args.privateKey ? 'приватный ключ' : (args.password ? 'пароль' : args.auth || 'без изменений'),
    }),
    run: (args) => ({ data: upsertHost(args) }),
  },

  {
    name: 'host_remove',
    group: GROUP,
    everyTime: true,
    mutating: true,
    title: pick({ ru: 'Убрать хост', en: 'Remove a host' }),
    description: pick({
      ru: 'Удаляет сервер и его секреты. Откажет, пока на него ссылается хоть одно подключение.',
      en: 'Deletes a server and its secrets. Refuses while any connection still points at it.',
    }),
    input: { alias: z.string() },
    summary: (args) => `Убрать хост «${args.alias}» и его секреты из реестра`,
    run: (args) => ({ data: removeHost(args.alias) }),
  },

  {
    name: 'conn_set',
    group: GROUP,
    everyTime: true,
    mutating: true,
    title: pick({ ru: 'Завести или изменить подключение', en: 'Create or update a connection' }),
    description: pick({
      ru: 'Заводит точку входа поверх хоста: shell, files, docker или db. Алиас — «проект/имя». '
        + 'Один сервер держит сколько угодно подключений. Требует подтверждения человека.',
      en: 'Registers an entry point on top of a host: shell, files, docker or db. Alias is "project/name". '
        + 'One server can carry any number of connections. Requires human confirmation.',
    }),
    input: {
      alias: z.string().describe(pick({ ru: 'project/name', en: 'project/name' })),
      kind: z.enum(KINDS).optional(),
      host: z.string().nullable().optional().describe(pick({
        ru: 'алиас хоста; null — ходить напрямую по сети',
        en: 'host alias; null means direct network access',
      })),
      config: z.object({
        cwd: z.string().optional(),
        shell: z.string().optional(),
        proto: z.enum(FILE_PROTOCOLS).optional(),
        root: z.string().optional(),
        address: z.string().optional(),
        port: z.number().int().positive().optional(),
        username: z.string().optional(),
        secure: z.boolean().optional(),
        container: z.string().optional(),
        composeFile: z.string().optional(),
        workdir: z.string().optional(),
        sudo: z.boolean().optional(),
        engine: z.enum(DB_ENGINES).optional(),
        database: z.string().optional(),
        ssl: z.boolean().optional(),
      }).optional().describe(pick({
        ru: 'настройки по типу: shell — cwd; files — proto, root; docker — container, composeFile; '
          + 'db — engine, database, username',
        en: 'kind-specific settings: shell — cwd; files — proto, root; docker — container, composeFile; '
          + 'db — engine, database, username',
      })),
      password: z.string().optional().describe(pick({ ru: 'пароль базы или ftp', en: 'database or ftp password' })),
      note: z.string().optional(),
    },
    summary: (args) => `Завести или изменить подключение «${args.alias}» в реестре`,
    details: (args) => ({ тип: args.kind, хост: args.host, настройки: args.config }),
    run: (args) => ({ data: upsertConnection(args) }),
  },

  {
    name: 'conn_remove',
    group: GROUP,
    everyTime: true,
    mutating: true,
    title: pick({ ru: 'Убрать подключение', en: 'Remove a connection' }),
    description: pick({
      ru: 'Удаляет алиас и его собственный секрет. Хост и другие подключения остаются.',
      en: 'Deletes an alias and its own secret. The host and other connections stay.',
    }),
    input: { alias: z.string() },
    summary: (args) => `Убрать подключение «${args.alias}» из реестра`,
    run: (args) => ({ data: removeConnection(args.alias) }),
  },

  {
    name: 'secret_set',
    group: GROUP,
    everyTime: true,
    mutating: true,
    title: pick({ ru: 'Положить секрет', en: 'Store a secret' }),
    description: pick({
      ru: 'Кладёт пароль, приватный ключ или парольную фразу в реестр. Значение шифруется и наружу '
        + 'не возвращается никогда — ни этим инструментом, ни любым другим.',
      en: 'Stores a password, private key or passphrase. The value is encrypted and never returned by '
        + 'this or any other tool.',
    }),
    input: {
      target: z.enum(['host', 'connection']),
      alias: z.string(),
      kind: z.enum(['password', 'private_key', 'passphrase']),
      value: z.string(),
    },
    summary: (args) => `Положить секрет (${args.kind}) для ${args.target === 'host' ? 'хоста' : 'подключения'} «${args.alias}»`,
    run: (args) => {
      if (args.target === 'host') {
        const patch = { alias: args.alias };
        if (args.kind === 'password') patch.password = args.value;
        if (args.kind === 'private_key') { patch.privateKey = args.value; patch.auth = 'key'; }
        if (args.kind === 'passphrase') patch.passphrase = args.value;
        return { data: { stored: true, host: upsertHost(patch).alias } };
      }

      if (args.kind !== 'password') {
        throw new Error('у подключения бывает только пароль; ключ и фраза живут на хосте');
      }

      const row = db().prepare('SELECT id, secret_id FROM connections WHERE alias = ?').get(args.alias);
      if (!row) throw new Error(`подключение «${args.alias}» не заведено`);

      const secretId = row.secret_id
        ? replaceSecret(row.secret_id, 'password', args.value)
        : putSecret('password', args.value);
      db().prepare('UPDATE connections SET secret_id = ? WHERE id = ?').run(secretId, row.id);

      return { data: { stored: true, connection: args.alias } };
    },
  },

  {
    name: 'conn_check',
    group: GROUP,
    mutating: false,
    needsConnection: true,
    title: pick({ ru: 'Проверить доступность', en: 'Check reachability' }),
    description: pick({
      ru: 'Подключается по алиасу и сразу отсоединяется: отвечает, живы ли креды, сходится ли '
        + 'отпечаток хоста и доступна ли база. Ничего не меняет.',
      en: 'Connects by alias and disconnects right away: tells whether credentials work, the host key '
        + 'matches and the database answers. Changes nothing.',
    }),
    input: { alias: z.string() },
    run: async (args, { approveHostKey }) => {
      const resolved = resolve(args.alias);

      if (resolved.kind === 'db') {
        const res = await dbTransport.query(resolved, 'select 1', { approveHostKey, maxRows: 1 });
        return { data: { alias: args.alias, ok: true, kind: 'db', via: res.via } };
      }

      if (resolved.kind === 'files' && (resolved.config.proto || 'sftp') !== 'sftp') {
        const list = await filesTransport.withFiles(resolved, { approveHostKey },
          (api) => api.list(filesTransport.resolvePath(resolved, '.')));
        return { data: { alias: args.alias, ok: true, kind: 'files', proto: resolved.config.proto, entries: list.length } };
      }

      await connect(resolved.host, { approveHostKey });
      return {
        data: {
          alias: args.alias,
          ok: true,
          kind: resolved.kind,
          host: resolved.host.alias,
          hostKey: resolved.host.hostKey,
          hostKeyStatus: resolved.host.hostKeyStatus,
        },
      };
    },
  },
];
