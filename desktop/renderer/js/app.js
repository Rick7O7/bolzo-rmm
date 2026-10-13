import { api, LS } from './api.js';
import { icon, esc, $, $$, primaryIp, isPveHost, installWindowControls } from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderClients } from './views/clients.js';
import { renderClient } from './views/client.js';
import { renderScripts } from './views/scripts.js';
import { renderJobs } from './views/jobs.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';
import { renderPve } from './views/pve.js';
import { renderGuest } from './views/guest.js';
import { renderNetwork, netProblems, KIND } from './views/network.js';
import { renderNetDevice } from './views/netdev.js';
import { updates, initUpdates } from './updates.js';

const app = $('#app');
const NAV = [
  { href: '#/dashboard', label: 'Dashboard', icon: 'grid' },
  { href: '#/clients', label: 'Clients', icon: 'monitor' },
  { href: '#/proxmox', label: 'Proxmox', icon: 'server' },
  { href: '#/network', label: 'Netzwerk', icon: 'network' },
  { href: '#/scripts', label: 'Skripte', icon: 'code' },
  { href: '#/jobs', label: 'Jobs', icon: 'zap' },
  { href: '#/history', label: 'Verlauf', icon: 'clock' },
  { href: '#/settings', label: 'Einstellungen', icon: 'sliders', bottom: true }, // unten über der Verbindungsanzeige
];
// Symbol-Leiste: nur Icons, Name als Tooltip; kleine Zähler für Probleme
const navItem = (n) => `<a class="nav-item" href="${n.href}" data-tip="${n.label}">${icon(n.icon)}${n.href === '#/clients' ? '<span class="nav-count" data-problems hidden></span>' : n.href === '#/network' ? '<span class="nav-count" data-netproblems hidden></span>' : ''}</a>`;
const ROUTES = {
  dashboard: renderDashboard,
  clients: renderClients,
  client: renderClient,
  scripts: renderScripts,
  jobs: renderJobs,
  history: renderHistory,
  proxmox: renderPve,
  guest: renderGuest,
  network: renderNetwork,
  netdev: renderNetDevice,
  settings: renderSettings,
};

let cleanup = null;
const go = (hash) => { location.hash = hash; };

// ---------- Login ----------
function showLogin(error = '') {
  cleanup?.();
  cleanup = null;
  app.innerHTML = `
    <div class="login"><div class="drag"></div>
      <form class="card login-card">
        <img class="brand-mark" src="../build/icon.png" alt="">
        <div><h1 class="wordmark">BOLZO <span>RMM</span></h1><p>Mit deinem BOLZO-RMM-Server verbinden</p></div>
        <div class="field"><label>Server-Adresse</label><input class="input" name="server" placeholder="https://rmm.example.de" value="${esc(api.server)}" required></div>
        <div class="field"><label>Admin-Passwort</label><input class="input" name="password" type="password" required autofocus></div>
        <div class="err-text">${esc(error)}</div>
        <button class="btn primary" style="height:40px">Anmelden</button>
      </form>
    </div>`;
  const form = $('form', app);
  (api.server ? form.password : form.server).focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    btn.disabled = true;
    btn.textContent = 'Verbinde ...';
    try {
      await api.login(form.server.value, form.password.value);
      start();
    } catch (err) {
      $('.err-text', form).textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Anmelden';
    }
  };
}

