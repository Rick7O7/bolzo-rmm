// Seite eines Netzwerkgeräts. OPNsense: Übersicht, Geräte im Netz, Dienste, Firewall, VPN, Updates.
// Switch (SNMP): Ports mit Frontansicht, angeschlossene Geräte, VLANs, Info. Ohne SNMP: Erreichbarkeit.
// Alle Abfragen laufen über den Abfrage-Client des Geräts (siehe server/network.js).
import { api } from '../api.js';
import { icon, esc, el, $, $$, toast, confirmDialog, promptDialog, fmtBytes, fmtRate, fmtDuration, fmtAgo } from '../ui.js';
import { poll, miniBar } from '../proxmox.js';
import { renderAuditLog } from './history.js';
import { KIND, stateBadge, deviceDialog } from './network.js';

const TABS = {
  opnsense: [['overview', 'Übersicht', 'activity'], ['clients', 'Geräte im Netz', 'users'], ['services', 'Dienste', 'server'], ['firewall', 'Firewall', 'firewall'], ['vpn', 'VPN', 'lock'], ['updates', 'Updates', 'download'], ['audit', 'Verlauf', 'clock'], ['notes', 'Notizen', 'note']],
  snmp: [['ports', 'Ports', 'ethernet'], ['macs', 'Angeschlossene Geräte', 'users'], ['vlans', 'VLANs', 'network'], ['info', 'Info', 'activity'], ['audit', 'Verlauf', 'clock'], ['notes', 'Notizen', 'note']],
  ping: [['info', 'Übersicht', 'activity'], ['audit', 'Verlauf', 'clock'], ['notes', 'Notizen', 'note']],
};
const tabsOf = (d) => (d.kind === 'opnsense' ? TABS.opnsense : d.snmp ? TABS.snmp : TABS.ping);
const call = (d, action, params) => api.netCall(d.id, action, params);
const errBox = (e) => `<div class="card empty err-text">${icon('alert')}<div>${esc(e.message || e)}</div></div>`;
const dash = '<span class="muted">–</span>';
const ms = (v) => (v == null ? '–' : `${String(Math.round(v * 10) / 10).replace('.', ',')} ms`);
const speedText = (mbit) => (!mbit ? '' : mbit >= 1000 ? `${String(mbit / 1000).replace('.', ',')} G` : `${mbit} M`);
const portLabel = (p) => (/^\d+$/.test(p.name) ? `Port ${p.name}` : p.name);
const ipKey = (ip) => String(ip || '').split('.').map((n) => n.padStart(3, '0')).join('.');

function popupMenu(anchor, items, onPick) {
  const r = anchor.getBoundingClientRect();
  const menu = el(`<div class="menu" style="top:${r.bottom + 6}px;right:${Math.max(8, window.innerWidth - r.right)}px">${items.map((i) => (i.sep ? '<div class="menu-sep"></div>'
    : i.note ? `<div class="menu-note">${esc(i.note)}</div>`
    : `<button class="menu-item ${i.danger ? 'danger' : ''}" data-k="${i.k}" ${i.disabled ? 'disabled' : ''}>${icon(i.icon, 'sm')}<span class="grow">${esc(i.label)}</span>${i.sub ? `<span class="muted mono" style="font-size:11px">${esc(i.sub)}</span>` : ''}</button>`)).join('')}</div>`);
  document.body.append(menu);
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside); };
  const outside = (e) => !menu.contains(e.target) && close();
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = (e) => {
    const k = e.target.closest('[data-k]:not([disabled])')?.dataset.k;
    if (!k) return;
    close();
    onPick(k);
  };
}

// Antwortzeiten als Balken (je Prüfung einer; rot = keine Antwort)
function latencyHtml(points) {
  if (!points.length) return '<div class="muted" style="font-size:12.5px">Noch keine Messwerte – das Gerät wird alle 30 Sekunden geprüft.</div>';
  const vals = points.map((p) => p[1]).filter((v) => v != null);
  const max = Math.max(2, ...vals);
  const lost = points.length - vals.length;
  const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  const bars = points.map(([ts, v]) => `<i class="${v == null ? 'lost' : ''}" style="height:${v == null ? 100 : Math.max(6, (100 * Math.sqrt(v)) / Math.sqrt(max))}%" title="${new Date(ts).toLocaleTimeString('de-DE')}: ${v == null ? 'keine Antwort' : ms(v)}"></i>`).join('');
  return `<div class="lat-bars">${bars}</div>
    <div class="lat-sum"><span>Ø <b>${ms(avg)}</b></span><span>Max <b>${ms(vals.length ? Math.max(...vals) : null)}</b></span><span class="${lost ? 'warn' : ''}">Ausfälle <b>${lost}</b></span><span class="muted">letzte ${Math.round((points.at(-1)[0] - points[0][0]) / 60e3) || 1} Min</span></div>`;
}

