import test from 'node:test';
import assert from 'node:assert/strict';

import { detect, redact, maskWhole, scanArgs, fingerprint } from '../src/secrets.js';

// Детектор ловит секрет по содержимому, поэтому у него две одинаково важные стороны.
// Пропущенная находка кладёт ключ в журнал открытым текстом; ложная — отклоняет
// обычную команду и останавливает работу. Проверяются обе.

const KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  'c2gtZWQyNTUxOQAAACDJyah9vv9nLaSNuQI00eNdFK+2C1bRJDZksf9qSP5ihQAA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

const hard = (text) => detect(text).filter((f) => f.hard);

test('приватный ключ опознаётся и описывается видом, длиной и отпечатком', () => {
  const found = hard(KEY);

  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'private_key');
  assert.equal(found[0].detail, 'openssh');
  assert.equal(found[0].bytes, Buffer.byteLength(KEY));

  const out = redact(`echo '${KEY}' > id_ed25519`);
  assert.equal(out.includes('BEGIN OPENSSH'), false, 'ключа в тексте не осталось');
  assert.match(out, /••••\[private_key openssh, \d+ Б, sha256:[0-9a-f]{8}\]/);
  assert.equal(out.startsWith("echo '"), true, 'остальной текст не тронут');
});

test('обрезанный ключ без END тоже вырезается', () => {
  const cut = KEY.split('\n').slice(0, 3).join('\n');
  const out = redact(cut);
  assert.equal(out.includes('b3BlbnNzaC1rZXktdjEA'), false);
});

test('одинаковый ключ даёт одинаковый отпечаток, разный — разный', () => {
  assert.equal(fingerprint(KEY), fingerprint(KEY));
  assert.notEqual(fingerprint(KEY), fingerprint(`${KEY}\n`));
});

test('однозначные токены ловятся как hard', () => {
  const cases = {
    jwt: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    github_token: 'git remote set-url origin https://ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    slack_token: 'curl -H "token: xoxb-123456789012-abcdefghijkl"',
    aws_key_id: 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE',
  };

  for (const [kind, text] of Object.entries(cases)) {
    const found = hard(text);
    assert.equal(found.length, 1, `${kind}: ожидалась одна находка, получено ${found.length}`);
    assert.equal(found[0].kind, kind);
    assert.equal(redact(text).includes(text.split(/\s/).pop()), false, `${kind}: значение осталось в тексте`);
  }
});

test('в строке подключения прячется только пароль', () => {
  const out = redact('psql postgres://shop:hunter2@db.local:5432/shop');

  assert.equal(out.includes('hunter2'), false);
  assert.equal(out.includes('postgres://shop:'), true, 'пользователь и схема остались');
  assert.equal(out.includes('@db.local:5432/shop'), true, 'адрес и база остались');
});

test('эвристики маскируют, но остаются soft — вызов из-за них не отклоняется', () => {
  const cases = [
    'PGPASSWORD=hunter2 psql -h db -U shop',
    'mysqldump -u root -phunter2 shop',
    'curl --password hunter2 https://example.org',
    'sshpass -p hunter2 ssh deploy@srv',
    'DB_PASSWORD=hunter2',
    '"api_key": "hunter2-abcdef"',
  ];

  for (const text of cases) {
    const found = detect(text);
    assert.ok(found.length >= 1, `не найдено ничего в «${text}»`);
    assert.equal(found.some((f) => f.hard), false, `«${text}» отмечено как hard`);
    assert.equal(redact(text).includes('hunter2'), false, `пароль остался в «${text}»`);
  }
});

test('обычные команды не считаются секретом: ложная находка блокирует работу', () => {
  const innocent = [
    'ls -la /var/www && git status',
    'ssh -p 2222 deploy@srv',
    'php artisan migrate --force',
    'docker compose up -d --build',
    'grep -rn "password" src/ | head',
    'openssl x509 -in cert.pem -noout -text',
    'tar czf dump.tgz /var/backups && sha256sum dump.tgz',
    'SELECT id, token_expires_at FROM users WHERE id = 1',
  ];

  for (const text of innocent) {
    assert.deepEqual(detect(text), [], `ложная находка в «${text}»`);
  }
});

test('подстановки и переменные секретом не считаются', () => {
  for (const text of ['PGPASSWORD=$DB_PASS psql', 'password: {{vault.pass}}', 'stdin: cr://secret/shop/srv#private_key']) {
    assert.deepEqual(detect(text), [], `подстановка принята за секрет: «${text}»`);
  }
});

test('повторный проход по уже замаскированному тексту ничего не меняет', () => {
  const once = redact(`PGPASSWORD=hunter2 psql; ${KEY}`);
  assert.equal(redact(once), once);
});

test('maskWhole прячет значение целиком и называет вид', () => {
  assert.match(maskWhole(KEY, 'private_key'), /^••••\[private_key openssh, \d+ Б, sha256:[0-9a-f]{8}\]$/);
  assert.match(maskWhole('hunter2', 'password'), /^••••\[password, 7 Б, sha256:[0-9a-f]{8}\]$/);
});

test('scanArgs смотрит только в названные поля и помнит имя поля', () => {
  const args = { alias: 'shop/shell', command: 'cat > key', stdin: KEY };

  assert.deepEqual(scanArgs(args, ['command']), []);

  const found = scanArgs(args, ['command', 'stdin']);
  assert.equal(found.length, 1);
  assert.equal(found[0].field, 'stdin');
  assert.equal(found[0].hard, true);
});
