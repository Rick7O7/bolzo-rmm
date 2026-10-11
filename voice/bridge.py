#!/usr/bin/env python3
"""BOLZO RMM – Sprachsteuerung per Telefon.

Meldet sich als IP-Telefon an der FRITZ!Box an. Ein Anruf läuft so ab:
  PIN per Tastatur -> Sprachbefehl -> Whisper (Sprache zu Text) -> Claude (Text zu Befehl)
  -> Rückfrage per Taste 1 -> BOLZO RMM führt aus -> Antwort per Sprachausgabe (Piper).

Konfiguration über Umgebungsvariablen (siehe /etc/bolzo-voice/voice.env).
Testen ohne Telefon:  bridge.py --test-text "Welche Server sind offline?"
"""
import argparse
import collections
import hmac
import json
import logging
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import wave

import anthropic
import httpx
import numpy as np

log = logging.getLogger("bolzo-voice")

RATE = 8000          # Telefon-Abtastrate
FRAME = 160          # 20 ms bei 8 kHz, 8 bit
VERBS = {"reboot": "neu starten", "shutdown": "herunterfahren", "wake": "aufwecken"}
DONE = {"reboot": "wird neu gestartet", "shutdown": "wird heruntergefahren", "wake": "wird aufgeweckt"}
GOODBYE = re.compile(r"^(nein|nichts|danke|tschüss|tschüs|ende|auflegen|das war'?s|das wars|bye)\b")


# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------
def load_config():
    e = os.environ.get
    cfg = {
        "fritzbox": e("FRITZBOX_HOST", "fritz.box"),
        "sip_port": int(e("SIP_PORT", "5060")),
        "local_sip_port": int(e("LOCAL_SIP_PORT", "5060")),
        "sip_user": e("SIP_USER", ""),
        "sip_pass": e("SIP_PASS", ""),
        "local_ip": e("LOCAL_IP", ""),
        "rmm_url": e("RMM_URL", "https://rmm.bolzo.net").rstrip("/"),
        "rmm_token": e("RMM_TOKEN", ""),
        "model": e("CLAUDE_MODEL", "claude-opus-5-5"),
        "effort": e("CLAUDE_EFFORT", "low"),
        "pin": e("PIN", ""),
        "allowed": [n for n in re.split(r"[,\s]+", e("ALLOWED_CALLERS", "")) if n],
        "whisper_model": e("WHISPER_MODEL", "small"),
        "whisper_dir": e("WHISPER_DIR", "/opt/bolzo-voice/models"),
        "piper_bin": e("PIPER_BIN", "/opt/bolzo-voice/piper/piper"),
        "piper_voice": e("PIPER_VOICE", "/opt/bolzo-voice/voices/de_DE-thorsten-medium.onnx"),
    }
    return cfg


def missing_config(cfg, need_phone=True):
    keys = ["rmm_token", "pin"] + (["sip_user", "sip_pass"] if need_phone else [])
    missing = [k for k in keys if not cfg[k]]
    if not os.environ.get("ANTHROPIC_API_KEY"):
        missing.append("anthropic_api_key")
    if cfg["pin"] and not re.fullmatch(r"\d{4,12}", cfg["pin"]):
        missing.append("pin (4-12 Ziffern)")
    return missing


