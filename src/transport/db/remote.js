import { connect, exec, quote } from '../ssh.js';
import { classify } from './sql.js';
import * as pg from './pg.js';
import * as mysql from './mysql.js';

// База, до которой не дотянуть туннелем: shared-хостинг пускает по SSH, но канал проброса не
// открывает. Тогда реестр ходит к ней консольным клиентом на самом сервере — mysql или psql, —
// а не драйвером у себя. Снаружи всё то же: db_query, db_tables, db_schema, db_dump, те же
// подтверждения и тот же вид ответа.
//
// SQL едет в stdin, пароль — переменной окружения через ту же преамбулу, что у ssh_exec: ни
// в строке команды, ни в ps на сервере их нет. Параметры подставляются литералами здесь —
// у консольного клиента нет протокола подготовленных запросов.

const NULL_MARK = '__CR_NULL__';

/** Пропускает строковый литерал или комментарий с позиции i; возвращает новую позицию или -1. */
function skipQuoted(sql, i, engine) {
  const ch = sql[i];
  const two = sql.slice(i, i + 2);
  if (two === '--' || (ch === '#' && engine !== 'postgres')) {
    const end = sql.indexOf('\n', i);
    return end === -1 ? sql.length : end;
  }
  if (two === '/*') {
    const end = sql.indexOf('*/', i + 2);
    return end === -1 ? sql.length : end + 2;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === '\\' && engine !== 'postgres') { j += 2; continue; }
      if (sql[j] === ch) {
        if (sql[j + 1] === ch) { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return sql.length;
  }
  return -1;
}

/** Значение параметра как литерал SQL. */
export function literal(value, engine) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`параметр ${value} не число, которое понимает SQL`);
    return String(value);
  }
  const text = String(value);
  if (engine === 'postgres') {
    if (text.includes('\0')) throw new Error('нулевой байт в строковом параметре postgres не принимает');
    return `'${text.replace(/'/g, "''")}'`;
  }
  const escaped = text.replace(/[\0\n\r\x1a'"\\]/g, (c) => ({
    '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z', "'": "\\'", '"': '\\"', '\\': '\\\\',
  }[c]));
  return `'${escaped}'`;
}

/** Подставляет параметры на место `?` (mysql) или `$n` (postgres) вне литералов и комментариев. */
export function inline(sql, params = [], engine = 'mysql') {
  if (!params.length) return sql;
  let out = '';
  let next = 0;
  let i = 0;

  while (i < sql.length) {
    const skipped = skipQuoted(sql, i, engine);
    if (skipped >= 0) { out += sql.slice(i, skipped); i = skipped; continue; }

    if (engine === 'postgres') {
      const m = sql.slice(i).match(/^\$(\d+)/);
      if (m) {
        const n = Number(m[1]);
        if (n < 1 || n > params.length) throw new Error(`в запросе $${n}, а параметров ${params.length}`);
        out += literal(params[n - 1], engine);
        i += m[0].length;
        continue;
      }
    } else if (sql[i] === '?') {
      if (next >= params.length) throw new Error(`знаков «?» в запросе больше, чем параметров (${params.length})`);
      out += literal(params[next++], engine);
      i++;
      continue;
    }

    out += sql[i];
    i++;
  }

  if (engine !== 'postgres' && next !== params.length) {
    throw new Error(`параметров ${params.length}, а знаков «?» в запросе ${next}`);
  }
  return out;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unxml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return String.fromCodePoint(code);
    }
    return ENTITIES[name] ?? all;
  });
}

// Целые — числом, как их отдаёт драйвер; «007» и длинные — строкой, чтобы не терять цифры.
const typed = (value) => (value !== null && /^-?(0|[1-9]\d{0,14})$/.test(value) ? Number(value) : value);

/** Разбирает `mysql --xml`: он, в отличие от --batch, отличает NULL от строки «NULL». */
export function parseMysqlXml(text) {
  const sets = [];
  const setRe = /<resultset\b[^>]*?(?:\/>|>([\s\S]*?)<\/resultset>)/g;
  let set = setRe.exec(text);

  while (set) {
    const columns = [];
    const rows = [];
    const rowRe = /<row>([\s\S]*?)<\/row>/g;
    let row = rowRe.exec(set[1] || '');

    while (row) {
      const values = [];
      const fieldRe = /<field name="([^"]*)"(\s+xsi:nil="true")?\s*(?:\/>|>([\s\S]*?)<\/field>)/g;
      let field = fieldRe.exec(row[1]);
      let index = 0;
      while (field) {
        if (rows.length === 0) columns.push(unxml(field[1]));
        values.push(field[2] ? null : typed(unxml(field[3] ?? '')));
        index++;
        field = fieldRe.exec(row[1]);
      }
      rows.push(values);
      row = rowRe.exec(set[1] || '');
    }

    sets.push({ columns, rows });
    set = setRe.exec(text);
  }
  return sets;
}

