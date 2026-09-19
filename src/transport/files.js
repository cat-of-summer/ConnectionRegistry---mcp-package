import path from 'node:path';
import { connect, sftp } from './ssh.js';
import { make as makeSftp } from './sftp.js';
import { open as openFtp } from './ftp.js';

// Путь в аргументах инструмента считается относительно root подключения, если он
// задан и путь не абсолютный. Абсолютный путь уходит как есть: реестр не строит
// клетку, он избавляет от повторного ввода одного и того же префикса.
export function resolvePath(resolved, target) {
  const root = resolved.config.root;
  const value = String(target ?? '.');
  if (!root) return value;
  if (value.startsWith('/')) return value;
  return path.posix.join(root, value);
}

/**
 * Создаёт каталог вместе с недостающими родителями. sftp умеет только один уровень,
 * ftp — сразу дерево; уравниваем, чтобы у инструмента было одно поведение на оба протокола.
 */
export async function mkdirp(api, target) {
  const parts = String(target).split('/').filter(Boolean);
  const created = [];
  let current = target.startsWith('/') ? '' : '.';

  for (const part of parts) {
    current = current === '.' ? part : `${current}/${part}`;
    try {
      await api.mkdir(current);
      created.push(current);
    } catch {
      // Уже есть или создан параллельно — проверим в конце по stat.
    }
  }

  await api.stat(target);
  return created;
}

export async function withFiles(resolved, { approveHostKey } = {}, fn) {
  const proto = resolved.config.proto || 'sftp';

  if (proto === 'sftp') {
    const client = await connect(resolved.host, { approveHostKey });
    const handle = await sftp(client);
    const api = makeSftp(handle);
    try {
      return await fn(api);
    } finally {
      // Закрывается только канал sftp: само соединение живёт в пуле и ещё пригодится.
      await api.close();
    }
  }

  const password = resolved.hasSecret ? resolved.secret() : resolved.host?.secret?.();
  const api = await openFtp({
    address: resolved.config.address || resolved.host?.address,
    port: resolved.port,
    username: resolved.config.username || resolved.host?.username,
    password,
    secure: proto === 'ftps',
  });

  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}
