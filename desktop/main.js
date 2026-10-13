'use strict';
const { app, BrowserWindow, shell, Menu, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const net = require('net');
const { pathToFileURL } = require('url');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
const consoles = new Map(); // "hostId:vmid" -> Konsolen-Fenster

// Gemeinsame Fenster-Einstellungen: ohne Windows-Titelleiste, die Fensterknöpfe zeichnet die App selbst
function makeWindow(opts, file, query) {
  const w = new BrowserWindow({
    backgroundColor: '#111214',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    show: false,
    ...opts,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  w.loadFile(path.join(__dirname, 'renderer', file), query ? { query } : undefined);
  w.once('ready-to-show', () => w.show());

  // Externe Links im Standardbrowser öffnen, nie im App-Fenster
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const own = pathToFileURL(path.join(__dirname, 'renderer') + path.sep).href;
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(own)) e.preventDefault();
  });
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) {
      w.webContents.toggleDevTools();
    }
    if (input.type === 'keyDown' && input.key === 'F5') w.webContents.reload();
  });
  const sendState = () => !w.isDestroyed() && w.webContents.send('win-state', { maximized: w.isMaximized(), fullscreen: w.isFullScreen() });
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) w.on(ev, sendState);
  return w;
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  win = makeWindow({ width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: 'BOLZO RMM' }, 'index.html');
  // Hauptfenster zu = App zu (auch offene Konsolen)
  win.on('closed', () => {
    win = null;
    for (const c of consoles.values()) if (!c.isDestroyed()) c.close();
  });
}

// Konsole einer VM / eines Containers in eigenem Fenster (pro Gast nur ein Fenster)
function openConsoleWindow(g) {
  const key = `${g.hostId}:${g.vmid}`;
  const open = consoles.get(key);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  const query = {};
  for (const k of ['hostId', 'vmid', 'type', 'name', 'label', 'hostName']) if (g[k] != null) query[k] = String(g[k]);
  const w = makeWindow({ width: 1280, height: 840, minWidth: 640, minHeight: 400, title: `${g.label || g.name || g.vmid} – Konsole` }, 'console.html', query);
  consoles.set(key, w);
  w.on('closed', () => consoles.get(key) === w && consoles.delete(key));
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ---------------------------------------------------------------------------
// Auto-Update über GitHub-Releases (nur in der installierten App)
// ---------------------------------------------------------------------------
let updateState = { status: app.isPackaged ? 'idle' : 'dev', version: null, percent: 0, message: '' };
function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('update-state', updateState);
}

const firstLine = (e) => String(e?.message || e).split(/\r?\n/)[0];

let autoUpdater = null;
function initUpdater() {
  if (!app.isPackaged) return;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', message: '' }));
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version, percent: 100 }));
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: firstLine(e) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 4 * 3600e3);
}

// Fensterknöpfe der App (minimieren, maximieren, schließen) – wirken auf das aufrufende Fenster
const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.on('win:minimize', (e) => senderWin(e)?.minimize());
ipcMain.on('win:toggle-maximize', (e) => {
  const w = senderWin(e);
  if (!w) return;
  if (w.isFullScreen()) w.setFullScreen(false);
  else if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', (e) => senderWin(e)?.close());
ipcMain.handle('win:state', (e) => {
  const w = senderWin(e);
  return { maximized: !!w?.isMaximized(), fullscreen: !!w?.isFullScreen() };
});
ipcMain.on('open-console', (_e, g) => {
  if (g && g.hostId && g.vmid != null) openConsoleWindow(g);
});

// ---------------------------------------------------------------------------
// Weboberfläche eines Netzwerkgeräts über dessen Abfrage-Client öffnen: Die App lauscht auf einem
// freien Port auf 127.0.0.1; jede Browser-Verbindung dorthin bekommt beim Server einen eigenen
// Tunnel (App -> Server -> Abfrage-Client -> Gerät). Nach 30 Minuten ohne Verbindung wieder zu.
// ---------------------------------------------------------------------------
const webProxies = new Map(); // Geräte-ID -> { srv, port, server, token, conns, timer }
const WEB_IDLE = 30 * 60e3;

function armIdle(px) {
  clearTimeout(px.timer);
  px.timer = setTimeout(() => {
    if (px.conns.size) return armIdle(px);
    px.srv.close();
    webProxies.delete(px.id);
  }, WEB_IDLE);
}

async function webTunnel(sock, px) {
  sock.pause();
  sock.on('error', () => {});
  px.conns.add(sock);
  armIdle(px);
  const post = async (p) => {
    const r = await fetch(px.server + p, { method: 'POST', headers: { Authorization: `Bearer ${px.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  const done = () => { px.conns.delete(sock); sock.destroy(); };
  try {
    const { sid } = await post(`/api/net/${encodeURIComponent(px.id)}/web`);
    const { ticket } = await post('/api/ws-ticket');
    const ws = new WebSocket(`${px.server.replace(/^http/, 'ws')}/ws/console?ticket=${encodeURIComponent(ticket)}&sid=${encodeURIComponent(sid)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      sock.on('data', (d) => ws.readyState === 1 && ws.send(d));
      sock.resume();
    };
    ws.onmessage = (e) => { if (typeof e.data !== 'string') sock.write(Buffer.from(e.data)); };
    ws.onclose = done;
    ws.onerror = done;
    sock.on('close', () => { px.conns.delete(sock); try { ws.close(); } catch {} });
  } catch {
    done();
  }
}

ipcMain.handle('net-web', async (_e, o) => {
  const id = String(o?.id || '');
  const server = String(o?.server || '').replace(/\/+$/, '');
  if (!id || !/^https?:\/\//.test(server) || !o?.token) throw new Error('Ungültige Anfrage');
  let px = webProxies.get(id);
  if (px && px.server !== server) {
    px.srv.close();
    clearTimeout(px.timer);
    px = null;
  }
  if (!px) {
    px = { id, server, conns: new Set(), timer: null };
    px.srv = net.createServer((sock) => webTunnel(sock, px));
    await new Promise((resolve, reject) => px.srv.once('error', reject).listen(0, '127.0.0.1', resolve));
    px.port = px.srv.address().port;
    webProxies.set(id, px);
  }
  px.token = o.token;
  armIdle(px);
  const scheme = o.scheme === 'https' ? 'https' : 'http';
  const p = String(o.path || '/');
  const url = `${scheme}://127.0.0.1:${px.port}${p.startsWith('/') ? p : '/'}`;
  shell.openExternal(url);
  return { url };
});

ipcMain.handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, hostname: os.hostname() }));
ipcMain.handle('update-state', () => updateState);
ipcMain.handle('update-check', async () => {
  if (!autoUpdater) return updateState;
  await autoUpdater.checkForUpdates().catch((e) => setUpdate({ status: 'error', message: firstLine(e) }));
  return updateState;
});
ipcMain.handle('update-install', () => {
  if (autoUpdater && updateState.status === 'ready') setImmediate(() => autoUpdater.quitAndInstall(false, true));
});

app.setAppUserModelId('net.bolzo.rmm');
app.whenReady().then(() => {
  createWindow();
  initUpdater();
});
app.on('window-all-closed', () => app.quit());
