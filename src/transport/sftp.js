import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Тонкая обёртка над ssh2: колбэки в промисы и ничего больше. Разбираться,
// куда класть файл и что считать корнем, — забота уровня выше.

const call = (handle, method, ...args) => new Promise((resolve, reject) => {
  handle[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
});

export function make(handle) {
  return {
    kind: 'sftp',

    async list(dir) {
      const entries = await call(handle, 'readdir', dir);
      return entries.map((entry) => ({
        name: entry.filename,
        size: entry.attrs.size,
        mode: (entry.attrs.mode & 0o7777).toString(8).padStart(4, '0'),
        mtime: new Date(entry.attrs.mtime * 1000).toISOString(),
        dir: (entry.attrs.mode & 0o040000) !== 0,
        link: (entry.attrs.mode & 0o120000) === 0o120000,
      }));
    },

    async stat(target) {
      const attrs = await call(handle, 'stat', target);
      return {
        path: target,
        size: attrs.size,
        mode: (attrs.mode & 0o7777).toString(8).padStart(4, '0'),
        mtime: new Date(attrs.mtime * 1000).toISOString(),
        dir: attrs.isDirectory(),
      };
    },

    async read(target, { maxBytes } = {}) {
      const chunks = [];
      let bytes = 0;
      let truncated = false;

      await pipeline(
        handle.createReadStream(target),
        new Writable({
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
        }),
      );

      return { content: Buffer.concat(chunks), truncated, bytes };
    },

    async writeStream(target, source) {
      await pipeline(source, handle.createWriteStream(target));
    },

    async write(target, buffer) {
      await pipeline(Readable.from(buffer), handle.createWriteStream(target));
    },

    async downloadTo(target, writable) {
      await pipeline(handle.createReadStream(target), writable);
    },

    remove: (target) => call(handle, 'unlink', target),
    rmdir: (target) => call(handle, 'rmdir', target),
    mkdir: (target) => call(handle, 'mkdir', target),
    move: (from, to) => call(handle, 'rename', from, to),
    chmod: (target, mode) => call(handle, 'chmod', target, mode),

    async close() { handle.end(); },
  };
}
