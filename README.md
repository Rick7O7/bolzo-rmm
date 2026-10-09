# BOLZO RMM

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

Empfohlen: ein eigener kleiner Debian/Ubuntu-LXC in Proxmox (1 GB RAM, 8 GB Disk). Auf dem
Container als root:

```bash
curl -fsSL https://raw.githubusercontent.com/Rick7O7/bolzo-rmm/main/install.sh | sudo bash
```

Das Skript holt sich den Code von GitHub, installiert eine eigene Node.js-Laufzeit nach
`/opt/bolzo-rmm`, legt den Dienst `bolzo-rmm` an und **gibt am Ende Adresse und Admin-Passwort aus**.
Konfiguration: `/etc/bolzo-rmm/bolzo-rmm.env`, Daten: `/var/lib/bolzo-rmm`.

- **Update:** denselben Befehl erneut ausführen (Clients, Daten und Passwort bleiben erhalten).
- **Status:** `systemctl status bolzo-rmm` · **Logs:** `journalctl -u bolzo-rmm -f`
- **Deinstallation:** `curl -fsSL https://raw.githubusercontent.com/Rick7O7/bolzo-rmm/main/uninstall.sh | sudo bash`
  (Daten bleiben; komplett löschen mit `| sudo bash -s -- --purge`)

### HTTPS (wichtig, sobald es übers Internet geht)

Der Server spricht selbst nur HTTP (Port 8095). Für Zugriffe von außen gehört nginx mit TLS davor.
Fertige Konfiguration: [`deploy/nginx/bolzo-rmm.conf`](deploy/nginx/bolzo-rmm.conf) (WebSockets
inklusive, SSL ergänzt certbot):

```bash
curl -fsSL https://raw.githubusercontent.com/Rick7O7/bolzo-rmm/main/deploy/nginx/bolzo-rmm.conf -o /etc/nginx/sites-available/bolzo-rmm
ln -s /etc/nginx/sites-available/bolzo-rmm /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d rmm.bolzo.net
```

Danach auf dem RMM-Server in `/etc/bolzo-rmm/bolzo-rmm.env` `PUBLIC_URL=https://rmm.bolzo.net`
setzen und `systemctl restart bolzo-rmm` ausführen. Eine direkte Portfreigabe von 8095 im Router
ist dann nicht mehr nötig und sollte geschlossen werden.

## 2. Desktop-App

**Installieren:** `BOLZO RMM Setup 1.0.0.exe` ausführen. Die App ist nicht signiert, deshalb zeigt
Windows beim ersten Start evtl. „Der Computer wurde durch Windows geschützt" → **Weitere
Informationen → Trotzdem ausführen**.

Beim ersten Start Server-Adresse (z.B. `http://10.0.0.50:8095` oder `https://rmm.deine-domain.de`)
und Admin-Passwort eingeben.

**Selbst bauen / entwickeln:**

```bash
cd desktop
npm install
npm start          # App direkt starten
npm run dist       # Installer bauen -> desktop/dist/BOLZO RMM Setup <version>.exe
npm run icon       # Icon/Logo-PNGs aus den SVGs in desktop/build/ neu erzeugen
```

## 3. Clients hinzufügen

In der App auf **„Client hinzufügen"** (Dashboard) oder unter **Einstellungen** klicken und den
passenden Einzeiler kopieren:

- **Linux** (als root): `curl -fsSL "https://…/install/linux.sh?key=…" | sudo bash`
- **Windows** (PowerShell als Administrator): `irm "https://…/install/windows.ps1?key=…" | iex`

Der Client erscheint nach wenigen Sekunden im Dashboard. Der Agent bringt eine eigene
Node.js-Laufzeit mit und läuft als systemd-Dienst `bolzo-rmm-agent` bzw. als geplante Aufgabe
`BolzoRMMAgent` (Konto SYSTEM). Logs: `journalctl -u bolzo-rmm-agent -f` bzw.
`C:\Program Files\BolzoRMMAgent\agent.log`.

## Updates

Alles lässt sich aus der App heraus aktualisieren: **Einstellungen → Updates**. Steht etwas
bereit, erscheint unten in der Seitenleiste „Update verfügbar".

- **Dashboard-App:** prüft beim Start und alle 4 Stunden die GitHub-Releases, lädt neue
  Versionen im Hintergrund und installiert sie per Klick („Jetzt installieren & neu starten").
- **Server:** „Server aktualisieren" lädt den neuesten Stand von GitHub (`main`) und startet neu.
  Technisch legt der Server nur eine Anforderungsdatei an; die systemd-Units
  `bolzo-rmm-update.path/.service` führen dann als root `install.sh` aus. Log:
  `/var/lib/bolzo-rmm/update.log`.
- **Agents:** erkennen veralteten Code per Fingerabdruck und aktualisieren sich nach einem
  Server-Update automatisch (abschaltbar), oder per Klick „Alle Agents aktualisieren".

**Neue Version veröffentlichen (Entwicklung):**

```bash
git push                      # Server + Agent: danach in der App "Server aktualisieren"
cd desktop
npm version minor             # bzw. patch – Dashboard-Version erhöhen
npm run release               # baut die Setup-EXE und legt das GitHub-Release an
```

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
