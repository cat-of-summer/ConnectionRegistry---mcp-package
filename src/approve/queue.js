import { EventEmitter } from 'node:events';
import { db, now } from '../registry/db.js';
import { newId } from '../audit/log.js';

// Очередь подтверждений. Живёт в двух местах намеренно: строка в базе, чтобы
// человек видел заявку на странице и после перезапуска, и обещание в памяти,
// чтобы ждущий вызов проснулся сразу после клика, а не по опросу.

const waiting = new Map();
export const events = new EventEmitter();
events.setMaxListeners(0);

export function create({ tool, alias, summary, details }) {
  const id = newId();
  db().prepare(`INSERT INTO approvals (id, ts, tool, alias, summary, details, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
    .run(id, now(), tool, alias ?? null, summary, details ? JSON.stringify(details) : null);
  events.emit('change', { id, action: 'created' });
  return id;
}

export function wait(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      db().prepare("UPDATE approvals SET status = 'timeout', decided_at = ?, decided_via = 'timeout' WHERE id = ? AND status = 'pending'")
        .run(now(), id);
      events.emit('change', { id, action: 'timeout' });
      resolve({ status: 'timeout', via: 'timeout' });
    }, timeoutMs);

    waiting.set(id, (outcome) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(outcome);
    });
  });
}

export function decide(id, status, via = 'web') {
  if (!['approved', 'declined'].includes(status)) throw new Error(`решение «${status}» не понято`);
  const row = db().prepare('SELECT * FROM approvals WHERE id = ?').get(id);
  if (!row) throw new Error(`заявка «${id}» не найдена`);
  if (row.status !== 'pending') throw new Error(`заявка «${id}» уже закрыта: ${row.status}`);

  db().prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_via = ? WHERE id = ?')
    .run(status, now(), via, id);

  const resume = waiting.get(id);
  if (resume) resume({ status, via });
  events.emit('change', { id, action: status });
  return { id, status, via };
}

export function pending() {
  return db().prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY ts").all()
    .map(shape);
}

export function recent(limit = 50) {
  return db().prepare('SELECT * FROM approvals ORDER BY ts DESC LIMIT ?').all(limit).map(shape);
}

export function get(id) {
  const row = db().prepare('SELECT * FROM approvals WHERE id = ?').get(id);
  return row ? shape(row) : null;
}

/** Сколько заявок висит без ответа — это же видно агенту в registry_info. */
export function pendingCount() {
  return db().prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get().n;
}

function shape(row) {
  return {
    id: row.id,
    ts: row.ts,
    tool: row.tool,
    alias: row.alias,
    summary: row.summary,
    details: row.details ? JSON.parse(row.details) : null,
    status: row.status,
    decidedAt: row.decided_at,
    decidedVia: row.decided_via,
  };
}

/** При старте сервера висящие заявки закрывать нельзя молча: ждавший их вызов уже умер. */
export function expireOrphans() {
  const res = db().prepare("UPDATE approvals SET status = 'timeout', decided_at = ?, decided_via = 'restart' WHERE status = 'pending'")
    .run(now());
  return res.changes;
}
