#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { cfg } from '../src/config.js';
import { DIRS, DB_FILE, ensureDirs } from '../src/paths.js';
import { db } from '../src/registry/db.js';
import { keyState } from '../src/registry/crypto.js';
import { listHosts, upsertHost, removeHost, pinHostKey, hostUsage } from '../src/registry/hosts.js';
import { listConnections, getConnection, upsertConnection, removeConnection, projects } from '../src/registry/connections.js';
import { getNotes, setFact, setText, removeFact } from '../src/registry/notes.js';
import * as auditQuery from '../src/audit/query.js';
import { logSize } from '../src/audit/log.js';

// Командная строка нужна там, где агента ещё нет: завести первый хост, положить
// ключ, посмотреть журнал, разрешить заявку с сервера без браузера.

const argv = process.argv.slice(2);

function flags(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item.startsWith('--')) { out._.push(item); continue; }
    const [name, inline] = item.slice(2).split('=');
    if (inline !== undefined) { out[name] = inline; continue; }
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) { out[name] = true; continue; }
    out[name] = next;
    i++;
  }
  return out;
}

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function die(message) {
  console.error(message);
  process.exit(1);
}

/** Секрет читается из файла (--password-file) или stdin (--password -): аргументы видны в ps и в history. */
function secretFrom(args, key) {
  const file = args[`${key}-file`];
  if (file) return trimEol(fs.readFileSync(file, 'utf8'));
  if (args[key] === true || args[key] === '-') return trimEol(fs.readFileSync(0, 'utf8'));
  return args[key];
}

/** Один завершающий перевод строки — след редактора, а не часть пароля. */
function trimEol(value) {
  if (value.endsWith(String.fromCharCode(13, 10))) return value.slice(0, -2);
  if (value.endsWith(String.fromCharCode(10))) return value.slice(0, -1);
  return value;
}

