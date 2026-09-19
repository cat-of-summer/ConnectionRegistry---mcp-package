import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-update-'));
process.env.CR_ROOT = root;
// Версия стенда — тег образа из BUNDLE_IMAGE, других источников у неё нет.
process.env.BUNDLE_IMAGE = 'ghcr.io/acme/app:1.0.0';

const { compareVersions, checkForUpdate, upgradeSteps, updateNotice } = await import('../src/update.js');
const { imageTag } = await import('../src/config.js');

const release = (tag) => async () => ({
  ok: true,
  json: async () => ({ tag_name: tag, published_at: '2026-09-19T00:00:00Z' }),
});

const cache = (name) => path.join(root, `${name}.json`);

test('версии сравниваются числами, а не строками', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, 'строкой 0.10.0 меньше 0.9.0 — это и ловим');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0, 'недостающие части считаются нулями');
  assert.equal(compareVersions('1.2.0', '1.2.0-rc1'), 1, 'релиз новее своего предрелиза');
});

test('тег образа берётся из BUNDLE_IMAGE и только из него', () => {
  assert.equal(imageTag('ghcr.io/acme/app:1.2.3'), '1.2.3');
  assert.equal(imageTag('ghcr.io/acme/app'), null, 'без тега сравнивать не с чем');
  assert.equal(imageTag('localhost:5000/acme/app'), null, 'двоеточие в адресе реестра — это порт');
  assert.equal(imageTag('localhost:5000/acme/app:0.4'), '0.4');
  assert.equal(imageTag('ghcr.io/acme/app@sha256:abc'), null, 'дайджест тега не несёт');
  assert.equal(imageTag(''), null);
  assert.equal(imageTag(), '1.0.0', 'без аргумента читается BUNDLE_IMAGE стенда');
});

test('отставшая версия видна, и к ней приложен порядок обновления', async () => {
  const res = await checkForUpdate({
    fetchImpl: release('v1.1.0'),
    cacheFile: cache('behind'),
    enabled: true,
  });

  assert.equal(res.updateAvailable, true);
  assert.equal(res.latest, '1.1.0');
  assert.ok(res.upgrade.fromImage.some((step) => step.includes('docker pull')));
  assert.ok(res.upgrade.files['docker-compose.yml'].includes('v1.1.0'),
    'файлы релиза — часть обновления: новый образ со старым compose поднимется неверно');
  assert.match(updateNotice(res), /1\.0\.0 → 1\.1\.0/);
});

test('актуальная версия не поднимает тревогу', async () => {
  const res = await checkForUpdate({ fetchImpl: release('1.0.0'), cacheFile: cache('same'), enabled: true });
  assert.equal(res.updateAvailable, false);
  assert.equal(res.upgrade, undefined);
  assert.equal(updateNotice(res), null);
});

test('плавающий тег — честное «неизвестно» с подсказкой, а не «всё хорошо»', async () => {
  process.env.BUNDLE_IMAGE = 'ghcr.io/acme/app:latest';
  try {
    const res = await checkForUpdate({ fetchImpl: release('1.1.0'), cacheFile: cache('floating'), enabled: true });
    assert.equal(res.updateAvailable, null);
    assert.match(res.undetermined, /latest/);
    assert.match(res.hint, /BUNDLE_IMAGE=/);
    assert.ok(res.upgrade, 'порядок обновления нужен и здесь — чтобы закрепить тег');
  } finally {
    process.env.BUNDLE_IMAGE = 'ghcr.io/acme/app:1.0.0';
  }
});

test('недоступный GitHub не ломает старт, а отвечает «неизвестно»', async () => {
  const res = await checkForUpdate({
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
    cacheFile: cache('offline'),
    enabled: true,
  });

  assert.equal(res.updateAvailable, null);
  assert.match(res.unavailable, /ENOTFOUND/);
  assert.equal(updateNotice(res), null);
});

test('ответ GitHub кэшируется: перезапуски не расходуют лимит', async () => {
  let calls = 0;
  const counting = async (...args) => { calls += 1; return release('1.1.0')(...args); };
  const file = cache('ttl');

  await checkForUpdate({ fetchImpl: counting, cacheFile: file, enabled: true });
  const second = await checkForUpdate({ fetchImpl: counting, cacheFile: file, enabled: true });
  assert.equal(calls, 1, 'второй запрос взят из кэша');
  assert.equal(second.fromCache, true);

  // Через семь часов кэш протух.
  const later = await checkForUpdate({
    fetchImpl: counting,
    cacheFile: file,
    enabled: true,
    now: Date.now() + 7 * 60 * 60 * 1000,
  });
  assert.equal(calls, 2);
  assert.equal(later.fromCache, false);
});

test('в кэше лежит ответ GitHub, а не вывод сравнения', async () => {
  const file = cache('compare');
  await checkForUpdate({ fetchImpl: release('1.1.0'), cacheFile: file, enabled: true });

  // Обновились: тег в BUNDLE_IMAGE стал новым, кэш остался прежним. Стенд обязан сразу
  // сказать «обновлений нет», а не повторять вчерашнее «доступно обновление».
  process.env.BUNDLE_IMAGE = 'ghcr.io/acme/app:1.1.0';
  try {
    const res = await checkForUpdate({ fetchImpl: release('1.1.0'), cacheFile: file, enabled: true });
    assert.equal(res.fromCache, true);
    assert.equal(res.updateAvailable, false);
  } finally {
    process.env.BUNDLE_IMAGE = 'ghcr.io/acme/app:1.0.0';
  }
});

test('выключенная проверка не ходит в сеть вовсе', async () => {
  let called = false;
  const res = await checkForUpdate({
    fetchImpl: async () => { called = true; throw new Error('не должно случиться'); },
    cacheFile: cache('off'),
    enabled: false,
  });

  assert.equal(called, false);
  assert.equal(res.disabled, true);
  assert.equal(res.updateAvailable, null);
});

test('порядок обновления называет и образ, и файлы релиза', () => {
  const steps = upgradeSteps('2.0.0');
  assert.match(steps.image, /:2\.0\.0$/);
  assert.equal(Object.keys(steps.files).length, 3);
  assert.ok(steps.files['.env.example'].endsWith('default.env.example'),
    'GitHub не принимает имена ассетов с точки в начале');
  assert.match(steps.note, /CR_MASTER_KEY/, 'про ключ надо предупредить: с другим секреты не прочитать');
  assert.ok(steps.fromSource.some((step) => step.includes('dockerbundle generate')));
});
