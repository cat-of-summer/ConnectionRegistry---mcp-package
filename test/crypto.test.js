import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-crypto-'));

// Проверка чужого ключа ставится отдельным процессом: модуль кэширует выведенный
// ключ, и «сменить CR_MASTER_KEY на лету» внутри одного процесса не получится —
// как не получится и на живом сервере.
function inProcess(script, env) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CR_ROOT: root, ...env },
    encoding: 'utf8',
  }).trim();
}

test('секрет переживает перезапуск с тем же ключом', () => {
  const stored = inProcess(`
    const { putSecret } = await import('${modulePath('src/registry/crypto.js')}');
    console.log(putSecret('password', 'пароль-от-боевого'));
  `, { CR_MASTER_KEY: 'ключ-один' });

  const read = inProcess(`
    const { readSecret } = await import('${modulePath('src/registry/crypto.js')}');
    console.log(readSecret(${stored}));
  `, { CR_MASTER_KEY: 'ключ-один' });

  assert.equal(read, 'пароль-от-боевого');
});

test('чужой мастер-ключ даёт внятный отказ, а не мусор', () => {
  const state = inProcess(`
    const { keyState } = await import('${modulePath('src/registry/crypto.js')}');
    console.log(JSON.stringify(keyState()));
  `, { CR_MASTER_KEY: 'ключ-другой' });

  const parsed = JSON.parse(state);
  assert.equal(parsed.unlocked, false);
  assert.equal(parsed.reason, 'wrong_key');
});

test('без ключа реестр заперт, но не падает', () => {
  const state = inProcess(`
    const { keyState, isUnlocked } = await import('${modulePath('src/registry/crypto.js')}');
    console.log(JSON.stringify({ ...keyState(), unlockedFlag: isUnlocked() }));
  `, { CR_MASTER_KEY: '' });

  const parsed = JSON.parse(state);
  assert.equal(parsed.unlocked, false);
  assert.equal(parsed.reason, 'no_key');
});

function modulePath(rel) {
  return new URL(`../${rel}`, import.meta.url).href;
}
