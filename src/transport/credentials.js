import fs from 'node:fs';
import { connect, exec, sftp, quote } from './ssh.js';
import { resolveSource } from '../artifacts.js';
import { make as makeSftp } from './sftp.js';
import { resolveHost } from '../registry/resolve.js';
import { applyCredentials } from '../registry/connections.js';
import { projectOf } from '../registry/schema.js';

// Реквизиты подключения из конфига приложения на сервере: пароль базы в database.php, пароль
// FTP в .env. Читает их реестр, по своему SSH, и дальше себя не отпускает: ни значения, ни
// куска файла нет ни в ответе, ни в ошибке — сообщение парсера JSON, например, цитирует
// входной текст, поэтому оно подменяется своим.

// Имена полей по умолчанию есть только у баз: там конфиги типовые (CodeIgniter, Laravel).
// Для FTP соглашения нет — поле с паролем называют явно.
const DB_DEFAULTS = {
  php: { password: 'password', username: 'username', database: 'database' },
  json: { password: 'password', username: 'username', database: 'database' },
  env: { password: 'DB_PASSWORD', username: 'DB_USERNAME', database: 'DB_DATABASE' },
};

const MAX_FILE_BYTES = 1024 * 1024;
const MARK = '__CR_CREDENTIALS__';

// CodeIgniter начинает конфиг с `defined('BASEPATH') OR exit`: без константы include молча
// завершит процесс. ENVIRONMENT — туда же. Вывод самого файла (BOM, пробел до <?php)
// глушится буфером, результат идёт после метки.
const PHP_READER = [
  'if (!defined("BASEPATH")) define("BASEPATH", dirname(getenv("CR_FILE")) . "/");',
  'if (!defined("ENVIRONMENT")) define("ENVIRONMENT", "production");',
  'ob_start();',
  '$__cr_r = include getenv("CR_FILE");',
  'ob_end_clean();',
  '$__cr_k = json_decode(getenv("CR_KEY"), true);',
  'if (count($__cr_k)) {',
  '  $__cr_n = $__cr_k[0]; $__cr_v = isset($$__cr_n) ? $$__cr_n : null;',
  '  foreach (array_slice($__cr_k, 1) as $__cr_p) {',
  '    $__cr_v = (is_array($__cr_v) && array_key_exists($__cr_p, $__cr_v)) ? $__cr_v[$__cr_p] : null;',
  '  }',
  '} else { $__cr_v = $__cr_r; }',
  `echo "\\n${MARK}" . json_encode($__cr_v);`,
].join(' ');

const pathOf = (key) => String(key || '').split('.').filter(Boolean);

