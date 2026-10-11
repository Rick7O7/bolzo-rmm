// Proxmox: Gäste eines Proxmox-Hosts verwalten, Clients ihrer VM/ihrem Container zuordnen
// und die Konsole öffnen – VMs als Bildschirm (noVNC), Container als echtes Terminal.
import RFB from '../../node_modules/@novnc/novnc/core/rfb.js';
import { api, LS } from './api.js';
import { icon, esc, el, $, $$, modal, toast, confirmDialog, fmtBytes, fmtDuration } from './ui.js';
import { RemoteTerminal } from './terminal.js';

const kind = (type) => (type === 'lxc' ? 'Container' : 'VM');
const OPS = {
  start: { label: 'Starten', icon: 'play', done: 'wird gestartet' },
  shutdown: { label: 'Herunterfahren', icon: 'power', done: 'wird heruntergefahren', confirm: 'Das Gastsystem wird sauber heruntergefahren.' },
  reboot: { label: 'Neu starten', icon: 'refresh', done: 'wird neu gestartet', confirm: 'Das Gastsystem wird neu gestartet.' },
  stop: { label: 'Ausschalten (hart)', icon: 'stop', done: 'wurde ausgeschaltet', confirm: 'Wie Stecker ziehen: nicht gespeicherte Daten gehen verloren. Nur nutzen, wenn der Gast nicht mehr reagiert.' },
};

export const proxmoxHosts = () => [...api.agents.values()].filter((a) => a.info?.proxmox);
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

