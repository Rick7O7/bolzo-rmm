// Client-Liste im Stil der UniFi-Geräteliste: Filter oben, eine ruhige Zeile pro Rechner,
// ein Klick öffnet rechts ein Detail-Panel (Doppelklick: ganze Detailseite).
import { api, LS } from '../api.js';
import {
  icon, esc, $, $$, tagHtml, memPct, worstDisk, fmtDuration, fmtAgo, fmtBytes, primaryIp, throttle, confirmDialog, toast,
  isPveHost, osName, osShort, pveLine, clientIcon,
} from '../ui.js';
import { lineChart } from '../charts.js';
import { addClientDialog } from './settings.js';
import { runScriptDialog } from './scripts.js';
import { openConsole } from '../proxmox.js';
import { renderFolderTree, subtreeIds, folderById, folderPath, moveMenu, folderIcon } from '../folders.js';

const COLS = [
  { key: 'name', label: 'Name', get: (a) => a.name.toLowerCase() },
  { key: 'status', label: 'Zustand', get: (a) => (a.online ? (a.alerts.length ? 1 : 2) : 0) },
  { key: 'tags', label: 'Tags', get: (a) => (a.tags || []).join(',').toLowerCase() || '~' },
  { key: 'os', label: 'Betriebssystem', get: (a) => osShort(a) },
  { key: 'ip', label: 'IP-Adresse', get: (a) => primaryIp(a).split('.').map((n) => n.padStart(3, '0')).join('.') },
  { key: 'cpu', label: 'CPU', get: (a) => a.metrics?.cpu ?? -1 },
  { key: 'mem', label: 'RAM', get: (a) => memPct(a.metrics) ?? -1 },
  { key: 'disk', label: 'Disk', get: (a) => worstDisk(a.metrics)?.pct ?? -1 },
  { key: 'seen', label: 'Laufzeit', get: (a) => (a.online ? a.metrics?.uptime ?? 0 : -(Date.now() - (a.lastSeen || 0))) },
];
const STATES = [['all', 'Alle'], ['online', 'Online'], ['offline', 'Offline'], ['alert', 'Warnungen']];
const TYPES = [['all', 'Alle Typen'], ['win32', 'Windows'], ['linux', 'Linux'], ['pve', 'Proxmox']];

function bar(v, threshold = 90) {
  if (v == null || v < 0) return '<span class="muted">–</span>';
  return `<span class="tbar"><span class="tr"><i class="${v >= threshold ? 'hi' : ''}" style="width:${Math.min(100, v)}%"></i></span><span class="v">${Math.round(v)}%</span></span>`;
}
const stateOf = (a) => (!a.online ? ['offline', 'Offline'] : a.alerts?.length ? ['alert', 'Warnung'] : ['online', 'Online']);

