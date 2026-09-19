import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import * as dbTransport from '../transport/db/index.js';
import { classify } from '../transport/db/sql.js';
import { newArtifact } from '../artifacts.js';

const GROUP = 'db';

export const tools = [
  {
    name: 'db_tables',
    group: GROUP,
    needsConnection: true,
    kinds: ['db'],
    mutating: false,
    title: pick({ ru: 'Таблицы базы', en: 'Database tables' }),
    description: pick({
      ru: 'Список таблиц и представлений. Подключение идёт через SSH-туннель к хосту, поэтому порт '
        + 'базы наружу открывать не нужно.',
      en: 'Tables and views. The connection goes through an SSH tunnel to the host, so the database '
        + 'port needs no public exposure.',
    }),
    input: { alias: z.string() },
    run: async (args, { resolved, approveHostKey }) => ({ data: await dbTransport.tables(resolved, { approveHostKey }) }),
  },

  {
    name: 'db_schema',
    group: GROUP,
    needsConnection: true,
    kinds: ['db'],
    mutating: false,
    title: pick({ ru: 'Схема таблицы', en: 'Table schema' }),
    description: pick({ ru: 'Столбцы таблицы: тип, обязательность, значение по умолчанию.', en: 'Table columns: type, nullability, default.' }),
    input: { alias: z.string(), table: z.string(), schema: z.string().optional() },
    run: async (args, { resolved, approveHostKey }) => ({
      data: await dbTransport.columns(resolved, args.table, { schema: args.schema || '', approveHostKey }),
    }),
  },

  {
    name: 'db_query',
    group: GROUP,
    needsConnection: true,
    kinds: ['db'],
    // Читающий запрос выполняется сразу, изменяющий — только после подтверждения.
    // Классификация разбирает SQL, а не доверяет намерению вызывающего.
    mutating: (args) => !classify(args.sql).readonly,
    title: pick({ ru: 'Запрос к базе', en: 'Database query' }),
    description: pick({
      ru: 'Выполняет SQL на базе по алиасу. SELECT идёт сразу, изменяющий запрос — после подтверждения '
        + 'человека. Несколько запросов через «;» в одном вызове отклоняются: подтверждать надо то, '
        + 'что человек прочитал целиком. Параметры передавайте в params, а не склейкой строк.',
      en: 'Runs SQL against the database behind the alias. A SELECT runs immediately, a mutating query '
        + 'only after human confirmation. Several statements separated by ";" are rejected: the human '
        + 'must confirm exactly what runs. Pass parameters in params instead of string concatenation.',
    }),
    input: {
      alias: z.string(),
      sql: z.string(),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      maxRows: z.number().int().positive().optional(),
    },
    summary: (args) => `Выполнить на базе «${args.alias}»: ${args.sql.slice(0, 500)}`,
    details: (args, resolved) => ({
      база: `${resolved?.config?.engine} ${resolved?.config?.database}`,
      сервер: resolved?.host ? `${resolved.host.alias} (${resolved.host.address})` : resolved?.config?.address,
      параметры: args.params,
    }),
    run: async (args, { resolved, approveHostKey }) => {
      const shape = classify(args.sql);
      if (shape.count > 1) {
        throw new Error(
          `в одном вызове ${shape.count} запросов (${shape.kinds.join(', ')}). Выполняйте по одному: `
          + 'подтверждать человек должен ровно то, что уйдёт в базу',
        );
      }

      const res = await dbTransport.query(resolved, args.sql, {
        params: args.params || [],
        maxRows: Math.min(args.maxRows || cfg.dbMaxRows, cfg.dbMaxRows),
        approveHostKey,
      });

      const first = res.results[0] || { columns: [], rows: [], rowCount: 0 };
      return {
        data: { via: res.via, readonly: shape.readonly, ...first },
        command: args.sql,
        stdout: JSON.stringify(first.rows),
      };
    },
  },

  {
    name: 'db_dump',
    group: GROUP,
    needsConnection: true,
    kinds: ['db'],
    mutating: false,
    title: pick({ ru: 'Дамп базы', en: 'Database dump' }),
    description: pick({
      ru: 'Снимает дамп штатной утилитой (pg_dump или mysqldump) и кладёт его в артефакты реестра — '
        + 'в ответе ссылка, а не содержимое. Базу не меняет.',
      en: 'Takes a dump with the native utility (pg_dump or mysqldump) and stores it as a registry '
        + 'artifact — the response carries a link, not the contents. Changes nothing in the database.',
    }),
    input: {
      alias: z.string(),
      table: z.string().optional(),
      schemaOnly: z.boolean().optional(),
      dataOnly: z.boolean().optional(),
    },
    run: async (args, { resolved, approveHostKey }) => {
      const name = `${resolved.config.database}${args.table ? `.${args.table}` : ''}.sql`;
      const artifact = newArtifact(name);
      const res = await dbTransport.dump(resolved, {
        table: args.table,
        schemaOnly: args.schemaOnly,
        dataOnly: args.dataOnly,
        outFile: artifact.path,
        approveHostKey,
      });

      return {
        data: { uri: artifact.uri, url: artifact.url, bytes: res.bytes, via: res.via, warning: res.warning },
        command: res.command,
      };
    },
  },
];
