import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import { connect, exec, quote } from '../transport/ssh.js';

const GROUP = 'shell';

function shape(res) {
  return {
    exitCode: res.code,
    signal: res.signal,
    timedOut: res.timedOut,
    truncated: res.truncated,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

export const tools = [
  {
    name: 'ssh_exec',
    group: GROUP,
    needsConnection: true,
    kinds: ['shell'],
    mutating: true,
    // Ключ или токен открытым текстом в команде отклоняется; в stdin вместо значения
    // принимается ссылка на секрет реестра — он подставляется на сервере.
    scan: ['command', 'stdin'],
    secretRefs: ['stdin'],
    title: pick({ ru: 'Выполнить команду', en: 'Run a command' }),
    description: pick({
      ru: 'Выполняет команду на сервере по алиасу подключения. Возвращает код возврата и оба потока '
        + 'целиком. Команда произвольная, поэтому каждый вызов проходит через подтверждение человека '
        + 'и целиком попадает в журнал. Секрет открытым текстом в команде отклоняется: положите его '
        + 'через secret_set и передайте в stdin ссылкой cr://secret/<хост>#private_key.',
      en: 'Runs a command on the server behind the alias. Returns the exit code and both streams in full. '
        + 'The command is arbitrary, so every call goes through human confirmation and is journalled in full. '
        + 'A plaintext secret in the command is refused: store it with secret_set and pass it in stdin '
        + 'as cr://secret/<host>#private_key.',
    }),
    input: {
      alias: z.string(),
      command: z.string().describe(pick({ ru: 'команда как в шелле', en: 'command as typed in a shell' })),
      cwd: z.string().optional().describe(pick({ ru: 'каталог; по умолчанию из настроек алиаса', en: 'directory; defaults to the alias setting' })),
      stdin: z.string().optional().describe(pick({
        ru: 'текст или ссылка cr://secret/<алиас>#private_key|password|passphrase — значение подставит сервер',
        en: 'text, or cr://secret/<alias>#private_key|password|passphrase — the server fills in the value',
      })),
      timeout: z.number().int().positive().optional().describe(pick({ ru: 'секунды', en: 'seconds' })),
    },
    summary: (args, resolved) => `Выполнить на «${args.alias}» (${resolved?.host?.address}): ${args.command}`,
    details: (args, resolved) => ({
      каталог: args.cwd || resolved?.config?.cwd || '—',
      пользователь: resolved?.host?.username,
    }),
    run: async (args, { resolved, approveHostKey }) => {
      const client = await connect(resolved.host, { approveHostKey });
      const res = await exec(client, args.command, {
        cwd: args.cwd || resolved.config.cwd,
        stdin: args.stdin,
        timeoutMs: args.timeout ? args.timeout * 1000 : cfg.execTimeoutMs,
      });

      return {
        data: shape(res),
        ok: res.code === 0,
        exitCode: res.code,
        command: res.command,
        stdout: res.stdout,
        stderr: res.stderr,
      };
    },
  },

  {
    name: 'ssh_script',
    group: GROUP,
    needsConnection: true,
    kinds: ['shell'],
    mutating: true,
    // Ссылок на секреты здесь нет: скрипт — код, а не значение. Ключ кладут ssh_exec'ом
    // со ссылкой в stdin.
    scan: ['script'],
    title: pick({ ru: 'Выполнить скрипт', en: 'Run a script' }),
    description: pick({
      ru: 'Отдаёт многострочный скрипт интерпретатору на сервере через stdin. Годится там, где '
        + 'команда не влезает в одну строку: цепочка с условиями, heredoc, кавычки внутри кавычек.',
      en: 'Feeds a multi-line script to an interpreter on the server via stdin. For cases a single '
        + 'command line cannot hold: conditionals, heredocs, quotes inside quotes.',
    }),
    input: {
      alias: z.string(),
      script: z.string(),
      interpreter: z.string().optional().describe(pick({ ru: 'по умолчанию sh', en: 'defaults to sh' })),
      cwd: z.string().optional(),
      timeout: z.number().int().positive().optional(),
    },
    summary: (args, resolved) => `Выполнить скрипт на «${args.alias}» (${resolved?.host?.address}), `
      + `${args.script.split('\n').length} строк`,
    details: (args) => ({ скрипт: args.script.slice(0, 1500) }),
    run: async (args, { resolved, approveHostKey }) => {
      const client = await connect(resolved.host, { approveHostKey });
      const interpreter = args.interpreter || resolved.config.shell || 'sh';
      const res = await exec(client, `${quote(interpreter)} -s`, {
        cwd: args.cwd || resolved.config.cwd,
        stdin: args.script,
        timeoutMs: args.timeout ? args.timeout * 1000 : cfg.execTimeoutMs,
      });

      return {
        data: shape(res),
        ok: res.code === 0,
        exitCode: res.code,
        command: `${interpreter} -s <<< (${args.script.split('\n').length} строк)`,
        stdout: res.stdout,
        stderr: res.stderr,
      };
    },
  },
];
