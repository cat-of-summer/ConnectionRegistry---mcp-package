import { connect, exec, sftp, quote } from './ssh.js';
import { make as makeSftp } from './sftp.js';

// Реквизиты базы из конфига приложения на её же хосте. Читает их реестр, по своему SSH,
// и дальше себя не отпускает: ни значения, ни куска файла нет ни в ответе, ни в ошибке —
// сообщение парсера JSON, например, цитирует входной текст, поэтому оно подменяется своим.

const DEFAULT_FIELDS = {
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
 * Читает источник, описанный в config.credentials подключения.
 * Возвращает { password, username, database, found } — found перечисляет имена полей,
 * которые нашлись, для ответа агенту без значений.
 */
export async function read(resolved, { approveHostKey } = {}) {
  const spec = resolved.config.credentials;
  if (!spec) throw new Error(`у «${resolved.alias}» не задан источник реквизитов: config.credentials`);
  if (!resolved.host) throw new Error('реквизиты читаются с хоста по SSH, а у подключения хоста нет');

  const client = await connect(resolved.host, { approveHostKey });
  let data;

  if (spec.format === 'php') {
    data = await readPhp(client, spec);
  } else {
    const text = await readText(client, spec.path);
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

  const names = { ...DEFAULT_FIELDS[spec.format], ...(spec.fields || {}) };
  const take = (field) => {
    const value = data[names[field]];
    return value === undefined || value === null || value === '' ? null : String(value);
  };

  const creds = { password: take('password'), username: take('username'), database: take('database') };
  if (creds.password === null) {
    const keys = Object.keys(data).slice(0, 20).join(', ');
    throw new Error(`в ${spec.path} нет поля «${names.password}» с паролем. Есть поля: ${keys || 'никаких'}`);
  }

  return { ...creds, found: Object.keys(creds).filter((k) => creds[k] !== null).map((k) => `${k} ← ${names[k]}`) };
}
