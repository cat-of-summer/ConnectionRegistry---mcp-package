import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Хост «только для чтения»: похожее на запись спрашивается каждый раз, и разрешение писать
// на хост, выданное на сессию, этого не отменяет. Лояльная политика — потому что именно
// при ней после первого «да» вопросов не остаётся вовсе.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-readonly-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-для-readonly';
process.env.CR_UPDATE_CHECK = '0';
process.env.CR_POLICY = 'loyal';
process.env.CR_APPROVE_TIMEOUT = '1';

const hosts = await import('../src/registry/hosts.js');
const connections = await import('../src/registry/connections.js');
const projects = await import('../src/registry/projects.js');
const { wrap } = await import('../src/tools/shared.js');
const query = await import('../src/audit/query.js');
const { tools: shellTools } = await import('../src/tools/shell.js');
const { tools: registryTools } = await import('../src/tools/registry.js');
const { tools: auditTools } = await import('../src/tools/audit.js');

projects.upsertProject({ project: 'hevel', dirs: [{ path: '/srv/hevel', comment: 'код' }] });
hosts.upsertHost({ alias: 'hevel/prod', address: '10.0.0.2', user: 'deploy', password: 'пароль-прода', readonly: true });
hosts.upsertHost({ alias: 'hevel/dev', address: '10.0.0.3', user: 'deploy', password: 'пароль-дева' });
connections.upsertConnection({ alias: 'hevel/prod-shell', kind: 'shell', host: 'hevel/prod' });
connections.upsertConnection({ alias: 'hevel/dev-shell', kind: 'shell', host: 'hevel/dev' });

function human(answer = 'accept', sessionId = 'ro') {
  const asked = [];
  return {
    asked,
    ctx: {
      sessionId,
      requestId: 1,
      server: {
        server: {
          getClientCapabilities: () => ({ elicitation: {} }),
          elicitInput: async (request) => {
            asked.push(request.message);
            return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
          },
        },
      },
    },
  };
}

/** Настоящая декларация ssh_exec, но без сети: run подменён. */
function exec(ctx, ran) {
  const def = shellTools.find((t) => t.name === 'ssh_exec');
  return wrap({ ...def, run: async (args) => { ran.push(args.command); return { data: { ok: true }, command: args.command, stdout: '' }; } }, ctx);
}

test('флаг виден в списке хостов и в разрешённом подключении', () => {
  assert.equal(hosts.getHost('hevel/prod').readonly, true);
  assert.equal(hosts.getHost('hevel/dev').readonly, false);
});

test('чтение на readonly-хосте идёт по обычной политике, запись спрашивается каждый раз', async () => {
  const { ctx, asked } = human('accept', 'A');
  const ran = [];
  const run = exec(ctx, ran);

  await run({ alias: 'hevel/prod-shell', command: 'ls -la' });
  const afterRead = asked.length;
  assert.equal(afterRead, 2, 'доступ к проекту и запись на хост — как обычно');

  await run({ alias: 'hevel/prod-shell', command: 'cat config.php' });
  assert.equal(asked.length, afterRead, 'второе чтение без вопросов');

  await run({ alias: 'hevel/prod-shell', command: 'rm /tmp/x.php' });
  assert.equal(asked.length, afterRead + 1);
  assert.match(asked.at(-1), /только для чтения/);
  assert.match(asked.at(-1), /почему спрашиваю: rm/);

  await run({ alias: 'hevel/prod-shell', command: 'echo 1 > /tmp/flag' });
  assert.equal(asked.length, afterRead + 2, 'следующая запись спрашивает снова');
  assert.equal(ran.length, 4);
});

test('обычный хост той же сессии не спрашивает про запись второй раз', async () => {
  const { ctx, asked } = human('accept', 'A');
  const ran = [];
  await exec(ctx, ran)({ alias: 'hevel/dev-shell', command: 'rm /tmp/x' });
  assert.equal(asked.length, 1, 'только право писать на новый хост');
  await exec(ctx, ran)({ alias: 'hevel/dev-shell', command: 'rm /tmp/y' });
  assert.equal(asked.length, 1);
});

test('отказ на readonly-вопрос — отказ, и следующее чтение он не закрывает', async () => {
  const { ctx } = human('accept', 'B');
  const ran = [];
  await exec(ctx, ran)({ alias: 'hevel/prod-shell', command: 'ls' });

  const { ctx: no } = human('decline', 'B');
  const res = await exec(no, ran)({ alias: 'hevel/prod-shell', command: 'git pull' });
  assert.equal(res.isError, true);
  assert.equal(ran.includes('git pull'), false);

  const again = await exec(ctx, ran)({ alias: 'hevel/prod-shell', command: 'git status' });
  assert.equal(again.isError, undefined, again.content?.[0]?.text);
});

test('снять флаг можно только с вопросом, даже при выданном доступе к проекту', async () => {
  const { ctx, asked } = human('accept', 'A');
  const hostSet = wrap(registryTools.find((t) => t.name === 'host_set'), ctx);

  const before = asked.length;
  await hostSet({ alias: 'hevel/prod', note: 'боевой' });
  assert.equal(asked.length, before, 'правка заметки идёт по доступу к проекту');

  const res = await hostSet({ alias: 'hevel/prod', readonly: false });
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  assert.equal(asked.length, before + 1);
  assert.match(asked.at(-1), /снятие флага/);

  // Вернуть флаг — без вопроса: закрыть проще, чем открыть.
  await hostSet({ alias: 'hevel/prod', readonly: true });
  assert.equal(asked.length, before + 1);
  assert.equal(hosts.getHost('hevel/prod').readonly, true);
});

test('журнал отвечает, что на хосте менялось: запись есть, чтения нет', async () => {
  const audit = wrap(auditTools.find((t) => t.name === 'audit_query'), human('accept', 'A').ctx);
  const res = await audit({ host: 'hevel/prod', onlyChanges: true, limit: 50 });
  const commands = JSON.parse(res.content[0].text).entries.map((e) => e.command);

  assert.ok(commands.includes('rm /tmp/x.php'));
  assert.ok(commands.includes('echo 1 > /tmp/flag'));
  assert.equal(commands.includes('ls -la'), false);
  assert.equal(commands.includes('git status'), false);
  assert.equal(commands.includes('git pull'), false, 'отказанное не менялось');

  const entry = query.list({ host: 'hevel/prod', onlyChanges: true, limit: 50 }).entries.find((e) => e.command === 'rm /tmp/x.php');
  assert.deepEqual(entry.writeSigns, ['rm']);
});
