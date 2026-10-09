import { api, LS } from '../api.js';
import { icon, esc, $, $$, tagHtml, memPct, worstDisk, fmtDuration, fmtAgo, osIcon, primaryIp, level, throttle, confirmDialog, toast } from '../ui.js';
import { addClientDialog } from './settings.js';
import { runScriptDialog } from './scripts.js';

const COLS = [
  { key: 'status', label: '', get: (a) => (a.online ? (a.alerts.length ? 1 : 2) : 0) },
  { key: 'name', label: 'Name', get: (a) => a.name.toLowerCase() },
  { key: 'os', label: 'Betriebssystem', get: (a) => a.os },
  { key: 'ip', label: 'IP-Adresse', get: (a) => primaryIp(a).split('.').map((n) => n.padStart(3, '0')).join('.') },
  { key: 'cpu', label: 'CPU', get: (a) => a.metrics?.cpu ?? -1 },
  { key: 'mem', label: 'RAM', get: (a) => memPct(a.metrics) ?? -1 },
  { key: 'disk', label: 'Disk', get: (a) => worstDisk(a.metrics)?.pct ?? -1 },
  { key: 'uptime', label: 'Uptime', get: (a) => a.metrics?.uptime ?? -1 },
  { key: 'seen', label: 'Zuletzt', get: (a) => a.lastSeen || 0 },
];

function mini(value, kind, threshold) {
  if (value == null || value < 0) return '<span class="muted">–</span>';
  return `<span class="mini-meter"><span class="meter-track"><span class="meter-fill ${kind} ${level(value, threshold)}" style="display:block;width:${Math.min(100, value)}%"></span></span><span>${Math.round(value)}%</span></span>`;
}

