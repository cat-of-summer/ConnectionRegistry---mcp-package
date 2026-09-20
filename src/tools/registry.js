import { z } from 'zod';
import { pick } from '../i18n.js';
import { listHosts, upsertHost, removeHost, hostUsage, hostProjects } from '../registry/hosts.js';
import { listConnections, getConnection, upsertConnection, removeConnection, projects } from '../registry/connections.js';
import { listProjects, upsertProject, removeDir, removeProject, COMMENT_MAX } from '../registry/projects.js';
import { KINDS, AUTH_KINDS, DB_ENGINES, FILE_PROTOCOLS } from '../registry/schema.js';
import { putSecret, replaceSecret } from '../registry/crypto.js';
import { db } from '../registry/db.js';
import { resolve, isSecretRef } from '../registry/resolve.js';
import { connect } from '../transport/ssh.js';
import * as filesTransport from '../transport/files.js';
import * as dbTransport from '../transport/db/index.js';

const GROUP = 'registry';

const dirSchema = z.object({
  path: z.string().describe(pick({ ru: 'путь на этой машине', en: 'path on this machine' })),
  comment: z.string().max(COMMENT_MAX).describe(pick({
    ru: 'что там: «код Laravel, git, ветка dev», «compose стенда, WSL»',
    en: 'what is there: "Laravel code, git, dev branch", "compose stack, WSL"',
  })),
}).strict();

