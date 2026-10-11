// Eigene Seite für eine VM / einen Container auf einem Proxmox-Host.
// Netzwerk, Hardware und Optionen werden direkt in Tabellenzeilen bearbeitet; Änderungen sammeln
// sich und werden über die Leiste unten gemeinsam übernommen (oder verworfen).
import { api } from '../api.js';
import { icon, esc, el, $, $$, toast, fmtBytes, fmtDuration, tagHtml, osShort } from '../ui.js';
import { lineChart } from '../charts.js';
import { pveCall, pvePower, openConsole, kind, OSTYPES, statusBadge, miniBar, renderGuestSnapshots, renderGuestBackups } from '../proxmox.js';

const TABS = [
  ['overview', 'Übersicht', 'activity'], ['network', 'Netzwerk', 'network'], ['hardware', 'Hardware', 'cpu'],
  ['options', 'Optionen', 'sliders'], ['snapshots', 'Snapshots', 'clock'], ['backups', 'Backups', 'download'],
];
const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function renderGuest(root, { go, params }) {
  const [hostId, type, vmidStr] = params;
  const vmid = Number(vmidStr);
  const isCt = type === 'lxc';
  const host = () => api.agents.get(hostId);
  const ref = { vmid, type };
  let tab = TABS.some((t) => t[0] === params[3]) ? params[3] : 'overview';
  let status = null;
  let conf = null;
  let draft = null;
  let bridges = null;
  let chart = null;
  let timeframe = 'hour';
  let timer = null;

  root.innerHTML = `<div class="gp">
    <button class="crumb" data-back style="margin-bottom:10px">${icon('back', 'sm')}Proxmox</button>
    <div class="detail-head" data-head><div class="muted">Lade ...</div></div>
    <div class="tabs">${TABS.map(([k, l, i]) => `<button class="tab" data-tab="${k}">${icon(i, 'sm')}${l}</button>`).join('')}</div>
    <div class="gp-cols"><div data-body></div><aside class="w gp-side" data-side></aside></div>
    <div class="applybar" data-apply hidden><span class="dot-acc"></span><span data-apply-text></span>
      <button class="btn ghost" data-discard>Verwerfen</button><button class="btn primary" data-save>${icon('check', 'sm')}Übernehmen</button></div></div>`;
  const view = $('.gp', root); // Listener nie am gemeinsamen Seitencontainer anmelden
  $('[data-back]', root).onclick = () => go('#/proxmox');
  const g = () => ({ hostId, vmid, type, name: status?.name || conf?.name || `${kind(type)} ${vmid}`, label: status?.name || conf?.name, hostName: host()?.name });

  // ---------- Laden ----------
  async function loadStatus() {
    const { guests } = await api.get(`/api/agents/${hostId}/pve/guests`);
    status = guests.find((x) => x.type === type && x.vmid === vmid) || null;
    if (!status) throw new Error(`${kind(type)} ${vmid} gibt es auf ${host()?.name || 'diesem Host'} nicht (mehr)`);
  }
  async function loadConf() {
    conf = await pveCall(hostId, 'pve.config.get', { ...ref, name: status?.name });
    draft = clone(conf);
  }
  async function loadAll() {
    if (!host()?.online) {
      $('[data-head]', root).innerHTML = `<div class="card empty" style="flex:1">${icon('server')}<h3>Proxmox-Host ist offline</h3></div>`;
      return;
    }
    try {
      await loadStatus();
      await loadConf();
    } catch (e) {
      $('[data-head]', root).innerHTML = `<div class="card empty err-text" style="flex:1">${esc(e.message)}</div>`;
      return;
    }
    drawHead();
    drawSide();
    showTab(tab);
  }
  async function refresh() {
    try { await loadStatus(); drawHead(); drawSide(); } catch {}
  }

  // ---------- Kopf + Zustand ----------
  function drawHead() {
    const s = status;
    const run = s.status === 'running';
    const crumb = $('[data-crumb]');
    if (crumb) crumb.textContent = `Proxmox / ${host()?.name || ''} / ${s.name}`;
    $('[data-head]', root).innerHTML = `
      <div class="detail-icon">${icon(isCt ? 'box' : 'monitor')}</div>
      <div class="detail-title grow">
        <h1>${esc(s.name)} ${statusBadge(s.status)}</h1>
        <div class="meta"><span>${kind(type)} ${vmid}</span><span>${esc(host()?.name || '')}</span><span>${esc(OSTYPES[s.ostype] ?? s.ostype ?? '')}</span>${run ? `<span>seit ${fmtDuration(s.uptime)}</span>` : ''}${s.lock ? `<span class="badge warning">gesperrt: ${esc(s.lock)}</span>` : ''}</div>
      </div>
      <div class="btn-group">
        ${run ? `<button class="btn" data-act="console">${icon(isCt ? 'terminal' : 'monitor', 'sm')}Konsole</button>
          <button class="btn" data-act="reboot">${icon('refresh', 'sm')}Neustart</button>
          <button class="btn" data-act="shutdown">${icon('power', 'sm')}Herunterfahren</button>`
        : `<button class="btn primary" data-act="start">${icon('play', 'sm')}Starten</button>`}
        <button class="btn icon-only" data-act="more" title="Weitere Aktionen">⋯</button>
      </div>`;
  }

  function drawSide() {
    const s = status;
    const run = s.status === 'running';
    const t = api.settings.thresholds;
    const a = s.agentId && api.agents.get(s.agentId);
    const memPct = s.maxmem ? (100 * s.mem) / s.maxmem : null;
    const diskPct = isCt && s.maxdisk ? (100 * s.disk) / s.maxdisk : null;
    $('[data-side]', root).innerHTML = `<div class="wh">Zustand</div><div class="kv gp-kv">
      <div class="k">CPU</div><div class="v">${run ? `${miniBar(s.cpu * 100, '', t.cpu)}<div class="sub">${s.cpus} ${s.cpus === 1 ? 'Kern' : 'Kerne'}</div>` : '–'}</div>
      <div class="k">RAM</div><div class="v">${run ? `${miniBar(memPct, 'mem', t.mem)}<div class="sub">${fmtBytes(s.mem)} / ${fmtBytes(s.maxmem)}</div>` : fmtBytes(s.maxmem)}</div>
      <div class="k">Disk</div><div class="v">${diskPct != null ? `${miniBar(diskPct, '', t.disk)}<div class="sub">${fmtBytes(s.disk)} / ${fmtBytes(s.maxdisk)}</div>` : fmtBytes(s.maxdisk)}</div>
      <div class="k">Netzwerk</div><div class="v">${run ? `↓ ${fmtBytes(s.netin)} · ↑ ${fmtBytes(s.netout)}` : '–'}</div>
      <div class="k">IP-Adressen</div><div class="v mono">${s.ips?.length ? s.ips.map(esc).join('<br>') : '–'}</div>
      <div class="k">BOLZO-Client</div><div class="v">${a ? `<a href="#/client/${a.id}" class="link-client"><span class="dot ${a.online ? 'online' : 'offline'}"></span>${esc(a.name)}</a>` : '<span class="muted">nicht zugeordnet</span>'}</div>
      <div class="k">Tags</div><div class="v">${s.tags?.length ? s.tags.map((x) => tagHtml(x, { small: true })).join(' ') : '–'}</div>
      <div class="k">Autostart</div><div class="v">${s.onboot ? 'an' : 'aus'}${conf?.startup?.order ? ` · Reihenfolge ${esc(conf.startup.order)}` : ''}</div>
    </div>`;
  }

  // ---------- Änderungen ----------
  function changes() {
    const ch = {};
    for (const k of ['name', 'cores', 'memory', 'onboot', 'protection', 'description']) if (!same(draft[k], conf[k])) ch[k] = draft[k];
    if (!isCt && draft.sockets !== conf.sockets) ch.sockets = draft.sockets;
    if (isCt && draft.swap !== conf.swap) ch.swap = draft.swap;
    if (!same(draft.tags, conf.tags)) ch.tags = draft.tags;
    if (draft.startup.order !== conf.startup.order || draft.startup.up !== conf.startup.up) ch.startup = draft.startup;
    const nets = [];
    const removeNets = [];
    for (const n of draft.nets) {
      if (n.removed) { if (!n.create) removeNets.push(n.key); continue; }
      if (n.create) { nets.push({ key: n.key, create: true, bridge: n.bridge, tag: n.tag, firewall: n.firewall, ...(isCt ? { ip: n.ip, gw: n.gw } : {}) }); continue; }
      const o = conf.nets.find((x) => x.key === n.key);
      const d = { key: n.key };
      for (const f of ['bridge', 'tag', 'firewall']) if (n[f] !== o[f]) d[f] = n[f];
      if (isCt && (n.ip !== o.ip || n.gw !== o.gw)) { d.ip = n.ip; d.gw = n.gw; }
      if (Object.keys(d).length > 1) nets.push(d);
    }
    if (nets.length) ch.nets = nets;
    if (removeNets.length) ch.removeNets = removeNets;
    return ch;
  }
  function countChanges(ch) {
    return Object.keys(ch).filter((k) => k !== 'nets' && k !== 'removeNets').length + (ch.nets?.length || 0) + (ch.removeNets?.length || 0);
  }
  function updateApply() {
    const n = countChanges(changes());
    $('[data-apply]', root).hidden = !n;
    $('[data-apply-text]', root).innerHTML = `<b>${n} ungespeicherte Änderung${n === 1 ? '' : 'en'}</b>`;
    // geänderte Zeilen markieren
    $$('[data-row]', root).forEach((r) => r.classList.toggle('changed', rowChanged(r.dataset.row)));
  }
  function rowChanged(key) {
    if (key.startsWith('net')) {
      const n = draft.nets.find((x) => x.key === key);
      const o = conf.nets.find((x) => x.key === key);
      return !!n && !n.create && !n.removed && !!o && ['bridge', 'tag', 'firewall', 'ip', 'gw'].some((f) => n[f] !== o[f]);
    }
    if (key === 'startup') return draft.startup.order !== conf.startup.order || draft.startup.up !== conf.startup.up;
    return !same(draft[key], conf[key]);
  }
  $('[data-discard]', root).onclick = () => { draft = clone(conf); showTab(tab); };
  $('[data-save]', root).onclick = async (e) => {
    const btn = e.currentTarget;
    const ch = changes();
    if (ch.nets?.some((n) => n.create && !n.bridge)) return toast('Bitte für die neue Netzwerkkarte eine Brücke wählen', 'err');
    btn.disabled = true;
    try {
      const r = await pveCall(hostId, 'pve.config.set', { ...ref, name: status.name, changes: ch });
      toast(r.pending?.length ? `Übernommen – ${r.pending.join(', ')} wird beim nächsten Neustart aktiv` : 'Übernommen');
      await loadConf();
      await refresh();
      showTab(tab);
    } catch (err) { toast(err.message, 'err'); }
    btn.disabled = false;
  };

  // ---------- Reiter ----------
  function showTab(k) {
    tab = k;
    history.replaceState(null, '', `#/guest/${hostId}/${type}/${vmid}/${k}`);
    $$('[data-tab]', root).forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    chart?.destroy?.();
    chart = null;
    // Inhaltsbereich frisch anlegen, damit sich Eingabe-Listener nicht ansammeln
    const old = $('[data-body]', root);
    const body = old.cloneNode(false);
    old.replaceWith(body);
    ({ overview, network, hardware, options, snapshots: () => renderGuestSnapshots(body, g()), backups: () => renderGuestBackups(body, g()) })[k](body);
    updateApply();
  }
  $$('[data-tab]', root).forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

  function overview(body) {
    const nets = conf.nets.map((n) => `${esc(n.key)} · ${esc(n.bridge)}${n.tag ? ` · VLAN ${esc(n.tag)}` : ''}`).join('<br>');
    body.innerHTML = `
      <div class="w" style="margin-bottom:12px"><div class="wh">Auslastung<span class="grow"></span>
        <div class="seg" data-tf><button data-v="hour">Stunde</button><button data-v="day">Tag</button><button data-v="week">Woche</button></div></div>
        <div style="padding:6px 16px 14px" data-chart></div></div>
      <div class="w"><div class="wh">Details</div><div class="kv gp-kv">
        <div class="k">Typ</div><div class="v">${kind(type)} ${vmid} auf ${esc(host()?.name || '')}</div>
        <div class="k">Betriebssystem</div><div class="v">${esc(status.agentId && api.agents.get(status.agentId) ? osShort(api.agents.get(status.agentId)) : OSTYPES[conf.ostype] ?? conf.ostype ?? '–')}</div>
        <div class="k">Netzwerkkarten</div><div class="v mono">${nets || '–'}</div>
        <div class="k">Ressourcen</div><div class="v">${conf.cores} ${conf.cores === 1 ? 'Kern' : 'Kerne'}${!isCt && conf.sockets > 1 ? ` × ${conf.sockets} Sockel` : ''} · ${fmtBytes(conf.memory * 1048576)} RAM${isCt ? ` · ${fmtBytes(conf.swap * 1048576)} Swap` : ''}</div>
        <div class="k">Schutz</div><div class="v">${conf.protection ? 'Vor Löschen geschützt' : 'aus'}</div>
        <div class="k">Notizen</div><div class="v" style="white-space:pre-wrap">${esc(conf.description || '–')}</div>
      </div></div>`;
    chart = lineChart($('[data-chart]', body), { height: 200 });
    const loadRrd = async () => {
      $$('[data-tf] button', body).forEach((b) => b.classList.toggle('on', b.dataset.v === timeframe));
      try {
        const pts = await pveCall(hostId, 'pve.rrd', { ...ref, timeframe });
        chart?.update(pts.map((p) => [p.t, p.cpu, p.mem]));
      } catch (e) { toast(e.message, 'err'); }
    };
    $('[data-tf]', body).onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { timeframe = b.dataset.v; loadRrd(); } };
    loadRrd();
  }

  async function network(body) {
    if (!bridges) {
      body.innerHTML = '<div class="card empty">Lade ...</div>';
      try { bridges = (await pveCall(hostId, 'pve.net.list')).ifaces.filter((i) => i.type === 'bridge' || i.type === 'OVSBridge'); } catch { bridges = []; }
      if (tab !== 'network') return;
    }
    const bridgeOpts = (cur) => {
      const list = bridges.some((b) => b.iface === cur) || !cur ? bridges : [...bridges, { iface: cur }];
      return `${cur ? '' : '<option value="">– wählen –</option>'}${list.map((b) => `<option value="${esc(b.iface)}" ${b.iface === cur ? 'selected' : ''}>${esc(b.iface)}${b.comments ? ` · ${esc(b.comments)}` : ''}${b.cidr ? ` · ${esc(b.cidr)}` : ''}${b.vlanAware ? ' · VLAN-fähig' : ''}</option>`).join('')}`;
    };
    const row = (n) => {
      const mode = isCt ? (n.ipMode === 'static' ? 'static' : !n.ip ? 'none' : n.ip === 'dhcp' ? 'dhcp' : n.ip === 'manual' ? 'manual' : 'static') : '';
      return `<div class="gp-nic ${n.create ? 'new' : ''} ${n.removed ? 'removed' : ''}" data-row="${n.key}">
        <span class="gp-nic-ic">${icon(n.create ? 'plus' : 'network', 'sm')}</span>
        <div class="gp-nic-name"><div class="n">${esc(n.key)}${n.name ? ` · ${esc(n.name)}` : ''}</div><div class="sub mono">${n.create ? 'neu – MAC vergibt Proxmox' : esc(n.mac || '')}${n.model ? ` · ${esc(n.model)}` : ''}</div></div>
        <select class="select" data-f="bridge" ${n.removed ? 'disabled' : ''}>${bridgeOpts(n.bridge)}</select>
        <input class="input" data-f="tag" type="number" min="1" max="4094" placeholder="kein VLAN" value="${esc(n.tag || '')}" ${n.removed ? 'disabled' : ''}>
        ${isCt ? `<div class="gp-ip">
            <select class="select" data-f="mode" ${n.removed ? 'disabled' : ''}><option value="dhcp" ${mode === 'dhcp' ? 'selected' : ''}>DHCP</option><option value="static" ${mode === 'static' ? 'selected' : ''}>Statisch</option>${mode === 'manual' || mode === 'none' ? `<option value="${mode}" selected>${mode === 'manual' ? 'Manuell' : 'Nicht gesetzt'}</option>` : ''}</select>
            ${mode === 'static' ? `<input class="input mono" data-f="ip" placeholder="10.2.30.50/24" value="${esc(n.ip)}"><input class="input mono" data-f="gw" placeholder="Gateway" value="${esc(n.gw || '')}">` : ''}
          </div>` : '<div class="muted gp-ip-vm">wird in der VM eingestellt</div>'}
        <label class="switch" title="Proxmox-Firewall"><input type="checkbox" data-f="firewall" ${n.firewall ? 'checked' : ''} ${n.removed ? 'disabled' : ''}><span></span></label>
        ${n.removed ? `<button class="btn sm" data-undo title="Wiederherstellen">Zurück</button>` : `<button class="btn sm ghost icon-only" data-remove title="Netzwerkkarte entfernen">${icon('trash', 'sm')}</button>`}
      </div>`;
    };
    body.innerHTML = `<div class="w gp-nics">
      <div class="gp-nic head"><span></span><span>Karte</span><span>Brücke</span><span>VLAN</span><span>IPv4</span><span>Firewall</span><span></span></div>
      ${draft.nets.map(row).join('')}
      <button class="gp-add" data-add>${icon('plus', 'sm')}Netzwerkkarte hinzufügen</button>
    </div>
    <div class="hint" style="margin-top:8px">Änderungen an laufenden Gästen greifen nach „Übernehmen“ sofort. Läuft die Verbindung zu ${esc(status.name)} über eine geänderte Karte, ist er kurz nicht erreichbar.</div>`;
    const box = $('.gp-nics', body);
    updateApply();
    box.addEventListener('input', onEdit);
    box.addEventListener('change', onEdit);
    function onEdit(e) {
      const r = e.target.closest('[data-row]');
      const f = e.target.dataset.f;
      if (!r || !f) return;
      const n = draft.nets.find((x) => x.key === r.dataset.row);
      if (f === 'firewall') n.firewall = e.target.checked;
      else if (f === 'mode') { n.ipMode = e.target.value; n.ip = e.target.value === 'static' ? (conf.nets.find((x) => x.key === n.key)?.ip?.includes('/') ? conf.nets.find((x) => x.key === n.key).ip : '') : e.target.value; if (e.target.value !== 'static') n.gw = ''; if (e.type === 'change') return network(body); }
      else n[f] = e.target.value.trim();
      updateApply();
    }
    box.addEventListener('click', (e) => {
      const r = e.target.closest('[data-row]');
      if (e.target.closest('[data-add]')) {
        const used = new Set(draft.nets.map((x) => x.key));
        let i = 0;
        while (used.has(`net${i}`)) i++;
        draft.nets.push({ key: `net${i}`, create: true, name: isCt ? `eth${i}` : '', bridge: bridges[0]?.iface || '', tag: '', firewall: true, ip: isCt ? 'dhcp' : '', gw: '', mac: '', model: isCt ? '' : 'virtio' });
        network(body);
        return updateApply();
      }
      if (!r) return;
      const n = draft.nets.find((x) => x.key === r.dataset.row);
      if (e.target.closest('[data-remove]')) {
        if (n.create) draft.nets = draft.nets.filter((x) => x !== n);
        else n.removed = true;
        network(body);
        updateApply();
      }
      if (e.target.closest('[data-undo]')) { n.removed = false; network(body); updateApply(); }
    });
  }

  // Einstellungen als Tabellenzeilen: Bezeichnung + Erklärung links, Eingabe rechts
  const setRow = (key, label, hint, control) => `<div class="gp-row" data-row="${key}"><div class="gp-k"><div>${label}</div>${hint ? `<div class="gp-h">${hint}</div>` : ''}</div><div class="gp-v">${control}</div></div>`;
  function bindRows(body) {
    body.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (f === 'tags') draft.tags = String(v).split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      else if (f === 'order' || f === 'up') draft.startup = { ...draft.startup, [f]: String(v).trim() };
      else if (['cores', 'sockets', 'memory', 'swap'].includes(f)) {
        draft[f] = Number(v) || 0;
        const hint = $(`[data-gb="${f}"]`, body);
        if (hint) hint.textContent = fmtBytes(draft[f] * 1048576);
      } else draft[f] = typeof v === 'string' && f === 'name' ? v.trim() : v;
      updateApply();
    });
  }

  function hardware(body) {
    body.innerHTML = `<div class="w gp-table">
      ${setRow('cores', 'CPU-Kerne', isCt ? 'Anzahl Kerne für den Container' : 'Kerne pro Sockel', `<input class="input" type="number" min="1" max="512" data-f="cores" value="${draft.cores}">`)}
      ${!isCt ? setRow('sockets', 'CPU-Sockel', 'Meist 1', `<input class="input" type="number" min="1" max="16" data-f="sockets" value="${draft.sockets}">`) : ''}
      ${setRow('memory', 'Arbeitsspeicher', 'in MB', `<input class="input" type="number" min="16" step="256" data-f="memory" value="${draft.memory}"><span class="gp-unit" data-gb="memory">${fmtBytes(draft.memory * 1048576)}</span>`)}
      ${isCt ? setRow('swap', 'Swap', 'in MB', `<input class="input" type="number" min="0" step="128" data-f="swap" value="${draft.swap}"><span class="gp-unit" data-gb="swap">${fmtBytes(draft.swap * 1048576)}</span>`) : ''}
    </div>
    <div class="w gp-table" style="margin-top:12px"><div class="wh">Datenträger</div>
      ${conf.disks.length ? conf.disks.map((d) => `<div class="gp-row"><div class="gp-k"><div class="mono">${esc(d.key)}</div>${d.mount ? `<div class="gp-h">eingehängt unter ${esc(d.mount)}</div>` : ''}</div>
        <div class="gp-v"><span class="mono" style="font-size:12.5px">${esc(d.volume)}</span><span class="gp-unit">${d.cdrom ? 'CD/DVD' : esc(d.size)}</span></div></div>`).join('') : '<div class="empty">Keine Datenträger</div>'}
      <div class="hint" style="padding:10px 16px">Datenträger vergrößern oder hinzufügen geht derzeit noch in der Proxmox-Oberfläche.</div>
    </div>`;
    bindRows(body);
  }

  function options(body) {
    body.innerHTML = `<div class="w gp-table">
      ${setRow('name', 'Name', isCt ? 'Hostname des Containers' : 'Anzeigename der VM', `<input class="input" data-f="name" value="${esc(draft.name)}">`)}
      ${setRow('tags', 'Tags', 'Mit Komma getrennt, z.B. web, prod', `<input class="input" data-f="tags" value="${esc(draft.tags.join(', '))}">`)}
      ${setRow('onboot', 'Autostart', `Startet mit, wenn ${esc(host()?.name || 'der Host')} hochfährt`, `<label class="switch"><input type="checkbox" data-f="onboot" ${draft.onboot ? 'checked' : ''}><span></span></label>`)}
      ${setRow('startup', 'Startreihenfolge', 'Kleinere Zahl startet zuerst · Wartezeit danach in Sekunden', `<input class="input" style="max-width:90px" type="number" min="0" placeholder="beliebig" data-f="order" value="${esc(draft.startup.order)}"><input class="input" style="max-width:110px" type="number" min="0" placeholder="0 s" data-f="up" value="${esc(draft.startup.up)}">`)}
      ${setRow('protection', 'Schutz vor Löschen', 'Verhindert, dass der Gast versehentlich gelöscht wird', `<label class="switch"><input type="checkbox" data-f="protection" ${draft.protection ? 'checked' : ''}><span></span></label>`)}
      ${setRow('description', 'Notizen', 'Wird auch in Proxmox angezeigt', `<textarea class="textarea" data-f="description" style="min-height:90px">${esc(draft.description)}</textarea>`)}
    </div>`;
    bindRows(body);
  }

  // ---------- Aktionen im Kopf ----------
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !status) return;
    const k = b.dataset.act;
    if (k === 'console') return openConsole(g());
    if (k === 'more') {
      const r = b.getBoundingClientRect();
      const items = [
        ...(status.status === 'running' ? [['stop', 'Ausschalten (hart)', 'stop', true]] : []),
        ...(status.status === 'running' && (isCt || status.agentId) ? [['restart-agent', 'BOLZO-Agent im Gast neu starten', 'refresh']] : []),
        ...(status.agentId ? [['client', 'Zugeordneten Client öffnen', 'monitor']] : []),
      ];
      if (!items.length) return;
      const m = el(`<div class="menu" style="top:${r.bottom + 6}px;right:${window.innerWidth - r.right}px">${items.map(([key, l, i, d]) => `<button class="menu-item ${d ? 'danger' : ''}" data-k="${key}">${icon(i, 'sm')}${l}</button>`).join('')}</div>`);
      document.body.append(m);
      const close = () => { m.remove(); document.removeEventListener('mousedown', out); };
      const out = (ev) => !m.contains(ev.target) && close();
      setTimeout(() => document.addEventListener('mousedown', out));
      m.onclick = async (ev) => {
        const key = ev.target.closest('[data-k]')?.dataset.k;
        if (!key) return;
        close();
        if (key === 'client') return go(`#/client/${status.agentId}`);
        if (key === 'restart-agent') {
          try { await api.post(`/api/agents/${hostId}/pve/restart-agent`, { vmid, type, name: status.name }); toast('BOLZO-Agent wird neu gestartet'); } catch (err) { toast(err.message, 'err'); }
          return;
        }
        if (await pvePower(g(), key)) setTimeout(refresh, 2500);
      };
      return;
    }
    if (await pvePower(g(), k)) setTimeout(refresh, 2500);
  });

  loadAll();
  timer = setInterval(refresh, 10000);
  return () => { clearInterval(timer); chart?.destroy?.(); };
}
