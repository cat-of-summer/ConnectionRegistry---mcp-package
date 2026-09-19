import { db } from './db.js';
import { readSecret } from './crypto.js';
import { getConnectionRow } from './connections.js';
import { effectivePort } from './connections.js';

// Единственное место, где секреты превращаются в открытый текст. Всё, что выше
// уровнем — инструменты, HTTP, журнал, — работает с результатом транспорта, а не
// с кредами: чтобы утечь, секрету пришлось бы пройти отсюда наружу явной строкой.

export function resolve(alias) {
  const row = getConnectionRow(alias);
  if (!row) {
    const known = db().prepare('SELECT alias FROM connections ORDER BY alias LIMIT 20').all().map((r) => r.alias);
    const err = new Error(`подключение «${alias}» не заведено${known.length ? `. Есть: ${known.join(', ')}` : ''}`);
    err.code = 'unknown_alias';
    throw err;
  }

  const hostRow = row.host_id ? db().prepare('SELECT * FROM hosts WHERE id = ?').get(row.host_id) : null;
  const config = JSON.parse(row.config || '{}');

  const host = hostRow
    ? {
      alias: hostRow.alias,
      address: hostRow.address,
      port: hostRow.port,
      username: hostRow.username,
      authKind: hostRow.auth_kind,
      hostKey: hostRow.host_key_fp,
      hostKeyStatus: hostRow.host_key_status,
      // Ленивое чтение: метаданные подключения смотрят и без мастер-ключа,
      // расшифровка происходит только когда дело дошло до соединения.
      secret: () => readSecret(hostRow.secret_id),
      passphrase: () => readSecret(hostRow.passphrase_id),
    }
    : null;

  return {
    alias,
    kind: row.kind,
    project: row.project,
    config,
    host,
    port: effectivePort(row.kind, config, hostRow),
    confirm: row.confirm_policy,
    // Пароль самого подключения: база, ftp
    secret: () => readSecret(row.secret_id),
    hasSecret: Boolean(row.secret_id),
  };
}

/** Значения, которые надо вычистить из вывода перед записью в журнал и ответом агенту. */
export function secretValues(resolved) {
  const values = [];
  for (const get of [resolved.secret, resolved.host?.secret, resolved.host?.passphrase]) {
    if (typeof get !== 'function') continue;
    try {
      const value = get();
      if (value && String(value).length >= 4) values.push(String(value));
    } catch { /* заперт или секрета нет — вычищать нечего */ }
  }
  return values;
}