# ---------------------------------------------------------------------------
# Audio-Helfer (Telefon-Audio: 8 kHz, 8 bit unsigned, mono)
# ---------------------------------------------------------------------------
def u8_to_float(b):
    return (np.frombuffer(b, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0


def float_to_u8(x):
    return np.clip(x * 127.0 + 128.0, 0, 255).astype(np.uint8).tobytes()


def resample(x, src, dst):
    if src == dst or len(x) == 0:
        return x.astype(np.float32)
    t_out = np.arange(0, len(x) / src, 1 / dst)
    return np.interp(t_out, np.arange(len(x)) / src, x).astype(np.float32)


# ---------------------------------------------------------------------------
# Sprachausgabe (Piper)
# ---------------------------------------------------------------------------
class Tts:
    def __init__(self, piper_bin, voice):
        self.bin = piper_bin
        self.voice = voice
        with open(voice + ".json", encoding="utf8") as f:
            self.rate = json.load(f)["audio"]["sample_rate"]
        self.cache = {}
        self.lock = threading.Lock()

    def synth(self, text):
        """Text -> Telefon-Audio (8 kHz, 8 bit)."""
        if text in self.cache:
            return self.cache[text]
        with self.lock:
            p = subprocess.run([self.bin, "--model", self.voice, "--output_raw"], input=text.encode("utf8"),
                               capture_output=True, timeout=60, check=True)
        pcm = np.frombuffer(p.stdout, dtype="<i2").astype(np.float32) / 32768.0
        # leichter Tiefpass gegen Aliasing, dann auf 8 kHz und lauter machen
        k = max(1, round(self.rate / RATE))
        if k > 1:
            pcm = np.convolve(pcm, np.ones(k) / k, mode="same")
        out = resample(pcm, self.rate, RATE)
        peak = float(np.max(np.abs(out))) if len(out) else 0
        if peak > 1e-3:
            out = out * (0.9 / peak)
        audio = float_to_u8(out) + bytes([128]) * (RATE // 5)  # 200 ms Pause danach
        if len(self.cache) < 200:
            self.cache[text] = audio
        return audio


# ---------------------------------------------------------------------------
# Spracherkennung (faster-whisper, lokal)
# ---------------------------------------------------------------------------
class Stt:
    def __init__(self, model, download_dir):
        from faster_whisper import WhisperModel  # erst hier laden – dauert ein paar Sekunden
        log.info("Lade Whisper-Modell '%s' ...", model)
        self.model = WhisperModel(model, device="cpu", compute_type="int8", download_root=download_dir)
        self.lock = threading.Lock()

    def transcribe(self, audio8k, hint=""):
        audio16k = resample(audio8k, RATE, 16000)
        with self.lock:
            segments, _ = self.model.transcribe(audio16k, language="de", beam_size=1,
                                                initial_prompt=hint or None, condition_on_previous_text=False)
            return " ".join(s.text.strip() for s in segments).strip()


# ---------------------------------------------------------------------------
# BOLZO RMM (eingeschränkter API-Zugang)
# ---------------------------------------------------------------------------
class Rmm:
    def __init__(self, url, token):
        self.http = httpx.Client(base_url=url, headers={"Authorization": f"Bearer {token}"}, timeout=30)

    def _check(self, r):
        if r.status_code >= 400:
            try:
                msg = r.json().get("error")
            except ValueError:
                msg = None
            raise RuntimeError(msg or f"HTTP {r.status_code}")
        return r.json()

    def clients(self):
        return self._check(self.http.get("/api/agents"))

    def power(self, client_id, action):
        if action == "wake":
            return self._check(self.http.post(f"/api/agents/{client_id}/wake"))
        return self._check(self.http.post(f"/api/agents/{client_id}/action", json={"action": action}))


def client_summary(a):
    m = a.get("metrics") or {}
    mem = m.get("mem") or {}
    s = {
        "id": a["id"],
        "name": a.get("name"),
        "hostname": a.get("hostname"),
        "online": a.get("online"),
        "os": a.get("os"),
        "tags": a.get("tags") or [],
        "warnings": [al.get("label") for al in a.get("alerts") or [] if al.get("kind") != "offline"],
    }
    if a.get("online") and m:
        s["cpu_percent"] = round(m.get("cpu") or 0)
        if mem.get("total"):
            s["ram_percent"] = round(100 * mem["used"] / mem["total"])
        s["disks"] = [{"mount": d["mount"], "percent": round(100 * d["used"] / d["size"])} for d in m.get("disks") or [] if d.get("size")]
        if m.get("uptime") is not None:
            s["uptime_hours"] = round(m["uptime"] / 3600, 1)
    elif a.get("lastSeen"):
        s["offline_since"] = time.strftime("%d.%m.%Y %H:%M", time.localtime(a["lastSeen"] / 1000))
    return s


# ---------------------------------------------------------------------------
# Claude: Sprachbefehl -> Aktion
# ---------------------------------------------------------------------------
SYSTEM = """Du bist der Telefon-Assistent von BOLZO RMM, einer Fernwartung für Server und PCs.
Der Anrufer hat sich bereits per PIN ausgewiesen. Seine Sätze kommen aus einer Spracherkennung und
können Hörfehler enthalten – Rechnernamen werden oft verstümmelt (z.B. "SRV MC", "Server MC", "S R V M C"
für SRV-MC). Löse Namen über list_clients auf; Spitznamen über Tags oder Hostnamen sind erlaubt.

Du kannst nur: Status abfragen, Rechner neu starten, herunterfahren oder per Wake-on-LAN aufwecken.
Skripte, Terminal und Einstellungen gibt es am Telefon nicht – sag das freundlich, wenn danach gefragt wird.
Ist unklar, welcher Rechner gemeint ist, frag kurz nach statt zu raten. Für mehrere Rechner rufst du
power_action je Rechner einmal auf. Der Anrufer bestätigt jede Aktion selbst per Tastendruck.

Deine Antworten werden vorgelesen: höchstens zwei bis drei kurze Sätze, keine Listen, kein Markdown,
keine Emojis, keine IDs. Zahlen rund und gesprochen ("85 Prozent"). Sprich Deutsch."""

TOOLS = [
    {
        "name": "list_clients",
        "description": "Liefert alle verwalteten Rechner mit id, Name, Hostname, Tags, online/offline, CPU-, RAM- und "
                       "Datenträger-Auslastung in Prozent, Laufzeit und Warnungen. Vor jeder Aktion aufrufen, um den "
                       "gemeinten Rechner und seine id zu finden.",
        "strict": True,
        "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
    },
    {
        "name": "power_action",
        "description": "Startet einen Rechner neu (reboot), fährt ihn herunter (shutdown) oder weckt einen "
                       "ausgeschalteten Rechner per Wake-on-LAN (wake). Der Anrufer wird vorher per Tastendruck um "
                       "Bestätigung gebeten; das Ergebnis sagt, ob er bestätigt hat und ob es geklappt hat.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "client_id": {"type": "string", "description": "id des Rechners aus list_clients"},
                "action": {"type": "string", "enum": ["reboot", "shutdown", "wake"]},
            },
            "required": ["client_id", "action"],
            "additionalProperties": False,
        },
    },
]


class Assistant:
    def __init__(self, rmm, model, effort):
        self.rmm = rmm
        self.model = model
        self.effort = effort
        self.client = anthropic.Anthropic()

    def _tool(self, name, args, confirm):
        """Führt ein Tool aus. Gibt (Text, ist_fehler) zurück."""
        if name == "list_clients":
            return json.dumps([client_summary(a) for a in self.rmm.clients()], ensure_ascii=False), False
        if name == "power_action":
            action = args.get("action")
            target = next((a for a in self.rmm.clients() if a["id"] == args.get("client_id")), None)
            if action not in VERBS:
                return "Unbekannte Aktion.", True
            if not target:
                return "Diesen Rechner gibt es nicht. Erst list_clients aufrufen.", True
            if action != "wake" and not target.get("online"):
                return f"{target['name']} ist offline – das geht nur, wenn er online ist.", True
            if action == "wake" and target.get("online"):
                return f"{target['name']} ist bereits online.", True
            if not confirm(f"Soll ich {target['name']} wirklich {VERBS[action]}?"):
                return "Der Anrufer hat nicht bestätigt – nichts ausgeführt.", False
            try:
                self.rmm.power(target["id"], action)
            except Exception as e:  # Fehler vom RMM-Server an Claude zurückgeben
                return f"Fehlgeschlagen: {e}", True
            log.info("Ausgeführt: %s -> %s", action, target["name"])
            return f"Ausgeführt: {target['name']} {DONE[action]}.", False
        return f"Unbekanntes Tool {name}.", True

    def ask(self, messages, text, confirm):
        """Verarbeitet einen Satz des Anrufers. messages wird fortgeschrieben (nur anhängen)."""
        messages.append({"role": "user", "content": text})
        for _ in range(8):
            try:
                resp = self.client.beta.messages.create(
                    model=self.model,
                    max_tokens=16000,
                    system=SYSTEM,
                    tools=TOOLS,
                    messages=messages,
                    output_config={"effort": self.effort},
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                )
            except anthropic.AuthenticationError:
                log.error("Anthropic-API-Schlüssel ungültig")
                return "Die Verbindung zur KI ist nicht eingerichtet."
            except anthropic.RateLimitError:
                return "Die KI ist gerade ausgelastet. Bitte versuch es gleich noch einmal."
            except anthropic.APIStatusError as e:
                log.error("Claude-Fehler %s: %s", e.status_code, e.message)
                return "Die KI hat einen Fehler gemeldet."
            except anthropic.APIConnectionError:
                return "Ich erreiche die KI gerade nicht."

            messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason == "refusal":
                return "Das kann ich leider nicht ausführen."
            if resp.stop_reason == "tool_use":
                results = []
                for block in resp.content:
                    if block.type != "tool_use":
                        continue
                    try:
                        out, err = self._tool(block.name, block.input, confirm)
                    except Hangup:
                        raise
                    except Exception as e:
                        out, err = f"Fehler: {e}", True
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": out, "is_error": err})
                messages.append({"role": "user", "content": results})
                continue
            spoken = " ".join(b.text for b in resp.content if b.type == "text").strip()
            return spoken or "Erledigt."
        return "Das hat zu lange gedauert. Bitte versuch es noch einmal."


# ---------------------------------------------------------------------------
# Anruf
# ---------------------------------------------------------------------------
class Hangup(Exception):
    pass


class Lockout:
    """Sperrt nach zu vielen falschen PINs alle Anrufe für eine Stunde."""

    def __init__(self, limit=6, window=3600):
        self.fails = collections.deque()
        self.limit, self.window = limit, window
        self.lock = threading.Lock()

    def _trim(self):
        while self.fails and self.fails[0] < time.time() - self.window:
            self.fails.popleft()

    def locked(self):
        with self.lock:
            self._trim()
            return len(self.fails) >= self.limit

    def fail(self):
        with self.lock:
            self.fails.append(time.time())


def normalize_number(n):
    d = re.sub(r"\D", "", n or "")
    if d.startswith("0049"):
        d = d[4:]
    elif d.startswith("49") and len(d) > 10:
        d = d[2:]
    return d.lstrip("0")


def caller_number(call):
    try:
        f = call.request.headers.get("From")
        return (f.get("number") or f.get("caller") or "") if isinstance(f, dict) else str(f or "")
    except Exception:
        return ""


class CallSession:
    def __init__(self, app, call):
        self.app = app
        self.call = call

    def alive(self):
        from pyVoIP.VoIP import CallState
        if self.call.state != CallState.ANSWERED:
            raise Hangup()

    # --- Ausgabe ---
    def play(self, audio):
        self.alive()
        self.call.write_audio(audio)
        end = time.time() + len(audio) / RATE
        while time.time() < end:  # während der Ansage eingehendes Audio verwerfen
            self.alive()
            self.call.read_audio(FRAME, blocking=False)
            time.sleep(0.02)

    def say(self, text):
        log.info("Ansage: %s", text)
        self.play(self.app.tts.synth(text))

    # --- Eingabe: Tasten ---
    def flush_dtmf(self):
        while self.call.get_dtmf(length=1):
            pass

    def read_digits(self, timeout=15, end="#", max_len=12):
        digits, deadline = "", time.time() + timeout
        while time.time() < deadline:
            self.alive()
            d = self.call.get_dtmf(length=1)
            if d:
                if d == end:
                    break
                digits += d
                if len(digits) >= max_len:
                    break
                deadline = time.time() + 5
            else:
                self.call.read_audio(FRAME, blocking=False)
                time.sleep(0.04)
        return digits

    def confirm(self, question):
        self.flush_dtmf()
        self.say(question + " Drücke die 1 zum Bestätigen.")
        ok = self.read_digits(timeout=10, max_len=1) == "1"
        log.info("Rückfrage '%s' -> %s", question, "bestätigt" if ok else "abgelehnt")
        return ok

    # --- Eingabe: Sprache ---
    def record(self, max_seconds=15, wait_seconds=7, end_silence=1.2):
        pre = collections.deque(maxlen=12)
        frames, speech, silent, noise = [], False, 0, []
        start = time.time()
        while True:
            self.alive()
            x = u8_to_float(self.call.read_audio(FRAME, blocking=True))
            rms = float(np.sqrt(np.mean(x * x))) if len(x) else 0.0
            if not speech and len(noise) < 15:
                noise.append(rms)
            threshold = max(0.02, float(np.median(noise)) * 3 if noise else 0.02)
            if rms > threshold:
                if not speech:
                    speech = True
                    frames.extend(pre)
                silent = 0
            elif speech:
                silent += 1
            if speech:
                frames.append(x)
                if silent * FRAME / RATE >= end_silence or len(frames) * FRAME / RATE >= max_seconds:
                    break
            else:
                pre.append(x)
                if time.time() - start > wait_seconds:
                    return None
        return np.concatenate(frames) if frames else None

    # --- Ablauf ---
    def run(self):
        app = self.app
        self.say("BOLZO RMM. Bitte gib deine PIN ein und bestätige mit Raute.")
        for attempt in range(3):
            pin = self.read_digits()
            if pin and hmac.compare_digest(pin, app.cfg["pin"]):
                break
            app.lockout.fail()
            log.warning("Falsche PIN (Versuch %d)", attempt + 1)
            if attempt == 2 or app.lockout.locked():
                self.say("Die PIN ist falsch. Auf Wiederhören.")
                return
            self.say("Falsche PIN. Bitte noch einmal.")
        else:
            return

        messages, misses = [], 0
        self.say("Hallo! Was soll ich tun?")
        while True:
            audio = self.record()
            if audio is None:
                misses += 1
                if misses >= 2:
                    self.say("Ich höre nichts mehr. Auf Wiederhören.")
                    return
                self.say("Ich habe nichts gehört. Was soll ich tun?")
                continue
            hint = "BOLZO RMM. Rechner: " + ", ".join(app.client_names())
            text = app.stt.transcribe(audio, hint)
            log.info("Erkannt: %s", text)
            if not text:
                self.say("Das habe ich nicht verstanden. Bitte noch einmal.")
                continue
            short = text.lower().strip(" .,!?")
            if len(short) < 30 and GOODBYE.match(short):
                self.say("Alles klar. Auf Wiederhören.")
                return
            misses = 0
            reply = app.assistant.ask(messages, text, self.confirm)
            self.say(reply)
            self.say("Noch etwas?")


class App:
    def __init__(self, cfg, with_phone=True):
        self.cfg = cfg
        self.rmm = Rmm(cfg["rmm_url"], cfg["rmm_token"])
        self.assistant = Assistant(self.rmm, cfg["model"], cfg["effort"])
        self.lockout = Lockout()
        self._names, self._names_at = [], 0
        if with_phone:
            self.tts = Tts(cfg["piper_bin"], cfg["piper_voice"])
            self.stt = Stt(cfg["whisper_model"], cfg["whisper_dir"])

    def client_names(self):
        if time.time() - self._names_at > 300:
            try:
                self._names = [a["name"] for a in self.rmm.clients()]
                self._names_at = time.time()
            except Exception:
                pass
        return self._names

    def on_call(self, call):
        number = caller_number(call)
        log.info("Anruf von %s", number or "unbekannt")
        allowed = self.cfg["allowed"]
        if self.lockout.locked() or (allowed and normalize_number(number) not in {normalize_number(n) for n in allowed}):
            log.warning("Anruf abgewiesen (%s)", "gesperrt" if self.lockout.locked() else "Nummer nicht erlaubt")
            try:
                call.deny()
            except Exception:
                pass
            return
        try:
            call.answer()
            CallSession(self, call).run()
        except Hangup:
            log.info("Anrufer hat aufgelegt")
        except Exception:
            log.exception("Fehler im Anruf")
        finally:
            try:
                call.hangup()
            except Exception:
                pass


def local_ip_towards(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, port))
        return s.getsockname()[0]
    finally:
        s.close()


# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
def run_phone(cfg):
    from pyVoIP.VoIP import VoIPPhone

    app = App(cfg)
    try:
        log.info("BOLZO RMM erreichbar: %d Rechner", len(app.rmm.clients()))
    except Exception as e:
        log.error("BOLZO RMM nicht erreichbar (%s) – prüfe RMM_URL und RMM_TOKEN", e)
    for phrase in ["BOLZO RMM. Bitte gib deine PIN ein und bestätige mit Raute.", "Hallo! Was soll ich tun?", "Noch etwas?"]:
        app.tts.synth(phrase)  # häufige Ansagen vorab erzeugen

    my_ip = cfg["local_ip"] or local_ip_towards(cfg["fritzbox"], cfg["sip_port"])
    phone = VoIPPhone(cfg["fritzbox"], cfg["sip_port"], cfg["sip_user"], cfg["sip_pass"],
                      myIP=my_ip, callCallback=app.on_call, sipPort=cfg["local_sip_port"])
    phone.start()
    log.info("Als IP-Telefon '%s' bei %s angemeldet (eigene IP %s) – warte auf Anrufe", cfg["sip_user"], cfg["fritzbox"], my_ip)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    log.info("Beende ...")
    phone.stop()


def run_text_test(cfg, text):
    """Testet Claude + RMM ohne Telefon; Rückfragen beantwortest du in der Konsole."""
    app = App(cfg, with_phone=False)
    confirm = lambda q: input(f"{q} [j/N] ").strip().lower() in ("j", "ja", "1", "y")
    print(app.assistant.ask([], text, confirm))


def run_tts_test(cfg, text, out):
    tts = Tts(cfg["piper_bin"], cfg["piper_voice"])
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(RATE)
        w.writeframes(tts.synth(text))
    print(f"Telefon-Audio geschrieben: {out}")


def main():
    ap = argparse.ArgumentParser(description="BOLZO RMM – Sprachsteuerung per Telefon")
    ap.add_argument("--test-text", help="Satz ohne Telefon durch Claude + RMM schicken")
    ap.add_argument("--test-tts", help="Satz als Telefon-Audio in eine WAV-Datei sprechen")
    ap.add_argument("--out", default="test.wav")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()
    if args.test_tts:
        return run_tts_test(cfg, args.test_tts, args.out)
    missing = missing_config(cfg, need_phone=not args.test_text)
    if missing:
        log.error("Konfiguration unvollständig: %s – bitte /etc/bolzo-voice/voice.env ausfüllen und "
                  "'systemctl restart bolzo-voice' ausführen.", ", ".join(missing))
        return 0  # sauber beenden, damit systemd nicht in einer Neustart-Schleife hängt
    if args.test_text:
        return run_text_test(cfg, args.test_text)
    run_phone(cfg)


if __name__ == "__main__":
    sys.exit(main() or 0)
