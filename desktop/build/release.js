// Veröffentlicht die gebaute Setup-EXE als GitHub-Release, damit installierte Apps
// sich selbst aktualisieren. Aufruf: npm run release  (baut vorher automatisch)
// Release-Notiz optional: RELEASE_NOTES="..." npm run release
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const dist = path.join(root, 'dist');
const exe = `BOLZO-RMM-Setup-${version}.exe`;
const files = [exe, `${exe}.blockmap`, 'latest.yml'].map((f) => path.join(dist, f));

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`Fehlt: ${f} – zuerst "npm run dist" ausführen.`);
    process.exit(1);
  }
}

const notes = process.env.RELEASE_NOTES || `BOLZO RMM Dashboard ${version}`;
execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--repo', 'Rick7O7/bolzo-rmm', '--title', `BOLZO RMM ${version}`, '--notes', notes], { stdio: 'inherit' });
console.log(`Release v${version} veröffentlicht – installierte Apps finden das Update automatisch.`);
