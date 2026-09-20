import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { DIRS, ensureDirs } from '../paths.js';
import { redact, maskWhole } from '../secrets.js';

// Журнал живёт файлами, без второй копии в базе: он растёт до гигабайта, а нужен
// целиком и подряд. Одна строка JSONL — одно действие; крупный вывод уезжает в
// соседний файл, иначе один db_dump растянул бы строку на сотни мегабайт и сломал
// построчное чтение.
//
// Секрет прячется двумя путями сразу, и они закрывают разное. По имени поля —
// там, где поле секретно целиком (password в host_set, value в secret_set). По
// содержимому — везде, потому что приватный ключ, переданный в ssh_exec, лежит в
// поле «command», и никакой список имён его не поймает. Третий путь, scrub, знает
// конкретные значения из реестра и вычищает их из вывода, если пароль ушёл в эхо.

const SECRET_KEYS = /^(password|passphrase|privatekey|private_key|secret|token|dsn|key)$/i;
const MASK = '••••';

/**
 * whole — имена полей, которые этот инструмент объявил секретными целиком.
 * Список имён общий на всех, а «value» секретно только у secret_set: у notes_set
 * поле с тем же именем — значение факта, и прятать его незачем.
 */
export function maskArgs(value, whole = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => maskArgs(v, whole, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(key) || whole.includes(key)) {
        out[key] = v === null || v === undefined ? v ?? null : maskWhole(v, hintOf(key));
        continue;
      }
      out[key] = maskArgs(v, whole, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? redact(value) : value;
}

function hintOf(key) {
  const name = key.toLowerCase();
  if (name === 'privatekey' || name === 'private_key') return 'private_key';
  if (name === 'passphrase') return 'passphrase';
  if (name === 'dsn') return 'connection_string';
  if (name === 'token') return 'token';
  return 'password';
}

/** Вычищает конкретные значения секретов из текста: пароль мог уйти в эхо команды. */
export function scrub(text, secrets = []) {
  if (!text) return text;
  let out = String(text);
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join(MASK);
  }
  return out;
}

