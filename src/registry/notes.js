import { cfg } from '../config.js';
import * as audit from '../audit/log.js';
import { db, now } from './db.js';
import { assertProject, requireProject, projects, getProjectRow } from './projects.js';

// Заметки — короткие факты о проекте, нужные для деплоя и операций на его серверах:
// путь до кода, версия PHP, чем гонять artisan, куда класть дамп. Свободного текста нет
// намеренно: в него уходит всё подряд, а факт с ключом можно измерить — читали его или нет.
//
// Жизнь факта считается сессиями, читавшими проект, а не календарём: проект, к которому не
// прикасались полгода, ничего не теряет. Список отдаёт только ключи и статусы; значение
// выдаётся по явному запросу, и именно это чтение продлевает факту жизнь. Факт, чьё
// значение не запрашивали CR_NOTES_STALE_SESSIONS сессий, помечается устаревшим, а ещё
// через CR_NOTES_EXPIRE_SESSIONS удаляется — с записью в журнал, откуда его можно вернуть.

export const KEY_MAX = 64;

// Сессия, читавшая проект, считается один раз: пара (сессия, проект) живёт в памяти
// столько же, сколько сессия MCP. CLI сессии не имеет и счётчик не двигает.
const seen = new Map(); // sessionId -> Set<project>

function beginRead(project, sessionId) {
  const row = getProjectRow(project);
  if (!row) throw new Error(`проект «${project}» не заведён`);
  if (!sessionId) return row.read_sessions;

  let set = seen.get(sessionId);
  if (!set) { set = new Set(); seen.set(sessionId, set); }
  if (set.has(project)) return row.read_sessions;

  set.add(project);
  db().prepare('UPDATE projects SET read_sessions = read_sessions + 1 WHERE name = ?').run(project);
  return row.read_sessions + 1;
}

export function forgetSession(sessionId) {
  seen.delete(sessionId);
}

function statusOf(age) {
  if (age >= cfg.notesStaleSessions + cfg.notesExpireSessions) return 'expired';
  if (age >= cfg.notesStaleSessions) return 'stale';
  return 'fresh';
}

/**
 * Удаляет факты, пережившие срок. Каждый уходит через журнал целиком — ключом и значением:
 * это единственное место, откуда стёртое можно вернуть.
 */
export function sweep(project) {
  const row = getProjectRow(project);
  if (!row) return [];
  const limit = row.read_sessions - (cfg.notesStaleSessions + cfg.notesExpireSessions);
  const gone = db().prepare('SELECT key, value, read_seq FROM notes_facts WHERE project = ? AND read_seq <= ?')
    .all(project, limit);
  if (!gone.length) return [];

  db().prepare('DELETE FROM notes_facts WHERE project = ? AND read_seq <= ?').run(project, limit);
  for (const fact of gone) {
    // Поле зовётся fact, а не key: журнал маскирует всё похожее на секрет, а ключ факта — не он.
    const entry = audit.start({
      tool: 'notes_expire',
      alias: project,
      args: { fact: fact.key, value: fact.value, sessionsUnread: row.read_sessions - fact.read_seq },
      kind: 'notes',
    });
    audit.finish(entry, { ok: true, stdout: `факт «${fact.key}» не читали ${row.read_sessions - fact.read_seq} сессий — удалён` });
  }
  return gone.map((f) => f.key);
}

export function sweepAll() {
  return Object.fromEntries(projects().map((name) => [name, sweep(name)]).filter(([, keys]) => keys.length));
}

// Ключ и ничего лишнего; пометка появляется только у устаревшего — свежий факт в
// объяснениях не нуждается.
function factView(row, readSessions) {
  const view = { key: row.key };
  if (statusOf(readSessions - row.read_seq) !== 'fresh') view.stale = true;
  return view;
}

/**
 * Ключи без значений, недавно читанные сверху: что знать о проекте, агент выбирает по
 * имени, а порядок подсказывает, что в этом проекте обычно нужно.
 */
