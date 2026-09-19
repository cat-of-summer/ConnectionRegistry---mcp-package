import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { DIRS, ensureDirs } from './paths.js';

// Файлы ходят мимо MCP: исходник приезжает на /upload, результат забирается по
// ссылке. Гнать мегабайты параметром инструмента значило бы платить за них
// контекстом модели — и упираться в её потолок на первом же дампе базы.

const SAFE = /[^a-zA-Z0-9._-]+/g;

export function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(SAFE, '_');
  return base.slice(0, 120) || 'file';
}

function stamp() {
  return `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${crypto.randomBytes(2).toString('hex')}`;
}

/** Каталог под одну загрузку: имя файла сохраняется, коллизии разводит метка времени. */
export function newUploadDir() {
  ensureDirs();
  const dir = path.join(DIRS.uploads, stamp());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newArtifact(name) {
  ensureDirs();
  const dir = path.join(DIRS.artifacts, stamp());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeName(name));
  return describe(file);
}

export function describe(file) {
  const rel = path.relative(DIRS.uploads, file);
  const inUploads = !rel.startsWith('..') && !path.isAbsolute(rel);
  const root = inUploads ? DIRS.uploads : DIRS.artifacts;
  const kind = inUploads ? 'uploads' : 'artifacts';
  const suffix = path.relative(root, file).split(path.sep).join('/');

  return {
    path: file,
    uri: `cr://${kind}/${suffix}`,
    url: `${cfg.publicBaseUrl}/${kind}/${suffix}`,
  };
}

/**
 * Принимает cr://uploads/…, cr://artifacts/… или обычный путь внутри этих каталогов.
 * За их пределы не выпускает: source приходит от агента, и «положи на сервер
 * /etc/shadow этого контейнера» — не то, о чём просят.
 */
export function resolveSource(source) {
  const value = String(source || '');
  let file;

  if (value.startsWith('cr://uploads/')) file = path.join(DIRS.uploads, value.slice('cr://uploads/'.length));
  else if (value.startsWith('cr://artifacts/')) file = path.join(DIRS.artifacts, value.slice('cr://artifacts/'.length));
  else file = path.resolve(value);

  const allowed = [DIRS.uploads, DIRS.artifacts].some((dir) => {
    const rel = path.relative(dir, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });

  if (!allowed) {
    throw new Error(
      `источник «${source}» лежит вне каталогов обмена. Загрузите файл на ${cfg.publicBaseUrl}/upload `
      + 'и передайте полученный cr://uploads/… адрес',
    );
  }
  if (!fs.existsSync(file)) throw new Error(`источник «${source}» не найден`);

  return file;
}

export function listUploads(limit = 50) {
  ensureDirs();
  return fs.readdirSync(DIRS.uploads)
    .sort()
    .reverse()
    .slice(0, limit)
    .flatMap((dir) => {
      const full = path.join(DIRS.uploads, dir);
      if (!fs.statSync(full).isDirectory()) return [];
      return fs.readdirSync(full).map((name) => {
        const file = path.join(full, name);
        return { ...describe(file), bytes: fs.statSync(file).size };
      });
    });
}
