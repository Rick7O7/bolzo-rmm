import { api, LS } from '../api.js';
import { icon, esc, el, $, $$, meter, memPct, worstDisk, fmtDuration, osIcon, osLabel, statusHtml, primaryIp, throttle } from '../ui.js';
import { sparkline } from '../charts.js';
import { addClientDialog } from './settings.js';

export function renderDashboard(root, { go }) {
  let filter = LS.get('dash.filter', 'all');
  let query = '';

  root.innerHTML = `
    <div class="page-head">
      <h1>Dashboard</h1>
      <span class="spacer"></span>
      <button class="btn primary" data-add>${icon('plus')}Client hinzufügen</button>
    </div>
    <div class="tiles" data-tiles></div>
    <div class="split" style="margin-top:14px">
      <div>
        <div class="toolbar" style="margin-top:12px">
          <div class="search grow" style="max-width:340px">${icon('search', 'sm')}<input class="input" placeholder="Clients durchsuchen (Name, IP, Tag) ..." data-q></div>
          <div class="seg" data-seg>
            <button data-f="all">Alle</button><button data-f="online">Online</button><button data-f="offline">Offline</button><button data-f="alert">Warnungen</button>
          </div>
        </div>
        <div class="dash-grid" data-grid></div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-head">${icon('bell', 'sm')}<h3>Benötigt Aufmerksamkeit</h3></div>
        <div class="alert-list" data-alerts></div>
      </div>
    </div>`;

  $('[data-add]', root).onclick = addClientDialog;
  $('[data-q]', root).addEventListener('input', (e) => { query = e.target.value.toLowerCase(); draw(); });
  const seg = $('[data-seg]', root);
  const markSeg = () => $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  seg.addEventListener('click', (e) => {
    const f = e.target.closest('button')?.dataset.f;
    if (!f) return;
    filter = f;
    LS.set('dash.filter', f);
    markSeg();
    draw();
  });
  markSeg();

  function draw() {
    const agents = [...api.agents.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    const online = agents.filter((a) => a.online);
    const withAlerts = agents.filter((a) => a.online && a.alerts.length);
    const avgCpu = online.length ? online.reduce((s, a) => s + (a.metrics?.cpu || 0), 0) / online.length : null;

    $('[data-tiles]', root).innerHTML = `
      <div class="card tile clickable" data-f="all"><div class="label">${icon('server', 'sm')}Clients gesamt</div><div class="value num">${agents.length}</div><div class="foot">${agents.filter((a) => a.platform === 'win32').length} Windows · ${agents.filter((a) => a.platform === 'linux').length} Linux</div></div>
      <div class="card tile clickable" data-f="online"><div class="label"><span class="dot online"></span>Online</div><div class="value num">${online.length}</div><div class="foot">${avgCpu == null ? 'keine aktiven Clients' : `Ø CPU-Last ${Math.round(avgCpu)} %`}</div></div>
      <div class="card tile clickable" data-f="offline"><div class="label"><span class="dot offline"></span>Offline</div><div class="value num">${agents.length - online.length}</div><div class="foot">${agents.length - online.length ? 'nicht erreichbar' : 'alle erreichbar'}</div></div>
      <div class="card tile clickable" data-f="alert"><div class="label">${icon('alert', 'sm')}Warnungen</div><div class="value num">${withAlerts.reduce((s, a) => s + a.alerts.length, 0)}</div><div class="foot">auf ${withAlerts.length} Client${withAlerts.length === 1 ? '' : 's'}</div></div>`;
    $$('[data-tiles] .tile', root).forEach((t) => (t.onclick = () => { filter = t.dataset.f; LS.set('dash.filter', filter); markSeg(); draw(); }));

    const visible = agents.filter((a) => {
      if (filter === 'online' && !a.online) return false;
      if (filter === 'offline' && a.online) return false;
      if (filter === 'alert' && !(a.online && a.alerts.length)) return false;
      if (!query) return true;
      return [a.name, a.hostname, primaryIp(a), a.os, ...(a.tags || [])].join(' ').toLowerCase().includes(query);
    });

    const grid = $('[data-grid]', root);
    if (!agents.length) {
      grid.innerHTML = `<div class="card empty" style="grid-column:1/-1">${icon('monitor')}<h3>Noch keine Clients</h3><div>Installiere den Agent auf einem Rechner, um ihn hier zu sehen.</div><button class="btn primary" style="margin-top:16px" data-add2>${icon('plus')}Client hinzufügen</button></div>`;
      $('[data-add2]', grid).onclick = addClientDialog;
    } else if (!visible.length) {
      grid.innerHTML = `<div class="card empty" style="grid-column:1/-1">${icon('search')}<h3>Keine Treffer</h3><div>Filter oder Suche anpassen.</div></div>`;
    } else {
      grid.innerHTML = visible.map(card).join('');
      $$('.client-card', grid).forEach((c) => (c.onclick = () => go(`#/client/${c.dataset.id}`)));
    }

    const alertRows = [];
    for (const a of agents) for (const al of a.alerts || []) alertRows.push({ a, al });
    alertRows.sort((x, y) => (x.al.level === 'critical' ? 0 : 1) - (y.al.level === 'critical' ? 0 : 1));
    const list = $('[data-alerts]', root);
    list.innerHTML = alertRows.length
      ? alertRows.slice(0, 40).map(({ a, al }) => `<div class="alert-row ${al.level}" data-id="${a.id}">${icon(al.kind === 'offline' ? 'power' : 'alert', 'sm')}<div class="grow"><div style="font-weight:500">${esc(a.name)}</div><div class="muted" style="font-size:12px">${esc(al.kind === 'offline' ? 'Offline' : al.label)}</div></div><span class="badge ${al.level}">${al.level === 'critical' ? 'Kritisch' : 'Warnung'}</span></div>`).join('')
      : `<div class="empty" style="padding:28px">${icon('check')}<div>Alles in Ordnung</div></div>`;
    $$('.alert-row', list).forEach((r) => (r.onclick = () => go(`#/client/${r.dataset.id}`)));
  }

  function card(a) {
    const t = api.settings.thresholds;
    const m = a.metrics;
    const disk = worstDisk(m);
    const mp = memPct(m);
    const alerts = (a.alerts || []).filter((x) => x.kind !== 'offline');
    return `<div class="card client-card ${a.online ? '' : 'offline'}" data-id="${a.id}">
      <div class="cc-head">
        <div class="grow">
          <div class="cc-name">${esc(a.name)}</div>
          <div class="cc-sub"><span class="os">${osIcon(a.platform)}${esc(a.os || osLabel(a.platform))}</span></div>
        </div>
        ${statusHtml(a).replace(/Online · \d+ Warnung(en)?/, 'Online')}
      </div>
      ${a.online ? `
        ${sparkline(a.spark)}
        ${meter({ label: 'CPU', iconName: 'cpu', value: m?.cpu, threshold: t.cpu })}
        ${meter({ label: 'RAM', iconName: 'memory', value: mp, kind: 'mem', threshold: t.mem })}
        ${disk ? meter({ label: `Disk ${disk.mount}`, iconName: 'disk', value: disk.pct, threshold: t.disk, text: `${Math.round(disk.pct)} %` }) : ''}
        <div class="row muted" style="font-size:12px;justify-content:space-between"><span>${esc(primaryIp(a))}</span><span>Uptime ${fmtDuration(m?.uptime)}</span></div>
      ` : `<div class="muted" style="font-size:12.5px">Zuletzt gesehen: ${new Date(a.lastSeen).toLocaleString('de-DE')}<br>${esc(primaryIp(a))}</div>`}
      ${alerts.length ? `<div class="cc-alerts">${alerts.map((x) => `<span class="badge ${x.level}">${icon('alert')}${esc(x.label)}</span>`).join('')}</div>` : ''}
      ${a.tags?.length ? `<div class="row" style="gap:6px;flex-wrap:wrap">${a.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  draw();
  const off = api.on('agents', throttle(draw, 1000));
  const tick = setInterval(draw, 30000); // "zuletzt gesehen" aktuell halten
  return () => { off(); clearInterval(tick); };
}
