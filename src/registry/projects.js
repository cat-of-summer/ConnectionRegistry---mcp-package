import { db, now } from './db.js';
import { PROJECT_RE } from './schema.js';

// Проект — владелец всего остального: хостов, подключений, фактов. Заводится явно и с
// рабочими директориями на машине человека: агент, открывший реестр, должен увидеть не
// только куда ходить по SSH, но и где на этой машине лежит код. Договорённость «путь
// лежит в заметке local.path» держалась на памяти, а не на схеме.

export const COMMENT_MAX = 200;

export function assertProject(name) {
  if (!PROJECT_RE.test(String(name || ''))) {
    throw new Error(`имя проекта — одно слово строчными буквами: получено «${name}»`);
  }
  return name;
}

export function getProjectRow(name) {
  return db().prepare('SELECT * FROM projects WHERE name = ?').get(name) || null;
}

/** Хост, подключение и факт живут только в заведённом проекте. */
export function requireProject(name) {
  assertProject(name);
  if (!getProjectRow(name)) {
    throw new Error(`проект «${name}» не заведён: сначала project_set с рабочей директорией`);
  }
  return name;
}

export function projects() {
  return db().prepare('SELECT name FROM projects ORDER BY name').all().map((r) => r.name);
}

function dirsOf(name) {
  return db().prepare('SELECT path, comment, updated_at FROM project_dirs WHERE project = ? ORDER BY path')
    .all(name)
    .map((d) => ({ path: d.path, comment: d.comment, updatedAt: d.updated_at }));
}

function publicProject(row) {
  const count = (sql) => db().prepare(sql).get(row.name).n;
  return {
    project: row.name,
    comment: row.comment || null,
    dirs: dirsOf(row.name),
    hosts: count('SELECT count(*) AS n FROM hosts WHERE project = ?'),
    connections: count('SELECT count(*) AS n FROM connections WHERE project = ?'),
    facts: count('SELECT count(*) AS n FROM notes_facts WHERE project = ?'),
    readSessions: row.read_sessions,
    updatedAt: row.updated_at,
  };
}

export function getProject(name) {
  assertProject(name);
  const row = getProjectRow(name);
  if (!row) throw new Error(`проект «${name}» не заведён`);
  return publicProject(row);
}

export function listProjects() {
  return db().prepare('SELECT * FROM projects ORDER BY name').all().map(publicProject);
}

function normalizeDir(dir) {
  const path = String(dir?.path ?? '').trim();
  const comment = String(dir?.comment ?? '').trim();
  if (!path || /[\r\n]/.test(path)) throw new Error('путь директории — непустая строка без переводов строк');
  if (!comment) throw new Error(`у директории «${path}» должен быть комментарий: что в ней лежит и зачем она`);
  if (comment.length > COMMENT_MAX) {
    throw new Error(`комментарий к «${path}» длиннее ${COMMENT_MAX} символов — оставьте суть`);
  }
  return { path, comment };
}

/**
 * Заводит или правит проект. Директории сливаются по пути: новые добавляются, названные
 * повторно — обновляют комментарий, остальные остаются. Новый проект без единой
 * директории не заводится: это и есть смысл требования.
 */
export function upsertProject({ project, comment, dirs }) {
  assertProject(project);
  const existing = getProjectRow(project);
  const list = (dirs ?? []).map(normalizeDir);

  if (!existing && !list.length) {
    throw new Error(`проект «${project}» заводится хотя бы с одной рабочей директорией: где на этой машине лежит его код`);
  }
  if (comment !== undefined && comment !== null && String(comment).length > COMMENT_MAX) {
    throw new Error(`комментарий проекта длиннее ${COMMENT_MAX} символов`);
  }

  const ts = now();
  db().transaction(() => {
    if (existing) {
      db().prepare('UPDATE projects SET comment = ?, updated_at = ? WHERE name = ?')
        .run(comment === undefined ? existing.comment : (comment || null), ts, project);
    } else {
      db().prepare('INSERT INTO projects (name, comment, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(project, comment || null, ts, ts);
    }
    const put = db().prepare(`INSERT INTO project_dirs (project, path, comment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project, path) DO UPDATE SET comment = excluded.comment, updated_at = excluded.updated_at`);
    for (const dir of list) put.run(project, dir.path, dir.comment, ts, ts);
  })();

  return getProject(project);
}

export function removeDir(project, path) {
  requireProject(project);
  const dirs = dirsOf(project);
  if (!dirs.some((d) => d.path === path)) throw new Error(`у проекта «${project}» нет директории «${path}»`);
  if (dirs.length === 1) {
    throw new Error(`«${path}» — единственная директория проекта «${project}»: сначала добавьте другую`);
  }
  db().prepare('DELETE FROM project_dirs WHERE project = ? AND path = ?').run(project, path);
  return getProject(project);
}

/** Проект уходит вместе с фактами и директориями; хосты и подключения нужно убрать раньше. */
export function removeProject(project) {
  requireProject(project);
  const hosts = db().prepare('SELECT alias FROM hosts WHERE project = ? ORDER BY alias').all(project).map((r) => r.alias);
  const conns = db().prepare('SELECT alias FROM connections WHERE project = ? ORDER BY alias').all(project).map((r) => r.alias);
  if (hosts.length || conns.length) {
    throw new Error(`у проекта «${project}» есть хосты и подключения: ${[...hosts, ...conns].join(', ')}. Сначала уберите их`);
  }
  db().transaction(() => {
    db().prepare('DELETE FROM notes_facts WHERE project = ?').run(project);
    db().prepare('DELETE FROM project_dirs WHERE project = ?').run(project);
    db().prepare('DELETE FROM projects WHERE name = ?').run(project);
  })();
  return { project, removed: true };
}
