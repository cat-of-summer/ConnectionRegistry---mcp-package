import crypto from 'node:crypto';
import fs from 'node:fs';
import { cfg } from '../config.js';
import { db, meta, now } from './db.js';

// Секреты лежат зашифрованными AES-256-GCM. Ключ выводится из мастер-ключа scrypt'ом
// с солью, которая заводится один раз при создании реестра и хранится в meta:
// одинаковый мастер-ключ на двух машинах не даёт одинаковый ключ шифрования.

const KEYCHECK_PLAIN = 'connection-registry';

let cachedKey = null;

// Расшифрованные значения помнятся до конца жизни процесса. Нужно это журналу:
// он вычищает из вывода секреты всех подключений проекта, а не только того, через
// которое шёл вызов, и платить за каждую такую чистку scrypt'ом по всем секретам
// было бы дороже самой команды. Ключ шифрования тут же рядом, в cachedKey, так что
// хуже от этого не становится.
const plaintexts = new Map();

function masterSecret() {
  if (cfg.masterKeyFile) {
    try {
      const value = fs.readFileSync(cfg.masterKeyFile, 'utf8').trim();
      if (value) return value;
    } catch (err) {
      throw new LockedError(`не удалось прочитать CR_MASTER_KEY_FILE (${cfg.masterKeyFile}): ${err.message}`);
    }
  }
  return cfg.masterKey.trim();
}

export class LockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'LockedError';
    this.code = 'registry_locked';
  }
}

export function isUnlocked() {
  return Boolean(masterSecret());
}

/** Состояние мастер-ключа для registry_info и `cr doctor`. */
export function keyState() {
  if (!masterSecret()) return { unlocked: false, reason: 'no_key' };
  try {
    key();
    return { unlocked: true, reason: null };
  } catch (err) {
    return { unlocked: false, reason: err.code === 'wrong_key' ? 'wrong_key' : 'error', message: err.message };
  }
}

function key() {
  if (cachedKey) return cachedKey;

  const secret = masterSecret();
  if (!secret) {
    throw new LockedError(
      'реестр заперт: не задан CR_MASTER_KEY. Метаданные и заметки читаются, подключаться никуда нельзя.',
    );
  }

  let salt = meta.get('kdf_salt');
  if (!salt) {
    salt = crypto.randomBytes(16).toString('base64');
    meta.set('kdf_salt', salt);
  }

  const derived = crypto.scryptSync(secret, Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });

  // Проверка ключа: подменённый мастер-ключ должен давать внятную ошибку при старте,
  // а не «сбой расшифровки» на первом же подключении к боевому серверу.
  const check = meta.get('keycheck');
  if (!check) {
    meta.set('keycheck', seal(derived, KEYCHECK_PLAIN));
  } else {
    try {
      if (open(derived, check) !== KEYCHECK_PLAIN) throw new Error('mismatch');
    } catch {
      const err = new LockedError('мастер-ключ не тот, которым заведён реестр: секреты этим ключом не расшифровать');
      err.code = 'wrong_key';
      throw err;
    }
  }

  cachedKey = derived;
  return cachedKey;
}

function seal(k, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function open(k, packed) {
  const [version, nonce, tag, ct] = String(packed).split(':');
  if (version !== 'v1') throw new Error(`неизвестный формат секрета: ${version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Кладёт секрет и возвращает его id. Значение наружу не выходит никогда. */
export function putSecret(kind, plaintext) {
  const packed = seal(key(), plaintext);
  const res = db()
    .prepare('INSERT INTO secrets (kind, value, created_at) VALUES (?, ?, ?)')
    .run(kind, packed, now());
  return Number(res.lastInsertRowid);
}

export function readSecret(id) {
  if (!id) return null;
  if (plaintexts.has(id)) return plaintexts.get(id);

  const row = db().prepare('SELECT value FROM secrets WHERE id = ?').get(id);
  if (!row) return null;

  const value = open(key(), row.value);
  plaintexts.set(id, value);
  return value;
}

/** Вид секрета под этим id: по нему сверяется ссылка cr://secret/…#вид. */
export function secretKind(id) {
  if (!id) return null;
  return db().prepare('SELECT kind FROM secrets WHERE id = ?').get(id)?.kind ?? null;
}

export function dropSecret(id) {
  if (!id) return;
  plaintexts.delete(id);
  db().prepare('DELETE FROM secrets WHERE id = ?').run(id);
}

/** Заменяет значение существующего секрета, сохраняя id — ссылки на него не рвутся. */
export function replaceSecret(id, kind, plaintext) {
  if (!id) return putSecret(kind, plaintext);
  plaintexts.delete(id);
  db().prepare('UPDATE secrets SET kind = ?, value = ?, created_at = ? WHERE id = ?')
    .run(kind, seal(key(), plaintext), now(), id);
  return id;
}
