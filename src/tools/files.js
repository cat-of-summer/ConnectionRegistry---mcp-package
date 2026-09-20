import fs from 'node:fs';
import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import { withFiles, resolvePath, mkdirp } from '../transport/files.js';
import { resolveSource, newArtifact, listUploads, safeName } from '../artifacts.js';

const GROUP = 'files';

export const tools = [
  {
    name: 'files_list',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: false,
    title: pick({ ru: 'Список файлов', en: 'List files' }),
    description: pick({
      ru: 'Содержимое каталога на сервере: имена, размеры, права, даты. Относительный путь считается '
        + 'от root подключения, абсолютный уходит как есть.',
      en: 'Directory contents on the server: names, sizes, permissions, dates. A relative path is taken '
        + 'from the connection root, an absolute one is used as is.',
    }),
    input: { alias: z.string(), path: z.string().optional() },
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path ?? '.');
      const entries = await withFiles(resolved, { approveHostKey }, (api) => api.list(target));
      return { data: { path: target, entries } };
    },
  },

  {
    name: 'files_stat',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: false,
    title: pick({ ru: 'Сведения о файле', en: 'File info' }),
    description: pick({ ru: 'Размер, права и время изменения одного файла.', en: 'Size, permissions and mtime of a single file.' }),
    input: { alias: z.string(), path: z.string() },
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const stat = await withFiles(resolved, { approveHostKey }, (api) => api.stat(target));
      return { data: stat };
    },
  },

  {
    name: 'files_read',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: false,
    title: pick({ ru: 'Прочитать файл', en: 'Read a file' }),
    description: pick({
      ru: 'Возвращает содержимое текстового файла. Крупный файл обрезается по maxBytes — за целым '
        + 'идите в files_get, он положит его в артефакты и даст ссылку.',
      en: 'Returns the contents of a text file, truncated at maxBytes. For the whole file use files_get: '
        + 'it stores the file as an artifact and returns a link.',
    }),
    input: {
      alias: z.string(),
      path: z.string(),
      maxBytes: z.number().int().positive().optional(),
    },
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const maxBytes = Math.min(args.maxBytes || cfg.maxTextBytes, cfg.maxTextBytes);
      const res = await withFiles(resolved, { approveHostKey }, (api) => api.read(target, { maxBytes }));

      return {
        data: {
          path: target,
          bytes: res.bytes,
          truncated: res.truncated,
          content: res.content.toString('utf8'),
        },
        stdout: res.content.toString('utf8'),
      };
    },
  },

  {
    name: 'files_get',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: false,
    title: pick({ ru: 'Забрать файл', en: 'Fetch a file' }),
    description: pick({
      ru: 'Скачивает файл с сервера в артефакты реестра и возвращает ссылку. Так забирают дампы, '
        + 'логи и бинарные файлы, не протаскивая их через контекст модели.',
      en: 'Downloads a file into the registry artifacts and returns a link. This is how dumps, logs and '
        + 'binaries are retrieved without dragging them through the model context.',
    }),
    input: { alias: z.string(), path: z.string() },
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const artifact = newArtifact(safeName(target.split('/').pop()));

      await withFiles(resolved, { approveHostKey }, async (api) => {
        const out = fs.createWriteStream(artifact.path);
        await api.downloadTo(target, out);
      });

      return { data: { from: target, ...artifact, bytes: fs.statSync(artifact.path).size } };
    },
  },

  {
    name: 'files_put',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: true,
    scan: ['content'],
    secretRefs: ['content'],
    title: pick({ ru: 'Положить файл', en: 'Upload a file' }),
    description: pick({
      ru: 'Кладёт файл на сервер. Источник — адрес cr://uploads/…, полученный после загрузки файла '
        + 'на /upload реестра, либо содержимое строкой в content. Ключ или пароль в content открытым '
        + 'текстом отклоняется — вместо него ссылка cr://secret/<алиас>#вид. Требует подтверждения человека.',
      en: 'Puts a file on the server. The source is a cr://uploads/… address returned by the registry '
        + '/upload endpoint, or inline text in content. A plaintext key or password in content is refused — '
        + 'pass a cr://secret/<alias>#kind reference instead. Requires human confirmation.',
    }),
    input: {
      alias: z.string(),
      dest: z.string().describe(pick({ ru: 'путь назначения на сервере', en: 'destination path on the server' })),
      source: z.string().optional().describe(pick({ ru: 'cr://uploads/…', en: 'cr://uploads/…' })),
      content: z.string().optional().describe(pick({
        ru: 'содержимое текстом, если файл маленький; или cr://secret/<алиас>#private_key|password|passphrase',
        en: 'inline text for small files; or cr://secret/<alias>#private_key|password|passphrase',
      })),
    },
    summary: (args, resolved) => `Положить файл на «${args.alias}» (${resolved?.host?.address || resolved?.config?.address}): `
      + `${resolvePath(resolved, args.dest)}`,
    details: (args) => ({ источник: args.source || 'текст в параметре content' }),
    run: async (args, { resolved, approveHostKey }) => {
      const dest = resolvePath(resolved, args.dest);

      if (!args.source && args.content === undefined) {
        throw new Error('нечего класть: передайте source (cr://uploads/…) или content');
      }

      const payload = args.source
        ? fs.createReadStream(resolveSource(args.source))
        : Buffer.from(args.content, 'utf8');

      const bytes = args.source
        ? fs.statSync(resolveSource(args.source)).size
        : Buffer.byteLength(args.content);

      await withFiles(resolved, { approveHostKey }, (api) => (args.source
        ? api.writeStream(dest, payload)
        : api.write(dest, payload)));

      return { data: { dest, bytes }, command: `put ${dest}` };
    },
  },

  {
    name: 'files_move',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: true,
    title: pick({ ru: 'Переместить файл', en: 'Move a file' }),
    description: pick({ ru: 'Переименовывает или переносит файл на сервере.', en: 'Renames or moves a file on the server.' }),
    input: { alias: z.string(), from: z.string(), to: z.string() },
    summary: (args, resolved) => `Переместить на «${args.alias}»: ${resolvePath(resolved, args.from)} → ${resolvePath(resolved, args.to)}`,
    run: async (args, { resolved, approveHostKey }) => {
      const from = resolvePath(resolved, args.from);
      const to = resolvePath(resolved, args.to);
      await withFiles(resolved, { approveHostKey }, (api) => api.move(from, to));
      return { data: { from, to }, command: `mv ${from} ${to}` };
    },
  },

  {
    name: 'files_remove',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: true,
    title: pick({ ru: 'Удалить файл', en: 'Delete a file' }),
    description: pick({
      ru: 'Удаляет файл или пустой каталог. Рекурсивного удаления здесь нет намеренно: '
        + 'снести дерево — это ssh_exec, где команда видна человеку целиком.',
      en: 'Deletes a file or an empty directory. No recursive delete on purpose: wiping a tree is '
        + 'ssh_exec, where the human sees the whole command.',
    }),
    input: { alias: z.string(), path: z.string(), dir: z.boolean().optional() },
    summary: (args, resolved) => `Удалить на «${args.alias}»: ${resolvePath(resolved, args.path)}`,
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      await withFiles(resolved, { approveHostKey }, (api) => (args.dir ? api.rmdir(target) : api.remove(target)));
      return { data: { removed: target }, command: `rm ${target}` };
    },
  },

  {
    name: 'files_mkdir',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: true,
    title: pick({ ru: 'Создать каталог', en: 'Create a directory' }),
    description: pick({
      ru: 'Создаёт каталог на сервере вместе с недостающими родительскими. Уже существующий '
        + 'каталог ошибкой не считается.',
      en: 'Creates a directory on the server together with missing parents. An existing directory '
        + 'is not an error.',
    }),
    input: { alias: z.string(), path: z.string() },
    summary: (args, resolved) => `Создать каталог на «${args.alias}»: ${resolvePath(resolved, args.path)}`,
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const created = await withFiles(resolved, { approveHostKey }, (api) => mkdirp(api, target));
      return { data: { path: target, created }, command: `mkdir -p ${target}` };
    },
  },

  {
    name: 'files_chmod',
    group: GROUP,
    needsConnection: true,
    kinds: ['files'],
    mutating: true,
    title: pick({ ru: 'Сменить права', en: 'Change permissions' }),
    description: pick({ ru: 'Права восьмеричным числом, например 644 или 755.', en: 'Octal permissions, e.g. 644 or 755.' }),
    input: { alias: z.string(), path: z.string(), mode: z.string().describe('644') },
    summary: (args, resolved) => `Сменить права на «${args.alias}»: ${resolvePath(resolved, args.path)} → ${args.mode}`,
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const mode = parseInt(args.mode, 8);
      if (Number.isNaN(mode)) throw new Error(`права «${args.mode}» не восьмеричное число`);
      await withFiles(resolved, { approveHostKey }, (api) => api.chmod(target, mode));
      return { data: { path: target, mode: args.mode }, command: `chmod ${args.mode} ${target}` };
    },
  },

  {
    name: 'files_uploads',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Что загружено на реестр', en: 'Registry uploads' }),
    description: pick({
      ru: 'Список файлов, загруженных на /upload и готовых к отправке через files_put. '
        + 'Полезно, когда человек уже положил файл, а адрес не назвал.',
      en: 'Files uploaded to /upload and ready for files_put. Useful when the human has already '
        + 'uploaded a file but did not mention its address.',
    }),
    input: {},
    run: () => ({ data: { uploads: listUploads(), где: `${cfg.publicBaseUrl}/upload` } }),
  },
];
