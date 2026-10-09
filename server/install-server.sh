#!/usr/bin/env bash
# BOLZO RMM – Server-Installation (Debian/Ubuntu mit systemd, z.B. Proxmox-LXC)
# Aufruf aus dem server/-Ordner:  sudo bash install-server.sh
# Erneut ausführen = Update (Daten und Passwort bleiben erhalten).
set -euo pipefail

APP=/opt/bolzo-rmm
DATA=/var/lib/bolzo-rmm
CONF=/etc/bolzo-rmm
PORT="${PORT:-8095}"
NODE_LINE="latest-v22.x"
SRC="$(cd "$(dirname "$0")" && pwd)"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen."
[ -f "$SRC/server.js" ] || fail "server.js nicht gefunden – Skript bitte aus dem server/-Ordner starten."
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl; }

case "$(uname -m)" in
  x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) fail "Nicht unterstützte Architektur: $(uname -m)" ;;
esac

id bolzo-rmm >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin bolzo-rmm
mkdir -p "$APP" "$DATA" "$CONF"

if [ ! -x "$APP/node/bin/node" ]; then
  info "Lade Node.js ($NODE_LINE) ..."
  SUMS=$(curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt")
  FILE=$(echo "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$ARCH\.tar\.gz$" | head -n1)
  curl -fsSL -o "/tmp/$FILE" "https://nodejs.org/dist/$NODE_LINE/$FILE"
  echo "$SUMS" | grep " $FILE\$" | (cd /tmp && sha256sum -c --quiet -) || fail "Prüfsumme stimmt nicht."
  mkdir -p "$APP/node"
  tar -xzf "/tmp/$FILE" -C "$APP/node" --strip-components=1
  rm -f "/tmp/$FILE"
fi

info "Kopiere Programmdateien nach $APP ..."
cp -r "$SRC/server.js" "$SRC/store.js" "$SRC/package.json" "$SRC/agent" "$SRC/templates" "$APP/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$APP/"
cd "$APP"
info "Installiere Abhängigkeiten ..."
PATH="$APP/node/bin:$PATH" npm install --omit=dev --no-audit --no-fund --silent

NEW_PW=""
if [ ! -f "$CONF/bolzo-rmm.env" ]; then
  NEW_PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)
  cat > "$CONF/bolzo-rmm.env" <<EOF
# BOLZO RMM Server – Konfiguration (nach Änderung: systemctl restart bolzo-rmm)
PORT=$PORT
HOST=0.0.0.0
DATA_DIR=$DATA
ADMIN_PASSWORD=$NEW_PW
# Öffentliche Adresse, unter der Agents den Server erreichen (z.B. https://rmm.example.de).
# Leer = Adresse, mit der sich die Desktop-App verbunden hat.
PUBLIC_URL=
EOF
fi
chown -R bolzo-rmm:bolzo-rmm "$DATA"
chown root:bolzo-rmm "$CONF/bolzo-rmm.env"
chmod 640 "$CONF/bolzo-rmm.env"

cat > /etc/systemd/system/bolzo-rmm.service <<EOF
[Unit]
Description=BOLZO RMM Server
After=network-online.target
Wants=network-online.target

[Service]
User=bolzo-rmm
Group=bolzo-rmm
EnvironmentFile=$CONF/bolzo-rmm.env
WorkingDirectory=$APP
ExecStart=$APP/node/bin/node $APP/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bolzo-rmm >/dev/null 2>&1
systemctl restart bolzo-rmm
sleep 2
systemctl is-active --quiet bolzo-rmm || { journalctl -u bolzo-rmm -n 30 --no-pager; fail "Server startet nicht."; }

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
info "BOLZO RMM Server läuft:  http://$IP:$PORT"
if [ -n "$NEW_PW" ]; then
  info "Admin-Passwort:        $NEW_PW"
  echo "    (steht auch in $CONF/bolzo-rmm.env – bitte notieren)"
fi
info "Logs: journalctl -u bolzo-rmm -f"
