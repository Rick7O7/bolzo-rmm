# RMM Desk

Fernwartung und Überwachung für Homelab und kleine Umgebungen – ähnlich wie Tactical RMM,
aber mit einer **Windows-Desktop-App** statt Weboberfläche.

```
┌──────────────────┐   HTTPS/WSS    ┌──────────────────┐   WSS (ausgehend)   ┌───────────────┐
│ Desktop-App      │ ─────────────▶ │ Server (Node.js) │ ◀────────────────── │ Agent         │
│ (Electron, Win)  │                │ z.B. Proxmox-LXC │                     │ Linux/Windows │
└──────────────────┘                └──────────────────┘                     └───────────────┘
```

Die Agents bauen die Verbindung **selbst** zum Server auf. Auf den Clients müssen also keine
Ports geöffnet werden, und sie funktionieren auch hinter NAT.

## Funktionen

- **Dashboard** mit allen Clients: online/offline, CPU, RAM, Datenträger, Verlaufskurve, Warnungen
- **Client-Detail**: Live-Auslastung (letzte Stunde), Systeminfos, Netzwerkadapter, Datenträger
- **Terminal**: Bash mit echtem PTY unter Linux (vim, htop gehen), PowerShell unter Windows
- **Neustart / Herunterfahren / Wake-on-LAN** (WoL wird über einen anderen Client im selben Netz gesendet)
- **Prozesse** anzeigen und beenden, **Dienste** starten/stoppen/neu starten (systemd bzw. Windows-Dienste)
- **Skript-Bibliothek** (Bash, sh, PowerShell, CMD, Python) und Ausführung auf **mehreren Clients gleichzeitig**
- **Verlauf** aller Skriptausführungen inkl. Ausgabe und Exit-Code
- **Tags, Notizen, Umbenennen** pro Client
- **Warnschwellen** für CPU/RAM/Disk und **Windows-Benachrichtigungen**, wenn ein Client offline geht
- **Install-Einzeiler** für neue Clients (Linux + Windows) direkt aus der App kopierbar
- Agent **aktualisieren** oder **deinstallieren** per Klick

## 1. Server installieren

Empfohlen: ein eigener kleiner Debian/Ubuntu-LXC in Proxmox (512 MB RAM reichen, 1 GB ist komfortabel).

```bash
# Ordner server/ auf den Container kopieren, z.B.:
scp -r server root@<container-ip>:/root/rmm-server-src
ssh root@<container-ip> "bash /root/rmm-server-src/install-server.sh"
```

Das Skript installiert eine eigene Node.js-Laufzeit nach `/opt/rmm-server`, legt den Dienst
`rmm-server` an und **gibt das Admin-Passwort aus**. Konfiguration: `/etc/rmm-server/rmm.env`.
Erneutes Ausführen aktualisiert den Server (Daten bleiben unter `/var/lib/rmm-server`).

### HTTPS (wichtig, sobald es übers Internet geht)

Der Server spricht selbst nur HTTP (Port 8095). Für Zugriffe von außen gehört ein Reverse-Proxy
mit TLS davor (nginx, Caddy, Nginx Proxy Manager). WebSockets müssen durchgereicht werden:

```nginx
location / {
    proxy_pass http://<container-ip>:8095;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

Danach in `/etc/rmm-server/rmm.env` `PUBLIC_URL=https://rmm.deine-domain.de` setzen und
`systemctl restart rmm-server` ausführen. Alternativ nur über WireGuard/VPN erreichbar machen.

## 2. Desktop-App

```bash
cd desktop
npm install
npm start          # App direkt starten
npm run dist       # Windows-Installer bauen -> desktop/dist/
```

Beim ersten Start Server-Adresse (z.B. `http://10.0.0.50:8095` oder `https://rmm.deine-domain.de`)
und Admin-Passwort eingeben.

## 3. Clients hinzufügen

In der App auf **„Client hinzufügen"** (Dashboard) oder unter **Einstellungen** klicken und den
passenden Einzeiler kopieren:

- **Linux** (als root): `curl -fsSL "https://…/install/linux.sh?key=…" | sudo bash`
- **Windows** (PowerShell als Administrator): `irm "https://…/install/windows.ps1?key=…" | iex`

Der Client erscheint nach wenigen Sekunden im Dashboard. Der Agent bringt eine eigene
Node.js-Laufzeit mit und läuft als systemd-Dienst `rmm-agent` bzw. als geplante Aufgabe
`RMMDeskAgent` (Konto SYSTEM). Logs: `journalctl -u rmm-agent -f` bzw.
`C:\Program Files\RMMDeskAgent\agent.log`.

## Sicherheit

- Wer das Admin-Passwort hat, hat **Root/SYSTEM-Zugriff auf alle Clients**. Starkes Passwort verwenden.
- Den Server nicht ohne HTTPS ins Internet stellen.
- Der Installationsschlüssel erlaubt nur das Registrieren neuer Clients. Er kann jederzeit in den
  Einstellungen erneuert werden; installierte Agents bleiben davon unberührt.
- Jeder Agent hat ein eigenes Geheimnis (auf dem Server nur als Hash gespeichert). Ein in der App
  gelöschter Client kann sich nicht mehr verbinden.
- 5 falsche Login-Versuche sperren die IP für 10 Minuten.

## Bekannte Grenzen

- Windows-Terminal ist zeilenbasiert (kein ConPTY): interaktive Vollbildprogramme laufen dort nicht.
- Netzwerkdurchsatz wird nur unter Linux erfasst.
- Verlaufsdaten der Auslastung liegen im Speicher des Servers (letzte Stunde) und gehen bei einem Neustart verloren.

## Projektstruktur

```
server/            Server (Express + ws), Datenhaltung in data/db.json
  agent/agent.js   Agent, wird von den Clients beim Installieren geladen
  templates/       Install-Skripte für Linux und Windows
  install-server.sh
desktop/           Electron-App
  renderer/        Oberfläche (HTML/CSS/JS, xterm.js fürs Terminal)
```
