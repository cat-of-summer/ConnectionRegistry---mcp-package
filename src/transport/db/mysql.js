import mysql from 'mysql2/promise';

export async function open({ host, port, database, username, password, ssl }) {
  return mysql.createConnection({
    host,
    port,
    database,
    user: username,
    password: password || undefined,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 15_000,
    multipleStatements: false,
    dateStrings: true,
  });
}

export async function query(connection, sql, params = []) {
  const [rows, fields] = await connection.query({ sql, values: params, rowsAsArray: true });

  // INSERT/UPDATE возвращают не таблицу, а сводку — приводим к одному виду.
  if (!Array.isArray(fields) || fields === undefined) {
    return [{ columns: [], rows: [], rowCount: rows?.affectedRows ?? 0, command: null }];
  }

  return [{
    columns: (fields || []).map((f) => f.name),
    rows: Array.isArray(rows) ? rows : [],
    rowCount: Array.isArray(rows) ? rows.length : (rows?.affectedRows ?? 0),
    command: null,
  }];
}

export const TABLES_SQL = `
  SELECT table_schema AS \`schema\`, table_name AS name, table_type AS type
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
  ORDER BY table_name`;

export const COLUMNS_SQL = `
  SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS default_value
  FROM information_schema.columns
  WHERE table_name = ? AND table_schema = DATABASE()
  ORDER BY ordinal_position`;

export function dumpArgv({ host, port, database, username }, { table, schemaOnly, dataOnly } = {}) {
  const argv = ['mysqldump', '--single-transaction', '--skip-lock-tables', '--no-tablespaces', '-h', host, '-P', String(port), '-u', username];
  if (schemaOnly) argv.push('--no-data');
  if (dataOnly) argv.push('--no-create-info');
  argv.push(database);
  if (table) argv.push(table);
  return argv;
}
