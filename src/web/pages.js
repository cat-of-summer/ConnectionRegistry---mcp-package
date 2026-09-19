import { cfg } from '../config.js';

// Страницы стенда пишутся строкой и не собираются ничем: это два экрана на одного
// человека, и сборщик ради них стоил бы дороже, чем сами страницы.

const STYLE = `
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3;
          --ok:#1a7f37; --bad:#b42318; --wait:#9a6700; --card:#fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181d; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2c2f36;
            --ok:#3fb950; --bad:#f85149; --wait:#d29922; --card:#1d2027; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
  nav a { color: inherit; margin-right: 16px; }
  .card { border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:12px;
          background:var(--card); }
  .row { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .tool { font-weight:600; }
  .alias { color:var(--muted); }
  .when { color:var(--muted); font-size:12px; margin-left:auto; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px;
        overflow:auto; max-height:320px; font-size:13px; margin:10px 0 0; }
  button { font:inherit; padding:7px 14px; border-radius:8px; border:1px solid var(--line);
           background:var(--bg); color:var(--fg); cursor:pointer; }
  button.yes { border-color:var(--ok); color:var(--ok); }
  button.no  { border-color:var(--bad); color:var(--bad); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .wait { color:var(--wait); }
  .empty { color:var(--muted); padding:32px 0; text-align:center; }
  input, select { font:inherit; padding:6px 10px; border-radius:8px; border:1px solid var(--line);
                  background:var(--bg); color:var(--fg); }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  td, th { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  tr.clickable { cursor:pointer; }
  td:first-child { white-space:nowrap; }
`;

function shell(title, body, script) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<nav><a href="/approvals">Подтверждения</a><a href="/audit">Журнал</a></nav>
${body}
</main>
<script type="module">${script}</script>
</body>
</html>`;
}

export function approvalsPage() {
  return shell('Подтверждения — реестр подключений', `
<h1>Подтверждения</h1>
<p class="sub">Изменяющее действие ждёт разрешения здесь, когда клиент агента не умеет спрашивать сам.
Таймаут — ${Math.round(cfg.approveTimeoutMs / 1000)} с.</p>
<div id="list"><p class="empty">Загрузка…</p></div>
<h2 style="font-size:16px;margin-top:32px">Недавние решения</h2>
<div id="recent"></div>
`, `
const list = document.getElementById('list');
const recent = document.getElementById('recent');

const when = (ts) => new Date(ts).toLocaleString('ru-RU');

function card(item) {
  const details = item.details
    ? '<pre>' + Object.entries(item.details)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)))
        .join('\\n') + '</pre>'
    : '';
  return '<div class="card"><div class="row"><span class="tool">' + item.tool + '</span>'
    + '<span class="alias">' + (item.alias || '') + '</span>'
    + '<span class="when">' + when(item.ts) + '</span></div>'
    + '<div style="margin-top:6px">' + escapeHtml(item.summary) + '</div>'
    + details
    + '<div class="row" style="margin-top:12px">'
    + '<button class="yes" data-id="' + item.id + '" data-decision="approved">Разрешить</button>'
    + '<button class="no" data-id="' + item.id + '" data-decision="declined">Отказать</button>'
    + '</div></div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function refresh() {
  const res = await fetch('/api/approvals');
  const data = await res.json();

  list.innerHTML = data.pending.length
    ? data.pending.map(card).join('')
    : '<p class="empty">Ждущих заявок нет.</p>';

  recent.innerHTML = '<table><tbody>' + data.recent
    .filter((item) => item.status !== 'pending')
    .map((item) => '<tr><td>' + when(item.ts) + '</td><td>' + item.tool + '</td>'
      + '<td>' + (item.alias || '') + '</td>'
      + '<td class="' + (item.status === 'approved' ? 'ok' : 'bad') + '">' + item.status + '</td>'
      + '<td>' + (item.decidedVia || '') + '</td></tr>').join('')
    + '</tbody></table>';
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  button.disabled = true;
  await fetch('/api/approvals/' + button.dataset.id, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: button.dataset.decision }),
  });
  refresh();
});

new EventSource('/api/approvals/stream').onmessage = refresh;
refresh();
`);
}

export function auditPage() {
  return shell('Журнал — реестр подключений', `
<h1>Журнал действий</h1>
<p class="sub">Каждое действие целиком: команда, код возврата, вывод. Секреты замаскированы.</p>
<div class="row" style="margin-bottom:16px">
  <input id="alias" placeholder="алиас" size="16">
  <input id="tool" placeholder="инструмент" size="14">
  <input id="contains" placeholder="подстрока" size="16">
  <label><input type="checkbox" id="errors"> только ошибки</label>
  <button id="apply">Показать</button>
</div>
<div id="list"><p class="empty">Загрузка…</p></div>
<div id="detail"></div>
`, `
const list = document.getElementById('list');
const detail = document.getElementById('detail');
const when = (ts) => new Date(ts).toLocaleString('ru-RU');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function refresh() {
  const params = new URLSearchParams();
  for (const id of ['alias', 'tool', 'contains']) {
    const value = document.getElementById(id).value.trim();
    if (value) params.set(id, value);
  }
  if (document.getElementById('errors').checked) params.set('onlyErrors', '1');
  params.set('limit', '100');

  const data = await (await fetch('/api/audit?' + params)).json();
  list.innerHTML = data.entries.length
    ? '<table><thead><tr><th>Когда</th><th>Инструмент</th><th>Алиас</th><th>Итог</th><th>Команда</th></tr></thead><tbody>'
      + data.entries.map((e) => '<tr class="clickable" data-id="' + e.id + '">'
        + '<td>' + when(e.ts) + '</td><td>' + e.tool + '</td><td>' + (e.alias || '') + '</td>'
        + '<td class="' + (e.ok ? 'ok' : 'bad') + '">' + (e.ok ? 'ок' : 'ошибка')
        + (e.exitCode === null || e.exitCode === undefined ? '' : ' (' + e.exitCode + ')') + '</td>'
        + '<td>' + escapeHtml((e.command || e.error || '').slice(0, 120)) + '</td></tr>').join('')
      + '</tbody></table>'
    : '<p class="empty">Записей нет.</p>';
}

list.addEventListener('click', async (event) => {
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  const item = await (await fetch('/api/audit/' + row.dataset.id)).json();
  detail.innerHTML = '<div class="card"><div class="row"><span class="tool">' + item.tool + '</span>'
    + '<span class="alias">' + (item.alias || '') + '</span>'
    + '<span class="when">' + when(item.ts) + ' · ' + item.durationMs + ' мс</span></div>'
    + '<pre>' + escapeHtml(JSON.stringify(item.args, null, 2)) + '</pre>'
    + (item.command ? '<pre>' + escapeHtml(item.command) + '</pre>' : '')
    + (item.stdout ? '<pre>' + escapeHtml(item.stdout) + '</pre>' : '')
    + (item.stderr ? '<pre class="bad">' + escapeHtml(item.stderr) + '</pre>' : '')
    + '</div>';
  detail.scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('apply').addEventListener('click', refresh);
refresh();
`);
}