export function listFacts(project, sessionId) {
  assertProject(project);
  const readSessions = beginRead(project, sessionId);
  sweep(project);
  const rows = db().prepare('SELECT key, read_seq FROM notes_facts WHERE project = ? ORDER BY read_seq DESC, key')
    .all(project);
  return { project, facts: rows.map((r) => factView(r, readSessions)) };
}

/** Значения названных ключей. Это и есть чтение факта: оно сбрасывает его возраст. */
export function readFacts(project, keys, sessionId) {
  assertProject(project);
  const wanted = [...new Set((keys ?? []).map((k) => String(k).trim()).filter(Boolean))];
  if (!wanted.length) throw new Error('назовите ключи фактов, которые нужно прочитать');

  const readSessions = beginRead(project, sessionId);
  sweep(project);
  const select = db().prepare('SELECT key, value, updated_at FROM notes_facts WHERE project = ? AND key = ?');
  const touch = db().prepare('UPDATE notes_facts SET read_seq = ? WHERE project = ? AND key = ?');

  const facts = {};
  const updatedAt = {};
  const missing = [];
  db().transaction(() => {
    for (const key of wanted) {
      const row = select.get(project, key);
      if (!row) { missing.push(key); continue; }
      touch.run(readSessions, project, key);
      facts[key] = row.value;
      updatedAt[key] = row.updated_at;
    }
  })();

  return { project, facts, updatedAt, missing };
}

export function setFact(project, key, value, sessionId) {
  requireProject(project);
  const name = String(key ?? '').trim();
  if (!name || /\s/.test(name)) throw new Error('ключ факта — слово без пробелов, например deploy.path');
  if (name.length > KEY_MAX) throw new Error(`ключ факта длиннее ${KEY_MAX} символов`);

  const body = String(value ?? '').trim();
  if (!body) throw new Error('у факта должно быть значение');
  if (/[\r\n]/.test(body)) throw new Error('значение факта — одна строка; несколько мыслей — несколько фактов');
  if (body.length > cfg.notesValueMax) {
    throw new Error(`значение длиннее ${cfg.notesValueMax} символов (CR_NOTES_VALUE_MAX) — разбейте на несколько фактов или оставьте суть`);
  }

  const readSessions = beginRead(project, sessionId);
  db().prepare(`INSERT INTO notes_facts (project, key, value, updated_at, read_seq) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
    read_seq = excluded.read_seq`)
    .run(project, name, body, now(), readSessions);
  return { project, key: name, value: body, updatedAt: now() };
}

export function removeFact(project, key) {
  assertProject(project);
  const res = db().prepare('DELETE FROM notes_facts WHERE project = ? AND key = ?').run(project, key);
  if (res.changes === 0) throw new Error(`у проекта «${project}» нет факта «${key}»`);
  return { project, key, removed: true };
}

/**
 * Фильтр по ключам и значениям — во всех проектах или в одном. Отдаёт только ключи:
 * поиск подсказывает, что прочитать, а само чтение остаётся явным.
 */
export function searchNotes(query, { project } = {}) {
  const like = `%${String(query ?? '').trim().toLowerCase()}%`;
  if (like === '%%') throw new Error('пустой запрос: назовите часть ключа или значения');
  if (project) assertProject(project);
  sweepAll();

  const rows = db().prepare(`SELECT f.project, f.key, f.read_seq, p.read_sessions,
        (lower(f.key) LIKE @like) AS by_key
      FROM notes_facts f JOIN projects p ON p.name = f.project
      WHERE (lower(f.key) LIKE @like OR lower(f.value) LIKE @like)
        ${project ? 'AND f.project = @project' : ''}
      ORDER BY f.project, f.read_seq DESC, f.key`).all(project ? { like, project } : { like });

  return {
    query,
    facts: rows.map((r) => ({
      project: r.project,
      ...factView(r, r.read_sessions),
      matched: r.by_key ? 'key' : 'value',
    })),
  };
}
