import { db, now } from './db.js';
import { PROJECT_RE } from './schema.js';

// Заметки — технические факты о проекте, которые агент иначе переоткрывает каждую
// сессию: путь до кода, версия PHP, имя контейнера с очередью. Ключ проекта тот же,
// что слева в алиасе подключения, поэтому знание и доступ лежат под одним именем.

function assertProject(project) {
  if (!PROJECT_RE.test(String(project || ''))) {
    throw new Error(`имя проекта — одно слово строчными буквами: получено «${project}»`);
  }
  return project;
}

export function getNotes(project) {
  assertProject(project);
  const facts = db().prepare('SELECT key, value, updated_at FROM notes_facts WHERE project = ? ORDER BY key')
    .all(project);
  const text = db().prepare('SELECT body, updated_at FROM notes_text WHERE project = ?').get(project);
  return {
    project,
    facts: Object.fromEntries(facts.map((f) => [f.key, f.value])),
    factsUpdatedAt: Object.fromEntries(facts.map((f) => [f.key, f.updated_at])),
    text: text ? text.body : null,
    textUpdatedAt: text ? text.updated_at : null,
  };
}

export function setFact(project, key, value) {
  assertProject(project);
  if (!key || /\s/.test(key)) throw new Error('ключ факта — слово без пробелов, например php.version');
  db().prepare(`INSERT INTO notes_facts (project, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(project, key, String(value), now());
  return getNotes(project);
}

export function setText(project, body) {
  assertProject(project);
  db().prepare(`INSERT INTO notes_text (project, body, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`)
    .run(project, String(body), now());
  return getNotes(project);
}

export function removeFact(project, key) {
  assertProject(project);
  const res = db().prepare('DELETE FROM notes_facts WHERE project = ? AND key = ?').run(project, key);
  if (res.changes === 0) throw new Error(`у проекта «${project}» нет факта «${key}»`);
  return getNotes(project);
}

export function removeText(project) {
  assertProject(project);
  db().prepare('DELETE FROM notes_text WHERE project = ?').run(project);
  return getNotes(project);
}

export function removeProject(project) {
  assertProject(project);
  db().transaction(() => {
    db().prepare('DELETE FROM notes_facts WHERE project = ?').run(project);
    db().prepare('DELETE FROM notes_text WHERE project = ?').run(project);
  })();
  return { project, removed: true };
}

/** Поиск по ключам, значениям и свободному тексту. Один запрос вместо чтения всего подряд. */
export function searchNotes(query) {
  const like = `%${String(query).toLowerCase()}%`;
  const facts = db().prepare(`SELECT project, key, value, updated_at FROM notes_facts
      WHERE lower(key) LIKE ? OR lower(value) LIKE ? ORDER BY project, key`).all(like, like);
  const texts = db().prepare('SELECT project, body, updated_at FROM notes_text WHERE lower(body) LIKE ?').all(like);
  return {
    query,
    facts: facts.map((f) => ({ project: f.project, key: f.key, value: f.value, updatedAt: f.updated_at })),
    texts: texts.map((t) => ({ project: t.project, excerpt: excerpt(t.body, query), updatedAt: t.updated_at })),
  };
}

function excerpt(body, query) {
  const at = body.toLowerCase().indexOf(String(query).toLowerCase());
  if (at < 0) return body.slice(0, 200);
  const from = Math.max(0, at - 80);
  return (from > 0 ? '…' : '') + body.slice(from, at + 160) + (at + 160 < body.length ? '…' : '');
}