export function renderNetDevice(root, { go, params }) {
  const id = params[0];
  const dev = () => api.net.get(id);
  if (!dev()) {
    root.innerHTML = `<button class="crumb" data-back>${icon('back', 'sm')}Netzwerk</button><div class="card empty">${icon('network')}<h3>Gerät nicht gefunden</h3></div>`;
    $('[data-back]', root).onclick = () => go('#/network');
    return null;
  }
  let tab = tabsOf(dev()).some((t) => t[0] === params[1]) ? params[1] : tabsOf(dev())[0][0];
  let cleanupTab = null;
  let sel = params[2] != null ? Number(params[2]) : null; // gewählter Switch-Port
  root.innerHTML = `<div class="nd-page">
    <button class="crumb" data-back style="margin-bottom:10px">${icon('back', 'sm')}Netzwerk</button>
    <div class="detail-head" data-head></div>
    <div class="tabs" data-tabs></div>
    <div data-body></div></div>`;
  const view = $('.nd-page', root);
  $('[data-back]', root).onclick = () => go('#/network');

  // ---------- Kopf ----------
  let headHtml = '';
  function drawHead() {
    const d = dev();
    if (!d) return;
    const k = KIND[d.kind];
    const i = d.info || {};
    const crumb = $('[data-crumb]');
    if (crumb) crumb.textContent = `Netzwerk / ${d.name}`;
    const sub = d.kind === 'opnsense' ? i.version : d.snmp ? i.model || i.descr : '';
    const html = `
      <div class="detail-icon net">${icon(k.icon)}</div>
      <div class="detail-title grow">
        <div class="page-kind net">${icon('network', 'sm')}${k.long}<span>abgefragt über ${d.probeName ? `<a href="#/client/${esc(d.probeId)}">${esc(d.probeName)}</a>${d.probeOnline ? '' : ' (offline)'}` : 'keinen Abfrage-Client'}</span></div>
        <h1>${esc(d.name)} ${stateBadge(d)}</h1>
        <div class="meta"><span class="mono">${esc(d.host)}</span>${sub ? `<span>${esc(sub)}</span>` : ''}${i.uptime ? `<span>läuft seit ${fmtDuration(i.uptime)}</span>` : ''}${d.ms != null ? `<span>Ping ${ms(d.ms)}</span>` : ''}${d.state === 'offline' && d.lastSeen ? `<span>zuletzt erreichbar ${fmtAgo(d.lastSeen)}</span>` : ''}</div>
        ${d.error && d.state !== 'online' ? `<div class="nd-headerr">${icon('alert', 'sm')}${esc(d.error)}</div>` : ''}
        ${(d.alerts || []).filter((a) => a.level !== 'info').map((a) => `<div class="nd-headerr">${icon('alert', 'sm')}${esc(a.label)}</div>`).join('')}
      </div>
      <div class="btn-group">
        <button class="btn" data-act="web">${icon('external', 'sm')}Weboberfläche</button>
        <button class="btn" data-act="edit">${icon('edit', 'sm')}Bearbeiten</button>
        <button class="btn icon-only" data-act="more" title="Weitere Aktionen">⋯</button>
      </div>`;
    if (html !== headHtml) $('[data-head]', root).innerHTML = headHtml = html;
  }
  $('[data-head]', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const d = dev();
    if (b.dataset.act === 'edit') return deviceDialog(d);
    if (b.dataset.act === 'web') return webMenu(b, d);
    if (b.dataset.act === 'more') {
      popupMenu(b, [
        ...(d.kind === 'opnsense' ? [{ k: 'backup', label: 'Konfiguration sichern (config.xml)', icon: 'download' }, { k: 'reboot', label: 'OPNsense neu starten', icon: 'power', danger: true }, { sep: true }] : []),
        { k: 'edit', label: 'Bearbeiten', icon: 'edit' },
        { k: 'delete', label: 'Aus BOLZO RMM entfernen', icon: 'x', danger: true },
      ], async (k) => {
        if (k === 'edit') return deviceDialog(d);
        if (k === 'backup') return backup(d);
        if (k === 'reboot') return rebootOpn(d);
        if (k === 'delete') {
          if (!(await confirmDialog({ title: `${d.name} entfernen?`, text: 'Das Gerät wird aus BOLZO RMM entfernt. Am Gerät selbst ändert sich nichts.', okText: 'Entfernen', danger: true }))) return;
          try { await api.del(`/api/net/${d.id}`); toast('Gerät entfernt'); go('#/network'); } catch (err) { toast(err.message, 'err'); }
        }
      });
    }
  });

  // ---------- Reiter ----------
  function drawTabs() {
    $('[data-tabs]', root).innerHTML = tabsOf(dev()).map(([k, l, i]) => `<button class="tab ${k === tab ? 'on' : ''}" data-tab="${k}">${icon(i, 'sm')}${dev().kind === 'device' && k === 'ports' ? 'Schnittstellen' : l}</button>`).join('');
  }
  function showTab(k) {
    tab = k;
    drawTabs();
    history.replaceState(null, '', `#/netdev/${id}/${k}${k === 'ports' && sel != null ? `/${sel}` : ''}`);
    cleanupTab?.();
    cleanupTab = null;
    // Jeder Reiter bekommt ein frisches Element – so verschwinden seine Klick-Handler mit ihm
    const body = document.createElement('div');
    body.innerHTML = '<div class="card empty">Lade ...</div>';
    $('[data-body]', root).replaceChildren(body);
    const views ={ overview: opnOverview, clients: opnClients, services: opnServices, firewall: opnFirewall, vpn: opnVpn, updates: opnUpdates, ports: switchPorts, macs: switchMacs, vlans: switchVlans, info: infoView, audit: (b) => renderAuditLog(b, { agentId: id }), notes: notesView };
    cleanupTab = views[k](body, dev()) || null;
  }
  $('[data-tabs]', root).addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t && t.dataset.tab !== tab) showTab(t.dataset.tab);
  });

  drawHead();
  showTab(tab);
  const offNet = api.on('net', () => {
    if (!dev()) return go('#/network');
    drawHead();
  });
  return () => { offNet(); cleanupTab?.(); };

  // =====================================================================
  // OPNsense
  // =====================================================================
  function opnOverview(body, d) {
    body.innerHTML = `<div class="nd-cols"><div class="nd-main" data-main><div class="card empty">Lade ...</div></div><aside class="w nd-side" data-side></aside></div>`;
    let lat = [];
    const t = api.settings.thresholds;
    async function load() {
      let r;
      try { r = await call(d, 'opn.overview'); } catch (e) { $('[data-main]', body).innerHTML = errBox(e); return; }
      const s = r.system;
      const memP = s.mem?.total ? (100 * s.mem.used) / s.mem.total : null;
      $('[data-side]', body).innerHTML = `<div class="wh">Zustand</div><div class="kv gp-kv">
          <div class="k">Version</div><div class="v">${esc(s.version || '–')}${r.firmware?.updates ? ` <a class="badge accent" href="#/netdev/${esc(id)}/updates" data-goto="updates">${r.firmware.updates} Updates</a>` : ''}</div>
          <div class="k">Hostname</div><div class="v">${esc(s.name || '–')}</div>
          <div class="k">System</div><div class="v">${esc(s.os || '–')}</div>
          <div class="k">Läuft seit</div><div class="v">${s.uptime != null ? fmtDuration(s.uptime) : '–'}</div>
          <div class="k">CPU</div><div class="v">${miniBar(s.cpu, '', t.cpu)}${s.load ? `<div class="sub">Last ${esc(s.load)}</div>` : ''}</div>
          <div class="k">RAM</div><div class="v">${miniBar(memP, 'mem', t.mem)}${s.mem ? `<div class="sub">${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}</div>` : ''}</div>
          ${s.disks.map((x) => `<div class="k">Disk ${esc(x.mount)}</div><div class="v">${miniBar(x.pct, '', t.disk)}<div class="sub">${esc(x.used)} / ${esc(x.size)} · ${esc(x.type)}</div></div>`).join('')}
          ${s.temps.length ? `<div class="k">Temperatur</div><div class="v">${s.temps.map((x) => `${esc(x.name)} ${Math.round(x.value)} °C`).join('<br>')}</div>` : ''}
        </div>
        <div class="wh" style="border-top:1px solid var(--border)">Antwortzeit</div><div class="nd-lat" data-lat>${latencyHtml(lat)}</div>`;
      const gw = r.gateways;
      $('[data-main]', body).innerHTML = `
        <div class="card table-wrap" style="margin-bottom:14px"><div class="card-head">${icon('globe', 'sm')}<h3>Gateways</h3></div>
          <table class="tbl"><thead><tr><th>Name</th><th>Adresse</th><th>Überwacht</th><th>Status</th><th class="r">Latenz</th><th class="r">Verlust</th></tr></thead><tbody>
          ${gw.map((g) => `<tr><td style="font-weight:500">${esc(g.name)}</td><td class="mono">${esc(g.address) || dash}</td><td class="mono muted">${esc(g.monitor) || dash}</td>
            <td><span class="badge ${g.ok ? 'good' : 'critical'}">${esc(g.text)}</span></td><td class="r num">${esc(g.delay) || dash}</td><td class="r num">${esc(g.loss) || dash}</td></tr>`).join('')
            || `<tr><td colspan="6"><div class="empty">${esc(r.errors.gateways || 'Keine Gateways')}</div></td></tr>`}
          </tbody></table></div>
        <div class="card table-wrap"><div class="card-head">${icon('network', 'sm')}<h3>Schnittstellen</h3><span class="spacer"></span><span class="muted" style="font-size:12px">Durchsatz aktualisiert alle 10 s</span></div>
          <table class="tbl"><thead><tr><th>Name</th><th>Status</th><th>IPv4</th><th>Medium</th><th class="r">↓ Empfangen</th><th class="r">↑ Gesendet</th><th class="r">Gesamt ↓ / ↑</th></tr></thead><tbody>
          ${r.interfaces.map((x) => `<tr class="${x.status === 'up' || !x.status ? '' : 'off'}"><td><div style="font-weight:500">${esc(x.name)}</div><div class="muted mono" style="font-size:11.5px">${esc(x.device || '')}${x.vlan ? ` · VLAN ${esc(x.vlan)}` : ''}</div></td>
            <td>${!x.status ? dash : x.status === 'up' ? '<span class="badge good">verbunden</span>' : `<span class="badge">${esc(x.status === 'down' ? 'getrennt' : x.status === 'no carrier' ? 'kein Kabel' : x.status)}</span>`}</td>
            <td class="mono">${esc(x.ipv4) || dash}${x.ipv6 ? `<div class="muted" style="font-size:11px">${esc(x.ipv6)}</div>` : ''}</td><td class="muted" style="font-size:12px">${esc(x.media) || dash}</td>
            <td class="r num">${x.rx != null ? fmtRate(x.rx) : dash}</td><td class="r num">${x.tx != null ? fmtRate(x.tx) : dash}</td>
            <td class="r num muted">${x.rxTotal != null ? `${fmtBytes(x.rxTotal)} / ${fmtBytes(x.txTotal)}` : dash}</td></tr>`).join('')
            || `<tr><td colspan="7"><div class="empty">${esc(r.errors.interfaces || 'Keine Schnittstellen')}</div></td></tr>`}
          </tbody></table></div>`;
    }
    async function loadLat() {
      try { lat = await api.get(`/api/net/${id}/latency`); } catch {}
      const box = $('[data-lat]', body);
      if (box) box.innerHTML = latencyHtml(lat);
    }
    body.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) { e.preventDefault(); showTab(g.dataset.goto); }
    });
    loadLat().then(load);
    const s1 = poll(load, 10000);
    const s2 = poll(loadLat, 30000);
    return () => { s1(); s2(); };
  }

  function opnClients(body, d) {
    const f = { q: '', kind: 'all' };
    let rows = null;
    body.innerHTML = `<div class="toolbar">
        <div class="search" style="width:280px">${icon('search', 'sm')}<input class="input" placeholder="Name, IP, MAC, Hersteller ..." data-q></div>
        <div class="seg" data-seg></div><span class="spacer grow"></span><span class="muted" style="font-size:12.5px" data-src></span>
        <button class="btn ghost icon-only" data-reload title="Aktualisieren">${icon('refresh', 'sm')}</button></div>
      <div class="card table-wrap"><table class="tbl"><thead><tr><th>Gerät</th><th>IP-Adresse</th><th>MAC-Adresse</th><th>Netz</th><th>Art</th><th>Switch-Port</th><th>Lease bis</th></tr></thead><tbody data-rows><tr><td colspan="7"><div class="empty">Lade ...</div></td></tr></tbody></table></div>`;
    const match = (r) => {
      if (f.kind === 'online' && !r.online) return false;
      if (f.kind === 'dhcp' && r.lease !== 'dhcp') return false;
      if (f.kind === 'static' && r.lease !== 'static') return false;
      const q = f.q.trim().toLowerCase();
      return !q || [r.hostname, r.ip, r.mac, r.vendor, r.iface, r.descr, api.agents.get(r.agentId)?.name, r.switchPort?.device].join(' ').toLowerCase().includes(q);
    };
    function draw() {
      if (!rows) return;
      const n = (fn) => rows.filter(fn).length;
      $('[data-seg]', body).innerHTML = [['all', 'Alle', rows.length], ['online', 'Aktiv', n((r) => r.online)], ['dhcp', 'DHCP', n((r) => r.lease === 'dhcp')], ['static', 'Statisch', n((r) => r.lease === 'static')]]
        .map(([k, l, c]) => `<button class="${f.kind === k ? 'on' : ''}" data-k="${k}">${l} <em>${c}</em></button>`).join('');
      const list = rows.filter(match).sort((a, b) => ipKey(a.ip).localeCompare(ipKey(b.ip)));
      $('[data-rows]', body).innerHTML = list.map((r) => {
        const a = r.agentId && api.agents.get(r.agentId);
        return `<tr><td><div class="nmc"><span class="dot ${r.online ? 'online' : 'offline'}" title="${r.online ? 'in der ARP-Tabelle (aktiv)' : 'derzeit nicht aktiv'}"></span>
            <div class="nm-t"><div class="n">${a ? `<a class="link-client" href="#/client/${esc(a.id)}">${icon('monitor', 'sm')}${esc(a.name)}</a>` : esc(r.hostname || r.descr || '') || '<span class="muted">unbekannt</span>'}</div>${r.descr && r.hostname ? `<div class="s">${esc(r.descr)}</div>` : ''}</div></div></td>
          <td class="mono">${esc(r.ip || '') || dash}</td>
          <td><div class="mono" style="font-size:12px">${esc(r.mac)}</div>${r.vendor ? `<div class="muted" style="font-size:11.5px">${esc(r.vendor)}</div>` : ''}</td>
          <td class="muted">${esc(r.iface || '') || dash}</td>
          <td>${r.lease === 'static' ? '<span class="badge accent">statisch</span>' : r.lease === 'dhcp' ? '<span class="badge">DHCP</span>' : '<span class="badge" title="nur in der ARP-Tabelle, z.B. feste IP am Gerät">ARP</span>'}</td>
          <td>${r.switchPort ? `<a href="#/netdev/${esc(r.switchPort.deviceId)}/ports" class="link-client">${icon('ethernet', 'sm')}${esc(r.switchPort.device)} · ${esc(/^\d+$/.test(r.switchPort.port) ? `Port ${r.switchPort.port}` : r.switchPort.port)}</a>` : dash}</td>
          <td class="muted num" style="font-size:12px">${r.lease === 'dhcp' && r.expires ? esc(String(r.expires).replace('T', ' ').slice(0, 16)) : dash}</td></tr>`;
      }).join('') || `<tr><td colspan="7"><div class="empty">${rows.length ? 'Nichts passt zum Filter' : 'Keine Geräte gefunden'}</div></td></tr>`;
    }
    async function load() {
      try {
        const r = await call(d, 'opn.leases');
        rows = r.rows;
        const src = [r.sources.isc && 'ISC-DHCP', r.sources.kea && 'Kea', r.sources.dnsmasq && 'Dnsmasq', r.sources.arp && 'ARP'].filter(Boolean);
        $('[data-src]', body).textContent = src.length ? `Quellen: ${src.join(', ')}` : '';
        draw();
      } catch (e) {
        $('[data-rows]', body).innerHTML = `<tr><td colspan="7">${errBox(e)}</td></tr>`;
      }
    }
    $('[data-q]', body).oninput = (e) => { f.q = e.target.value; draw(); };
    $('[data-seg]', body).onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) { f.kind = b.dataset.k; draw(); } };
    $('[data-reload]', body).onclick = load;
    load();
    return poll(load, 30000);
  }

  function opnServices(body, d) {
    body.innerHTML = `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Dienst</th><th>Status</th><th class="r"></th></tr></thead><tbody data-rows><tr><td colspan="3"><div class="empty">Lade ...</div></td></tr></tbody></table></div>`;
    let list = [];
    async function load() {
      try { list = await call(d, 'opn.services'); } catch (e) { $('[data-rows]', body).innerHTML = `<tr><td colspan="3">${errBox(e)}</td></tr>`; return; }
      $('[data-rows]', body).innerHTML = list.sort((a, b) => a.description.localeCompare(b.description)).map((s) => `<tr data-id="${esc(s.id)}">
        <td><div style="font-weight:500">${esc(s.description)}</div><div class="muted mono" style="font-size:11.5px">${esc(s.id)}</div></td>
        <td>${s.running ? '<span class="badge good">läuft</span>' : '<span class="badge critical">gestoppt</span>'}</td>
        <td class="r" style="white-space:nowrap">${s.locked ? '<span class="muted" style="font-size:12px" title="Systemdienst – wird von OPNsense selbst verwaltet">geschützt</span>'
          : `${s.running ? `<button class="btn sm" data-op="restart">${icon('refresh', 'sm')}Neu starten</button> <button class="btn sm danger" data-op="stop">${icon('stop', 'sm')}Stoppen</button>` : `<button class="btn sm primary" data-op="start">${icon('play', 'sm')}Starten</button>`}`}</td></tr>`).join('')
        || '<tr><td colspan="3"><div class="empty">Keine Dienste</div></td></tr>';
    }
    body.onclick = async (e) => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const s = list.find((x) => x.id === b.closest('tr').dataset.id);
      const op = b.dataset.op;
      if (op === 'stop' && !(await confirmDialog({ title: `${s.description} stoppen?`, text: 'Der Dienst bleibt aus, bis er wieder gestartet wird (oder die Firewall neu startet).', okText: 'Stoppen', danger: true }))) return;
      b.disabled = true;
      try {
        await call(d, 'opn.service', { id: s.id, op, label: s.description });
        toast(`${s.description}: ${{ start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet' }[op]}`);
      } catch (err) { toast(err.message, 'err'); }
      load();
    };
    load();
    return poll(load, 20000);
  }

  function opnFirewall(body, d) {
    let mode = 'log';
    let stop = null;
    body.innerHTML = `<div class="seg pve-hseg" data-mode><button data-m="log">${icon('activity', 'sm')} Live-Log</button><button data-m="rules">${icon('list', 'sm')} Regeln</button></div><div data-fw></div>`;
    const box = $('[data-fw]', body);
    function show(m) {
      mode = m;
      $$('[data-m]', body).forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      stop?.();
      stop = m === 'log' ? logView() : rulesView();
    }
    $('[data-mode]', body).onclick = (e) => { const b = e.target.closest('[data-m]'); if (b && b.dataset.m !== mode) show(b.dataset.m); };

    function logView() {
      const f = { act: 'all', q: '' };
      let paused = false;
      let rows = [];
      box.innerHTML = `<div class="toolbar">
          <div class="search" style="width:260px">${icon('search', 'sm')}<input class="input" placeholder="IP, Port, Schnittstelle ..." data-q></div>
          <div class="seg" data-act></div><span class="spacer grow"></span>
          <button class="btn" data-pause>${icon('pause', 'sm')}Anhalten</button></div>
        <div class="card table-wrap nd-log"><table class="tbl"><thead><tr><th>Zeit</th><th>Aktion</th><th>Schnittstelle</th><th>Protokoll</th><th>Quelle</th><th>Ziel</th><th>Regel</th></tr></thead><tbody data-rows><tr><td colspan="7"><div class="empty">Lade ...</div></td></tr></tbody></table></div>`;
      const ok = (r) => (f.act === 'all' || (f.act === 'block' ? r.action === 'block' : r.action !== 'block'))
        && (!f.q || [r.src, r.dst, r.srcPort, r.dstPort, r.iface, r.label, r.proto].join(' ').toLowerCase().includes(f.q.toLowerCase()));
      const hp = (h, p) => `${esc(h)}${p ? `<span class="muted">:${esc(p)}</span>` : ''}`;
      function draw() {
        $('[data-act]', box).innerHTML = [['all', 'Alle'], ['block', 'Blockiert'], ['pass', 'Erlaubt']].map(([k, l]) => `<button class="${f.act === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
        $('[data-rows]', box).innerHTML = rows.filter(ok).map((r) => `<tr><td class="num muted" style="white-space:nowrap">${esc(r.ts ? new Date(r.ts).toLocaleTimeString('de-DE') : '')}</td>
          <td>${r.action === 'block' ? '<span class="badge critical">blockiert</span>' : r.action === 'pass' ? '<span class="badge good">erlaubt</span>' : `<span class="badge">${esc(r.action)}</span>`}</td>
          <td>${esc(r.iface)}<span class="muted"> ${r.dir === 'out' ? '↑' : '↓'}</span></td><td class="muted">${esc(r.proto)}</td>
          <td class="mono">${hp(r.src, r.srcPort)}</td><td class="mono">${hp(r.dst, r.dstPort)}</td><td class="muted" style="font-size:12px">${esc(r.label)}</td></tr>`).join('')
          || '<tr><td colspan="7"><div class="empty">Keine Einträge</div></td></tr>';
      }
      async function load() {
        if (paused) return;
        try { rows = await call(d, 'opn.fwlog', { limit: 300 }); draw(); } catch (e) { $('[data-rows]', box).innerHTML = `<tr><td colspan="7">${errBox(e)}</td></tr>`; }
      }
      $('[data-q]', box).oninput = (e) => { f.q = e.target.value; draw(); };
      $('[data-act]', box).onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) { f.act = b.dataset.k; draw(); } };
      $('[data-pause]', box).onclick = (e) => {
        paused = !paused;
        e.currentTarget.innerHTML = paused ? `${icon('play', 'sm')}Fortsetzen` : `${icon('pause', 'sm')}Anhalten`;
        if (!paused) load();
      };
      load();
      return poll(load, 5000);
    }

    function rulesView() {
      box.innerHTML = '<div class="card empty">Lade ...</div>';
      let rules = [];
      async function load() {
        try { rules = await call(d, 'opn.rules'); } catch (e) { box.innerHTML = errBox(e); return; }
        box.innerHTML = `<div class="hint" style="margin-bottom:10px">Regeln aus <b>Firewall → Regeln</b>, die OPNsense über die API bereitstellt. Klassisch angelegte Regeln älterer Versionen fehlen hier je nach Version. Ein- und Ausschalten wirkt sofort.</div>
          <div class="card table-wrap"><table class="tbl"><thead><tr><th style="width:60px">Aktiv</th><th>#</th><th>Aktion</th><th>Schnittstelle</th><th>Protokoll</th><th>Quelle</th><th>Ziel</th><th>Port</th><th>Beschreibung</th></tr></thead><tbody>
          ${rules.sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9)).map((r) => `<tr data-uuid="${esc(r.uuid)}" class="${r.enabled ? '' : 'off'}">
            <td><label class="switch"><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''}><span></span></label></td>
            <td class="num muted">${r.seq ?? ''}</td>
            <td>${r.action === 'pass' ? '<span class="badge good">erlauben</span>' : r.action === 'block' ? '<span class="badge critical">blockieren</span>' : r.action === 'reject' ? '<span class="badge critical">ablehnen</span>' : `<span class="badge">${esc(r.action)}</span>`}</td>
            <td>${esc(r.iface) || dash}<span class="muted"> ${r.direction === 'out' ? '↑' : '↓'}</span></td><td class="muted">${esc([r.ipproto, r.proto].filter((x) => x && x !== 'any').join(' ')) || 'alle'}</td>
            <td class="mono">${esc(r.src) || 'alle'}</td><td class="mono">${esc(r.dst) || 'alle'}</td><td class="mono">${esc(r.dstPort) || dash}</td><td>${esc(r.descr)}</td></tr>`).join('')
            || '<tr><td colspan="9"><div class="empty">Keine Regeln über die API verfügbar</div></td></tr>'}
          </tbody></table></div>`;
      }
      box.onchange = async (e) => {
        const cb = e.target.closest('[data-toggle]');
        if (!cb) return;
        const r = rules.find((x) => x.uuid === cb.closest('tr').dataset.uuid);
        const on = cb.checked;
        if (!(await confirmDialog({ title: `Regel ${on ? 'aktivieren' : 'deaktivieren'}?`, text: `<b>${esc(r.descr || r.uuid)}</b> wird ${on ? 'aktiviert' : 'deaktiviert'} und die Firewall-Regeln sofort neu geladen.`, okText: on ? 'Aktivieren' : 'Deaktivieren', danger: !on }))) { cb.checked = !on; return; }
        cb.disabled = true;
        try { await call(d, 'opn.rule', { uuid: r.uuid, enabled: on, label: r.descr }); toast(`Regel ${on ? 'aktiviert' : 'deaktiviert'}`); } catch (err) { toast(err.message, 'err'); }
        load();
      };
      load();
      return () => { box.onchange = null; };
    }
    show('log');
    return () => stop?.();
  }

  function opnVpn(body, d) {
    async function load() {
      let r;
      try { r = await call(d, 'opn.vpn'); } catch (e) { body.innerHTML = errBox(e); return; }
      const fresh = (ts) => ts && Date.now() / 1000 - ts < 180;
      const peers = (r.wireguard || []).filter((x) => x.type === 'peer');
      const sect = (title, ic, inner) => `<div class="card table-wrap" style="margin-bottom:14px"><div class="card-head">${icon(ic, 'sm')}<h3>${title}</h3></div>${inner}</div>`;
      body.innerHTML = [
        sect('WireGuard', 'lock', r.wireguard == null ? '<div class="empty">WireGuard ist nicht eingerichtet oder über die API nicht verfügbar</div>'
          : `<table class="tbl"><thead><tr><th>Gegenstelle</th><th>Tunnel</th><th>Endpunkt</th><th>Erlaubte IPs</th><th>Letzter Kontakt</th><th class="r">Empfangen</th><th class="r">Gesendet</th></tr></thead><tbody>
            ${peers.map((p) => `<tr><td><div class="row" style="gap:8px"><span class="dot ${fresh(p.handshake) ? 'online' : 'offline'}"></span><b style="font-weight:500">${esc(p.name || '–')}</b></div></td><td class="muted">${esc(p.iface)}</td>
              <td class="mono">${esc(p.endpoint) || dash}</td><td class="mono muted" style="font-size:12px">${esc(p.allowed)}</td><td>${p.handshake ? fmtAgo(p.handshake * 1000) : 'noch nie'}</td>
              <td class="r num">${fmtBytes(p.rx)}</td><td class="r num">${fmtBytes(p.tx)}</td></tr>`).join('') || '<tr><td colspan="7"><div class="empty">Keine Gegenstellen</div></td></tr>'}
            </tbody></table>`),
        sect('OpenVPN', 'lock', r.openvpn == null ? '<div class="empty">OpenVPN ist nicht eingerichtet oder über die API nicht verfügbar</div>'
          : `<table class="tbl"><thead><tr><th>Verbindung</th><th>Benutzer</th><th>Von</th><th>VPN-Adresse</th><th>Seit</th><th class="r">Empfangen</th><th class="r">Gesendet</th></tr></thead><tbody>
            ${r.openvpn.map((s) => `<tr><td>${esc(s.name)} <span class="muted">${esc(s.type)}</span></td><td>${esc(s.user) || dash}</td><td class="mono">${esc(s.real) || dash}</td><td class="mono">${esc(s.virtual) || dash}</td><td class="muted">${esc(s.since) || dash}</td>
              <td class="r num">${fmtBytes(s.rx)}</td><td class="r num">${fmtBytes(s.tx)}</td></tr>`).join('') || '<tr><td colspan="7"><div class="empty">Keine aktiven Verbindungen</div></td></tr>'}
            </tbody></table>`),
        r.ipsec ? sect('IPsec', 'lock', `<table class="tbl"><thead><tr><th>Verbindung</th><th>Lokal</th><th>Gegenstelle</th><th>Status</th></tr></thead><tbody>
            ${r.ipsec.map((s) => `<tr><td>${esc(s.name)}</td><td class="mono">${esc(s.local)}</td><td class="mono">${esc(s.remote)}</td><td>${s.connected ? '<span class="badge good">verbunden</span>' : '<span class="badge">getrennt</span>'}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">Keine Verbindungen</div></td></tr>'}
            </tbody></table>`) : '',
      ].join('');
    }
    body.innerHTML = '<div class="card empty">Lade ...</div>';
    load();
    return poll(load, 15000);
  }

  function opnUpdates(body, d) {
    let busyTimer = null;
    async function load() {
      let f;
      try { f = await call(d, 'opn.firmware'); } catch (e) { body.innerHTML = errBox(e); return; }
      const unchecked = !f.updates && !f.lastCheck && !f.message;
      body.innerHTML = `
        <div class="card card-pad nd-fw" style="margin-bottom:14px">
          <div class="nd-fw-top">
            <div class="nd-fw-ic ${f.updates || unchecked ? 'upd' : 'ok'}">${icon(f.updates ? 'download' : unchecked ? 'refresh' : 'check')}</div>
            <div class="grow"><div class="nd-fw-title">${f.updates ? `${f.updates} Update${f.updates === 1 ? '' : 's'} verfügbar${f.latest && f.latest !== f.current ? ` – OPNsense ${esc(f.latest)}` : ''}` : unchecked ? 'Noch nicht geprüft' : 'Alles aktuell'}</div>
              <div class="muted">Installiert: ${esc(f.current || '–')}${f.lastCheck ? ` · zuletzt geprüft: ${esc(f.lastCheck)}` : ''}${f.needsReboot && f.updates ? ' · <span class="warn">Neustart nach dem Update nötig</span>' : ''}</div>
              ${f.message ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(f.message)}</div>` : ''}
              ${f.major ? `<div class="pve-note" style="margin:10px 0 0">${icon('alert', 'sm')}Neue Hauptversion${typeof f.major === 'string' ? ` ${esc(f.major)}` : ''} verfügbar – Hauptversionen bitte in der OPNsense-Weboberfläche einspielen.</div>` : ''}</div>
            <div class="btn-group">
              <button class="btn" data-check>${icon('refresh', 'sm')}Nach Updates suchen</button>
              <button class="btn primary" data-install ${f.updates ? '' : 'disabled'}>${icon('download', 'sm')}Updates installieren</button>
              <button class="btn danger" data-reboot>${icon('power', 'sm')}Neu starten</button>
            </div></div>
          <pre class="output" data-log hidden style="margin-top:14px;max-height:300px"></pre>
        </div>
        ${f.packages.length ? `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Paket</th><th>Installiert</th><th>Neu</th><th>Quelle</th></tr></thead><tbody>
          ${f.packages.map((p) => `<tr><td style="font-weight:500">${esc(p.name)}</td><td class="mono muted" style="font-size:12px">${esc(p.from)}</td><td class="mono" style="font-size:12px">${esc(p.to)}</td><td class="muted">${esc(p.repo || '')}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
      $('[data-check]', body).onclick = (e) => run(e.currentTarget, 'opn.firmware.check', 'Suche ...');
      $('[data-install]', body).onclick = async (e) => {
        if (!(await confirmDialog({ title: 'OPNsense-Updates installieren?', text: `${f.updates} Update(s) werden installiert.${f.needsReboot ? ' <b>Die Firewall startet danach neu</b> – das Netz ist für einige Minuten unterbrochen.' : ' Dienste können dabei kurz neu starten.'}`, okText: 'Installieren', danger: f.needsReboot }))) return;
        run(e.currentTarget, 'opn.firmware.update', 'Installiere ...');
      };
      $('[data-reboot]', body).onclick = () => rebootOpn(d);
    }
    // Vorgang starten und das Protokoll der OPNsense mitlesen, bis er fertig ist
    async function run(btn, action, text) {
      $$('.nd-fw .btn', body).forEach((b) => (b.disabled = true));
      btn.innerHTML = `${icon('refresh', 'sm spin')}${text}`;
      const log = $('[data-log]', body);
      log.hidden = false;
      log.textContent = 'Wird gestartet ...';
      try { await call(d, action); } catch (e) { toast(e.message, 'err'); return load(); }
      const started = Date.now();
      const tick = async () => {
        let p = null;
        try { p = await call(d, 'opn.firmware.progress'); } catch (e) { log.textContent += `\n(${e.message} – Firewall startet evtl. gerade neu)`; }
        if (p) { log.textContent = p.log || '...'; log.scrollTop = log.scrollHeight; }
        if (p?.status === 'reboot') { log.textContent += '\n\n*** Die Firewall startet neu – sie ist in einigen Minuten wieder erreichbar. ***'; return; }
        if ((p && p.status !== 'running') || Date.now() - started > 30 * 60e3) { toast(action === 'opn.firmware.check' ? 'Prüfung abgeschlossen' : 'Fertig'); return setTimeout(load, 1500); }
        busyTimer = setTimeout(tick, 2500);
      };
      busyTimer = setTimeout(tick, 1500);
    }
    body.innerHTML = '<div class="card empty">Lade ...</div>';
    load();
    return () => clearTimeout(busyTimer);
  }

  // =====================================================================
  // Switch / SNMP
  // =====================================================================
  function switchPorts(body, d) {
    const isSwitch = d.kind === 'switch';
    let data = null;
    body.innerHTML = `<div class="nd-cols"><div class="nd-main">
        ${isSwitch ? '<div class="card sw-front" data-front><div class="muted" style="padding:20px">Lade Ports ...</div></div>' : ''}
        <div class="card table-wrap"><table class="tbl sw-tbl"><thead><tr><th>Port</th><th>Status</th><th>VLAN</th><th>PoE</th><th class="r">↓ Empfangen</th><th class="r">↑ Gesendet</th><th>Verbunden mit</th><th class="px-acol"></th></tr></thead><tbody data-rows><tr><td colspan="8"><div class="empty">Lade ...</div></td></tr></tbody></table></div>
        <div data-other></div>
      </div><aside class="w nd-side" data-side></aside></div>`;
    const shown = () => (data?.ports || []).filter((p) => (isSwitch ? p.phys : true));

    const POE_TEXT = { delivering: 'liefert Strom', searching: 'kein Verbraucher', disabled: 'aus', fault: 'Fehler', otherFault: 'Fehler', test: 'Test' };
    const stateOf = (p) => (p.admin === 'down' ? 'disabled' : p.oper === 'up' ? (p.speed >= 1000 ? 'g1' : p.speed >= 100 ? 'm100' : 'm10') : 'down');
    const STATE_TEXT = { disabled: 'deaktiviert', g1: 'verbunden', m100: 'verbunden', m10: 'verbunden', down: 'keine Verbindung' };
    const vlanText = (p) => [p.untagged.length ? p.untagged.join(', ') : p.pvid ?? '', p.tagged.length ? `<span class="muted" title="tagged">+ ${p.tagged.join(', ')} T</span>` : ''].filter((x) => x !== '').join(' ') || dash;
    const neighbor = (p) => {
      if (p.lldp.length) return `${icon('network', 'sm')}<b style="font-weight:500">${esc(p.lldp[0].name || p.lldp[0].chassis)}</b>${p.lldp[0].port ? ` <span class="muted">· ${esc(p.lldp[0].portDesc || p.lldp[0].port)}</span>` : ''}`;
      if (!p.macs.length) return dash;
      const named = p.macs.filter((m) => m.name);
      const first = named[0] || p.macs[0];
      const label = first.agentId ? `<a class="link-client" href="#/client/${esc(first.agentId)}">${icon('monitor', 'sm')}${esc(first.name)}</a>` : esc(first.name || first.ip || first.mac);
      return `${label}${p.macCount > 1 ? ` <span class="muted">+ ${p.macCount - 1}</span>` : ''}`;
    };

    function front() {
      const box = $('[data-front]', body);
      if (!box || !data) return;
      const ports = shown();
      // Zwei Reihen wie am Gerät: ungerade oben, gerade unten. Die letzten (bis zu 4) Ports als eigener
      // Block, wenn sie schneller sind als alle übrigen – das sind meist die Uplink-/SFP-Ports.
      let k = 0;
      for (let n = Math.min(4, ports.length - 8); n >= 1 && !k; n--) {
        const restMax = Math.max(...ports.slice(0, -n).map((p) => p.speed || 0));
        if (ports.slice(-n).every((p) => (p.speed || 0) > restMax)) k = n;
      }
      const up = k ? ports.slice(-k) : [];
      const main = ports.slice(0, ports.length - k);
      const cell = (p) => {
        const st = stateOf(p);
        const lbl = /^\d+$/.test(p.name) ? p.name : p.ifIndex;
        return `<button class="sp ${st} ${sel === p.ifIndex ? 'sel' : ''} ${p.poe?.status === 'delivering' ? 'poe' : ''}" data-if="${p.ifIndex}" title="${esc(`${portLabel(p)}${p.alias ? ` – ${p.alias}` : ''}: ${STATE_TEXT[st]}${p.oper === 'up' ? ` (${speedText(p.speed)}bit/s)` : ''}${p.poe?.status === 'delivering' ? ' · PoE' : ''}`)}">
          <span class="sp-num">${esc(lbl)}</span>${p.poe?.status === 'delivering' ? `<span class="sp-poe">${icon('zap')}</span>` : ''}${p.lldp.length ? '<span class="sp-up" title="Nachbar per LLDP erkannt"></span>' : ''}</button>`;
      };
      const block = (list) => {
        const cols = [];
        for (let i = 0; i < list.length; i += 2) cols.push(list.slice(i, i + 2));
        const groups = [];
        for (let i = 0; i < cols.length; i += 6) groups.push(cols.slice(i, i + 6));
        return groups.map((g) => `<div class="sp-group">${g.map((c) => `<div class="sp-col">${c.map(cell).join('')}</div>`).join('')}</div>`).join('');
      };
      const s = { g1: 0, m100: 0, m10: 0, down: 0, disabled: 0 };
      for (const p of ports) s[stateOf(p)]++;
      box.innerHTML = `<div class="sw-top"><span class="sw-name">${icon('ethernet', 'sm')}${esc(d.info?.model || d.name)}</span><span class="spacer grow"></span>
          ${data.poe ? `<span class="sw-poe" title="PoE-Budget">${icon('zap', 'sm')}${data.poe.used ?? '?'} / ${data.poe.power} W</span>` : ''}</div>
        <div class="sw-panel">${block(main)}${up.length ? `<div class="sp-sfp">${block(up)}</div>` : ''}</div>
        <div class="sw-legend"><span><i class="sp-l g1"></i>1 Gbit/s+ <b>${s.g1}</b></span><span><i class="sp-l m100"></i>100 Mbit/s <b>${s.m100}</b></span>${s.m10 ? `<span><i class="sp-l m10"></i>10 Mbit/s <b>${s.m10}</b></span>` : ''}<span><i class="sp-l down"></i>frei <b>${s.down}</b></span>${s.disabled ? `<span><i class="sp-l disabled"></i>deaktiviert <b>${s.disabled}</b></span>` : ''}<span><span class="sp-poe-l">${icon('zap')}</span>PoE</span></div>`;
    }

    let rowsHtml = '';
    function table() {
      const html = shown().map((p) => {
        const st = stateOf(p);
        return `<tr class="px-row ${sel === p.ifIndex ? 'sel' : ''} ${st === 'down' || st === 'disabled' ? 'off' : ''}" data-if="${p.ifIndex}">
          <td><div style="font-weight:500">${esc(portLabel(p))}${p.probe ? ` <span class="badge accent" title="Hier hängt der Abfrage-Client">${icon('radar')}Abfrage</span>` : ''}${p.uplink && p.lldp.length ? ' <span class="badge">Uplink</span>' : ''}</div>${p.alias ? `<div class="muted" style="font-size:12px">${esc(p.alias)}</div>` : ''}</td>
          <td><span class="sp-dot ${st}"></span>${st === 'disabled' ? 'deaktiviert' : p.oper === 'up' ? `${speedText(p.speed)}bit/s` : 'frei'}${(p.inErr || 0) + (p.outErr || 0) > 0 ? ` <span class="warn" title="Fehler empfangen/gesendet">⚠ ${(p.inErr || 0) + (p.outErr || 0)}</span>` : ''}</td>
          <td class="num">${vlanText(p)}</td>
          <td>${p.poe ? (p.poe.status === 'delivering' ? `<span class="poe-on">${icon('zap', 'sm')}an</span>` : `<span class="muted">${esc(POE_TEXT[p.poe.status] || p.poe.status)}</span>`) : dash}</td>
          <td class="r num">${p.oper === 'up' && p.rx != null ? fmtRate(p.rx) : dash}</td><td class="r num">${p.oper === 'up' && p.tx != null ? fmtRate(p.tx) : dash}</td>
          <td class="sw-nb">${neighbor(p)}</td>
          <td class="px-acts"><div><button class="btn ghost icon-only" data-pmenu title="Aktionen">${icon('more', 'sm')}</button></div></td></tr>`;
      }).join('') || '<tr><td colspan="8"><div class="empty">Keine Ports gefunden</div></td></tr>';
      if (html !== rowsHtml) $('[data-rows]', body).innerHTML = rowsHtml = html;
      const other = (data?.ports || []).filter((p) => isSwitch && !p.phys);
      const ob = $('[data-other]', body);
      if (ob && other.length && !ob.innerHTML) {
        ob.innerHTML = `<details class="nd-more"><summary>Weitere Schnittstellen (${other.length}) – VLAN-Schnittstellen, Trunks, CPU</summary><div class="card table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Typ</th><th>Status</th><th>MAC</th></tr></thead><tbody>
          ${other.map((p) => `<tr><td>${esc(p.name)}${p.alias ? ` <span class="muted">${esc(p.alias)}</span>` : ''}</td><td class="muted">${p.type}</td><td>${p.oper === 'up' ? '<span class="badge good">up</span>' : `<span class="badge">${esc(p.oper)}</span>`}</td><td class="mono muted">${esc(p.mac)}</td></tr>`).join('')}
        </tbody></table></div></details>`;
      }
    }

    function side() {
      const box = $('[data-side]', body);
      const p = shown().find((x) => x.ifIndex === sel);
      if (!data) { box.innerHTML = ''; return; }
      if (!p) {
        const ports = shown();
        const act = ports.filter((x) => x.oper === 'up');
        const rx = act.reduce((s, x) => s + (x.rx || 0), 0), tx = act.reduce((s, x) => s + (x.tx || 0), 0);
        const poeOn = ports.filter((x) => x.poe?.status === 'delivering').length;
        box.innerHTML = `<div class="wh">${isSwitch ? 'Switch' : 'Schnittstellen'}</div><div class="kv gp-kv">
          <div class="k">Ports</div><div class="v">${act.length} von ${ports.length} verbunden</div>
          <div class="k">Durchsatz</div><div class="v">↓ ${fmtRate(rx)} · ↑ ${fmtRate(tx)}</div>
          ${data.poe ? `<div class="k">PoE</div><div class="v">${miniBar(data.poe.used != null ? (100 * data.poe.used) / data.poe.power : null, '', 90)}<div class="sub">${data.poe.used ?? '?'} von ${data.poe.power} W · ${poeOn} Verbraucher</div></div>` : ''}
          <div class="k">VLANs</div><div class="v">${data.vlans.length || dash}</div>
          <div class="k">Läuft seit</div><div class="v">${data.uptime != null ? fmtDuration(data.uptime) : '–'}</div>
          <div class="k">Ändern</div><div class="v">${data.write ? '<span class="badge good">Schreibzugriff</span>' : '<span class="muted">nur lesen – Schreib-Community fehlt</span>'}</div>
          <div class="k">Stand</div><div class="v">${new Date(Math.max(data.liveTs || 0, data.ts)).toLocaleTimeString('de-DE')}${data.cached ? ' <span class="muted">(gespeichert, wird aktualisiert)</span>' : ''}</div>
        </div><div class="nd-side-hint">${icon('chevron', 'sm')}Port anklicken für Details und Aktionen</div>`;
        return;
      }
      const st = stateOf(p);
      box.innerHTML = `<div class="wh row" style="gap:8px"><span class="sp-dot ${st}"></span>${esc(portLabel(p))}<span class="spacer grow"></span><button class="btn ghost sm icon-only" data-unsel title="Schließen">${icon('x', 'sm')}</button></div>
        <div class="kv gp-kv">
          <div class="k">Beschreibung</div><div class="v">${esc(p.alias) || '<span class="muted">keine</span>'} ${data.write ? `<button class="btn ghost sm icon-only" data-alias title="Beschreibung ändern">${icon('edit', 'sm')}</button>` : ''}</div>
          <div class="k">Status</div><div class="v">${STATE_TEXT[st]}${p.oper === 'up' ? ` · ${speedText(p.speed)}bit/s` : ''}${p.lastChange != null && data.uptime != null ? `<div class="sub">${p.oper === 'up' ? 'verbunden' : 'getrennt'} seit ${fmtDuration(Math.max(0, data.uptime - p.lastChange / 100))}</div>` : ''}</div>
          <div class="k">VLAN</div><div class="v">${p.untagged.length ? `untagged ${p.untagged.join(', ')}` : p.pvid != null ? `PVID ${p.pvid}` : '–'}${p.tagged.length ? `<div class="sub">tagged ${p.tagged.join(', ')}</div>` : ''}</div>
          ${p.poe ? `<div class="k">PoE</div><div class="v">${p.poe.enabled ? (p.poe.status === 'delivering' ? `<span class="poe-on">${icon('zap', 'sm')}liefert Strom</span>` : esc(POE_TEXT[p.poe.status] || p.poe.status)) : 'ausgeschaltet'}</div>` : ''}
          <div class="k">Durchsatz</div><div class="v">${p.oper === 'up' ? `↓ ${fmtRate(p.rx)} · ↑ ${fmtRate(p.tx)}` : '–'}${p.rxTotal != null ? `<div class="sub">gesamt ↓ ${fmtBytes(p.rxTotal)} · ↑ ${fmtBytes(p.txTotal)}</div>` : ''}</div>
          <div class="k">Fehler</div><div class="v">${(p.inErr || 0) + (p.outErr || 0) ? `<span class="warn">${p.inErr || 0} empfangen · ${p.outErr || 0} gesendet</span>` : 'keine'}</div>
          ${p.lldp.map((l) => `<div class="k">Nachbar (LLDP)</div><div class="v"><b style="font-weight:500">${esc(l.name || l.chassis)}</b><div class="sub">${esc([l.portDesc, l.port].filter(Boolean).join(' · '))}</div></div>`).join('')}
        </div>
        ${data.write ? `<div class="nd-pacts">
          ${p.admin === 'down' ? `<button class="btn sm" data-pact="enable">${icon('play', 'sm')}Aktivieren</button>` : `<button class="btn sm danger" data-pact="disable">${icon('stop', 'sm')}Deaktivieren</button>`}
          ${p.poe ? `<button class="btn sm" data-pact="poe-cycle" ${p.poe.enabled ? '' : 'disabled'}>${icon('refresh', 'sm')}PoE neu starten</button>` : ''}</div>` : ''}
        <div class="wh" style="border-top:1px solid var(--border)">Geräte an diesem Port${p.macCount ? ` <span class="muted">(${p.macCount})</span>` : ''}</div>
        <div class="nd-macs">${p.macs.map((m) => `<div class="nd-mac"><div class="grow">${m.agentId ? `<a class="link-client" href="#/client/${esc(m.agentId)}">${icon('monitor', 'sm')}${esc(m.name)}</a>` : `<span>${esc(m.name || '') || '<span class="muted">unbekannt</span>'}</span>`}
            <div class="muted mono" style="font-size:11.5px">${esc(m.mac)}${m.ip ? ` · ${esc(m.ip)}` : ''}${m.vendor ? ` · ${esc(m.vendor)}` : ''}</div></div>${m.vlan ? `<span class="badge" title="VLAN">${m.vlan}</span>` : ''}</div>`).join('')
          || `<div class="muted" style="font-size:12.5px">${p.oper === 'up' ? 'Keine MAC-Adressen gelernt' : 'Nichts angeschlossen'}</div>`}${p.macCount > p.macs.length ? `<div class="muted" style="font-size:12px">+ ${p.macCount - p.macs.length} weitere</div>` : ''}</div>`;
    }

    const drawAll = () => { front(); table(); side(); };
    const select = (ifIndex) => {
      sel = sel === ifIndex ? null : ifIndex;
      history.replaceState(null, '', `#/netdev/${id}/ports${sel != null ? `/${sel}` : ''}`);
      drawAll();
    };

    async function portAction(p, k) {
      const name = `${portLabel(p)}${p.alias ? ` (${p.alias})` : ''}`;
      const risky = p.probe || (p.uplink && p.lldp.length) ? `<br><br><b class="warn">Achtung: Über diesen Port ${p.probe ? 'ist der Abfrage-Client' : 'läuft der Uplink'} angebunden – danach ist der Switch für BOLZO RMM womöglich nicht mehr erreichbar und der Port muss vor Ort wieder eingeschaltet werden.</b>` : '';
      try {
        if (k === 'alias') {
          const alias = await promptDialog({ title: `${portLabel(p)}: Beschreibung`, label: 'Beschreibung (am Switch gespeichert)', value: p.alias || '' });
          if (alias === null) return;
          await call(d, 'snmp.alias', { ifIndex: p.ifIndex, alias });
          toast('Beschreibung gespeichert');
        } else if (k === 'disable' || k === 'enable') {
          const off = k === 'disable';
          if (!(await confirmDialog({ title: `${name} ${off ? 'deaktivieren' : 'aktivieren'}?`, text: off ? `Angeschlossene Geräte verlieren sofort die Verbindung.${risky}` : 'Der Port wird wieder eingeschaltet.', okText: off ? 'Deaktivieren' : 'Aktivieren', danger: off }))) return;
          await call(d, 'snmp.port', { ifIndex: p.ifIndex, up: !off });
          toast(`${name} ${off ? 'deaktiviert' : 'aktiviert'}`);
        } else if (k.startsWith('poe-')) {
          const op = k.slice(4);
          const txt = { cycle: 'neu starten', on: 'einschalten', off: 'ausschalten' }[op];
          if (op !== 'on' && !(await confirmDialog({ title: `PoE an ${name} ${txt}?`, text: op === 'cycle' ? `Das Gerät an diesem Port (z.B. Kamera, Access Point) verliert kurz den Strom und startet neu.${risky}` : `Das Gerät an diesem Port bekommt keinen Strom mehr.${risky}`, okText: `PoE ${txt}`, danger: true }))) return;
          await call(d, 'snmp.poe', { ifIndex: p.ifIndex, group: p.poe.group, port: p.poe.port, op });
          toast(op === 'cycle' ? 'PoE neu gestartet' : `PoE ${op === 'on' ? 'eingeschaltet' : 'ausgeschaltet'}`);
        }
      } catch (e) { return toast(e.message, 'err'); }
      setTimeout(() => loadFull(), 800);
    }
    function portMenu(anchor, p) {
      if (!data.write) {
        return popupMenu(anchor, [{ k: 'sel', label: 'Details anzeigen', icon: 'list' }, { note: 'Zum Schalten in „Bearbeiten“ eine Schreib-Community eintragen' }], () => select(p.ifIndex));
      }
      popupMenu(anchor, [
        { k: 'sel', label: 'Details anzeigen', icon: 'list' },
        { k: 'alias', label: 'Beschreibung ändern', icon: 'edit' },
        ...(p.poe ? [{ sep: true }, { k: 'poe-cycle', label: 'PoE neu starten', icon: 'refresh', disabled: !p.poe.enabled }, p.poe.enabled ? { k: 'poe-off', label: 'PoE ausschalten', icon: 'zap', danger: true } : { k: 'poe-on', label: 'PoE einschalten', icon: 'zap' }] : []),
        { sep: true },
        p.admin === 'down' ? { k: 'enable', label: 'Port aktivieren', icon: 'play' } : { k: 'disable', label: 'Port deaktivieren', icon: 'stop', danger: true },
      ], (k) => (k === 'sel' ? select(p.ifIndex) : portAction(p, k)));
    }

    body.addEventListener('click', (e) => {
      const pm = e.target.closest('[data-pmenu]');
      const p = (x) => shown().find((q) => q.ifIndex === Number(x));
      if (pm) return portMenu(pm, p(pm.closest('[data-if]').dataset.if));
      if (e.target.closest('[data-unsel]')) return select(sel);
      if (e.target.closest('[data-alias]')) return portAction(p(sel), 'alias');
      const a = e.target.closest('[data-pact]');
      if (a) {
        const k = a.dataset.pact;
        return portAction(p(sel), k === 'disable' ? 'disable' : k === 'enable' ? 'enable' : 'poe-cycle');
      }
      if (e.target.closest('a')) return;
      const c = e.target.closest('[data-if]');
      if (c) select(Number(c.dataset.if));
    });

    // maxAge: gespeicherten Stand vom Server nehmen, wenn er nicht älter ist (zeigt die Seite sofort)
    async function loadFull(maxAge = 0) {
      const slow = setTimeout(() => {
        const fr = $('[data-front] .muted', body);
        if (fr && !data) fr.textContent = 'Der Switch antwortet langsam – Ports werden geladen ...';
      }, 3000);
      try {
        data = await call(d, 'snmp.ports', maxAge ? { maxAge } : {});
        drawAll();
      } catch (e) {
        if (!data) {
          $('[data-rows]', body).innerHTML = `<tr><td colspan="8">${errBox(e)}</td></tr>`;
          const fr = $('[data-front]', body);
          if (fr) fr.remove();
        } else toast(e.message, 'err');
      } finally {
        clearTimeout(slow);
      }
    }
    // Zwischendurch nur Zustand und Zähler. Der Abstand richtet sich nach dem Switch: wer für die
    // Antwort lange braucht, wird seltener gefragt (mindestens 10 s, sonst das Vierfache der Antwortzeit).
    let liveTimer = null;
    let stopped = false;
    async function loadLive() {
      const t0 = Date.now();
      if (data && !document.hidden) {
        try {
          const r = await call(d, 'snmp.ports', { live: true });
          const m = new Map(r.ports.map((x) => [x.ifIndex, x]));
          data.ports = data.ports.map((p) => ({ ...p, ...(m.get(p.ifIndex) || {}) }));
          data.liveTs = r.ts;
          drawAll();
        } catch {}
      }
      if (!stopped) liveTimer = setTimeout(loadLive, Math.max(10000, 4 * (Date.now() - t0)));
    }
    loadFull(10 * 60e3).then(() => {
      if (stopped) return;
      // Gespeicherter Stand: gleich frische Zustände holen, ganz neu laden, wenn er älter als 1 min ist
      if (data?.cached) {
        loadLive();
        if (Date.now() - data.ts > 60e3) loadFull();
      } else liveTimer = setTimeout(loadLive, 10000);
    });
    const s2 = poll(() => loadFull(), 60000);
    return () => { stopped = true; clearTimeout(liveTimer); s2(); };
  }

  function switchMacs(body, d) {
    let rows = null;
    let q = '';
    body.innerHTML = `<div class="toolbar"><div class="search" style="width:280px">${icon('search', 'sm')}<input class="input" placeholder="Name, IP, MAC, Port ..." data-q></div><span class="spacer grow"></span><span class="muted" style="font-size:12.5px" data-count></span>
        <button class="btn ghost icon-only" data-reload title="Aktualisieren">${icon('refresh', 'sm')}</button></div>
      <div class="card table-wrap"><table class="tbl"><thead><tr><th>Gerät</th><th>IP-Adresse</th><th>MAC-Adresse</th><th>VLAN</th><th>Port</th></tr></thead><tbody data-rows><tr><td colspan="5"><div class="empty">Lade ...</div></td></tr></tbody></table></div>
      <div class="hint" style="margin-top:8px">Aus der MAC-Tabelle des Switches. Namen und IP-Adressen kommen von BOLZO-Clients und – falls eingerichtet – aus DHCP/ARP der OPNsense. Ports mit vielen Adressen (Uplinks) sind ausgeblendet.</div>`;
    function draw() {
      if (!rows) return;
      const s = q.trim().toLowerCase();
      const list = rows.filter((r) => !s || [r.name, r.ip, r.mac, r.port, r.vendor].join(' ').toLowerCase().includes(s));
      $('[data-count]', body).textContent = `${rows.length} Geräte`;
      $('[data-rows]', body).innerHTML = list.map((r) => `<tr><td>${r.agentId ? `<a class="link-client" href="#/client/${esc(r.agentId)}">${icon('monitor', 'sm')}${esc(r.name)}</a>` : esc(r.name || '') || '<span class="muted">unbekannt</span>'}${r.probe ? ' <span class="badge accent">Abfrage-Client</span>' : ''}</td>
        <td class="mono">${esc(r.ip || '') || dash}</td><td><div class="mono" style="font-size:12px">${esc(r.mac)}</div>${r.vendor ? `<div class="muted" style="font-size:11.5px">${esc(r.vendor)}</div>` : ''}</td>
        <td class="num">${r.vlan ?? dash}</td><td><a href="#/netdev/${esc(id)}/ports/${r.ifIndex}" class="link-client">${icon('ethernet', 'sm')}${esc(r.port)}</a></td></tr>`).join('')
        || `<tr><td colspan="5"><div class="empty">${rows.length ? 'Nichts passt zur Suche' : 'Keine Einträge in der MAC-Tabelle'}</div></td></tr>`;
    }
    async function load() {
      try {
        const r = await call(d, 'snmp.ports', { maxAge: 60e3 });
        rows = r.ports.filter((p) => !p.uplink || p.probe).flatMap((p) => p.macs.map((m) => ({ ...m, port: portLabel(p), ifIndex: p.ifIndex })))
          .sort((a, b) => (a.ip ? 0 : 1) - (b.ip ? 0 : 1) || ipKey(a.ip).localeCompare(ipKey(b.ip)) || a.mac.localeCompare(b.mac));
        draw();
      } catch (e) { $('[data-rows]', body).innerHTML = `<tr><td colspan="5">${errBox(e)}</td></tr>`; }
    }
    $('[data-q]', body).oninput = (e) => { q = e.target.value; draw(); };
    $('[data-reload]', body).onclick = load;
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#/netdev/"]');
      if (!a) return;
      e.preventDefault();
      sel = Number(a.getAttribute('href').split('/').pop());
      showTab('ports');
    });
    load();
    return poll(load, 60000);
  }

  function switchVlans(body, d) {
    body.innerHTML = '<div class="card empty">Lade ...</div>';
    call(d, 'snmp.ports', { maxAge: 5 * 60e3 }).then((r) => {
      const ports = r.ports.filter((p) => p.phys || d.kind !== 'switch');
      const vids = [...new Set([...r.vlans.map((v) => v.vid), ...ports.flatMap((p) => [...p.untagged, ...p.tagged])])].sort((a, b) => a - b);
      const nm = (vid) => r.vlans.find((v) => v.vid === vid)?.name || '';
      const list = (arr) => arr.map((p) => `<span class="vl-port" title="${esc(p.alias || '')}">${esc(p.name)}</span>`).join('') || dash;
      body.innerHTML = vids.length ? `<div class="card table-wrap"><table class="tbl"><thead><tr><th style="width:80px">VLAN</th><th>Name</th><th>Untagged (Zugang)</th><th>Tagged (Trunk)</th></tr></thead><tbody>
        ${vids.map((vid) => `<tr><td class="num" style="font-weight:600">${vid}</td><td>${esc(nm(vid)) || dash}</td>
          <td><div class="vl-ports">${list(ports.filter((p) => p.untagged.includes(vid)))}</div></td><td><div class="vl-ports tagged">${list(ports.filter((p) => p.tagged.includes(vid)))}</div></td></tr>`).join('')}
      </tbody></table></div><div class="hint" style="margin-top:8px">Aus der Q-BRIDGE-MIB des Switches. VLANs ändern geht in der Weboberfläche des Switches.</div>`
        : `<div class="card empty">${icon('network')}<h3>Keine VLAN-Daten</h3><div>Der Switch liefert per SNMP keine VLAN-Tabelle (Q-BRIDGE-MIB).</div></div>`;
    }).catch((e) => (body.innerHTML = errBox(e)));
  }

  // Übersicht für Geräte ohne SNMP bzw. "Info" bei Switches
  function infoView(body, d) {
    body.innerHTML = `<div class="nd-cols"><div class="nd-main" data-main></div><aside class="w nd-side"><div class="wh">Antwortzeit</div><div class="nd-lat" data-lat><div class="muted">Lade ...</div></div></aside></div>`;
    const main = $('[data-main]', body);
    const kv = (rows) => `<div class="card card-pad"><div class="kv">${rows.filter(([, v]) => v).map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div></div>`;
    if (d.snmp) {
      main.innerHTML = '<div class="card empty">Lade ...</div>';
      call(d, 'snmp.info').then((i) => {
        main.innerHTML = kv([
          ['Name', esc(i.name)], ['Modell', esc(i.model)], ['Firmware', esc(i.firmware)], ['Seriennummer', i.serial ? `<span class="mono">${esc(i.serial)}</span>` : ''],
          ['Beschreibung', esc(i.descr)], ['Standort', esc(i.location)], ['Kontakt', esc(i.contact)], ['Läuft seit', i.uptime != null ? fmtDuration(i.uptime) : ''],
          ['Adresse', `<span class="mono">${esc(d.host)}</span>`], ['SNMP', `v${esc(d.snmp.version)} · Port ${d.snmp.port}${d.snmp.write ? ' · mit Schreibzugriff' : ''}`],
        ]);
      }).catch((e) => (main.innerHTML = errBox(e)));
    } else {
      const st = d.state === 'online' ? 'antwortet' : d.state === 'offline' ? 'antwortet nicht' : 'wird geprüft';
      main.innerHTML = `${kv([['Adresse', `<span class="mono">${esc(d.host)}</span>`], ['Status', `${stateBadge(d)} <span class="muted">${st}</span>`], ['Antwortzeit', d.ms != null ? ms(d.ms) : ''], ['Abfrage-Client', esc(d.probeName)], ['Weboberfläche', `<span class="mono">${esc(d.webUrl)}</span>`]])}
        <div class="hint" style="margin-top:10px">Dieses Gerät wird nur per Ping überwacht. Kann es SNMP, lassen sich in „Bearbeiten“ auch Schnittstellen und Durchsatz anzeigen.</div>`;
    }
    const loadLat = () => api.get(`/api/net/${id}/latency`).then((p) => { const b = $('[data-lat]', body); if (b) b.innerHTML = latencyHtml(p); }).catch(() => {});
    loadLat();
    return poll(loadLat, 30000);
  }

  function notesView(body, d) {
    body.innerHTML = `<div class="card"><div class="card-head">${icon('note', 'sm')}<h3>Notizen</h3><span class="spacer"></span><span class="muted" style="font-size:12px" data-state></span></div>
      <div class="card-pad"><textarea class="textarea" style="min-height:360px" placeholder="Standort, Zugangsdaten-Hinweise, Verkabelung, Besonderheiten ... (werden auf dem Server gespeichert)" data-notes></textarea></div></div>`;
    const ta = $('[data-notes]', body);
    ta.value = d.notes || '';
    let timer;
    const save = async () => {
      timer = null;
      try { await api.patch(`/api/net/${id}`, { notes: ta.value }); $('[data-state]', body).textContent = 'Gespeichert'; } catch (e) { toast(e.message, 'err'); }
    };
    ta.oninput = () => {
      $('[data-state]', body).textContent = 'Ungespeichert ...';
      clearTimeout(timer);
      timer = setTimeout(save, 800);
    };
    return () => { if (timer) { clearTimeout(timer); save(); } };
  }
}

