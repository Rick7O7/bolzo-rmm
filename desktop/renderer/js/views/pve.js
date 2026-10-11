// Bereich "Proxmox": oben eine Kachel je Server zum Umschalten (plus "Alle Server"),
// darunter nur der gewählte Server – kein endloses Scrollen bei mehreren Hosts.
import { api, LS } from '../api.js';
import { icon, esc, $, memPct, level } from '../ui.js';
import { proxmoxHosts, renderProxmoxHost, renderProxmoxTab } from '../proxmox.js';

const pct = (v, threshold) => `<span class="ph-bar"><i class="${level(v, threshold)}" style="width:${Math.min(100, v || 0)}%"></i></span>`;

export function renderPve(root) {
  root.innerHTML = `
    <div class="page-head"><h1>Proxmox</h1><span class="sub" data-sub></span></div>
    <div class="ph-cards" data-cards></div>
    <div data-content></div>`;
  let sel = LS.get('pve.sel', 'all');
  let shownKey = '';
  let cleanup = null;
  const counts = {}; // hostId -> { running, total }

  const hosts = () => proxmoxHosts().sort((a, b) => a.name.localeCompare(b.name));

  function drawCards() {
    const list = hosts();
    if (sel !== 'all' && !list.some((h) => h.id === sel)) sel = 'all';
    const t = api.settings.thresholds;
    const totals = Object.values(counts).reduce((s, c) => ({ running: s.running + c.running, total: s.total + c.total }), { running: 0, total: 0 });
    $('[data-sub]', root).textContent = list.length ? `${list.length} Server · ${list.filter((h) => h.online).length} online` : '';
    $('[data-cards]', root).innerHTML = !list.length ? '' : `
      <button class="ph-card all ${sel === 'all' ? 'on' : ''}" data-sel="all">
        <div class="ph-top"><span class="ph-ic">${icon('grid', 'sm')}</span><div class="ph-name">Alle Server</div></div>
        <div class="ph-big">${totals.total ? `${totals.running}<small>von ${totals.total} Gästen laufen</small>` : '<small>Gäste werden geladen ...</small>'}</div>
        <div class="ph-foot">${list.length} Server</div>
      </button>
      ${list.map((h) => {
        const m = h.metrics;
        const c = counts[h.id];
        const state = !h.online ? 'offline' : h.alerts?.length ? 'alert' : 'online';
        return `<button class="ph-card ${sel === h.id ? 'on' : ''} ${h.online ? '' : 'off'}" data-sel="${h.id}">
          <div class="ph-top"><span class="ph-ic">${icon('server', 'sm')}</span><div class="ph-name">${esc(h.name)}</div><span class="dot ${state}" title="${state === 'offline' ? 'Offline' : state === 'alert' ? 'Warnung' : 'Online'}"></span></div>
          ${h.online && m ? `
            <div class="ph-meter"><span>CPU</span>${pct(m.cpu, t.cpu)}<b>${Math.round(m.cpu)}%</b></div>
            <div class="ph-meter"><span>RAM</span>${pct(memPct(m), t.mem)}<b>${Math.round(memPct(m) || 0)}%</b></div>` : '<div class="ph-off">Offline</div>'}
          <div class="ph-foot">${c ? `${c.running} von ${c.total} Gästen laufen` : h.online ? 'Gäste werden geladen ...' : '–'}<span>PVE ${esc((h.info.proxmox.version || '').split('.').slice(0, 2).join('.'))}</span></div>
        </button>`;
      }).join('')}`;
  }

  function drawContent() {
    const list = hosts();
    const key = `${sel}|${list.map((h) => `${h.id}:${h.online}`).join(',')}`;
    if (key === shownKey) return;
    shownKey = key;
    cleanup?.();
    const box = $('[data-content]', root);
    if (!list.length) {
      cleanup = null;
      box.innerHTML = `<div class="card empty">${icon('server')}<h3>Noch kein Proxmox-Server</h3>
        <div>Installiere den BOLZO-Agent auf deinem Proxmox-Server (wie bei jedem anderen Linux-Client).<br>Er wird automatisch erkannt und erscheint dann hier.</div></div>`;
      return;
    }
    box.innerHTML = '';
    cleanup = sel === 'all' ? renderProxmoxTab(box, list.map((h) => h.id)) : renderProxmoxHost(box, sel, { compact: true });
  }

  // Gäste-Anzahl je Server für die Kacheln (leichtgewichtig, jede Minute)
  async function loadCounts() {
    await Promise.all(hosts().filter((h) => h.online).map(async (h) => {
      try {
        const { guests } = await api.get(`/api/agents/${h.id}/pve/guests`);
        const real = guests.filter((g) => !g.template);
        counts[h.id] = { running: real.filter((g) => g.status === 'running').length, total: real.length };
      } catch {}
    }));
    drawCards();
  }

  $('[data-cards]', root).addEventListener('click', (e) => {
    const c = e.target.closest('[data-sel]');
    if (!c || c.dataset.sel === sel) return;
    sel = c.dataset.sel;
    LS.set('pve.sel', sel);
    drawCards();
    drawContent();
  });

  drawCards();
  drawContent();
  loadCounts();
  const off = api.on('agents', () => { drawCards(); drawContent(); });
  const timer = setInterval(loadCounts, 60000);
  return () => { off(); clearInterval(timer); cleanup?.(); };
}
