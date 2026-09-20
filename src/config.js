// Единственное место, где читается окружение. Всё остальное берёт значения отсюда:
// иначе умолчание «сколько ждать подтверждения» разъезжается по трём файлам.

const int = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

const str = (name, def = '') => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
};

export const cfg = {
  lang: str('CR_LANG', 'ru'),
  port: int('MCP_PORT', 8932),
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://127.0.0.1:${int('MCP_PORT', 8932)}`),

  masterKey: str('CR_MASTER_KEY'),
  masterKeyFile: str('CR_MASTER_KEY_FILE'),

  // Подтверждения
  policy: str('CR_POLICY', 'base'),
  approveTimeoutMs: int('CR_APPROVE_TIMEOUT', 300) * 1000,

  // Журнал
  logMaxBytes: int('CR_LOG_MAX_BYTES', 1024 * 1024 * 1024),
  logFileBytes: int('CR_LOG_FILE_BYTES', 64 * 1024 * 1024),
  logInlineBytes: int('CR_LOG_INLINE_BYTES', 256 * 1024),

  // Потолки ответов агенту
  maxTextBytes: int('CR_MAX_TEXT_BYTES', 128 * 1024),
  dbMaxRows: int('CR_DB_MAX_ROWS', 500),
  maxUploadBytes: int('CR_MAX_UPLOAD_BYTES', 256 * 1024 * 1024),
  // Потолок вывода одной команды в памяти: без него cat большого файла кладёт сервер
  maxOutputBytes: int('CR_MAX_OUTPUT_BYTES', 32 * 1024 * 1024),

  // Заметки: факт — одна короткая строка; жизнь меряется сессиями, читавшими проект.
  // Столько сессий без чтения значения — факт устаревший, ещё столько — удаляется сам.
  notesValueMax: int('CR_NOTES_VALUE_MAX', 200),
  notesStaleSessions: int('CR_NOTES_STALE_SESSIONS', 15),
  notesExpireSessions: int('CR_NOTES_EXPIRE_SESSIONS', 5),

  // Транспорт
  sshIdleMs: int('CR_SSH_IDLE_MS', 300_000),
  execTimeoutMs: int('CR_EXEC_TIMEOUT', 120_000),

  // Проверка обновлений. Выключается целиком — для контуров без выхода наружу, где запрос
  // к GitHub всё равно упрётся в таймаут. Репозиторий и образ переопределяются для форков.
  updateCheck: str('CR_UPDATE_CHECK', '1') !== '0',
  updateRepo: str('CR_UPDATE_REPO', 'cat-of-summer/ConnectionRegistry---mcp-package'),
  updateImage: str('CR_UPDATE_IMAGE', 'ghcr.io/cat-of-summer/connectionregistry---mcp-package'),
};

/**
 * Версия стенда — это тег образа, и источник у него ровно один: BUNDLE_IMAGE из .env, тот самый
 * ref, который правят руками при обновлении. Второй записи того же факта нет намеренно: версии
 * кода, нумерующейся отдельно от релизов, не с чем сравнивать, и она только сбивает с толку.
 */
export function imageTag(ref = process.env.BUNDLE_IMAGE) {
  const value = String(ref ?? '').trim();
  if (!value) return null;

  // Дайджест сильнее тега: ghcr.io/owner/app@sha256:… тега не несёт вовсе.
  const name = value.split('@')[0];
  const colon = name.lastIndexOf(':');
  if (colon < 0) return null;

  // Двоеточие в имени реестра — это порт (localhost:5000/app), а не тег: у тега слешей нет.
  const tag = name.slice(colon + 1);
  return tag && !tag.includes('/') ? tag : null;
}

cfg.version = imageTag() ?? 'unknown';

export default cfg;
