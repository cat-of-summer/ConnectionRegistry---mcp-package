import path from 'node:path';
import { classify } from './transport/db/sql.js';

// Похожа ли команда на изменяющую. Нужна там, где хост помечен «только чтение»: ssh_exec
// по построению изменяющий, и без разбора команды каждое `ls` на проде спрашивало бы
// человека — а вопрос, который задают на всё, перестают читать.
//
// Это эвристика, и она это знает. Команда разбирается как шелл без исполнения: кавычки,
// перенаправления, цепочки, `sh -c` и подстановки `$(…)`. Интерпретатор, запись через
// python -c или хитрое экранирование она пропустит — задача ловить случайности, а не
// злой умысел. Ошибка в другую сторону дешевле: лишний вопрос человеку, а не тихая запись.

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'busybox']);

// Префиксы, за которыми идёт настоящая команда.
const WRAPPERS = new Set(['sudo', 'nohup', 'env', 'time', 'command', 'exec', 'nice', 'ionice', 'timeout', 'xargs', 'stdbuf']);

const ALWAYS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'ln', 'mkdir', 'touch', 'truncate', 'dd', 'chmod', 'chown', 'chgrp',
  'tee', 'install', 'unlink', 'shred', 'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt',
  'useradd', 'userdel', 'usermod', 'passwd', 'rsync', 'scp', 'patch', 'mount', 'umount',
]);

const GIT = new Set(['pull', 'merge', 'checkout', 'switch', 'reset', 'commit', 'push', 'stash', 'clean', 'rebase',
  'cherry-pick', 'revert', 'am', 'apply', 'rm', 'mv', 'restore', 'tag', 'branch', 'init', 'clone', 'fetch']);

const SYSTEMCTL = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'kill', 'daemon-reload', 'try-restart', 'reload-or-restart']);

const DOCKER = new Set(['rm', 'rmi', 'stop', 'start', 'restart', 'kill', 'run', 'create', 'cp', 'pull', 'build', 'prune',
  'up', 'down', 'pause', 'unpause', 'update', 'rename', 'commit', 'load', 'import', 'tag', 'push']);

const PACKAGES = {
  apt: ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'autoremove', 'update'],
  'apt-get': ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'autoremove', 'update'],
  yum: ['install', 'remove', 'erase', 'update', 'upgrade'],
  dnf: ['install', 'remove', 'erase', 'update', 'upgrade'],
  apk: ['add', 'del', 'upgrade', 'update'],
  pip: ['install', 'uninstall'],
  pip3: ['install', 'uninstall'],
  npm: ['install', 'i', 'ci', 'uninstall', 'update', 'link', 'publish'],
  yarn: ['add', 'install', 'remove', 'upgrade'],
  composer: ['install', 'update', 'require', 'remove', 'dump-autoload', 'dumpautoload'],
};

const ARTISAN = /^(migrate|db:|down$|up$|key:generate|storage:link|queue:restart|optimize|.*:clear$|.*:cache$|vendor:publish|schedule:run|tinker$)/;

const SQL_CLIENTS = new Set(['mysql', 'mariadb', 'psql']);

