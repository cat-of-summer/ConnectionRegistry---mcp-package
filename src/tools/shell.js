import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import { connect, exec, quote } from '../transport/ssh.js';
import { newArtifact, safeName } from '../artifacts.js';
import { writeSigns, scriptSigns } from '../shellguard.js';

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

// Параметры, общие для команды и скрипта: переменные окружения и куда девать stdout.
const common = {
  env: z.record(z.string()).optional().describe(pick({ ru: 'значение или cr://secret/…', en: 'value or cr://secret/…' })),
  output: z.enum(['inline', 'artifact']).optional().describe(pick({
    ru: 'artifact — stdout файлом: ссылка, размер, sha256',
    en: 'artifact — stdout as a file: link, size, sha256',
  })),
  name: z.string().optional(),
};

/** Выполняет и собирает ответ: stdout в тексте либо в артефакте. */
async function run(client, command, args, { resolved, secrets, stdin, label, fallbackName }) {
  const artifact = args.output === 'artifact' ? newArtifact(safeName(args.name || fallbackName)) : null;

  const res = await exec(client, command, {
    cwd: args.cwd || resolved.config.cwd,
    stdin,
    vars: args.env,
    timeoutMs: args.timeout ? args.timeout * 1000 : cfg.execTimeoutMs,
    stdoutTo: artifact ? { file: artifact.path, secrets } : undefined,
  });

  if (!artifact) {
    return { data: shape(res), ok: res.code === 0, exitCode: res.code, command: label ?? res.command, stdout: res.stdout, stderr: res.stderr };
  }

  const data = {
    exitCode: res.code,
    signal: res.signal,
    timedOut: res.timedOut,
    uri: artifact.uri,
    url: artifact.url,
    bytes: res.file.bytes,
    sha256: res.file.sha256,
    stderr: res.stderr,
  };
  return {
    data,
    ok: res.code === 0,
    exitCode: res.code,
    command: label ?? res.command,
    stdout: `(stdout в артефакте ${artifact.uri}, ${res.file.bytes} Б, sha256:${res.file.sha256})`,
    stderr: res.stderr,
  };
}

const envNames = (args) => (args.env ? Object.keys(args.env).join(', ') : undefined);

export const tools = [
  {
    name: 'ssh_exec',
    group: GROUP,
    needsConnection: true,
    kinds: ['shell'],
    mutating: true,
    // Ключ или токен открытым текстом в команде отклоняется; в stdin и env вместо значения
    // принимается ссылка на секрет реестра — он подставляется на сервере.
    scan: ['command', 'stdin', 'env'],
    secretRefs: ['stdin', 'env'],
    writeSigns: (args) => writeSigns(args.command),
    title: pick({ ru: 'Выполнить команду', en: 'Run a command' }),
    description: pick({
      ru: 'Выполняет команду на сервере по алиасу подключения. Возвращает код возврата и оба потока; '
        + 'большой вывод — output: artifact. Каждый вызов целиком попадает в журнал. Секрет открытым '
        + 'текстом отклоняется: положите его через secret_set и передайте ссылкой cr://secret/… в stdin или env.',
      en: 'Runs a command on the server behind the alias. Returns the exit code and both streams; large '
        + 'output — output: artifact. Every call is journalled in full. A plaintext secret is refused: store '
        + 'it with secret_set and pass a cr://secret/… reference in stdin or env.',
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
      ...common,
    },
    summary: (args, resolved) => `Выполнить на «${args.alias}» (${resolved?.host?.address}): ${args.command}`,
    details: (args, resolved) => ({
      каталог: args.cwd || resolved?.config?.cwd || '—',
      пользователь: resolved?.host?.username,
      переменные: envNames(args),
    }),
    run: async (args, { resolved, approveHostKey, secrets }) => {
      const client = await connect(resolved.host, { approveHostKey });
      return run(client, args.command, args, {
        resolved, secrets, stdin: args.stdin, label: null, fallbackName: 'stdout.txt',
      });
    },
  },

  {
    name: 'ssh_script',
    group: GROUP,
    needsConnection: true,
    kinds: ['shell'],
    mutating: true,
    // Скрипт — код, а не значение: ссылки на секреты принимаются только в env.
    scan: ['script', 'env'],
    secretRefs: ['env'],
    writeSigns: (args, resolved) => scriptSigns(args.script, args.interpreter || resolved?.config?.shell || 'sh'),
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
      ...common,
    },
    summary: (args, resolved) => `Выполнить скрипт на «${args.alias}» (${resolved?.host?.address}), `
      + `${args.script.split('\n').length} строк`,
    details: (args) => ({ скрипт: args.script.slice(0, 1500), переменные: envNames(args) }),
    run: async (args, { resolved, approveHostKey, secrets }) => {
      const client = await connect(resolved.host, { approveHostKey });
      const interpreter = args.interpreter || resolved.config.shell || 'sh';
      return run(client, `${quote(interpreter)} -s`, args, {
        resolved,
        secrets,
        stdin: args.script,
        label: `${interpreter} -s <<< (${args.script.split('\n').length} строк)`,
        fallbackName: 'script-stdout.txt',
      });
    },
  },
];
