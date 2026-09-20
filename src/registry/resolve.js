import { db } from './db.js';
import { readSecret, secretKind } from './crypto.js';
import { getConnectionRow } from './connections.js';
import { effectivePort } from './connections.js';
import { projectOf } from './schema.js';

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

/**
 * Секреты всех хостов и подключений названных проектов. Знать только креды текущего
 * подключения журналу мало: `cat .env` на одном сервере проекта показывает пароль
 * базы того же проекта, и без этого списка он лёг бы в журнал открытым текстом.
 */
export function projectSecretValues(projects = []) {
  const names = [...new Set(projects.filter(Boolean))];
  if (!names.length) return [];

  const marks = names.map(() => '?').join(', ');
  const rows = db().prepare(`
    SELECT secret_id AS id FROM hosts WHERE project IN (${marks}) AND secret_id IS NOT NULL
    UNION
    SELECT passphrase_id AS id FROM hosts WHERE project IN (${marks}) AND passphrase_id IS NOT NULL
    UNION
    SELECT secret_id AS id FROM connections WHERE project IN (${marks}) AND secret_id IS NOT NULL
  `).all(...names, ...names, ...names);

  const values = [];
  for (const row of rows) {
    try {
      const value = readSecret(row.id);
      if (value && String(value).length >= 4) values.push(String(value));
    } catch { /* заперт — вычищать нечего */ }
  }
  return values;
}

export const SECRET_REF = 'cr://secret/';
export const SECRET_REF_KINDS = ['private_key', 'password', 'passphrase'];

export const isSecretRef = (value) => typeof value === 'string' && value.trim().startsWith(SECRET_REF);

function secretIdFor(alias, kind) {
  const host = db().prepare('SELECT * FROM hosts WHERE alias = ?').get(alias);
  if (host) return kind === 'passphrase' ? host.passphrase_id : host.secret_id;

  const conn = getConnectionRow(alias);
  if (!conn) throw new Error(`«${alias}» — нет такого хоста или подключения`);
  if (kind !== 'password') throw new Error(`у подключения бывает только пароль; ключ и фраза живут на хосте`);
  return conn.secret_id;
}

/**
 * Разворачивает `cr://secret/<алиас>#<вид>` в значение. Это единственный способ
 * положить секрет на сервер, не пронося его через агента: значение подставляется
 * здесь, после подтверждения, а в журнал и в диалог человеку уходит ссылка.
 *
 * Секрет берётся только из того же проекта, что и алиас вызова. Иначе доступ к
 * одному проекту давал бы возможность разложить по своим серверам ключи чужого.
 */
export function readSecretRef(ref, { project } = {}) {
  const rest = String(ref).trim().slice(SECRET_REF.length);
  const hash = rest.indexOf('#');
  if (hash < 0) {
    throw new Error(`ссылка «${ref}» без вида секрета: нужно cr://secret/<алиас>#${SECRET_REF_KINDS.join('|')}`);
  }

  const alias = rest.slice(0, hash);
  const kind = rest.slice(hash + 1);

  if (!SECRET_REF_KINDS.includes(kind)) {
    throw new Error(`вида секрета «${kind}» не бывает; есть: ${SECRET_REF_KINDS.join(', ')}`);
  }
  if (project && projectOf(alias) !== project) {
    throw new Error(
      `«${alias}» — секрет чужого проекта: подставить можно только секрет проекта «${project}»`,
    );
  }

  const id = secretIdFor(alias, kind);
  if (!id) throw new Error(`у «${alias}» не заведён секрет вида «${kind}» — положите его через secret_set`);

  const stored = secretKind(id);
  if (stored !== kind) throw new Error(`у «${alias}» под этим именем лежит «${stored}», а не «${kind}»`);

  const value = readSecret(id);
  if (!value) throw new Error(`секрет «${alias}#${kind}» не читается`);
  return value;
}
