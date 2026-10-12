// Proxmox: Gäste eines Proxmox-Hosts verwalten, Clients ihrer VM/ihrem Container zuordnen
// und die Konsole öffnen – VMs als Bildschirm (noVNC), Container als echtes Terminal.
import RFB from '../../node_modules/@novnc/novnc/core/rfb.js';
import { api, LS } from './api.js';
import { icon, esc, el, $, $$, modal, toast, confirmDialog, fmtBytes, fmtDuration, level, tagHtml, osShort } from './ui.js';
import { RemoteTerminal } from './terminal.js';

export const kind = (type) => (type === 'lxc' ? 'Container' : 'VM');
const OPS = {
  start: { label: 'Starten', icon: 'play', done: 'wird gestartet' },
  shutdown: { label: 'Herunterfahren', icon: 'power', done: 'wird heruntergefahren', confirm: 'Das Gastsystem wird sauber heruntergefahren.' },
  reboot: { label: 'Neu starten', icon: 'refresh', done: 'wird neu gestartet', confirm: 'Das Gastsystem wird neu gestartet.' },
  stop: { label: 'Ausschalten (hart)', icon: 'stop', done: 'wurde ausgeschaltet', confirm: 'Wie Stecker ziehen: nicht gespeicherte Daten gehen verloren. Nur nutzen, wenn der Gast nicht mehr reagiert.' },
};

export const proxmoxHosts = () => [...api.agents.values()].filter((a) => a.info?.proxmox);

// ---------- Gäste-Listen zwischenspeichern ----------
// Alle Ansichten (Übersicht, Proxmox-Seite, Kacheln, Gast-Seite) teilen sich eine Anfrage je Host.
// Beim Umschalten wird sofort der letzte Stand gezeigt und im Hintergrund aktualisiert.
const guestCache = new Map(); // hostId -> { at, data, promise }
export const cachedGuests = (hostId) => guestCache.get(hostId)?.data || null;
export function fetchGuests(hostId, maxAge = 0) {
  let c = guestCache.get(hostId);
  if (!c) guestCache.set(hostId, (c = { at: 0, data: null, promise: null }));
  if (c.promise) return c.promise;
  if (c.data && Date.now() - c.at < maxAge) return Promise.resolve(c.data);
  c.promise = api.get(`/api/agents/${hostId}/pve/guests`)
    .then((d) => { c.data = d; c.at = Date.now(); api.emit('pve.guests', hostId); return d; })
    .finally(() => { c.promise = null; });
  return c.promise;
}
// Regelmäßig aktualisieren, aber nicht, solange das Fenster minimiert/verdeckt ist
export function poll(fn, ms) {
  const t = setInterval(() => !document.hidden && fn(), ms);
  const vis = () => !document.hidden && fn();
  document.addEventListener('visibilitychange', vis);
  return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
}
const macsOf = (a) => new Set((a.info?.interfaces || []).map((i) => (i.mac || '').toLowerCase()).filter((m) => m && m !== '00:00:00:00:00:00'));

// ---------- Aktionen ----------
export async function pvePower({ hostId, vmid, type, name }, op) {
  const o = OPS[op];
  const title = `${name || `${kind(type)} ${vmid}`}: ${o.label}?`;
  if (o.confirm && !(await confirmDialog({ title, text: o.confirm, okText: o.label, danger: op !== 'reboot' }))) return false;
  try {
    await api.post(`/api/agents/${hostId}/pve/power`, { vmid, type, name, op });
    toast(`${name || `${kind(type)} ${vmid}`} ${o.done}`);
    return true;
  } catch (e) {
    toast(e.message, 'err');
    return false;
  }
}

// In der Desktop-App öffnet jede Konsole ein eigenes Fenster (console.html), sonst als Überlagerung
export function openConsole(g) {
  if (window.rmmDesk?.openConsole) {
    const { hostId, vmid, type, name, label, hostName } = g;
    window.rmmDesk.openConsole({ hostId, vmid, type, name, label, hostName });
    return;
  }
  return mountConsole(g);
}

export function mountConsole(g, { standalone = false } = {}) {
  return g.type === 'lxc' ? openContainerConsole(g, standalone) : openVmConsole(g, standalone);
}

function popupMenu(anchor, items, onPick) {
  const r = anchor.getBoundingClientRect();
  const menu = el(`<div class="menu" style="top:${r.bottom + 6}px;right:${window.innerWidth - r.right}px">${items.map((i) => `<button class="menu-item ${i.danger ? 'danger' : ''}" data-k="${i.k}">${icon(i.icon, 'sm')}${esc(i.label)}</button>`).join('')}</div>`);
  document.body.append(menu);
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside); };
  const outside = (e) => !menu.contains(e.target) && close();
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    close();
    onPick(k);
  };
}

// ---------- Konsolen-Fenster ----------
function consoleFrame(g, extraBar = '', standalone = false) {
  const overlay = el(`<div class="console-overlay ${standalone ? 'standalone' : ''}">
    <div class="console-bar">
      ${standalone ? '' : `<button class="btn sm" data-close title="Konsole schließen">${icon('back', 'sm')}Schließen</button>`}
      <span class="dot" data-dot></span>
      <div class="console-title"><b>${esc(g.label || g.name || `${kind(g.type)} ${g.vmid}`)}</b><span class="muted">${kind(g.type)} ${g.vmid}${g.hostName ? ` · ${esc(g.hostName)}` : ''}</span></div>
      <span class="muted console-status" data-status>Verbinde ...</span>
      <span class="spacer"></span>
      ${extraBar}
      <button class="btn sm icon-only" data-full title="Vollbild an/aus">${icon('monitor', 'sm')}</button>
      <button class="btn sm icon-only" data-power title="Proxmox: Starten, Herunterfahren, Neustart ...">${icon('power', 'sm')}</button>
    </div>
    <div class="console-screen" data-screen></div>
  </div>`);
  document.body.append(overlay);
  const status = (text, state) => {
    $('[data-status]', overlay).textContent = text;
    $('[data-dot]', overlay).className = `dot ${state || ''}`;
  };
  $('[data-full]', overlay).onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  $('[data-power]', overlay).onclick = (e) => popupMenu(e.currentTarget, Object.entries(OPS).map(([k, o]) => ({ k, label: `Proxmox: ${o.label}`, icon: o.icon, danger: k === 'stop' })), (op) => pvePower(g, op));
  // Schließen: in eigenem Fenster schließt das Fenster selbst (siehe onClose)
  const onClose = (fn) => {
    if (standalone) window.addEventListener('beforeunload', fn);
    else $('[data-close]', overlay).onclick = fn;
  };
  return { overlay, screen: $('[data-screen]', overlay), status, onClose };
}

