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
  approveTimeoutMs: int('CR_APPROVE_TIMEOUT', 300) * 1000,
  // Политика по умолчанию для подключения, у которого не задана своя
  defaultConfirmPolicy: str('CR_CONFIRM_POLICY', 'writes'),

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

  // Транспорт
  sshIdleMs: int('CR_SSH_IDLE_MS', 300_000),
  execTimeoutMs: int('CR_EXEC_TIMEOUT', 120_000),

  version: str('CR_VERSION', str('BUNDLE_IMAGE', '').split(':').pop() || 'unknown'),
};

export default cfg;
