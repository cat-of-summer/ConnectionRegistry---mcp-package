import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client } from 'ssh2';
import { cfg } from '../config.js';
import { scrubber } from '../secrets.js';

// Один хост — одно живое соединение. Поверх него и шелл, и файлы, и docker, и
// туннель к базе: ровно то, ради чего реестр разделён на хосты и подключения.

const pool = new Map(); // alias -> { client, idleTimer, stamp }

// Живое соединение годится, пока хост в реестре тот же. Сменили адрес, пользователя
// или отпечаток — старую сессию закрываем, иначе правка реестра ничего бы не меняла.
const stampOf = (host) => [host.address, host.port, host.username, host.authKind, host.hostKey, host.hostKeyStatus].join('|');

export function fingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export class HostKeyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'HostKeyError';
    this.code = 'host_key';
    Object.assign(this, details);
  }
}

function authOptions(host) {
  if (host.authKind === 'agent') {
    const socket = process.env.SSH_AUTH_SOCK;
    if (!socket) throw new Error('вход через агента выбран, но SSH_AUTH_SOCK в контейнере не задан');
    return { agent: socket };
  }
  if (host.authKind === 'key') {
    const key = host.secret();
    if (!key) throw new Error(`у хоста «${host.alias}» не найден приватный ключ`);
    const passphrase = host.passphrase();
    return passphrase ? { privateKey: key, passphrase } : { privateKey: key };
  }
  const password = host.secret();
  if (!password) throw new Error(`у хоста «${host.alias}» не найден пароль`);
  return { password };
}

/**
 * @param host           разрешённый хост из resolve()
 * @param approveHostKey async (fingerprint) => boolean — спрашивает человека про новый ключ
 */
export async function connect(host, { approveHostKey } = {}) {
  if (!host) throw new Error('подключение не привязано к хосту');

  const live = pool.get(host.alias);
  if (live && live.stamp === stampOf(host)) {
    touch(host.alias);
    return live.client;
  }
  if (live) {
    drop(host.alias);
    try { live.client.end(); } catch { /* уже закрыт */ }
  }

  const client = new Client();
  const options = {
    host: host.address,
    port: host.port || 22,
    username: host.username,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    ...authOptions(host),
  };

  await new Promise((resolve, reject) => {
    let keyProblem = null;

    options.hostVerifier = (key, cb) => {
      const fp = fingerprint(key);

      if (host.hostKey && host.hostKeyStatus === 'pinned') {
        if (fp === host.hostKey) return cb(true);
        keyProblem = new HostKeyError(
          `отпечаток хоста «${host.alias}» не совпал с закреплённым. Ожидался ${host.hostKey}, пришёл ${fp}. `
          + 'Подключение отменено: так выглядит и подмена сервера, и честная переустановка — разобраться должен человек.',
          { expected: host.hostKey, actual: fp, host: host.alias },
        );
        return cb(false);
      }

      if (typeof approveHostKey !== 'function') {
        keyProblem = new HostKeyError(
          `хост «${host.alias}» виден впервые, его ключ ${fp} ещё не закреплён. Закрепите его подтверждением.`,
          { actual: fp, host: host.alias, firstSeen: true },
        );
        return cb(false);
      }

      Promise.resolve(approveHostKey(fp))
        .then((ok) => {
          if (!ok) {
            keyProblem = new HostKeyError(`ключ хоста «${host.alias}» (${fp}) не подтверждён`, { actual: fp, host: host.alias });
          }
          cb(Boolean(ok));
        })
        .catch((err) => { keyProblem = err; cb(false); });
    };

    // ssh2 после отказа по хост-ключу шлёт два события error подряд («not verified» и
    // «connection lost»). Слушатель остаётся навсегда: событие без слушателя роняет процесс.
    let settled = false;
    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(keyProblem || err);
    });
    client.once('ready', () => { settled = true; resolve(); });
    client.connect(options);
  });

  client.on('close', () => {
    if (pool.get(host.alias)?.client === client) drop(host.alias);
  });
  pool.set(host.alias, { client, idleTimer: null, stamp: stampOf(host) });
  touch(host.alias);
  return client;
}

function touch(alias) {
  const live = pool.get(alias);
  if (!live) return;
  clearTimeout(live.idleTimer);
  live.idleTimer = setTimeout(() => {
    pool.delete(alias);
    try { live.client.end(); } catch { /* уже закрыт */ }
  }, cfg.sshIdleMs);
  live.idleTimer.unref?.();
}

function drop(alias) {
  const live = pool.get(alias);
  if (!live) return;
  clearTimeout(live.idleTimer);
  pool.delete(alias);
}

