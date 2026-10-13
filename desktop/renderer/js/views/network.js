// Bereich "Netzwerk": OPNsense-Firewalls, Switches und andere Geräte. Abgefragt werden sie über einen
// Abfrage-Client – einen BOLZO-Client im selben Netz. Die Kacheln zeigen den Zustand, Klick öffnet die Geräteseite.
import { api } from '../api.js';
import { icon, esc, $, $$, modal, toast, confirmDialog, fmtDuration, fmtAgo, level, primaryIp, osShort } from '../ui.js';
import { addClientDialog } from './settings.js';

export const KIND = {
  opnsense: { label: 'OPNsense', long: 'OPNsense-Firewall', icon: 'firewall', group: 'Firewall', desc: 'Zustand, Gateways, Geräte im Netz, Dienste, Firewall, VPN und Updates über die OPNsense-API' },
  switch: { label: 'Switch', long: 'Switch', icon: 'ethernet', group: 'Switches', desc: 'Ports, VLANs, PoE und angeschlossene Geräte per SNMP – ohne SNMP nur Erreichbarkeit' },
  device: { label: 'Gerät', long: 'Netzwerkgerät', icon: 'box', group: 'Weitere Geräte', desc: 'Drucker, Access Point, NAS ... – Erreichbarkeit per Ping, optional SNMP' },
};
export const STATE = {
  online: { label: 'Online', dot: 'online', badge: 'good' },
  warning: { label: 'Warnung', dot: 'alert', badge: 'warning' },
  offline: { label: 'Offline', dot: 'offline', badge: 'critical' },
  unknown: { label: 'Unbekannt', dot: '', badge: '' },
};
const PROBE_MIN = '1.7.0';
export const probes = () => [...api.agents.values()].filter((a) => a.probe).sort((a, b) => a.name.localeCompare(b.name));
export const netProblems = () => [...api.net.values()].filter((d) => d.state === 'offline' || d.state === 'warning');
export const stateBadge = (d) => {
  const s = STATE[d.state] || STATE.unknown;
  return `<span class="badge ${s.badge}">${s.label}</span>`;
};
const versionAtLeast = (v, min) => {
  const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};
const meter = (v, kind = '', threshold = 90) => `<div class="px-meter"><span class="px-track"><i class="${kind} ${level(v, threshold)}" style="width:${Math.min(100, v || 0)}%"></i></span><b>${v == null ? '–' : `${Math.round(v)}%`}</b></div>`;

// Kleine Port-Leiste wie an der Gerätefront: grün = Verbindung
function strip(bits) {
  if (!bits?.length) return '';
  return `<div class="nd-strip" style="--n:${Math.ceil(bits.length / 2)}">${bits.map((b, i) => `<i class="${b ? 'up' : ''}" style="grid-row:${(i % 2) + 1}"></i>`).join('')}</div>`;
}

function card(d) {
  const k = KIND[d.kind] || KIND.device;
  const st = STATE[d.state] || STATE.unknown;
  const i = d.info || {};
  const t = api.settings.thresholds;
  let body = '';
  if (d.kind === 'opnsense' && d.info) {
    const memP = i.mem?.total ? (100 * i.mem.used) / i.mem.total : null;
    const gws = i.gateways || [];
    const down = gws.filter((g) => !g.ok);
    body = `<div class="ph-meters"><div><label>CPU</label>${meter(i.cpu, '', t.cpu)}</div><div><label>RAM</label>${meter(memP, 'mem', t.mem)}</div></div>
      <div class="nd-line">${gws.length ? `<span class="${down.length ? 'warn' : ''}">${icon('globe', 'sm')}${down.length ? `${esc(down.map((g) => g.name).join(', '))} gestört` : `${gws.length === 1 ? 'Gateway' : `${gws.length} Gateways`} online`}</span>` : ''}
        ${i.updates ? `<span class="badge accent">${icon('download')}${i.updates} Update${i.updates === 1 ? '' : 's'}</span>` : ''}</div>`;
  } else if (d.snmp && i.ports) {
    body = `${strip(i.strip)}<div class="nd-line"><span>${icon('ethernet', 'sm')}${i.ports.up} von ${i.ports.total} Ports aktiv</span>${i.uptime ? `<span class="muted">seit ${fmtDuration(i.uptime)}</span>` : ''}</div>`;
  } else if (d.state === 'online' || d.state === 'warning') {
    body = `<div class="nd-line"><span>${icon('activity', 'sm')}Antwortet in ${d.ms != null ? `${String(d.ms).replace('.', ',')} ms` : '–'}</span></div>`;
  }
  const sub = d.kind === 'opnsense' ? i.version || 'OPNsense' : d.snmp ? i.model || k.long : k.long;
  const err = d.state !== 'online' && d.error ? `<div class="nd-err">${icon(d.state === 'unknown' ? 'radar' : 'alert', 'sm')}<span>${esc(d.error)}</span></div>` : '';
  return `<button class="ph-card nd-card ${d.state}" data-id="${esc(d.id)}">
    <div class="ph-top"><span class="nd-ic">${icon(k.icon, 'sm')}</span><span class="ph-name">${esc(d.name)}</span><span class="ph-ver">${esc(sub)}</span><span class="grow"></span>
      <span class="badge ${st.badge}">${st.label}</span></div>
    ${body}${err}
    <div class="ph-foot"><span class="mono">${esc(d.host)}</span><span>${d.state === 'offline' && d.lastSeen ? `zuletzt ${fmtAgo(d.lastSeen)}` : `${icon('radar', 'sm')}${esc(d.probeName || 'kein Abfrage-Client')}`}</span></div>
  </button>`;
}

