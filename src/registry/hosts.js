import { db, now } from './db.js';
import { putSecret, replaceSecret, dropSecret } from './crypto.js';
import { assertHostAlias, projectOf, AUTH_KINDS } from './schema.js';
import { requireProject } from './projects.js';

// Наружу уходит только это представление: ни одного поля, по которому можно
// восстановить секрет. Отпечаток хост-ключа — публичная величина, он остаётся.
export function publicHost(row) {
  if (!row) return null;
  return {
    alias: row.alias,
    project: row.project,
    address: row.address,
    port: row.port,
    user: row.username,
    auth: row.auth_kind,
    hasSecret: Boolean(row.secret_id),
    hostKey: row.host_key_fp || null,
    hostKeyStatus: row.host_key_status,
    note: row.note || null,
    updatedAt: row.updated_at,
  };
}

export function listHosts({ project } = {}) {
  const sql = `SELECT * FROM hosts ${project ? 'WHERE project = @project' : ''} ORDER BY alias`;
  return db().prepare(sql).all(project ? { project } : {}).map(publicHost);
}

/** Проекты, которым хост нужен: его собственный и те, чьи подключения на него ссылаются. */
export function hostProjects(alias) {
  const row = getHostRow(alias);
  if (!row) return [projectOf(alias)].filter(Boolean);

  const used = db().prepare('SELECT DISTINCT project FROM connections WHERE host_id = ? ORDER BY project')
    .all(row.id).map((r) => r.project);
  return [...new Set([row.project, ...used])].filter(Boolean);
}

export function getHostRow(alias) {
  return db().prepare('SELECT * FROM hosts WHERE alias = ?').get(alias) || null;
}

export function getHost(alias) {
  return publicHost(getHostRow(alias));
}

export function hostUsage(alias) {
  const row = getHostRow(alias);
  if (!row) return [];
  return db().prepare('SELECT alias FROM connections WHERE host_id = ? ORDER BY alias').all(row.id).map((r) => r.alias);
}

/**
 * Заводит или правит хост. Поля, которых нет во входе, остаются прежними —
 * «сменить порт» не должно требовать повторять пароль.
 */
export function upsertHost(input) {
  const alias = assertHostAlias(input.alias);
  requireProject(projectOf(alias));
  const existing = getHostRow(alias);

  const authKind = input.auth ?? existing?.auth_kind ?? (input.privateKey ? 'key' : 'password');
  if (!AUTH_KINDS.includes(authKind)) {
    throw new Error(`способ входа «${authKind}» неизвестен, ожидается один из: ${AUTH_KINDS.join(', ')}`);
  }

  let secretId = existing?.secret_id ?? null;
  if (input.privateKey !== undefined) {
    secretId = replaceSecret(secretId, 'private_key', input.privateKey);
  } else if (input.password !== undefined) {
    secretId = replaceSecret(secretId, 'password', input.password);
  }

  let passphraseId = existing?.passphrase_id ?? null;
  if (input.passphrase !== undefined) {
    passphraseId = input.passphrase === ''
      ? (dropSecret(passphraseId), null)
      : replaceSecret(passphraseId, 'passphrase', input.passphrase);
  }

  const ts = now();
  const row = {
    alias,
    project: projectOf(alias),
    address: input.address ?? existing?.address,
    port: input.port ?? existing?.port ?? 22,
    username: input.user ?? existing?.username,
    auth_kind: authKind,
    secret_id: secretId,
    passphrase_id: passphraseId,
    host_key_fp: input.hostKey ?? existing?.host_key_fp ?? null,
    host_key_status: input.hostKey ? 'pinned' : (existing?.host_key_status ?? 'pending'),
    note: input.note ?? existing?.note ?? null,
    updated_at: ts,
  };

  if (!row.address) throw new Error('у хоста должен быть адрес');
  if (!row.username) throw new Error('у хоста должен быть пользователь');
  if (authKind !== 'agent' && !secretId) {
    throw new Error(`для входа «${authKind}» нужен секрет: пароль или приватный ключ`);
  }

  if (existing) {
    db().prepare(`UPDATE hosts SET project = @project, address = @address, port = @port, username = @username,
      auth_kind = @auth_kind, secret_id = @secret_id, passphrase_id = @passphrase_id,
      host_key_fp = @host_key_fp, host_key_status = @host_key_status, note = @note,
      updated_at = @updated_at WHERE alias = @alias`).run(row);
  } else {
    db().prepare(`INSERT INTO hosts (alias, project, address, port, username, auth_kind, secret_id, passphrase_id,
      host_key_fp, host_key_status, note, created_at, updated_at)
      VALUES (@alias, @project, @address, @port, @username, @auth_kind, @secret_id, @passphrase_id,
      @host_key_fp, @host_key_status, @note, @created_at, @updated_at)`).run({ ...row, created_at: ts });
  }

  return getHost(alias);
}

export function pinHostKey(alias, fingerprint) {
  const res = db().prepare('UPDATE hosts SET host_key_fp = ?, host_key_status = ?, updated_at = ? WHERE alias = ?')
    .run(fingerprint, 'pinned', now(), alias);
  if (res.changes === 0) throw new Error(`хост «${alias}» не найден`);
  return getHost(alias);
}

export function removeHost(alias) {
  const row = getHostRow(alias);
  if (!row) throw new Error(`хост «${alias}» не найден`);

  const used = hostUsage(alias);
  if (used.length) {
    throw new Error(`на хост «${alias}» ссылаются подключения: ${used.join(', ')}. Сначала уберите их`);
  }

  db().transaction(() => {
    db().prepare('DELETE FROM hosts WHERE id = ?').run(row.id);
    dropSecret(row.secret_id);
    dropSecret(row.passphrase_id);
  })();

  return { alias, removed: true };
}