// ---------- Aktionen, die auch die Kopfzeile braucht ----------
async function webMenu(anchor, d) {
  const tunnel = !!window.rmmDesk?.netWeb;
  popupMenu(anchor, [
    { k: 'direct', label: 'Direkt öffnen', icon: 'external', sub: d.webUrl.replace(/^https?:\/\//, '') },
    { k: 'tunnel', label: 'Über den Abfrage-Client öffnen', icon: 'radar', disabled: !tunnel || !d.probeOnline, sub: d.probeName },
    { note: tunnel ? 'Direkt geht nur im selben Netz oder per VPN. Über den Abfrage-Client klappt es von überall.' : 'Der Weg über den Abfrage-Client geht nur in der Desktop-App.' },
  ], async (k) => {
    if (k === 'direct') return window.open(d.webUrl, '_blank');
    try {
      const t = await api.post(`/api/net/${d.id}/web-open`);
      const r = await window.rmmDesk.netWeb({ server: api.server, token: api.token, id: d.id, scheme: t.scheme, path: t.path });
      toast(t.scheme === 'https' ? 'Geöffnet – der Browser warnt beim Zertifikat, weil die Adresse 127.0.0.1 ist; das ist hier erwartbar.' : `Geöffnet: ${r.url}`);
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function backup(d) {
  try {
    toast('Sicherung wird geladen ...');
    const r = await api.netCall(d.id, 'opn.backup');
    const bin = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bin], { type: 'application/xml' }));
    a.download = r.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { toast(e.message, 'err'); }
}

async function rebootOpn(d) {
  if (!(await confirmDialog({ title: `${d.name} neu starten?`, text: 'Die Firewall startet neu – Internet, DHCP, DNS und VPN sind für einige Minuten unterbrochen.', okText: 'Neu starten', danger: true }))) return;
  try { await api.netCall(d.id, 'opn.reboot'); toast('Firewall startet neu'); } catch (e) { toast(e.message, 'err'); }
}