export function renderNetwork(root, { go }) {
  root.innerHTML = `<div class="nw">
    <div class="page-head"><h1>Netzwerk</h1><span class="sub" data-sub></span><span class="spacer"></span>
      <button class="btn ghost" data-probes>${icon('radar', 'sm')}Abfrage-Clients</button>
      <button class="btn primary" data-add>${icon('plus', 'sm')}Gerät hinzufügen</button></div>
    <div data-body></div></div>`;
  const view = $('.nw', root);
  let last = '';

  function draw() {
    const list = [...api.net.values()];
    const pr = probes();
    const on = list.filter((d) => d.state === 'online' || d.state === 'warning').length;
    $('[data-sub]', root).textContent = list.length ? `${list.length} Gerät${list.length === 1 ? '' : 'e'} · ${on} erreichbar${pr.length ? ` · Abfrage über ${pr.map((a) => a.name).join(', ')}` : ''}` : '';
    let html;
    if (!list.length) {
      const ok1 = pr.length > 0;
      html = `<div class="card nw-empty">
        <div class="nw-empty-ic">${icon('network')}</div>
        <h3>Firewall, Switches und andere Geräte im Blick</h3>
        <p>Netzwerkgeräte bekommen keinen Agent. BOLZO RMM fragt sie stattdessen über einen <b>Abfrage-Client</b> ab – einen BOLZO-Client im selben Netz, der die Anfragen (OPNsense-API, SNMP, Ping) für den Server ausführt.</p>
        <div class="nw-steps">
          <div class="nw-step ${ok1 ? 'done' : ''}"><span class="n">${ok1 ? icon('check', 'sm') : '1'}</span><div class="grow"><b>Abfrage-Client einrichten</b>
            <div class="muted">${ok1 ? `Freigegeben: ${esc(pr.map((a) => a.name).join(', '))}` : 'Am besten ein eigener kleiner Linux-Container (z.B. Debian-LXC mit 512 MB RAM) im Netz von Firewall und Switches. Agent wie bei jedem Client installieren und dann hier freigeben.'}</div></div>
            <button class="btn ${ok1 ? '' : 'primary'}" data-probes>${ok1 ? 'Ändern' : 'Einrichten'}</button></div>
          <div class="nw-step ${ok1 ? '' : 'dim'}"><span class="n">2</span><div class="grow"><b>Geräte hinzufügen</b>
            <div class="muted">OPNsense per API-Schlüssel, Switches per SNMP, alles andere per Ping.</div></div>
            <button class="btn ${ok1 ? 'primary' : ''}" data-add ${ok1 ? '' : 'disabled'}>${icon('plus', 'sm')}Gerät hinzufügen</button></div>
        </div></div>`;
    } else {
      html = Object.entries(KIND).map(([kind, k]) => {
        const mine = list.filter((d) => d.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
        return mine.length ? `<div class="nw-group"><h2>${esc(k.group)}<span>${mine.length}</span></h2><div class="ph-cards nd-cards">${mine.map(card).join('')}</div></div>` : '';
      }).join('');
    }
    // nur bei Änderungen neu zeichnen – sonst gehen Klicks verloren
    if (html !== last) $('[data-body]', root).innerHTML = last = html;
  }

  view.addEventListener('click', (e) => {
    if (e.target.closest('[data-probes]')) return probeDialog();
    if (e.target.closest('[data-add]')) return deviceDialog(null, { onSaved: (d) => go(`#/netdev/${d.id}`) });
    const c = e.target.closest('.nd-card');
    if (c) go(`#/netdev/${c.dataset.id}`);
  });
  draw();
  const off1 = api.on('net', draw);
  const off2 = api.on('agents', draw);
  const t = setInterval(draw, 30000); // "zuletzt vor ..." aktuell halten
  return () => { off1(); off2(); clearInterval(t); };
}

// ---------- Abfrage-Clients freigeben ----------
export function probeDialog() {
  let off = null;
  const m = modal({
    title: 'Abfrage-Clients',
    wide: true,
    onClose: () => off?.(),
    body: `<div class="nw-intro">${icon('radar')}<div>Ein Abfrage-Client fragt OPNsense, Switches und andere Geräte für den Server ab. Er muss die Geräte im Netz erreichen können – am besten ein eigener kleiner Linux-Container im selben Netz. Zugangsdaten (API-Schlüssel, SNMP-Community) bleiben auf dem Server und gehen nur mit der jeweiligen Anfrage an ihn.</div></div>
      <div class="card nw-probes" data-list></div>`,
    foot: `<button class="btn ghost" data-install>${icon('plus', 'sm')}Neuen Client installieren</button><span class="grow"></span><button class="btn primary" data-close>Fertig</button>`,
  });
  const list = $('[data-list]', m.el);
  const usedBy = (id) => [...api.net.values()].filter((d) => d.probeId === id);
  function draw() {
    const all = [...api.agents.values()].sort((a, b) => b.probe - a.probe || b.online - a.online || (a.platform === 'linux' ? -1 : 0) - (b.platform === 'linux' ? -1 : 0) || a.name.localeCompare(b.name));
    list.innerHTML = all.map((a) => {
      const n = usedBy(a.id).length;
      const old = !versionAtLeast(a.version, PROBE_MIN);
      return `<label class="nw-probe ${a.probe ? 'on' : ''}">
        <span class="switch"><input type="checkbox" data-id="${esc(a.id)}" ${a.probe ? 'checked' : ''}><span></span></span>
        <span class="dot ${a.online ? 'online' : 'offline'}"></span>
        <div class="grow"><div class="n">${esc(a.name)}</div><div class="muted">${esc([osShort(a), primaryIp(a)].filter(Boolean).join(' · '))}</div></div>
        ${old ? `<span class="badge warning" title="Abfragen brauchen Agent ${PROBE_MIN} – Agents aktualisieren sich automatisch">Agent ${esc(a.version || '?')} zu alt</span>` : ''}
        ${n ? `<span class="badge accent">fragt ${n} Gerät${n === 1 ? '' : 'e'} ab</span>` : ''}
      </label>`;
    }).join('') || '<div class="empty">Noch keine Clients</div>';
  }
  list.addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-id]');
    if (!cb) return;
    const id = cb.dataset.id;
    const n = usedBy(id).length;
    if (!cb.checked && n && !(await confirmDialog({ title: 'Freigabe entfernen?', text: `${n} Gerät${n === 1 ? ' wird' : 'e werden'} über diesen Client abgefragt und ${n === 1 ? 'ist' : 'sind'} danach ohne Abfrage, bis du ${n === 1 ? 'ihm' : 'ihnen'} einen anderen Abfrage-Client zuweist.`, okText: 'Entfernen', danger: true }))) {
      cb.checked = true;
      return;
    }
    try { await api.patch(`/api/agents/${id}`, { probe: cb.checked }); } catch (err) { toast(err.message, 'err'); cb.checked = !cb.checked; }
  });
  $('[data-install]', m.el).onclick = () => addClientDialog();
  draw();
  off = api.on('agents', draw);
}

