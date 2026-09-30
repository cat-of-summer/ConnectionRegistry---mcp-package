import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { cfg } from '../../config.js';
import * as tunnel from '../tunnel.js';
import * as credentials from '../credentials.js';
import * as pg from './pg.js';
import * as mysql from './mysql.js';
import * as remote from './remote.js';
import { classify } from './sql.js';

const DRIVERS = { postgres: pg, mysql, mariadb: mysql };

function driverOf(resolved) {
  const driver = DRIVERS[resolved.config.engine];
  if (!driver) throw new Error(`движок «${resolved.config.engine}» не поддержан`);
  return driver;
}

const onServer = (resolved) => resolved.config.via === 'exec';

/** Флаг «только для чтения» — на хосте или на самом подключении (база в облаке без хоста). */
export const flaggedReadonly = (resolved) => Boolean(resolved.host?.readonly || resolved.config.readonly);

/**
 * Открывает канал до базы и гарантированно закрывает его. Два пути с одним интерфейсом:
 * драйвер реестра через SSH-туннель (или напрямую) либо консольный клиент на самом
 * сервере — via: exec, для хостингов, где проброс закрыт. fn получает { client, driver }
 * и не знает, какой из них ему достался.
 */
export async function withDb(resolved, { approveHostKey, addSecret, readOnly = false } = {}, fn) {
  const creds = await credentials.current(resolved, { approveHostKey, addSecret });
  if (!creds.database) throw new Error(`у «${resolved.alias}» не задано имя базы`);
  if (!creds.username) throw new Error(`у «${resolved.alias}» не задан пользователь базы`);

  const port = creds.port || resolved.port;
  const withWarning = (res) => (creds.warning && res && typeof res === 'object'
    ? { ...res, warning: [res.warning, creds.warning].filter(Boolean).join('; ') }
    : res);

  if (onServer(resolved)) {
    const endpoint = {
      host: creds.address || '127.0.0.1',
      port,
      database: creds.database,
      username: creds.username,
      password: creds.password,
      readOnly,
    };
    const client = await remote.open(resolved, endpoint, { approveHostKey, timeoutMs: cfg.execTimeoutMs });
    const via = `${resolved.host.alias}: ${resolved.config.engine === 'postgres' ? 'psql' : 'mysql'} на сервере`;
    return withWarning(await fn({ client, driver: remote.driverFor(resolved.config.engine), endpoint, via, remote: true }));
  }

  const driver = driverOf(resolved);
  const target = { ...resolved, config: { ...resolved.config, address: creds.address || resolved.config.address }, port };
  const channel = await tunnel.open(target, { approveHostKey });

  const endpoint = {
    host: channel.host,
    port: channel.port,
    database: creds.database,
    username: creds.username,
    password: creds.password,
    ssl: resolved.config.ssl,
    // Клиентский таймаут запрос не отменяет: без серверного потолка «отвалившийся» UPDATE
    // докатывается и коммитится сам, когда клиент давно отчитался об ошибке.
    statementTimeoutMs: cfg.execTimeoutMs,
    // Читающий вызов на помеченном подключении идёт в сессии только для чтения: ошибись
    // разбор SQL (select nextval(), функция с записью) — сервер откажет сам.
    readOnly,
  };

  let client = null;
  try {
    client = await driver.open(endpoint);
    const via = channel.direct ? 'напрямую' : channel.via;
    return withWarning(await fn({ client, driver, endpoint, via, remote: false }));
  } finally {
    try { await client?.end?.(); } catch { /* уже закрыт */ }
    await channel.close();
  }
}

export async function query(resolved, sql, { params = [], maxRows = cfg.dbMaxRows, approveHostKey, addSecret } = {}) {
  const readOnly = flaggedReadonly(resolved) && classify(sql).readonly;
  return withDb(resolved, { approveHostKey, addSecret, readOnly }, async ({ client, driver, via }) => {
    const results = await driver.query(client, sql, params);
    return {
      via,
      results: results.map((res) => ({
        columns: res.columns,
        rows: res.rows.slice(0, maxRows).map(serializeRow),
        rowCount: res.rowCount,
        truncated: res.rows.length > maxRows,
        command: res.command,
      })),
    };
  });
}

// Дата, буфер и bigint в JSON уходят по-разному у разных драйверов. Приводим сами,
// иначе один и тот же столбец выглядит по-разному в postgres и mysql.
function serializeRow(row) {
  return row.map((value) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `0x${value.toString('hex').slice(0, 64)}`;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object') return value;
    return value;
  });
}

export async function tables(resolved, { approveHostKey, addSecret } = {}) {
  return withDb(resolved, { approveHostKey, addSecret, readOnly: flaggedReadonly(resolved) }, async ({ client, driver, via }) => {
    const [res] = await driver.query(client, driver.TABLES_SQL, []);
    return {
      via,
      tables: res.rows.map((row) => ({ schema: row[0], name: row[1], type: row[2] })),
    };
  });
}

export async function columns(resolved, table, { schema = '', approveHostKey, addSecret } = {}) {
  return withDb(resolved, { approveHostKey, addSecret, readOnly: flaggedReadonly(resolved) }, async ({ client, driver, via }) => {
    const params = resolved.config.engine === 'postgres' ? [table, schema] : [table];
    const [res] = await driver.query(client, driver.COLUMNS_SQL, params);
    return {
      via,
      table,
      columns: res.rows.map((row) => ({ name: row[0], type: row[1], nullable: row[2] === 'YES', default: row[3] })),
    };
  });
}

/**
 * Дамп снимает штатная утилита (pg_dump / mysqldump), а не самописный обход схемы:
 * она знает про последовательности, права и порядок вставки, а мы — нет. При via: exec
 * утилита работает на сервере, а поток ложится в артефакт реестра.
 */
export async function dump(resolved, { table, schemaOnly, dataOnly, outFile, approveHostKey, addSecret, secrets = [] } = {}) {
  return withDb(resolved, { approveHostKey, addSecret }, async ({ client, driver, endpoint, via, remote: onHost }) => {
    const argv = driver.dumpArgv(endpoint, { table, schemaOnly, dataOnly });

    if (onHost) {
      const res = await remote.dump(client, argv, { outFile, secrets });
      return { via, file: outFile, bytes: res.bytes, command: argv[0], warning: res.warning };
    }

    const env = { ...process.env };
    if (endpoint.password) {
      if (resolved.config.engine === 'postgres') env.PGPASSWORD = endpoint.password;
      else env.MYSQL_PWD = endpoint.password;
    }
    if (resolved.config.ssl && resolved.config.engine === 'postgres') env.PGSSLMODE = 'require';

    const out = fs.createWriteStream(outFile);
    const child = spawn(argv[0], argv.slice(1), { env });
    child.stdout.pipe(out);

    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    await new Promise((resolve) => out.end(resolve));

    const message = Buffer.concat(stderr).toString('utf8').trim();
    if (code !== 0) throw new Error(`${argv[0]} завершился с кодом ${code}: ${message || 'без сообщения'}`);

    return { via, file: outFile, bytes: fs.statSync(outFile).size, command: argv[0], warning: message || null };
  });
}
