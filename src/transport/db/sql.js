// Что считать изменяющим запросом. Это решение стоит на пути каждого db_query,
// поэтому оно живёт отдельным модулем и покрыто тестами: ошибка здесь означает
// либо лишний вопрос человеку, либо тихий UPDATE на боевой базе.

const READONLY = new Set(['select', 'show', 'explain', 'describe', 'desc', 'table', 'values', 'analyze']);
const DML_INSIDE_CTE = /\b(insert|update|delete|merge)\b/i;
const BACKSLASH = '\\';

/** Убирает комментарии и строковые литералы, чтобы ключевые слова искались в коде, а не в данных. */
function strip(sql) {
  let out = '';
  let i = 0;
  const text = String(sql);

  while (i < text.length) {
    const two = text.slice(i, i + 2);

    if (two === '--') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === BACKSLASH) { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      out += ' ? ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

export function statements(sql) {
  return strip(sql)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @returns {{readonly: boolean, count: number, kinds: string[]}}
 */
export function classify(sql) {
  const parts = statements(sql);
  const kinds = parts.map((part) => (part.match(/^[a-z]+/i)?.[0] || '').toLowerCase());

  const readonly = parts.length > 0 && parts.every((part, index) => {
    const kind = kinds[index];
    if (!READONLY.has(kind) && kind !== 'with') return false;
    if (kind === 'with' && DML_INSIDE_CTE.test(part)) return false;
    return true;
  });

  return { readonly, count: parts.length, kinds };
}

export const isReadonly = (sql) => classify(sql).readonly;
