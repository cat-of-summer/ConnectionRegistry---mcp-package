import net from 'node:net';
import { connect, forwardOut } from './ssh.js';

// База на сервере обычно слушает только 127.0.0.1 — и правильно делает. Поэтому
// подключение к ней идёт через SSH: здесь поднимается локальный порт, каждое
// соединение с которым уезжает на удалённый хост по уже открытому SSH-каналу.
// Локальный порт, а не голый поток, потому что им пользуются и драйверы, и
// pg_dump с mysqldump, которым нужен именно адрес.

export async function open(resolved, { approveHostKey } = {}) {
  const target = { address: resolved.config.address || '127.0.0.1', port: resolved.port };

  if (!resolved.host) {
    // Прямой доступ: адрес виден из контейнера, туннель не нужен.
    return { host: target.address, port: target.port, direct: true, async close() {} };
  }

  const client = await connect(resolved.host, { approveHostKey });

  // Пробный проброс до того, как за порт возьмётся драйвер: иначе запрет на стороне
  // sshd (AllowTcpForwarding no) выглядит как «соединение неожиданно закрыто».
  try {
    const probe = await forwardOut(client, target.address, target.port);
    probe.end();
  } catch (err) {
    const reason = /administratively prohibited/i.test(err.message)
      ? `хост «${resolved.host.alias}» запрещает проброс портов — в sshd_config стоит AllowTcpForwarding no`
      : `хост «${resolved.host.alias}» не открыл канал до ${target.address}:${target.port}: ${err.message}`;
    throw new Error(`${reason}. Без проброса до базы за SSH не добраться`);
  }

  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    forwardOut(client, target.address, target.port)
      .then((stream) => {
        stream.on('error', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
      })
      .catch(() => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    host: '127.0.0.1',
    port: server.address().port,
    direct: false,
    via: `${resolved.host.alias} → ${target.address}:${target.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