async function openVmConsole(g, standalone) {
  let info;
  try {
    info = await api.post(`/api/agents/${g.hostId}/pve/console`, { vmid: g.vmid, type: g.type, name: g.name });
  } catch (e) {
    if (!standalone) return toast(e.message, 'err');
    const { status } = consoleFrame(g, '', true);
    return status(e.message, 'offline');
  }
  const layout = LS.get('vncLayout', 'de');
  const { overlay, screen, status, onClose } = consoleFrame(g, `
    <select class="select sm" data-layout title="Tastaturlayout der VM (für „Text einfügen“)">
      ${Object.entries(LAYOUTS).map(([k, l]) => `<option value="${k}" ${k === layout ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <button class="btn sm" data-paste title="Text in die VM tippen lassen">${icon('copy', 'sm')}Text einfügen</button>
    <button class="btn sm" data-cad>Strg+Alt+Entf</button>
    <button class="btn sm" data-scale title="Bild an das Fenster anpassen oder in Originalgröße (1:1) anzeigen">${icon('grid', 'sm')}<span>Anpassen</span></button>`, standalone);

  const url = api.server.replace(/^http/, 'ws') + `/ws/console?token=${encodeURIComponent(api.token)}&sid=${encodeURIComponent(info.sid)}`;
  const rfb = new RFB(screen, url, { credentials: info.password ? { password: info.password } : undefined });
  rfb.scaleViewport = LS.get('vncScale', true);
  rfb.resizeSession = false;
  rfb.background = '#000';
  let closed = false;
  rfb.addEventListener('connect', () => { status('Verbunden', 'online'); rfb.focus(); });
  rfb.addEventListener('desktopname', (e) => e.detail.name && status(`Verbunden · ${e.detail.name}`, 'online'));
  rfb.addEventListener('credentialsrequired', () => status('VNC verlangt ein Passwort – Konsole bitte neu öffnen', 'offline'));
  rfb.addEventListener('securityfailure', (e) => status(`Anmeldung abgelehnt: ${e.detail.reason || e.detail.status}`, 'offline'));
  rfb.addEventListener('disconnect', (e) => { if (!closed) status(e.detail.clean ? 'Verbindung beendet' : 'Verbindung abgebrochen', 'offline'); });

  const scaleBtn = $('[data-scale] span', overlay);
  const drawScale = () => (scaleBtn.textContent = rfb.scaleViewport ? 'Anpassen' : '1:1');
  drawScale();
  $('[data-scale]', overlay).onclick = () => {
    rfb.scaleViewport = !rfb.scaleViewport;
    rfb.clipViewport = !rfb.scaleViewport;
    LS.set('vncScale', rfb.scaleViewport);
    drawScale();
  };
  $('[data-cad]', overlay).onclick = () => { rfb.sendCtrlAltDel(); rfb.focus(); };
  $('[data-layout]', overlay).onchange = (e) => LS.set('vncLayout', e.target.value);
  $('[data-paste]', overlay).onclick = () => pasteDialog(rfb, () => $('[data-layout]', overlay).value);
  onClose(() => {
    closed = true;
    try { rfb.disconnect(); } catch {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    overlay.remove();
  });
}

function openContainerConsole(g, standalone) {
  const { overlay, screen, status, onClose } = consoleFrame(g, `<span class="muted" style="font-size:12px">Markieren + Strg+C = kopieren · Strg+V oder Rechtsklick = einfügen</span>`, standalone);
  screen.classList.add('term-host');
  const term = new RemoteTerminal(screen, g.hostId, {
    extra: { lxc: g.vmid, name: g.name },
    onStatus: (s, m) => {
      if (s === 'open') status(`Verbunden · ${m?.shell || ''}`, 'online');
      else if (s === 'closed') status('Sitzung beendet', 'offline');
      else status('Verbinde ...', '');
    },
  });
  term.connect();
  onClose(() => {
    term.dispose();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    overlay.remove();
  });
}

// ---------- Text in die VM tippen ----------
// VNC kennt keine gemeinsame Zwischenablage: Der Text wird als Tastendrücke gesendet.
// Dafür muss das Tastaturlayout der VM bekannt sein (sonst werden z.B. y und z vertauscht).
const LAYOUTS = { de: 'Deutsch', 'de-nodead': 'Deutsch (ohne Tottasten)', us: 'Englisch (US)' };

function keymap(layout) {
  const m = new Map(); // Zeichen -> [code, shift, altgr, tot]
  const set = (ch, code, shift = 0, altgr = 0, dead = 0) => ch && !m.has(ch) && m.set(ch, [code, shift, altgr, dead]);
  const de = layout !== 'us';
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(97 + i);
    const code = de && c === 'y' ? 'KeyZ' : de && c === 'z' ? 'KeyY' : `Key${c.toUpperCase()}`;
    set(c, code);
    set(c.toUpperCase(), code, 1);
  }
  for (let d = 0; d <= 9; d++) set(String(d), `Digit${d}`);
  set(' ', 'Space'); set('\n', 'Enter'); set('\t', 'Tab');
  const rows = de
    ? [['Digit1', '', '!'], ['Digit2', '', '"', '²'], ['Digit3', '', '§', '³'], ['Digit4', '', '$'], ['Digit5', '', '%'], ['Digit6', '', '&'],
      ['Digit7', '', '/', '{'], ['Digit8', '', '(', '['], ['Digit9', '', ')', ']'], ['Digit0', '', '=', '}'], ['Minus', 'ß', '?', '\\'],
      ['BracketLeft', 'ü', 'Ü'], ['BracketRight', '+', '*', '~'], ['Backslash', '#', "'"], ['Semicolon', 'ö', 'Ö'], ['Quote', 'ä', 'Ä'],
      ['Comma', ',', ';'], ['Period', '.', ':'], ['Slash', '-', '_'], ['IntlBackslash', '<', '>', '|'], ['KeyQ', '', '', '@'], ['KeyE', '', '', '€'], ['KeyM', '', '', 'µ']]
    : [['Digit1', '', '!'], ['Digit2', '', '@'], ['Digit3', '', '#'], ['Digit4', '', '$'], ['Digit5', '', '%'], ['Digit6', '', '^'], ['Digit7', '', '&'],
      ['Digit8', '', '*'], ['Digit9', '', '('], ['Digit0', '', ')'], ['Backquote', '`', '~'], ['Minus', '-', '_'], ['Equal', '=', '+'],
      ['BracketLeft', '[', '{'], ['BracketRight', ']', '}'], ['Backslash', '\\', '|'], ['Semicolon', ';', ':'], ['Quote', "'", '"'],
      ['Comma', ',', '<'], ['Period', '.', '>'], ['Slash', '/', '?']];
  for (const [code, plain, shifted, altgr] of rows) {
    set(plain, code);
    set(shifted, code, 1);
    set(altgr, code, 0, 1);
  }
  if (de) { // Tottasten: Taste, dann Leertaste ergibt das Zeichen selbst
    const dead = layout === 'de' ? 1 : 0;
    set('^', 'Backquote', 0, 0, dead); set('°', 'Backquote', 1);
    set('´', 'Equal', 0, 0, dead); set('`', 'Equal', 1, 0, dead);
  }
  return m;
}

const keysymOf = (ch) => ({ '\n': 0xff0d, '\t': 0xff09 })[ch] ?? (ch.codePointAt(0) < 0x100 ? ch.codePointAt(0) : 0x1000000 + ch.codePointAt(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeText(rfb, text, layout, { onProgress, isCancelled }) {
  const map = keymap(layout);
  const chars = [...text.replace(/\r\n?/g, '\n')];
  const skipped = new Set();
  for (let i = 0; i < chars.length; i++) {
    if (isCancelled()) break;
    const ch = chars[i];
    const k = map.get(ch);
    if (!k) { skipped.add(ch); continue; }
    const [code, shift, altgr, dead] = k;
    if (shift) rfb.sendKey(0xffe1, 'ShiftLeft', true);
    if (altgr) rfb.sendKey(0xfe03, 'AltRight', true);
    rfb.sendKey(keysymOf(ch), code, true);
    rfb.sendKey(keysymOf(ch), code, false);
    if (altgr) rfb.sendKey(0xfe03, 'AltRight', false);
    if (shift) rfb.sendKey(0xffe1, 'ShiftLeft', false);
    if (dead) rfb.sendKey(0x20, 'Space');
    // etwas Zeit lassen, damit langsame Gäste (BIOS, Installer) keine Tasten verlieren
    await sleep(ch === '\n' ? 40 : 8);
    if (i % 20 === 0) onProgress(i, chars.length);
  }
  onProgress(chars.length, chars.length);
  return [...skipped];
}

async function pasteDialog(rfb, getLayout) {
  let clip = '';
  try { clip = await navigator.clipboard.readText(); } catch {}
  const { el: back, close } = modal({
    title: 'Text in die VM einfügen',
    wide: true,
    body: `<div class="field"><label>Text (wird Zeichen für Zeichen eingetippt)</label>
        <textarea class="textarea mono" style="min-height:180px" data-text></textarea>
        <div class="hint">Tastaturlayout der VM: <b>${esc(LAYOUTS[getLayout()])}</b> (oben in der Leiste umstellbar). Vorher in der VM an die richtige Stelle klicken.</div></div>
      <div class="muted" data-prog style="font-size:12.5px;margin-top:8px"></div>`,
    foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-go>${icon('play', 'sm')}Eintippen</button>`,
  });
  const ta = $('[data-text]', back);
  ta.value = clip;
  ta.focus();
  let cancelled = false;
  $$('[data-close]', back).forEach((b) => b.addEventListener('click', () => (cancelled = true)));
  $('[data-go]', back).onclick = async (e) => {
    const text = ta.value;
    if (!text) return;
    e.currentTarget.disabled = true;
    ta.disabled = true;
    const skipped = await typeText(rfb, text, getLayout(), {
      isCancelled: () => cancelled,
      onProgress: (n, total) => ($('[data-prog]', back).textContent = `Tippe ... ${n} von ${total} Zeichen`),
    });
    close();
    rfb.focus();
    if (skipped.length) toast(`Eingefügt – nicht tippbar und ausgelassen: ${skipped.map((c) => JSON.stringify(c)).join(' ')}`, 'err');
    else if (!cancelled) toast('Text eingefügt');
  };
}

// ---------- Zuordnung eines Clients zu seiner VM / seinem Container ----------
export async function assignDialog(agent) {
  const hosts = proxmoxHosts().filter((h) => h.id !== agent.id);
  if (!hosts.length) {
    return modal({
      title: 'Proxmox-Zuordnung',
      body: `<div class="empty" style="padding:20px">${icon('server')}<h3>Kein Proxmox-Host gefunden</h3>
        <div>Installiere den BOLZO-Agent auch auf dem Proxmox-Server (ab Agent 1.3.0 wird er automatisch erkannt).</div></div>`,
    });
  }
  const cur = agent.pve;
  const { el: back, close } = modal({
    title: `${agent.name}: Proxmox-Zuordnung`,
    wide: true,
    body: `<div class="field"><label>Proxmox-Host</label>
        <select class="select" data-host>${hosts.map((h) => `<option value="${h.id}" ${cur?.hostId === h.id ? 'selected' : ''}>${esc(h.name)}${h.online ? '' : ' (offline)'}</option>`).join('')}</select></div>
      <div data-list style="margin-top:12px"></div>`,
    foot: `${cur ? `<button class="btn danger" data-remove style="margin-right:auto">${icon('trash', 'sm')}Zuordnung entfernen</button>` : ''}
      <button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>`,
  });
  const list = $('[data-list]', back);
  const mine = macsOf(agent);
  let choice = cur ? { vmid: cur.vmid, type: cur.type } : null;

  async function load() {
    const host = api.agents.get($('[data-host]', back).value);
    if (!host.online) {
      list.innerHTML = `<div class="muted" style="margin-bottom:10px">Der Host ist offline – ID von Hand eintragen:</div>
        <div class="row" style="gap:10px"><select class="select" style="width:auto" data-type><option value="qemu">VM</option><option value="lxc">Container</option></select>
        <input class="input" style="width:140px" placeholder="ID, z.B. 105" data-vmid value="${choice?.vmid || ''}"></div>`;
      if (choice) $('[data-type]', list).value = choice.type;
      const upd = () => (choice = { vmid: Number($('[data-vmid]', list).value), type: $('[data-type]', list).value });
      $('[data-vmid]', list).oninput = upd;
      $('[data-type]', list).onchange = upd;
      return;
    }
    list.innerHTML = `<div class="muted">Lade VMs und Container ...</div>`;
    try {
      const { guests } = await fetchGuests(host.id, 10000);
      const match = (g) => g.macs.some((m) => mine.has(m));
      if (!choice || cur?.hostId !== host.id) {
        const auto = guests.filter(match);
        choice = auto.length === 1 ? { vmid: auto[0].vmid, type: auto[0].type } : null;
      }
      list.innerHTML = `<div class="card table-wrap" style="max-height:46vh;overflow:auto"><table class="tbl"><thead><tr><th></th><th>ID</th><th>Name</th><th>Typ</th><th>Status</th><th></th></tr></thead><tbody>
        ${guests.filter((g) => !g.template).map((g) => {
          const taken = g.agentId && g.agentId !== agent.id ? api.agents.get(g.agentId)?.name : '';
          const on = choice?.vmid === g.vmid && choice?.type === g.type;
          return `<tr class="click" data-g="${g.type}:${g.vmid}" ${taken ? 'style="opacity:.5"' : ''}>
            <td><input type="radio" name="pveg" ${on ? 'checked' : ''} ${taken ? 'disabled' : ''}></td>
            <td class="num">${g.vmid}</td><td style="font-weight:500">${esc(g.name)}</td><td class="muted">${kind(g.type)}</td>
            <td>${statusBadge(g.status)}</td>
            <td>${match(g) ? `<span class="badge good">${icon('check')}MAC passt</span>` : taken ? `<span class="muted" style="font-size:12px">${esc(taken)}</span>` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="6"><div class="empty">Keine VMs oder Container</div></td></tr>'}</tbody></table></div>
        <div class="hint" style="margin-top:8px">„MAC passt“: Die Netzwerkkarte der VM hat dieselbe MAC-Adresse wie ${esc(agent.name)} – das ist mit hoher Wahrscheinlichkeit der richtige Eintrag.</div>`;
      $$('tr[data-g]', list).forEach((tr) => {
        tr.onclick = () => {
          const radio = $('input', tr);
          if (radio.disabled) return;
          radio.checked = true;
          const [type, vmid] = tr.dataset.g.split(':');
          choice = { type, vmid: Number(vmid) };
        };
      });
    } catch (e) {
      list.innerHTML = `<div class="err-text">${esc(e.message)}</div>`;
    }
  }
  $('[data-host]', back).onchange = () => { choice = null; load(); };
  $('[data-save]', back).onclick = async () => {
    if (!choice?.vmid) return toast('Bitte eine VM oder einen Container auswählen', 'err');
    try {
      await api.patch(`/api/agents/${agent.id}`, { pve: { hostId: $('[data-host]', back).value, ...choice } });
      toast('Zuordnung gespeichert');
      close();
    } catch (e) { toast(e.message, 'err'); }
  };
  const rm = $('[data-remove]', back);
  if (rm) {
    rm.onclick = async () => {
      try {
        await api.patch(`/api/agents/${agent.id}`, { pve: null });
        toast('Zuordnung entfernt');
        close();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
  load();
}

// Betriebssystem laut Proxmox-Konfiguration (ostype)
export const OSTYPES = {
  l26: 'Linux', l24: 'Linux 2.4', win11: 'Windows 11', win10: 'Windows 10', win8: 'Windows 8', win7: 'Windows 7', wvista: 'Windows Vista',
  wxp: 'Windows XP', w2k: 'Windows 2000', w2k3: 'Windows 2003', w2k8: 'Windows 2008', solaris: 'Solaris', other: 'Andere',
  debian: 'Debian', ubuntu: 'Ubuntu', alpine: 'Alpine', centos: 'CentOS', fedora: 'Fedora', archlinux: 'Arch Linux',
  opensuse: 'openSUSE', gentoo: 'Gentoo', nixos: 'NixOS', devuan: 'Devuan', unmanaged: '',
};

export function miniBar(pct, kind = '', threshold = 90) {
  if (pct == null || !isFinite(pct)) return '<span class="muted">–</span>';
  const text = pct < 10 ? pct.toFixed(1).replace('.', ',') : Math.round(pct);
  return `<span class="mini-meter"><span class="meter-track"><span class="meter-fill ${kind} ${level(pct, threshold)}" style="display:block;width:${Math.min(100, pct)}%"></span></span><span>${text}%</span></span>`;
}

export const statusBadge = (s) => (s === 'running'
  ? `<span class="badge good">läuft</span>`
  : s === 'stopped' ? `<span class="badge">aus</span>` : `<span class="badge warning">${esc(s || '?')}</span>`);

// ---------- Tab "Proxmox" beim Host ----------
// Gäste-Tabelle für einen Host oder – mit einer Liste von Host-IDs – für mehrere Server zusammen
export function renderProxmoxTab(body, hostId, { compact = false } = {}) {
  const hostIds = Array.isArray(hostId) ? hostId : [hostId];
  const multi = Array.isArray(hostId);
  const hostOf = (id) => api.agents.get(id);
  const cols = multi ? 13 : 12;
  let filter = '';
  body.innerHTML = `
    <div class="toolbar">
      <div class="search" style="width:240px">${icon('search', 'sm')}<input class="input" placeholder="Name, ID, IP, Tag ..." data-gfilter></div>
      <span class="muted" style="font-size:13px" data-ver></span>
      <span class="spacer grow"></span>
      <button class="btn" data-auto title="Clients anhand der MAC-Adresse ihrer VM/ihrem Container zuordnen">${icon('link', 'sm')}Automatisch zuordnen</button>
      <button class="btn" data-refresh>${icon('refresh', 'sm')}Aktualisieren</button>
    </div>
    <div class="card table-wrap"><table class="tbl"><thead><tr>
      <th>ID</th><th>Name</th>${multi ? '<th>Server</th>' : ''}<th>Typ</th><th>Status</th><th>IP-Adresse</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Netzwerk</th><th>Laufzeit</th><th>BOLZO-Client</th><th></th>
    </tr></thead><tbody><tr><td colspan="${cols}"><div class="empty">Lade ...</div></td></tr></tbody></table></div>`;
  const p = hostOf(hostIds[0])?.info?.proxmox;
  $('[data-ver]', body).textContent = compact || multi || !p ? '' : `Proxmox VE ${p.version || ''} · Knoten ${p.node}`;
  let guests = [];
  let failed = [];
  let lastHtml = '';
  const setBody = (html) => {
    if (html === lastHtml) return; // unverändert: nicht neu zeichnen (sonst gehen Klicks verloren)
    lastHtml = html;
    $('tbody', body).innerHTML = html;
  };

  function collect(results, online) {
    failed = hostIds.filter((id) => !online.includes(id)).map((id) => `${hostOf(id)?.name || id}: offline`);
    guests = [];
    results.forEach((r, i) => {
      const h = hostOf(online[i]);
      if (r.status === 'fulfilled' && r.value) guests.push(...r.value.guests.map((g) => ({ ...g, hostId: h.id, hostName: h.name })));
      else if (r.status === 'rejected') failed.push(`${h.name}: ${r.reason.message}`);
    });
    if (!guests.length && failed.length && !multi) {
      setBody(`<tr><td colspan="${cols}"><div class="empty err-text">${esc(failed.join(' · '))}</div></td></tr>`);
      return;
    }
    if (multi) guests.sort((a, b) => a.hostName.localeCompare(b.hostName) || a.vmid - b.vmid);
    draw();
  }

  async function load(force = true) {
    const online = hostIds.filter((id) => hostOf(id)?.online);
    if (!online.length) {
      setBody(`<tr><td colspan="${cols}"><div class="empty">${icon('server')}<h3>${multi ? 'Kein Proxmox-Server online' : 'Host ist offline'}</h3></div></td></tr>`);
      return;
    }
    collect(await Promise.allSettled(online.map((id) => fetchGuests(id, force ? 0 : 10000))), online);
  }

  function draw() {
    const t = api.settings.thresholds;
    const q = filter.trim().toLowerCase();
    const shown = guests.filter((g) => !g.template && (!q || [g.vmid, g.name, g.hostName, ...(g.ips || []), ...(g.tags || []), api.agents.get(g.agentId)?.name].join(' ').toLowerCase().includes(q)));
    const note = multi && failed.length ? `<tr><td colspan="${cols}" class="pve-failed">${icon('alert', 'sm')}${esc(failed.join(' · '))}</td></tr>` : '';
    setBody(note + shown.map((g) => {
      const a = g.agentId && api.agents.get(g.agentId);
      const run = g.status === 'running';
      const osText = a ? osShort(a) : OSTYPES[g.ostype] ?? g.ostype ?? '';
      const memPct = g.maxmem ? (100 * g.mem) / g.maxmem : null;
      const diskPct = g.type === 'lxc' && g.maxdisk ? (100 * g.disk) / g.maxdisk : null; // VMs melden keine Belegung
      return `<tr data-g="${g.hostId}:${g.type}:${g.vmid}" class="pve-row">
        <td class="num">${g.vmid}</td>
        <td class="pve-name-cell" ${g.description ? `title="${esc(g.description)}"` : ''}>
          <a class="n pve-open" data-k="settings" title="Details öffnen">${esc(g.name)}</a>
          ${g.tags?.length ? `<div class="sub">${g.tags.map((x) => tagHtml(x, { small: true })).join('')}</div>` : g.description ? `<div class="sub muted">${esc(g.description)}</div>` : ''}
        </td>
        ${multi ? `<td class="pve-host-cell">${esc(g.hostName)}</td>` : ''}
        <td><div>${kind(g.type)}</div>${osText ? `<div class="sub muted">${esc(osText)}</div>` : ''}</td>
        <td><div>${statusBadge(g.status)}</div><div class="sub muted">${[g.onboot ? 'Autostart' : '', g.lock ? `gesperrt: ${esc(g.lock)}` : ''].filter(Boolean).join(' · ')}</div></td>
        <td class="mono pve-ips">${g.ips?.length ? g.ips.map((ip) => `<div>${esc(ip)}</div>`).join('') : '<span class="muted">–</span>'}</td>
        <td><div>${run ? miniBar(g.cpu * 100, '', t.cpu) : '<span class="muted">–</span>'}</div><div class="sub muted">${g.cpus ? `${g.cpus} ${g.cpus === 1 ? 'Kern' : 'Kerne'}` : ''}</div></td>
        <td><div>${run ? miniBar(memPct, 'mem', t.mem) : '<span class="muted">–</span>'}</div><div class="sub muted num">${run ? `${fmtBytes(g.mem)} / ` : ''}${fmtBytes(g.maxmem)}</div></td>
        <td><div>${diskPct != null ? miniBar(diskPct, '', t.disk) : '<span class="muted">–</span>'}</div><div class="sub muted num">${diskPct != null ? `${fmtBytes(g.disk)} / ` : ''}${g.maxdisk ? fmtBytes(g.maxdisk) : ''}</div></td>
        <td class="num pve-net">${run ? `<div title="Empfangen seit dem Start">↓ ${fmtBytes(g.netin)}</div><div title="Gesendet seit dem Start">↑ ${fmtBytes(g.netout)}</div>` : '<span class="muted">–</span>'}</td>
        <td class="muted">${run ? fmtDuration(g.uptime) : '–'}</td>
        <td>${a ? `<a href="#/client/${a.id}" class="link-client"><span class="dot ${a.online ? 'online' : 'offline'}"></span>${esc(a.name)}</a>
          ${run && !a.online ? `<div><button class="btn sm ghost pve-fix" data-k="restart-agent" title="BOLZO-Agent im Gast neu starten">${icon('refresh', 'sm')}Agent neu starten</button></div>` : ''}` : '<span class="muted">–</span>'}</td>
        <td class="actions" style="white-space:nowrap">
          ${run ? `<button class="btn sm" data-k="console">${icon(g.type === 'lxc' ? 'terminal' : 'monitor', 'sm')}Konsole</button>` : `<button class="btn sm" data-k="start">${icon('play', 'sm')}Starten</button>`}
          <button class="btn sm icon-only" data-k="settings" title="Details & Einstellungen">${icon('sliders', 'sm')}</button>
          <button class="btn sm icon-only" data-k="more" title="Weitere Aktionen">⋯</button>
        </td></tr>`;
    }).join('') || `<tr><td colspan="${cols}"><div class="empty">${q ? 'Kein Gast passt zum Filter' : 'Keine VMs oder Container'}</div></td></tr>`);
  }
  $('[data-gfilter]', body).addEventListener('input', (e) => { filter = e.target.value; draw(); });

  const guestOf = (tr) => {
    const [hid, type, vmid] = tr.dataset.g.split(':');
    const g = guests.find((x) => x.hostId === hid && x.type === type && x.vmid === Number(vmid));
    return { ...g, label: g.name };
  };
  $('tbody', body).onclick = async (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const g = guestOf(b.closest('tr'));
    if (b.dataset.k === 'console') return openConsole(g);
    if (b.dataset.k === 'start') return (await pvePower(g, 'start')) && setTimeout(load, 2500);
    if (b.dataset.k === 'restart-agent') return restartAgent(g, b);
    if (b.dataset.k === 'settings') { location.hash = `#/guest/${g.hostId}/${g.type}/${g.vmid}`; return; }
    const ops = g.status === 'running' ? ['shutdown', 'reboot', 'stop'] : ['start'];
    popupMenu(b, [
      ...ops.map((k) => ({ k, label: OPS[k].label, icon: OPS[k].icon, danger: k === 'stop' })),
      ...(g.status === 'running' ? [{ k: 'console', label: 'Konsole öffnen', icon: g.type === 'lxc' ? 'terminal' : 'monitor' }] : []),
      ...(g.status === 'running' && (g.type === 'lxc' || g.agentId) ? [{ k: 'restart-agent', label: 'BOLZO-Agent im Gast neu starten', icon: 'refresh' }] : []),
      { k: 'settings', label: 'Details & Einstellungen', icon: 'sliders' },
    ], async (k) => {
      if (k === 'console') return openConsole(g);
      if (k === 'restart-agent') return restartAgent(g);
      if (k === 'settings') { location.hash = `#/guest/${g.hostId}/${g.type}/${g.vmid}`; return; }
      if (await pvePower(g, k)) setTimeout(load, 2500);
    });
  };
  async function restartAgent(g, btn) {
    if (btn) btn.disabled = true;
    try {
      await api.post(`/api/agents/${g.hostId}/pve/restart-agent`, { vmid: g.vmid, type: g.type, name: g.name });
      toast(`BOLZO-Agent in ${g.name} wird neu gestartet`);
      setTimeout(load, 5000);
    } catch (e) {
      toast(e.message, 'err');
      if (btn) btn.disabled = false;
    }
  }

  $('[data-refresh]', body).onclick = load;
  $('[data-auto]', body).onclick = async () => {
    const free = guests.filter((g) => !g.agentId && !g.template);
    const pairs = [];
    for (const a of api.agents.values()) {
      if (a.info?.proxmox || a.pve) continue;
      const mine = macsOf(a);
      const hits = free.filter((g) => g.macs.some((m) => mine.has(m)));
      if (hits.length === 1) pairs.push([a, hits[0]]);
    }
    if (!pairs.length) return toast('Keine neuen Zuordnungen gefunden (MAC-Adressen passen zu keinem freien Client)');
    if (!(await confirmDialog({ title: `${pairs.length} Zuordnung(en) übernehmen?`, text: pairs.map(([a, g]) => `<b>${esc(a.name)}</b> → ${kind(g.type)} ${g.vmid} (${esc(g.name)})${multi ? ` auf ${esc(g.hostName)}` : ''}`).join('<br>'), okText: 'Übernehmen' }))) return;
    let ok = 0;
    for (const [a, g] of pairs) {
      try { await api.patch(`/api/agents/${a.id}`, { pve: { hostId: g.hostId, vmid: g.vmid, type: g.type } }); ok++; } catch (e) { toast(`${a.name}: ${e.message}`, 'err'); }
    }
    toast(`${ok} Client(s) zugeordnet`);
    load();
  };
  // Zuerst sofort den gespeicherten Stand zeigen (falls vorhanden), dann frisch laden
  const online0 = hostIds.filter((id) => hostOf(id)?.online);
  if (online0.length && online0.every((id) => cachedGuests(id))) collect(online0.map((id) => ({ status: 'fulfilled', value: cachedGuests(id) })), online0);
  load(false);
  return poll(load, 15000);
}

// =====================================================================
// Verwaltung: Gast-Einstellungen, Snapshots, Backups, Host, Netzwerk
// =====================================================================
export const pveCall = (hostId, action, params = {}) => api.post(`/api/agents/${hostId}/pve/call`, { action, params });
export const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const bar = (used, total) => (total ? miniBar((100 * used) / total, '', 90) : '<span class="muted">–</span>');

// ---------- Snapshots und Backups eines Gastes (eingebettet in die Gast-Seite) ----------
export async function renderGuestSnapshots(body, g) {
  const ref = { vmid: g.vmid, type: g.type, name: g.name };
  const show = () => renderGuestSnapshots(body, g);
  body.innerHTML = '<div class="card empty">Lade ...</div>';
  try {
    const r = await pveCall(g.hostId, 'pve.snap.list', ref);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    body.innerHTML = `
      <div class="card card-pad" style="margin-bottom:14px">
        <div class="form-grid">
          <div class="field"><label>Neuer Snapshot</label><input class="input" data-sn value="snap-${stamp}"></div>
          <div class="field"><label>Beschreibung</label><input class="input" data-sd placeholder="z.B. vor dem Update"></div>
        </div>
        <div class="row" style="justify-content:space-between;margin-top:12px">
          ${g.type === 'qemu' ? '<label class="row" style="gap:8px;cursor:pointer;font-size:13px"><input type="checkbox" class="check" data-sv>Arbeitsspeicher mitsichern (VM läuft danach exakt weiter, dauert länger)</label>' : '<span></span>'}
          <button class="btn primary" data-screate>${icon('plus', 'sm')}Snapshot anlegen</button>
        </div>
      </div>
      <div class="card table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Erstellt</th><th>Beschreibung</th><th>RAM</th><th></th></tr></thead><tbody>
        ${r.snapshots.map((s) => `<tr data-s="${esc(s.name)}">
          <td style="font-weight:500">${esc(s.name)}${s.name === r.current ? ' <span class="badge accent">aktueller Stand</span>' : ''}</td>
          <td class="muted">${fmtDate(s.snaptime)}</td><td>${esc(s.description)}</td><td>${s.vmstate ? icon('check', 'sm') : ''}</td>
          <td style="white-space:nowrap;text-align:right"><button class="btn sm" data-sk="rollback">${icon('back', 'sm')}Zurückrollen</button> <button class="btn sm danger icon-only" data-sk="delete" title="Löschen">${icon('trash', 'sm')}</button></td></tr>`).join('')
        || '<tr><td colspan="5"><div class="empty">Noch keine Snapshots</div></td></tr>'}
      </tbody></table></div>`;
    const after = (msg) => { toast(msg); setTimeout(() => show(), 3000); };
    $('[data-screate]', body).onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await pveCall(g.hostId, 'pve.snap', { ...ref, op: 'create', snapname: $('[data-sn]', body).value.trim(), description: $('[data-sd]', body).value, vmstate: !!$('[data-sv]', body)?.checked });
        after(res.done === false ? 'Snapshot wird angelegt (läuft im Hintergrund)' : 'Snapshot angelegt');
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    };
    $$('[data-sk]', body).forEach((b) => (b.onclick = async () => {
      const snapname = b.closest('tr').dataset.s;
      const rollback = b.dataset.sk === 'rollback';
      const ok = await confirmDialog(rollback
        ? { title: `Auf „${snapname}“ zurückrollen?`, text: `<b>${esc(g.name)}</b> wird auf den Stand dieses Snapshots zurückgesetzt. Alles, was danach geändert wurde, geht verloren.`, okText: 'Zurückrollen', danger: true }
        : { title: `Snapshot „${snapname}“ löschen?`, text: 'Der Snapshot wird endgültig entfernt. Der aktuelle Stand des Gastes bleibt unverändert.', okText: 'Löschen', danger: true });
      if (!ok) return;
      try {
        await pveCall(g.hostId, 'pve.snap', { ...ref, op: b.dataset.sk, snapname });
        after(rollback ? 'Wird zurückgerollt' : 'Snapshot wird gelöscht');
      } catch (err) { toast(err.message, 'err'); }
    }));
    } catch (e) {
    body.innerHTML = `<div class="card empty err-text">${esc(e.message)}</div>`;
  }
}

export async function renderGuestBackups(body, g) {
  const ref = { vmid: g.vmid, type: g.type, name: g.name };
  body.innerHTML = '<div class="card empty">Lade ...</div>';
  try {
    const r = await pveCall(g.hostId, 'pve.backup.info', ref);
    body.innerHTML = `
      <div class="card card-pad" style="margin-bottom:14px">
        ${r.storages.length ? `<div class="form-grid">
          <div class="field"><label>Speicher</label><select class="select" data-bs>${r.storages.map((s) => `<option value="${esc(s.storage)}">${esc(s.storage)} (${esc(s.type)}) – ${fmtBytes(s.avail)} frei</option>`).join('')}</select></div>
          <div class="field"><label>Modus</label><select class="select" data-bm><option value="snapshot">Snapshot – Gast läuft weiter</option><option value="suspend">Anhalten – kurz pausiert</option><option value="stop">Stopp – Gast wird kurz heruntergefahren</option></select></div>
          <div class="field" style="grid-column:1/-1"><label>Notiz</label><input class="input" data-bn placeholder="z.B. vor Umbau"></div>
        </div>
        <div class="row" style="justify-content:space-between;margin-top:12px"><span class="hint">Den Fortschritt siehst du beim Host unter „Aufgaben“.</span><button class="btn primary" data-brun>${icon('download', 'sm')}Backup jetzt starten</button></div>`
        : '<div class="muted">Kein Speicher für Backups eingerichtet (in Proxmox unter Rechenzentrum → Storage den Inhalt „VZDump-Backup“ erlauben).</div>'}
      </div>
      <div class="card table-wrap"><table class="tbl"><thead><tr><th>Erstellt</th><th>Speicher</th><th class="r">Größe</th><th>Notiz</th></tr></thead><tbody>
        ${r.backups.map((b) => `<tr title="${esc(b.volid)}"><td>${fmtDate(b.ctime)}${b.protected ? ` ${icon('key', 'sm')}` : ''}</td><td>${esc(b.storage)}</td><td class="r num">${fmtBytes(b.size)}</td><td class="muted">${esc(b.notes)}</td></tr>`).join('')
        || '<tr><td colspan="4"><div class="empty">Noch keine Backups</div></td></tr>'}
      </tbody></table></div>`;
    const run = $('[data-brun]', body);
    if (run) {
      run.onclick = async () => {
        run.disabled = true;
        try {
          await pveCall(g.hostId, 'pve.backup.run', { ...ref, storage: $('[data-bs]', body).value, mode: $('[data-bm]', body).value, notes: $('[data-bn]', body).value });
          toast('Backup gestartet – läuft im Hintergrund');
        } catch (e) { toast(e.message, 'err'); run.disabled = false; }
      };
    }
    } catch (e) {
    body.innerHTML = `<div class="card empty err-text">${esc(e.message)}</div>`;
  }
}

// ---------- Host-Bereich mit Reitern ----------
const TASK_TYPES = {
  vzdump: 'Backup', qmsnapshot: 'Snapshot', vzsnapshot: 'Snapshot', qmrollback: 'Snapshot zurückrollen', vzrollback: 'Snapshot zurückrollen',
  qmdelsnapshot: 'Snapshot löschen', vzdelsnapshot: 'Snapshot löschen', qmstart: 'Start', vzstart: 'Start', qmstop: 'Ausschalten', vzstop: 'Ausschalten',
  qmshutdown: 'Herunterfahren', vzshutdown: 'Herunterfahren', qmreboot: 'Neustart', vzreboot: 'Neustart', aptupdate: 'Paketlisten aktualisieren',
  srvreload: 'Dienst neu laden', vncproxy: 'Konsole', vncshell: 'Konsole', qmigrate: 'Migration', vzmigrate: 'Migration', qmclone: 'Klonen',
  vzcreate: 'Container anlegen', qmcreate: 'VM anlegen', imgdel: 'Disk löschen', qmdestroy: 'VM löschen', vzdestroy: 'Container löschen',
  startall: 'Alle starten', stopall: 'Alle stoppen',
};

export function renderProxmoxHost(body, hostId, opts = {}) {
  body.innerHTML = `
    <div class="seg pve-hseg" data-hseg>
      <button data-h="guests">${icon('box', 'sm')} VMs & Container</button>
      <button data-h="host">${icon('server', 'sm')} Host & Speicher</button>
      <button data-h="updates">${icon('download', 'sm')} Updates</button>
      <button data-h="network">${icon('network', 'sm')} Netzwerk</button>
      <button data-h="tasks">${icon('list', 'sm')} Aufgaben</button>
    </div>
    <div data-hbody></div>`;
  let cleanup = null;
  const views = { guests: (b) => renderProxmoxTab(b, hostId, opts), host: hostView, updates: updatesView, network: networkView, tasks: tasksView };
  function show(v) {
    $$('[data-h]', body).forEach((b) => b.classList.toggle('on', b.dataset.h === v));
    cleanup?.();
    const b = $('[data-hbody]', body);
    b.innerHTML = '<div class="card empty">Lade ...</div>';
    cleanup = views[v](b) || null;
  }
  $$('[data-h]', body).forEach((b) => (b.onclick = () => show(b.dataset.h)));
  show('guests');
  return () => cleanup?.();

  function hostView(b) {
    pveCall(hostId, 'pve.host').then((r) => {
      const s = r.status;
      b.innerHTML = `
        <div class="card card-pad" style="margin-bottom:14px"><div class="kv">
          <div class="k">Version</div><div class="v">${esc(s.pveversion.replace('pve-manager/', 'Proxmox VE '))}</div>
          <div class="k">Kernel</div><div class="v">${esc(s.kversion.split(' #')[0])}</div>
          <div class="k">Prozessor</div><div class="v">${esc(s.cpuModel)}${s.cpus ? ` · ${s.cpus} Threads` : ''}</div>
          <div class="k">CPU</div><div class="v pve-kvbar">${miniBar(s.cpu * 100, '', 90)}<span class="muted">Last ${esc(s.loadavg.join(' / '))}</span></div>
          <div class="k">RAM</div><div class="v pve-kvbar">${bar(s.memory.used, s.memory.total)}<span class="muted">${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)}</span></div>
          <div class="k">System-Disk</div><div class="v pve-kvbar">${bar(s.rootfs.used, s.rootfs.total)}<span class="muted">${fmtBytes(s.rootfs.used)} / ${fmtBytes(s.rootfs.total)}</span></div>
          <div class="k">Läuft seit</div><div class="v">${fmtDuration(s.uptime)}${r.rebootRequired ? ' <span class="badge warning">Neustart erforderlich</span>' : ''}</div>
        </div></div>
        <div class="card table-wrap"><table class="tbl"><thead><tr><th>Speicher</th><th>Typ</th><th>Inhalt</th><th>Belegung</th><th class="r">Belegt / Gesamt</th><th class="r">Frei</th><th>Status</th></tr></thead><tbody>
          ${r.storages.map((x) => `<tr><td style="font-weight:500">${esc(x.storage)}${x.shared ? ' <span class="muted" style="font-size:12px">geteilt</span>' : ''}</td><td class="muted">${esc(x.type)}</td>
            <td class="muted" style="font-size:12px">${esc(x.content.split(',').filter(Boolean).map((c) => ({ images: 'VM-Disks', rootdir: 'Container', iso: 'ISO', vztmpl: 'Vorlagen', backup: 'Backups', snippets: 'Snippets', import: 'Import' })[c] || c).join(', '))}</td>
            <td>${x.active ? bar(x.used, x.total) : ''}</td><td class="r num">${x.active ? `${fmtBytes(x.used)} / ${fmtBytes(x.total)}` : '–'}</td><td class="r num">${x.active ? fmtBytes(x.avail) : '–'}</td>
            <td>${!x.enabled ? '<span class="badge">deaktiviert</span>' : x.active ? '<span class="badge good">aktiv</span>' : '<span class="badge critical">nicht erreichbar</span>'}</td></tr>`).join('')}
        </tbody></table></div>`;
    }).catch((e) => (b.innerHTML = `<div class="card empty err-text">${esc(e.message)}</div>`));
  }

  function updatesView(b) {
    const load = () => pveCall(hostId, 'pve.host').then(draw).catch((e) => (b.innerHTML = `<div class="card empty err-text">${esc(e.message)}</div>`));
    function draw(r) {
      b.innerHTML = `
        <div class="toolbar">
          <span class="muted" style="font-size:13px">${r.updates.length ? `${r.updates.length} Update(s) verfügbar` : 'Alles aktuell'}${r.rebootRequired ? ' · <span class="badge warning">Neustart erforderlich</span>' : ''}</span>
          <span class="spacer grow"></span>
          <button class="btn" data-urefresh>${icon('refresh', 'sm')}Paketlisten aktualisieren</button>
          <button class="btn primary" data-uinstall ${r.updates.length ? '' : 'disabled'}>${icon('download', 'sm')}Updates installieren</button>
          <button class="btn danger" data-ureboot>${icon('power', 'sm')}Host neu starten</button>
        </div>
        <div class="card table-wrap"><table class="tbl"><thead><tr><th>Paket</th><th>Installiert</th><th>Neu</th><th>Beschreibung</th></tr></thead><tbody>
          ${r.updates.map((u) => `<tr><td style="font-weight:500">${esc(u.package)}</td><td class="mono muted" style="font-size:12px">${esc(u.from)}</td><td class="mono" style="font-size:12px">${esc(u.to)}</td><td class="muted">${esc(u.title)}</td></tr>`).join('')
          || `<tr><td colspan="4"><div class="empty">${icon('check')}<h3>Keine Updates</h3><div>Stand der letzten Prüfung – mit „Paketlisten aktualisieren“ neu prüfen.</div></div></td></tr>`}
        </tbody></table></div>`;
      $('[data-urefresh]', b).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = `${icon('refresh', 'sm spin')}Prüfe ...`;
        try { await pveCall(hostId, 'pve.apt.refresh'); } catch (err) { toast(err.message, 'err'); }
        load();
      };
      $('[data-uinstall]', b).onclick = async () => {
        if (!(await confirmDialog({ title: 'Proxmox-Updates installieren?', text: `${r.updates.length} Paket(e) werden installiert (apt dist-upgrade). Laufende Gäste bleiben an. Die Ausgabe erscheint unter <b>Verlauf → Skript-Ausgaben</b>. Nach Kernel-Updates ist ein Neustart des Hosts nötig.`, okText: 'Installieren' }))) return;
        try { await api.post(`/api/agents/${hostId}/pve/upgrade`); toast('Updates werden installiert – Ausgabe unter Verlauf → Skript-Ausgaben'); } catch (err) { toast(err.message, 'err'); }
      };
      $('[data-ureboot]', b).onclick = async () => {
        if (!(await confirmDialog({ title: 'Proxmox-Host neu starten?', text: 'Alle laufenden VMs und Container auf diesem Host werden dabei heruntergefahren und – sofern Autostart gesetzt ist – danach wieder gestartet.', okText: 'Host neu starten', danger: true }))) return;
        try { await api.action(hostId, 'reboot'); toast('Host wird neu gestartet'); } catch (err) { toast(err.message, 'err'); }
      };
    }
    load();
  }

  function networkView(b) {
    let data = null;
    const load = () => pveCall(hostId, 'pve.net.list').then((r) => { data = r; draw(); }).catch((e) => (b.innerHTML = `<div class="card empty err-text">${esc(e.message)}</div>`));
    const typeName = (t) => ({ bridge: 'Brücke', eth: 'Netzwerkkarte', bond: 'Bond', vlan: 'VLAN', OVSBridge: 'OVS-Brücke' })[t] || t;
    const dash = '<span class="muted">–</span>';
    function draw() {
      const r = data;
      b.innerHTML = `
        ${r.pending ? `<div class="card card-pad pve-pending">
          <div class="row" style="gap:10px;flex-wrap:wrap">${icon('alert', 'sm')}<b>Ausstehende Änderungen</b><span class="muted" style="font-size:12.5px">noch nicht aktiv</span><span class="spacer grow"></span>
            <button class="btn" data-nrevert>Verwerfen</button><button class="btn primary" data-napply>${icon('check', 'sm')}Übernehmen</button></div>
          <pre class="output" style="max-height:220px;margin-top:10px">${esc(r.diff)}</pre></div>` : ''}
        <div class="toolbar"><span class="muted" style="font-size:13px">Netzwerk-Schnittstellen des Hosts</span><span class="spacer grow"></span><button class="btn" data-nadd>${icon('plus', 'sm')}Brücke hinzufügen</button></div>
        <div class="card table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Typ</th><th>IP/Netz</th><th>Gateway</th><th>Ports</th><th>VLAN-fähig</th><th>Autostart</th><th>Kommentar</th><th>Status</th><th></th></tr></thead><tbody>
          ${r.ifaces.map((i) => `<tr data-i="${esc(i.iface)}"><td style="font-weight:500">${esc(i.iface)}</td><td class="muted">${esc(typeName(i.type))}</td>
            <td class="mono" style="font-size:12px">${i.cidr ? esc(i.cidr) : dash}</td><td class="mono" style="font-size:12px">${i.gateway ? esc(i.gateway) : dash}</td>
            <td class="mono" style="font-size:12px">${i.ports ? esc(i.ports) : dash}</td><td>${i.type === 'bridge' ? (i.vlanAware ? icon('check', 'sm') : dash) : ''}</td>
            <td>${i.autostart ? icon('check', 'sm') : dash}</td><td class="muted">${esc(i.comments)}</td>
            <td>${i.active ? '<span class="badge good">aktiv</span>' : '<span class="badge">inaktiv</span>'}</td>
            <td style="white-space:nowrap;text-align:right">${/^vmbr\d+$/.test(i.iface) ? `<button class="btn sm icon-only" data-nedit title="Bearbeiten">${icon('edit', 'sm')}</button> <button class="btn sm danger icon-only" data-ndel title="Löschen">${icon('trash', 'sm')}</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">Änderungen werden erst gesammelt und mit „Übernehmen“ aktiv. Ist der BOLZO-Server danach nicht erreichbar, stellt der Agent die alte Konfiguration nach etwa einer Minute automatisch wieder her.</div>`;
      $('[data-nadd]', b).onclick = () => bridgeDialog(null);
      $$('[data-nedit]', b).forEach((x) => (x.onclick = () => bridgeDialog(r.ifaces.find((i) => i.iface === x.closest('tr').dataset.i))));
      $$('[data-ndel]', b).forEach((x) => (x.onclick = async () => {
        const iface = x.closest('tr').dataset.i;
        const mgmt = r.ifaces.find((i) => i.iface === iface)?.gateway;
        if (!(await confirmDialog({ title: `${iface} löschen?`, text: `${mgmt ? '<b>Achtung: Über diese Brücke läuft vermutlich die Verwaltung des Hosts (Gateway gesetzt).</b><br>' : ''}Gäste an dieser Brücke verlieren nach dem Übernehmen ihr Netzwerk. Die Änderung wird erst mit „Übernehmen“ aktiv.`, okText: 'Löschen', danger: true }))) return;
        try { await pveCall(hostId, 'pve.net.delete', { iface }); load(); } catch (e) { toast(e.message, 'err'); }
      }));
      const revert = $('[data-nrevert]', b);
      if (revert) {
        revert.onclick = async () => {
          try { await pveCall(hostId, 'pve.net.revert'); toast('Änderungen verworfen'); load(); } catch (e) { toast(e.message, 'err'); }
        };
      }
      const apply = $('[data-napply]', b);
      if (apply) {
        apply.onclick = async () => {
          if (!(await confirmDialog({ title: 'Netzwerk-Änderungen übernehmen?', text: 'Das Netzwerk des Hosts wird neu geladen. Ist der BOLZO-Server danach nicht mehr erreichbar, wird die vorherige Konfiguration nach etwa einer Minute automatisch wiederhergestellt.', okText: 'Übernehmen' }))) return;
          apply.disabled = true;
          apply.innerHTML = `${icon('refresh', 'sm spin')}Wird angewendet ...`;
          try {
            const res = await pveCall(hostId, 'pve.net.apply');
            if (res.rolledBack) toast(res.message, 'err'); else toast('Netzwerk-Änderungen übernommen');
          } catch (err) {
            toast(`${err.message} – der Host lädt evtl. noch neu; bitte gleich erneut prüfen`, 'err');
          }
          load();
        };
      }
    }
    function bridgeDialog(i) {
      const create = !i;
      const next = `vmbr${Math.max(-1, ...data.ifaces.map((x) => Number((x.iface.match(/^vmbr(\d+)$/) || [])[1] ?? -1))) + 1}`;
      const nics = data.ifaces.filter((x) => ['eth', 'bond', 'vlan'].includes(x.type)).map((x) => x.iface);
      const { el: m, close } = modal({
        title: create ? 'Brücke hinzufügen' : `${i.iface} bearbeiten`,
        body: `<div class="form-grid">
          <div class="field"><label>Name</label><input class="input mono" data-b="iface" value="${esc(i?.iface || next)}" ${create ? '' : 'disabled'}></div>
          <div class="field"><label>IP/Netz (optional)</label><input class="input mono" data-b="cidr" value="${esc(i?.cidr || '')}" placeholder="z.B. 192.168.20.1/24"></div>
          <div class="field"><label>Gateway (optional)</label><input class="input mono" data-b="gateway" value="${esc(i?.gateway || '')}" placeholder="nur bei der Haupt-Brücke"></div>
          <div class="field"><label>Ports</label><input class="input mono" data-b="ports" value="${esc(i?.ports || '')}" placeholder="${esc(nics.join(' ') || 'leer = nur intern')}"><div class="hint">Leer = internes Netz ohne Verbindung nach außen${nics.length ? `. Vorhanden: ${esc(nics.join(', '))}` : ''}</div></div>
          <div class="field"><label>Kommentar</label><input class="input" data-b="comments" value="${esc(i?.comments || '')}"></div>
          <div class="field"><label>Optionen</label>
            <label class="row" style="gap:8px;cursor:pointer;height:28px"><input type="checkbox" class="check" data-b="vlanAware" ${i?.vlanAware ? 'checked' : ''}>VLAN-fähig</label>
            <label class="row" style="gap:8px;cursor:pointer;height:28px"><input type="checkbox" class="check" data-b="autostart" ${!i || i.autostart ? 'checked' : ''}>Autostart</label></div>
        </div>
        ${!create && i.gateway ? `<div class="pve-note" style="margin-top:12px">${icon('alert', 'sm')}Über diese Brücke läuft die Verwaltung des Hosts. Falsche Werte können ihn unerreichbar machen – die automatische Wiederherstellung greift dann nach etwa einer Minute.</div>` : ''}`,
        foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-bsave>Speichern</button>`,
      });
      $('[data-bsave]', m).onclick = async () => {
        const v = (k) => $(`[data-b="${k}"]`, m);
        try {
          await pveCall(hostId, 'pve.net.save', { create, iface: v('iface').value.trim(), cidr: v('cidr').value.trim(), gateway: v('gateway').value.trim(), ports: v('ports').value.trim(), comments: v('comments').value, vlanAware: v('vlanAware').checked, autostart: v('autostart').checked });
          toast('Gespeichert – mit „Übernehmen“ aktivieren');
          close();
          load();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    load();
  }

  function tasksView(b) {
    const load = () => pveCall(hostId, 'pve.tasks').then((list) => {
      b.innerHTML = `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Start</th><th>Aufgabe</th><th>Gast</th><th>Benutzer</th><th>Dauer</th><th>Status</th></tr></thead><tbody>
        ${list.map((t) => {
          const running = !t.end;
          const ok = t.status === 'OK';
          const status = running ? `<span class="badge accent">${icon('refresh', 'spin')}läuft</span>`
            : ok ? '<span class="badge good">OK</span>'
            : `<span class="badge ${/^WARNINGS/.test(t.status) ? 'warning' : 'critical'}" title="${esc(t.status)}">${esc(t.status.slice(0, 40))}</span>`;
          return `<tr><td class="muted num">${fmtDate(t.start)}</td><td style="font-weight:500">${esc(TASK_TYPES[t.type] || t.type)}</td><td class="num">${esc(t.id)}</td><td class="muted">${esc(t.user)}</td>
            <td class="num muted">${fmtDuration(((t.end || Date.now()) - t.start) / 1000)}</td><td>${status}</td></tr>`;
        }).join('') || '<tr><td colspan="6"><div class="empty">Keine Aufgaben</div></td></tr>'}
      </tbody></table></div>`;
    }).catch((e) => (b.innerHTML = `<div class="card empty err-text">${esc(e.message)}</div>`));
    load();
    return poll(load, 5000);
  }
}
