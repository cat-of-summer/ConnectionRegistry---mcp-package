import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs } from '../paths.js';
import { readBlob } from './log.js';

// Индекса нет — читаем файлы от новых к старым и останавливаемся, набрав limit.
// Чтение идёт с конца кусками: держать в памяти 64-мегабайтный файл ради десяти
// последних записей незачем.

const CHUNK = 1024 * 1024;

function logFiles() {
  ensureDirs();
  return fs.readdirSync(DIRS.logs)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .reverse()
    .map((name) => path.join(DIRS.logs, name));
}

function* linesBackwards(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let position = fs.fstatSync(fd).size;
    let tail = '';

    while (position > 0) {
      const size = Math.min(CHUNK, position);
      position -= size;
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, position);

      const text = buf.toString('utf8') + tail;
      const parts = text.split('\n');
      tail = parts.shift() ?? '';

      for (let i = parts.length - 1; i >= 0; i--) {
        const line = parts[i].trim();
        if (line) yield line;
      }
    }

    if (tail.trim()) yield tail.trim();
  } finally {
    fs.closeSync(fd);
  }
}

function matches(record, filter) {
  if (filter.alias && record.alias !== filter.alias) return false;
  if (filter.project && !String(record.alias || '').startsWith(`${filter.project}/`)) return false;
  if (filter.tool && record.tool !== filter.tool) return false;
  if (filter.onlyErrors && record.ok !== false) return false;
  if (filter.since && record.ts < filter.since) return false;
  if (filter.until && record.ts > filter.until) return false;
  if (filter.contains) {
    const needle = String(filter.contains).toLowerCase();
    const hay = `${record.command || ''} ${JSON.stringify(record.args || {})} ${record.stdout || ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function list(filter = {}) {
  const limit = Math.min(Number(filter.limit) || 20, 500);
  const found = [];

  for (const file of logFiles()) {
    // Файл целиком старше запрошенного окна — дальше только ещё старше.
    if (filter.since && path.basename(file).slice(0, 10) < filter.since.slice(0, 10)) break;

    for (const line of linesBackwards(file)) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!matches(record, filter)) continue;
      found.push(summary(record));
      if (found.length >= limit) return { entries: found, limit, truncated: true };
    }
  }

  return { entries: found, limit, truncated: false };
}

export function get(id) {
  const day = String(id).slice(0, 10);
  const candidates = logFiles().filter((file) => path.basename(file).startsWith(day));

  for (const file of candidates.length ? candidates : logFiles()) {
    for (const line of linesBackwards(file)) {
      if (!line.includes(id)) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.id !== id) continue;
      return { ...record, stdout: readBlob(record, 'stdout'), stderr: readBlob(record, 'stderr') };
    }
  }

  return null;
}

function summary(record) {
  return {
    id: record.id,
    ts: record.ts,
    tool: record.tool,
    alias: record.alias,
    ok: record.ok,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    command: record.command,
    approval: record.approval,
    bytes: record.bytes,
    error: record.error,
  };
}
