#!/usr/bin/env bash
# RMM Desk – Agent-Installation für Linux (systemd)
# Aufruf: curl -fsSL "__SERVER_URL__/install/linux.sh?key=..." | sudo bash
set -euo pipefail

SERVER="__SERVER_URL__"
KEY="__ENROLL_KEY__"
DIR="/opt/rmm-agent"
NODE_LINE="latest-v22.x"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (sudo)."
command -v systemctl >/dev/null || fail "systemd wird benötigt."
command -v curl >/dev/null || fail "curl wird benötigt."

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l) ARCH=armv7l ;;
  *) fail "Nicht unterstützte Architektur: $(uname -m)" ;;
esac

mkdir -p "$DIR"
cd "$DIR"

# Eigene Node.js-Laufzeit, damit nichts am System verändert wird
if [ ! -x "$DIR/node/bin/node" ] || ! "$DIR/node/bin/node" -e 'process.exit(typeof WebSocket==="undefined")' 2>/dev/null; then
  info "Lade Node.js ($NODE_LINE, $ARCH) ..."
  SUMS=$(curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt")
  FILE=$(echo "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$ARCH\.tar\.gz$" | head -n1)
  [ -n "$FILE" ] || fail "Node.js-Paket für $ARCH nicht gefunden."
  curl -fsSL -o "/tmp/$FILE" "https://nodejs.org/dist/$NODE_LINE/$FILE"
  echo "$SUMS" | grep " $FILE\$" | (cd /tmp && sha256sum -c --quiet -) || fail "Prüfsumme stimmt nicht."
  rm -rf "$DIR/node"
  mkdir -p "$DIR/node"
  tar -xzf "/tmp/$FILE" -C "$DIR/node" --strip-components=1
  rm -f "/tmp/$FILE"
fi

info "Lade Agent von $SERVER ..."
curl -fsSL -o "$DIR/agent.js" "$SERVER/agent/agent.js"

if [ ! -f "$DIR/config.json" ] || ! grep -q '"secret"' "$DIR/config.json"; then
  cat > "$DIR/config.json" <<EOF
{
  "server": "$SERVER",
  "enrollKey": "$KEY"
}
EOF
  chmod 600 "$DIR/config.json"
fi

cat > /etc/systemd/system/rmm-agent.service <<EOF
[Unit]
Description=RMM Desk Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$DIR/node/bin/node $DIR/agent.js
WorkingDirectory=$DIR
Restart=always
RestartSec=5
MemoryMax=150M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable rmm-agent >/dev/null 2>&1
systemctl restart rmm-agent

sleep 3
if systemctl is-active --quiet rmm-agent; then
  info "Fertig! $(hostname) erscheint jetzt in RMM Desk."
  info "Logs: journalctl -u rmm-agent -f"
else
  journalctl -u rmm-agent -n 20 --no-pager || true
  fail "Agent läuft nicht – siehe Log oben."
fi
