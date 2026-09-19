import { cfg } from '../config.js';
import * as audit from '../audit/log.js';
import * as gate from '../approve/gate.js';
import { resolve, secretValues } from '../registry/resolve.js';
import { pinHostKey } from '../registry/hosts.js';
import { LockedError } from '../registry/crypto.js';

// Общая рамка вокруг каждого инструмента: разобрать алиас, спросить человека,
// выполнить, записать в журнал. Инструменты сами этим не занимаются — иначе
// первый же новый инструмент завёл бы четвёртый вариант «как мы тут спрашиваем».

export function text(data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (Buffer.byteLength(body) <= cfg.maxTextBytes) return { content: [{ type: 'text', text: body }] };

  const cut = Buffer.from(body).subarray(0, cfg.maxTextBytes).toString('utf8');
  return {
    content: [{
      type: 'text',
      text: `${cut}\n\n… ответ обрезан до CR_MAX_TEXT_BYTES (${cfg.maxTextBytes} Б). `
        + 'Сузьте выборку или заберите результат файлом.',
    }],
  };
}

export function fail(message, details) {
  const body = details ? `${message}\n${JSON.stringify(details, null, 2)}` : message;
  return { isError: true, content: [{ type: 'text', text: body }] };
}

/** Разворачивает mutating: булево или предикат от аргументов. */
function isMutating(def, args) {
  return typeof def.mutating === 'function' ? Boolean(def.mutating(args)) : Boolean(def.mutating);
}

export function wrap(def, ctx) {
  return async (args = {}) => {
    const alias = typeof args.alias === 'string' ? args.alias : null;
    const entry = audit.start({ tool: def.name, alias, args, kind: def.group });

    let resolved = null;
    let secrets = [];

    try {
      if (def.needsConnection) {
        resolved = resolve(alias);
        if (def.kinds && !def.kinds.includes(resolved.kind)) {
          throw new Error(
            `«${alias}» — подключение типа «${resolved.kind}», а ${def.name} работает с: ${def.kinds.join(', ')}`,
          );
        }
        entry.kind = resolved.kind;
        entry.target = resolved.host ? resolved.host.alias : (resolved.config.address || null);
      }

      const mutating = isMutating(def, args);
      const policy = resolved?.confirm;

      if (gate.needsApproval({ mutating, always: def.alwaysConfirm, policy })
        || (!mutating && gate.alwaysAsks(policy))) {
        const summary = def.summary ? def.summary(args, resolved) : `${def.name}${alias ? ` на ${alias}` : ''}`;
        entry.approval = await gate.approve(ctx, {
          tool: def.name,
          alias,
          summary,
          details: def.details ? def.details(args, resolved) : undefined,
        });
      } else {
        entry.approval = { required: false };
      }

      // Список секретов собираем после подтверждения: до него расшифровка не нужна.
      if (resolved) secrets = secretValues(resolved);

      const result = await def.run(args, {
        ctx,
        resolved,
        approveHostKey: makeHostKeyApprover(ctx, resolved, def.name),
      });

      const payload = result?.data ?? result ?? null;
      audit.finish(entry, {
        ok: result?.ok !== false,
        exitCode: result?.exitCode ?? null,
        command: result?.command ?? null,
        stdout: result?.stdout ?? (payload === null ? '' : JSON.stringify(payload)),
        stderr: result?.stderr ?? '',
        secrets,
      });

      return text(payload);
    } catch (err) {
      audit.finish(entry, { ok: false, error: err.message, stdout: '', stderr: err.stack || '', secrets });

      if (err instanceof LockedError) {
        return fail(`Реестр заперт: ${err.message}`);
      }
      if (err.name === 'Declined') {
        return fail(err.message, err.decision?.url ? { где: err.decision.url } : undefined);
      }
      if (err.code === 'host_key') {
        return fail(err.message, { хост: err.host, ожидался: err.expected, пришёл: err.actual });
      }
      return fail(`${def.name}: ${err.message}`);
    }
  };
}

/**
 * Новый хост-ключ закрепляется только после подтверждения человека, расхождение с
 * закреплённым не спрашивается вовсе — так выглядит подмена сервера.
 */
function makeHostKeyApprover(ctx, resolved, toolName) {
  if (!resolved?.host) return undefined;

  return async (fp) => {
    const host = resolved.host;
    await gate.approve(ctx, {
      tool: toolName,
      alias: resolved.alias,
      summary: `Хост «${host.alias}» (${host.address}) виден впервые. Закрепить его ключ?`,
      details: {
        отпечаток: fp,
        'что это значит': 'Дальше реестр будет отказываться подключаться, если ключ сменится.',
      },
    });
    pinHostKey(host.alias, fp);
    host.hostKey = fp;
    host.hostKeyStatus = 'pinned';
    return true;
  };
}
