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
- **Jobs**: fester Befehl auf festen Rechnern, z.B. „Minecraft-Server starten“ auf SRV-MC – per Klick oder
  per Telefon („Starte den Minecraft-Server“). Vorlagen für Programme in tmux (starten, sauber beenden, läuft es?).
  Unter Linux startet der Agent Skripte und Jobs in einem eigenen systemd-Scope: Was sie im Hintergrund
  starten, hängt nicht am Speicherlimit des Agents und läuft auch nach einem Agent-Update weiter.
- **Protokoll (Audit-Log)** unter Verlauf: wer hat wann was getan – Anmeldungen (auch fehlgeschlagene),
  Neustart/Herunterfahren, Befehle und Skripte, Terminal-Sitzungen, Prozesse/Dienste, Einstellungen,
  API-Zugänge (z.B. Telefon), Updates, Online/Offline. Mit Filter, Suche und CSV-Export. Der Server hängt
  jeden Eintrag an `/var/lib/bolzo-rmm/audit.jsonl` an; aus der App lässt sich das Protokoll nicht löschen.
  Terminal-Eingaben werden bewusst nicht mitgeschrieben (darin können Passwörter stehen).
- **Skript-Ausgaben** der letzten 300 Ausführungen inkl. Ausgabe und Exit-Code
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

## Proxmox

Läuft der BOLZO-Agent (ab 1.3.0) auf einem Proxmox-Server, erkennt er das selbst. Der Client bekommt
dann einen Tab **Proxmox** mit allen VMs und Containern (Status, CPU, RAM, Laufzeit), dazu Starten,
Herunterfahren, Neustart und hartes Ausschalten.

- **Zuordnen:** Client → ⋯ → „Proxmox-VM zuordnen“, oder im Proxmox-Tab **Automatisch zuordnen**
  (vergleicht die MAC-Adressen der VMs mit denen der Clients).
- **Konsole:** Zugeordnete Clients haben oben den Knopf **Konsole**. Er geht auch dann, wenn der
  Gast hängt oder der Agent darin nicht läuft.
  - **VM:** Bildschirm per noVNC. **Text einfügen** tippt die Zwischenablage in die VM; dafür oben das
    Tastaturlayout der VM wählen. Dazu Strg+Alt+Entf, Anpassen/1:1 und Vollbild.
  - **Container:** echtes Terminal (`pct enter`). Kopieren und Einfügen gehen in beide Richtungen.
- **Aufwecken** startet zugeordnete VMs und Container über Proxmox statt per Wake-on-LAN, auch über
  die Telefon-Sprachsteuerung.
- **Einstellungen pro Gast** (⚙): Name, Kerne, RAM, Swap, Autostart/Startreihenfolge, Tags,
  Beschreibung. Netzwerk: Brücke, VLAN, Firewall, bei Containern IP/Gateway. Dazu Snapshots
  (anlegen, zurückrollen, löschen) und Backups (sofort starten, vorhandene ansehen).
- **Host:** Speicher mit Belegung, Updates (prüfen, installieren, Host neu starten), Aufgaben-Liste
  und **Netzwerk-Brücken** (anlegen, bearbeiten, löschen). Netzwerk-Änderungen werden gesammelt und
  mit „Übernehmen“ aktiv. Ist der Server danach nicht erreichbar, stellt der Agent die alte
  Konfiguration automatisch wieder her.

Technisch: Der Host-Agent setzt per QEMU-Monitor ein Einmal-Passwort, das 60 s gilt. Dann verbindet er
den VNC-Socket der VM über einen eigenen WebSocket (`/ws/tunnel`) mit dem Server, der die Daten
unverändert an die App reicht (`/ws/console`). Am Proxmox muss dafür nichts eingerichtet werden.

## Sprachsteuerung per Telefon (optional)

