import { db, now } from './db.js';
import { replaceSecret, dropSecret } from './crypto.js';
import { getHostRow, publicHost } from './hosts.js';
import { assertAlias, normalizeConfig, KINDS, CONFIRM_POLICIES, DEFAULT_DB_PORT, DEFAULT_FILE_PORT } from './schema.js';

export function publicConnection(row, { host } = {}) {
  if (!row) return null;
  const config = JSON.parse(row.config || '{}');
  return {
    alias: row.alias,
    project: row.project,
    kind: row.kind,
    host: host ? host.alias : null,
    config,
    hasSecret: Boolean(row.secret_id),
    confirm: row.confirm_policy,
    note: row.note || null,
    updatedAt: row.updated_at,
  };
}

export function listConnections({ project, kind } = {}) {
  const where = [];
  const args = {};
  if (project) { where.push('c.project = @project'); args.project = project; }
  if (kind) { where.push('c.kind = @kind'); args.kind = kind; }
  const sql = `SELECT c.*, h.alias AS host_alias FROM connections c
               LEFT JOIN hosts h ON h.id = c.host_id
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY c.alias`;
  return db().prepare(sql).all(args).map((row) => publicConnection(row, { host: row.host_alias ? { alias: row.host_alias } : null }));
}

export function getConnectionRow(alias) {
  return db().prepare('SELECT * FROM connections WHERE alias = ?').get(alias) || null;
}

export function getConnection(alias) {
  const row = getConnectionRow(alias);
  if (!row) return null;
  const host = row.host_id ? db().prepare('SELECT * FROM hosts WHERE id = ?').get(row.host_id) : null;
  return { ...publicConnection(row, { host }), hostInfo: host ? publicHost(host) : null };
}

export function projects() {
  const fromConnections = db().prepare('SELECT DISTINCT project FROM connections').all().map((r) => r.project);
  const fromFacts = db().prepare('SELECT DISTINCT project FROM notes_facts').all().map((r) => r.project);
  const fromText = db().prepare('SELECT project FROM notes_text').all().map((r) => r.project);
  return [...new Set([...fromConnections, ...fromFacts, ...fromText])].sort();
}

export function upsertConnection(input) {
  const alias = assertAlias(input.alias);
  const project = alias.split('/')[0];
  const existing = getConnectionRow(alias);

  const kind = input.kind ?? existing?.kind;
  if (!KINDS.includes(kind)) {
    throw new Error(`тип подключения «${kind}» неизвестен, ожидается один из: ${KINDS.join(', ')}`);
  }

  const mergedConfig = { ...(existing ? JSON.parse(existing.config) : {}), ...(input.config ?? {}) };
  const config = normalizeConfig(kind, mergedConfig);

  let hostRow = null;
  if (input.host === null) {
    hostRow = null;
  } else if (input.host !== undefined) {
    hostRow = getHostRow(input.host);
    if (!hostRow) throw new Error(`хост «${input.host}» не заведён`);
  } else if (existing?.host_id) {
    hostRow = db().prepare('SELECT * FROM hosts WHERE id = ?').get(existing.host_id);
  }

  let secretId = existing?.secret_id ?? null;
  if (input.password !== undefined) {
    secretId = input.password === ''
      ? (dropSecret(secretId), null)
      : replaceSecret(secretId, 'password', input.password);
  }

  const confirm = input.confirm ?? existing?.confirm_policy ?? 'inherit';
  if (!CONFIRM_POLICIES.includes(confirm)) {
    throw new Error(`политика подтверждения «${confirm}» неизвестна, ожидается: ${CONFIRM_POLICIES.join(', ')}`);
  }

  checkReachability(kind, config, hostRow, secretId);

  const ts = now();
  const row = {
    alias,
    project,
    kind,
    host_id: hostRow ? hostRow.id : null,
    config: JSON.stringify(config),
    secret_id: secretId,
    confirm_policy: confirm,
    note: input.note ?? existing?.note ?? null,
    updated_at: ts,
  };

  if (existing) {
    db().prepare(`UPDATE connections SET project = @project, kind = @kind, host_id = @host_id,
      config = @config, secret_id = @secret_id, confirm_policy = @confirm_policy, note = @note,
      updated_at = @updated_at WHERE alias = @alias`).run(row);
  } else {
    db().prepare(`INSERT INTO connections (alias, project, kind, host_id, config, secret_id, confirm_policy, note,
      created_at, updated_at)
      VALUES (@alias, @project, @kind, @host_id, @config, @secret_id, @confirm_policy, @note, @created_at, @updated_at)`)
      .run({ ...row, created_at: ts });
  }

  return getConnection(alias);
}

// Подключение без хоста ходит по сети напрямую — значит адрес обязан быть задано явно.
// Поймать это при заведении дешевле, чем через месяц на боевом сервере.
function checkReachability(kind, config, hostRow, secretId) {
  if (kind === 'shell' || kind === 'docker') {
    if (!hostRow) throw new Error(`подключению типа «${kind}» нужен хост: команды выполняются по SSH`);
    return;
  }

  if (kind === 'files') {
    if (config.proto === 'sftp' && !hostRow) throw new Error('sftp работает поверх хоста — укажите host');
    if (config.proto !== 'sftp' && !config.address && !hostRow) {
      throw new Error('для ftp/ftps укажите address или привяжите хост');
    }
    if (config.proto !== 'sftp' && config.username && !secretId) {
      throw new Error('для входа на ftp нужен пароль');
    }
    return;
  }

  if (kind === 'db') {
    if (!hostRow && (config.address === '127.0.0.1' || config.address === 'localhost')) {
      throw new Error('без хоста 127.0.0.1 указывает на сам контейнер реестра: привяжите host или задайте адрес базы');
    }
    if (!config.database) throw new Error('у подключения к базе должно быть имя базы');
    if (!config.username) throw new Error('у подключения к базе должен быть пользователь');
  }
}

export function removeConnection(alias) {
  const row = getConnectionRow(alias);
  if (!row) throw new Error(`подключение «${alias}» не найдено`);
  db().transaction(() => {
    db().prepare('DELETE FROM connections WHERE id = ?').run(row.id);
    dropSecret(row.secret_id);
  })();
  return { alias, removed: true };
}

export function effectivePort(kind, config, hostRow) {
  if (kind === 'db') return config.port || DEFAULT_DB_PORT[config.engine];
  if (kind === 'files') return config.port || DEFAULT_FILE_PORT[config.proto] || hostRow?.port || 22;
  return hostRow?.port || 22;
}
