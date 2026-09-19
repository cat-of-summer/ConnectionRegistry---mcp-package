import { connect, exec, quote } from './ssh.js';
import { cfg } from '../config.js';

// docker вызывается своим же CLI на хосте: ни сокета наружу, ни второго набора
// кредов. Контейнер по умолчанию берётся из подключения, поэтому агенту хватает
// алиаса — «перезапусти myproject/queue».

function prefix(resolved) {
  return resolved.config.sudo ? 'sudo docker' : 'docker';
}

export function container(resolved, override) {
  const name = override || resolved.config.container;
  if (!name) {
    throw new Error(`у подключения «${resolved.alias}» не задан контейнер — передайте container явно`);
  }
  return name;
}

export async function run(resolved, argv, { approveHostKey, timeoutMs } = {}) {
  const client = await connect(resolved.host, { approveHostKey });
  const command = `${prefix(resolved)} ${argv.join(' ')}`;
  return exec(client, command, { cwd: resolved.config.workdir, timeoutMs: timeoutMs || cfg.execTimeoutMs });
}

export async function compose(resolved, argv, { approveHostKey, timeoutMs } = {}) {
  const file = resolved.config.composeFile;
  const head = file ? `${prefix(resolved)} compose -f ${quote(file)}` : `${prefix(resolved)} compose`;
  const client = await connect(resolved.host, { approveHostKey });
  return exec(client, `${head} ${argv.join(' ')}`, {
    cwd: resolved.config.workdir,
    timeoutMs: timeoutMs || cfg.execTimeoutMs,
  });
}

export { quote };
