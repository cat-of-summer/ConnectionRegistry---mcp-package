import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { DIRS, ensureDirs } from '../paths.js';
import { redact, scrub } from '../secrets.js';

// Журнал для разбора — не журнал действий. Журнал действий отвечает «что сделали» и хранит
// всё целиком; этот отвечает «где агенту было трудно» и не хранит содержимого вовсе: ни
// вывода, ни значений аргументов — только форму вызова, исход и трение вокруг него.
// Из него потом вычитываются доработки: какие ошибки повторяются, где агент упирается в
// потолки, какие вопросы человек подтверждает не глядя, где агент идёт в обход.
//
// Выключен по умолчанию (CR_INSIGHTS=1 включает): разбор нужен тому, кто развивает стенд,
// а не каждому, кто им пользуется.

const COMMAND_MAX = 400;
const ERROR_MAX = 300;

// Класс ошибки — чтобы считать, а не читать. Код, если его поставил сам реестр, иначе по тексту.
const ERROR_CLASSES = [
  ['tunnel_closed', /не открыл канал|запрещает проброс|Channel open failure/i],
  ['timeout', /таймаут|timed? ?out|ETIMEDOUT/i],
  ['auth', /Access denied|password authentication failed|All configured authentication methods failed|не найден пароль|не найден приватный ключ/i],
  ['unreachable', /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|getaddrinfo/i],
  ['kind_mismatch', /подключение типа .*работает с/],
  ['not_imported', /ещё не прочитаны с хоста/],
  ['sql', /syntax|ERROR \d+|ошибка синтаксиса|does not exist|doesn't exist|read-only transaction/i],
  ['too_big', /CR_MAX_OUTPUT_BYTES|обрезан|больше .* Б/],
  ['refused_statements', /Выполняйте по одному/],
];

export function errorClass(err) {
  if (!err) return null;
  // Коды реестра — слова (host_key, secret_in_args). SQLSTATE драйвера (25006) и системные
  // (ECONNREFUSED) кодами класса не считаются: они разбираются ниже по тексту.
  if (typeof err.code === 'string' && /^[a-z_]+$/.test(err.code)) return err.code;
  if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return 'sql';
  if (err.name === 'Declined') return 'not_approved';
  const message = String(err.message || err);
  for (const [name, re] of ERROR_CLASSES) if (re.test(message)) return name;
  return 'error';
}

// Последний вызов каждой сессии — чтобы узнать повтор и «обход после отказа» без второго прохода.
const lastBySession = new Map();
const seenSessions = new Set();

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12);

/** Форма аргументов: какие поля переданы и какого размера, без значений. */
export function argShape(args = {}) {
  const shape = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'alias' || key === 'project') continue;
    if (value === undefined) continue;
    if (typeof value === 'string') shape[key] = value.startsWith('cr://') ? value.replace(/#.*$/, '#…').replace(/^(cr:\/\/[a-z]+\/).*$/, '$1…') : `${Buffer.byteLength(value)} Б`;
    else if (Array.isArray(value)) shape[key] = `[${value.length}]`;
    else if (value && typeof value === 'object') shape[key] = `{${Object.keys(value).join(',')}}`;
    else shape[key] = typeof value === 'boolean' || typeof value === 'number' ? value : typeof value;
  }
  return shape;
}

/** Сколько раз известные секреты встретились в ответе: агент дочитался до пароля руками. */
export function secretHits(payload, secrets = []) {
  if (!secrets.length || payload === null || payload === undefined) return 0;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let hits = 0;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    hits += text.split(secret).length - 1;
  }
  return hits;
}

const clean = (text, secrets, max) => (text ? redact(scrub(String(text), secrets)).slice(0, max) : null);

