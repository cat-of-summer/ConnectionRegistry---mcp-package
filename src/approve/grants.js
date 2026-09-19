// Разрешения живут в памяти и ровно столько, сколько живёт сессия MCP. На диск они
// не ложатся намеренно: «разрешено до конца сессии» должно кончаться вместе с ней,
// иначе через неделю никто не вспомнит, что и кому когда-то разрешили.
//
// Их два уровня, и оба спрашиваются один раз:
//   сессия — можно ли этой сессии вообще что-то менять;
//   проект — можно ли менять в этом проекте.
// Отказ тоже запоминается: второй раз о том же не спрашиваем, сразу отвечаем отказом.

const sessions = new Map(); // sessionId -> { write, projects: Map<project, 'write'|'read'>, since }

export const STDIO_SESSION = 'stdio';

function state(sessionId) {
  const key = sessionId || STDIO_SESSION;
  let found = sessions.get(key);
  if (!found) {
    found = { write: undefined, projects: new Map(), since: new Date().toISOString() };
    sessions.set(key, found);
  }
  return found;
}

/** @returns 'granted' | 'denied' | undefined */
export const sessionWrite = (sessionId) => state(sessionId).write;

export function setSessionWrite(sessionId, granted) {
  state(sessionId).write = granted ? 'granted' : 'denied';
  return granted;
}

/** @returns 'write' | 'read' | undefined */
export const projectAccess = (sessionId, project) => state(sessionId).projects.get(project);

export function setProjectAccess(sessionId, project, granted) {
  state(sessionId).projects.set(project, granted ? 'write' : 'read');
  return granted;
}

export function forget(sessionId) {
  sessions.delete(sessionId || STDIO_SESSION);
}

/** Что сейчас разрешено — это же показывает registry_info. */
export function snapshot(sessionId) {
  const current = state(sessionId);
  return {
    запись: current.write ?? 'ещё не спрашивали',
    проекты: Object.fromEntries([...current.projects].map(([name, access]) => [
      name,
      access === 'write' ? 'запись разрешена' : 'только чтение',
    ])),
    сессияС: current.since,
  };
}

export const sessionCount = () => sessions.size;
