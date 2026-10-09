import { api, LS } from './api.js';
import { icon, esc, $, $$ } from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderClients } from './views/clients.js';
import { renderClient } from './views/client.js';
import { renderScripts } from './views/scripts.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';

const app = $('#app');
const NAV = [
  { href: '#/dashboard', label: 'Dashboard', icon: 'grid' },
  { href: '#/clients', label: 'Clients', icon: 'monitor' },
  { href: '#/scripts', label: 'Skripte', icon: 'code' },
  { href: '#/history', label: 'Verlauf', icon: 'clock' },
  { href: '#/settings', label: 'Einstellungen', icon: 'sliders' },
];
const ROUTES = {
  dashboard: renderDashboard,
  clients: renderClients,
  client: renderClient,
  scripts: renderScripts,
  history: renderHistory,
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
        <div class="brand-mark">${icon('activity')}</div>
        <div><h1>RMM Desk</h1><p>Mit deinem RMM-Server verbinden</p></div>
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
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">${icon('activity')}</div>RMM Desk</div>
        <nav class="nav">${NAV.map((n) => `<a class="nav-item" href="${n.href}" style="text-decoration:none">${icon(n.icon)}${n.label}${n.href === '#/clients' ? '<span class="badge" data-online></span>' : ''}</a>`).join('')}</nav>
        <div class="sidebar-foot">
          <div class="conn"><span class="dot" data-conndot></span><div style="min-width:0"><div data-connlabel>Verbinde ...</div><div class="host">${esc(api.server.replace(/^https?:\/\//, ''))}</div></div></div>
        </div>
      </aside>
      <main class="main">
        <div class="topbar"></div>
        <div class="page" id="page"></div>
      </main>
    </div>`;
}

function updateConn() {
  const dot = $('[data-conndot]');
  if (!dot) return;
  dot.className = `dot ${api.connected ? 'online' : 'offline'}`;
  $('[data-connlabel]').textContent = api.connected ? 'Verbunden' : 'Getrennt – verbinde neu';
}
function updateBadge() {
  const b = $('[data-online]');
  if (!b) return;
  const all = [...api.agents.values()];
  b.textContent = `${all.filter((a) => a.online).length}/${all.length}`;
}

function route() {
  if (!api.loggedIn) return showLogin();
  const [name, ...params] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const view = ROUTES[name] || renderDashboard;
  $$('.nav-item').forEach((n) => {
    const target = n.getAttribute('href').slice(2);
    n.classList.toggle('active', target === name || (name === 'client' && target === 'clients'));
  });
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

let waitingForFirstData = false;
function start() {
  showShell();
  updateConn();
  waitingForFirstData = true;
  api.connect();
  route();
}

api.on('conn', updateConn);
api.on('agents', () => {
  updateBadge();
  // Erste Daten nach dem Verbinden: aktuelle Ansicht neu zeichnen
  if (waitingForFirstData) {
    waitingForFirstData = false;
    route();
  }
});
api.on('logout', () => showLogin());
window.addEventListener('hashchange', route);

if (api.loggedIn) start();
else showLogin();
