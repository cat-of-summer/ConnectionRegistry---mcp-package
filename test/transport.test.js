import test from 'node:test';
import assert from 'node:assert/strict';
import { withVars } from '../src/transport/ssh.js';
import { parseEnv } from '../src/transport/credentials.js';
import { scrubber, scrubDeep } from '../src/secrets.js';

test('переменные уезжают в stdin, в строке команды только имена', () => {
  const res = withVars("cd '/srv' && mysql -e 'select 1'", { MYSQL_PWD: 'секрет-базы', LANG: 'C' }, 'данные');

  assert.equal(res.command, "{ IFS= read -r MYSQL_PWD && export MYSQL_PWD && IFS= read -r LANG && export LANG; } && cd '/srv' && mysql -e 'select 1'");
  assert.equal(res.stdin, 'секрет-базы\nC\nданные');
  assert.equal(res.command.includes('секрет-базы'), false);
});

test('без переменных команда и stdin не трогаются', () => {
  assert.deepEqual(withVars('ls', undefined, undefined), { command: 'ls', stdin: undefined });
  assert.deepEqual(withVars('ls', {}, 'x'), { command: 'ls', stdin: 'x' });
});

test('негодное имя и многострочное значение отклоняются', () => {
  assert.throws(() => withVars('ls', { 'A;rm': '1' }), /не годится/);
  assert.throws(() => withVars('ls', { KEY: 'a\nb' }), /многострочное/);
});

test('.env разбирается как его читает Laravel', () => {
  const env = parseEnv([
    '# комментарий',
    'DB_HOST=127.0.0.1',
    'export DB_USERNAME=shop',
    'DB_PASSWORD="пароль с # решёткой"',
    "DB_DATABASE='shop' # комментарий",
    'APP_NAME=Shop # хвост',
    'EMPTY=',
  ].join('\n'));

  assert.deepEqual(env, {
    DB_HOST: '127.0.0.1',
    DB_USERNAME: 'shop',
    DB_PASSWORD: 'пароль с # решёткой',
    DB_DATABASE: 'shop',
    APP_NAME: 'Shop',
    EMPTY: '',
  });
});

test('потоковая чистка ловит секрет на границе кусков', () => {
  const secret = 'пароль-базы-42';
  const text = Buffer.from(`начало ${secret} середина ${secret} конец`, 'utf8');

  // Режем на куски по 3 байта: секрет гарантированно разрезан, и не раз, и посреди буквы.
  for (const size of [1, 3, 7, 1000]) {
    const clean = scrubber([secret]);
    const parts = [];
    for (let i = 0; i < text.length; i += size) parts.push(clean.push(text.subarray(i, i + size)));
    parts.push(clean.end());
    const out = Buffer.concat(parts).toString('utf8');

    assert.equal(out, 'начало •••• середина •••• конец', `кусками по ${size}`);
  }
});

test('без секретов поток идёт как есть', () => {
  const clean = scrubber([]);
  const chunk = Buffer.from('abc');
  assert.equal(clean.push(chunk), chunk);
  assert.equal(clean.end().length, 0);
});

test('ответ целиком чистится по строкам, структура остаётся', () => {
  const out = scrubDeep({ stdout: 'pw=hunter22', rows: [['hunter22', 1]], n: 5 }, ['hunter22']);
  assert.deepEqual(out, { stdout: 'pw=••••', rows: [['••••', 1]], n: 5 });
});