export function newId(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}_${crypto.randomBytes(2).toString('hex')}`;
}

function dayOf(id) {
  return id.slice(0, 10);
}

function currentFile(day) {
  ensureDirs();
  const files = fs.readdirSync(DIRS.logs)
    .filter((name) => name.startsWith(day) && name.endsWith('.jsonl'))
    .sort();

  if (files.length === 0) return path.join(DIRS.logs, `${day}.jsonl`);

  const last = path.join(DIRS.logs, files[files.length - 1]);
  const size = fs.statSync(last).size;
  if (size < cfg.logFileBytes) return last;

  const index = files.length + 1;
  return path.join(DIRS.logs, `${day}.${index}.jsonl`);
}

function blobPath(id, stream) {
  return path.join(DIRS.blobs, `${id}.${stream}.txt`);
}

/**
 * Потоки записывает сам сервер, и они ходят через блоб всегда. Аргументы и команда
 * приходят от агента и до сих пор шли в строку без всякого потолка: один files_put
 * с мегабайтным content давал мегабайтную строку JSONL и ломал построчное чтение
 * ровно так же, как это делал бы db_dump. Поля про блоб проставляются только когда
 * он появился: у обычной записи их нет, и читается она как раньше.
 */
function attachIfBig(record, id, field, text, inline) {
  if (Buffer.byteLength(text) <= cfg.logInlineBytes) return;

  const stored = store(id, field, text);
  record[field] = inline;
  record[`${field}Bytes`] = stored.bytes;
  record[`${field}Blob`] = stored.blob;
  record[`${field}Truncated`] = true;
}

/**
 * Крупный вывод уходит в блоб, в строке остаётся начало и ссылка.
 * Возвращает {text, truncated, bytes, blob}.
 */
function store(id, stream, text) {
  const value = text == null ? '' : String(text);
  const bytes = Buffer.byteLength(value);
  if (bytes <= cfg.logInlineBytes) return { text: value, truncated: false, bytes, blob: null };

  ensureDirs();
  const file = blobPath(id, stream);
  fs.writeFileSync(file, value);
  return {
    text: value.slice(0, 2000),
    truncated: true,
    bytes,
    blob: path.relative(DIRS.logs, file).split(path.sep).join('/'),
  };
}

export function start({ tool, alias, args, kind = null, target = null, secretArgs = [] }) {
  return {
    id: newId(),
    ts: new Date().toISOString(),
    startedAt: Date.now(),
    tool,
    alias: alias ?? null,
    kind,
    target,
    args: maskArgs(args ?? {}, secretArgs),
    approval: null,
  };
}

/** Сначала известные значения из реестра, потом всё, что похоже на секрет само по себе. */
const clean = (text, secrets) => redact(scrub(text, secrets));

export function finish(entry, outcome = {}) {
  const secrets = outcome.secrets || [];
  const record = {
    id: entry.id,
    ts: entry.ts,
    tool: entry.tool,
    alias: entry.alias,
    kind: entry.kind,
    target: entry.target,
    args: entry.args,
    approval: entry.approval,
    ok: outcome.ok !== false,
    exitCode: outcome.exitCode ?? null,
    durationMs: Date.now() - entry.startedAt,
    command: clean(outcome.command ?? null, secrets),
    error: clean(outcome.error ?? null, secrets),
  };

  attachIfBig(record, entry.id, 'args', JSON.stringify(record.args), { '…': 'аргументы целиком в блобе' });
  if (record.command) attachIfBig(record, entry.id, 'command', record.command, record.command.slice(0, 2000));

  const stdout = store(entry.id, 'stdout', clean(outcome.stdout, secrets));
  const stderr = store(entry.id, 'stderr', clean(outcome.stderr, secrets));
  record.stdout = stdout.text;
  record.stdoutBytes = stdout.bytes;
  record.stdoutBlob = stdout.blob;
  record.stdoutTruncated = stdout.truncated;
  record.stderr = stderr.text;
  record.stderrBytes = stderr.bytes;
  record.stderrBlob = stderr.blob;
  record.stderrTruncated = stderr.truncated;
  record.bytes = stdout.bytes + stderr.bytes;

  write(record);
  rotate();
  return record;
}

function write(record) {
  const file = currentFile(dayOf(record.id));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Потолок задаётся одним числом — общим размером журнала. Переполнение убирает
 * самые старые файлы целиком вместе с их блобами: резать строки внутри файла
 * значило бы переписывать гигабайт ради одной записи.
 */
export function rotate() {
  ensureDirs();
  const files = fs.readdirSync(DIRS.logs)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => {
      const file = path.join(DIRS.logs, name);
      return { name, file, size: fs.statSync(file).size };
    });

  const blobs = fs.existsSync(DIRS.blobs)
    ? fs.readdirSync(DIRS.blobs).map((name) => {
      const file = path.join(DIRS.blobs, name);
      return { name, file, size: fs.statSync(file).size };
    })
    : [];

  let total = files.reduce((sum, f) => sum + f.size, 0) + blobs.reduce((sum, b) => sum + b.size, 0);
  if (total <= cfg.logMaxBytes) return { removed: [], total };

  const removed = [];
  for (const entry of files) {
    if (total <= cfg.logMaxBytes) break;
    if (files.length - removed.length <= 1) break; // текущий файл не трогаем

    const day = entry.name.slice(0, 10);
    for (const blob of blobs) {
      if (!blob.name.startsWith(day)) continue;
      try { fs.unlinkSync(blob.file); total -= blob.size; } catch { /* уже удалён */ }
    }
    try { fs.unlinkSync(entry.file); total -= entry.size; removed.push(entry.name); } catch { /* уже удалён */ }
  }

  return { removed, total };
}

export function logSize() {
  ensureDirs();
  const sum = (dir) => fs.readdirSync(dir).reduce((acc, name) => {
    const stat = fs.statSync(path.join(dir, name));
    return acc + (stat.isFile() ? stat.size : 0);
  }, 0);
  return sum(DIRS.logs) + (fs.existsSync(DIRS.blobs) ? sum(DIRS.blobs) : 0);
}

export function readBlob(record, field) {
  const name = record[`${field}Blob`];
  if (!name) return record[field];
  const file = path.join(DIRS.logs, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Аргументы уехали в блоб JSON-текстом — вернуть их надо объектом, как в строке. */
export function readArgs(record) {
  if (!record.argsBlob) return record.args;
  const raw = readBlob(record, 'args');
  try { return JSON.parse(raw); } catch { return record.args; }
}
