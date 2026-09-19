import { cfg } from '../config.js';
import * as queue from './queue.js';

// Разрешение на действие спрашивается один раз на вызов и только у человека.
// Два пути: штатный elicitation MCP, если клиент его объявил, и веб-очередь, если
// нет. Второй путь нужен не как запасной вариант, а как гарантия: набор клиентов
// заранее неизвестен, а спрашивать должен сервер, у которого лежат ключи.

export class Declined extends Error {
  constructor(decision, summary) {
    const reason = decision.status === 'timeout'
      ? `подтверждение не получено за ${Math.round(cfg.approveTimeoutMs / 1000)} с`
      : 'человек отказал';
    super(`Действие не выполнено: ${reason}. ${summary}`);
    this.name = 'Declined';
    this.code = 'not_approved';
    this.decision = decision;
  }
}

/**
 * Нужно ли спрашивать. Запись в реестр и заметки спрашивается всегда — политика
 * подключения к ней не относится: она про доступ, а не про то, кто правит реестр.
 */
export function needsApproval({ mutating, always = false, policy }) {
  if (always) return true;
  if (!mutating) return false;

  const effective = !policy || policy === 'inherit' ? cfg.defaultConfirmPolicy : policy;
  if (effective === 'never') return false;
  if (effective === 'always') return true;
  return true; // writes: изменяющая операция — спрашиваем
}

/** Политика `always` спрашивает и на чтении. */
export function alwaysAsks(policy) {
  const effective = !policy || policy === 'inherit' ? cfg.defaultConfirmPolicy : policy;
  return effective === 'always';
}

async function askElicitation(ctx, { summary, details }) {
  const caps = ctx?.server?.server?.getClientCapabilities?.();
  if (!caps?.elicitation) return null;

  const lines = [summary];
  for (const [key, value] of Object.entries(details || {})) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  try {
    const res = await ctx.server.server.elicitInput({
      message: lines.join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          approve: {
            type: 'boolean',
            title: 'Выполнить это действие?',
            description: 'Да — реестр выполнит операцию и запишет её в журнал. Нет — вызов не состоится.',
          },
        },
        required: ['approve'],
      },
    }, { timeout: cfg.approveTimeoutMs });

    if (res.action === 'accept') {
      return { status: res.content?.approve === false ? 'declined' : 'approved', via: 'elicitation' };
    }
    if (res.action === 'decline') return { status: 'declined', via: 'elicitation' };
    return null; // cancel — уходим в очередь, вдруг человек ответит там
  } catch {
    return null; // клиент соврал о возможности или отвалился — остаётся очередь
  }
}

/**
 * Спрашивает разрешение. Возвращает описание решения для журнала либо бросает Declined.
 */
export async function approve(ctx, { tool, alias, summary, details }) {
  const viaClient = await askElicitation(ctx, { summary, details });
  if (viaClient) {
    const id = queue.create({ tool, alias, summary, details });
    queue.decide(id, viaClient.status, 'elicitation');
    const decision = { ...viaClient, id, required: true };
    if (decision.status !== 'approved') throw new Declined(decision, summary);
    return decision;
  }

  const id = queue.create({ tool, alias, summary, details });
  const outcome = await queue.wait(id, cfg.approveTimeoutMs);
  const decision = { ...outcome, id, required: true, url: `${cfg.publicBaseUrl}/approvals` };
  if (decision.status !== 'approved') throw new Declined(decision, summary);
  return decision;
}