const NULL_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/** Разбивает текст на простые команды: слова и перенаправления. */
function lex(text) {
  const segments = [];
  const nested = [];
  let words = [];
  let redirs = [];
  let word = null;
  let pendingRedir = null;
  let heredocs = [];
  let i = 0;
  const s = String(text);

  const pushWord = () => {
    if (word === null) return;
    if (pendingRedir) {
      if (pendingRedir.op === '<<' || pendingRedir.op === '<<-') heredocs.push(word);
      else redirs.push({ ...pendingRedir, target: word });
      pendingRedir = null;
    } else {
      words.push(word);
    }
    word = null;
  };
  const endSegment = () => {
    pushWord();
    if (words.length || redirs.length) segments.push({ words, redirs });
    words = [];
    redirs = [];
  };
  const skipHeredocs = () => {
    // Тело heredoc — данные, а не команды: пропускаем до строки-ограничителя.
    for (const delim of heredocs) {
      while (i < s.length) {
        const end = s.indexOf('\n', i);
        const line = s.slice(i, end === -1 ? s.length : end);
        i = end === -1 ? s.length : end + 1;
        if (line.trim() === delim) break;
      }
    }
    heredocs = [];
  };
  const closing = (from, open, close) => {
    let depth = 1;
    let j = from;
    while (j < s.length && depth > 0) {
      if (s[j] === open) depth++;
      else if (s[j] === close) depth--;
      j++;
    }
    return j;
  };

  while (i < s.length) {
    const ch = s[i];
    const two = s.slice(i, i + 2);

    if (ch === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') { i += 2; continue; }
      word = (word ?? '') + s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      word = (word ?? '') + s.slice(i + 1, end === -1 ? s.length : end);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        if (s.slice(j, j + 2) === '$(') {
          const end = closing(j + 2, '(', ')');
          nested.push(s.slice(j + 2, end - 1));
        }
        buf += s[j];
        j++;
      }
      word = (word ?? '') + buf;
      i = j + 1;
      continue;
    }
    if (two === '$(') {
      const end = closing(i + 2, '(', ')');
      nested.push(s.slice(i + 2, end - 1));
      word = (word ?? '') + '$()';
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      nested.push(s.slice(i + 1, end === -1 ? s.length : end));
      word = (word ?? '') + '``';
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (ch === '#' && word === null) {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === '\n') {
      endSegment();
      i++;
      if (heredocs.length) skipHeredocs();
      continue;
    }
    if (two === '&&' || two === '||') { endSegment(); i += 2; continue; }
    if (ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '{' && word === null || ch === '}' && word === null) {
      endSegment();
      i++;
      continue;
    }

    // Перенаправления: [n]>, [n]>>, &>, >&n, <, <<, <<-, <<<
    const redir = s.slice(i).match(/^(\d*|&)(>>?|<<<|<<-?|<)(&\d+|&-)?/);
    if (redir) {
      // 2>… — цифра была частью оператора; echo a>f — слово кончилось на операторе.
      if (word !== null && /^\d+$/.test(word)) word = null;
      else pushWord();
      const [all, , op, dup] = redir;
      i += all.length;
      if (dup) continue; // 2>&1 — не файл
      pendingRedir = { op };
      continue;
    }
    if (ch === '&') { endSegment(); i++; continue; }

    if (ch === ' ' || ch === '\t' || ch === '\r') { pushWord(); i++; continue; }

    word = (word ?? '') + ch;
    i++;
  }
  endSegment();

  return { segments, nested };
}

const base = (word) => path.posix.basename(String(word || ''));

/** Снимает sudo, env VAR=… и подобное: возвращает слова начиная с настоящей команды. */
function strip(words) {
  let k = 0;
  while (k < words.length) {
    const w = words[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { k++; continue; }
    if (WRAPPERS.has(base(w))) {
      k++;
      // Опции обёртки и аргумент timeout.
      while (k < words.length && (words[k].startsWith('-') || /^\d+[smhd]?$/.test(words[k]))) k++;
      continue;
    }
    break;
  }
  return words.slice(k);
}

function firstArg(args, skipWithValue = []) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (skipWithValue.includes(a)) { k++; continue; }
    if (a.startsWith('-')) continue;
    return { value: a, index: k };
  }
  return null;
}

function sqlArg(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-e' || a === '--execute' || a === '-c' || a === '--command') return args[k + 1] ?? '';
    const glued = a.match(/^(?:--execute=|--command=|-e(?=.)|-c(?=.))(.*)$/s);
    if (glued) return glued[1];
  }
  return null;
}