// ---------- Hauptfenster ----------
function showShell() {
  app.innerHTML = `
    <div class="shell">
      <nav class="rail">
        <a class="rail-logo" href="#/dashboard" data-tip="BOLZO RMM"><img src="../build/icon.png" alt=""></a>
        ${NAV.filter((n) => !n.bottom).map(navItem).join('')}
        <span class="rail-grow"></span>
        <a class="nav-item update" href="#/settings" data-updpill data-tip="Update verfügbar" hidden>${icon('download')}<span class="nav-dot"></span></a>
        ${NAV.filter((n) => n.bottom).map(navItem).join('')}
      </nav>
      <main class="main">
        <header class="topbar">
          <div class="crumbs"><span class="root">BOLZO RMM</span><span class="sep">/</span><span data-crumb></span></div>
          <span class="grow"></span>
          <div class="gsearch">
            ${icon('search', 'sm')}<input data-gsearch placeholder="Clients, Geräte, IPs, Tags suchen" spellcheck="false"><kbd>Strg K</kbd>
            <div class="gsearch-results" data-gresults hidden></div>
          </div>
          <span class="conn-pill" data-conn title="${esc(api.server.replace(/^https?:\/\//, ''))}"><span class="dot" data-conndot></span><span data-connlabel>Verbinde ...</span></span>
        </header>
        <div class="page" id="page"></div>
      </main>
    </div>`;
  initSearch();
}

// Globale Suche: Clients nach Name, IP, Tag, Betriebssystem; Enter öffnet den ersten Treffer
function initSearch() {
  const input = $('[data-gsearch]');
  const box = $('[data-gresults]');
  let hits = [];
  let sel = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { box.hidden = true; return; }
    const clients = [...api.agents.values()].filter((a) => [a.name, a.hostname, primaryIp(a), a.os, a.publicIp, a.pve?.hostName, isPveHost(a) ? 'proxmox' : '', ...(a.tags || [])]
      .join(' ').toLowerCase().includes(q)).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, href: `#/client/${a.id}`, name: a.name, sub: primaryIp(a), dot: a.online ? 'online' : 'offline' }));
    const devices = [...api.net.values()].filter((d) => [d.name, d.host, KIND[d.kind]?.long, d.kind === 'opnsense' ? 'firewall' : ''].join(' ').toLowerCase().includes(q))
      .map((d) => ({ id: d.id, href: `#/netdev/${d.id}`, name: d.name, sub: `${KIND[d.kind]?.label || ''} · ${d.host}`, dot: d.state === 'online' ? 'online' : d.state === 'warning' ? 'alert' : 'offline' }));
    hits = [...clients, ...devices].slice(0, 8);
    sel = Math.min(sel, Math.max(0, hits.length - 1));
    box.hidden = false;
    box.innerHTML = hits.length ? hits.map((h, i) => `<div class="gs-item ${i === sel ? 'on' : ''}" data-i="${i}">
        <span class="dot ${h.dot}"></span><span class="n">${esc(h.name)}</span><span class="s">${esc(h.sub)}</span></div>`).join('')
      : '<div class="gs-empty">Keine Treffer</div>';
  };
  const open = (h) => { if (!h) return; input.value = ''; box.hidden = true; input.blur(); go(h.href); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, hits.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') open(hits[sel]);
    else if (e.key === 'Escape') { input.value = ''; box.hidden = true; input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 150));
  input.addEventListener('focus', draw);
  box.addEventListener('mousedown', (e) => {
    const it = e.target.closest('[data-i]');
    if (it) open(hits[Number(it.dataset.i)]);
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    const input = $('[data-gsearch]');
    if (input) { e.preventDefault(); input.focus(); input.select(); }
  }
});

function updateConn() {
  const dot = $('[data-conndot]');
  if (!dot) return;
  dot.className = `dot ${api.connected ? 'online' : 'offline'}`;
  $('[data-connlabel]').textContent = api.connected ? 'Verbunden' : 'Getrennt – verbinde neu';
  $('[data-conn]').classList.toggle('bad', !api.connected);
}

// Zähler an "Clients": Rechner, die offline sind oder eine Warnung haben
function updateBadge() {
  const b = $('[data-problems]');
  if (!b) return;
  const all = [...api.agents.values()];
  const n = all.filter((a) => !a.online || a.alerts?.length).length;
  b.hidden = !n;
  b.textContent = n;
  b.closest('.nav-item').dataset.tip = `Clients · ${all.filter((a) => a.online).length} von ${all.length} online`;
}