function file(date = new Date()) {
  ensureDirs();
  const dir = path.join(DIRS.logs, 'insights');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

function rotate() {
  const dir = path.join(DIRS.logs, 'insights');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
  let total = files.reduce((sum, n) => sum + fs.statSync(path.join(dir, n)).size, 0);
  while (total > cfg.insightsMaxBytes && files.length > 1) {
    const oldest = path.join(dir, files.shift());
    total -= fs.statSync(oldest).size;
    fs.rmSync(oldest, { force: true });
  }
}

function write(event) {
  try {
    fs.appendFileSync(file(), `${JSON.stringify(event)}\n`);
    rotate();
  } catch {
    // Разбор — не то, из-за чего можно уронить вызов.
  }
}

export const enabled = () => cfg.insights;

/** Сессия пишется один раз — при первом вызове: клиент, его версия, умеет ли он спрашивать. */
export function session(ctx) {
  if (!enabled() || !ctx?.sessionId || seenSessions.has(ctx.sessionId)) return;
  seenSessions.add(ctx.sessionId);
  const inner = ctx.server?.server;
  write({
    type: 'session',
    ts: new Date().toISOString(),
    session: ctx.sessionId,
    client: inner?.getClientVersion?.() ?? null,
    elicitation: Boolean(inner?.getClientCapabilities?.()?.elicitation),
    policy: cfg.policy,
    version: cfg.version,
  });
}

/**
 * Один вызов инструмента. call — то, что собрала обёртка по ходу:
 *   tool, group, kind, project, host, mutating, writeSigns, guard, args, approval, approvalMs,
 *   durationMs, ok, error, result, payload, secrets, command.
 */
export function call(ctx, c) {
  if (!enabled()) return;
  const sessionId = ctx?.sessionId ?? null;
  const argsHash = hash({ tool: c.tool, args: c.args });
  const previous = sessionId ? lastBySession.get(sessionId) : null;

  const payload = c.payload;
  const responseBytes = payload === null || payload === undefined ? 0 : Buffer.byteLength(JSON.stringify(payload));
  const data = payload && typeof payload === 'object' ? payload : {};

  const event = {
    type: 'call',
    ts: new Date().toISOString(),
    session: sessionId,
    seq: previous ? previous.seq + 1 : 1,
    tool: c.tool,
    group: c.group,
    kind: c.kind ?? null,
    project: c.project ?? null,
    host: c.host ?? null,
    args: argShape(c.args),
    command: clean(c.command, c.secrets || [], COMMAND_MAX),
    mutating: c.mutating ?? null,
    writeSigns: c.writeSigns ?? null,
    guard: c.guard ? c.guard.reasons : null,
    approval: c.approval
      ? {
        // Сколько вопросов задано человеку этим вызовом: ступеней бывает несколько.
        asked: c.approval.questions ?? (c.approval.id ? 1 : 0),
        status: c.approval.status ?? null,
        scope: c.approval.scope ?? null,
        via: c.approval.via ?? null,
        waitMs: c.approvalMs ?? null,
      }
      : null,
    ok: c.ok,
    error: c.error ? { class: errorClass(c.error), message: clean(c.error.message, c.secrets || [], ERROR_MAX) } : null,
    exitCode: c.result?.exitCode ?? null,
    durationMs: c.durationMs,
    responseBytes,
    // Потолки: ответ агенту, вывод команды в памяти, строки выборки. Упёрся — значит, нужен
    // был другой путь (артефакт, дамп, выборка уже), и агент его, возможно, не знал.
    limits: {
      response: responseBytes > cfg.maxTextBytes,
      output: Boolean(data.truncated && c.group === 'shell'),
      rows: Boolean(data.truncated && c.group === 'db'),
    },
    artifact: Boolean(data.uri && String(data.uri).startsWith('cr://artifacts/')),
    warning: data.warning ? clean(data.warning, c.secrets || [], ERROR_MAX) : null,
    secretHits: secretHits(payload, c.secrets || []),
    retry: Boolean(previous && previous.argsHash === argsHash && previous.ok === false),
    afterFailure: previous && previous.ok === false
      ? { tool: previous.tool, class: previous.errorClass, sameTool: previous.tool === c.tool }
      : null,
  };

  write(event);
  if (sessionId) {
    lastBySession.set(sessionId, {
      seq: event.seq, argsHash, ok: c.ok, tool: c.tool, errorClass: event.error?.class ?? null,
    });
  }
}

function* events(days) {
  const dir = path.join(DIRS.logs, 'insights');
  if (!fs.existsSync(dir)) return;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && n.slice(0, 10) >= since).sort()) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { /* битая строка — пропускаем */ }
    }
  }
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const top = (map, n = 10) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));

/**
 * Сводка за days дней — то, с чего начинать разбор: частые ошибки, вопросы, которые человек
 * подтверждает не глядя, потолки, повторы и обходы, секреты, дочитанные руками.
 */
export function summary({ days = 30 } = {}) {
  const sessions = new Map();
  const tools = new Map();
  const errors = new Map();
  const guardSigns = new Map();
  const limits = new Map();
  const retries = new Map();
  const afterFailure = new Map();
  const secretReads = new Map();
  const slow = new Map();
  let calls = 0;
  let asked = 0;
  let waitMs = 0;

  for (const e of events(days)) {
    if (e.type === 'session') {
      const name = e.client ? `${e.client.name} ${e.client.version}` : 'неизвестный клиент';
      bump(sessions, `${name}${e.elicitation ? '' : ' (не умеет спрашивать)'}`);
      continue;
    }
    if (e.type !== 'call') continue;
    calls++;
    bump(tools, e.tool);
    if (e.error) bump(errors, `${e.tool}: ${e.error.class}`);
    if (e.approval?.asked) { asked += e.approval.asked; waitMs += e.approval.waitMs || 0; }
    for (const reason of e.guard || []) bump(guardSigns, `${reason} → ${e.approval?.status || 'нет ответа'}`);
    for (const [limit, hit] of Object.entries(e.limits || {})) if (hit) bump(limits, `${e.tool}: ${limit}${e.artifact ? ' (артефакт)' : ''}`);
    if (e.retry) bump(retries, `${e.tool}: ${e.afterFailure?.class || 'error'}`);
    if (e.afterFailure && !e.afterFailure.sameTool) bump(afterFailure, `${e.afterFailure.tool} (${e.afterFailure.class}) → ${e.tool}`);
    if (e.secretHits) bump(secretReads, `${e.tool}${e.host ? ` @ ${e.host}` : ''}`, e.secretHits);
    if (e.durationMs > 10_000) bump(slow, e.tool);
  }

  return {
    period: `${days} дн.`,
    calls,
    sessions: top(sessions),
    tools: top(tools, 15),
    errors: top(errors, 15),
    questions: { asked, perCall: calls ? Number((asked / calls).toFixed(2)) : 0, avgWaitMs: asked ? Math.round(waitMs / asked) : 0 },
    guardSigns: top(guardSigns, 15),
    limits: top(limits),
    retries: top(retries),
    afterFailure: top(afterFailure),
    secretReads: top(secretReads),
    slowOver10s: top(slow),
  };
}
