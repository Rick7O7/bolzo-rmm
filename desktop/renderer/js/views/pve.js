// Eigener Bereich "Proxmox": alle Proxmox-Server mit ihren VMs und Containern auf einer Seite
import { api } from '../api.js';
import { icon, esc, $, statusHtml, meter, memPct } from '../ui.js';
import { proxmoxHosts, renderProxmoxTab } from '../proxmox.js';

export function renderPve(root, { go }) {
  root.innerHTML = `
    <div class="page-head">
      <h1>Proxmox</h1><span class="sub">Server, VMs und Container</span>
    </div>
    <div data-hosts></div>`;
  let cleanups = [];
  let shown = '';

  function draw() {
    const hosts = proxmoxHosts().sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    const key = hosts.map((h) => `${h.id}:${h.online}`).join('|');
    if (key === shown) return drawHeads(hosts); // Tabellen nicht bei jedem Messwert neu laden
    shown = key;
    cleanups.forEach((c) => c?.());
    cleanups = [];
    const box = $('[data-hosts]', root);
    if (!hosts.length) {
      box.innerHTML = `<div class="card empty">${icon('server')}<h3>Noch kein Proxmox-Server</h3>
        <div>Installiere den BOLZO-Agent auf deinem Proxmox-Server (wie bei jedem anderen Linux-Client).<br>Er wird automatisch erkannt und erscheint dann hier.</div></div>`;
      return;
    }
    box.innerHTML = hosts.map((h) => `
      <section class="pve-section" data-host="${h.id}">
        <div class="pve-head">
          <div class="detail-icon">${icon('server')}</div>
          <div class="grow" style="min-width:0">
            <div class="row" style="gap:10px;flex-wrap:wrap"><a href="#/client/${h.id}" class="pve-name">${esc(h.name)}</a><span data-status></span></div>
            <div class="muted" style="font-size:12.5px;margin-top:3px">Proxmox VE ${esc(h.info.proxmox.version || '')} · Knoten ${esc(h.info.proxmox.node)}</div>
          </div>
          <div class="pve-meters" data-meters></div>
        </div>
        <div data-guests></div>
      </section>`).join('');
    for (const h of hosts) {
      const sec = root.querySelector(`[data-host="${h.id}"]`);
      cleanups.push(renderProxmoxTab($('[data-guests]', sec), h.id, { compact: true }));
    }
    drawHeads(hosts);
  }

  function drawHeads(hosts) {
    for (const h of hosts) {
      const sec = root.querySelector(`[data-host="${h.id}"]`);
      if (!sec) continue;
      $('[data-status]', sec).innerHTML = statusHtml(h);
      const m = h.metrics;
      $('[data-meters]', sec).innerHTML = h.online && m
        ? `${meter({ label: 'CPU', iconName: 'cpu', value: m.cpu, threshold: api.settings.thresholds.cpu })}${meter({ label: 'RAM', iconName: 'memory', value: memPct(m), kind: 'mem', threshold: api.settings.thresholds.mem })}`
        : '';
    }
  }

  draw();
  const off = api.on('agents', draw);
  return () => { off(); cleanups.forEach((c) => c?.()); };
}
