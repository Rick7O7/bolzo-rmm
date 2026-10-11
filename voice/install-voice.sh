#!/usr/bin/env bash
# BOLZO RMM – Sprachsteuerung per Telefon installieren/aktualisieren
# (Debian, Ubuntu, Raspberry Pi OS – arm64 oder x86_64; Gerät im FRITZ!Box-Netz)
#   curl -fsSL https://raw.githubusercontent.com/Rick7O7/bolzo-rmm/main/voice/install-voice.sh | sudo bash
# Erneut ausführen = Update. Die Konfiguration in /etc/bolzo-voice/voice.env bleibt erhalten.
set -euo pipefail

REPO_URL="${BOLZO_RMM_REPO:-https://github.com/Rick7O7/bolzo-rmm.git}"
BRANCH="${BOLZO_RMM_BRANCH:-main}"
APP=/opt/bolzo-voice
CONF=/etc/bolzo-voice
PIPER_RELEASE="https://github.com/rhasspy/piper/releases/download/2023.11.14-2"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium"
VOICE=de_DE-thorsten-medium

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (sudo)."
command -v systemctl >/dev/null || fail "systemd wird benötigt."
case "$(uname -m)" in
  aarch64|arm64) PIPER_ARCH=aarch64 ;;
  x86_64) PIPER_ARCH=x86_64 ;;
  *) fail "Nicht unterstützte Architektur: $(uname -m) (benötigt 64 Bit: arm64 oder x86_64)" ;;
esac

info "Systempakete installieren ..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq ca-certificates curl git python3 python3-venv python3-pip >/dev/null

id bolzo-voice >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin bolzo-voice
mkdir -p "$APP" "$CONF" "$APP/models" "$APP/voices"

info "Lade BOLZO RMM von GitHub ..."
rm -rf "$APP/src"
git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP/src"
cp "$APP/src/voice/bridge.py" "$APP/src/voice/requirements.txt" "$APP/"
rm -rf "$APP/src"

info "Python-Umgebung einrichten (dauert beim ersten Mal einige Minuten) ..."
[ -x "$APP/venv/bin/python" ] || python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install --quiet --upgrade pip
"$APP/venv/bin/pip" install --quiet -r "$APP/requirements.txt"

if [ ! -x "$APP/piper/piper" ]; then
  info "Sprachausgabe Piper laden ..."
  curl -fsSL "$PIPER_RELEASE/piper_linux_${PIPER_ARCH}.tar.gz" | tar -xz -C "$APP"
fi
if [ ! -f "$APP/voices/$VOICE.onnx" ]; then
  info "Deutsche Stimme laden ..."
  curl -fsSL -o "$APP/voices/$VOICE.onnx" "$VOICE_BASE/$VOICE.onnx"
  curl -fsSL -o "$APP/voices/$VOICE.onnx.json" "$VOICE_BASE/$VOICE.onnx.json"
fi

if [ ! -f "$CONF/voice.env" ]; then
  cat > "$CONF/voice.env" <<'EOF'
# BOLZO RMM – Sprachsteuerung. Nach Änderungen: systemctl restart bolzo-voice

# FRITZ!Box: unter Telefonie -> Telefoniegeräte angelegtes IP-Telefon
FRITZBOX_HOST=fritz.box
SIP_USER=
SIP_PASS=

# BOLZO RMM: API-Zugang aus der App (Einstellungen -> API-Zugänge), Rechte "Status" und "Neustart/..."
RMM_URL=https://rmm.bolzo.net
RMM_TOKEN=

# Claude: eigener API-Schlüssel von console.anthropic.com
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-opus-5-5
CLAUDE_EFFORT=low

# PIN, die du nach dem Anruf per Tastatur eingibst (4-12 Ziffern)
PIN=
# Optional: nur diese Anrufernummern zulassen (kommagetrennt, z.B. 0171...). Leer = alle mit PIN.
ALLOWED_CALLERS=

# Spracherkennung: small (empfohlen). base ist schneller, versteht Telefon-Audio aber deutlich schlechter.
WHISPER_MODEL=small
EOF
fi
chown root:bolzo-voice "$CONF/voice.env"
chmod 640 "$CONF/voice.env"

WHISPER_MODEL="$(grep -E '^WHISPER_MODEL=' "$CONF/voice.env" | cut -d= -f2 | tr -d '"' )"
info "Spracherkennungs-Modell '${WHISPER_MODEL:-small}' vorab laden ..."
"$APP/venv/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL:-small}', device='cpu', compute_type='int8', download_root='$APP/models')" \
  || echo "    (wird beim ersten Start geladen)"

chown -R bolzo-voice:bolzo-voice "$APP"

cat > /etc/systemd/system/bolzo-voice.service <<EOF
[Unit]
Description=BOLZO RMM Sprachsteuerung (Telefon)
After=network-online.target
Wants=network-online.target

[Service]
User=bolzo-voice
Group=bolzo-voice
EnvironmentFile=$CONF/voice.env
Environment=WHISPER_DIR=$APP/models
Environment=PIPER_BIN=$APP/piper/piper
Environment=PIPER_VOICE=$APP/voices/$VOICE.onnx
Environment=HF_HOME=$APP/models
WorkingDirectory=$APP
ExecStart=$APP/venv/bin/python $APP/bridge.py
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bolzo-voice >/dev/null 2>&1
systemctl restart bolzo-voice

echo
info "Installiert."
if grep -qE '^(SIP_USER|SIP_PASS|RMM_TOKEN|ANTHROPIC_API_KEY|PIN)=$' "$CONF/voice.env"; then
  info "Jetzt die Konfiguration ausfüllen:  nano $CONF/voice.env"
  info "Danach starten:                     systemctl restart bolzo-voice"
fi
info "Logs: journalctl -u bolzo-voice -f"
info "Test ohne Telefon: sudo -u bolzo-voice env \$(grep -v '^#' $CONF/voice.env | xargs) $APP/venv/bin/python $APP/bridge.py --test-text \"Welche Rechner sind offline?\""
