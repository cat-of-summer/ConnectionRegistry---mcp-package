import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Журнал и маскирование проверяются на отдельном корне: тест не должен ни читать,
// ни портить настоящий журнал стенда.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-journal-'));
process.env.CR_ROOT = root;
process.env.CR_LOG_INLINE_BYTES = '256';
process.env.CR_LOG_FILE_BYTES = '4096';
process.env.CR_LOG_MAX_BYTES = '12288';

const log = await import('../src/audit/log.js');
const query = await import('../src/audit/query.js');

const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

const masked = /^••••\[[^\]]+, \d+ Б, sha256:[0-9a-f]{8}\]$/;

test('поля с секретами маскируются по имени', () => {
  const out = log.maskArgs({
    alias: 'shop/db',
    password: 'hunter2',
    nested: { privateKey: '-----BEGIN', token: 'abc' },
    list: [{ secret: 'x' }],
    command: 'ls -la',
  });

  // На месте секрета остаётся примета: вид, длина и отпечаток. По ней видно,
  // один ли ключ ходил в двух записях, — при том что самого ключа в журнале нет.
  assert.match(out.password, masked);
  assert.match(out.nested.privateKey, masked);
  assert.match(out.nested.token, masked);
  assert.match(out.list[0].secret, masked);
  assert.equal(out.command, 'ls -la');
  assert.equal(out.alias, 'shop/db');
});

test('поле, секретное только у одного инструмента, объявляется им самим', () => {
  // value у secret_set — приватный ключ, у notes_set — значение факта.
  assert.match(log.maskArgs({ value: PEM }, ['value']).value, masked);
  assert.equal(log.maskArgs({ value: 'php.version = 8.3' }).value, 'php.version = 8.3');
});

test('секрет ловится и там, где имя поля ничего не говорит', () => {
  const out = log.maskArgs({ command: `echo '${PEM}' > id_ed25519`, stdin: PEM });

  assert.equal(out.command.includes('BEGIN OPENSSH'), false, 'ключ остался в команде');
  assert.equal(out.command.startsWith("echo '"), true, 'вырезан только ключ, а не вся команда');
  assert.equal(out.stdin.includes('BEGIN OPENSSH'), false, 'ключ остался в stdin');
});

test('значение секрета вычищается из вывода', () => {
  const out = log.scrub('mysql -u root -phunter2 && echo hunter2', ['hunter2']);
  assert.equal(out.includes('hunter2'), false);
  assert.equal(out.includes('••••'), true);
});

test('короткая строка не считается секретом: иначе вычистили бы пол-вывода', () => {
  assert.equal(log.scrub('abc abc', ['abc']), 'abc abc');
});

test('запись попадает в файл и читается обратно целиком', () => {
  const entry = log.start({ tool: 'ssh_exec', alias: 'shop/shell', args: { command: 'id', password: 'hunter2' } });
  const record = log.finish(entry, { ok: true, exitCode: 0, command: 'id', stdout: 'uid=0(root)', stderr: '' });

  const found = query.get(record.id);
  assert.equal(found.tool, 'ssh_exec');
  assert.equal(found.alias, 'shop/shell');
  assert.equal(found.stdout, 'uid=0(root)');
  assert.match(found.args.password, masked);

  const list = query.list({ alias: 'shop/shell', limit: 5 });
  assert.equal(list.entries[0].id, record.id);
});

test('крупные аргументы уезжают в блоб и возвращаются целиком', () => {
  const big = 'y'.repeat(5000);
  const entry = log.start({ tool: 'files_put', alias: 'shop/files', args: { dest: 'big.txt', content: big } });
  const record = log.finish(entry, { ok: true, command: 'put big.txt', stdout: '', stderr: '' });

  assert.equal(record.argsTruncated, true);
  assert.ok(record.argsBlob, 'ссылка на блоб проставлена');
  assert.ok(JSON.stringify(record.args).length < big.length, 'в строке журнала аргументов уже нет');

  assert.equal(query.get(record.id).args.content, big);
});

test('обычная запись полей про блоб не заводит и читается как раньше', () => {
  const entry = log.start({ tool: 'ssh_exec', alias: 'shop/shell', args: { command: 'id' } });
  const record = log.finish(entry, { ok: true, command: 'id', stdout: 'uid=0(root)', stderr: '' });

  assert.equal('argsBlob' in record, false);
  assert.equal('commandBlob' in record, false);

  const found = query.get(record.id);
  assert.deepEqual(found.args, { command: 'id' });
  assert.equal(found.command, 'id');
});

test('крупный вывод уезжает в блоб, но возвращается целиком', () => {
  const big = 'x'.repeat(5000);
  const entry = log.start({ tool: 'files_read', alias: 'shop/files', args: {} });
  const record = log.finish(entry, { ok: true, stdout: big, stderr: '' });

  assert.equal(record.stdoutTruncated, true);
  assert.ok(record.stdoutBlob, 'ссылка на блоб проставлена');
  assert.ok(record.stdout.length < big.length, 'в строке журнала только начало');

  assert.equal(query.get(record.id).stdout.length, big.length);
});

test('переполнение потолка убирает самые старые файлы', () => {
  // Пишем заведомо больше потолка: файлы по 4 КБ, потолок 12 КБ.
  for (let i = 0; i < 40; i++) {
    const entry = log.start({ tool: 'ssh_exec', alias: 'shop/shell', args: { i } });
    log.finish(entry, { ok: true, stdout: 'y'.repeat(200), stderr: '' });
  }

  assert.ok(log.logSize() <= 12288 * 1.5, `журнал держится у потолка, сейчас ${log.logSize()}`);

  // Ротация не должна ломать чтение: свежие записи на месте, старые просто исчезли.
  const list = query.list({ limit: 5 });
  assert.ok(list.entries.length > 0);
});

test('выборка по несуществующему окну отвечает пустотой, а не ошибкой', () => {
  const res = query.list({ since: '1999-01-01T00:00:00.000Z', until: '1999-01-02T00:00:00.000Z', limit: 10 });
  assert.deepEqual(res.entries, []);
});
