'use strict';
const { app, BrowserWindow, shell, Menu, nativeTheme, ipcMain } = require('electron');
const path = require('path');

if (!app.requestSingleInstanceLock()) app.quit();

let win;

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'BOLZO RMM',
    backgroundColor: '#0e0f11',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f11', symbolColor: '#c3c2b7', height: 44 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Externe Links im Standardbrowser öffnen, nie im App-Fenster
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) {
      win.webContents.toggleDevTools();
    }
    if (input.type === 'keyDown' && input.key === 'F5') win.webContents.reload();
  });
}

app.on('second-instance', () => {
  if (win) {
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

ipcMain.handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
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
