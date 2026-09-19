import pgLib from 'pg';

const { Client } = pgLib;

export async function open({ host, port, database, username, password, ssl }) {
  const client = new Client({
    host,
    port,
    database,
    user: username,
    password: password || undefined,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    application_name: 'connection-registry',
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  return client;
}

export async function query(client, sql, params = []) {
  const res = await client.query({ text: sql, values: params, rowMode: 'array' });
  const list = Array.isArray(res) ? res : [res];
  return list.map((r) => ({
    columns: (r.fields || []).map((f) => f.name),
    rows: r.rows || [],
    rowCount: r.rowCount ?? (r.rows ? r.rows.length : 0),
    command: r.command || null,
  }));
}

export const TABLES_SQL = `
  SELECT table_schema AS schema, table_name AS name, table_type AS type
  FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  ORDER BY table_schema, table_name`;

export const COLUMNS_SQL = `
  SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS default_value
  FROM information_schema.columns
  WHERE table_name = $1 AND ($2 = '' OR table_schema = $2)
  ORDER BY ordinal_position`;

export function dumpArgv({ host, port, database, username }, { table, schemaOnly, dataOnly } = {}) {
  const argv = ['pg_dump', '--no-owner', '--no-privileges', '-h', host, '-p', String(port), '-U', username];
  if (schemaOnly) argv.push('--schema-only');
  if (dataOnly) argv.push('--data-only');
  if (table) argv.push('-t', table);
  argv.push(database);
  return argv;
}
