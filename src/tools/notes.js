import { z } from 'zod';
import { pick } from '../i18n.js';
import { getNotes, setFact, setText, removeFact, removeText, searchNotes } from '../registry/notes.js';
import { projects } from '../registry/connections.js';

const GROUP = 'notes';

export const tools = [
  {
    name: 'notes_get',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Заметки по проекту', en: 'Project notes' }),
    description: pick({
      ru: 'Технические факты о проекте и свободный текст: пути на сервере, версии, имена контейнеров, '
        + 'порядок деплоя. Читать стоит до первого подключения — это дешевле, чем выяснять заново.',
      en: 'Technical facts about a project plus free-form text: server paths, versions, container names, '
        + 'deploy order. Worth reading before connecting anywhere — cheaper than rediscovering it.',
    }),
    input: {
      project: z.string().optional().describe(pick({
        ru: 'имя проекта — левая часть алиаса; без него вернётся список проектов',
        en: 'project name — the left part of an alias; omit to list projects',
      })),
    },
    run: (args) => {
      if (!args.project) return { data: { projects: projects() } };
      return { data: getNotes(args.project) };
    },
  },

  {
    name: 'notes_search',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Поиск по заметкам', en: 'Search notes' }),
    description: pick({
      ru: 'Ищет по ключам, значениям и свободному тексту всех проектов сразу. Так находят «где ещё '
        + 'стоит php 7.4» или «в каком проекте этот путь».',
      en: 'Searches keys, values and free-form text across all projects at once.',
    }),
    input: { query: z.string() },
    run: (args) => ({ data: searchNotes(args.query) }),
  },

  {
    name: 'notes_set',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Записать заметку', en: 'Write a note' }),
    description: pick({
      ru: 'Кладёт факт «ключ — значение» (php.version = 8.3) либо заменяет свободный текст проекта. '
        + 'Запись входит в разрешение на проект: человек даёт его один раз за сессию.',
      en: 'Stores a key–value fact (php.version = 8.3) or replaces the project free-form text. '
        + 'Writing falls under the project grant the human gives once per session.',
    }),
    input: {
      project: z.string(),
      key: z.string().optional().describe(pick({ ru: 'ключ факта, например deploy.path', en: 'fact key, e.g. deploy.path' })),
      value: z.string().optional().describe(pick({ ru: 'значение факта', en: 'fact value' })),
      text: z.string().optional().describe(pick({
        ru: 'свободный текст проекта целиком — заменяет прежний',
        en: 'the whole free-form text of the project — replaces the previous one',
      })),
    },
    summary: (args) => (args.key
      ? `Записать в заметки «${args.project}»: ${args.key} = ${args.value}`
      : `Заменить свободный текст заметок проекта «${args.project}»`),
    details: (args) => (args.text ? { текст: args.text.slice(0, 400) } : undefined),
    run: (args) => {
      if (args.key !== undefined) {
        if (args.value === undefined) throw new Error('у факта должно быть значение');
        return { data: setFact(args.project, args.key, args.value) };
      }
      if (args.text !== undefined) return { data: setText(args.project, args.text) };
      throw new Error('нечего записывать: передайте key с value либо text');
    },
  },

  {
    name: 'notes_remove',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Убрать заметку', en: 'Remove a note' }),
    description: pick({
      ru: 'Удаляет один факт или свободный текст проекта. Факт, который перестал быть верным, '
        + 'лучше заменить новым значением, а не удалять: следующая сессия будет искать его снова.',
      en: 'Deletes a single fact or the project free-form text. A fact that stopped being true is '
        + 'usually better replaced than deleted.',
    }),
    input: {
      project: z.string(),
      key: z.string().optional().describe(pick({ ru: 'ключ факта; без него убирается текст', en: 'fact key; omit to remove the text' })),
    },
    summary: (args) => (args.key
      ? `Убрать факт «${args.key}» из заметок проекта «${args.project}»`
      : `Убрать свободный текст заметок проекта «${args.project}»`),
    run: (args) => ({ data: args.key ? removeFact(args.project, args.key) : removeText(args.project) }),
  },
];
