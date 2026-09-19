import { cfg } from '../config.js';
import * as queue from './queue.js';
import * as grants from './grants.js';
import { policy } from './policy.js';

// Разрешение на действие спрашивается у человека и только у него. Два пути: штатный
// elicitation MCP и веб-очередь, если клиент спрашивать не умеет. Второй нужен не как
// запасной вариант, а как гарантия: набор клиентов заранее неизвестен, а спрашивать
// должен сервер, у которого лежат ключи.
//
// Какие вопросы задать и в каком порядке, решает политика (policy.js). Здесь только
// исполнение её решения: спросить, запомнить ответ, пропустить или отказать.

export class Declined extends Error {
  constructor(decision, summary) {
    super(`Действие не выполнено: ${reason(decision)}. ${summary}`);
    this.name = 'Declined';
    this.code = 'not_approved';
    this.decision = decision;
  }
}

function reason(decision) {
  if (decision.status === 'timeout') {
    return `подтверждение не получено за ${Math.round(cfg.approveTimeoutMs / 1000)} с`;
  }
  return policy.refusal(decision);
}

async function viaElicitation(ctx, { summary, details }) {
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
            title: 'Разрешить?',
            description: 'Да — реестр выполнит действие и запишет его в журнал. Нет — действие не состоится.',
          },
        },
        required: ['approve'],
      },
    }, {
      timeout: cfg.approveTimeoutMs,
      // Без привязки к запросу SDK шлёт вопрос в фоновый поток сессии, а если клиент
      // его ещё не открыл — молча выбрасывает, и вызов висит до таймаута.
      relatedRequestId: ctx.requestId,
    });

    if (res.action === 'accept') {
      return { status: res.content?.approve === false ? 'declined' : 'approved', via: 'elicitation' };
    }
    if (res.action === 'decline') return { status: 'declined', via: 'elicitation' };
    return null; // cancel — уходим в очередь, вдруг человек ответит там
  } catch {
    return null; // клиент соврал о возможности или отвалился — остаётся очередь
  }
}

/** Задаёт человеку один вопрос: сначала клиенту, при неудаче — в веб-очередь. */
async function ask(ctx, { tool, alias, summary, details }) {
  const answered = await viaElicitation(ctx, { summary, details });
  if (answered) {
    const id = queue.create({ tool, alias, summary, details });
    queue.decide(id, answered.status, 'elicitation');
    return { ...answered, id };
  }

  const id = queue.create({ tool, alias, summary, details });
  const outcome = await queue.wait(id, cfg.approveTimeoutMs);
  return { ...outcome, id, url: `${cfg.publicBaseUrl}/approvals` };
}

/** Ступень без ключа: вопрос задаётся каждый раз, ответ не запоминается. */
async function perCall(ctx, call, step) {
  const decision = await ask(ctx, { tool: call.tool, alias: call.alias, summary: step.summary, details: step.details });
  const record = { required: true, scope: 'call', ...decision };
  if (decision.status !== 'approved') throw new Declined(record, step.summary);
  return record;
}

/** Ступень с ключом: спрашивается один раз за сессию, ответ — и отказ тоже — запоминается. */
async function perSession(ctx, call, step) {
  const base = { required: true, scope: step.scope, project: step.project, host: step.host };
  const known = grants.get(ctx.sessionId, step.key);

  if (known === 'denied') throw new Declined({ ...base, status: 'declined' }, call.summary);
  if (known === 'granted') return { ...base, status: 'approved', granted: 'ранее в этой сессии' };

  if (step.auto) {
    grants.set(ctx.sessionId, step.key, true);
    return { ...base, status: 'approved', granted: 'выдано вместе с заведением' };
  }

  const decision = await ask(ctx, { tool: call.tool, alias: call.alias, summary: step.summary, details: step.details });
  grants.set(ctx.sessionId, step.key, decision.status === 'approved');
  if (decision.status !== 'approved') throw new Declined({ ...base, ...decision }, step.summary);
  return { ...base, ...decision };
}

/**
 * Пропускает вызов или бросает Declined. Возвращает запись для журнала: по ней видно,
 * спрашивали ли человека сейчас или действие прошло по выданному раньше разрешению.
 */
export async function authorize(ctx, call) {
  const steps = policy.ladder(call);
  if (!steps.length) return { required: false };

  let last = null;
  for (const step of steps) {
    last = step.scope === 'call' ? await perCall(ctx, call, step) : await perSession(ctx, call, step);
  }
  return last;
}
