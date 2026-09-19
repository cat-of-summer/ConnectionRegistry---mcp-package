import { Readable, Writable } from 'node:stream';
import { Client } from 'basic-ftp';

// FTP не держим в пуле: соединение дешёвое, а состояние (текущий каталог,
// пассивный режим) переживает вызовы плохо. Открыли, сделали, закрыли.

export async function open({ address, port, username, password, secure }) {
  const client = new Client(30_000);
  client.ftp.verbose = false;
  await client.access({
    host: address,
    port: port || 21,
    user: username || 'anonymous',
    password: password || 'anonymous@',
    secure: Boolean(secure),
    secureOptions: secure ? { rejectUnauthorized: false } : undefined,
  });

  return {
    kind: 'ftp',

    async list(dir) {
      const entries = await client.list(dir);
      return entries.map((entry) => ({
        name: entry.name,
        size: entry.size,
        mode: entry.permissions ? String(entry.permissions.user ?? '') : null,
        mtime: entry.modifiedAt ? entry.modifiedAt.toISOString() : null,
        dir: entry.isDirectory,
        link: entry.isSymbolicLink,
      }));
    },

    async stat(target) {
      const size = await client.size(target).catch(() => null);
      const mtime = await client.lastMod(target).catch(() => null);
      return { path: target, size, mtime: mtime ? mtime.toISOString() : null, dir: size === null };
    },

    async read(target, { maxBytes } = {}) {
      const chunks = [];
      let bytes = 0;
      let truncated = false;

      const sink = new Writable({
        write(chunk, _enc, cb) {
          if (maxBytes && bytes + chunk.length > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - bytes)));
            bytes = maxBytes;
            return cb();
          }
          bytes += chunk.length;
          chunks.push(chunk);
          cb();
        },
      });

      await client.downloadTo(sink, target);
      return { content: Buffer.concat(chunks), truncated, bytes };
    },

    writeStream: (target, source) => client.uploadFrom(source, target),
    write: (target, buffer) => client.uploadFrom(Readable.from(buffer), target),
    downloadTo: (target, writable) => client.downloadTo(writable, target),

    remove: (target) => client.remove(target),
    rmdir: (target) => client.removeDir(target),
    mkdir: (target) => client.ensureDir(target),
    move: (from, to) => client.rename(from, to),
    async chmod(target, mode) {
      // SITE CHMOD поддерживают не все серверы — отвечаем честно, а не молча «ок».
      const res = await client.send(`SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${target}`, true);
      if (res.code >= 400) throw new Error(`сервер отказал в смене прав: ${res.code} ${res.message}`);
      return res;
    },

    async close() { client.close(); },
  };
}