export const tools = [
  {
    name: 'project_list',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Список проектов', en: 'List projects' }),
    description: pick({
      ru: 'Проекты и их рабочие директории на этой машине: где код, compose, фронтенд. С этого '
        + 'начинают: имя проекта — левая часть алиаса, директория — где работать.',
      en: 'Projects and their working directories on this machine: code, compose, frontend. Start here: '
        + 'the project name is the left part of an alias, the directory is where to work.',
    }),
    input: {},
    run: () => ({ data: { projects: listProjects() } }),
  },

  {
    name: 'project_set',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Завести или изменить проект', en: 'Create or update a project' }),
    description: pick({
      ru: 'Заводит проект раньше хостов, подключений и фактов. Новому нужна хотя бы одна рабочая '
        + 'директория с комментарием. Директории сливаются по пути: вскрылся постоянный путь — гит '
        + 'фронтенда, каталог compose — добавьте его сюда.',
      en: 'Registers a project before its hosts, connections and facts. A new one needs at least one '
        + 'working directory with a comment. Directories merge by path: found a permanent path — '
        + 'frontend git, compose folder — add it here.',
    }),
    input: {
      project: z.string().describe(pick({ ru: 'имя, одно слово строчными', en: 'name, one lowercase word' })),
      comment: z.string().max(COMMENT_MAX).optional().describe(pick({ ru: 'что за проект, одной строкой', en: 'what the project is, one line' })),
      dirs: z.array(dirSchema).optional().describe(pick({ ru: 'рабочие директории', en: 'working directories' })),
    },
    summary: (args) => `Завести или изменить проект «${args.project}»`,
    details: (args) => ({
      комментарий: args.comment,
      директории: args.dirs?.map((d) => `${d.path} — ${d.comment}`),
    }),
    run: (args) => ({ data: upsertProject(args) }),
  },

  {
    name: 'project_dir_remove',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Убрать директорию проекта', en: 'Remove a project directory' }),
    description: pick({
      ru: 'Убирает рабочую директорию. Последнюю не отдаёт: сначала добавьте другую.',
      en: 'Removes a working directory. Refuses to remove the last one.',
    }),
    input: {
      project: z.string(),
      path: z.string(),
    },
    summary: (args) => `Убрать директорию «${args.path}» из проекта «${args.project}»`,
    run: (args) => ({ data: removeDir(args.project, args.path) }),
  },

  {
    name: 'project_remove',
    group: GROUP,
    everyTime: true,
    mutating: true,
    title: pick({ ru: 'Убрать проект', en: 'Remove a project' }),
    description: pick({
      ru: 'Удаляет проект с фактами и директориями. Откажет, пока есть его хосты или подключения.',
      en: 'Deletes a project with its facts and directories. Refuses while it has hosts or connections.',
    }),
    input: { project: z.string() },
    summary: (args) => `Убрать проект «${args.project}», его факты и директории из реестра`,
    run: (args) => ({ data: removeProject(args.project) }),
  },

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
      ru: 'Серверы проекта, на которые ссылаются подключения: адрес, пользователь, способ входа, '
        + 'отпечаток ключа. Алиас хоста — «проект/имя», как у подключения.',
      en: 'Project servers behind the connections: address, user, auth kind, host key fingerprint. '
        + 'A host alias is "project/name", same shape as a connection alias.',
    }),
    input: {
      project: z.string().optional().describe(pick({ ru: 'только один проект', en: 'single project only' })),
    },
    run: (args) => ({ data: { hosts: listHosts(args).map((h) => ({ ...h, usedBy: hostUsage(h.alias) })) } }),
  },

  {
    name: 'host_set',
    group: GROUP,
    everyTime: true,
    mutating: true,
    title: pick({ ru: 'Завести или изменить хост', en: 'Create or update a host' }),
    description: pick({
      ru: 'Заводит сервер проекта: адрес, пользователь, вход по паролю или ключу. Алиас — «проект/имя», '
        + 'например adzhubey/dev. Поля, которых нет во вводе, остаются прежними — сменить порт можно, '
        + 'не повторяя пароль.',
      en: 'Registers a project server: address, user, password or key auth. Alias is "project/name", '
        + 'e.g. adzhubey/dev. Omitted fields keep their previous value, so changing a port does not '
        + 'require repeating the password.',
    }),
    input: {
      alias: z.string().describe(pick({ ru: 'алиас вида project/name', en: 'alias like project/name' })),
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
    // Хост живёт в своём проекте, но пользуются им и подключения других проектов:
    // правка кредов задевает их все, поэтому разрешение спрашивается у каждого.
    projects: (args) => hostProjects(args.alias),
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
    projects: (args) => hostProjects(args.alias),
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
        + 'Один сервер держит сколько угодно подключений.',
      en: 'Registers an entry point on top of a host: shell, files, docker or db. Alias is "project/name". '
        + 'One server can carry any number of connections.',
    }),
    input: {
      alias: z.string().describe(pick({ ru: 'project/name', en: 'project/name' })),
      kind: z.enum(KINDS).optional(),
      host: z.string().nullable().optional().describe(pick({
        ru: 'алиас хоста вида project/name; null — ходить напрямую по сети',
        en: 'host alias like project/name; null means direct network access',
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
    // Поле value секретно целиком только здесь: у notes_set так зовётся значение факта.
    secretArgs: ['value'],
    title: pick({ ru: 'Положить секрет', en: 'Store a secret' }),
    description: pick({
      ru: 'Кладёт пароль, приватный ключ или парольную фразу в реестр. Значение шифруется и наружу '
        + 'не возвращается никогда — ни этим инструментом, ни любым другим. На сервер его потом '
        + 'кладут ссылкой cr://secret/<алиас>#<вид> в ssh_exec (stdin) или files_put (content).',
      en: 'Stores a password, private key or passphrase. The value is encrypted and never returned by '
        + 'this or any other tool. Later it goes to a server as a cr://secret/<alias>#<kind> reference '
        + 'in ssh_exec (stdin) or files_put (content).',
    }),
    input: {
      target: z.enum(['host', 'connection']),
      alias: z.string(),
      kind: z.enum(['password', 'private_key', 'passphrase']),
      value: z.string(),
    },
    summary: (args) => `Положить секрет (${args.kind}) для ${args.target === 'host' ? 'хоста' : 'подключения'} «${args.alias}»`,
    run: (args) => {
      if (isSecretRef(args.value)) {
        throw new Error('secret_set принимает само значение: перекладывать секрет из реестра в реестр незачем');
      }

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
