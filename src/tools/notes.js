import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import { listFacts, readFacts, setFact, removeFact, searchNotes } from '../registry/notes.js';
import { projects } from '../registry/projects.js';

const GROUP = 'notes';

export const tools = [
  {
    name: 'notes_get',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Факты о проекте', en: 'Project facts' }),
    description: pick({
      ru: 'Без keys — ключи фактов проекта без значений, недавно читанные сверху. С keys — значения: '
        + `это чтение факта, оно продлевает ему жизнь. Не читанный ${cfg.notesStaleSessions} сессий помечен `
        + `stale, ещё через ${cfg.notesExpireSessions} удаляется. Важный по имени stale-факт прочитайте и `
        + 'замените или уберите.',
      en: 'Without keys — the project fact keys without values, recently read first. With keys — values: '
        + `that is reading a fact and extends its life. Unread for ${cfg.notesStaleSessions} sessions it is `
        + `marked stale, after ${cfg.notesExpireSessions} more it is deleted. Read a stale fact whose key `
        + 'matters, then replace or remove it.',
    }),
    input: {
      project: z.string().optional().describe(pick({
        ru: 'имя проекта — левая часть алиаса; без него вернётся список проектов',
        en: 'project name — the left part of an alias; omit to list projects',
      })),
      keys: z.array(z.string()).optional().describe(pick({
        ru: 'ключи, значения которых нужны задаче',
        en: 'keys whose values the task needs',
      })),
    },
    run: (args, { ctx } = {}) => {
      if (!args.project) return { data: { projects: projects() } };
      if (args.keys?.length) return { data: readFacts(args.project, args.keys, ctx?.sessionId) };
      return { data: listFacts(args.project, ctx?.sessionId) };
    },
  },

  {
    name: 'notes_search',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Поиск по фактам', en: 'Search facts' }),
    description: pick({
      ru: 'Фильтр по ключам и значениям во всех проектах или в одном. Отдаёт ключи и в чём совпало, '
        + 'без значений: читают потом через notes_get с keys.',
      en: 'Filters keys and values across all projects or within one. Returns keys and what matched, '
        + 'no values: read them through notes_get with keys.',
    }),
    input: {
      query: z.string().describe(pick({ ru: 'часть ключа или значения', en: 'part of a key or a value' })),
      project: z.string().optional().describe(pick({ ru: 'искать только в этом проекте', en: 'search this project only' })),
    },
    run: (args) => ({ data: searchNotes(args.query, { project: args.project }) }),
  },

  {
    name: 'notes_set',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Записать факт', en: 'Write a fact' }),
    description: pick({
      ru: `Кладёт факт «ключ — значение»: одна строка до ${cfg.notesValueMax} символов о том, что нужно `
        + 'для деплоя и операций на серверах проекта — путь, версия, имя контейнера. Тот же ключ — '
        + 'замена значения.',
      en: `Stores a key–value fact: one line up to ${cfg.notesValueMax} characters about what deploys and `
        + 'server operations need — a path, a version, a container name. Same key replaces the value.',
    }),
    input: {
      project: z.string(),
      key: z.string().describe(pick({ ru: 'ключ факта, например deploy.path', en: 'fact key, e.g. deploy.path' })),
      value: z.string().describe(pick({ ru: 'значение — одна строка', en: 'value — a single line' })),
    },
    summary: (args) => `Записать в заметки «${args.project}»: ${args.key} = ${args.value}`,
    run: (args, { ctx } = {}) => ({ data: setFact(args.project, args.key, args.value, ctx?.sessionId) }),
  },

  {
    name: 'notes_remove',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Убрать факт', en: 'Remove a fact' }),
    description: pick({
      ru: 'Удаляет факт. Факт, который перестал быть верным, лучше заменить новым значением, а не '
        + 'удалять: следующая сессия будет искать его снова.',
      en: 'Deletes a fact. A fact that stopped being true is usually better replaced than deleted.',
    }),
    input: {
      project: z.string(),
      key: z.string().describe(pick({ ru: 'ключ факта', en: 'fact key' })),
    },
    summary: (args) => `Убрать факт «${args.key}» из заметок проекта «${args.project}»`,
    run: (args) => ({ data: removeFact(args.project, args.key) }),
  },
];
