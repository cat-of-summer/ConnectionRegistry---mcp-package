import test from 'node:test';
import assert from 'node:assert/strict';
import { inline, literal, parseMysqlXml, parseCsv } from '../src/transport/db/remote.js';

// via: exec — база за хостингом, где проброс закрыт: SQL уходит консольному клиенту на сервере.
// Подготовленных запросов там нет, поэтому параметры становятся литералами здесь, и ошибка в
// экранировании — это инъекция в боевую базу.

test('параметры mysql подставляются литералами и экранируются', () => {
  assert.equal(
    inline('select * from t where a = ? and b = ? and c = ? and d = ?', ["O'Brien\\x", 42, null, true], 'mysql'),
    "select * from t where a = 'O\\'Brien\\\\x' and b = 42 and c = NULL and d = TRUE",
  );
  assert.equal(literal('a\nb\0c', 'mysql'), "'a\\nb\\0c'");
});

test('знак вопроса внутри строки и комментария — не параметр', () => {
  assert.equal(
    inline("select '?', \"?\", `?` -- ?\n, ? /* ? */", [1], 'mysql'),
    "select '?', \"?\", `?` -- ?\n, 1 /* ? */",
  );
});

test('число параметров сверяется', () => {
  assert.throws(() => inline('select ?, ?', [1], 'mysql'), /больше, чем параметров/);
  assert.throws(() => inline('select ?', [1, 2], 'mysql'), /параметров 2, а знаков «\?» в запросе 1/);
  assert.throws(() => inline('select $2', [1], 'postgres'), /\$2, а параметров 1/);
});

test('postgres: $n по номеру, кавычка удваивается, обратная косая черта — как есть', () => {
  assert.equal(
    inline("select $2, $1, '$1' where x = $1", ["it's\\", 7], 'postgres'),
    "select 7, 'it''s\\', '$1' where x = 'it''s\\'",
  );
});

test('mysql --xml: NULL отличается от строки «NULL», целые — числами', () => {
  const xml = `<?xml version="1.0"?>
<resultset statement="select ..." xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
\t<field name="id">7</field>
\t<field name="code">007</field>
\t<field name="word">NULL</field>
\t<field name="nothing" xsi:nil="true" />
\t<field name="text">a &lt;b&gt; &amp; &quot;c&quot; &#1046;</field>
  </row>
</resultset>`;
  assert.deepEqual(parseMysqlXml(xml), [{
    columns: ['id', 'code', 'word', 'nothing', 'text'],
    rows: [[7, '007', 'NULL', null, 'a <b> & "c" Ж']],
  }]);
});

test('mysql --xml: пустая выборка и два набора подряд', () => {
  const xml = '<resultset statement="x"></resultset>\n<resultset statement="y">\n<row><field name="affected">3</field></row>\n</resultset>';
  const sets = parseMysqlXml(xml);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[0], { columns: [], rows: [] });
  assert.deepEqual(sets[1].rows, [[3]]);
});

test('CSV psql: кавычки, запятые и переводы строк внутри поля', () => {
  assert.deepEqual(
    parseCsv('a,b,c\n1,"x, y","строка\nвторая"\n2,"он сказал ""да""",\n'),
    [['a', 'b', 'c'], ['1', 'x, y', 'строка\nвторая'], ['2', 'он сказал "да"', '']],
  );
});