Eine ungenutzte Festnetznummer der FRITZ!Box anrufen, PIN eintippen und z.B. „Fahr SRV-MC herunter"
sagen. Ein kleiner Dienst auf einem Gerät **im FRITZ!Box-Netz** (Raspberry Pi 5 oder Mini-PC; ein Pi 4 geht,
braucht aber spürbar länger für die Antwort) meldet sich als IP-Telefon an, erkennt die Sprache lokal (Whisper), lässt Claude den
Befehl verstehen und führt ihn über einen eingeschränkten API-Zugang aus. Jede Aktion wird vorher
rückgefragt („Ja" sagen oder Taste 1). Was am Telefon geht, bestimmen die Rechte des API-Zugangs (in der App
jederzeit änderbar, der Schlüssel bleibt gleich): Status, Neustart/Herunterfahren/Aufwecken, Prozesse beenden,
Dienste steuern, Proxmox-VMs starten/stoppen, gespeicherte Skripte und vorbereitete **Jobs** ausführen
(„Starte den Minecraft-Server“ – Rechner und Befehl stehen im Job fest) und – nur wenn angehakt –
ausgeschaltete VMs löschen (dafür zusätzlich die VM-Nummer auf der Tastatur eintippen). Terminal und frei
diktierte Befehle gibt es am Telefon nie.

1. **FRITZ!Box:** Telefonie → Telefoniegeräte → Neues Gerät → Telefon → „LAN/WLAN (IP-Telefon)";
   Benutzername + Kennwort vergeben; ausgehend und ankommend **nur** die ungenutzte Nummer.
   Bei allen anderen Telefonen diese Nummer abwählen. „Anmeldung aus dem Internet" bleibt aus.
2. **App:** Einstellungen → API-Zugänge → Zugang „Telefon" mit den gewünschten Rechten anlegen, Schlüssel kopieren.
3. **Gerät zu Hause:**

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Rick7O7/bolzo-rmm/main/voice/install-voice.sh | sudo bash
   ```

4. `/etc/bolzo-voice/voice.env` ausfüllen (FRITZ!Box-Zugang, `RMM_TOKEN`, eigener
   `ANTHROPIC_API_KEY` von console.anthropic.com, `PIN`), dann `systemctl restart bolzo-voice`.
   Logs: `journalctl -u bolzo-voice -f`.

## Sicherheit

- Wer das Admin-Passwort hat, hat **Root/SYSTEM-Zugriff auf alle Clients**. Starkes Passwort verwenden.
- Den Server nicht ohne HTTPS ins Internet stellen.
- Clients im Heimnetz verbinden sich oft per `http://` direkt mit dem Server – dann laufen Befehle
  und Terminal unverschlüsselt durchs LAN. Besser: im Router/DNS (z.B. OPNsense → Unbound → Host
  Overrides) `rmm.bolzo.net` intern auf den nginx zeigen lassen und die Agents per
  „Verbindung der Agents" auf `https://` umziehen.
- Der Installationsschlüssel erlaubt nur das Registrieren neuer Clients und gilt 24 Stunden (die App
  zeigt immer einen frischen). „Neuen Schlüssel erzeugen" macht alle bisherigen sofort ungültig;
  installierte Agents bleiben davon unberührt. Ein laufender Client kann nicht per Neuinstallation
  „übernommen" werden.
- Jeder Agent hat ein eigenes Geheimnis (auf dem Server nur als Hash gespeichert). Ein in der App
  gelöschter Client kann sich nicht mehr verbinden.
- Anmeldungen gelten 30 Tage, enden aber sofort, wenn sich das Admin-Passwort ändert. „Andere Geräte
  abmelden" (Einstellungen → Server) beendet alle anderen Anmeldungen.
- Live-Verbindungen melden sich mit einem 60 Sekunden gültigen Einmal-Ticket an; Download-Links gelten
  30 Minuten und nur für Dateien des gerade angezeigten Ordners. Die nginx-Vorlage protokolliert
  Adressen ohne Query-String, damit keine Schlüssel in Logs landen.
- 5 falsche Login-Versuche sperren die IP für 10 Minuten, 30 Fehlversuche insgesamt sperren die
  Anmeldung für alle für 10 Minuten.
- API-Zugänge (Sprachsteuerung) sehen die Notizen der Clients nicht.
- Sprachsteuerung: SIP-Nachrichten werden nur von der FRITZ!Box angenommen. Falsche PINs sperren
  nach 6 Versuchen pro Stunde bzw. 15 pro Tag alle Anrufe (bleibt auch über Neustarts erhalten).
  PIN mit mindestens 6 Ziffern verwenden.

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
