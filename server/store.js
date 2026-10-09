'use strict';
// Einfache JSON-Datenhaltung. Für ein Homelab mit einigen Dutzend Clients reicht das
// völlig und kommt ohne native Abhängigkeiten aus.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SCRIPTS = [
  {
    name: 'Systemübersicht',
    description: 'Hostname, Uptime, Speicher und Datenträger',
    shell: 'bash',
    body: 'hostnamectl 2>/dev/null || hostname\necho\nuptime\necho\nfree -h\necho\ndf -h -x tmpfs -x devtmpfs',
  },
  {
    name: 'Updates installieren (apt)',
    description: 'apt update + upgrade ohne Rückfragen',
    shell: 'bash',
    timeout: 1800,
    body: 'export DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get -y upgrade\n[ -f /var/run/reboot-required ] && echo "*** Neustart erforderlich ***" || true',
  },
  {
    name: 'Docker-Container',
    description: 'Laufende und gestoppte Container auflisten',
    shell: 'bash',
    body: 'docker ps -a --format "table {{.Names}}\\t{{.Status}}\\t{{.Image}}"',
  },
  {
    name: 'Größte Verzeichnisse',
    description: 'Die 15 größten Verzeichnisse unter /',
    shell: 'bash',
    timeout: 600,
    body: 'du -xh / 2>/dev/null | sort -rh | head -n 15',
  },
  {
    name: 'Systemübersicht (Windows)',
    description: 'OS, Uptime, RAM und Datenträger',
    shell: 'powershell',
    body: '$os = Get-CimInstance Win32_OperatingSystem\n"{0} (Build {1})" -f $os.Caption, $os.BuildNumber\n"Uptime: {0}" -f ((Get-Date) - $os.LastBootUpTime)\n"RAM frei: {0:N1} GB von {1:N1} GB" -f ($os.FreePhysicalMemory/1MB), ($os.TotalVisibleMemorySize/1MB)\nGet-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Format-Table DeviceID, @{n="Frei (GB)";e={[math]::Round($_.FreeSpace/1GB,1)}}, @{n="Gesamt (GB)";e={[math]::Round($_.Size/1GB,1)}} -AutoSize',
  },
  {
    name: 'Temp-Dateien löschen (Windows)',
    description: 'Leert die Temp-Ordner von Windows und System',
    shell: 'powershell',
    body: '$paths = @("$env:windir\\Temp\\*", "$env:TEMP\\*")\nforeach ($p in $paths) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }\n"Temp-Ordner geleert."',
  },
  {
    name: 'Windows-Updates suchen',
    description: 'Listet verfügbare Updates (kann einige Minuten dauern)',
    shell: 'powershell',
    timeout: 900,
    body: '$s = New-Object -ComObject Microsoft.Update.Session\n$r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")\nif ($r.Updates.Count -eq 0) { "Keine Updates verfügbar." } else { $r.Updates | ForEach-Object { $_.Title } }',
  },
];

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    let data = {};
    if (fs.existsSync(this.file)) {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    }
    data.agents ??= {};
    data.sessions ??= {};
    data.history ??= [];
    data.settings ??= {};
    data.settings.thresholds ??= { cpu: 90, mem: 90, disk: 90 };
    data.enrollKey ??= crypto.randomBytes(18).toString('base64url');
    if (!data.scripts) {
      data.scripts = DEFAULT_SCRIPTS.map((s) => ({
        id: crypto.randomUUID(),
        timeout: 300,
        ...s,
        createdAt: Date.now(),
      }));
    }
    return data;
  }

  // Schreibt verzögert, damit z.B. viele lastSeen-Updates nicht ständig die Platte belasten.
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