// Zähler an "Netzwerk": Geräte offline oder mit Warnung (z.B. Gateway gestört)
function updateNetBadge() {
  const b = $('[data-netproblems]');
  if (!b) return;
  const n = netProblems().length;
  b.hidden = !n;
  b.textContent = n;
  const all = [...api.net.values()];
  b.closest('.nav-item').dataset.tip = all.length ? `Netzwerk · ${all.filter((d) => d.state === 'online' || d.state === 'warning').length} von ${all.length} erreichbar` : 'Netzwerk';
}

// Hinweis in der Leiste, sobald irgendein Update bereitsteht
function updatePill() {
  const pill = $('[data-updpill]');
  if (!pill) return;
  const parts = [];
  if (updates.app.status === 'ready') parts.push(`App ${updates.app.version}`);
  if (updates.server?.updateAvailable) parts.push('Server');
  if (updates.server?.agent?.outdatedOnline) parts.push('Agents');
  pill.hidden = !parts.length;
  pill.dataset.tip = `Update verfügbar: ${parts.join(', ')}`;
}
updates.on(updatePill);

function route() {
  if (!api.loggedIn) return showLogin();
  const [name, ...params] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const view = ROUTES[name] || renderDashboard;
  $$('.nav-item').forEach((n) => {
    const target = n.getAttribute('href').slice(2);
    n.classList.toggle('active', !n.hasAttribute('data-updpill') && (target === name || (name === 'client' && target === 'clients') || (name === 'guest' && target === 'proxmox') || (name === 'netdev' && target === 'network')));
  });
  const crumb = $('[data-crumb]');
  if (crumb) {
    crumb.textContent = name === 'client' ? `Clients / ${api.agents.get(params[0])?.name || ''}` : name === 'guest' ? `Proxmox / ${api.agents.get(params[0])?.name || ''}`
      : name === 'netdev' ? `Netzwerk / ${api.net.get(params[0])?.name || ''}` : (NAV.find((n) => n.href === `#/${name}`) || NAV[0]).label;
  }
  cleanup?.();
  const page = $('#page');
  page.scrollTop = 0;
  page.innerHTML = '';
  cleanup = view(page, { go, params }) || null;
}

// Desktop-Benachrichtigungen bei Statuswechseln
api.on('agent', ({ agent, prev }) => {
  if (!prev || prev.online === agent.online || !LS.get('notify', true)) return;
  try {
    new Notification(agent.online ? `${agent.name} ist wieder online` : `${agent.name} ist offline`, {
      body: agent.online ? 'Der Client hat sich wieder verbunden.' : 'Der Agent hat die Verbindung verloren.',
      silent: agent.online,
    });
  } catch {}
});
api.on('net', (e) => {
  updateNetBadge();
  const { device: d, prev } = e || {};
  if (!d || !prev || !LS.get('notify', true)) return;
  const up = (s) => s === 'online' || s === 'warning';
  if (prev.state === 'unknown' || d.state === 'unknown' || up(prev.state) === up(d.state)) return;
  try {
    new Notification(up(d.state) ? `${d.name} ist wieder erreichbar` : `${d.name} ist nicht erreichbar`, {
      body: up(d.state) ? `${KIND[d.kind]?.long || 'Gerät'} antwortet wieder.` : d.error || 'Das Gerät antwortet nicht mehr.',
      silent: up(d.state),
    });
  } catch {}
});

let waitingForFirstData = false;
let updatesStarted = false;
function start() {
  showShell();
  updateConn();
  waitingForFirstData = true;
  api.connect();
  route();
  if (!updatesStarted) {
    updatesStarted = true;
    initUpdates();
  } else {
    updates.refreshServer();
  }
  updatePill();
}

api.on('conn', updateConn);
api.on('agents', () => {
  updateBadge();
  updateNetBadge();
  // Erste Daten nach dem Verbinden: aktuelle Ansicht neu zeichnen
  if (waitingForFirstData) {
    waitingForFirstData = false;
    route();
  }
});
api.on('logout', () => showLogin());
window.addEventListener('hashchange', route);

installWindowControls();
if (api.loggedIn) start();
else showLogin();