export function closeAll() {
  for (const [alias, live] of pool) {
    clearTimeout(live.idleTimer);
    try { live.client.end(); } catch { /* уже закрыт */ }
    pool.delete(alias);
  }
}

export function poolState() {
  return [...pool.keys()];
}

export function quote(value) {
  return `'${String(value).replace(/'/g, `'\''`)}'`;
}

export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Переменные окружения команды едут первыми строками stdin, а не запросом env канала SSH:
 * sshd пропускает оттуда только то, что разрешено AcceptEnv, — обычно LANG и LC_*, — и
 * молча выбрасывает остальное. Шелл читает их встроенным read, который из трубы берёт
 * ровно по байту, так что исходный stdin достаётся команде нетронутым. Заодно значение
 * не видно ни в ps на сервере, ни в строке команды в журнале.
 */
export function withVars(command, vars, stdin) {
  const entries = Object.entries(vars || {});
  if (!entries.length) return { command, stdin };

  for (const [name, value] of entries) {
    if (!VAR_NAME.test(name)) throw new Error(`имя переменной «${name}» не годится для шелла`);
    if (/[\n\0]/.test(String(value))) {
      throw new Error(`значение переменной ${name} многострочное — через env оно не передаётся; передайте его в stdin`);
    }
  }

  const prelude = entries.map(([name]) => `IFS= read -r ${name} && export ${name}`).join(' && ');
  return {
    command: `{ ${prelude}; } && ${command}`,
    stdin: `${entries.map(([, value]) => String(value)).join('\n')}\n${stdin ?? ''}`,
  };
}

/**
 * Выполняет команду и возвращает код возврата и потоки целиком (с потолком по объёму).
 *
 * vars     — переменные окружения, см. withVars.
 * stdoutTo — { file, secrets }: stdout пишется в файл потоком, без потолка, с чисткой
 *            известных секретов и sha256 по дороге. В ответе тогда не текст, а размер и хеш.
 */
export function exec(client, command, { cwd, stdin, timeoutMs = cfg.execTimeoutMs, env, vars, stdoutTo } = {}) {
  const located = cwd ? `cd ${quote(cwd)} && ${command}` : command;
  const prepared = withVars(located, vars, stdin);
  const full = prepared.command;
  const input = prepared.stdin;

  return new Promise((resolve, reject) => {
    client.exec(full, { env }, (err, stream) => {
      if (err) return reject(err);

      const out = [];
      const errOut = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;

      const file = stdoutTo ? fs.createWriteStream(stdoutTo.file) : null;
      const clean = stdoutTo ? scrubber(stdoutTo.secrets) : null;
      const hash = stdoutTo ? crypto.createHash('sha256') : null;
      let fileBytes = 0;
      let fileError = null;
      file?.on('error', (e) => { fileError = e; });

      const toFile = (buf) => {
        if (!buf.length) return true;
        hash.update(buf);
        fileBytes += buf.length;
        return file.write(buf);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.signal('KILL'); } catch { /* сервер мог запретить сигналы */ }
        try { stream.close(); } catch { /* уже закрыт */ }
      }, timeoutMs);

      const take = (chunk, bucket, isErr) => {
        const size = chunk.length;
        if ((isErr ? errBytes : outBytes) + size > cfg.maxOutputBytes) {
          truncated = true;
          return;
        }
        if (isErr) errBytes += size; else outBytes += size;
        bucket.push(chunk);
      };

      stream.on('data', (chunk) => {
        if (!file) return take(chunk, out, false);
        // Диск медленнее сети бывает: держим канал, пока файл не прожуёт своё.
        if (!toFile(clean.push(chunk))) {
          stream.pause();
          file.once('drain', () => stream.resume());
        }
      });
      stream.stderr.on('data', (chunk) => take(chunk, errOut, true));

      stream.on('close', async (code, signal) => {
        clearTimeout(timer);
        const result = {
          command: full,
          code: timedOut ? null : (code ?? null),
          signal: signal ?? null,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
          truncated,
          timedOut,
        };

        if (file) {
          toFile(clean.end());
          await new Promise((done) => file.end(done));
          if (fileError) return reject(fileError);
          result.file = { bytes: fileBytes, sha256: hash.digest('hex') };
        }
        resolve(result);
      });

      stream.on('error', (streamErr) => { clearTimeout(timer); file?.destroy(); reject(streamErr); });

      if (input !== undefined && input !== null) stream.end(input);
      else stream.end();
    });
  });
}

/** Локальный поток до порта на стороне хоста — так база остаётся закрытой снаружи. */
export function forwardOut(client, address, port) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, address, port, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

export function sftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, handle) => (err ? reject(err) : resolve(handle)));
  });
}
