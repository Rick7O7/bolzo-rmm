// Dashboard im Stil "C × UniFi": Widgets oben, Auslastung + Client-Tabelle links, Hinweise + Ereignisse rechts
import { api } from '../api.js';
import { icon, esc, $, $$, memPct, worstDisk, fmtDuration, fmtAgo, primaryIp, throttle, isPveHost, osShort, clientIcon, pveLine } from '../ui.js';
import { lineChart } from '../charts.js';
import { addClientDialog } from './settings.js';
import { AUDIT_CATS } from './history.js';
import { fetchGuests, poll } from '../proxmox.js';

const EV_ICON = { auth: 'key', client: 'monitor', power: 'power', action: 'refresh', script: 'code', shell: 'terminal', settings: 'sliders', system: 'server', connection: 'network' };

function miniLine(points, key, color) {
  if (!points || points.length < 2) return '<div class="w-mini"></div>';
  const n = points.length;
  const pts = points.map((p, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(36 - (Math.min(100, p[key]) / 100) * 34).toFixed(2)}`).join(' ');
  return `<svg class="w-mini" viewBox="0 0 100 36" preserveAspectRatio="none"><polygon points="0,36 ${pts} 100,36" fill="${color}" opacity="0.08"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function bar(v, threshold = 90) {
  if (v == null) return '<span class="muted">–</span>';
  return `<span class="tbar"><span class="tr"><i class="${v >= threshold ? 'hi' : ''}" style="width:${Math.min(100, v)}%"></i></span><span class="v">${Math.round(v)}%</span></span>`;
}

const stateOf = (a) => (!a.online ? ['offline', 'Offline'] : a.alerts?.length ? ['alert', 'Warnung'] : ['online', 'Online']);

export function renderDashboard(root, { go }) {
  root.innerHTML = `
    <div class="page-head">
      <h1>Übersicht</h1><span class="sub" data-sub></span>
      <span class="spacer"></span>
      <button class="btn primary" data-add>${icon('plus', 'sm')}Client hinzufügen</button>
    </div>
    <div class="w-row" data-tiles></div>
    <div class="dash-main">
      <div class="dash-col">
        <div class="w"><div class="wh">Auslastung aller Clients · letzte Stunde<span class="grow"></span></div><div data-chart></div></div>
        <div class="w w-flush"><div class="wh">Clients<span class="grow"></span><a href="#/clients">Alle anzeigen</a></div>
          <div class="table-wrap"><table class="tbl dtbl"><thead><tr><th>Name</th><th>Zustand</th><th>CPU</th><th>RAM</th><th>Disk</th><th>IP-Adresse</th><th>Laufzeit</th></tr></thead><tbody data-rows></tbody></table></div>
        </div>
      </div>
      <div class="dash-col">
        <div class="w" data-attn-box><div class="wh">Benötigt Aufmerksamkeit<span class="grow"></span><span class="w-count" data-attn-count></span></div><div data-attn></div></div>
        <div class="w"><div class="wh">Ereignisse<span class="grow"></span><a href="#/history">Verlauf</a></div><div data-events><div class="muted">Lade ...</div></div></div>
      </div>
    </div>`;
  $('[data-add]', root).onclick = addClientDialog;

  let hist = [];
  let pveStats = null;
  const chart = lineChart($('[data-chart]', root), { height: 170 });

  function tiles() {
    const all = [...api.agents.values()];
    const online = all.filter((a) => a.online);
    const warn = online.filter((a) => a.alerts?.length);
    const ok = online.length - warn.length;
    const off = all.length - online.length;
    const avg = (f) => (online.length ? online.reduce((s, a) => s + (f(a) || 0), 0) / online.length : null);
    const peak = (f) => online.reduce((best, a) => ((f(a) || 0) > (f(best) || 0) ? a : best), online[0]);
    const cpuAvg = avg((a) => a.metrics?.cpu);
    const memAvg = avg((a) => memPct(a.metrics));
    const pc = online.length && peak((a) => a.metrics?.cpu);
    const pm = online.length && peak((a) => memPct(a.metrics));
    const hosts = all.filter(isPveHost);
    $('[data-sub]', root).textContent = `${all.length} Clients · ${online.length} online`;
    const fourth = hosts.length && pveStats
      ? `<div class="w"><div class="wh">Proxmox<span class="grow"></span><a href="#/proxmox">Öffnen</a></div>
          <div class="big">${pveStats.running}<small>von ${pveStats.total} Gästen laufen</small></div>
          <div class="w-sub">${esc(hosts.map((h) => h.name).join(', '))}${pveStats.total - pveStats.running ? ` · ${pveStats.total - pveStats.running} aus` : ''}</div>
          <div class="stackbar"><i style="flex:${pveStats.running};background:var(--accent)"></i><i style="flex:${pveStats.total - pveStats.running};background:#4a4e57"></i></div></div>`
      : `<div class="w"><div class="wh">Warnungen</div><div class="big">${warn.reduce((s, a) => s + a.alerts.length, 0)}</div><div class="w-sub">auf ${warn.length} Client${warn.length === 1 ? '' : 's'}</div></div>`;
    $('[data-tiles]', root).innerHTML = `
      <div class="w w-wide"><div class="wh">Zustand der Clients<span class="grow"></span><a href="#/clients">Alle anzeigen</a></div>
        <div class="big">${online.length}<small>von ${all.length} online</small></div>
        <div class="stackbar">${ok ? `<i style="flex:${ok};background:var(--good)"></i>` : ''}${warn.length ? `<i style="flex:${warn.length};background:var(--warning)"></i>` : ''}${off ? `<i style="flex:${off};background:#4a4e57"></i>` : ''}</div>
        <div class="legend"><span><span class="dot online"></span>In Ordnung <b>${ok}</b></span><span><span class="dot alert"></span>Warnung <b>${warn.length}</b></span><span><span class="dot offline"></span>Offline <b>${off}</b></span></div></div>
      <div class="w"><div class="wh">Ø CPU-Last</div><div class="big">${cpuAvg == null ? '–' : Math.round(cpuAvg)}<small>%</small></div>
        <div class="w-sub">${pc ? `Spitze ${Math.round(pc.metrics?.cpu || 0)} % · ${esc(pc.name)}` : 'keine Clients online'}</div>${miniLine(hist, 1, 'var(--series-cpu)')}</div>
      <div class="w"><div class="wh">Ø Arbeitsspeicher</div><div class="big">${memAvg == null ? '–' : Math.round(memAvg)}<small>%</small></div>
        <div class="w-sub">${pm ? `Spitze ${Math.round(memPct(pm.metrics) || 0)} % · ${esc(pm.name)}` : 'keine Clients online'}</div>${miniLine(hist, 2, 'var(--series-mem)')}</div>
      ${fourth}`;
  }

  function rows() {
    const t = api.settings.thresholds;
    const rank = (a) => (!a.online ? 1 : a.alerts?.length ? 3 : 2);
    const load = (a) => Math.max(a.metrics?.cpu || 0, memPct(a.metrics) || 0);
    const list = [...api.agents.values()].sort((a, b) => rank(b) - rank(a) || load(b) - load(a) || a.name.localeCompare(b.name));
    $('[data-rows]', root).innerHTML = list.map((a) => {
      const [cls, label] = stateOf(a);
      const m = a.metrics;
      return `<tr class="click ${a.online ? '' : 'off'}" data-id="${a.id}">
        <td><div class="nmc"><span class="nm-ic">${clientIcon(a)}</span><div class="nm-t"><div class="n">${esc(a.name)}</div><div class="s">${a.pve ? pveLine(a) : esc(osShort(a))}</div></div></div></td>
        <td><span class="state"><span class="dot ${cls}"></span>${label}</span></td>
        <td>${a.online ? bar(m?.cpu, t.cpu) : '<span class="muted">–</span>'}</td>
        <td>${a.online ? bar(memPct(m), t.mem) : '<span class="muted">–</span>'}</td>
        <td>${a.online ? bar(worstDisk(m)?.pct, t.disk) : '<span class="muted">–</span>'}</td>
        <td class="muted">${esc(primaryIp(a))}</td>
        <td class="muted">${a.online ? fmtDuration(m?.uptime) : fmtAgo(a.lastSeen)}</td></tr>`;
    }).join('') || `<tr><td colspan="7"><div class="empty">${icon('monitor')}<h3>Noch keine Clients</h3><div>Über „Client hinzufügen“ den Agent auf einem Rechner installieren.</div></div></td></tr>`;
  }

  function attention() {
    const items = [];
    for (const a of api.agents.values()) for (const al of a.alerts || []) items.push({ a, al });
    items.sort((x, y) => (x.al.level === 'critical' ? 0 : 1) - (y.al.level === 'critical' ? 0 : 1) || x.a.name.localeCompare(y.a.name));
    $('[data-attn-count]', root).textContent = items.length || '';
    $('[data-attn]', root).innerHTML = items.length
      ? items.slice(0, 8).map(({ a, al }) => `<div class="ev click" data-id="${a.id}"><span class="ev-ic ${al.level === 'critical' ? 'crit' : 'warn'}">${icon(al.kind === 'offline' ? 'power' : 'alert', 'sm')}</span>
          <div class="ev-tx"><div><b>${esc(a.name)}</b></div><div class="muted">${al.kind === 'offline' ? `Offline seit ${fmtAgo(a.lastSeen).replace(/^vor /, '')}` : esc(al.label)}</div></div>
          <span class="badge ${al.level === 'critical' ? 'critical' : 'warning'}">${al.level === 'critical' ? 'Kritisch' : 'Warnung'}</span></div>`).join('')
        + (items.length > 8 ? `<div class="muted" style="font-size:12px;padding-top:6px">+ ${items.length - 8} weitere</div>` : '')
      : `<div class="ok-line">${icon('check', 'sm')}Alles in Ordnung</div>`;
  }

  // Ereignisse aus dem Protokoll
  let events = [];
  function drawEvents() {
    const box = $('[data-events]', root);
    if (!box) return;
    const today = new Date().toDateString();
    box.innerHTML = events.length ? events.slice(0, 12).map((e) => {
      const tone = e.ok === false ? 'crit' : e.action === 'Offline' ? 'crit' : e.cat === 'connection' ? 'ok' : e.cat === 'power' || e.cat === 'shell' ? 'blue' : e.cat === 'settings' || e.cat === 'system' ? 'muted' : 'ok';
      const d = new Date(e.ts);
      const time = d.toDateString() === today ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      return `<div class="ev"><span class="ev-ic ${tone}">${icon(EV_ICON[e.cat] || 'activity', 'sm')}</span>
        <div class="ev-tx"><div>${e.target ? `<b>${esc(e.target)}</b> · ` : ''}${esc(e.action)}</div><div class="muted">${esc(e.detail || e.result || e.actor || AUDIT_CATS[e.cat]?.label || '')}</div></div>
        <span class="ev-tm">${time}</span></div>`;
    }).join('') : '<div class="muted">Noch keine Ereignisse</div>';
  }
  api.get('/api/audit?limit=20').then((r) => { events = r.items; drawEvents(); }).catch(() => { events = []; drawEvents(); });
  const offAudit = api.on('audit', (e) => { events.unshift(e); events.length = Math.min(events.length, 40); drawEvents(); });

  async function loadHist() {
    try { hist = await api.get('/api/stats/history'); chart.update(hist); tiles(); } catch {}
  }
  async function loadPve() {
    const hosts = [...api.agents.values()].filter((a) => isPveHost(a) && a.online);
    if (!hosts.length) { pveStats = null; return; }
    const res = await Promise.allSettled(hosts.map((h) => fetchGuests(h.id, 50000)));
    const guests = res.flatMap((r) => (r.status === 'fulfilled' ? r.value.guests.filter((g) => !g.template) : []));
    if (res.some((r) => r.status === 'fulfilled')) pveStats = { total: guests.length, running: guests.filter((g) => g.status === 'running').length };
    tiles();
  }

  const redraw = throttle(() => { tiles(); rows(); attention(); }, 1000);
  $('.dash-main', root).addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row && !e.target.closest('a')) go(`#/client/${row.dataset.id}`);
  });
  redraw();
  loadHist();
  loadPve();
  const offAgents = api.on('agents', redraw);
  const stop1 = poll(loadHist, 30000);
  const stop2 = poll(loadPve, 60000);
  return () => { offAgents(); offAudit(); stop1(); stop2(); chart.destroy?.(); };
}
