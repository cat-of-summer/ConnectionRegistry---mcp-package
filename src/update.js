/**
 * Проверка обновлений стенда.
 *
 * Три требования, каждое из которых легко нарушить:
 *
 *   1. Не мешать работе. GitHub может не ответить, лежать, ограничить по частоте, а стенд с
 *      ключами от боевых серверов вполне может стоять в контуре без выхода наружу. Ни один такой
 *      случай не должен ни задержать запуск, ни уронить его: проверка обёрнута в таймаут и в
 *      try/catch, и любой отказ означает «неизвестно», а не ошибку.
 *   2. Не долбить чужой сервер. Неавторизованный лимит GitHub — 60 запросов в час на адрес, а
 *      сервер перезапускается легко. Ответ кладётся в кэш и переспрашивается не чаще раза в
 *      шесть часов, в том числе после перезапуска.
 *   3. Сказать не только «есть обновление», но и что с ним делать. Уведомление без инструкции
 *      заставляет агента гадать или лезть в интернет за документацией.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg, imageTag } from './config.js';
import { DIRS } from './paths.js';
import { pick } from './i18n.js';

// Кэш лежит в томе registry, а не в запечённом в образ каталоге: иначе он терялся бы при каждом
// пересоздании контейнера — то есть ровно тогда, когда стенд обновляют и перезапускают чаще всего.
const CACHE_FILE = path.join(DIRS.registry, '.update-check.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

export const UPDATE = {
  repo: cfg.updateRepo,
  image: cfg.updateImage,
  enabled: cfg.updateCheck,
  releases: `https://github.com/${cfg.updateRepo}/releases`,
  api: `https://api.github.com/repos/${cfg.updateRepo}/releases/latest`,
};

/**
 * Годится ли строка на роль версии, с которой можно сравнивать.
 *
 * Плавающие теги (latest, stable), имена веток и пустота версиями не являются. Стенд на теге
 * latest не может сказать, отстал он или нет, и обязан отвечать «неизвестно»: молчаливое
 * «всё хорошо» здесь хуже честного «не знаю».
 */
function comparable(value) {
  return /^v?\d+(\.\d+)*$/i.test(String(value ?? '').trim());
}