export function renderClients(root, { go }) {
  let sort = LS.get('clients.sort', { key: 'name', dir: 1 });
  if (!COLS.some((c) => c.key === sort.key)) sort = { key: 'name', dir: 1 };
  let query = '';
  let tagFilter = '';
  let state = 'all';
  let type = 'all';
  let current = null; // im Panel gezeigter Client
  let folder = LS.get('clients.folder', 'all'); // 'all' | 'none' | Ordner-ID
  const selected = new Set();

  root.innerHTML = `
    <div class="cl-layout">
      <aside class="ft" data-tree></aside>
      <div class="cl-list">
        <div class="page-head">
          <h1>Clients</h1><span class="sub" data-count></span>
          <span class="spacer"></span>
          <div class="btn-group" data-bulk style="display:none">
            <span class="muted" data-selcount style="align-self:center;font-size:12.5px"></span>
            <button class="btn" data-move>${icon('folder', 'sm')}Verschieben</button>
            <button class="btn" data-run>${icon('code', 'sm')}Skript ausführen</button>
            <button class="btn" data-reboot>${icon('refresh', 'sm')}Neustart</button>
          </div>
          <button class="btn primary" data-add>${icon('plus', 'sm')}Client hinzufügen</button>
        </div>
        <div class="toolbar">
          <div class="seg" data-state></div>
          <div class="seg" data-type></div>
          <span class="spacer grow"></span>
          <div class="search" style="width:220px">${icon('search', 'sm')}<input class="input" placeholder="Filtern ..." data-q></div>
          <select class="select" style="width:150px" data-tag></select>
        </div>
        <div class="card table-wrap"><table class="tbl ctbl"><thead></thead><tbody></tbody></table></div>
      </div>
      <aside class="cl-panel" data-panel hidden></aside>
    </div>`;

  $('[data-add]', root).onclick = addClientDialog;
  $('[data-q]', root).addEventListener('input', (e) => { query = e.target.value.toLowerCase(); draw(); });
  $('[data-tag]', root).addEventListener('change', (e) => { tagFilter = e.target.value; draw(); });
  $('[data-run]', root).onclick = () => runScriptDialog({ preselect: [...selected] });
  $('[data-move]', root).onclick = (e) => moveMenu(e.currentTarget, [...selected]);
  const tree = renderFolderTree($('[data-tree]', root), {
    selected: folder,
    onSelect: (k) => { folder = k; LS.set('clients.folder', k); draw(); },
  });
  const inFolder = (a) => {
    if (folder === 'all') return true;
    if (folder === 'none') return !a.folderId || !folderById(a.folderId);
    return !!a.folderId && subtreeIds(folder).has(a.folderId);
  };
  $('[data-reboot]', root).onclick = async () => {
    const ids = [...selected].filter((id) => api.agents.get(id)?.online);
    if (!ids.length) return toast('Keiner der ausgewählten Clients ist online', 'err');
    if (!(await confirmDialog({ title: 'Clients neu starten?', text: `${ids.length} Client(s) werden sofort neu gestartet.`, okText: 'Neu starten', danger: true }))) return;
    const res = await Promise.allSettled(ids.map((id) => api.action(id, 'reboot')));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    toast(`Neustart an ${ok} von ${ids.length} Client(s) gesendet`, ok === ids.length ? 'ok' : 'err');
  };

  const matchState = (a, s) => s === 'all' || (s === 'online' ? a.online : s === 'offline' ? !a.online : a.online && a.alerts?.length);
  const matchType = (a, t) => t === 'all' || (t === 'pve' ? isPveHost(a) || !!a.pve : a.platform === t && !isPveHost(a));

  function draw() {
    const all = [...api.agents.values()];
    // Filter-Schalter mit Anzahl
    $('[data-state]', root).innerHTML = STATES.map(([k, l]) => `<button data-s="${k}" class="${state === k ? 'on' : ''}">${l}<em>${all.filter((a) => matchState(a, k)).length}</em></button>`).join('');
    $('[data-type]', root).innerHTML = TYPES.filter(([k]) => k !== 'pve' || all.some((a) => isPveHost(a) || a.pve)).map(([k, l]) => `<button data-t="${k}" class="${type === k ? 'on' : ''}">${l}</button>`).join('');
    const tags = [...new Set(all.flatMap((a) => a.tags || []))].sort();
    const tagSel = $('[data-tag]', root);
    const tagOptions = `<option value="">Alle Tags</option>` + tags.map((t) => `<option ${t === tagFilter ? 'selected' : ''}>${esc(t)}</option>`).join('');
    if (tagSel.innerHTML !== tagOptions) tagSel.innerHTML = tagOptions;

    const col = COLS.find((c) => c.key === sort.key) || COLS[0];
    const rows = all
      .filter((a) => inFolder(a) && matchState(a, state) && matchType(a, type))
      .filter((a) => !tagFilter || a.tags?.includes(tagFilter))
      .filter((a) => !query || [a.name, a.hostname, primaryIp(a), a.os, a.publicIp, isPveHost(a) ? 'proxmox' : '', a.pve?.hostName, ...(a.tags || [])].join(' ').toLowerCase().includes(query))
      .sort((a, b) => { const x = col.get(a), y = col.get(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
    for (const id of selected) if (!api.agents.has(id)) selected.delete(id);

    $('[data-count]', root).textContent = `${folder !== 'all' && folder !== 'none' && folderById(folder) ? `${folderPath(folder)} · ` : folder === 'none' ? 'Ohne Ordner · ' : ''}${rows.length} von ${all.length}`;
    $('[data-bulk]', root).style.display = selected.size ? 'flex' : 'none';
    $('[data-selcount]', root).textContent = `${selected.size} ausgewählt`;

    const allSel = rows.length && rows.every((a) => selected.has(a.id));
    $('thead', root).innerHTML = `<tr><th style="width:34px"><input type="checkbox" class="check" data-all ${allSel ? 'checked' : ''}></th>${COLS.map((c) => `<th class="sortable c-${c.key}" data-sort="${c.key}">${c.label}${sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr>`;
    const t = api.settings.thresholds;
    $('tbody', root).innerHTML = rows.length ? rows.map((a) => {
      const m = a.metrics;
      const [cls, label] = stateOf(a);
      return `<tr class="click ${a.online ? '' : 'off'} ${current === a.id ? 'sel' : ''}" data-id="${a.id}" draggable="true">
        <td><input type="checkbox" class="check" data-sel ${selected.has(a.id) ? 'checked' : ''}></td>
        <td><div class="nmc"><span class="nm-ic">${clientIcon(a)}</span><div class="nm-t"><div class="n">${esc(a.name)}</div>${a.pve ? `<div class="s">${pveLine(a)}</div>` : ''}</div></div></td>
        <td><span class="state"><span class="dot ${cls}"></span>${label}</span></td>
        <td class="cl-tags">${(a.tags || []).map((x) => tagHtml(x, { small: true })).join('')}</td>
        <td class="cl-os" title="${esc(osName(a))}">${esc(osShort(a))}</td>
        <td class="muted">${esc(primaryIp(a))}</td>
        <td>${a.online ? bar(m?.cpu, t.cpu) : '<span class="muted">–</span>'}</td>
        <td>${a.online ? bar(memPct(m), t.mem) : '<span class="muted">–</span>'}</td>
        <td class="c-disk">${a.online ? bar(worstDisk(m)?.pct, t.disk) : '<span class="muted">–</span>'}</td>
        <td class="muted c-seen">${a.online ? fmtDuration(m?.uptime) : fmtAgo(a.lastSeen)}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="${COLS.length + 1}"><div class="empty">${icon('monitor')}<h3>Keine Clients</h3><div>Kein Client passt zum Filter.</div></div></td></tr>`;
    if (current) drawPanelInfo();
  }

  // ---------- Detail-Panel ----------
  let chart = null;
  let histTimer = null;
  function openPanel(id) {
    current = id;
    const panel = $('[data-panel]', root);
    panel.hidden = false;
    $('.cl-layout', root).classList.add('with-panel');
    panel.innerHTML = `
      <div class="cp-head"><span class="cp-ic" data-ic></span><div class="grow"><div class="cp-name" data-name></div><div class="cp-state" data-state-line></div></div>
        <button class="btn ghost sm icon-only" data-close title="Schließen">${icon('x', 'sm')}</button></div>
      <div class="cp-actions" data-actions></div>
      <div class="w cp-chart"><div class="wh">Auslastung · letzte Stunde</div><div data-chart></div></div>
      <div class="kv cp-kv" data-kv></div>
      <button class="btn" data-open style="width:100%">${icon('back', 'sm')}Alle Details öffnen</button>`;
    $('[data-close]', panel).onclick = closePanel;
    $('[data-open]', panel).onclick = () => go(`#/client/${id}`);
    chart?.destroy?.();
    chart = lineChart($('[data-chart]', panel), { height: 120 });
    const loadHist = () => api.get(`/api/agents/${id}`).then((d) => current === id && chart.update(d.history || [])).catch(() => {});
    loadHist();
    clearInterval(histTimer);
    histTimer = setInterval(loadHist, 15000);
    drawPanelInfo();
    draw();
  }
  function closePanel() {
    current = null;
    clearInterval(histTimer);
    chart?.destroy?.();
    chart = null;
    $('[data-panel]', root).hidden = true;
    $('.cl-layout', root).classList.remove('with-panel');
    draw();
  }
  function drawPanelInfo() {
    const a = api.agents.get(current);
    const panel = $('[data-panel]', root);
    if (!a) return closePanel();
    const [cls, label] = stateOf(a);
    const m = a.metrics;
    const t = api.settings.thresholds;
    $('[data-ic]', panel).innerHTML = clientIcon(a);
    $('[data-name]', panel).textContent = a.name;
    $('[data-state-line]', panel).innerHTML = `<span class="dot ${cls}"></span>${label} · ${a.online ? `seit ${fmtDuration(m?.uptime)}` : `zuletzt ${fmtAgo(a.lastSeen)}`}`;
    const acts = [
      ['terminal', 'Terminal', 'terminal', !a.online],
      ...(a.pve ? [['console', 'Konsole', a.pve.type === 'lxc' ? 'terminal' : 'monitor', !a.pve.hostOnline]] : []),
      ...(a.online
        ? [['reboot', 'Neustart', 'refresh'], ['shutdown', 'Ausschalten', 'power']]
        : [['wake', a.pve ? 'Starten' : 'Aufwecken', a.pve ? 'play' : 'zap']]),
    ];
    $('[data-actions]', panel).innerHTML = acts.map(([k, l, i, dis]) => `<button class="btn" data-act="${k}" ${dis ? 'disabled' : ''}>${icon(i, 'sm')}${l}</button>`).join('');
    const disk = worstDisk(m);
    $('[data-kv]', panel).innerHTML = [
      ['Betriebssystem', esc(osName(a))],
      ['IP-Adresse', esc(primaryIp(a)) || '–'],
      ...(a.publicIp ? [['Öffentliche IP', esc(a.publicIp)]] : []),
      ...(a.pve ? [['Proxmox', pveLine(a)]] : []),
      ...(a.online ? [
        ['CPU', bar(m?.cpu, t.cpu)],
        ['Arbeitsspeicher', `${bar(memPct(m), t.mem)}${m?.mem ? `<div class="muted" style="font-size:11.5px;margin-top:2px">${fmtBytes(m.mem.used)} von ${fmtBytes(m.mem.total)}</div>` : ''}`],
        ...(disk ? [[`Datenträger ${esc(disk.mount)}`, bar(disk.pct, t.disk)]] : []),
      ] : []),
      ['Ordner', `<button class="linkbtn" data-act="move">${folderIcon(folderById(a.folderId))}${a.folderId && folderById(a.folderId) ? esc(folderPath(a.folderId)) : 'ohne Ordner'}</button>`],
      ['Tags', (a.tags || []).map((x) => tagHtml(x, { small: true })).join(' ') || '<span class="muted">–</span>'],
      ['Agent', `${esc(a.version || '–')}${a.outdated ? ' <span class="badge warning">veraltet</span>' : ''}`],
    ].map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');
  }
  async function panelAction(kind, btn) {
    const a = api.agents.get(current);
    if (!a) return;
    try {
      if (kind === 'move') return moveMenu(btn, [a.id]);
      if (kind === 'terminal') return go(`#/client/${a.id}/terminal`);
      if (kind === 'console') return openConsole({ hostId: a.pve.hostId, vmid: a.pve.vmid, type: a.pve.type, name: a.name, label: a.name, hostName: a.pve.hostName });
      if (kind === 'wake') {
        const r = await api.post(`/api/agents/${a.id}/wake`);
        return toast(a.pve ? `Wird gestartet (über ${r.via})` : `Magic Packet gesendet (über ${r.via})`);
      }
      const reboot = kind === 'reboot';
      if (!(await confirmDialog({ title: `${a.name} ${reboot ? 'neu starten' : 'herunterfahren'}?`, text: 'Nicht gespeicherte Arbeit auf dem Rechner geht verloren.', okText: reboot ? 'Neu starten' : 'Herunterfahren', danger: true }))) return;
      await api.action(a.id, kind);
      toast(reboot ? 'Neustart wird ausgeführt' : 'Wird heruntergefahren');
    } catch (e) { toast(e.message, 'err'); }
  }

  const view = $('.cl-layout', root); // nicht am gemeinsamen Seitencontainer anmelden
  view.addEventListener('click', (e) => {
    const st = e.target.closest('[data-s]');
    if (st) { state = st.dataset.s; return draw(); }
    const ty = e.target.closest('[data-t]');
    if (ty) { type = ty.dataset.t; return draw(); }
    const act = e.target.closest('[data-act]');
    if (act) return panelAction(act.dataset.act, act);
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
    if (current === tr.dataset.id) return closePanel();
    openPanel(tr.dataset.id);
  });
  view.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const ids = selected.has(tr.dataset.id) ? [...selected] : [tr.dataset.id];
    e.dataTransfer.setData('text/x-bolzo-agents', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = ids.length === 1 ? api.agents.get(ids[0])?.name : `${ids.length} Clients`;
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove());
  });
  view.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) go(`#/client/${tr.dataset.id}`);
  });

  draw();
  const off = api.on('agents', throttle(draw, 1500));
  const offF = api.on('folders', throttle(draw, 300));
  return () => { off(); offF(); tree.destroy(); clearInterval(histTimer); chart?.destroy?.(); };
}
