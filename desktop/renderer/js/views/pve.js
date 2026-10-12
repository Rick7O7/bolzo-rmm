// Bereich "Proxmox": oben eine Kachel je Server (CPU, RAM, laufende Gäste), darunter alle Gäste in
// einer Tabelle, nach Server gruppiert. Klick auf eine Kachel zeigt nur diesen Server – mit den Reitern
// für Host, Updates, Netzwerk und Aufgaben; nochmal klicken (oder "Alle Server") zeigt wieder alle.
import { api, LS } from '../api.js';
import { icon, esc, $, memPct, level } from '../ui.js';
import { proxmoxHosts, renderProxmoxHost, renderProxmoxTab, fetchGuests, cachedGuests, poll } from '../proxmox.js';

const meter = (v, kind, threshold) => `<div class="px-meter"><span class="px-track"><i class="${kind} ${level(v, threshold)}" style="width:${Math.min(100, v || 0)}%"></i></span><b>${v == null ? '–' : `${Math.round(v)}%`}</b></div>`;

export function renderPve(root) {
  root.innerHTML = `
    <div class="page-head"><h1>Proxmox</h1><span class="sub" data-sub></span><span class="grow"></span>
      <button class="btn ghost" data-all hidden>${icon('grid', 'sm')}Alle Server</button></div>
    <div class="ph-cards" data-cards></div>
    <div data-content></div>`;
  let sel = LS.get('pve.sel', 'all');
  let shownKey = '';
  let cleanup = null;
  let cardsHtml = '';
  const counts = {}; // hostId -> { running, total }
  const countFrom = (id) => {
    const d = cachedGuests(id);
    if (!d) return;
    const real = d.guests.filter((g) => !g.template);
    counts[id] = { running: real.filter((g) => g.status === 'running').length, total: real.length };
  };

  const hosts = () => proxmoxHosts().sort((a, b) => a.name.localeCompare(b.name));

  function drawCards() {
    const list = hosts();
    if (sel !== 'all' && !list.some((h) => h.id === sel)) sel = 'all';
    const t = api.settings.thresholds;
    const totals = list.reduce((s, h) => ({ running: s.running + (counts[h.id]?.running || 0), total: s.total + (counts[h.id]?.total || 0) }), { running: 0, total: 0 });
    $('[data-sub]', root).textContent = !list.length ? ''
      : `${list.length} Server${totals.total ? ` · ${totals.running} von ${totals.total} Gästen laufen` : ` · ${list.filter((h) => h.online).length} online`}`;
    $('[data-all]', root).hidden = sel === 'all';
    const html = list.map((h) => {
      const m = h.metrics;
      const c = counts[h.id];
      const ver = (h.info.proxmox.version || '').split('.').slice(0, 2).join('.');
      const badge = !h.online ? '<span class="badge">offline</span>'
        : c ? `<span class="badge ${c.running ? 'good' : ''}">${c.running} / ${c.total} laufen</span>`
        : '<span class="badge">lädt ...</span>';
      return `<button class="ph-card ${sel === h.id ? 'on' : ''} ${h.online ? '' : 'off'}" data-sel="${h.id}" title="${sel === h.id ? 'Wieder alle Server zeigen' : `Nur ${esc(h.name)} zeigen – mit Host, Updates, Netzwerk und Aufgaben`}">
        <div class="ph-top">${icon('server', 'sm')}<span class="ph-name">${esc(h.name)}</span><span class="ph-ver">PVE ${esc(ver)}</span><span class="grow"></span>${badge}</div>
        <div class="ph-meters">
          <div><label>CPU</label>${h.online && m ? meter(m.cpu, '', t.cpu) : meter(null, '', 101)}</div>
          <div><label>RAM</label>${h.online && m ? meter(memPct(m), 'mem', t.mem) : meter(null, '', 101)}</div>
        </div>
      </button>`;
    }).join('');
    // Nur bei Änderungen neu zeichnen – Statusmeldungen kommen alle paar Sekunden und würden Klicks verschlucken
    if (html !== cardsHtml) $('[data-cards]', root).innerHTML = cardsHtml = html;
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

  // Gäste-Anzahl je Server für die Kacheln: aus dem gemeinsamen Speicher; nur nachladen, was älter als 50 s ist
  async function loadCounts() {
    await Promise.all(hosts().filter((h) => h.online).map((h) => fetchGuests(h.id, 50000).catch(() => {})));
  }

  const select = (v) => {
    sel = v;
    LS.set('pve.sel', sel);
    drawCards();
    drawContent();
  };
  $('[data-cards]', root).addEventListener('click', (e) => {
    const c = e.target.closest('[data-sel]');
    if (c) select(c.dataset.sel === sel ? 'all' : c.dataset.sel);
  });
  $('[data-all]', root).onclick = () => select('all');

  for (const h of hosts()) countFrom(h.id);
  drawCards();
  drawContent();
  loadCounts();
  const off = api.on('agents', () => { drawCards(); drawContent(); });
  const offG = api.on('pve.guests', (id) => { countFrom(id); drawCards(); });
  const stopPoll = poll(loadCounts, 60000);
  return () => { off(); offG(); stopPoll(); cleanup?.(); };
}