/** Сравнение версий по числам, а не строкой: '0.10.0' строкой меньше '0.9.0'. */
export function compareVersions(a, b) {
  const parse = (v) => String(v || '')
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;

    // Части кончились у одной стороны, а у другой начался хвост вроде -rc1: релиз старше
    // своего предрелиза. Иначе стенд на 1.2.0 предлагал бы «обновиться» до 1.2.0-rc1.
    if (left[i] === undefined) return 1;
    if (right[i] === undefined) return -1;

    // Оба хвоста нечисловые — сравниваем как строки: точной семантики предрелизов тут не нужно,
    // важно лишь не соврать про «новее».
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

async function readCache(cacheFile, now) {
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (now - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS) return cached;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cacheFile, data) {
  // Кэш — удобство, а не состояние: не записался, значит в следующий раз спросим ещё раз.
  await fs.writeFile(cacheFile, JSON.stringify(data, null, 2), 'utf8').catch(() => {});
}

async function fetchLatest(fetchImpl) {
  const res = await fetchImpl(UPDATE.api, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'connection-registry-mcp' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const data = await res.json();
  return { tag: String(data.tag_name || '').replace(/^v/i, ''), publishedAt: data.published_at || null };
}

/**
 * Как обновляться. Текст живёт здесь, а не в README, потому что читать его будет агент: увидев
 * обновление, он должен сразу понимать порядок действий, не уходя за документацией.
 */
export function upgradeSteps(tag) {
  const version = tag || 'НОВАЯ_ВЕРСИЯ';
  const assets = `${UPDATE.releases}/download/v${version}`;

  // Файлы релиза — часть обновления, а не справочный материал. docker-compose.yml описывает
  // порты, тома и healthcheck; между версиями там появляются новые тома и меняются проверки
  // готовности, и новый образ со старым compose поднимается неверно или не поднимается вовсе.
  // Имя ассета у .env.example — default.env.example: GitHub не принимает имена с точки в начале.
  const files = {
    'docker-compose.yml': `${assets}/docker-compose.yml`,
    '.env.example': `${assets}/default.env.example`,
    'docker-bundle.lock.yml': `${assets}/docker-bundle.lock.yml`,
  };

  return {
    releases: UPDATE.releases,
    image: `${UPDATE.image}:${version}`,
    files,
    fromImage: [
      `docker pull ${UPDATE.image}:${version}`,
      `скачать ${files['docker-compose.yml']} и заменить им docker-compose.yml стенда`,
      `скачать ${files['.env.example']} и сверить со своим .env: перенести появившиеся ключи, `
        + 'свои значения при этом не терять — .env целиком не перезаписывать',
      `в .env выставить BUNDLE_IMAGE=${UPDATE.image}:${version}`,
      'docker compose up -d',
    ],
    fromSource: [
      'git pull и git submodule update --remote',
      'dockerbundle generate — пересобрать dist/ из docker-bundle.yml',
      'docker compose up -d --build',
    ],
    note: 'Реестр, журнал, загрузки и артефакты лежат в томах и обновление переживают. '
      + 'Единственный файл, который правится руками и не берётся из релиза, — .env, '
      + 'а в нём главное — CR_MASTER_KEY: с другим ключом секреты не расшифруются.',
  };
}

export async function checkForUpdate({
  force = false,
  fetchImpl = (...args) => globalThis.fetch(...args),
  cacheFile = CACHE_FILE,
  enabled = UPDATE.enabled,
  now = Date.now(),
} = {}) {
  const current = { imageTag: imageTag() };

  // Выключатель нужен стендам без выхода наружу: там проверка каждый раз упирается в таймаут,
  // и четыре секунды на старте платятся впустую.
  if (!enabled) return { current, updateAvailable: null, disabled: true };

  // В кэше лежит только ответ GitHub: тег и дата релиза. Сравнение с текущим тегом делается при
  // каждом чтении, а не запоминается, — иначе после обновления стенд ещё шесть часов сообщал бы
  // «доступно обновление», сравнивая новый тег со снятым до него результатом.
  try {
    let latest = null;
    let fromCache = false;

    if (!force) {
      const cached = await readCache(cacheFile, now);
      if (cached?.latest) {
        latest = { tag: cached.latest, publishedAt: cached.publishedAt, checkedAt: cached.checkedAt };
        fromCache = true;
      }
    }

    if (!latest) {
      const fetched = await fetchLatest(fetchImpl);
      latest = { ...fetched, checkedAt: new Date().toISOString() };
      await writeCache(cacheFile, { checkedAt: latest.checkedAt, latest: latest.tag, publishedAt: latest.publishedAt });
    }

    const base = current.imageTag;
    const known = comparable(base);
    const behind = known && compareVersions(latest.tag, base) > 0;

    return {
      checkedAt: latest.checkedAt,
      latest: latest.tag,
      publishedAt: latest.publishedAt,
      current,
      fromCache,
      updateAvailable: known ? behind : null,
      ...(known ? {} : {
        undetermined: base
          ? `BUNDLE_IMAGE указывает на тег ${base} — это не версия, сравнивать не с чем.`
          : 'BUNDLE_IMAGE не задан или указан без тега — сравнивать не с чем.',
        hint: `Закрепите версию: BUNDLE_IMAGE=${UPDATE.image}:${latest.tag} в .env стенда. `
          + 'До этого стенд не может сказать, отстал он или нет.',
      }),
      // Порядок обновления отдаём и когда сравнить не вышло: он там и нужен — чтобы закрепить тег.
      ...(behind || !known ? { upgrade: upgradeSteps(latest.tag) } : {}),
    };
  } catch (err) {
    // Недоступность GitHub — не повод для тревоги в отчёте: стенд вполне может стоять в закрытом
    // контуре. Говорим «неизвестно» и живём дальше.
    return {
      checkedAt: new Date().toISOString(),
      current,
      updateAvailable: null,
      unavailable: err.message,
      releases: UPDATE.releases,
    };
  }
}

/** Короткая строка для instructions: агент должен увидеть её, не вызывая ничего. */
export function updateNotice(result) {
  if (!result || result.updateAvailable !== true) return null;

  return pick({
    ru: `Доступно обновление стенда: ${result.current.imageTag} → ${result.latest}. `
      + `Образ ${UPDATE.image}:${result.latest}. Порядок обновления — в registry_info, поле «обновление». `
      + 'На работу это не влияет: всё продолжает работать на текущей версии.',
    en: `A registry update is available: ${result.current.imageTag} → ${result.latest}. `
      + `Image ${UPDATE.image}:${result.latest}. Upgrade steps are in registry_info, field update. `
      + 'Nothing is blocked: everything keeps working on the current version.',
  });
}
