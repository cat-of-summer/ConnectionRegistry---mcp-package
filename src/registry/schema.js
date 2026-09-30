import { z } from 'zod';

export const KINDS = ['shell', 'files', 'docker', 'db'];
export const AUTH_KINDS = ['password', 'key', 'agent'];
export const DB_ENGINES = ['postgres', 'mysql', 'mariadb'];
export const FILE_PROTOCOLS = ['sftp', 'ftp', 'ftps'];

// Алиас всегда `проект/имя` — и у подключения, и у хоста: проект слева служит
// ключом заметок и границей разрешений, поэтому одно имя описывает и доступ,
// и знание о нём. Хост живёт в проекте: «adzhubey/dev», «adzhubey/prod».
export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const projectOf = (alias) => String(alias || '').split('/')[0] || null;

export function assertAlias(alias) {
  if (!ALIAS_RE.test(String(alias || ''))) {
    throw new Error(`алиас подключения должен быть вида «проект/точка», строчными: получено «${alias}»`);
  }
  return alias;
}

export function assertHostAlias(alias) {
  if (!ALIAS_RE.test(String(alias || ''))) {
    throw new Error(`алиас хоста должен быть вида «проект/имя», строчными: получено «${alias}»`);
  }
  return alias;
}

export const CREDENTIAL_FORMATS = ['php', 'env', 'json'];

// Реквизиты в конфиге приложения на сервере: реестр читает их сам, по SSH, и значение не
// проходит через агента. key — путь по точкам: у php «db.default» значит $db['default']
// после include, пусто — то, что include вернул (конфиг Laravel). fields — какое поле
// источника куда ложится: password — в секрет подключения, остальное — в его config.
// from — хост, где лежит файл, если не на хосте самого подключения (ftp без хоста).
export const CREDENTIAL_TARGETS = ['password', 'username', 'database', 'address', 'port'];

export const credentialsSchema = z.object({
  path: z.string(),
  format: z.enum(CREDENTIAL_FORMATS),
  key: z.string().optional(),
  from: z.string().optional(),
  fields: z.object(Object.fromEntries(CREDENTIAL_TARGETS.map((k) => [k, z.string().optional()]))).strict().optional(),
  live: z.boolean().optional(),
}).strict();

const shell = z.object({
  cwd: z.string().optional(),
  shell: z.string().optional(),
}).strict();

const files = z.object({
  proto: z.enum(FILE_PROTOCOLS).default('sftp'),
  root: z.string().optional(),
  // ftp/ftps живут своим адресом и логином: FTP-сервер редко совпадает с SSH-входом
  address: z.string().optional(),
  port: z.number().int().positive().optional(),
  username: z.string().optional(),
  secure: z.boolean().optional(),
  credentials: credentialsSchema.optional(),
  readonly: z.boolean().optional(),
}).strict();

const docker = z.object({
  container: z.string().optional(),
  composeFile: z.string().optional(),
  workdir: z.string().optional(),
  sudo: z.boolean().optional(),
}).strict();

const database = z.object({
  engine: z.enum(DB_ENGINES),
  // Адрес со стороны хоста: при туннеле это 127.0.0.1 самого сервера
  address: z.string().default('127.0.0.1'),
  port: z.number().int().positive().optional(),
  // Без источника реквизитов оба обязательны — это проверяет connections.js
  database: z.string().optional(),
  username: z.string().optional(),
  ssl: z.boolean().optional(),
  credentials: credentialsSchema.optional(),
  // tunnel — драйвер реестра через SSH-проброс; exec — консольный клиент на самом сервере,
  // для хостингов, где проброс закрыт.
  via: z.enum(['tunnel', 'exec']).optional(),
  // Только чтение у самого подключения — для базы без хоста (облако), где флагу хоста
  // негде жить. С хостом работает и флаг хоста; достаточно любого из двух.
  readonly: z.boolean().optional(),
}).strict();

const BY_KIND = { shell, files, docker, db: database };

export const DEFAULT_DB_PORT = { postgres: 5432, mysql: 3306, mariadb: 3306 };
export const DEFAULT_FILE_PORT = { sftp: 22, ftp: 21, ftps: 21 };

export function normalizeConfig(kind, config = {}) {
  const schema = BY_KIND[kind];
  if (!schema) throw new Error(`неизвестный тип подключения «${kind}», ожидается один из: ${KINDS.join(', ')}`);
  const parsed = schema.safeParse(config ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
    throw new Error(`настройки подключения типа «${kind}» не приняты — ${problems}`);
  }
  return parsed.data;
}