function inspectCommand(words, redirs, depth, signs) {
  for (const r of redirs) {
    if (r.op.startsWith('>') && !NULL_TARGETS.has(r.target)) signs.push(`запись в файл ${r.target}`);
  }

  const argv = strip(words);
  if (!argv.length) return;
  const name = base(argv[0]);
  const args = argv.slice(1);

  if (SHELLS.has(name)) {
    const c = args.indexOf('-c');
    if (c >= 0 && args[c + 1] !== undefined && depth < 4) collect(args[c + 1], depth + 1, signs);
    return;
  }
  if (name === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
    if (args.includes('-delete')) signs.push('find -delete');
    const exec = args.findIndex((a) => a === '-exec' || a === '-execdir');
    if (exec >= 0) inspectCommand(args.slice(exec + 1).filter((a) => a !== ';' && a !== '{}' && a !== '+'), [], depth + 1, signs);
    return;
  }
  if (ALWAYS.has(name)) {
    if (name === 'tee' && args.every((a) => a.startsWith('-') || NULL_TARGETS.has(a))) return;
    signs.push(name);
    return;
  }
  if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) { signs.push('sed -i'); return; }
  if (name === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) { signs.push('perl -i'); return; }
  if (name === 'git') {
    const sub = firstArg(args, ['-C', '-c', '--git-dir', '--work-tree']);
    if (sub && GIT.has(sub.value)) signs.push(`git ${sub.value}`);
    return;
  }
  if (name === 'crontab') {
    if (!args.includes('-l')) signs.push('crontab');
    return;
  }
  if (name === 'systemctl') {
    const sub = firstArg(args);
    if (sub && SYSTEMCTL.has(sub.value)) signs.push(`systemctl ${sub.value}`);
    return;
  }
  if (name === 'service') {
    if (args.some((a) => SYSTEMCTL.has(a))) signs.push(`service ${args.join(' ')}`);
    return;
  }
  if (name === 'docker' || name === 'docker-compose') {
    const rest = name === 'docker-compose' ? ['compose', ...args] : args;
    const sub = firstArg(rest, ['-H', '--host', '--context', '-f', '--file', '-p', '--project-name', '--env-file']);
    if (!sub) return;
    if (sub.value === 'compose' || ['volume', 'network', 'system', 'image', 'container'].includes(sub.value)) {
      const inner = firstArg(rest.slice(sub.index + 1), ['-f', '--file', '-p', '--project-name', '--env-file', '--profile']);
      if (inner && DOCKER.has(inner.value)) signs.push(`docker ${sub.value} ${inner.value}`);
      return;
    }
    if (DOCKER.has(sub.value)) signs.push(`docker ${sub.value}`);
    return;
  }
  if (PACKAGES[name]) {
    const sub = firstArg(args);
    if (sub && PACKAGES[name].includes(sub.value)) signs.push(`${name} ${sub.value}`);
    return;
  }
  if (name === 'php' || name === 'artisan') {
    const at = name === 'artisan' ? -1 : args.findIndex((a) => base(a) === 'artisan');
    if (name === 'php' && at < 0) return;
    const sub = firstArg(args.slice(at + 1));
    if (sub && ARTISAN.test(sub.value)) signs.push(`artisan ${sub.value}`);
    return;
  }
  if (SQL_CLIENTS.has(name)) {
    const sql = sqlArg(args);
    if (sql === null) {
      signs.push(`${name} без -e: запрос из stdin не разобрать`);
      return;
    }
    const shape = classify(sql);
    if (!shape.readonly) signs.push(`${name}: ${shape.kinds.join(', ') || 'запрос'}`);
  }
}

function collect(text, depth, signs) {
  const { segments, nested } = lex(text);
  for (const segment of segments) inspectCommand(segment.words, segment.redirs, depth, signs);
  if (depth < 4) for (const inner of nested) collect(inner, depth + 1, signs);
}

/**
 * Приметы записи в шелл-команде: «rm», «запись в файл /tmp/x», «git pull». Пустой
 * список — команда выглядит читающей.
 */
export function writeSigns(text) {
  const signs = [];
  collect(String(text ?? ''), 0, signs);
  return [...new Set(signs)];
}

/** Приметы записи для скрипта: не-шелл не разбирается, и это само по себе примета. */
export function scriptSigns(script, interpreter = 'sh') {
  const name = base(String(interpreter).trim().split(/\s+/)[0]);
  if (!SHELLS.has(name)) return [`скрипт для ${name} — не разбирается`];
  return writeSigns(script);
}
