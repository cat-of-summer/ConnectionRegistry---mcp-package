import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import * as query from '../audit/query.js';

const GROUP = 'audit';

export const tools = [
  {
    name: 'audit_query',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Журнал действий', en: 'Action journal' }),
    description: pick({
      ru: 'Что делалось через реестр: время, алиас, инструмент, команда, код возврата, решение по '
        + 'подтверждению. Выдаёт сводки от новых к старым; вывод команды целиком — в audit_show.',
      en: 'What has been done through the registry: time, alias, tool, command, exit code, approval '
        + 'decision. Returns summaries newest first; full output is in audit_show.',
    }),
    input: {
      alias: z.string().optional(),
      project: z.string().optional(),
      tool: z.string().optional(),
      since: z.string().optional().describe(pick({ ru: 'ISO-время, от', en: 'ISO time, from' })),
      until: z.string().optional().describe(pick({ ru: 'ISO-время, до', en: 'ISO time, to' })),
      onlyErrors: z.boolean().optional(),
      contains: z.string().optional().describe(pick({ ru: 'подстрока в команде или выводе', en: 'substring in command or output' })),
      limit: z.number().int().positive().optional(),
    },
    run: (args) => ({ data: query.list(args) }),
  },

  {
    name: 'audit_show',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Запись журнала целиком', en: 'Full journal entry' }),
    description: pick({
      ru: 'Одна запись со всем, что было: аргументы, команда, stdout и stderr целиком. Секреты в ней '
        + 'замаскированы, и это единственное, что из записи вырезано.',
      en: 'A single entry with everything: arguments, command, full stdout and stderr. Secrets are '
        + 'masked, and that is the only thing removed.',
    }),
    input: { id: z.string() },
    run: (args) => {
      const record = query.get(args.id);
      if (!record) throw new Error(`записи «${args.id}» в журнале нет — возможно, её вытеснила ротация`);
      return { data: record };
    },
  },

  {
    name: 'audit_tail',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Последние действия', en: 'Recent actions' }),
    description: pick({
      ru: 'Короткая сводка последних действий — чем закончилась прошлая сессия и что уже пробовали.',
      en: 'A short summary of recent actions — how the previous session ended and what was already tried.',
    }),
    input: { limit: z.number().int().positive().optional() },
    run: (args) => ({
      data: {
        ...query.list({ limit: args.limit || 10 }),
        журнал: `${cfg.publicBaseUrl}/audit`,
      },
    }),
  },
];