async function api(pathname, init) {
  const base = `http://127.0.0.1:${cfg.port}`;
  const res = await fetch(base + pathname, init).catch((err) => {
    die(`сервер реестра не отвечает на ${base}: ${err.message}`);
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(body.error || `${res.status}`);
  return body;
}

const COMMANDS = {
  doctor() {
    ensureDirs();
    const key = keyState();
    const counts = { хостов: listHosts().length, подключений: listConnections().length, проектов: projects().length };

    print({
      версия: cfg.version,
      мастерКлюч: key.unlocked ? 'есть' : `нет (${key.reason}${key.message ? `: ${key.message}` : ''})`,
      базаРеестра: { файл: DB_FILE, есть: fs.existsSync(DB_FILE), права: modeOf(DB_FILE) },
      каталоги: Object.fromEntries(Object.entries(DIRS).map(([name, dir]) => [name, `${dir} ${fs.existsSync(dir) ? 'есть' : 'НЕТ'}`])),
      реестр: counts,
      журнал: { размерБайт: logSize(), потолокБайт: cfg.logMaxBytes },
      сервер: `http://127.0.0.1:${cfg.port}`,
    });

    if (!key.unlocked) {
      console.error('\nРеестр заперт: задайте CR_MASTER_KEY в .env. Сгенерировать: cr key gen');
      process.exitCode = 1;
    }
  },

  key(args) {
    if (args._[0] !== 'gen') return die('cr key gen');
    print(crypto.randomBytes(32).toString('base64'));
  },

  host(args) {
    const [action, alias] = args._;

    if (!action || action === 'ls') return print(listHosts().map((h) => ({ ...h, usedBy: hostUsage(h.alias) })));

    if (action === 'add' || action === 'set') {
      if (!alias) return die('cr host add <алиас> --address … --user … [--password | --key-file …]');
      return print(upsertHost({
        alias,
        address: args.address,
        port: args.port ? Number(args.port) : undefined,
        user: args.user,
        auth: args.auth,
        password: secretFrom(args, 'password'),
        privateKey: args['key-file'] ? fs.readFileSync(args['key-file'], 'utf8') : undefined,
        passphrase: secretFrom(args, 'passphrase'),
        hostKey: args['host-key'],
        note: args.note,
      }));
    }

    if (action === 'pin') {
      if (!alias || !args.fingerprint) return die('cr host pin <алиас> --fingerprint SHA256:…');
      return print(pinHostKey(alias, args.fingerprint));
    }

    if (action === 'rm') return print(removeHost(alias));

    return die(`cr host: неизвестное действие «${action}»`);
  },

  conn(args) {
    const [action, alias] = args._;

    if (!action || action === 'ls') return print(listConnections({ project: args.project, kind: args.kind }));
    if (action === 'show') return print(getConnection(alias));

    if (action === 'add' || action === 'set') {
      if (!alias) return die('cr conn add <проект/имя> --kind shell --host <хост> [--config \'{"cwd":"/var/www"}\']');
      let config;
      if (args.config) {
        try { config = JSON.parse(args.config); } catch (err) { return die(`--config не разобран как JSON: ${err.message}`); }
      }
      return print(upsertConnection({
        alias,
        kind: args.kind,
        host: args.host === 'none' ? null : args.host,
        config,
        password: secretFrom(args, 'password'),
        confirm: args.confirm,
        note: args.note,
      }));
    }

    if (action === 'rm') return print(removeConnection(alias));

    return die(`cr conn: неизвестное действие «${action}»`);
  },

  note(args) {
    const [action, project, key] = args._;

    if (!action || action === 'get') {
      if (!project) return print({ projects: projects() });
      return print(getNotes(project));
    }
    if (action === 'set') {
      if (args.text !== undefined) return print(setText(project, secretFrom(args, 'text')));
      if (!key) return die('cr note set <проект> <ключ> <значение> | cr note set <проект> --text …');
      return print(setFact(project, key, args._.slice(3).join(' ')));
    }
    if (action === 'rm') return print(removeFact(project, key));

    return die(`cr note: неизвестное действие «${action}»`);
  },

  log(args) {
    const [action, id] = args._;

    if (!action || action === 'tail') {
      const res = auditQuery.list({
        alias: args.alias,
        tool: args.tool,
        onlyErrors: Boolean(args.errors),
        limit: Number(args.limit) || 20,
      });
      for (const entry of res.entries.reverse()) {
        const mark = entry.ok ? 'ок ' : 'ОШ ';
        console.log(`${entry.ts}  ${mark} ${entry.tool.padEnd(14)} ${(entry.alias || '').padEnd(20)} `
          + `${(entry.command || entry.error || '').slice(0, 90)}   [${entry.id}]`);
      }
      return undefined;
    }

    if (action === 'show') {
      const record = auditQuery.get(id);
      if (!record) return die(`записи «${id}» нет`);
      return print(record);
    }

    return die(`cr log: неизвестное действие «${action}»`);
  },

  async approve(args) {
    const [action, id] = args._;

    if (!action || action === 'ls') {
      const data = await api('/api/approvals');
      if (!data.pending.length) return print('Ждущих заявок нет.');
      for (const item of data.pending) console.log(`${item.ts}  ${item.tool}  ${item.alias || ''}\n  ${item.summary}\n  [${item.id}]`);
      return undefined;
    }

    if (action === 'yes' || action === 'no') {
      const decision = action === 'yes' ? 'approved' : 'declined';
      return print(await api(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      }));
    }

    return die(`cr approve: неизвестное действие «${action}»`);
  },
};

function modeOf(file) {
  try { return (fs.statSync(file).mode & 0o777).toString(8); } catch { return '—'; }
}

const HELP = `cr — реестр подключений

  cr doctor                          состояние: ключ, база, каталоги, журнал
  cr key gen                         сгенерировать значение для CR_MASTER_KEY

  cr host ls
  cr host add <алиас> --address <адрес> --user <логин> [--password | --password-file <ф> | --key-file <ф>]
                      [--port 22] [--passphrase-file <ф>] [--host-key SHA256:…] [--note …]
  cr host pin <алиас> --fingerprint SHA256:…
  cr host rm  <алиас>

  cr conn ls [--project <проект>] [--kind shell|files|docker|db]
  cr conn show <проект/имя>
  cr conn add  <проект/имя> --kind <тип> [--host <хост>|--host none] [--config '<json>']
                            [--password-file <ф>] [--confirm always|writes|never] [--note …]
  cr conn rm   <проект/имя>

  cr note get [<проект>]
  cr note set <проект> <ключ> <значение>
  cr note set <проект> --text -        свободный текст со stdin
  cr note rm  <проект> <ключ>

  cr log tail [--alias …] [--tool …] [--errors] [--limit 20]
  cr log show <id>

  cr approve ls
  cr approve yes <id>  |  cr approve no <id>

Секреты передавайте файлом или через stdin (--password -): аргументы видны в ps и в history.
`;

async function main() {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') return print(HELP);

  const handler = COMMANDS[command];
  if (!handler) return die(`неизвестная команда «${command}»\n\n${HELP}`);

  db();
  await handler(flags(rest));
  return undefined;
}

main().catch((err) => die(err.message));