// ---------- Gerät hinzufügen / bearbeiten ----------
export function deviceDialog(dev, { kind: kind0 = 'opnsense', onSaved } = {}) {
  const edit = !!dev;
  let kind = dev?.kind || kind0;
  let removeWrite = false;
  let trust = false;
  let kindChanged = false;
  let off = null;
  const m = modal({
    title: edit ? `${dev.name} bearbeiten` : 'Gerät hinzufügen',
    wide: true,
    closeOnBackdrop: false,
    onClose: () => off?.(),
    body: '<div class="nw-form" data-form></div>',
    foot: `${edit ? `<button class="btn danger" data-del>${icon('trash', 'sm')}Entfernen</button>` : ''}<span class="grow"></span>
      <button class="btn" data-test>${icon('activity', 'sm')}Verbindung testen</button><button class="btn" data-close>Abbrechen</button>
      <button class="btn primary" data-save>${edit ? 'Speichern' : 'Hinzufügen'}</button>`,
  });
  const form = $('[data-form]', m.el);
  const val = (k) => $(`[data-f="${k}"]`, form);

  function draw() {
    const pr = probes();
    // Werte beim Umschalten der Geräteart behalten
    const keep = {};
    for (const x of $$('[data-f]', form)) keep[x.dataset.f] = x.type === 'checkbox' ? x.checked : x.value;
    if (kindChanged) delete keep.snmpOn; // Switch: SNMP an, sonstiges Gerät: aus
    kindChanged = false;
    const v = (k, d = '') => keep[k] ?? d;
    const s = dev?.snmp;
    const snmpOn = keep.snmpOn ?? (edit ? !!s : kind === 'switch');
    const probeSel = v('probeId', dev?.probeId || pr.find((a) => a.online)?.id || pr[0]?.id || '');
    form.innerHTML = `
      ${edit ? '' : `<div class="nw-kinds">${Object.entries(KIND).map(([k, x]) => `<button type="button" class="nw-kind ${k === kind ? 'on' : ''}" data-kind="${k}">${icon(x.icon)}<b>${x.long}</b><span>${x.desc}</span></button>`).join('')}</div>`}
      ${pr.length ? '' : `<div class="pve-note">${icon('alert', 'sm')}Noch kein Abfrage-Client freigegeben. <button class="btn sm" type="button" data-probes style="margin-left:auto">Abfrage-Clients</button></div>`}
      <div class="form-grid">
        <div class="field"><label>Name</label><input class="input" data-f="name" value="${esc(v('name', dev?.name || ''))}" placeholder="${kind === 'opnsense' ? 'z.B. Firewall' : kind === 'switch' ? 'z.B. Switch Keller' : 'z.B. Drucker Büro'}"></div>
        <div class="field"><label>Adresse</label><input class="input mono" data-f="host" value="${esc(v('host', dev?.host || ''))}" placeholder="IP-Adresse oder Hostname"></div>
        <div class="field"><label>Abfrage-Client</label><select class="select" data-f="probeId">${pr.map((a) => `<option value="${esc(a.id)}" ${a.id === probeSel ? 'selected' : ''}>${esc(a.name)}${a.online ? '' : ' (offline)'}</option>`).join('') || '<option value="">– keiner freigegeben –</option>'}</select></div>
        <div class="field"><label>Weboberfläche (optional)</label><input class="input mono" data-f="webUrl" value="${esc(v('webUrl', dev && dev.webUrl !== defaultWeb(dev) ? dev.webUrl : ''))}" placeholder="${kind === 'opnsense' ? 'wie API-Adresse' : 'http://<Adresse>'}"></div>
      </div>
      ${kind === 'opnsense' ? `
        <div class="nw-sec"><div class="nw-sec-h">${icon('key', 'sm')}API-Zugang</div>
          <div class="form-grid">
            <div class="field"><label>API-Adresse</label><input class="input mono" data-f="url" value="${esc(v('url', dev?.opn?.url || ''))}" placeholder="https://<Adresse>"><div class="hint">Nur nötig, wenn die Weboberfläche auf einem anderen Port läuft</div></div>
            <div class="field"><label>API-Key</label><input class="input mono" data-f="key" value="${esc(v('key'))}" placeholder="${edit && dev.opn?.keySet ? 'unverändert' : ''}" autocomplete="off" spellcheck="false"></div>
            <div class="field"><label>API-Secret</label><input class="input mono" type="password" data-f="secret" value="${esc(v('secret'))}" placeholder="${edit && dev.opn?.keySet ? 'unverändert' : ''}" autocomplete="new-password"></div>
          </div>
          <div class="hint nw-hint">So bekommst du den Schlüssel: in der OPNsense unter <b>System → Zugang → Benutzer</b> einen Benutzer bearbeiten (oder einen eigenen anlegen, z.B. „bolzo“) und bei <b>API-Schlüssel</b> auf „+“ klicken – der Browser lädt eine Datei mit <span class="mono">key</span> und <span class="mono">secret</span> herunter. Der Benutzer braucht Rechte für alles, was hier angezeigt oder geändert werden soll – am einfachsten Mitglied der Gruppe <b>admins</b>.</div>
          ${edit && dev.opn?.cert ? `<div class="nw-cert ${trust ? 'reset' : ''}">${icon(dev.opn.cert.trusted ? 'shield' : 'lock', 'sm')}<div class="grow">
              <div>${dev.opn.cert.trusted ? 'Gültiges Zertifikat' : 'Selbst signiertes Zertifikat – beim ersten Kontakt gemerkt'} · ${esc(dev.opn.cert.subject || '')}</div>
              <div class="mono muted" title="SHA-256-Fingerabdruck">${esc(dev.opn.cert.fingerprint || '')}</div></div>
              ${dev.opn.cert.trusted ? '' : `<button class="btn sm" type="button" data-trust ${trust ? 'disabled' : ''}>${trust ? 'Wird neu gemerkt' : 'Neu vertrauen'}</button>`}</div>` : ''}
        </div>` : `
        <div class="nw-sec"><label class="nw-sec-h nw-toggle"><span class="switch"><input type="checkbox" data-f="snmpOn" ${snmpOn ? 'checked' : ''}><span></span></span>SNMP verwenden<span class="muted">– Ports, VLANs, PoE und angeschlossene Geräte</span></label>
          ${snmpOn ? `<div class="form-grid">
            <div class="field"><label>Version</label><select class="select" data-f="version"><option value="2c" ${v('version', s?.version || '2c') === '2c' ? 'selected' : ''}>v2c (empfohlen)</option><option value="1" ${v('version', s?.version) === '1' ? 'selected' : ''}>v1 (sehr alte Geräte)</option></select></div>
            <div class="field"><label>Community (lesen)</label><input class="input mono" data-f="community" value="${esc(v('community', edit ? '' : 'public'))}" placeholder="${edit && s ? 'unverändert' : 'public'}" autocomplete="off" spellcheck="false"></div>
            <div class="field"><label>Schreib-Community (optional)</label>
              ${edit && s?.write && !removeWrite ? `<div class="row" style="gap:8px"><input class="input mono" data-f="writeCommunity" value="${esc(v('writeCommunity'))}" placeholder="gespeichert – unverändert" autocomplete="off"><button class="btn sm ghost" type="button" data-rmwrite title="Schreibzugriff entfernen">${icon('x', 'sm')}</button></div>`
                : `<input class="input mono" data-f="writeCommunity" value="${esc(v('writeCommunity'))}" placeholder="${removeWrite ? 'wird entfernt' : 'leer = nur anzeigen'}" autocomplete="off">`}
              <div class="hint">Nur nötig, um Ports oder PoE zu schalten</div></div>
            <div class="field"><label>Port</label><input class="input mono" data-f="port" value="${esc(v('port', String(s?.port || 161)))}"></div>
          </div>
          <div class="hint nw-hint">${kind === 'switch' ? '<b>HP ProCurve</b> (z.B. 2510, 2530, 2610): SNMP ist ab Werk an, Community meist „public“ (prüfen mit <span class="mono">show snmp-server</span>). <b>HP 1810/1820/1920</b>: SNMP erst in der Weboberfläche aktivieren. Kommt keine Antwort, kann der Switch wahrscheinlich kein SNMP oder es ist aus – dann SNMP hier ausschalten, der Switch wird nur per Ping überwacht.' : 'SNMP ist optional – ohne wird das Gerät nur per Ping überwacht.'}</div>` : ''}
        </div>`}
      <div class="nw-result" data-result hidden></div>`;
    const t = $('[data-trust]', form);
    if (t) t.onclick = () => { trust = true; draw(); };
    const rw = $('[data-rmwrite]', form);
    if (rw) rw.onclick = () => { removeWrite = true; draw(); };
    const pb = $('[data-probes]', form);
    if (pb) pb.onclick = () => probeDialog();
    const on = $('[data-f="snmpOn"]', form);
    if (on) on.onchange = draw;
    $$('[data-kind]', form).forEach((b) => (b.onclick = () => { kindChanged = kind !== b.dataset.kind; kind = b.dataset.kind; draw(); }));
  }
  const defaultWeb = (d) => (d?.kind === 'opnsense' && d.opn?.url ? d.opn.url : `http://${d?.host}`);

  function body() {
    const b = { kind, name: val('name').value.trim(), host: val('host').value.trim(), probeId: val('probeId').value, webUrl: val('webUrl').value.trim() };
    if (kind === 'opnsense') b.opn = { url: val('url').value.trim(), key: val('key').value.trim(), secret: val('secret').value.trim(), ...(trust ? { trust: true } : {}) };
    else if (val('snmpOn')?.checked) {
      b.snmp = { version: val('version').value, community: val('community').value.trim(), port: Number(val('port').value) || 161 };
      const w = val('writeCommunity').value.trim();
      if (removeWrite && !w) b.snmp.writeCommunity = null;
      else if (w) b.snmp.writeCommunity = w;
    } else b.snmp = { enabled: false };
    return b;
  }
  const result = (ok, html) => {
    const r = $('[data-result]', form);
    r.hidden = false;
    r.className = `nw-result ${ok ? 'ok' : 'err'}`;
    r.innerHTML = `${icon(ok ? 'check' : 'alert', 'sm')}<div>${html}</div>`;
  };
  const busy = (btn, on, text) => {
    btn.disabled = on;
    if (on) { btn.dataset.html = btn.innerHTML; btn.innerHTML = `${icon('refresh', 'sm spin')}${text}`; } else if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
  };

  $('[data-test]', m.el).onclick = async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Teste ...');
    try {
      const r = await api.post('/api/net/test', { ...body(), ...(edit ? { id: dev.id } : {}) });
      const extra = [];
      if (r.ping) extra.push(r.ping.alive ? `Ping ${String(r.ping.ms).replace('.', ',')} ms` : 'kein Ping (evtl. gesperrt)');
      if (r.canWrite === true) extra.push('Schreibzugriff ok');
      if (r.canWrite === false) extra.push('<span class="warn">Schreib-Community wird abgelehnt</span>');
      if (r.cert && !r.cert.trusted) extra.push(`selbst signiertes Zertifikat (${esc(r.cert.fingerprint.slice(0, 23))}…) wird gemerkt`);
      result(true, `<b>${esc(r.text)}</b>${extra.length ? `<div class="muted">${extra.join(' · ')}</div>` : ''}`);
    } catch (err) {
      result(false, esc(err.message));
    }
    busy(btn, false);
  };
  $('[data-save]', m.el).onclick = async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Speichere ...');
    try {
      const d = edit ? await api.patch(`/api/net/${dev.id}`, body()) : await api.post('/api/net', body());
      toast(edit ? 'Gespeichert' : `${d.name} hinzugefügt`);
      m.close();
      onSaved?.(d);
    } catch (err) {
      result(false, esc(err.message));
      busy(btn, false);
    }
  };
  const del = $('[data-del]', m.el);
  if (del) {
    del.onclick = async () => {
      if (!(await confirmDialog({ title: `${dev.name} entfernen?`, text: 'Das Gerät wird aus BOLZO RMM entfernt. Am Gerät selbst ändert sich nichts.', okText: 'Entfernen', danger: true }))) return;
      try {
        await api.del(`/api/net/${dev.id}`);
        toast('Gerät entfernt');
        m.close();
        location.hash = '#/network';
      } catch (err) { toast(err.message, 'err'); }
    };
  }
  draw();
  $('[data-f="name"]', form)?.focus();
  // Abfrage-Client im Dialog freigegeben: Auswahl auffrischen
  off = api.on('agents', () => {
    const sel = val('probeId');
    if (sel && [...sel.options].filter((o) => o.value).length !== probes().length) draw();
  });
}
