import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { cfg } from '../../config.js';
import * as tunnel from '../tunnel.js';
import * as pg from './pg.js';
import * as mysql from './mysql.js';

const DRIVERS = { postgres: pg, mysql, mariadb: mysql };

function driverOf(resolved) {
  const driver = DRIVERS[resolved.config.engine];
  if (!driver) throw new Error(`движок «${resolved.config.engine}» не поддержан`);
  return driver;
}

/** Открывает канал до базы (при необходимости через SSH) и гарантированно закрывает его. */
export async function withDb(resolved, { approveHostKey } = {}, fn) {
  const driver = driverOf(resolved);
  const channel = await tunnel.open(resolved, { approveHostKey });

  const endpoint = {
    host: channel.host,
    port: channel.port,
    database: resolved.config.database,
    username: resolved.config.username,
    password: resolved.hasSecret ? resolved.secret() : null,
    ssl: resolved.config.ssl,
  };

  let client = null;
  try {
    client = await driver.open(endpoint);
    return await fn({ client, driver, endpoint, via: channel.direct ? 'напрямую' : channel.via });
  } finally {
    try { await client?.end?.(); } catch { /* уже закрыт */ }
    await channel.close();
  }
}

export async function query(resolved, sql, { params = [], maxRows = cfg.dbMaxRows, approveHostKey } = {}) {
  return withDb(resolved, { approveHostKey }, async ({ client, driver, via }) => {
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

export async function tables(resolved, { approveHostKey } = {}) {
  return withDb(resolved, { approveHostKey }, async ({ client, driver, via }) => {
    const [res] = await driver.query(client, driver.TABLES_SQL, []);
    return {
      via,
      tables: res.rows.map((row) => ({ schema: row[0], name: row[1], type: row[2] })),
    };
  });
}

export async function columns(resolved, table, { schema = '', approveHostKey } = {}) {
  return withDb(resolved, { approveHostKey }, async ({ client, driver, via }) => {
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
 * она знает про последовательности, права и порядок вставки, а мы — нет.
 */
export async function dump(resolved, { table, schemaOnly, dataOnly, outFile, approveHostKey } = {}) {
  return withDb(resolved, { approveHostKey }, async ({ driver, endpoint, via }) => {
    const argv = driver.dumpArgv(endpoint, { table, schemaOnly, dataOnly });
    const env = { ...process.env };
    if (endpoint.password) {
      if (resolved.config.engine === 'postgres') env.PGPASSWORD = endpoint.password;
      else env.MYSQL_PWD = endpoint.password;
    }

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
