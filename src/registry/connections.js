import { db, now } from './db.js';
import { replaceSecret, dropSecret, readSecret } from './crypto.js';
import { getHostRow, publicHost } from './hosts.js';
import { assertAlias, normalizeConfig, KINDS, DEFAULT_DB_PORT, DEFAULT_FILE_PORT, CREDENTIAL_TARGETS } from './schema.js';
import { requireProject } from './projects.js';

export { projects } from './projects.js';

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

export function upsertConnection(input) {
  const alias = assertAlias(input.alias);
  const project = requireProject(alias.split('/')[0]);
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

  // Пустой пароль снимает секрет. Удаляется он после записи строки: пока подключение на
  // него ссылается, внешний ключ удалить не даст.
  let secretId = existing?.secret_id ?? null;
  let orphan = null;
  if (input.password !== undefined) {
    if (input.password === '') [orphan, secretId] = [secretId, null];
    else secretId = replaceSecret(secretId, 'password', input.password);
  }

  checkReachability(kind, config, hostRow, secretId, project);

  const ts = now();
  const row = {
    alias,
    project,
    kind,
    host_id: hostRow ? hostRow.id : null,
    config: JSON.stringify(config),
    secret_id: secretId,
    note: input.note ?? existing?.note ?? null,
    updated_at: ts,
  };

  if (existing) {
    db().prepare(`UPDATE connections SET project = @project, kind = @kind, host_id = @host_id,
      config = @config, secret_id = @secret_id, note = @note,
      updated_at = @updated_at WHERE alias = @alias`).run(row);
  } else {
    db().prepare(`INSERT INTO connections (alias, project, kind, host_id, config, secret_id, note,
      created_at, updated_at)
      VALUES (@alias, @project, @kind, @host_id, @config, @secret_id, @note, @created_at, @updated_at)`)
      .run({ ...row, created_at: ts });
  }
  dropSecret(orphan);

  return getConnection(alias);
}

// Подключение без хоста ходит по сети напрямую — значит адрес обязан быть задано явно.
// Поймать это при заведении дешевле, чем через месяц на боевом сервере.
function checkReachability(kind, config, hostRow, secretId, project) {
  const creds = config.credentials;
  if (creds) {
    const uploaded = creds.path.startsWith('cr://uploads/');
    if (uploaded && creds.live) {
      throw new Error('загруженный файл после импорта удаляется — live с ним невозможен, импортируйте заново');
    }
    if (uploaded && creds.format === 'php') {
      throw new Error('php-конфиг исполняется на сервере — загруженный файл годится только для env и json');
    }
    if (!uploaded && !hostRow && !creds.from) {
      throw new Error('реквизиты читаются с сервера по SSH — привяжите host, укажите credentials.from '
        + 'или загрузите файл на /upload и дайте путь cr://uploads/…');
    }
    if (creds.from && creds.from.split('/')[0] !== project) {
      throw new Error(`credentials.from «${creds.from}» — хост чужого проекта`);
    }
    if (kind === 'files' && config.proto === 'sftp') {
      throw new Error('sftp входит с кредами хоста — источник реквизитов нужен только ftp/ftps');
    }
    if (kind === 'files' && !creds.fields?.password) {
      throw new Error('для ftp укажите, в каком поле источника пароль: credentials.fields.password');
    }
    if (kind === 'files' && creds.fields?.database) {
      throw new Error('у ftp нет имени базы — уберите credentials.fields.database');
    }
  }

  if (kind === 'shell' || kind === 'docker') {
    if (!hostRow) throw new Error(`подключению типа «${kind}» нужен хост: команды выполняются по SSH`);
    return;
  }

  if (kind === 'files') {
    if (config.proto === 'sftp' && !hostRow) throw new Error('sftp работает поверх хоста — укажите host');
    if (config.proto !== 'sftp' && !config.address && !hostRow) {
      throw new Error('для ftp/ftps укажите address или привяжите хост');
    }
    if (config.proto !== 'sftp' && config.username && !secretId && !creds) {
      throw new Error('для входа на ftp нужен пароль');
    }
    return;
  }

  if (kind === 'db') {
    if (!hostRow && (config.address === '127.0.0.1' || config.address === 'localhost')) {
      throw new Error('без хоста 127.0.0.1 указывает на сам контейнер реестра: привяжите host или задайте адрес базы');
    }
    if (config.via === 'exec' && !hostRow) {
      throw new Error('via: exec выполняет клиент базы на сервере — привяжите host');
    }
    // Источник реквизитов даёт имя базы и пользователя сам — при импорте или на каждом соединении.
    if (creds) return;
    if (!config.database) throw new Error('у подключения к базе должно быть имя базы');
    if (!config.username) throw new Error('у подключения к базе должен быть пользователь');
  }
}

/**
 * Кладёт реквизиты, прочитанные с сервера: пароль — в секрет подключения, остальное
 * (username, database, address, port) — в config. Пишет только изменившееся и говорит,
 * что именно. Возвращает и несекретную часть config — для ответа агенту.
 */
export function applyCredentials(alias, values) {
  const row = getConnectionRow(alias);
  if (!row) throw new Error(`подключение «${alias}» не заведено`);

  const config = JSON.parse(row.config || '{}');
  const changed = [];
  let secretId = row.secret_id;

  const stored = row.secret_id ? readSecret(row.secret_id) : null;
  if (values.password != null && values.password !== stored) {
    secretId = replaceSecret(row.secret_id, 'password', values.password);
    changed.push('password');
  }
  for (const field of CREDENTIAL_TARGETS) {
    if (field === 'password' || values[field] == null) continue;
    if (values[field] !== config[field]) {
      config[field] = values[field];
      changed.push(field);
    }
  }

  if (changed.length) {
    normalizeConfig(row.kind, config);
    db().prepare('UPDATE connections SET config = ?, secret_id = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), secretId, now(), row.id);
  }

  const visible = Object.fromEntries(CREDENTIAL_TARGETS.filter((f) => f !== 'password' && config[f] != null).map((f) => [f, config[f]]));
  return { changed, config: visible };
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
