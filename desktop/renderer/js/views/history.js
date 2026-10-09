import { api } from '../api.js';
import { icon, esc, $, $$, fmtTime, modal, toast, confirmDialog, exitBadge } from '../ui.js';

export function showRunResult(r) {
  modal({
    title: `${r.scriptName} · ${r.hostname}`,
    wide: true,
    body: `<div class="row" style="justify-content:space-between"><span class="muted">${fmtTime(r.ts)}</span>${exitBadge(r)}</div>
      <pre class="output" style="max-height:60vh">${esc(r.error ? `Fehler: ${r.error}` : r.output || '(keine Ausgabe)')}</pre>`,
  });
}

export function renderHistory(root, { go }) {
  root.innerHTML = `
    <div class="page-head">
      <h1>Verlauf</h1><span class="sub">Zuletzt ausgeführte Skripte und Befehle</span>
      <span class="spacer"></span>
      <button class="btn danger" data-clear>${icon('trash', 'sm')}Verlauf leeren</button>
    </div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Zeitpunkt</th><th>Client</th><th>Skript</th><th>Shell</th><th>Ergebnis</th></tr></thead><tbody></tbody></table></div>`;

  let items = [];
  async function load() {
    items = await api.get('/api/history').catch((e) => { toast(e.message, 'err'); return []; });
    $('tbody', root).innerHTML = items.length ? items.map((r, i) => `<tr class="click" data-i="${i}">
      <td class="num muted">${fmtTime(r.ts)}</td>
      <td style="font-weight:500">${esc(r.hostname)}</td>
      <td>${esc(r.scriptName)}</td>
      <td class="muted">${esc(r.shell)}</td>
      <td>${exitBadge(r)}</td></tr>`).join('')
      : `<tr><td colspan="5"><div class="empty">${icon('clock')}<h3>Noch kein Verlauf</h3><div>Hier erscheinen ausgeführte Skripte.</div></div></td></tr>`;
    $$('tr[data-i]', root).forEach((tr) => (tr.onclick = () => showRunResult(items[tr.dataset.i])));
  }
  $('[data-clear]', root).onclick = async () => {
    if (!(await confirmDialog({ title: 'Verlauf leeren?', text: 'Alle gespeicherten Ausgaben werden gelöscht.', okText: 'Leeren', danger: true }))) return;
    await api.del('/api/history');
    load();
  };
  load();
  return api.on('history', load);
}
