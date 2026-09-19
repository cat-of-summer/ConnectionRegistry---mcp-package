import { tools as registry } from './registry.js';
import { tools as notes } from './notes.js';
import { tools as shell } from './shell.js';
import { tools as files } from './files.js';
import { tools as docker } from './docker.js';
import { tools as database } from './db.js';
import { tools as audit } from './audit.js';
import { tools as service } from './help.js';

// Набор инструментов выбирается адресом подключения, а не настройкой сервера:
// одна поднятая копия обслуживает и того, кому нужна только база, и того, кому
// нужен весь реестр, и смена набора не требует перезапуска.

export const ALL = [...service, ...registry, ...notes, ...shell, ...files, ...docker, ...database, ...audit];

export const GROUPS = ALL.reduce((acc, tool) => {
  (acc[tool.group] ||= []).push(tool.name);
  return acc;
}, {});

// service есть на любом адресе: агент, не нашедший инструмента, иначе решил бы,
// что реестр неисправен, вместо того чтобы посмотреть registry_info.
const ALWAYS = ['service'];

export const ALIASES = {
  all: ['registry', 'notes', 'shell', 'files', 'docker', 'db', 'audit'],
  core: ['registry', 'notes', 'shell', 'files'],
  minimal: ['registry'],
  ops: ['registry', 'shell', 'docker', 'audit'],
};

/**
 * Разбирает хвост адреса: /mcp → всё, /mcp/db+audit → названные группы.
 * Порядок не важен, «db+audit» и «audit+db» — одно и то же.
 */
export function select(spec) {
  const requested = String(spec || 'all')
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((part) => ALIASES[part] || [part]);

  const unknown = requested.filter((name) => !GROUPS[name]);
  if (unknown.length) {
    const err = new Error(`неизвестные группы: ${unknown.join(', ')}. Есть: ${Object.keys(GROUPS).join(', ')}`);
    err.code = 'unknown_group';
    throw err;
  }

  const groups = [...new Set([...ALWAYS, ...(requested.length ? requested : ALIASES.all)])];
  const tools = ALL.filter((tool) => groups.includes(tool.group));
  return { groups, tools };
}
