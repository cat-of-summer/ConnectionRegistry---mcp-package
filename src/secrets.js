import crypto from 'node:crypto';

// Секрет узнаётся по содержимому, а не по имени поля. Пароль в host_set лежит в поле
// «password» и маскируется списком имён; приватный ключ, переданный в ssh_exec, лежит
// в поле «command» — и тем же списком не ловится никак. Поэтому текст разбирается
// сам по себе, где бы он ни ехал: в аргументах, в команде, в выводе.
//
// Найденное не вырезается молча: на его месте остаётся примета — вид, длина и отпечаток.
// Журнал от этого остаётся годен для разбора: видно, один ли ключ ходил в двух записях
// и тот ли это ключ, что лежит в реестре, — при том что самого ключа в журнале нет.
//
// Находки двух классов, и разделение здесь принципиальное:
//   hard — то, что не бывает ничем другим: PEM-блок, JWT, токен с опознаваемым префиксом.
//          По ним вызов в shell и files отклоняется целиком.
//   soft — эвристика вида PGPASSWORD=…: маскируется, но работу не останавливает.
//          Цена ложной находки здесь — заблокированная команда, и платить ею за догадку
//          нельзя.

const MASK = '••••';

/**
 * group — какую часть совпадения прятать: 0 — всё, N — N-ю скобку. Пряча в строке
 * подключения только пароль, мы оставляем читаемыми хост, порт и имя базы.
 */
const PATTERNS = [
  {
    kind: 'private_key',
    hard: true,
    // Хвост «или конец строки» нужен для обрезанного ключа: без него блок без END
    // не распознался бы и уехал бы в журнал целиком.
    re: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
    detail: (m) => {
      const type = m[1].replace(/ ?PRIVATE KEY$/, '').toLowerCase();
      return type || 'pkcs8';
    },
  },
  {
    kind: 'private_key',
    hard: true,
    re: /PuTTY-User-Key-File-\d+:[\s\S]*?(?:Private-MAC:[ \t]*\S+|$)/g,
    detail: () => 'putty',
  },
  {
    kind: 'jwt',
    hard: true,
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    kind: 'github_token',
    hard: true,
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    kind: 'slack_token',
    hard: true,
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    kind: 'aws_key_id',
    hard: true,
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: 'aws_secret_key',
    hard: true,
    group: 1,
    re: /\baws_secret_access_key\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
  },
  {
    kind: 'connection_string',
    hard: true,
    group: 3,
    re: /\b(postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|ftps?|sftp|https?):\/\/([^\s:@/]+):([^\s@/]{1,256})@/g,
  },

  {
    kind: 'password',
    hard: false,
    group: 1,
    re: /\b(?:PGPASSWORD|MYSQL_PWD)=(\S+)/g,
  },
  {
    kind: 'password',
    hard: false,
    group: 1,
    re: /--password[= ]("[^"\n]{1,256}"|'[^'\n]{1,256}'|\S+)/g,
  },
  {
    kind: 'password',
    hard: false,
    group: 1,
    re: /\bsshpass\s+-p\s*("[^"\n]{1,256}"|'[^'\n]{1,256}'|\S+)/g,
  },
  {
    kind: 'password',
    hard: false,
    group: 1,
    // -p вплотную к значению — это mysql и только он: у ssh -p порт, и он идёт через пробел.
    re: /\bmysql(?:dump|admin)?\b[^\n]{0,200}?\s-p(\S+)/g,
  },
  {
    kind: 'password',
    hard: false,
    group: 1,
    // Присваивание в .env, yaml и json разом: PASSWORD=…, "token": "…", secret: '…'.
    re: /(?:^|[\s,{[])["']?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?([^\s"',;}\]]{4,256})/gi,
  },
];

/** Подстановки, переменные и уже замаскированное за секрет не считаются. */
function looksSubstituted(value) {
  return value.startsWith('$')
    || value.startsWith('%')
    || value.startsWith('{{')
    || value.startsWith('cr://')
    || value.includes(MASK);
}

export function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8)}`;
}

/** «private_key openssh, 1704 Б, sha256:ab12cd34» — вид, длина и отпечаток. */
export function describe(finding) {
  const kind = finding.detail ? `${finding.kind} ${finding.detail}` : finding.kind;
  return `${kind}, ${finding.bytes} Б, ${finding.fp}`;
}

export function label(finding) {
  return `${MASK}[${describe(finding)}]`;
}

/**
 * Что в тексте похоже на секрет. Находки не пересекаются: пересёкшиеся отбрасываются
 * в пользу найденной раньше — порядок в PATTERNS от точного к эвристическому.
 */
export function detect(text) {
  if (!text) return [];
  const value = String(text);
  const found = [];

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match = pattern.re.exec(value);

    while (match) {
      const group = pattern.group ?? 0;
      const captured = match[group];

      if (captured && !looksSubstituted(captured)) {
        const start = group === 0 ? match.index : match.index + match[0].indexOf(captured);
        const end = start + captured.length;

        if (!found.some((f) => start < f.end && end > f.start)) {
          found.push({
            kind: pattern.kind,
            detail: pattern.detail ? pattern.detail(match) : null,
            hard: pattern.hard,
            start,
            end,
            bytes: Buffer.byteLength(captured),
            fp: fingerprint(captured),
          });
        }
      }

      // Совпадение нулевой длины сдвигаем руками: иначе exec крутится на месте.
      if (match.index === pattern.re.lastIndex) pattern.re.lastIndex += 1;
      match = pattern.re.exec(value);
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

/** Тот же текст, но найденное заменено приметами. */
export function redact(text) {
  if (!text) return text;
  const value = String(text);
  const found = detect(value);
  if (!found.length) return value;

  let out = '';
  let cursor = 0;
  for (const finding of found) {
    out += value.slice(cursor, finding.start) + label(finding);
    cursor = finding.end;
  }
  return out + value.slice(cursor);
}

/**
 * Примета вместо значения целиком — для полей, которые секретны по имени
 * (password в host_set, value в secret_set): там прятать надо всё, а не кусок.
 */
export function maskWhole(value, kindHint = 'secret') {
  const text = String(value ?? '');
  const inner = detect(text).find((f) => f.hard);
  return label({
    kind: inner ? inner.kind : kindHint,
    detail: inner ? inner.detail : null,
    bytes: Buffer.byteLength(text),
    fp: fingerprint(text),
  });
}

/**
 * Ищет секреты в названных полях аргументов. Возвращает находки с именем поля —
 * отказ должен сказать человеку и агенту, где именно лежит ключ.
 */
export function scanArgs(args, fields = []) {
  const found = [];
  for (const field of fields) {
    const value = args?.[field];
    if (typeof value !== 'string') continue;
    for (const finding of detect(value)) found.push({ ...finding, field });
  }
  return found;
}
