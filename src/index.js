import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDirs } from './paths.js';
import { db } from './registry/db.js';
import { createServer } from './server.js';
import { start as startHttp } from './http.js';
import { closeAll } from './transport/ssh.js';
import { expireOrphans } from './approve/queue.js';
import { sweepAll } from './registry/notes.js';

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

async function main() {
  ensureDirs();
  db(); // миграции прогоняются до первого запроса, а не на нём
  sweepAll(); // просроченные факты уходят при старте, а не когда до них дойдёт чтение

  const transport = arg('transport', 'http');

  if (transport === 'stdio') {
    // В stdio адреса нет, и набор инструментов называют флагом.
    expireOrphans();
    const { server } = await createServer({ spec: arg('tools', 'all') });
    await server.connect(new StdioServerTransport());
    return;
  }

  startHttp();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closeAll();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[registry] не удалось запуститься: ${err.stack || err.message}`);
  process.exit(1);
});
