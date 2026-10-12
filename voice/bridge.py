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
import hashlib
import hmac
import json
import logging
import math
import os
import queue
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
# Schreibweise so, wie die Stimme es richtig ausspricht (am Telefon mit Spracherkennung geprüft)
GREETING = "Hallo, hier ist Bollzo Nettwörks. Bitte gib deine Pin ein und drücke danach die Raute-Taste."
NO_DIGITS = "Ich habe keine Ziffern erhalten. Bitte gib deine Pin ein und drücke danach die Raute-Taste."
# werden beim Start einmal erzeugt und auf Platte gespeichert
COMMON_PHRASES = [
    GREETING,
    NO_DIGITS,
    "Falsche Pin. Bitte noch einmal.",
    "Hallo! Was soll ich tun?",
    "Einen Moment.",
    "Sonst noch etwas?",
    "Ich habe nichts gehört. Was soll ich tun?",
    "Das habe ich nicht verstanden. Bitte noch einmal.",
    "Alles klar. Auf Wiederhören.",
]
# Antworten auf Rückfragen ("Soll ich X wirklich neu starten?") – ein Nein schlägt immer ein Ja
YES = re.compile(r"\b(ja+|jawohl|jap|jo|yes|genau|richtig|korrekt|bestätigt?|ok(ay)?|klar|gerne?|mach(e|s)?|tu es|bitte ja)\b")
NO = re.compile(r"\b(nein|nee|ne|nö|no|nicht|kein|keine|stopp?|abbrechen|abbruch|halt|warte|später)\b")


