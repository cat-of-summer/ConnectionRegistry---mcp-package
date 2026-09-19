import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень — каталог, где лежит код (/var/www/html), а не cwd: `docker exec … cr`
// запускается откуда угодно, и реестр от этого переезжать не должен. Всё состояние
// лежит в подкаталогах, и каждый из них смонтирован томом: пересоздание контейнера
// и docker pull их не задевают. CR_ROOT переопределяет — им пользуются тесты.
export const ROOT = process.env.CR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DIRS = {
  registry: path.join(ROOT, 'registry'),
  logs: path.join(ROOT, 'logs'),
  blobs: path.join(ROOT, 'logs', 'blobs'),
  uploads: path.join(ROOT, 'uploads'),
  artifacts: path.join(ROOT, 'artifacts'),
};

export const DB_FILE = path.join(DIRS.registry, 'registry.sqlite');

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
  // Реестр читает и пишет только сам сервер: соседям по контейнеру там делать нечего.
  try { fs.chmodSync(DIRS.registry, 0o700); } catch { /* windows / чужая fs */ }
}

export default { ROOT, DIRS, DB_FILE, ensureDirs };