export function openConsole(g) {
  return g.type === 'lxc' ? openContainerConsole(g) : openVmConsole(g);
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
function consoleFrame(g, extraBar = '') {
  const overlay = el(`<div class="console-overlay">
    <div class="console-bar">
      <span class="dot" data-dot></span>
      <div class="console-title"><b>${esc(g.label || g.name || `${kind(g.type)} ${g.vmid}`)}</b><span class="muted">${kind(g.type)} ${g.vmid}${g.hostName ? ` · ${esc(g.hostName)}` : ''}</span></div>
      <span class="muted console-status" data-status>Verbinde ...</span>
      <span class="spacer"></span>
      ${extraBar}
      <button class="btn sm" data-power title="Proxmox-Aktionen">${icon('power', 'sm')}</button>
      <button class="btn sm" data-full title="Vollbild">${icon('monitor', 'sm')}Vollbild</button>
      <button class="btn sm" data-close title="Konsole schließen">${icon('x', 'sm')}Schließen</button>
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
  return { overlay, screen: $('[data-screen]', overlay), status };
}

async function openVmConsole(g) {
  let info;
  try {
    info = await api.post(`/api/agents/${g.hostId}/pve/console`, { vmid: g.vmid, type: g.type, name: g.name });
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  const layout = LS.get('vncLayout', 'de');
  const { overlay, screen, status } = consoleFrame(g, `
    <select class="select sm" data-layout title="Tastaturlayout der VM (für „Text einfügen“)">
      ${Object.entries(LAYOUTS).map(([k, l]) => `<option value="${k}" ${k === layout ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <button class="btn sm" data-paste title="Text in die VM tippen lassen">${icon('copy', 'sm')}Text einfügen</button>
    <button class="btn sm" data-cad>Strg+Alt+Entf</button>
    <button class="btn sm" data-scale title="Bild an das Fenster anpassen oder 1:1 anzeigen">${icon('grid', 'sm')}<span>Anpassen</span></button>`);

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
  $('[data-close]', overlay).onclick = () => {
    closed = true;
    try { rfb.disconnect(); } catch {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    overlay.remove();
  };
}

function openContainerConsole(g) {
  const { overlay, screen, status } = consoleFrame(g, `<span class="muted" style="font-size:12px">Markieren = kopieren (Strg+C) · Strg+V = einfügen</span>`);
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
  $('[data-close]', overlay).onclick = () => {
    term.dispose();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    overlay.remove();
  };
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
      const { guests } = await api.get(`/api/agents/${host.id}/pve/guests`);
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

const statusBadge = (s) => (s === 'running'
  ? `<span class="badge good">läuft</span>`
  : s === 'stopped' ? `<span class="badge">aus</span>` : `<span class="badge warning">${esc(s || '?')}</span>`);

// ---------- Tab "Proxmox" beim Host ----------
export function renderProxmoxTab(body, hostId, { compact = false } = {}) {
  const host = () => api.agents.get(hostId);
  body.innerHTML = `
    <div class="toolbar">
      <span class="muted" style="font-size:13px" data-ver></span>
      <span class="spacer grow"></span>
      <button class="btn" data-auto title="Clients anhand der MAC-Adresse ihrer VM/ihrem Container zuordnen">${icon('link', 'sm')}Automatisch zuordnen</button>
      <button class="btn" data-refresh>${icon('refresh', 'sm')}Aktualisieren</button>
    </div>
    <div class="card table-wrap"><table class="tbl"><thead><tr>
      <th>ID</th><th>Name</th><th>Typ</th><th>Status</th><th class="r">CPU</th><th class="r">RAM</th><th>Laufzeit</th><th>BOLZO-Client</th><th></th>
    </tr></thead><tbody><tr><td colspan="9"><div class="empty">Lade ...</div></td></tr></tbody></table></div>`;
  const p = host().info.proxmox;
  $('[data-ver]', body).textContent = compact ? '' : `Proxmox VE ${p.version || ''} · Knoten ${p.node}`;
  let guests = [];
  let timer = null;

  async function load() {
    if (!host()?.online) {
      $('tbody', body).innerHTML = `<tr><td colspan="9"><div class="empty">${icon('server')}<h3>Host ist offline</h3></div></td></tr>`;
      return;
    }
    try {
      ({ guests } = await api.get(`/api/agents/${hostId}/pve/guests`));
    } catch (e) {
      $('tbody', body).innerHTML = `<tr><td colspan="9"><div class="empty err-text">${esc(e.message)}</div></td></tr>`;
      return;
    }
    $('tbody', body).innerHTML = guests.filter((g) => !g.template).map((g) => {
      const a = g.agentId && api.agents.get(g.agentId);
      const run = g.status === 'running';
      return `<tr data-g="${g.type}:${g.vmid}">
        <td class="num">${g.vmid}</td>
        <td style="font-weight:500">${esc(g.name)}</td>
        <td class="muted">${kind(g.type)}</td>
        <td>${statusBadge(g.status)}</td>
        <td class="r num">${run ? `${Math.round(g.cpu * 100)} %` : '–'}</td>
        <td class="r num">${run ? `${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}` : fmtBytes(g.maxmem)}</td>
        <td class="muted">${run ? fmtDuration(g.uptime) : '–'}</td>
        <td>${a ? `<a href="#/client/${a.id}" class="link-client"><span class="dot ${a.online ? 'online' : 'offline'}"></span>${esc(a.name)}</a>` : '<span class="muted">–</span>'}</td>
        <td class="actions" style="white-space:nowrap">
          ${run ? `<button class="btn sm" data-k="console">${icon(g.type === 'lxc' ? 'terminal' : 'monitor', 'sm')}Konsole</button>` : `<button class="btn sm" data-k="start">${icon('play', 'sm')}Starten</button>`}
          <button class="btn sm icon-only" data-k="more" title="Weitere Aktionen">⋯</button>
        </td></tr>`;
    }).join('') || `<tr><td colspan="9"><div class="empty">Keine VMs oder Container</div></td></tr>`;
  }

  const guestOf = (tr) => {
    const [type, vmid] = tr.dataset.g.split(':');
    const g = guests.find((x) => x.type === type && x.vmid === Number(vmid));
    return { ...g, hostId, hostName: host().name, label: g.name };
  };
  $('tbody', body).onclick = async (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const g = guestOf(b.closest('tr'));
    if (b.dataset.k === 'console') return openConsole(g);
    if (b.dataset.k === 'start') return (await pvePower(g, 'start')) && setTimeout(load, 2500);
    const ops = g.status === 'running' ? ['shutdown', 'reboot', 'stop'] : ['start'];
    popupMenu(b, [
      ...ops.map((k) => ({ k, label: OPS[k].label, icon: OPS[k].icon, danger: k === 'stop' })),
      ...(g.status === 'running' ? [{ k: 'console', label: 'Konsole öffnen', icon: g.type === 'lxc' ? 'terminal' : 'monitor' }] : []),
    ], async (k) => {
      if (k === 'console') return openConsole(g);
      if (await pvePower(g, k)) setTimeout(load, 2500);
    });
  };
  $('[data-refresh]', body).onclick = load;
  $('[data-auto]', body).onclick = async () => {
    const free = guests.filter((g) => !g.agentId && !g.template);
    const pairs = [];
    for (const a of api.agents.values()) {
      if (a.id === hostId || a.pve) continue;
      const mine = macsOf(a);
      const hits = free.filter((g) => g.macs.some((m) => mine.has(m)));
      if (hits.length === 1) pairs.push([a, hits[0]]);
    }
    if (!pairs.length) return toast('Keine neuen Zuordnungen gefunden (MAC-Adressen passen zu keinem freien Client)');
    if (!(await confirmDialog({ title: `${pairs.length} Zuordnung(en) übernehmen?`, text: pairs.map(([a, g]) => `<b>${esc(a.name)}</b> → ${kind(g.type)} ${g.vmid} (${esc(g.name)})`).join('<br>'), okText: 'Übernehmen' }))) return;
    let ok = 0;
    for (const [a, g] of pairs) {
      try { await api.patch(`/api/agents/${a.id}`, { pve: { hostId, vmid: g.vmid, type: g.type } }); ok++; } catch (e) { toast(`${a.name}: ${e.message}`, 'err'); }
    }
    toast(`${ok} Client(s) zugeordnet`);
    load();
  };
  load();
  timer = setInterval(load, 15000);
  return () => clearInterval(timer);
}
