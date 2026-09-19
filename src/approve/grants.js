// Разрешения живут в памяти и ровно столько, сколько живёт сессия MCP. На диск они
// не ложатся намеренно: «разрешено до конца сессии» должно кончаться вместе с ней,
// иначе через неделю никто не вспомнит, что и кому когда-то разрешили.
//
// Что именно спрашивается и в каком порядке, решает политика (approve/policy.js).
// Здесь только хранилище: ключ ступени → 'granted' | 'denied'. Отказ запоминается
// наравне с согласием: второй раз о том же не спрашиваем, сразу отвечаем отказом.

import { policy } from './policy.js';

const sessions = new Map(); // sessionId -> { steps: Map<key, 'granted'|'denied'>, since }

export const STDIO_SESSION = 'stdio';

function state(sessionId) {
  const key = sessionId || STDIO_SESSION;
  let found = sessions.get(key);
  if (!found) {
    found = { steps: new Map(), since: new Date().toISOString() };
    sessions.set(key, found);
  }
  return found;
}

/** @returns 'granted' | 'denied' | undefined */
export const get = (sessionId, key) => state(sessionId).steps.get(key);

export function set(sessionId, key, granted) {
  state(sessionId).steps.set(key, granted ? 'granted' : 'denied');
  return granted;
}

export function forget(sessionId) {
  sessions.delete(sessionId || STDIO_SESSION);
}

/**
 * Что сейчас разрешено — это же показывает registry_info. Формулировки берутся из
 * политики: «доступ есть» и «запись разрешена» — разные вещи, и путать их нельзя.
 */
export function snapshot(sessionId) {
  const current = state(sessionId);
  const out = { сессияС: current.since };

  for (const [key, value] of current.steps) {
    const [scope, name] = key.includes(':') ? key.split(/:(.*)/s) : [key, null];
    const words = policy.wording[scope]?.[value] ?? value;
    if (!name) { out[scope === 'session' ? 'запись' : scope] = words; continue; }
    (out[scope === 'project' ? 'проекты' : 'хосты'] ||= {})[name] = words;
  }

  if (policy.name === 'base' && out.запись === undefined) out.запись = 'ещё не спрашивали';
  return out;
}

export const sessionCount = () => sessions.size;
