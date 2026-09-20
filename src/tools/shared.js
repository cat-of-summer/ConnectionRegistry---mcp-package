import { cfg } from '../config.js';
import * as audit from '../audit/log.js';
import * as gate from '../approve/gate.js';
import {
  resolve, secretValues, projectSecretValues, readSecretRef, isSecretRef, SECRET_REF_KINDS,
} from '../registry/resolve.js';
import { pinHostKey } from '../registry/hosts.js';
import { LockedError } from '../registry/crypto.js';
import { scanArgs, describe } from '../secrets.js';

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

/** Проекты, которых касается вызов: свой плюс объявленные инструментом. */
function touched(project, def, args, resolved) {
  const declared = def.projects ? def.projects(args, resolved) : [];
  return [...new Set([project, resolved?.project, ...declared])].filter(Boolean);
}

/**
 * Секрет, присланный открытым текстом, отклоняется до вопроса человеку. Чистка журнала
 * лечит половину беды: к этому месту ключ уже прошёл через контекст модели и транскрипт
 * клиента, и отменить это нельзя. Поэтому отказ — и с подсказкой, как сделать правильно,
 * иначе агент пойдёт искать обход.
 *
 * Отклоняются только однозначные находки (hard). Эвристики вроде `PGPASSWORD=…`
 * маскируются в журнале, но работу не останавливают: цена ложной находки здесь —
 * заблокированная команда.
 */
function refuseSecrets(def, args, resolved) {
  if (!cfg.secretScan || !def.scan) return;

  const found = scanArgs(args, def.scan).filter((f) => f.hard);
  if (!found.length) return;

  const example = resolved?.host?.alias || `${String(args.alias || 'проект/хост')}`;
  const where = [...new Set(found.map((f) => f.field))].map((f) => `«${f}»`).join(', ');
  const what = found.map((f) => describe(f)).join('; ');
  const field = def.secretRefs?.[0];

  const err = new Error(
    `в ${where} лежит секрет открытым текстом (${what}). Через реестр секреты так не ходят: `
    + 'вызов целиком ложится в журнал, а до журнала успевает пройти через контекст модели. '
    + `Положите его один раз через secret_set и подставляйте ссылкой${field ? ` в «${field}»` : ''}: `
    + `cr://secret/${example}#${SECRET_REF_KINDS.join('|')} — значение подставит сервер, `
    + 'в журнал уйдёт ссылка.',
  );
  err.code = 'secret_in_args';
  throw err;
}

/**
 * Подставляет значения вместо ссылок cr://secret/…, уже после подтверждения. Поле
 * подставляется целиком: подстановка внутри текста вернула бы секрет в произвольную
 * строку, ради ухода от которой всё и затевалось.
 */
function fillSecretRefs(def, args, project) {
  if (!def.secretRefs) return { args, values: [] };

  let out = args;
  const values = [];

  for (const field of def.secretRefs) {
    if (!isSecretRef(out[field])) continue;
    const value = readSecretRef(out[field], { project });
    out = { ...out, [field]: value };
    values.push(value);
  }

  return { args: out, values };
}

export function wrap(def, sessionCtx) {
  return async (args = {}, extra = {}) => {
    // Вопрос человеку привязывается к этому вызову: без requestId SDK шлёт его в фоновый
    // поток сессии, а если клиент его ещё не открыл — молча выбрасывает, и вызов висит.
    const ctx = { ...sessionCtx, requestId: extra.requestId, sessionId: extra.sessionId ?? sessionCtx.sessionId };
    const alias = typeof args.alias === 'string' ? args.alias : null;
    // Проект — левая часть алиаса либо явный параметр заметок: на нём держится
    // разрешение «работать с этим проектом».
    const project = alias ? alias.split('/')[0] : (typeof args.project === 'string' ? args.project : null);
    const entry = audit.start({
      tool: def.name,
      alias: alias ?? project,
      args,
      kind: def.group,
      secretArgs: def.secretArgs,
    });

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

      // До вопроса человеку: иначе он подтвердит то, что всё равно не выполнится, а
      // ssh_script успеет показать ему ключ в диалоге — details там сам скрипт.
      refuseSecrets(def, args, resolved);

      const summary = def.summary ? def.summary(args, resolved) : `${def.name}${alias ? ` на ${alias}` : ''}`;
      entry.approval = await gate.authorize(ctx, {
        tool: def.name,
        group: def.group,
        alias,
        project,
        // Инструмент может задеть больше одного проекта — так хост объявляет тех, чьи
        // подключения на него ссылаются: правка кредов сервера касается их всех.
        projects: def.projects ? def.projects(args, resolved) : undefined,
        // Право писать выдаётся на сервер: одно разрешение на shell, файлы, docker и базу
        // одного хоста. Подключение без хоста ходит по сети само — тогда оно и есть ключ.
        host: resolved?.host?.alias ?? alias,
        mutating: isMutating(def, args),
        everyTime: def.everyTime,
        summary,
        details: def.details ? def.details(args, resolved) : undefined,
      });

      // Список секретов собираем после подтверждения: до него расшифровка не нужна.
      // Берём и секреты всего проекта: пароль базы, попавший в эхо команды на шелле
      // того же проекта, — такой же секрет, как креды самого подключения.
      if (resolved) secrets = secretValues(resolved);
      secrets = [...new Set([...secrets, ...projectSecretValues(touched(project, def, args, resolved))])];

      const filled = fillSecretRefs(def, args, resolved?.project ?? project);
      secrets = [...new Set([...secrets, ...filled.values])];

      const result = await def.run(filled.args, {
        ctx,
        resolved,
        approveHostKey: makeHostKeyApprover(resolved),
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
      // Отказ по секрету сам объясняет, что делать: прятать его за именем инструмента незачем.
      if (err.code === 'secret_in_args') return fail(err.message);
      return fail(`${def.name}: ${err.message}`);
    }
  };
}

/**
 * Ключ хоста, увиденного впервые, закрепляется молча: спрашивать нечего, сверять не с
 * чем. Смысл проверки в том, что будет дальше — расхождение с закреплённым ключом
 * отклоняется без вопросов, и это видно в журнале.
 */
function makeHostKeyApprover(resolved) {
  if (!resolved?.host) return undefined;

  return async (fp) => {
    const host = resolved.host;
    pinHostKey(host.alias, fp);
    host.hostKey = fp;
    host.hostKeyStatus = 'pinned';
    return true;
  };
}
