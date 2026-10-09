// Rendert die Logo-SVGs als PNG – Aufruf: npm run icon
//   logo.svg      -> icon.png  (App-Icon, 512 px)
//   logo-full.svg -> logo.png  (Logo mit Schriftzug, für dunkle Hintergründe)
//   logo-full-light.svg -> logo-light.png  (für helle Hintergründe)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

async function render(src, out, width, height) {
  const svg = fs.readFileSync(path.join(__dirname, src), 'utf8');
  const win = new BrowserWindow({ width, height, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  fs.writeFileSync(path.join(__dirname, out), img.resize({ width, height }).toPNG());
  win.destroy();
  console.log(`${out} geschrieben`);
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // zwischen den Renderings nicht beenden
app.whenReady().then(async () => {
  await render('logo.svg', 'icon.png', 512, 512);
  await render('logo-full.svg', 'logo.png', 1600, 400);
  await render('logo-full-light.svg', 'logo-light.png', 1600, 400);
  app.quit();
});
