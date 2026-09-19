import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isReadonly } from '../src/transport/db/sql.js';

// От этой классификации зависит, спросят ли человека перед запросом. Ошибка здесь —
// либо лишний вопрос на каждом SELECT, либо тихий UPDATE на боевой базе.

test('чтение проходит без подтверждения', () => {
  for (const sql of [
    'select 1',
    'SELECT * FROM users WHERE id = $1',
    '  with recent as (select * from orders) select count(*) from recent',
    'SHOW TABLES',
    'explain analyze select 1',
    '-- посчитать заказы\nselect count(*) from orders',
    '/* комментарий с delete from users */ select 1',
  ]) {
    assert.equal(isReadonly(sql), true, sql);
  }
});

test('изменяющее требует подтверждения', () => {
  for (const sql of [
    'update users set banned = true',
    'DELETE FROM orders',
    'drop table users',
    'insert into logs values (1)',
    'truncate orders',
    'alter table users add column x int',
    'grant all on database to someone',
  ]) {
    assert.equal(isReadonly(sql), false, sql);
  }
});

test('CTE с записью внутри — это запись', () => {
  const sql = 'WITH gone AS (DELETE FROM sessions WHERE ts < now() RETURNING *) SELECT count(*) FROM gone';
  assert.equal(isReadonly(sql), false);
});

test('строковый литерал не превращает SELECT в UPDATE', () => {
  assert.equal(isReadonly("select 'update users set banned = true' as sql"), true);
  assert.equal(isReadonly('select "delete from t" as x'), true);
});

test('несколько запросов видны по счётчику', () => {
  assert.equal(classify('select 1; select 2').count, 2);
  assert.equal(classify('select 1;').count, 1);
  assert.equal(classify("select ';' ; delete from t").count, 2);
});

test('пустой ввод не считается чтением', () => {
  assert.equal(isReadonly(''), false);
  assert.equal(isReadonly('   -- только комментарий'), false);
});
