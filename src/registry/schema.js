import { z } from 'zod';

export const KINDS = ['shell', 'files', 'docker', 'db'];
export const AUTH_KINDS = ['password', 'key', 'agent'];
export const DB_ENGINES = ['postgres', 'mysql', 'mariadb'];
export const FILE_PROTOCOLS = ['sftp', 'ftp', 'ftps'];

// Алиас подключения — всегда `проект/точка входа`: проект слева заодно служит
// ключом заметок, поэтому одно имя описывает и доступ, и знание о нём.
export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
export const HOST_ALIAS_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const PROJECT_RE = HOST_ALIAS_RE;

export function assertAlias(alias) {
  if (!ALIAS_RE.test(String(alias || ''))) {
    throw new Error(`алиас подключения должен быть вида «проект/точка», строчными: получено «${alias}»`);
  }
  return alias;
}

export function assertHostAlias(alias) {
  if (!HOST_ALIAS_RE.test(String(alias || ''))) {
    throw new Error(`алиас хоста — одно слово строчными буквами: получено «${alias}»`);
  }
  return alias;
}

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
  database: z.string(),
  username: z.string(),
  ssl: z.boolean().optional(),
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
