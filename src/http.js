import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import busboy from 'busboy';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { cfg } from './config.js';
import { DIRS } from './paths.js';
import { createServer } from './server.js';
import * as queue from './approve/queue.js';
import * as auditQuery from './audit/query.js';
import { newUploadDir, describe, safeName } from './artifacts.js';
import { approvalsPage, auditPage } from './web/pages.js';
import { keyState } from './registry/crypto.js';

// Сессии MCP привязаны к адресу подключения: запрос с чужим mcp-session-id
// получает 400, а не молча другой набор инструментов.
const sessions = new Map(); // sessionId -> { transport, spec }

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

const html = (res, body) => send(res, 200, body, { 'content-type': 'text/html; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

async function handleMcp(req, res, spec) {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId) {
    const live = sessions.get(sessionId);
    if (!live) return send(res, 404, { error: 'сессия не найдена или уже закрыта' });
    if (live.spec !== spec) {
      return send(res, 400, {
        error: `сессия заведена на /mcp/${live.spec}, а запрос пришёл на /mcp/${spec}. `
          + 'Откройте новую сессию на нужном адресе',
      });
    }
    return live.transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
  }

  if (req.method !== 'POST') return send(res, 400, { error: 'нет mcp-session-id' });

  const body = await readBody(req);
  if (!isInitializeRequest(body)) {
    return send(res, 400, { error: 'первым запросом должен быть initialize' });
  }

  let built;
  try {
    built = createServer({ spec });
  } catch (err) {
    return send(res, 404, { error: err.message });
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => sessions.set(id, { transport, spec }),
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await built.server.connect(transport);
  return transport.handleRequest(req, res, body);
}

function serveFile(res, root, suffix) {
  const file = path.join(root, suffix);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 403, { error: 'путь за пределами каталога' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'файл не найден' });

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${encodeURIComponent(path.basename(file))}"`,
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function handleUpload(req, res) {
  const dir = newUploadDir();
  const writes = [];
  let tooBig = false;

  const parser = busboy({ headers: req.headers, limits: { fileSize: cfg.maxUploadBytes, files: 10 } });

  parser.on('file', (_name, stream, info) => {
    const file = path.join(dir, safeName(info.filename));
    stream.on('limit', () => { tooBig = true; });

    // Ответ уходит только когда файл дописан: busboy закрывается раньше, чем
    // поток записи сбросит буфер на диск, и stat по свежему файлу отвечал ENOENT.
    const sink = fs.createWriteStream(file);
    writes.push(new Promise((resolve, reject) => {
      sink.on('finish', () => resolve(file));
      sink.on('error', reject);
    }));
    stream.pipe(sink);
  });

  parser.on('close', async () => {
    try {
      const saved = await Promise.all(writes);

      if (tooBig) {
        for (const file of saved) { try { fs.unlinkSync(file); } catch { /* уже нет */ } }
        return send(res, 413, { error: `файл больше CR_MAX_UPLOAD_BYTES (${cfg.maxUploadBytes} Б)` });
      }
      if (!saved.length) return send(res, 400, { error: 'в запросе нет файла: curl -F file=@путь' });

      return send(res, 200, {
        uploaded: saved.map((file) => ({ ...describe(file), bytes: fs.statSync(file).size })),
        дальше: 'передайте uri в files_put параметром source',
      });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });

  parser.on('error', (err) => send(res, 400, { error: err.message }));
  req.pipe(parser);
}

function approvalsStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  const onChange = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  queue.events.on('change', onChange);

  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(beat);
    queue.events.off('change', onChange);
  });
}

export function start() {
  queue.expireOrphans();

  // Исключение в обработчике события (а не в await-цепочке) иначе валит процесс целиком —
  // вместе с живыми SSH-сессиями и ждущими подтверждениями. Логируем и живём дальше.
  process.on('uncaughtException', (err) => console.error(`[registry] необработанная ошибка: ${err.stack || err.message}`));
  process.on('unhandledRejection', (err) => console.error(`[registry] необработанный отказ: ${err?.stack || err}`));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (route === '/health') {
        const key = keyState();
        return send(res, 200, { ok: true, version: cfg.version, unlocked: key.unlocked, reason: key.reason });
      }

      if (route === '/mcp' || route.startsWith('/mcp/')) {
        const spec = route === '/mcp' ? 'all' : route.slice('/mcp/'.length);
        return await handleMcp(req, res, spec);
      }

      if (route === '/upload' && req.method === 'POST') return handleUpload(req, res);

      if (route === '/api/approvals/stream') return approvalsStream(req, res);

      if (route === '/api/approvals' && req.method === 'GET') {
        return send(res, 200, { pending: queue.pending(), recent: queue.recent(30) });
      }

      if (route.startsWith('/api/approvals/') && req.method === 'POST') {
        const id = route.slice('/api/approvals/'.length);
        const body = await readBody(req);
        return send(res, 200, queue.decide(id, body?.decision, 'web'));
      }

      if (route === '/api/audit') {
        const q = Object.fromEntries(url.searchParams);
        return send(res, 200, auditQuery.list({ ...q, onlyErrors: q.onlyErrors === '1', limit: Number(q.limit) || 50 }));
      }

      if (route.startsWith('/api/audit/')) {
        const record = auditQuery.get(route.slice('/api/audit/'.length));
        return record ? send(res, 200, record) : send(res, 404, { error: 'записи нет' });
      }

      if (route === '/approvals') return html(res, approvalsPage());
      if (route === '/audit' || route === '/') return html(res, auditPage());

      if (route.startsWith('/artifacts/')) return serveFile(res, DIRS.artifacts, route.slice('/artifacts/'.length));
      if (route.startsWith('/uploads/')) return serveFile(res, DIRS.uploads, route.slice('/uploads/'.length));

      return send(res, 404, { error: `нет такого адреса: ${route}` });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });

  server.listen(cfg.port, '0.0.0.0', () => {
    const key = keyState();
    console.log(`[registry] streamable http на 0.0.0.0:${cfg.port}/mcp`);
    console.log(`[registry] страницы: ${cfg.publicBaseUrl}/approvals и ${cfg.publicBaseUrl}/audit`);
    if (!key.unlocked) {
      console.log(`[registry] ВНИМАНИЕ: реестр заперт (${key.reason}) — задайте CR_MASTER_KEY, иначе подключения не работают`);
    }
  });

  return server;
}
