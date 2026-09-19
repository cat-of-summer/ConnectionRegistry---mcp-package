import { cfg } from '../config.js';
import * as queue from './queue.js';
import * as grants from './grants.js';

// Разрешение на действие спрашивается у человека и только у него. Два пути: штатный
// elicitation MCP и веб-очередь, если клиент спрашивать не умеет. Второй нужен не как
// запасной вариант, а как гарантия: набор клиентов заранее неизвестен, а спрашивать
// должен сервер, у которого лежат ключи.
//
// Спрашиваем редко и по делу:
//   чтение                       — никогда;
//   запись                       — один раз за сессию и один раз на проект;
//   хосты, секреты, подключения  — каждый раз: это доступы, а не работа внутри проекта.

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
  if (decision.scope === 'session') {
    return 'запись в этой сессии запрещена человеком — он отказал на первом же изменяющем вызове';
  }
  if (decision.scope === 'project') {
    return `проект «${decision.project}» человек оставил только на чтение до конца сессии`;
  }
  return 'человек отказал';
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

/**
 * Пропускает вызов или бросает Declined. Возвращает запись для журнала: по ней видно,
 * спрашивали ли человека сейчас или действие прошло по выданному раньше разрешению.
 */
export async function authorize(ctx, { tool, alias, project, mutating, everyTime, summary, details }) {
  if (everyTime) {
    const decision = await ask(ctx, { tool, alias, summary, details });
    const record = { required: true, scope: 'call', ...decision };
    if (decision.status !== 'approved') throw new Declined(record, summary);
    return record;
  }

  if (!mutating) return { required: false };

  const sessionId = ctx.sessionId;

  // 1. Право этой сессии менять хоть что-нибудь.
  const session = grants.sessionWrite(sessionId);
  if (session === 'denied') throw new Declined({ required: true, scope: 'session', status: 'declined' }, summary);

  if (session === undefined) {
    const decision = await ask(ctx, {
      tool,
      alias,
      summary: 'Разрешить этой сессии агента менять что-либо на серверах и в базах?',
      details: {
        'первое действие': summary,
        'что это значит': 'Спрашиваю один раз за сессию. Дальше на каждый новый проект будет ещё один вопрос, '
          + 'а внутри разрешённого проекта вопросов не будет. Отказ запретит запись до конца сессии.',
      },
    });
    grants.setSessionWrite(sessionId, decision.status === 'approved');
    if (decision.status !== 'approved') {
      throw new Declined({ required: true, scope: 'session', ...decision }, summary);
    }
  }

  // 2. Право менять в этом проекте.
  if (!project) return { required: true, scope: 'session', status: 'approved', granted: 'ранее в этой сессии' };

  const access = grants.projectAccess(sessionId, project);
  if (access === 'read') {
    throw new Declined({ required: true, scope: 'project', project, status: 'declined' }, summary);
  }

  if (access === undefined) {
    const decision = await ask(ctx, {
      tool,
      alias,
      summary: `Разрешить запись в проект «${project}» до конца сессии?`,
      details: {
        'первое действие': summary,
        'что это значит': 'Да — дальше в этом проекте вопросов не будет. Нет — проект останется только на чтение '
          + 'до конца сессии, и спрашивать о нём я больше не буду.',
      },
    });
    grants.setProjectAccess(sessionId, project, decision.status === 'approved');
    if (decision.status !== 'approved') {
      throw new Declined({ required: true, scope: 'project', project, ...decision }, summary);
    }
    return { required: true, scope: 'project', project, ...decision };
  }

  return { required: true, scope: 'project', project, status: 'approved', granted: 'ранее в этой сессии' };
}