function dig(value, parts) {
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

/** .env: KEY=VALUE, `export` впереди, кавычки, комментарий после пробела у значения без кавычек. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    const quoted = value.match(/^(["'])(.*)\1\s*(?:#.*)?$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    out[match[1]] = value;
  }
  return out;
}

async function readText(client, file) {
  const api = makeSftp(await sftp(client));
  try {
    const res = await api.read(file, { maxBytes: MAX_FILE_BYTES });
    if (res.truncated) throw new Error(`файл реквизитов ${file} больше ${MAX_FILE_BYTES} Б — это не конфиг`);
    return res.content.toString('utf8');
  } finally {
    await api.close();
  }
}

async function readPhp(client, spec) {
  const res = await exec(client, `php -r ${quote(PHP_READER)}`, {
    vars: { CR_FILE: spec.path, CR_KEY: JSON.stringify(pathOf(spec.key)) },
    timeoutMs: 30_000,
  });
  const at = res.stdout.lastIndexOf(MARK);
  if (res.code !== 0 || at < 0) {
    const why = res.stderr.trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
    throw new Error(`php на хосте не прочитал ${spec.path} (код ${res.code})${why ? `: ${why}` : ''}`);
  }
  try {
    return JSON.parse(res.stdout.slice(at + MARK.length));
  } catch {
    throw new Error(`php вернул не JSON для ${spec.path}`);
  }
}

/**
 * Источник может лежать и на этой машине — .env проекта рядом с кодом, как у баз в облаке,
 * куда SSH не ведёт вовсе. Такой файл загружают на /upload: он едет мимо контекста модели,
 * а в config остаётся ссылка cr://uploads/….
 */
export const isUploaded = (value) => String(value || '').startsWith('cr://uploads/');

function readUploaded(ref) {
  const file = resolveSource(ref);
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error(`файл реквизитов ${ref} больше ${MAX_FILE_BYTES} Б — это не конфиг`);
  return fs.readFileSync(file, 'utf8');
}

/** Хост, где лежит файл: свой у подключения либо from — но только из того же проекта. */
function sourceHost(resolved, spec) {
  if (spec.from) {
    if (projectOf(spec.from) !== resolved.project) {
      throw new Error(`источник реквизитов «${spec.from}» — хост чужого проекта`);
    }
    return resolveHost(spec.from);
  }
  if (!resolved.host) throw new Error('реквизиты читаются с хоста по SSH: привяжите host или укажите credentials.from');
  return resolved.host;
}

/** Какое поле источника в какое поле подключения. */
export function fieldMap(resolved) {
  const spec = resolved.config.credentials;
  const defaults = resolved.kind === 'db' ? DB_DEFAULTS[spec.format] : {};
  return { ...defaults, ...(spec.fields || {}) };
}

/**
 * Читает источник, описанный в config.credentials подключения.
 * Возвращает { values, found }: values — { password, username, … } с null там, где поля
 * не нашлось; found — «куда ← откуда» для ответа агенту, без значений.
 */
export async function read(resolved, { approveHostKey } = {}) {
  const spec = resolved.config.credentials;
  if (!spec) throw new Error(`у «${resolved.alias}» не задан источник реквизитов: config.credentials`);

  const names = fieldMap(resolved);
  if (!names.password) {
    throw new Error(`не сказано, в каком поле ${spec.path} лежит пароль: config.credentials.fields.password`);
  }

  let data;
  const uploaded = isUploaded(spec.path);

  if (spec.format === 'php') {
    if (uploaded) throw new Error('php-конфиг исполняется на сервере — загруженный файл годится только для env и json');
    data = await readPhp(await connect(sourceHost(resolved, spec), { approveHostKey }), spec);
  } else {
    const text = uploaded
      ? readUploaded(spec.path)
      : await readText(await connect(sourceHost(resolved, spec), { approveHostKey }), spec.path);
    if (spec.format === 'env') {
      data = parseEnv(text);
    } else {
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error(`${spec.path} — не JSON`); }
      data = dig(parsed, pathOf(spec.key));
    }
  }

  if (!data || typeof data !== 'object') {
    throw new Error(`в ${spec.path} по ключу «${spec.key || '—'}» нет массива с реквизитами`);
  }

  const values = {};
  for (const [target, source] of Object.entries(names)) {
    const value = data[source];
    values[target] = value === undefined || value === null || value === '' ? null : String(value);
  }
  if (values.port !== undefined && values.port !== null) {
    const port = Number(values.port);
    values.port = Number.isInteger(port) && port > 0 ? port : null;
  }

  if (values.password === null) {
    const keys = Object.keys(data).slice(0, 20).join(', ');
    throw new Error(`в ${spec.path} нет поля «${names.password}» с паролем. Есть поля: ${keys || 'никаких'}`);
  }

  const found = Object.keys(values).filter((k) => values[k] !== null).map((k) => `${k} ← ${names[k]}`);
  return { values, found };
}

/**
 * Реквизиты на момент соединения. Обычно — из реестра. С live — с хоста: изменилось —
 * реестр запоминает новое; не прочиталось — работаем сохранённым и говорим об этом в
 * warning, а не роняем запрос к боевой базе.
 */
export async function current(resolved, { approveHostKey, addSecret } = {}) {
  const spec = resolved.config.credentials;
  const config = resolved.config;
  const stored = {
    password: resolved.hasSecret ? resolved.secret() : null,
    username: config.username ?? null,
    database: config.database ?? null,
    address: config.address ?? null,
    port: config.port ?? null,
  };

  if (!spec?.live) {
    if (spec && !stored.password) {
      throw new Error(`реквизиты «${resolved.alias}» ещё не прочитаны с хоста — вызовите secret_import`);
    }
    return { ...stored, warning: null };
  }

  try {
    const fresh = await read(resolved, { approveHostKey });
    addSecret?.(fresh.values.password);
    const applied = applyCredentials(resolved.alias, fresh.values);
    return {
      ...stored,
      ...applied.config,
      password: fresh.values.password,
      warning: applied.changed.length ? `реквизиты на хосте изменились (${applied.changed.join(', ')}), реестр обновлён` : null,
    };
  } catch (err) {
    if (!stored.password) throw err;
    return { ...stored, warning: `реквизиты с хоста не прочитались (${err.message}), взяты сохранённые` };
  }
}