export function renderClients(root, { go }) {
  let sort = LS.get('clients.sort', { key: 'name', dir: 1 });
  let query = '';
  let tagFilter = '';
  const selected = new Set();

  root.innerHTML = `
    <div class="page-head">
      <h1>Clients</h1><span class="sub" data-count></span>
      <span class="spacer"></span>
      <button class="btn primary" data-add>${icon('plus')}Client hinzufügen</button>
    </div>
    <div class="toolbar">
      <div class="search grow" style="max-width:340px">${icon('search', 'sm')}<input class="input" placeholder="Suchen ..." data-q></div>
      <select class="select" style="width:180px" data-tag></select>
      <span class="spacer grow"></span>
      <div class="btn-group" data-bulk style="display:none">
        <span class="muted" data-selcount style="align-self:center"></span>
        <button class="btn" data-run>${icon('play', 'sm')}Skript ausführen</button>
        <button class="btn" data-reboot>${icon('refresh', 'sm')}Neustart</button>
      </div>
    </div>
    <div class="card table-wrap"><table class="tbl"><thead></thead><tbody></tbody></table></div>`;

  $('[data-add]', root).onclick = addClientDialog;
  $('[data-q]', root).addEventListener('input', (e) => { query = e.target.value.toLowerCase(); draw(); });
  $('[data-tag]', root).addEventListener('change', (e) => { tagFilter = e.target.value; draw(); });
  $('[data-run]', root).onclick = () => runScriptDialog({ preselect: [...selected] });
  $('[data-reboot]', root).onclick = async () => {
    const ids = [...selected].filter((id) => api.agents.get(id)?.online);
    if (!ids.length) return toast('Keiner der ausgewählten Clients ist online', 'err');
    if (!(await confirmDialog({ title: 'Clients neu starten?', text: `${ids.length} Client(s) werden sofort neu gestartet.`, okText: 'Neu starten', danger: true }))) return;
    const res = await Promise.allSettled(ids.map((id) => api.action(id, 'reboot')));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    toast(`Neustart an ${ok} von ${ids.length} Client(s) gesendet`, ok === ids.length ? 'ok' : 'err');
  };

  function draw() {
    const all = [...api.agents.values()];
    const tags = [...new Set(all.flatMap((a) => a.tags || []))].sort();
    const tagSel = $('[data-tag]', root);
    const tagOptions = `<option value="">Alle Tags</option>` + tags.map((t) => `<option ${t === tagFilter ? 'selected' : ''}>${esc(t)}</option>`).join('');
    if (tagSel.innerHTML !== tagOptions) tagSel.innerHTML = tagOptions;

    const col = COLS.find((c) => c.key === sort.key) || COLS[1];
    const rows = all
      .filter((a) => !tagFilter || a.tags?.includes(tagFilter))
      .filter((a) => !query || [a.name, a.hostname, primaryIp(a), a.os, a.publicIp, ...(a.tags || [])].join(' ').toLowerCase().includes(query))
      .sort((a, b) => { const x = col.get(a), y = col.get(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
    for (const id of selected) if (!api.agents.has(id)) selected.delete(id);

    $('[data-count]', root).textContent = `${rows.length} von ${all.length}`;
    $('[data-bulk]', root).style.display = selected.size ? 'flex' : 'none';
    $('[data-selcount]', root).textContent = `${selected.size} ausgewählt`;

    const allSel = rows.length && rows.every((a) => selected.has(a.id));
    $('thead', root).innerHTML = `<tr><th style="width:36px"><input type="checkbox" class="check" data-all ${allSel ? 'checked' : ''}></th>${COLS.map((c) => `<th class="sortable" data-sort="${c.key}">${c.label}${sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}<th></th></tr>`;
    const t = api.settings.thresholds;
    $('tbody', root).innerHTML = rows.length ? rows.map((a) => {
      const m = a.metrics;
      return `<tr class="click" data-id="${a.id}">
        <td><input type="checkbox" class="check" data-sel ${selected.has(a.id) ? 'checked' : ''}></td>
        <td><span class="dot ${a.online ? (a.alerts.length ? 'alert' : 'online') : 'offline'}" style="display:inline-block"></span></td>
        <td style="min-width:260px"><div style="font-weight:500">${esc(a.name)}</div>${a.tags?.length ? `<div class="tag-row" style="gap:4px;margin-top:5px">${a.tags.map((x) => tagHtml(x, { small: true })).join('')}</div>` : ''}</td>
        <td><span class="os">${osIcon(a.platform)}${esc(a.os)}</span></td>
        <td class="mono">${esc(primaryIp(a))}</td>
        <td>${a.online ? mini(m?.cpu, '', t.cpu) : '<span class="muted">–</span>'}</td>
        <td>${a.online ? mini(memPct(m), 'mem', t.mem) : '<span class="muted">–</span>'}</td>
        <td>${a.online ? mini(worstDisk(m)?.pct, '', t.disk) : '<span class="muted">–</span>'}</td>
        <td class="num">${a.online ? fmtDuration(m?.uptime) : '–'}</td>
        <td class="muted">${a.online ? 'jetzt' : fmtAgo(a.lastSeen)}</td>
        <td class="actions"><button class="btn sm ghost icon-only" title="Terminal öffnen" data-term>${icon('terminal', 'sm')}</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="${COLS.length + 2}"><div class="empty">${icon('monitor')}<h3>Keine Clients</h3></div></td></tr>`;
  }

  root.addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]');
    if (th) {
      sort = { key: th.dataset.sort, dir: sort.key === th.dataset.sort ? -sort.dir : 1 };
      LS.set('clients.sort', sort);
      return draw();
    }
    if (e.target.matches('[data-all]')) {
      const ids = $$('tbody tr[data-id]', root).map((r) => r.dataset.id);
      if (e.target.checked) ids.forEach((id) => selected.add(id));
      else ids.forEach((id) => selected.delete(id));
      return draw();
    }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (e.target.matches('[data-sel]')) {
      if (e.target.checked) selected.add(tr.dataset.id);
      else selected.delete(tr.dataset.id);
      return draw();
    }
    if (e.target.closest('[data-term]')) return go(`#/client/${tr.dataset.id}/terminal`);
    go(`#/client/${tr.dataset.id}`);
  });

  draw();
  const off = api.on('agents', throttle(draw, 1500));
  return off;
}
