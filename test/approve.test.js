import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-approve-'));
process.env.CR_ROOT = root;
process.env.CR_MASTER_KEY = 'ключ-подтверждений';
process.env.CR_APPROVE_TIMEOUT = '1';

const gate = await import('../src/approve/gate.js');
const queue = await import('../src/approve/queue.js');
const { ALL } = await import('../src/tools/groups.js');

test('чтение не спрашивает, запись спрашивает', () => {
  assert.equal(gate.needsApproval({ mutating: false }), false);
  assert.equal(gate.needsApproval({ mutating: true }), true);
});

test('политика подключения решает, а по умолчанию спрашиваем на записи', () => {
  assert.equal(gate.needsApproval({ mutating: true, policy: 'never' }), false);
  assert.equal(gate.needsApproval({ mutating: true, policy: 'writes' }), true);
  assert.equal(gate.needsApproval({ mutating: true, policy: 'always' }), true);
  assert.equal(gate.needsApproval({ mutating: false, policy: 'always' }), false, 'сам по себе не спрашивает');
  assert.equal(gate.alwaysAsks('always'), true, 'но политика always добирает и чтение');
  assert.equal(gate.alwaysAsks('writes'), false);
});

test('правка реестра и заметок спрашивается даже при политике never', () => {
  assert.equal(gate.needsApproval({ mutating: true, always: true, policy: 'never' }), true);

  for (const name of ['host_set', 'conn_set', 'conn_remove', 'host_remove', 'secret_set', 'notes_set', 'notes_remove']) {
    const tool = ALL.find((t) => t.name === name);
    assert.ok(tool, `инструмент ${name} на месте`);
    assert.equal(tool.alwaysConfirm, true, `${name} обязан спрашивать человека`);
  }
});

test('чтение реестра и журнала не спрашивает', () => {
  for (const name of ['conn_list', 'conn_info', 'host_list', 'notes_get', 'notes_search', 'audit_query', 'audit_show', 'help', 'registry_info']) {
    const tool = ALL.find((t) => t.name === name);
    assert.equal(tool.mutating, false, `${name} — чтение`);
    assert.notEqual(tool.alwaysConfirm, true, `${name} не должен дёргать человека`);
  }
});

test('без ответа человека вызов отказывает по таймауту и это видно в очереди', async () => {
  const ctx = { server: { server: { getClientCapabilities: () => ({}) } } };

  await assert.rejects(
    gate.approve(ctx, { tool: 'ssh_exec', alias: 'demo/shell', summary: 'rm -rf /' }),
    (err) => {
      assert.equal(err.name, 'Declined');
      assert.equal(err.decision.status, 'timeout');
      return true;
    },
  );

  const last = queue.recent(1)[0];
  assert.equal(last.status, 'timeout');
  assert.equal(last.summary, 'rm -rf /');
});

test('решение человека будит ждущий вызов', async () => {
  const ctx = { server: { server: { getClientCapabilities: () => ({}) } } };
  const pendingCall = gate.approve(ctx, { tool: 'ssh_exec', alias: 'demo/shell', summary: 'systemctl restart nginx' });

  // Заявка появляется в очереди сразу — её и видит человек на странице.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const waiting = queue.pending();
  assert.equal(waiting.length, 1);

  queue.decide(waiting[0].id, 'approved', 'web');
  const decision = await pendingCall;

  assert.equal(decision.status, 'approved');
  assert.equal(decision.via, 'web');
  assert.equal(queue.pendingCount(), 0);
});

test('отказ человека — обычный исход с объяснением', async () => {
  const ctx = { server: { server: { getClientCapabilities: () => ({}) } } };
  const pendingCall = gate.approve(ctx, { tool: 'files_remove', alias: 'demo/files', summary: 'rm /var/www/index.php' });

  await new Promise((resolve) => setTimeout(resolve, 20));
  queue.decide(queue.pending()[0].id, 'declined', 'web');

  await assert.rejects(pendingCall, /человек отказал/);
});

test('клиент, умеющий спрашивать сам, решает без очереди', async () => {
  const asked = [];
  const ctx = {
    server: {
      server: {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: async (request) => {
          asked.push(request.message);
          return { action: 'accept', content: { approve: true } };
        },
      },
    },
  };

  const decision = await gate.approve(ctx, { tool: 'db_query', alias: 'demo/db', summary: 'delete from t' });

  assert.equal(decision.status, 'approved');
  assert.equal(decision.via, 'elicitation');
  assert.ok(asked[0].includes('delete from t'), 'человеку показали сам запрос');
  assert.equal(queue.recent(1)[0].decidedVia, 'elicitation', 'решение всё равно записано');
});

test('клиент сказал «нет» — вызов не состоится', async () => {
  const ctx = {
    server: {
      server: {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: async () => ({ action: 'decline' }),
      },
    },
  };

  await assert.rejects(
    gate.approve(ctx, { tool: 'ssh_exec', alias: 'demo/shell', summary: 'reboot' }),
    /человек отказал/,
  );
});