def classify_answer(text):
    """True = ja, False = nein, None = unklar."""
    t = (text or "").lower()
    if NO.search(t):
        return False
    if YES.search(t):
        return True
    return None


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
        "tts_cache": e("TTS_CACHE", "/opt/bolzo-voice/cache"),
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
# Sprachausgabe
# ---------------------------------------------------------------------------
def to_phone(x, src_rate):
    """Float-Audio (-1..1) -> Telefon-Audio (8 kHz, 8 bit unsigned) mit sauberem Tiefpass und Pegel."""
    x = np.asarray(x, dtype=np.float32)
    try:
        from scipy.signal import resample_poly
        g = math.gcd(int(src_rate), RATE)
        out = resample_poly(x, RATE // g, int(src_rate) // g).astype(np.float32)
    except ImportError:
        k = max(1, round(src_rate / RATE))
        if k > 1:
            x = np.convolve(x, np.ones(k) / k, mode="same")
        out = resample(x, src_rate, RATE)
    peak = float(np.max(np.abs(out))) if len(out) else 0
    if peak > 1e-3:
        out = out * (0.8 / peak)
    return float_to_u8(out) + bytes([128]) * (RATE // 5)  # 200 ms Pause danach


def split_sentences(text, min_len=25):
    """Antwort in Sätze teilen, damit der erste schon gesprochen wird, während die nächsten entstehen."""
    parts, buf = [], ""
    for p in re.split(r"(?<=[.!?:;])\s+", text.strip()):
        buf = f"{buf} {p}".strip()
        if len(buf) >= min_len:
            parts.append(buf)
            buf = ""
    if buf:
        if parts and len(buf) < min_len:
            parts[-1] += " " + buf
        else:
            parts.append(buf)
    return parts or [text]


class Tts:
    """Basis: Speicher im RAM und auf Platte (Ansagen wiederholen sich) + Umrechnung auf Telefon-Audio."""
    name = "tts"

    def __init__(self, cache_dir=None):
        self.cache = {}
        self.lock = threading.Lock()
        self.cache_dir = cache_dir
        if cache_dir:
            try:
                os.makedirs(cache_dir, exist_ok=True)
            except OSError:
                self.cache_dir = None

    def _render(self, text):
        raise NotImplementedError

    def synth(self, text):
        """Text -> Telefon-Audio (8 kHz, 8 bit)."""
        if text in self.cache:
            return self.cache[text]
        path = None
        if self.cache_dir:
            key = hashlib.sha256(f"{self.name}\n{text}".encode("utf8")).hexdigest()[:32]
            path = os.path.join(self.cache_dir, key + ".u8")
            try:
                with open(path, "rb") as f:
                    audio = f.read()
                self.cache[text] = audio
                return audio
            except OSError:
                pass
        with self.lock:
            t0 = time.time()
            x, rate = self._render(text)
        audio = to_phone(x, rate)
        log.info("Sprachausgabe: %.1fs Audio in %.1fs erzeugt", len(audio) / RATE, time.time() - t0)
        if len(self.cache) < 200:
            self.cache[text] = audio
        if path:
            self._store(path, audio)
        return audio

    def _store(self, path, audio):
        try:
            with open(path, "wb") as f:
                f.write(audio)
            files = sorted((os.path.join(self.cache_dir, n) for n in os.listdir(self.cache_dir)), key=os.path.getmtime)
            for old in files[:-500]:  # höchstens 500 Ansagen behalten
                os.remove(old)
        except OSError:
            pass


class PiperTts(Tts):
    def __init__(self, piper_bin, voice, cache_dir=None):
        super().__init__(cache_dir)
        self.bin = piper_bin
        self.voice = voice
        self.name = "piper:" + os.path.basename(voice)
        with open(voice + ".json", encoding="utf8") as f:
            self.rate = json.load(f)["audio"]["sample_rate"]

    def _render(self, text):
        p = subprocess.run([self.bin, "--model", self.voice, "--output_raw"], input=text.encode("utf8"),
                           capture_output=True, timeout=60, check=True)
        return np.frombuffer(p.stdout, dtype="<i2").astype(np.float32) / 32768.0, self.rate


def make_tts(cfg):
    return PiperTts(cfg["piper_bin"], cfg["piper_voice"], cfg["tts_cache"])


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

    def scopes(self):
        """Rechte dieses API-Zugangs (ältere Server kennen die Abfrage nicht: dann Status + Neustart)."""
        try:
            return self._check(self.http.get("/api/token-info"))["scopes"]
        except Exception as e:
            log.warning("Rechte des API-Zugangs unbekannt (%s) – nehme Status und Neustart an", e)
            return ["status", "power"]

    def clients(self):
        return self._check(self.http.get("/api/agents"))

    def action(self, client_id, action, params=None):
        return self._check(self.http.post(f"/api/agents/{client_id}/action", json={"action": action, "params": params or {}}, timeout=60))

    def power(self, client_id, action):
        if action == "wake":
            return self._check(self.http.post(f"/api/agents/{client_id}/wake"))
        return self.action(client_id, action)

    def guests(self, host_id):
        return self._check(self.http.get(f"/api/agents/{host_id}/pve/guests", timeout=60))["guests"]

    def guest_power(self, host_id, g, op):
        return self._check(self.http.post(f"/api/agents/{host_id}/pve/power", json={"vmid": g["vmid"], "type": g["type"], "name": g.get("name"), "op": op}))

    def guest_destroy(self, host_id, g):
        return self._check(self.http.post(f"/api/agents/{host_id}/pve/destroy", json={"vmid": g["vmid"], "type": g["type"], "name": g.get("name")}, timeout=60))

    def scripts(self):
        return self._check(self.http.get("/api/scripts"))

    def run_script(self, script_id, client_ids):
        return self._check(self.http.post(f"/api/scripts/{script_id}/run", json={"agentIds": client_ids}, timeout=900))


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
    if (a.get("info") or {}).get("proxmox"):
        s["proxmox_host"] = True
    if a.get("pve"):
        s["is_guest_of"] = f"{'Container' if a['pve'].get('type') == 'lxc' else 'VM'} {a['pve'].get('vmid')} auf {a['pve'].get('hostName')}"
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
# Was der Assistent je nach Recht des API-Zugangs kann (für den System-Prompt)
ABILITIES = {
    "status": "den Zustand der Rechner abfragen (online, CPU, RAM, Datenträger, Warnungen)",
    "power": "Rechner neu starten, herunterfahren oder per Wake-on-LAN aufwecken",
    "processes": "laufende Programme (Prozesse) eines Rechners anzeigen und beenden",
    "services": "Dienste eines Rechners suchen, starten, stoppen und neu starten",
    "proxmox": "VMs und Container auf den Proxmox-Servern anzeigen, starten, herunterfahren, neu starten und hart ausschalten",
    "pvedelete": "ausgeschaltete VMs und Container endgültig löschen",
    "scripts": "gespeicherte Skripte aus der Bibliothek auf Rechnern ausführen",
}

SYSTEM = """Du bist der Telefon-Assistent von BOLZO RMM, einer Fernwartung für Server und PCs.
Der Anrufer hat sich bereits per PIN ausgewiesen. Seine Sätze kommen aus einer Spracherkennung und
können Hörfehler enthalten – Namen werden oft verstümmelt (z.B. "SRV MC", "Server MC", "S R V M C"
für SRV-MC, "Krom" für chrome). Löse Rechnernamen über list_clients auf; Spitznamen über Tags oder
Hostnamen sind erlaubt. Proxmox-VMs heißen oft wie der Rechner darin.

Du kannst: {abilities}.
Alles andere (Terminal, frei diktierte Befehle, Einstellungen) gibt es am Telefon nicht – sag das freundlich.
Ist unklar, welcher Rechner, Prozess, Dienst oder welche VM gemeint ist, frag kurz nach statt zu raten.
Jede verändernde Aktion wird vor der Ausführung automatisch beim Anrufer rückgefragt – frag also nicht
zusätzlich selbst "Soll ich ...?", sondern ruf das Werkzeug direkt auf. Für mehrere Ziele rufst du das
Werkzeug je Ziel einmal auf.

Deine Antworten werden vorgelesen: höchstens zwei bis drei kurze Sätze, keine Listen, kein Markdown,
keine Emojis, keine IDs oder PIDs. Zahlen rund und gesprochen ("85 Prozent"). Bei vielen Treffern nur die
wichtigsten nennen. Sprich Deutsch.

Nachfragen nur, wenn es passt: Musst du etwas wissen, endet die Antwort mit genau dieser einen Frage.
Hast du gerade eine Aktion ausgeführt, darfst du knapp anbieten weiterzumachen ("Sonst noch was?").
Nach reinen Auskünften stellst du keine Frage – der Anrufer spricht von selbst weiter, wenn er mehr will.
Niemals "Noch etwas?" oder ähnliche Floskeln nach jeder Antwort."""


def _tool(name, desc, props=None, required=None):
    return {"name": name, "description": desc, "strict": True,
            "input_schema": {"type": "object", "properties": props or {}, "required": required or [], "additionalProperties": False}}


CLIENT_ID = {"type": "string", "description": "id des Rechners aus list_clients"}
HOST_ID = {"type": "string", "description": "host_id des Proxmox-Servers aus list_guests"}
TOOLS = {
    "status": [_tool("list_clients", "Liefert alle verwalteten Rechner mit id, Name, Hostname, Tags, online/offline, CPU-, RAM- und "
                     "Datenträger-Auslastung in Prozent, Laufzeit und Warnungen. Vor jeder Aktion an einem Rechner aufrufen, "
                     "um ihn und seine id zu finden.")],
    "power": [_tool("power_action", "Startet einen Rechner neu (reboot), fährt ihn herunter (shutdown) oder weckt einen "
                    "ausgeschalteten Rechner per Wake-on-LAN (wake).",
                    {"client_id": CLIENT_ID, "action": {"type": "string", "enum": ["reboot", "shutdown", "wake"]}}, ["client_id", "action"])],
    "processes": [
        _tool("list_processes", "Die Programme eines Rechners, die gerade am meisten CPU oder Arbeitsspeicher brauchen "
              "(gleichnamige Prozesse zusammengefasst, mit Anzahl).", {"client_id": CLIENT_ID}, ["client_id"]),
        _tool("kill_process", "Beendet auf einem Rechner alle Prozesse mit diesem Programmnamen (z.B. chrome, notepad.exe; "
              "Groß-/Kleinschreibung und .exe egal). Vorher list_processes aufrufen, um den genauen Namen zu kennen.",
              {"client_id": CLIENT_ID, "name": {"type": "string"}}, ["client_id", "name"]),
    ],
    "services": [
        _tool("find_services", "Sucht Dienste eines Rechners, deren Name oder Beschreibung den Suchbegriff enthält "
              "(z.B. apache, spooler, docker). Liefert Name, Beschreibung und ob er läuft.",
              {"client_id": CLIENT_ID, "query": {"type": "string"}}, ["client_id", "query"]),
        _tool("service_action", "Startet, stoppt oder startet einen Dienst neu. name exakt wie von find_services geliefert.",
              {"client_id": CLIENT_ID, "name": {"type": "string"}, "op": {"type": "string", "enum": ["start", "stop", "restart"]}},
              ["client_id", "name", "op"]),
    ],
    "proxmox": [
        _tool("list_guests", "Alle VMs und Container aller Proxmox-Server mit host_id, Server, vmid, Typ, Name, Status "
              "(running/stopped), CPU- und RAM-Auslastung."),
        _tool("guest_power", "Startet (start), fährt herunter (shutdown), startet neu (reboot) oder schaltet eine VM / einen "
              "Container hart aus (stop – nur wenn er nicht mehr reagiert).",
              {"host_id": HOST_ID, "vmid": {"type": "integer"}, "op": {"type": "string", "enum": ["start", "shutdown", "reboot", "stop"]}},
              ["host_id", "vmid", "op"]),
    ],
    "pvedelete": [
        _tool("delete_guest", "Löscht eine ausgeschaltete VM / einen Container endgültig samt Disks. Der Anrufer muss zur "
              "Bestätigung die VM-Nummer auf der Telefontastatur eintippen.",
              {"host_id": HOST_ID, "vmid": {"type": "integer"}}, ["host_id", "vmid"]),
    ],
    "scripts": [
        _tool("list_scripts", "Die gespeicherten Skripte der Bibliothek mit id, Name und Beschreibung."),
        _tool("run_script", "Führt ein gespeichertes Skript auf einem oder mehreren Rechnern aus und liefert Exit-Code und das "
              "Ende der Ausgabe je Rechner.",
              {"script_id": {"type": "string", "description": "id aus list_scripts"},
               "client_ids": {"type": "array", "items": {"type": "string"}, "description": "ids aus list_clients"}},
              ["script_id", "client_ids"]),
    ],
}
GUEST_OPS = {"start": ("starten", "wird gestartet"), "shutdown": ("herunterfahren", "wird heruntergefahren"),
             "reboot": ("neu starten", "wird neu gestartet"), "stop": ("hart ausschalten", "wurde ausgeschaltet")}
SERVICE_OPS = {"start": ("starten", "wurde gestartet"), "stop": ("stoppen", "wurde gestoppt"), "restart": ("neu starten", "wurde neu gestartet")}


def proc_key(name):
    n = (name or "").lower()
    return n[:-4] if n.endswith(".exe") else n


class Assistant:
    def __init__(self, rmm, model, effort, scopes=None):
        self.rmm = rmm
        self.model = model
        self.effort = effort
        self.client = anthropic.Anthropic()
        self.scopes = [s for s in (scopes or ["status", "power"]) if s in TOOLS]
        if "status" not in self.scopes:
            self.scopes.insert(0, "status")  # Rechner finden geht immer (Server prüft trotzdem)
        self.tools = [t for s in self.scopes for t in TOOLS[s]]
        if "pvedelete" in self.scopes and "proxmox" not in self.scopes:
            self.tools.append(TOOLS["proxmox"][0])  # zum Löschen muss er die Gäste finden können (nur Liste)
        self.system = SYSTEM.replace("{abilities}", "; ".join(ABILITIES[s] for s in self.scopes))
        log.info("Rechte am Telefon: %s", ", ".join(self.scopes))

    # --- Hilfen ---
    def _client(self, client_id, need_online=True):
        a = next((x for x in self.rmm.clients() if x["id"] == client_id), None)
        if not a:
            raise ToolError("Diesen Rechner gibt es nicht. Erst list_clients aufrufen.")
        if need_online and not a.get("online"):
            raise ToolError(f"{a['name']} ist offline.")
        return a

    def _guests(self):
        out = []
        for h in self.rmm.clients():
            if not (h.get("info") or {}).get("proxmox") or not h.get("online"):
                continue
            try:
                for g in self.rmm.guests(h["id"]):
                    if not g.get("template"):
                        out.append({**g, "host_id": h["id"], "host": h["name"]})
            except Exception as e:
                log.warning("Gäste von %s nicht lesbar: %s", h["name"], e)
        return out

    def _guest(self, host_id, vmid):
        g = next((x for x in self._guests() if x["host_id"] == host_id and x["vmid"] == vmid), None)
        if not g:
            raise ToolError("Diese VM gibt es nicht. Erst list_guests aufrufen.")
        return g

    def _tool(self, name, args, ui):
        """Führt ein Werkzeug aus. Gibt (Text, ist_fehler) zurück."""
        try:
            return self._run_tool(name, args, ui), False
        except ToolError as e:
            return str(e), True

    def _run_tool(self, name, args, ui):
        allowed = {t["name"] for t in self.tools}
        if name not in allowed:
            raise ToolError(f"Werkzeug {name} ist nicht erlaubt.")
        no = "Der Anrufer hat nicht bestätigt – nichts ausgeführt."

        if name == "list_clients":
            return json.dumps([client_summary(a) for a in self.rmm.clients()], ensure_ascii=False)

        if name == "power_action":
            action = args.get("action")
            a = self._client(args.get("client_id"), need_online=action != "wake")
            if action not in VERBS:
                raise ToolError("Unbekannte Aktion.")
            if action == "wake" and a.get("online"):
                raise ToolError(f"{a['name']} ist bereits online.")
            if not ui.confirm(f"Soll ich {a['name']} wirklich {VERBS[action]}?"):
                return no
            self._do(lambda: self.rmm.power(a["id"], action))
            log.info("Ausgeführt: %s -> %s", action, a["name"])
            return f"Ausgeführt: {a['name']} {DONE[action]}."

        if name == "list_processes":
            a = self._client(args.get("client_id"))
            groups = {}
            for p in self._do(lambda: self.rmm.action(a["id"], "processes")):
                k = proc_key(p.get("name"))
                g = groups.setdefault(k, {"name": p.get("name"), "count": 0, "cpu_percent": 0.0, "ram_mb": 0})
                g["count"] += 1
                g["cpu_percent"] += p.get("cpu") or 0
                g["ram_mb"] += round((p.get("mem") or 0) / 1048576)
            top = sorted(groups.values(), key=lambda g: (g["cpu_percent"], g["ram_mb"]), reverse=True)[:20]
            for g in top:
                g["cpu_percent"] = round(g["cpu_percent"], 1)
            return json.dumps({"rechner": a["name"], "programme": top}, ensure_ascii=False)

        if name == "kill_process":
            a = self._client(args.get("client_id"))
            want = proc_key(args.get("name"))
            procs = [p for p in self._do(lambda: self.rmm.action(a["id"], "processes")) if proc_key(p.get("name")) == want]
            if not procs:
                raise ToolError(f"Auf {a['name']} läuft kein Programm namens {args.get('name')}. Erst list_processes aufrufen.")
            label = procs[0].get("name")
            many = f" ({len(procs)} Prozesse)" if len(procs) > 1 else ""
            if not ui.confirm(f"Soll ich {label} auf {a['name']} beenden{many}?"):
                return no
            done, failed = 0, []
            for p in procs:
                try:
                    self.rmm.action(a["id"], "kill", {"pid": p["pid"], "name": p.get("name")})
                    done += 1
                except Exception as e:
                    failed.append(str(e))
            log.info("Ausgeführt: %s beendet auf %s (%d/%d)", label, a["name"], done, len(procs))
            return f"{label} auf {a['name']}: {done} von {len(procs)} Prozessen beendet." + (f" Fehler: {failed[0]}" if failed else "")

        if name == "find_services":
            a = self._client(args.get("client_id"))
            q = (args.get("query") or "").lower()
            hits = [s for s in self._do(lambda: self.rmm.action(a["id"], "services"))
                    if q in (s.get("name") or "").lower() or q in (s.get("description") or "").lower()]
            return json.dumps({"rechner": a["name"], "treffer": len(hits), "dienste": [
                {"name": s["name"], "beschreibung": s.get("description"), "läuft": s.get("active")} for s in hits[:15]]}, ensure_ascii=False)

        if name == "service_action":
            a = self._client(args.get("client_id"))
            op, svc = args.get("op"), args.get("name")
            if op not in SERVICE_OPS:
                raise ToolError("Unbekannte Aktion.")
            if not ui.confirm(f"Soll ich den Dienst {svc} auf {a['name']} {SERVICE_OPS[op][0]}?"):
                return no
            self._do(lambda: self.rmm.action(a["id"], "service", {"name": svc, "op": op}))
            log.info("Ausgeführt: Dienst %s %s auf %s", svc, op, a["name"])
            return f"Dienst {svc} auf {a['name']} {SERVICE_OPS[op][1]}."

        if name == "list_guests":
            return json.dumps([{"host_id": g["host_id"], "server": g["host"], "vmid": g["vmid"],
                                "typ": "Container" if g["type"] == "lxc" else "VM", "name": g.get("name"), "status": g.get("status"),
                                **({"cpu_percent": round((g.get("cpu") or 0) * 100), "ram_percent": round(100 * g["mem"] / g["maxmem"])}
                                   if g.get("status") == "running" and g.get("maxmem") else {})} for g in self._guests()], ensure_ascii=False)

        if name == "guest_power":
            op = args.get("op")
            if op not in GUEST_OPS:
                raise ToolError("Unbekannte Aktion.")
            g = self._guest(args.get("host_id"), args.get("vmid"))
            running = g.get("status") == "running"
            if op == "start" and running:
                raise ToolError(f"{g['name']} läuft bereits.")
            if op != "start" and not running:
                raise ToolError(f"{g['name']} ist bereits aus.")
            if not ui.confirm(f"Soll ich {g['name']} auf {g['host']} {GUEST_OPS[op][0]}?"):
                return no
            self._do(lambda: self.rmm.guest_power(g["host_id"], g, op))
            log.info("Ausgeführt: %s %s auf %s", g["name"], op, g["host"])
            return f"{g['name']} {GUEST_OPS[op][1]}."

        if name == "delete_guest":
            g = self._guest(args.get("host_id"), args.get("vmid"))
            if g.get("status") == "running":
                raise ToolError(f"{g['name']} läuft noch – zum Löschen muss die VM erst heruntergefahren werden.")
            what = "den Container" if g["type"] == "lxc" else "die VM"
            if not ui.confirm_code(f"Achtung, endgültig: Soll ich {what} {g['name']} auf {g['host']} mit allen Daten löschen?", g["vmid"]):
                return "Die Nummer wurde nicht richtig eingetippt – nichts gelöscht."
            self._do(lambda: self.rmm.guest_destroy(g["host_id"], g))
            log.warning("Ausgeführt: %s %s auf %s GELÖSCHT", what, g["name"], g["host"])
            return f"{g['name']} wird gelöscht."

        if name == "list_scripts":
            return json.dumps([{"id": s["id"], "name": s["name"], "beschreibung": s.get("description", "")} for s in self.rmm.scripts()], ensure_ascii=False)

        if name == "run_script":
            s = next((x for x in self.rmm.scripts() if x["id"] == args.get("script_id")), None)
            if not s:
                raise ToolError("Dieses Skript gibt es nicht. Erst list_scripts aufrufen.")
            targets = [self._client(cid) for cid in dict.fromkeys(args.get("client_ids") or [])]
            if not targets:
                raise ToolError("Kein Rechner angegeben.")
            names = ", ".join(t["name"] for t in targets)
            if not ui.confirm(f"Soll ich das Skript {s['name']} auf {names} ausführen?"):
                return no
            ui.hint("Einen Moment.")
            res = self._do(lambda: self.rmm.run_script(s["id"], [t["id"] for t in targets]))
            log.info("Ausgeführt: Skript %s auf %s", s["name"], names)
            return json.dumps([{"rechner": r.get("hostname"), "fehler": r.get("error"), "exit_code": r.get("exitCode"),
                                "zeitüberschreitung": r.get("timedOut"), "ausgabe_ende": (r.get("output") or "")[-600:]} for r in res], ensure_ascii=False)

        raise ToolError(f"Unbekanntes Werkzeug {name}.")

    @staticmethod
    def _do(fn):
        try:
            return fn()
        except Exception as e:  # Fehler vom RMM-Server an Claude zurückgeben
            raise ToolError(f"Fehlgeschlagen: {e}") from e

    def ask(self, messages, text, ui):
        """Verarbeitet einen Satz des Anrufers. messages wird fortgeschrieben (nur anhängen).
        ui: confirm(frage) -> bool, confirm_code(frage, nummer) -> bool, hint(text)."""
        messages.append({"role": "user", "content": text})
        for _ in range(10):
            try:
                resp = self.client.beta.messages.create(
                    model=self.model,
                    max_tokens=16000,
                    system=self.system,
                    tools=self.tools,
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
                        out, err = self._tool(block.name, block.input, ui)
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


class ToolError(Exception):
    """Fehler, der als Werkzeug-Ergebnis an Claude zurückgeht."""


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
        self.out_end = 0.0  # bis wann bereits geschriebenes Audio noch abgespielt wird

    def alive(self):
        from pyVoIP.VoIP import CallState
        if self.call.state != CallState.ANSWERED:
            raise Hangup()

    # --- Ausgabe ---
    def drain(self):
        """Bisher eingegangenes Audio verwerfen (während Ansagen, Spracherkennung und Claude)."""
        self.call.read_audio(RATE * 120, blocking=False)

    def say(self, text):
        """Satz für Satz erzeugen und abspielen – der erste Satz läuft schon, während die nächsten entstehen."""
        log.info("Ansage: %s", text)
        q = queue.Queue()

        def produce():
            try:
                for part in split_sentences(text):
                    q.put(self.app.tts.synth(part))
            except Exception:
                log.exception("Sprachausgabe fehlgeschlagen")
            q.put(None)

        threading.Thread(target=produce, name="Sprachausgabe", daemon=True).start()
        while True:
            self.alive()
            try:
                audio = q.get(timeout=0.05)
            except queue.Empty:
                self.drain()
                continue
            if audio is None:
                break
            self.queue_audio(audio)
        while time.time() < self.out_end:
            self.alive()
            self.drain()
            time.sleep(0.02)
        self.drain()

    def hint(self, text):
        """Kurze, vorab erzeugte Ansage abspielen, ohne zu warten (z.B. während Claude nachdenkt)."""
        audio = self.app.tts.cache.get(text)
        if audio:
            self.queue_audio(audio)

    def queue_audio(self, audio):
        self.call.write_audio(audio)  # pyVoIP hängt an bereits wartendes Audio an
        self.out_end = max(self.out_end, time.time()) + len(audio) / RATE

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
        """Rückfrage per Sprache ("ja"/"nein"); Taste 1 geht weiterhin. Unklar oder still = nicht ausführen."""
        self.flush_dtmf()
        prompts = [question + " Sag ja oder nein.", "Bitte sag ja oder nein. Oder drücke die 1."]
        for prompt in prompts:
            self.say(prompt)
            got = self.record(max_seconds=4, wait_seconds=8, end_silence=0.8, dtmf=True)
            if isinstance(got, str):
                ok, heard = got == "1", f"Taste {got}"
            elif got is None:
                ok, heard = None, "(nichts gehört)"
            else:
                heard = self.app.stt.transcribe(got, "Ja. Nein. Ja, bitte. Nein, nicht.")
                ok = classify_answer(heard)
            log.info("Rückfrage '%s' -> %s: %s", question, heard,
                     {True: "bestätigt", False: "abgelehnt", None: "unklar"}[ok])
            if ok is not None:
                return ok
        return False

    def confirm_code(self, question, code):
        """Besonders gefährliche Aktionen: Bestätigung durch Eintippen einer Nummer (z.B. der VM-ID)."""
        self.flush_dtmf()
        digits = " ".join(str(code))
        self.say(f"{question} Zum Bestätigen tippe die Nummer {digits} und dann die Raute-Taste. Zum Abbrechen einfach Raute.")
        got = self.read_digits(timeout=25)
        ok = got == str(code)
        log.info("Rückfrage mit Nummer '%s' -> %s", question, "bestätigt" if ok else "abgelehnt")
        return ok

    # --- Eingabe: Sprache ---
    def record(self, max_seconds=15, wait_seconds=7, end_silence=1.2, dtmf=False):
        """Sprache aufnehmen bis zur Pause. Mit dtmf=True beendet ein Tastendruck die Aufnahme (gibt die Taste zurück)."""
        self.drain()
        pre = collections.deque(maxlen=12)
        frames, speech, silent, noise = [], False, 0, []
        start = time.time()
        while True:
            self.alive()
            if dtmf:
                key = self.call.get_dtmf(length=1)
                if key:
                    return key
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
        self.say(GREETING)
        wrong = empty = 0
        while True:
            pin = self.read_digits()
            if not pin:
                # nur Raute oder gar nichts gedrückt – zählt nicht als Fehlversuch
                empty += 1
                log.info("Keine PIN-Ziffern erhalten (%d)", empty)
                if empty >= 3:
                    self.say("Keine Eingabe erhalten. Auf Wiederhören.")
                    return
                self.say(NO_DIGITS)
                continue
            if hmac.compare_digest(pin, app.cfg["pin"]):
                break
            wrong += 1
            app.lockout.fail()
            log.warning("Falsche PIN (Versuch %d, %d Ziffern)", wrong, len(pin))
            if wrong >= 3 or app.lockout.locked():
                self.say("Die Pin ist falsch. Auf Wiederhören.")
                return
            self.say("Falsche Pin. Bitte noch einmal.")

        messages, misses, answered = [], 0, False
        self.say("Hallo! Was soll ich tun?")
        while True:
            audio = self.record()
            if audio is None:
                misses += 1
                if misses >= 2:
                    self.say("Ich höre nichts mehr. Auf Wiederhören.")
                    return
                # Nach einer Antwort ist eine Pause der passende Moment für "Sonst noch etwas?"
                self.say("Sonst noch etwas?" if answered else "Ich habe nichts gehört. Was soll ich tun?")
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
            self.hint("Einen Moment.")
            reply = app.assistant.ask(messages, text, self)
            self.say(reply)  # ob Claude am Ende nachfragt, entscheidet es selbst (siehe SYSTEM)
            answered = True


class App:
    def __init__(self, cfg, with_phone=True):
        self.cfg = cfg
        self.rmm = Rmm(cfg["rmm_url"], cfg["rmm_token"])
        self.assistant = Assistant(self.rmm, cfg["model"], cfg["effort"], self.rmm.scopes())
        self.lockout = Lockout()
        self._names, self._names_at = [], 0
        if with_phone:
            self.tts = make_tts(cfg)
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
def fix_pyvoip_pcma():
    """pyVoIP 1.6.8 kodiert bei ausgehandeltem PCMA (A-law, Standard der FRITZ!Box) fälschlich als
    PCMU (μ-law) – das klingt extrem übersteuert. Hier richtig nach Codec kodieren."""
    from pyVoIP import RTP

    def encode_packet(self, payload):
        if self.preference == RTP.PayloadType.PCMA:
            return self.encode_pcma(payload)
        if self.preference == RTP.PayloadType.PCMU:
            return self.encode_pcmu(payload)
        raise RTP.RTPParseError("Unsupported codec (encode): " + str(self.preference))

    RTP.RTPClient.encode_packet = encode_packet


def fix_pyvoip_dtmf():
    """pyVoIP wertet Tastentöne (RFC 4733) nur über das Marker-Bit aus – je nach Gegenstelle kommt eine
    Taste dann gar nicht oder mehrfach an. Alle Pakete einer Taste tragen denselben Zeitstempel:
    darüber genau einmal pro Tastendruck melden."""
    from pyVoIP import RTP
    keys = "0123456789*#ABCD"

    def parse_telephone_event(self, packet):
        p = packet.payload
        if not p or p[0] >= len(keys) or getattr(self, "_dtmf_ts", None) == packet.timestamp:
            return
        self._dtmf_ts = packet.timestamp
        if self.dtmf is not None:
            self.dtmf(keys[p[0]])

    RTP.RTPClient.parse_telephone_event = parse_telephone_event


def run_phone(cfg):
    from pyVoIP.VoIP import VoIPPhone

    fix_pyvoip_pcma()
    fix_pyvoip_dtmf()

    app = App(cfg)
    try:
        log.info("BOLZO RMM erreichbar: %d Rechner", len(app.rmm.clients()))
    except Exception as e:
        log.error("BOLZO RMM nicht erreichbar (%s) – prüfe RMM_URL und RMM_TOKEN", e)
    log.info("Erzeuge häufige Ansagen vorab ...")
    for phrase in COMMON_PHRASES:
        app.tts.synth(phrase)

    my_ip = cfg["local_ip"] or local_ip_towards(cfg["fritzbox"], cfg["sip_port"])
    phone = VoIPPhone(cfg["fritzbox"], cfg["sip_port"], cfg["sip_user"], cfg["sip_pass"],
                      myIP=my_ip, callCallback=app.on_call, sipPort=cfg["local_sip_port"])
    phone.start()
    if phone.get_status().name != "REGISTERED":
        try:
            fb_ip = socket.gethostbyname(cfg["fritzbox"])
        except OSError:
            fb_ip = "nicht auflösbar"
        log.error("Anmeldung an der FRITZ!Box fehlgeschlagen: keine Antwort von %s (%s) Port %s. "
                  "Liegt dieses Gerät im selben Netz wie die FRITZ!Box? Sonst FRITZBOX_HOST auf die IP der FRITZ!Box setzen.",
                  cfg["fritzbox"], fb_ip, cfg["sip_port"])
    log.info("Als IP-Telefon '%s' bei %s angemeldet (eigene IP %s) – warte auf Anrufe", cfg["sip_user"], cfg["fritzbox"], my_ip)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    # pyVoIP gibt nach 3 fehlgeschlagenen Neuanmeldungen (z.B. FRITZ!Box-Neustart) still auf und
    # nimmt dann keine Anrufe mehr an (Anrufer hören "besetzt") – dann beenden, systemd startet neu.
    while not stop.wait(15):
        status = phone.get_status().name
        if status in ("FAILED", "INACTIVE"):
            log.error("Anmeldung an der FRITZ!Box verloren (%s) – starte neu", status)
            os._exit(1)
    log.info("Beende ...")
    phone.stop()


def run_text_test(cfg, text):
    """Testet Claude + RMM ohne Telefon; Rückfragen beantwortest du in der Konsole."""
    app = App(cfg, with_phone=False)
    class Console:
        @staticmethod
        def confirm(q):
            a = input(f"{q} [ja/nein] ").strip().lower()
            return a in ("j", "1") or classify_answer(a) is True

        @staticmethod
        def confirm_code(q, code):
            return input(f"{q} Nummer eintippen ({code}): ").strip() == str(code)

        @staticmethod
        def hint(t):
            print(t)

    print(app.assistant.ask([], text, Console))


def run_tts_test(cfg, text, out):
    tts = make_tts(cfg)
    t0 = time.time()
    audio = b"".join(tts.synth(p) for p in split_sentences(text))
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(RATE)
        w.writeframes(audio)
    print(f"Telefon-Audio geschrieben: {out} ({len(audio) / RATE:.1f}s Audio in {time.time() - t0:.1f}s erzeugt)")


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