/** CSV по RFC 4180 — то, что печатает `psql --csv`. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  const endCell = () => { row.push(cell); cell = ''; };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { endCell(); i++; continue; }
    if (ch === '\n' || ch === '\r') {
      endCell();
      rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== '' || row.length) { endCell(); rows.push(row); }
  return rows;
}

const PG_TAG = /^(INSERT \d+ \d+|UPDATE \d+|DELETE \d+|MERGE \d+|COPY \d+|[A-Z][A-Z ]*[A-Z])$/;

function client(engine) {
  return engine === 'postgres' ? 'psql' : 'mysql';
}

/** Команда клиента и переменная с паролем. SQL в команду не входит — он идёт в stdin. */
function command(endpoint, engine, timeoutMs) {
  if (engine === 'postgres') {
    return {
      line: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '--csv', '-P', `null=${NULL_MARK}`,
        '-h', endpoint.host, '-p', String(endpoint.port), '-U', endpoint.username, '-d', endpoint.database]
        .map(quote).join(' '),
      // Серверный потолок, как у драйвера: клиентский таймаут запрос не отменяет.
      vars: {
        ...(endpoint.password ? { PGPASSWORD: endpoint.password } : {}),
        PGOPTIONS: [
          timeoutMs ? `-c statement_timeout=${timeoutMs}` : '',
          endpoint.readOnly ? '-c default_transaction_read_only=on' : '',
        ].filter(Boolean).join(' '),
      },
    };
  }
  const line = ['mysql', '--xml', '--default-character-set=utf8mb4', '-h', endpoint.host, '-P', String(endpoint.port),
    '-u', endpoint.username, endpoint.database];
  return { line: line.map(quote).join(' '), vars: endpoint.password ? { MYSQL_PWD: endpoint.password } : {} };
}

async function run(conn, sql, { engine, readonly }) {
  const { line, vars } = command(conn.endpoint, engine, conn.timeoutMs);
  // Сколько строк задел изменяющий запрос, mysql в --xml не печатает — спрашиваем отдельно.
  const tail = engine !== 'postgres' && !readonly ? ';\nSELECT ROW_COUNT() AS affected;\n' : ';\n';
  const head = engine !== 'postgres' && conn.endpoint.readOnly ? 'SET SESSION TRANSACTION READ ONLY;\n' : '';
  const input = `${head}${sql.replace(/;\s*$/, '')}${tail}`;

  const res = await exec(conn.ssh, line, { stdin: input, vars, timeoutMs: conn.timeoutMs });
  if (res.timedOut) throw new Error(`${client(engine)} на сервере не уложился в таймаут`);
  if (res.truncated) {
    throw new Error(`ответ ${client(engine)} больше CR_MAX_OUTPUT_BYTES — сузьте выборку или снимите db_dump`);
  }
  if (res.code !== 0) {
    const message = res.stderr.trim().split('\n').filter((l) => !/Using a password/i.test(l)).join(' ').slice(0, 500);
    throw new Error(`${client(engine)} на сервере завершился с кодом ${res.code}: ${message || 'без сообщения'}`);
  }
  return res.stdout;
}

/** Результат в том же виде, что у драйверов: [{ columns, rows, rowCount, command }]. */
async function query(conn, sql, params = []) {
  const engine = conn.engine;
  const text = inline(sql, params, engine);
  const readonly = classify(text).readonly;
  const out = await run(conn, text, { engine, readonly });

  if (engine !== 'postgres') {
    const sets = parseMysqlXml(out);
    if (!readonly) {
      const affected = sets.at(-1)?.rows?.[0]?.[0];
      return [{ columns: [], rows: [], rowCount: typeof affected === 'number' ? affected : 0, command: null }];
    }
    const first = sets[0] || { columns: [], rows: [] };
    return [{ ...first, rowCount: first.rows.length, command: null }];
  }

  const lines = out.replace(/\n+$/, '').split('\n');
  let tag = null;
  if (!readonly && PG_TAG.test(lines.at(-1) || '')) tag = lines.pop();
  const table = lines.length ? parseCsv(`${lines.join('\n')}\n`) : [];
  const [head = [], ...body] = table;
  const rows = body.map((r) => r.map((v) => (v === NULL_MARK ? null : typed(v))));
  const count = tag?.match(/(\d+)$/);
  return [{
    columns: head,
    rows,
    rowCount: count ? Number(count[1]) : rows.length,
    command: tag ? tag.split(' ')[0] : null,
  }];
}

/**
 * «Соединение» с базой на сервере: SSH-клиент реестра и реквизиты. Снаружи — тот же
 * интерфейс, что у драйвера: withDb подставляет его на место mysql2 или pg.
 */
export async function open(resolved, endpoint, { approveHostKey, timeoutMs } = {}) {
  if (!resolved.host) throw new Error('режим via: exec работает через хост — привяжите host');
  const ssh = await connect(resolved.host, { approveHostKey });
  return { ssh, endpoint, engine: resolved.config.engine === 'postgres' ? 'postgres' : 'mysql', timeoutMs, end() {} };
}

export function driverFor(engine) {
  const base = engine === 'postgres' ? pg : mysql;
  return {
    query,
    TABLES_SQL: base.TABLES_SQL,
    COLUMNS_SQL: base.COLUMNS_SQL,
    dumpArgv: base.dumpArgv,
  };
}

/** Дамп на сервере: утилита пишет в stdout, реестр кладёт поток в артефакт. */
export async function dump(conn, argv, { outFile, secrets }) {
  const vars = conn.endpoint.password
    ? (conn.engine === 'postgres' ? { PGPASSWORD: conn.endpoint.password } : { MYSQL_PWD: conn.endpoint.password })
    : {};
  const res = await exec(conn.ssh, argv.map(quote).join(' '), {
    vars,
    stdoutTo: { file: outFile, secrets },
    timeoutMs: conn.timeoutMs,
  });
  const message = res.stderr.trim().split('\n').filter((l) => !/Using a password/i.test(l)).join('\n').trim();
  if (res.timedOut) throw new Error(`${argv[0]} на сервере не уложился в таймаут`);
  if (res.code !== 0) throw new Error(`${argv[0]} на сервере завершился с кодом ${res.code}: ${message || 'без сообщения'}`);
  return { bytes: res.file.bytes, sha256: res.file.sha256, warning: message || null };
}
