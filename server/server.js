'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const dgram = require('dgram');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');
const { AuditLog } = require('./audit');

// ---------------------------------------------------------------------------
// Konfiguration: Umgebungsvariablen, optional ergänzt durch server/.env
// ---------------------------------------------------------------------------
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8095);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const SESSION_DAYS = 30;
const HISTORY_POINTS = 720; // 1 h bei 5-s-Intervall

const store = new Store(DATA_DIR);
const audit = new AuditLog(DATA_DIR);

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  const pwFile = path.join(DATA_DIR, 'admin-password.txt');
  if (!fs.existsSync(pwFile)) {
    fs.writeFileSync(pwFile, crypto.randomBytes(12).toString('base64url') + '\n', { mode: 0o600 });
  }
  ADMIN_PASSWORD = fs.readFileSync(pwFile, 'utf8').trim();
  console.log(`[bolzo-rmm] Kein ADMIN_PASSWORD gesetzt – verwende ${pwFile}`);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sha256hex = (s) => sha256(s).toString('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
// Anmeldungen gelten nur, solange das Admin-Passwort gleich bleibt: Passwort ändern = überall abgemeldet
const PW_MARK = sha256hex(`bolzo-rmm-session:${ADMIN_PASSWORD}`).slice(0, 16);
for (const s of Object.values(store.data.sessions)) s.pw ??= PW_MARK; // bestehende Sitzungen übernehmen
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Laufzeit-Zustand
// ---------------------------------------------------------------------------
const conns = new Map(); // agentId -> { ws, pending: Map }
const live = new Map(); // agentId -> { metrics, history: [[ts, cpu, mem]] }
const shells = new Map(); // sid -> { adminWs, agentId }
const admins = new Set();

function liveOf(id) {
  if (!live.has(id)) live.set(id, { metrics: null, history: [] });
  return live.get(id);
}

function computeAlerts(agent, online, m) {
  const t = store.data.settings.thresholds;
  const alerts = [];
  if (!online) {
    alerts.push({ kind: 'offline', level: 'critical', label: 'Offline' });
    return alerts;
  }
  if (!m) return alerts;
  if (m.cpu >= t.cpu) alerts.push({ kind: 'cpu', level: 'warning', label: `CPU ${Math.round(m.cpu)} %` });
  const memPct = m.mem && m.mem.total ? (100 * m.mem.used) / m.mem.total : 0;
  if (memPct >= t.mem) alerts.push({ kind: 'mem', level: 'warning', label: `RAM ${Math.round(memPct)} %` });
  for (const d of m.disks || []) {
    const pct = d.size ? (100 * d.used) / d.size : 0;
    if (pct >= t.disk) alerts.push({ kind: 'disk', level: pct >= 97 ? 'critical' : 'warning', label: `${d.mount} ${Math.round(pct)} %` });
  }
  return alerts;
}

function summarize(a, withSpark = false) {
  const online = conns.has(a.id);
  const l = live.get(a.id);
  const metrics = online && l ? l.metrics : null;
  return {
    id: a.id,
    name: a.name || a.info?.hostname || a.hostname,
    hostname: a.info?.hostname || a.hostname,
    platform: a.info?.platform || a.platform,
    os: a.info?.os || '',
    info: a.info || {},
    tags: a.tags || [],
    notes: a.notes || '',
    version: a.version || '',
    outdated: agentOutdated(a),
    serverUrl: a.serverUrl || '',
    publicIp: a.publicIp || '',
    pve: a.pve ? { ...a.pve, hostName: agentLabel(store.data.agents[a.pve.hostId]) || '?', hostOnline: conns.has(a.pve.hostId) } : null,
    probe: !!a.probe,
    folderId: a.folderId || null,
    createdAt: a.createdAt,
    lastSeen: online ? Date.now() : a.lastSeen,
    online,
    metrics,
    alerts: computeAlerts(a, online, metrics),
    ...(withSpark ? { spark: (l?.history || []).slice(-60).map((h) => [h[0], h[1], h[2]]) } : {}),
  };
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of admins) if (ws.readyState === 1) ws.send(s);
}
const broadcastAgent = (id) => {
  const a = store.data.agents[id];
  if (a) broadcast({ type: 'agent', agent: summarize(a) });
};

function sendJson(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function agentRequest(agentId, action, params = {}, timeoutMs = 30000) {
  const c = conns.get(agentId);
  if (!c) return Promise.reject(httpError(409, 'Client ist offline'));
  const reqId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(reqId);
      reject(httpError(504, 'Zeitüberschreitung – der Client hat nicht geantwortet'));
    }, timeoutMs);
    c.pending.set(reqId, { resolve, reject, timer });
    sendJson(c.ws, { type: 'request', reqId, action, params });
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 'loopback, uniquelocal'); // Reverse-Proxy im LAN (nginx, Caddy, NPM)
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Bolzo-Device');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sessionByKey(key) {
  const s = key && store.data.sessions[key];
  return s && s.expires > Date.now() && s.pw === PW_MARK ? s : null;
}
const validSession = (token) => (token ? sessionByKey(sha256hex(token)) : null);

// API-Zugänge (z.B. für die Sprachsteuerung) dürfen nur, was ihre Rechte (scopes) erlauben:
//   status    – Clients und ihren Zustand lesen
//   power     – Neustart, Herunterfahren, Aufwecken
//   processes – Prozesse anzeigen und beenden
//   services  – Dienste anzeigen, starten, stoppen, neu starten
//   proxmox   – VMs/Container eines Proxmox-Hosts anzeigen, starten, herunterfahren, neu starten
//   scripts   – gespeicherte Skripte aus der Bibliothek ausführen (keine frei eingegebenen Befehle)
//   jobs      – vorbereitete Jobs ausführen (Befehl und Rechner stehen fest, z.B. "Minecraft-Server starten")
//   pvedelete – VMs/Container endgültig löschen (nur ausgeschaltet, Proxmox-Schutz wird beachtet)
const TOKEN_SCOPES = ['status', 'power', 'processes', 'services', 'proxmox', 'scripts', 'jobs', 'pvedelete'];
// Welches Recht eine Client-Aktion braucht (nicht aufgeführt = nur mit Admin-Anmeldung)
const ACTION_SCOPES = { reboot: 'power', shutdown: 'power', processes: 'processes', kill: 'processes', services: 'services', service: 'services' };

function apiTokenFor(token) {
  if (!token || !token.startsWith('bzr_')) return null;
  const hash = sha256hex(token);
  return store.data.apiTokens.find((t) => t.hash === hash) || null;
}

function bearer(req) {
  return (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
}

// Name des PCs, auf dem die App läuft – fürs Protokoll ("Admin (JEAN-PC)")
function noteDevice(session, name) {
  const device = String(name || '').trim().slice(0, 60);
  if (session && device && session.device !== device) {
    session.device = device;
    store.save();
  }
  return session;
}

function requireAdmin(req, res, next) {
  const token = bearer(req);
  if ((req.session = noteDevice(validSession(token), req.get('x-bolzo-device')))) return next();
  if (apiTokenFor(token)) return res.status(403).json({ error: 'Dieser API-Zugang hat dafür keine Berechtigung' });
  res.status(401).json({ error: 'Nicht angemeldet' });
}

// scope: Name des Rechts, Liste (eines davon genügt) oder Funktion (req) => Name (z.B. abhängig von der Aktion)
function requireScope(scope) {
  return (req, res, next) => {
    const token = bearer(req);
    if ((req.session = noteDevice(validSession(token), req.get('x-bolzo-device')))) return next();
    const t = apiTokenFor(token);
    if (!t) return res.status(401).json({ error: 'Nicht angemeldet' });
    const need = [typeof scope === 'function' ? scope(req) : scope].flat().filter(Boolean);
    if (!need.some((s) => t.scopes.includes(s))) return res.status(403).json({ error: 'Dieser API-Zugang hat dafür keine Berechtigung' });
    req.apiToken = t;
    if (Date.now() - (t.lastUsed || 0) > 60e3) {
      t.lastUsed = Date.now();
      store.save();
    }
    next();
  };
}

// ---- Audit-Log -------------------------------------------------------------
// Kategorien: auth, client, power, action, script, shell, settings, system, connection, network
const ipOf = (req) => String(req.ip || '').replace(/^::ffff:/, '');
const agentLabel = (a) => (a ? a.name || a.info?.hostname || a.hostname || a.id : '');

function actorOf(req) {
  if (req.apiToken) return `API: ${req.apiToken.name}`;
  if (req.session) return req.session.device ? `Admin (${req.session.device})` : 'Admin';
  return 'Unbekannt';
}

function auditReq(req, cat, action, extra = {}) {
  return audit.add({ cat, action, actor: actorOf(req), ip: ipOf(req), ...extra });
}

function auditAgent(req, a, cat, action, extra = {}) {
  return auditReq(req, cat, action, { agentId: a.id, target: agentLabel(a), ...extra });
}

audit.onEntry((entry) => broadcast({ type: 'audit', entry }));

app.get('/health', (req, res) => res.json({ ok: true, id: store.data.serverId }));

// ---- Login ----------------------------------------------------------------
const loginFails = new Map(); // ip -> [timestamps]
let allFails = []; // alle Fehlversuche – bremst auch Angriffe von vielen Adressen aus
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip;
  const since = Date.now() - 10 * 60e3;
  const recent = (loginFails.get(ip) || []).filter((t) => t > since);
  allFails = allFails.filter((t) => t > since);
  const device = String(req.body?.device || '').trim().slice(0, 60);
  if (recent.length >= 5 || allFails.length >= 30) {
    audit.add({ cat: 'auth', action: 'Anmeldung gesperrt', actor: device || 'Unbekannt', ip: ipOf(req), detail: 'Zu viele Fehlversuche', ok: false });
    return res.status(429).json({ error: 'Zu viele Fehlversuche – bitte 10 Minuten warten' });
  }
  const { password } = req.body || {};
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    recent.push(Date.now());
    loginFails.set(ip, recent);
    allFails.push(Date.now());
    audit.add({ cat: 'auth', action: 'Anmeldung fehlgeschlagen', actor: device || 'Unbekannt', ip: ipOf(req), detail: 'Falsches Passwort', ok: false });
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const [k, s] of Object.entries(store.data.sessions)) if (s.expires < now) delete store.data.sessions[k];
  req.session = { created: now, expires: now + SESSION_DAYS * 864e5, device: device || undefined, ip: ipOf(req), pw: PW_MARK };
  store.data.sessions[sha256hex(token)] = req.session;
  store.save();
  auditReq(req, 'auth', 'Anmeldung');
  res.json({ token });
}));

function closeSessionSockets(keep) {
  for (const ws of admins) if (ws.sessionKey !== keep) ws.close(4001, 'abgemeldet');
}

app.post('/api/logout', requireAdmin, (req, res) => {
  const key = sha256hex(bearer(req));
  delete store.data.sessions[key];
  store.save();
  for (const ws of admins) if (ws.sessionKey === key) ws.close(4001, 'abgemeldet');
  auditReq(req, 'auth', 'Abmeldung');
  res.json({ ok: true });
});

// Alle anderen Anmeldungen beenden (z.B. wenn ein Laptop mit der App verloren ging)
app.post('/api/sessions/revoke', requireAdmin, (req, res) => {
  const keep = sha256hex(bearer(req));
  const n = Object.keys(store.data.sessions).filter((k) => k !== keep).length;
  for (const k of Object.keys(store.data.sessions)) if (k !== keep) delete store.data.sessions[k];
  store.save();
  closeSessionSockets(keep);
  auditReq(req, 'auth', 'Andere Anmeldungen beendet', { detail: `${n} Sitzung${n === 1 ? '' : 'en'}` });
  res.json({ ok: true, revoked: n });
});

// Live-Verbindungen (WebSocket) melden sich mit einem kurzlebigen Einmal-Ticket an statt mit der
// Sitzung selbst – so landet die 30 Tage gültige Sitzung nie in Adresszeilen und Proxy-Logs.
const wsTickets = new Map(); // ticket -> { key, exp }
app.post('/api/ws-ticket', requireAdmin, (req, res) => {
  const now = Date.now();
  for (const [k, v] of wsTickets) if (v.exp < now) wsTickets.delete(k);
  const ticket = crypto.randomBytes(24).toString('base64url');
  wsTickets.set(ticket, { key: sha256hex(bearer(req)), exp: now + 60e3 });
  res.json({ ticket });
});

function wsAuth(url) {
  const ticket = url.searchParams.get('ticket');
  if (ticket) {
    const t = wsTickets.get(ticket);
    wsTickets.delete(ticket); // nur einmal gültig
    const session = t && t.exp > Date.now() ? sessionByKey(t.key) : null;
    return session ? { session, key: t.key } : null;
  }
  // Apps bis 1.13 schicken noch die Sitzung selbst – entfernen, sobald alle Apps aktualisiert sind
  const token = url.searchParams.get('token');
  const session = validSession(token);
  return session ? { session, key: sha256hex(token) } : null;
}

// ---- Clients --------------------------------------------------------------
// API-Zugänge (z.B. Sprachsteuerung) bekommen die Notizen nicht – darin stehen oft Zugangsdaten
const forCaller = (req, s) => (req.apiToken ? { ...s, notes: undefined } : s);

app.get('/api/agents', requireScope('status'), (req, res) => {
  res.json(Object.values(store.data.agents).map((a) => forCaller(req, summarize(a, true))));
});

function getAgent(req) {
  const a = store.data.agents[req.params.id];
  if (!a) throw httpError(404, 'Client nicht gefunden');
  return a;
}

app.get('/api/agents/:id', requireScope('status'), wrap(async (req, res) => {
  const a = getAgent(req);
  res.json(forCaller(req, { ...summarize(a), history: live.get(a.id)?.history || [] }));
}));

// Durchschnittliche Auslastung aller Online-Clients je Minute (letzte Stunde) – fürs Dashboard
app.get('/api/stats/history', requireAdmin, (req, res) => {
  const buckets = new Map();
  for (const id of conns.keys()) {
    for (const [ts, cpu, mem] of live.get(id)?.history || []) {
      const m = Math.floor(ts / 60e3) * 60e3;
      const b = buckets.get(m) || { cpu: 0, mem: 0, n: 0 };
      b.cpu += cpu; b.mem += mem; b.n++;
      buckets.set(m, b);
    }
  }
  res.json([...buckets].sort((x, y) => x[0] - y[0]).map(([m, b]) => [m, Math.round((b.cpu / b.n) * 10) / 10, Math.round((b.mem / b.n) * 10) / 10]));
});

app.patch('/api/agents/:id', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const { name, tags, notes, pve, probe } = req.body || {};
  const before = { label: agentLabel(a), tags: a.tags || [], notes: a.notes || '' };
  // Abfrage-Client: fragt OPNsense, Switches und andere Netzwerkgeräte ab (siehe network.js)
  if (typeof probe === 'boolean' && probe !== !!a.probe) {
    a.probe = probe || undefined;
    auditAgent(req, a, 'network', probe ? 'Als Abfrage-Client freigegeben' : 'Abfrage-Client entfernt');
    network.agentChanged(a.id);
  }
  if (pve === null && a.pve) {
    delete a.pve;
    auditAgent(req, a, 'client', 'Proxmox-Zuordnung entfernt');
  } else if (pve && typeof pve === 'object') {
    const host = store.data.agents[pve.hostId];
    const vmid = Number(pve.vmid);
    if (!host?.info?.proxmox) throw httpError(400, 'Der gewählte Client ist kein Proxmox-Host');
    if (host.id === a.id) throw httpError(400, 'Ein Proxmox-Host kann nicht sich selbst zugeordnet werden');
    if (!Number.isInteger(vmid) || vmid < 100) throw httpError(400, 'Ungültige VM-ID');
    if (!['qemu', 'lxc'].includes(pve.type)) throw httpError(400, 'Ungültiger Typ');
    const taken = Object.values(store.data.agents).find((x) => x.id !== a.id && x.pve?.hostId === host.id && x.pve.vmid === vmid);
    if (taken) throw httpError(409, `ID ${vmid} ist bereits ${agentLabel(taken)} zugeordnet`);
    a.pve = { hostId: host.id, vmid, type: pve.type };
    auditAgent(req, a, 'client', 'Proxmox-Zuordnung', { detail: `${pve.type === 'lxc' ? 'Container' : 'VM'} ${vmid} auf ${agentLabel(host)}` });
  }
  if (typeof name === 'string') a.name = name.trim().slice(0, 80) || undefined;
  if (Array.isArray(tags)) a.tags = [...new Set(tags.map((t) => String(t).trim().slice(0, 32)).filter(Boolean))].slice(0, 20);
  if (typeof notes === 'string') a.notes = notes.slice(0, 20000);
  store.save();
  if (agentLabel(a) !== before.label) auditAgent(req, a, 'client', 'Umbenannt', { detail: `${before.label} → ${agentLabel(a)}` });
  const added = (a.tags || []).filter((t) => !before.tags.includes(t));
  const removed = before.tags.filter((t) => !(a.tags || []).includes(t));
  if (added.length || removed.length) {
    auditAgent(req, a, 'client', 'Tags geändert', { detail: [...added.map((t) => `+${t}`), ...removed.map((t) => `−${t}`)].join(', ') });
  }
  if ((a.notes || '') !== before.notes) auditAgent(req, a, 'client', 'Notizen geändert');
  broadcastAgent(a.id);
  res.json(summarize(a));
}));

app.delete('/api/agents/:id', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const c = conns.get(a.id);
  delete store.data.agents[a.id];
  live.delete(a.id);
  for (const j of store.data.jobs) j.agentIds = j.agentIds.filter((id) => id !== a.id);
  store.save();
  auditAgent(req, a, 'client', 'Client entfernt');
  if (c) {
    sendJson(c.ws, { type: 'revoked' });
    c.ws.close(4003, 'revoked');
  }
  broadcast({ type: 'agent.removed', id: a.id });
  res.json({ ok: true });
}));

const ACTIONS = new Set(['processes', 'kill', 'services', 'service', 'reboot', 'shutdown', 'update', 'uninstall', 'info']);
const POWER_LABELS = { reboot: 'Neustart', shutdown: 'Herunterfahren' };
const SERVICE_OPS = { start: 'Dienst gestartet', stop: 'Dienst gestoppt', restart: 'Dienst neu gestartet' };

// Nur verändernde Aktionen landen im Protokoll (Prozess-/Dienstlisten nicht)
function auditedAction(action, params) {
  switch (action) {
    case 'reboot':
    case 'shutdown': return { cat: 'power', action: POWER_LABELS[action] };
    case 'kill': return { cat: 'action', action: 'Prozess beendet', detail: params.name ? `${params.name} (PID ${params.pid})` : `PID ${params.pid}` };
    case 'service': return { cat: 'action', action: SERVICE_OPS[params.op] || `Dienst: ${params.op}`, detail: params.name };
    case 'update': return { cat: 'action', action: 'Agent-Update', detail: 'manuell' };
    case 'uninstall': return { cat: 'action', action: 'Agent deinstalliert' };
    default: return null;
  }
}
app.post('/api/agents/:id/action', requireScope((req) => ACTION_SCOPES[req.body?.action]), wrap(async (req, res) => {
  const a = getAgent(req);
  const { action, params } = req.body || {};
  if (!ACTIONS.has(action)) throw httpError(400, 'Unbekannte Aktion');
  log(`[action] ${action} -> ${a.info?.hostname || a.id}`);
  const what = auditedAction(action, params || {});
  let result;
  try {
    result = await agentRequest(a.id, action, params || {}, action === 'services' || action === 'processes' ? 45000 : 30000);
  } catch (e) {
    if (what) auditAgent(req, a, what.cat, what.action, { detail: what.detail, ok: false, result: e.message });
    throw e;
  }
  if (what) auditAgent(req, a, what.cat, what.action, { detail: what.detail });
  if (action === 'info') {
    a.info = result;
    store.save();
    broadcastAgent(a.id);
  }
  res.json(result ?? { ok: true });
}));

// Wake-on-LAN: bevorzugt über einen Online-Client im selben /24-Netz senden,
// sonst direkt vom Server (funktioniert nur, wenn der Server im selben LAN steht).
function sendMagicPacket(macs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      let pending = macs.length;
      for (const mac of macs) {
        const hex = mac.replace(/[^0-9a-f]/gi, '');
        const buf = Buffer.alloc(102, 0xff);
        for (let i = 1; i <= 16; i++) Buffer.from(hex, 'hex').copy(buf, i * 6);
        sock.send(buf, 9, '255.255.255.255', () => {
          if (--pending === 0) { sock.close(); resolve(); }
        });
      }
    });
  });
}

const subnet24 = (ip) => ip.split('.').slice(0, 3).join('.');
app.post('/api/agents/:id/wake', requireScope('power'), wrap(async (req, res) => {
  const a = getAgent(req);
  if (a.pve && conns.has(a.pve.hostId)) {
    const host = store.data.agents[a.pve.hostId];
    await agentRequest(host.id, 'pve.power', { vmid: a.pve.vmid, type: a.pve.type, op: 'start' }, 30000);
    auditAgent(req, a, 'power', 'Aufwecken', { detail: `über Proxmox (${agentLabel(host)})` });
    return res.json({ ok: true, via: `Proxmox (${agentLabel(host)})` });
  }
  const ifaces = (a.info?.interfaces || []).filter((i) => i.mac && i.mac !== '00:00:00:00:00:00');
  if (!ifaces.length) throw httpError(400, 'Keine MAC-Adresse für diesen Client bekannt');
  const macs = [...new Set(ifaces.map((i) => i.mac))];
  const nets = new Set(ifaces.map((i) => subnet24(i.ip)));
  for (const [id] of conns) {
    if (id === a.id) continue;
    const other = store.data.agents[id];
    const hit = (other?.info?.interfaces || []).some((i) => nets.has(subnet24(i.ip)));
    if (hit) {
      await agentRequest(id, 'wol', { macs });
      auditAgent(req, a, 'power', 'Aufwecken', { detail: `über ${agentLabel(other)}` });
      return res.json({ ok: true, via: other.name || other.info.hostname });
    }
  }
  await sendMagicPacket(macs);
  auditAgent(req, a, 'power', 'Aufwecken', { detail: 'über den Server' });
  res.json({ ok: true, via: 'Server' });
}));

// ---- Proxmox ---------------------------------------------------------------
// Alle Aufrufe gehen an den Agent auf dem Proxmox-Host (pvesh/qm/pct als root).
const PVE_LABELS = { start: 'Starten', shutdown: 'Herunterfahren', stop: 'Ausschalten (hart)', reboot: 'Neustart' };
const guestKind = (type) => (type === 'lxc' ? 'Container' : 'VM');

function pveHost(req) {
  const h = getAgent(req);
  if (!h.info?.proxmox) throw httpError(400, 'Dieser Client ist kein Proxmox-Host (Agent ab Version 1.3.0 nötig)');
  return h;
}

// Für das Protokoll: zugeordneter Client, sonst "VM 105 (name) auf PROX"
function guestAudit(host, vmid, type, name) {
  const a = Object.values(store.data.agents).find((x) => x.pve?.hostId === host.id && x.pve.vmid === vmid);
  return a
    ? { agentId: a.id, target: agentLabel(a), detail: `${guestKind(type)} ${vmid} auf ${agentLabel(host)}` }
    : { agentId: host.id, target: `${guestKind(type)} ${vmid}${name ? ` (${name})` : ''}`, detail: `auf ${agentLabel(host)}` };
}

function guestParams(body) {
  const vmid = Number(body?.vmid);
  if (!Number.isInteger(vmid) || vmid < 100) throw httpError(400, 'Ungültige VM-ID');
  if (!['qemu', 'lxc'].includes(body?.type)) throw httpError(400, 'Ungültiger Typ');
  return { vmid, type: body.type, name: String(body?.name || '').slice(0, 80) };
}

app.get('/api/agents/:id/pve/guests', requireScope(['proxmox', 'pvedelete']), wrap(async (req, res) => {
  const h = pveHost(req);
  const r = await agentRequest(h.id, 'pve.guests', {}, 60000);
  const assigned = {};
  for (const a of Object.values(store.data.agents)) if (a.pve?.hostId === h.id) assigned[`${a.pve.type}:${a.pve.vmid}`] = a.id;
  res.json({ ...r, guests: r.guests.map((g) => ({ ...g, agentId: assigned[`${g.type}:${g.vmid}`] || null })) });
}));

app.post('/api/agents/:id/pve/power', requireScope('proxmox'), wrap(async (req, res) => {
  const h = pveHost(req);
  const { vmid, type, name } = guestParams(req.body);
  const op = req.body?.op;
  if (!PVE_LABELS[op]) throw httpError(400, 'Unbekannte Aktion');
  const what = guestAudit(h, vmid, type, name);
  try {
    const r = await agentRequest(h.id, 'pve.power', { vmid, type, op }, 30000);
    auditReq(req, 'power', `Proxmox: ${PVE_LABELS[op]}`, what);
    res.json(r);
  } catch (e) {
    auditReq(req, 'power', `Proxmox: ${PVE_LABELS[op]}`, { ...what, ok: false, result: e.message });
    throw e;
  }
}));

// Verwaltung: Gast-Einstellungen, Snapshots, Backups, Host (Speicher, Updates, Aufgaben, Netzwerk).
// Nur diese Agent-Aktionen sind erlaubt; verändernde landen im Protokoll.
// VM/Container endgültig löschen (samt Disks). Der Agent lehnt laufende oder geschützte Gäste ab.
app.post('/api/agents/:id/pve/destroy', requireScope('pvedelete'), wrap(async (req, res) => {
  const h = pveHost(req);
  const { vmid, type, name } = guestParams(req.body);
  const what = guestAudit(h, vmid, type, name);
  const label = `Proxmox: ${guestKind(type)} gelöscht`;
  try {
    const r = await agentRequest(h.id, 'pve.destroy', { vmid, type }, 40000);
    // Zuordnung von Clients zu diesem Gast aufheben
    for (const a of Object.values(store.data.agents)) {
      if (a.pve?.hostId === h.id && a.pve.vmid === vmid && a.pve.type === type) {
        delete a.pve;
        broadcastAgent(a.id);
      }
    }
    store.save();
    auditReq(req, 'action', label, { ...what, detail: [what.detail, name].filter(Boolean).join(' – ') });
    res.json(r ?? { ok: true });
  } catch (e) {
    auditReq(req, 'action', label, { ...what, ok: false, result: e.message });
    throw e;
  }
}));

const PVE_CALLS = {
  'pve.config.get': { guest: true },
  'pve.config.set': { guest: true, audit: 'Proxmox: Einstellungen geändert', detail: (p) => Object.keys(p.changes || {}).join(', ') },
  'pve.rrd': { guest: true },
  'pve.snap.list': { guest: true },
  'pve.snap': { guest: true, timeout: 45000, audit: (p) => ({ create: 'Proxmox: Snapshot angelegt', rollback: 'Proxmox: Snapshot zurückgerollt', delete: 'Proxmox: Snapshot gelöscht' })[p.op], detail: (p) => p.snapname },
  'pve.backup.info': { guest: true, timeout: 60000 },
  'pve.backup.run': { guest: true, audit: 'Proxmox: Backup gestartet', detail: (p) => `auf ${p.storage} (${p.mode || 'snapshot'})` },
  'pve.host': { timeout: 60000 },
  'pve.apt.refresh': { timeout: 150000, audit: 'Proxmox: Paketlisten aktualisiert' },
  'pve.tasks': {},
  'pve.net.list': {},
  'pve.net.save': { audit: (p) => (p.create ? 'Proxmox: Brücke angelegt' : 'Proxmox: Brücke geändert'), detail: (p) => [p.iface, p.cidr, p.ports].filter(Boolean).join(' · ') },
  'pve.net.delete': { audit: 'Proxmox: Brücke gelöscht', detail: (p) => p.iface },
  'pve.net.revert': { audit: 'Proxmox: Netzwerk-Änderungen verworfen' },
  'pve.net.apply': { timeout: 240000, audit: 'Proxmox: Netzwerk-Änderungen angewendet' },
};

app.post('/api/agents/:id/pve/call', requireAdmin, wrap(async (req, res) => {
  const h = pveHost(req);
  const { action, params = {} } = req.body || {};
  const def = PVE_CALLS[action];
  if (!def) throw httpError(400, 'Unbekannte Proxmox-Aktion');
  const label = typeof def.audit === 'function' ? def.audit(params) : def.audit;
  let what = { agentId: h.id, target: agentLabel(h) };
  if (def.guest) {
    const g = guestParams(params);
    what = guestAudit(h, g.vmid, g.type, g.name);
  }
  const detail = [what.detail, def.detail?.(params)].filter(Boolean).join(' – ') || undefined;
  try {
    const r = await agentRequest(h.id, action, params, def.timeout || 30000);
    if (label) auditReq(req, def.guest ? 'action' : 'settings', label, { ...what, detail, ok: r?.ok !== false, result: r?.message });
    res.json(r ?? { ok: true });
  } catch (e) {
    if (label) auditReq(req, def.guest ? 'action' : 'settings', label, { ...what, detail, ok: false, result: e.message });
    throw e;
  }
}));

// Updates des Proxmox-Hosts installieren: läuft als Skript, Ausgabe unter Verlauf -> Skript-Ausgaben
app.post('/api/agents/:id/pve/upgrade', requireAdmin, wrap(async (req, res) => {
  const h = pveHost(req);
  if (!conns.has(h.id)) throw httpError(409, 'Client ist offline');
  const script = {
    name: 'Proxmox-Updates installieren', shell: 'bash', timeout: 3600,
    body: 'export DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade\n[ -f /run/reboot-required ] && echo "*** Neustart erforderlich ***" || true',
  };
  log(`[pve] Updates auf ${agentLabel(h)} gestartet`);
  runOn(h.id, script, req).catch(() => {}); // dauert lange – Ergebnis kommt über den Verlauf
  res.json({ ok: true, started: true });
}));

// BOLZO-Agent im Gast neu starten (pct exec bzw. QEMU-Gast-Agent), z.B. wenn er hängt
app.post('/api/agents/:id/pve/restart-agent', requireAdmin, wrap(async (req, res) => {
  const h = pveHost(req);
  const { vmid, type, name } = guestParams(req.body);
  const what = guestAudit(h, vmid, type, name);
  try {
    const r = await agentRequest(h.id, 'pve.restartAgent', { vmid, type }, 60000);
    auditReq(req, 'action', 'Agent im Gast neu gestartet', what);
    res.json(r);
  } catch (e) {
    auditReq(req, 'action', 'Agent im Gast neu gestartet', { ...what, ok: false, result: e.message });
    throw e;
  }
}));

// VM-Bildschirm: Der Host-Agent öffnet einen Tunnel (/ws/tunnel) zum VNC der VM, die App
// verbindet sich mit /ws/console. Der Server reicht die Daten unverändert durch.
const tunnels = new Map(); // sid -> { hostId, agentWs, adminWs, toAdmin: [], toAgent: [], timer, audit }

function closeTunnel(sid, reason = 'geschlossen') {
  const t = tunnels.get(sid);
  if (!t) return;
  tunnels.delete(sid);
  clearTimeout(t.timer);
  for (const ws of [t.agentWs, t.adminWs]) try { ws?.close(); } catch {}
  if (t.connectedAt && t.audit) {
    const secs = Math.round((Date.now() - t.connectedAt) / 1000);
    audit.add({ ...t.audit, action: 'Konsole geschlossen', detail: `${t.audit.detail}, ${reason}, Dauer ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`}` });
  }
}

app.post('/api/agents/:id/pve/console', requireAdmin, wrap(async (req, res) => {
  const h = pveHost(req);
  const { vmid, type, name } = guestParams(req.body);
  if (type !== 'qemu') throw httpError(400, 'Die Bildschirm-Konsole gibt es nur für VMs – Container öffnen ein Terminal');
  const sid = crypto.randomUUID();
  const what = guestAudit(h, vmid, type, name);
  const t = { hostId: h.id, agentWs: null, adminWs: null, toAdmin: [], toAgent: [] };
  t.timer = setTimeout(() => closeTunnel(sid, 'nicht verbunden'), 30000);
  tunnels.set(sid, t);
  let r;
  try {
    r = await agentRequest(h.id, 'vnc.open', { sid, vmid }, 45000);
  } catch (e) {
    closeTunnel(sid);
    auditReq(req, 'shell', 'Konsole geöffnet', { ...what, ok: false, result: e.message });
    throw e;
  }
  t.audit = { cat: 'shell', actor: actorOf(req), ip: ipOf(req), ...what };
  audit.add({ ...t.audit, action: 'Konsole geöffnet' });
  res.json({ sid, password: r?.password || null });
}));

// ---- Ordner für Clients -----------------------------------------------------
const folderById = (id) => store.data.folders.find((f) => f.id === id);
const broadcastFolders = () => broadcast({ type: 'folders', folders: store.data.folders });
function folderPath(id) {
  const parts = [];
  for (let f = folderById(id), guard = 0; f && guard < 50; f = folderById(f.parentId), guard++) parts.unshift(f.name);
  return parts.join(' / ');
}
const isDescendant = (id, ancestor) => {
  for (let f = folderById(id), guard = 0; f && guard < 50; f = folderById(f.parentId), guard++) if (f.id === ancestor) return true;
  return false;
};
// Symbol und Farbe eines Ordners (Symbolnamen kommen aus der App, Farbe als #rrggbb)
function folderStyle(body, f) {
  if (body?.icon !== undefined) {
    const ic = String(body.icon || '');
    if (ic && !/^[a-zA-Z]{2,20}$/.test(ic)) throw httpError(400, 'Ungültiges Symbol');
    f.icon = ic || undefined;
  }
  if (body?.color !== undefined) {
    const c = String(body.color || '');
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw httpError(400, 'Ungültige Farbe');
    f.color = c || undefined;
  }
}
const folderName = (v) => {
  const n = String(v || '').trim().slice(0, 60);
  if (!n) throw httpError(400, 'Name fehlt');
  return n;
};

app.get('/api/folders', requireAdmin, (req, res) => res.json(store.data.folders));

app.post('/api/folders', requireAdmin, wrap(async (req, res) => {
  const parentId = req.body?.parentId || null;
  if (parentId && !folderById(parentId)) throw httpError(400, 'Übergeordneter Ordner nicht gefunden');
  const f = { id: crypto.randomUUID(), name: folderName(req.body?.name), parentId, createdAt: Date.now() };
  folderStyle(req.body, f);
  store.data.folders.push(f);
  store.save();
  auditReq(req, 'client', 'Ordner angelegt', { target: folderPath(f.id) });
  broadcastFolders();
  res.json(f);
}));

app.patch('/api/folders/:fid', requireAdmin, wrap(async (req, res) => {
  const f = folderById(req.params.fid);
  if (!f) throw httpError(404, 'Ordner nicht gefunden');
  const before = folderPath(f.id);
  if (req.body?.name !== undefined) f.name = folderName(req.body.name);
  folderStyle(req.body, f);
  if (req.body?.parentId !== undefined) {
    const pid = req.body.parentId || null;
    if (pid && (!folderById(pid) || pid === f.id || isDescendant(pid, f.id))) throw httpError(400, 'Ein Ordner kann nicht in sich selbst verschoben werden');
    f.parentId = pid;
  }
  store.save();
  auditReq(req, 'client', 'Ordner geändert', { target: folderPath(f.id), detail: before !== folderPath(f.id) ? `vorher: ${before}` : undefined });
  broadcastFolders();
  res.json(f);
}));

// Löschen: Unterordner und Clients wandern eine Ebene nach oben
app.delete('/api/folders/:fid', requireAdmin, (req, res) => {
  const f = folderById(req.params.fid);
  if (!f) return res.json({ ok: true });
  const path = folderPath(f.id);
  for (const c of store.data.folders) if (c.parentId === f.id) c.parentId = f.parentId;
  for (const a of Object.values(store.data.agents)) {
    if (a.folderId === f.id) { a.folderId = f.parentId || undefined; broadcastAgent(a.id); }
  }
  store.data.folders = store.data.folders.filter((x) => x.id !== f.id);
  store.save();
  auditReq(req, 'client', 'Ordner gelöscht', { target: path });
  broadcastFolders();
  res.json({ ok: true });
});

// Mehrere Clients in einen Ordner verschieben (folderId null = ohne Ordner)
app.post('/api/agents/move', requireAdmin, wrap(async (req, res) => {
  const folderId = req.body?.folderId || null;
  if (folderId && !folderById(folderId)) throw httpError(400, 'Ordner nicht gefunden');
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => store.data.agents[id]);
  for (const id of ids) {
    store.data.agents[id].folderId = folderId || undefined;
    broadcastAgent(id);
  }
  store.save();
  if (ids.length) auditReq(req, 'client', 'In Ordner verschoben', { target: ids.map((id) => agentLabel(store.data.agents[id])).join(', ').slice(0, 300), detail: folderId ? folderPath(folderId) : 'ohne Ordner' });
  res.json({ ok: true, moved: ids.length });
}));

// ---- Dateimanager ------------------------------------------------------------
// Auflisten/Anlegen/Umbenennen/Löschen gehen direkt an den Agent. Übertragungen laufen über
// einen eigenen Tunnel: Hochladen per WebSocket (/ws/stream, kein Größenlimit durch nginx),
// Herunterladen als HTTP-Antwort – mit einem kurzlebigen Schlüssel in der Adresse, damit
// Dateien auch per Drag & Drop aus der App auf den Desktop gezogen werden können.
const FS_CALLS = {
  list: { action: 'fs.list' },
  mkdir: { action: 'fs.mkdir', audit: 'Ordner angelegt (Dateien)', detail: (p) => p.path },
  rename: { action: 'fs.rename', audit: 'Datei umbenannt', detail: (p) => `${p.from} → ${p.name}` },
  delete: { action: 'fs.delete', audit: 'Dateien gelöscht', detail: (p) => (p.paths || []).join(', ').slice(0, 500) },
};
// Ein Download-Schlüssel gilt nur für Dateien direkt in dem Ordner, der gerade angezeigt wurde
const dlKeys = new Map(); // key -> { agentId, dir, exp }
const trimSep = (p) => String(p || '').replace(/[\\/]+$/, '');
const parentOf = (p) => trimSep(p).replace(/[\\/][^\\/]*$/, '');
function dlKeyFor(agentId, dir) {
  const now = Date.now();
  for (const [k, v] of dlKeys) if (v.exp < now) dlKeys.delete(k);
  const key = crypto.randomBytes(18).toString('base64url');
  dlKeys.set(key, { agentId, dir: trimSep(dir), exp: now + 30 * 60e3 });
  return key;
}

app.post('/api/agents/:id/files', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const { op, ...params } = req.body || {};
  const def = FS_CALLS[op];
  if (!def) throw httpError(400, 'Unbekannte Dateiaktion');
  try {
    const r = await agentRequest(a.id, def.action, params, 60000);
    if (def.audit) auditAgent(req, a, 'action', def.audit, { detail: def.detail(params) });
    res.json(op === 'list' ? { ...r, dlKey: dlKeyFor(a.id, r.path) } : r);
  } catch (e) {
    if (def.audit) auditAgent(req, a, 'action', def.audit, { detail: def.detail(params), ok: false, result: e.message });
    throw e;
  }
}));

// Hochladen vorbereiten: Agent öffnet den Tunnel, die App schickt danach über /ws/stream
app.post('/api/agents/:id/files/upload', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const { dir, name, size } = req.body || {};
  const sid = crypto.randomUUID();
  const t = { hostId: a.id, agentWs: null, adminWs: null, toAdmin: [], toAgent: [] };
  t.timer = setTimeout(() => closeTunnel(sid, 'nicht verbunden'), 30000);
  tunnels.set(sid, t);
  try {
    await agentRequest(a.id, 'fs.upload', { sid, dir, name, size }, 30000);
  } catch (e) {
    closeTunnel(sid);
    throw e;
  }
  auditAgent(req, a, 'action', 'Datei hochgeladen', { detail: `${dir}${dir && !/[\\/]$/.test(dir) ? '/' : ''}${name} (${Math.round((Number(size) || 0) / 1024)} KB)` });
  res.json({ sid });
}));

// Herunterladen: GET mit Schlüssel statt Anmeldung (für Drag & Drop auf den Desktop)
app.get('/api/files/dl', wrap(async (req, res) => {
  const k = dlKeys.get(String(req.query.key || ''));
  const agentId = String(req.query.agent || '');
  if (!k || k.exp < Date.now() || k.agentId !== agentId) throw httpError(403, 'Download-Link abgelaufen – Ordner in der App neu laden');
  const a = store.data.agents[agentId];
  if (!a || !conns.has(agentId)) throw httpError(409, 'Client ist offline');
  const filePath = String(req.query.path || '');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(filePath) || parentOf(filePath) !== k.dir) throw httpError(403, 'Dieser Download-Link gilt nur für den angezeigten Ordner');
  const sid = crypto.randomUUID();
  let ready = false;
  let headersSet = false;
  let written = 0;
  const t = { hostId: agentId, agentWs: null, adminWs: null, toAdmin: [], toAgent: [] };
  const go = () => { if (ready && headersSet && t.agentWs?.readyState === 1) t.agentWs.send('go'); };
  t.onAgent = () => { ready = true; go(); };
  t.sink = (data, isBinary) => {
    if (isBinary) {
      res.write(data, () => {
        written += data.length;
        if (t.agentWs?.readyState === 1) t.agentWs.send(JSON.stringify({ ack: written }));
      });
      return;
    }
    let m = {};
    try { m = JSON.parse(data); } catch {}
    if (m.eof || m.error) {
      if (m.error && !res.headersSent) res.status(500).json({ error: m.error });
      else res.end();
      closeTunnel(sid);
    }
  };
  t.timer = setTimeout(() => closeTunnel(sid, 'nicht verbunden'), 60000);
  tunnels.set(sid, t);
  req.on('close', () => { if (!res.writableEnded) closeTunnel(sid); });
  let info;
  try {
    info = await agentRequest(agentId, 'fs.download', { sid, path: filePath }, 30000);
  } catch (e) {
    closeTunnel(sid);
    throw e;
  }
  clearTimeout(t.timer);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(info.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
    'Cache-Control': 'no-store',
  });
  res.flushHeaders();
  headersSet = true;
  audit.add({ cat: 'action', action: 'Datei heruntergeladen', actor: 'Admin', ip: ipOf(req), agentId, target: agentLabel(a), detail: `${filePath} (${Math.round(info.size / 1024)} KB)` });
  go();
}));

// ---- Skripte --------------------------------------------------------------
const SHELLS = new Set(['powershell', 'cmd', 'bash', 'sh', 'python']);

function validateScript(body) {
  const s = {
    name: String(body.name || '').trim().slice(0, 100),
    description: String(body.description || '').slice(0, 300),
    shell: body.shell,
    body: String(body.body || ''),
    timeout: Math.min(Math.max(Number(body.timeout) || 300, 5), 7200),
  };
  if (!s.name) throw httpError(400, 'Name fehlt');
  if (!SHELLS.has(s.shell)) throw httpError(400, 'Ungültige Shell');
  return s;
}

// API-Zugänge sehen nur Name und Beschreibung, nicht den Inhalt
app.get('/api/scripts', requireScope('scripts'), (req, res) => res.json(req.apiToken
  ? store.data.scripts.map((s) => ({ id: s.id, name: s.name, description: s.description || '', shell: s.shell }))
  : store.data.scripts));

app.post('/api/scripts', requireAdmin, wrap(async (req, res) => {
  const s = { id: crypto.randomUUID(), ...validateScript(req.body || {}), createdAt: Date.now() };
  store.data.scripts.push(s);
  store.save();
  auditReq(req, 'script', 'Skript angelegt', { target: s.name });
  res.json(s);
}));

app.put('/api/scripts/:sid', requireAdmin, wrap(async (req, res) => {
  const s = store.data.scripts.find((x) => x.id === req.params.sid);
  if (!s) throw httpError(404, 'Skript nicht gefunden');
  const oldName = s.name;
  Object.assign(s, validateScript(req.body || {}), { updatedAt: Date.now() });
  store.save();
  auditReq(req, 'script', 'Skript geändert', { target: s.name, detail: oldName !== s.name ? `umbenannt von ${oldName}` : undefined });
  res.json(s);
}));

app.delete('/api/scripts/:sid', requireAdmin, (req, res) => {
  const s = store.data.scripts.find((x) => x.id === req.params.sid);
  if (s) auditReq(req, 'script', 'Skript gelöscht', { target: s.name });
  store.data.scripts = store.data.scripts.filter((x) => x.id !== req.params.sid);
  store.save();
  res.json({ ok: true });
});

async function runOn(agentId, script, req) {
  const a = store.data.agents[agentId];
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    agentId,
    hostname: a ? a.name || a.info?.hostname : agentId,
    scriptName: script.name || 'Ad-hoc',
    shell: script.shell,
    ...(script.job ? { job: true } : {}),
  };
  try {
    if (!a) throw httpError(404, 'Client nicht gefunden');
    const r = await agentRequest(agentId, 'run', { body: script.body, shell: script.shell, timeout: script.timeout }, (script.timeout + 15) * 1000);
    Object.assign(entry, { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: r.output });
  } catch (e) {
    entry.error = e.message;
  }
  store.data.history.unshift({ ...entry, output: (entry.output || '').slice(0, 100_000) });
  store.data.history.length = Math.min(store.data.history.length, 300);
  store.save();
  broadcast({ type: 'history' });
  const adhoc = script.name === 'Ad-hoc';
  auditReq(req, 'script', adhoc ? 'Befehl ausgeführt' : script.job ? 'Job ausgeführt' : 'Skript ausgeführt', {
    agentId, target: entry.hostname,
    detail: adhoc ? `${script.shell}: ${script.body.slice(0, 2000)}` : `${script.name} (${script.shell})`,
    ok: !entry.error && !entry.timedOut && entry.exitCode === 0,
    result: entry.error || (entry.timedOut ? 'Zeitüberschreitung' : `Exit ${entry.exitCode}`),
    ref: entry.id,
  });
  return entry;
}

// Ad-hoc-Befehl/Skript auf einem Client
app.post('/api/agents/:id/run', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const s = validateScript({ name: 'Ad-hoc', ...req.body });
  log(`[run] ${s.name} (${s.shell}) -> ${a.info?.hostname}`);
  res.json(await runOn(a.id, s, req));
}));

// Bibliotheks-Skript auf mehreren Clients parallel
app.post('/api/scripts/:sid/run', requireScope('scripts'), wrap(async (req, res) => {
  const s = store.data.scripts.find((x) => x.id === req.params.sid);
  if (!s) throw httpError(404, 'Skript nicht gefunden');
  const ids = Array.isArray(req.body?.agentIds) ? req.body.agentIds : [];
  if (!ids.length) throw httpError(400, 'Keine Clients ausgewählt');
  log(`[run] ${s.name} -> ${ids.length} Client(s)`);
  res.json(await Promise.all(ids.map((id) => runOn(id, s, req))));
}));

// ---- Jobs -----------------------------------------------------------------
// Vorbereitete Aufgaben: ein fester Befehl auf festen Rechnern, z.B. "Minecraft-Server starten" auf
// SRV-MC. Mit dem Recht "jobs" auch per Telefon abrufbar – dort lässt sich weder der Befehl noch der
// Rechner ändern, nur der ganze Job auslösen.
function validateJob(body) {
  const s = validateScript(body);
  if (!s.body.trim()) throw httpError(400, 'Befehl fehlt');
  const agentIds = [...new Set((Array.isArray(body.agentIds) ? body.agentIds : []).filter((id) => store.data.agents[id]))];
  if (!agentIds.length) throw httpError(400, 'Mindestens einen Rechner auswählen');
  return { ...s, agentIds, voice: body.voice !== false };
}

const jobOk = (r) => !r.error && !r.timedOut && r.exitCode === 0;
// API-Zugänge sehen nur Jobs, die fürs Telefon freigegeben sind, und nicht den Befehl selbst
const jobForToken = (j) => ({
  id: j.id,
  name: j.name,
  description: j.description || '',
  agents: j.agentIds.filter((id) => store.data.agents[id]).map((id) => ({ id, name: agentLabel(store.data.agents[id]), online: conns.has(id) })),
});

app.get('/api/jobs', requireScope('jobs'), (req, res) => res.json(req.apiToken
  ? store.data.jobs.filter((j) => j.voice).map(jobForToken)
  : store.data.jobs));

app.post('/api/jobs', requireAdmin, wrap(async (req, res) => {
  const j = { id: crypto.randomUUID(), ...validateJob(req.body || {}), createdAt: Date.now() };
  store.data.jobs.push(j);
  store.save();
  auditReq(req, 'script', 'Job angelegt', { target: j.name });
  broadcast({ type: 'jobs' });
  res.json(j);
}));

app.put('/api/jobs/:jid', requireAdmin, wrap(async (req, res) => {
  const j = store.data.jobs.find((x) => x.id === req.params.jid);
  if (!j) throw httpError(404, 'Job nicht gefunden');
  const oldName = j.name;
  Object.assign(j, validateJob(req.body || {}), { updatedAt: Date.now() });
  store.save();
  auditReq(req, 'script', 'Job geändert', { target: j.name, detail: oldName !== j.name ? `umbenannt von ${oldName}` : undefined });
  broadcast({ type: 'jobs' });
  res.json(j);
}));

app.delete('/api/jobs/:jid', requireAdmin, (req, res) => {
  const j = store.data.jobs.find((x) => x.id === req.params.jid);
  if (j) auditReq(req, 'script', 'Job gelöscht', { target: j.name });
  store.data.jobs = store.data.jobs.filter((x) => x.id !== req.params.jid);
  store.save();
  broadcast({ type: 'jobs' });
  res.json({ ok: true });
});

// Job auf allen seinen Rechnern parallel ausführen – der Aufrufer bestimmt nichts außer dem Job
app.post('/api/jobs/:jid/run', requireScope('jobs'), wrap(async (req, res) => {
  const j = store.data.jobs.find((x) => x.id === req.params.jid);
  if (!j || (req.apiToken && !j.voice)) throw httpError(404, 'Job nicht gefunden');
  const ids = j.agentIds.filter((id) => store.data.agents[id]);
  if (!ids.length) throw httpError(400, 'Der Job hat keine Rechner mehr');
  log(`[job] ${j.name} -> ${ids.length} Client(s)`);
  const results = await Promise.all(ids.map((id) => runOn(id, { ...j, job: true }, req)));
  j.lastRun = { ts: Date.now(), ok: results.every(jobOk), by: actorOf(req) };
  store.save();
  broadcast({ type: 'jobs' });
  res.json(results);
}));

app.get('/api/history', requireAdmin, (req, res) => {
  let h = store.data.history;
  if (req.query.agentId) h = h.filter((x) => x.agentId === req.query.agentId);
  res.json(h.slice(0, 200));
});

app.delete('/api/history', requireAdmin, (req, res) => {
  store.data.history = [];
  store.save();
  auditReq(req, 'settings', 'Skript-Ausgaben gelöscht');
  res.json({ ok: true });
});

// Nur lesen – Protokolleinträge lassen sich über die API bewusst nicht löschen
app.get('/api/audit', requireAdmin, (req, res) => {
  const { cat, agentId, q } = req.query;
  const before = Number(req.query.before) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 20000);
  res.json(audit.query({ cat, agentId, q, before, limit }));
});

// ---- Einstellungen & Enrollment ------------------------------------------
app.get('/api/settings', requireAdmin, (req, res) => res.json(store.data.settings));

app.put('/api/settings', requireAdmin, wrap(async (req, res) => {
  const t = req.body?.thresholds || {};
  const changes = [];
  const LABELS = { cpu: 'CPU', mem: 'RAM', disk: 'Datenträger' };
  for (const k of ['cpu', 'mem', 'disk']) {
    const v = Number(t[k]);
    const old = store.data.settings.thresholds[k];
    if (v >= 10 && v <= 100 && v !== old) {
      store.data.settings.thresholds[k] = v;
      changes.push(`${LABELS[k]}-Warnung ${old} → ${v} %`);
    }
  }
  if (typeof req.body?.autoUpdateAgents === 'boolean' && req.body.autoUpdateAgents !== store.data.settings.autoUpdateAgents) {
    store.data.settings.autoUpdateAgents = req.body.autoUpdateAgents;
    changes.push(`Agents automatisch aktualisieren: ${req.body.autoUpdateAgents ? 'an' : 'aus'}`);
  }
  store.save();
  if (changes.length) auditReq(req, 'settings', 'Einstellungen geändert', { detail: changes.join(', ') });
  for (const id of Object.keys(store.data.agents)) broadcastAgent(id);
  res.json(store.data.settings);
}));

// ---- Updates ---------------------------------------------------------------
// Server: Die Desktop-App legt eine Anforderungsdatei an. Eine systemd-Path-Unit
// (läuft als root, siehe install-server.sh) startet daraufhin install.sh von GitHub.
const REPO = process.env.UPDATE_REPO || 'Rick7O7/bolzo-rmm';
const UPDATE_REQUEST = path.join(DATA_DIR, 'update-request');
const UPDATE_LOG = path.join(DATA_DIR, 'update.log');
const UPDATE_UNIT = '/etc/systemd/system/bolzo-rmm-update.path';
let updateRequestedAt = 0;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const SERVER_VERSION = readJson(path.join(__dirname, 'version.json')) || { commit: 'dev', date: null, message: 'Entwicklungsversion' };

// Mitgelieferter Agent: Version und Fingerabdruck (muss dem CODE_HASH im Agent entsprechen)
let agentBundle = { version: '?', hash: '' };
function loadAgentBundle() {
  const buf = fs.readFileSync(path.join(__dirname, 'agent', 'agent.js'));
  agentBundle = {
    version: (buf.toString('utf8').match(/const VERSION = '([^']+)'/) || [])[1] || '?',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}
loadAgentBundle();
const agentOutdated = (a) => !a.agentHash || a.agentHash !== agentBundle.hash;

let latestCache = { at: 0, data: null };
async function latestOnGitHub(force = false) {
  if (!force && latestCache.data && Date.now() - latestCache.at < 5 * 60e3) return latestCache.data;
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
    headers: { 'User-Agent': 'bolzo-rmm-server', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}`);
  const c = await res.json();
  latestCache = { at: Date.now(), data: { commit: c.sha.slice(0, 7), date: c.commit.committer.date, message: c.commit.message.split('\n')[0] } };
  return latestCache.data;
}

function updateLogTail() {
  try { return fs.readFileSync(UPDATE_LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-25).join('\n'); } catch { return ''; }
}

app.get('/api/update', requireAdmin, wrap(async (req, res) => {
  let latest = null, latestError = null;
  try { latest = await latestOnGitHub(req.query.force === '1'); } catch (e) { latestError = e.message; }
  const agents = Object.values(store.data.agents);
  res.json({
    server: SERVER_VERSION,
    latest,
    latestError,
    updateAvailable: !!latest && SERVER_VERSION.commit !== 'dev' && latest.commit !== SERVER_VERSION.commit,
    canSelfUpdate: fs.existsSync(UPDATE_UNIT),
    updating: fs.existsSync(UPDATE_REQUEST) || (updateRequestedAt > 0 && Date.now() - updateRequestedAt < 15 * 60e3),
    log: updateLogTail(),
    agent: { version: agentBundle.version, total: agents.length, outdated: agents.filter(agentOutdated).length, outdatedOnline: agents.filter((a) => conns.has(a.id) && agentOutdated(a)).length },
  });
}));

app.post('/api/update/server', requireAdmin, wrap(async (req, res) => {
  if (!fs.existsSync(UPDATE_UNIT)) throw httpError(501, 'Selbst-Update ist auf diesem Server noch nicht eingerichtet. Bitte einmal den curl-Installationsbefehl auf dem Server ausführen.');
  fs.writeFileSync(UPDATE_REQUEST, JSON.stringify({ requestedAt: Date.now() }));
  updateRequestedAt = Date.now();
  log('[update] Server-Update angefordert');
  auditReq(req, 'system', 'Server-Update angefordert', { detail: `aktuell ${SERVER_VERSION.commit}` });
  broadcast({ type: 'server.updating' });
  res.json({ ok: true });
}));

function updateAgent(id, reason, req) {
  const a = store.data.agents[id];
  if (!a) return Promise.resolve();
  a.lastAutoUpdate = Date.now();
  log(`[update] Agent ${a.info?.hostname || id} wird aktualisiert (${reason})`);
  const entry = { agentId: id, target: agentLabel(a), detail: `${reason}, ${a.version || '?'} → ${agentBundle.version}` };
  const record = (extra) => (req
    ? auditReq(req, 'action', 'Agent-Update', { ...entry, ...extra })
    : audit.add({ cat: 'action', action: 'Agent-Update', actor: 'System', ...entry, ...extra }));
  return agentRequest(id, 'update', {}, 60000).then(
    (r) => { record({}); return r; },
    (e) => { record({ ok: false, result: e.message }); throw e; },
  );
}

app.post('/api/update/agents', requireAdmin, wrap(async (req, res) => {
  const ids = [...conns.keys()].filter((id) => store.data.agents[id] && agentOutdated(store.data.agents[id]));
  const results = await Promise.allSettled(ids.map((id) => updateAgent(id, 'manuell', req)));
  res.json({ requested: ids.length, ok: results.filter((r) => r.status === 'fulfilled').length });
}));

// Adresse, unter der dieser Request den Server erreicht hat
function requestUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function installCommands(url, key) {
  return {
    url,
    linux: `curl -fsSL --connect-timeout 10 "${url}/install/linux.sh?key=${key}" | sudo bash`,
    windows: `[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm -TimeoutSec 15 "${url}/install/windows.ps1?key=${key}" | iex`,
  };
}

// Eigene Adresse im lokalen Netz (z.B. http://10.2.30.3:8095). Überschreibbar mit LAN_URL.
function lanUrl() {
  if (process.env.LAN_URL) return process.env.LAN_URL.replace(/\/+$/, '');
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // Container-Bridges und VPN-Tunnel (WireGuard, Tailscale ...) sind nicht das Heimnetz
    if (/^(docker|br-|veth|virbr|lo|wg|tun|tap|tailscale|zt|vEthernet)/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) candidates.push(a);
    }
  }
  // Echte Netzwerkkarten (mit MAC-Adresse) vor virtuellen Adaptern
  candidates.sort((a, b) => (a.mac === '00:00:00:00:00:00') - (b.mac === '00:00:00:00:00:00'));
  return candidates.length ? `http://${candidates[0].address}:${PORT}` : null;
}

// Clients im Heimnetz kommen oft nicht über die öffentliche Adresse herein (kein
// Hairpin-NAT im Router). Deshalb gibt es neben der öffentlichen Adresse immer
// auch die LAN-Adresse des Servers – und ggf. die Adresse, mit der die App verbunden ist.
// Installationsschlüssel stehen in den Install-Befehlen und damit oft in der Shell-Historie der
// Clients. Deshalb gilt jeder nur 24 Stunden; die App zeigt immer einen frischen an.
const ENROLL_TTL = 24 * 3600e3;
const newEnrollKey = () => ({ key: crypto.randomBytes(18).toString('base64url'), createdAt: Date.now() });
function currentEnrollKey() {
  const now = Date.now();
  store.data.enrollKeys = store.data.enrollKeys.filter((k) => now - k.createdAt < ENROLL_TTL);
  let k = store.data.enrollKeys.at(-1);
  if (!k || now - k.createdAt > 3600e3) {
    store.data.enrollKeys.push((k = newEnrollKey()));
    store.save();
  }
  return k;
}
const validEnrollKey = (key) => !!key && store.data.enrollKeys.some((k) => Date.now() - k.createdAt < ENROLL_TTL && safeEqual(key, k.key));

function enrollInfo(req) {
  const ek = currentEnrollKey();
  const key = ek.key;
  const host = (u) => u.replace(/^https?:\/\//, '');
  const primary = PUBLIC_URL || requestUrl(req);
  const candidates = [
    [primary, PUBLIC_URL ? `Von außen (${host(primary)})` : `Wie die App verbunden ist (${host(primary)})`],
    [lanUrl(), (u) => `Im Heimnetz (${host(u)})`],
    [requestUrl(req), (u) => `Direkt (${host(u)})`],
  ];
  const variants = [];
  for (const [url, label] of candidates) {
    if (!url || variants.some((v) => v.url === url)) continue;
    variants.push({ label: typeof label === 'function' ? label(url) : label, ...installCommands(url, key) });
  }
  if (variants.length === 1) variants[0].label = '';
  return { serverUrl: variants[0].url, key, keyExpires: ek.createdAt + ENROLL_TTL, linux: variants[0].linux, windows: variants[0].windows, variants };
}

app.get('/api/enroll', requireAdmin, (req, res) => res.json(enrollInfo(req)));

// ---- API-Zugänge -----------------------------------------------------------
const publicToken = (t) => ({ id: t.id, name: t.name, scopes: t.scopes, createdAt: t.createdAt, lastUsed: t.lastUsed || null });

app.get('/api/tokens', requireAdmin, (req, res) => res.json(store.data.apiTokens.map(publicToken)));

// Ein API-Zugang fragt seine eigenen Rechte ab (z.B. die Sprachsteuerung beim Start)
app.get('/api/token-info', (req, res) => {
  const t = apiTokenFor(bearer(req));
  if (!t) return res.status(401).json({ error: 'Kein gültiger API-Zugang' });
  res.json({ name: t.name, scopes: t.scopes });
});

app.post('/api/tokens', requireAdmin, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const scopes = [...new Set((req.body?.scopes || []).filter((s) => TOKEN_SCOPES.includes(s)))];
  if (!name) throw httpError(400, 'Name fehlt');
  if (!scopes.length) throw httpError(400, 'Mindestens ein Recht auswählen');
  const token = 'bzr_' + crypto.randomBytes(32).toString('base64url');
  const t = { id: crypto.randomUUID(), name, scopes, hash: sha256hex(token), createdAt: Date.now() };
  store.data.apiTokens.push(t);
  store.save();
  log(`[api] Zugang angelegt: ${name} (${scopes.join(', ')})`);
  auditReq(req, 'settings', 'API-Zugang angelegt', { target: name, detail: `Rechte: ${scopes.join(', ')}` });
  res.json({ ...publicToken(t), token }); // Klartext nur dieses eine Mal
}));

// Rechte eines bestehenden Zugangs ändern (der Schlüssel bleibt gleich)
app.patch('/api/tokens/:tid', requireAdmin, wrap(async (req, res) => {
  const t = store.data.apiTokens.find((x) => x.id === req.params.tid);
  if (!t) throw httpError(404, 'API-Zugang nicht gefunden');
  const scopes = [...new Set((req.body?.scopes || []).filter((s) => TOKEN_SCOPES.includes(s)))];
  if (!scopes.length) throw httpError(400, 'Mindestens ein Recht auswählen');
  const before = t.scopes.join(', ');
  t.scopes = scopes;
  store.save();
  log(`[api] Rechte geändert: ${t.name} (${scopes.join(', ')})`);
  auditReq(req, 'settings', 'API-Zugang geändert', { target: t.name, detail: `Rechte: ${before} → ${scopes.join(', ')}` });
  res.json(publicToken(t));
}));

app.delete('/api/tokens/:tid', requireAdmin, (req, res) => {
  const t = store.data.apiTokens.find((x) => x.id === req.params.tid);
  if (t) auditReq(req, 'settings', 'API-Zugang gelöscht', { target: t.name });
  store.data.apiTokens = store.data.apiTokens.filter((t) => t.id !== req.params.tid);
  store.save();
  res.json({ ok: true });
});

// Agents auf eine andere Server-Adresse umziehen. Jeder Agent probiert die Adressen
// der Reihe nach (öffentlich zuerst, dann Heimnetz) und wechselt nur, wenn dort
// dieser Server erreichbar ist.
const versionAtLeast = (v, min) => {
  const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};

app.post('/api/agents/migrate', requireAdmin, wrap(async (req, res) => {
  const urls = Array.isArray(req.body?.urls) && req.body.urls.length
    ? req.body.urls.map(String)
    : enrollInfo(req).variants.map((v) => v.url);
  const only = Array.isArray(req.body?.agentIds) ? new Set(req.body.agentIds) : null;
  const ids = [...conns.keys()].filter((id) => store.data.agents[id] && (!only || only.has(id)));
  log(`[migrate] ${ids.length} Agent(s) -> ${urls.join(' | ')}`);
  const results = await Promise.all(ids.map(async (id) => {
    const a = store.data.agents[id];
    const base = { id, hostname: a.name || a.info?.hostname || id, from: a.serverUrl || '' };
    if (!versionAtLeast(a.version, '1.2.0')) return { ...base, ok: false, error: 'Agent zu alt – zuerst aktualisieren' };
    try {
      const r = await agentRequest(id, 'setServer', { urls, serverId: store.data.serverId }, 45000);
      auditAgent(req, a, 'action', 'Server-Adresse umgezogen', { detail: r?.changed ? `${base.from || '?'} → ${r.url}` : `unverändert (${r?.note || r?.url || ''})` });
      return { ...base, ok: true, ...r };
    } catch (e) {
      auditAgent(req, a, 'action', 'Server-Adresse umgezogen', { detail: urls.join(' | '), ok: false, result: e.message });
      return { ...base, ok: false, error: e.message };
    }
  }));
  res.json({ urls, results });
}));

// ---- Netzwerkgeräte (OPNsense, Switches ...) über Abfrage-Clients -----------
const network = require('./network')({
  app, store, conns, agentRequest, broadcast, audit, auditReq, requireAdmin, wrap, httpError, log, agentLabel, versionAtLeast, tunnels, closeTunnel,
});

app.post('/api/enroll/rotate', requireAdmin, (req, res) => {
  store.data.enrollKeys = [newEnrollKey()]; // alle bisherigen Schlüssel sofort ungültig
  store.save();
  auditReq(req, 'settings', 'Installationsschlüssel erneuert');
  res.json(enrollInfo(req));
});

// ---- Öffentlich: Install-Skripte, Agent-Download, Enrollment -------------
function checkKey(req) {
  const key = String(req.query.key || req.body?.key || '');
  if (!validEnrollKey(key)) {
    audit.add({ cat: 'auth', action: 'Ungültiger Installationsschlüssel', actor: 'Installationsskript', ip: ipOf(req), detail: req.path, ok: false });
    throw httpError(403, 'Ungültiger Installationsschlüssel');
  }
}

// Der Agent verbindet sich später über genau die Adresse, über die das Skript geladen wurde.
function renderTemplate(name, req) {
  return fs.readFileSync(path.join(__dirname, 'templates', name), 'utf8')
    .replaceAll('__SERVER_URL__', requestUrl(req))
    .replaceAll('__ENROLL_KEY__', String(req.query.key)); // checkKey hat ihn geprüft
}

app.get('/install/linux.sh', wrap(async (req, res) => {
  checkKey(req);
  res.type('text/x-shellscript').send(renderTemplate('install-linux.sh', req));
}));

app.get('/install/windows.ps1', wrap(async (req, res) => {
  checkKey(req);
  res.type('text/plain').send(renderTemplate('install-windows.ps1', req));
}));

app.get('/agent/agent.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').sendFile(path.join(__dirname, 'agent', 'agent.js'));
});

app.post('/agent/enroll', wrap(async (req, res) => {
  checkKey(req);
  const { hostname, platform, machineId } = req.body || {};
  if (!hostname) throw httpError(400, 'hostname fehlt');
  // Neuinstallation auf derselben Maschine übernimmt den bestehenden Eintrag.
  let a = machineId && Object.values(store.data.agents).find((x) => x.machineId === machineId);
  // Läuft der bisherige Agent noch, wird der Eintrag nie übernommen – sonst könnte jemand mit
  // Installationsschlüssel und fremder Maschinen-ID einen Client "kapern" (z.B. Terminal-Eingaben abgreifen)
  if (a && conns.has(a.id)) a = null;
  const known = !!a;
  if (!a) {
    a = { id: crypto.randomUUID(), createdAt: Date.now(), tags: [], notes: '' };
    store.data.agents[a.id] = a;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  Object.assign(a, {
    hostname: String(hostname).slice(0, 120),
    platform: String(platform || ''),
    machineId: machineId ? String(machineId).slice(0, 100) : a.machineId,
    secretHash: sha256hex(secret),
    lastSeen: Date.now(),
  });
  store.flush();
  log(`[enroll] ${a.hostname} (${a.platform}) -> ${a.id}`);
  audit.add({ cat: 'connection', action: known ? 'Client neu installiert' : 'Client registriert', actor: 'Installationsskript', ip: ipOf(req), agentId: a.id, target: agentLabel(a), detail: a.platform });
  broadcastAgent(a.id);
  res.json({ id: a.id, secret });
}));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) log('[error]', err);
  res.status(status).json({ error: err.message || 'Serverfehler' });
});

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const wssAdmin = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const wssTunnel = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  let auth = null;
  if (url.pathname === '/ws/agent') {
    wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit('connection', ws, req));
  } else if (url.pathname === '/ws/tunnel') {
    wssTunnel.handleUpgrade(req, socket, head, (ws) => tunnelAgentSide(ws));
  } else if (['/ws/console', '/ws/stream', '/ws/admin'].includes(url.pathname) && (auth = wsAuth(url))) {
    if (url.pathname === '/ws/admin') {
      noteDevice(auth.session, url.searchParams.get('device'));
      wssAdmin.handleUpgrade(req, socket, head, (ws) => {
        ws.session = auth.session;
        ws.sessionKey = auth.key;
        wssAdmin.emit('connection', ws, req);
      });
      return;
    }
    const sid = url.searchParams.get('sid');
    if (tunnels.get(sid)?.adminWs !== null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    wssTunnel.handleUpgrade(req, socket, head, (ws) => tunnelAdminSide(ws, sid));
  } else {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

// Agent-Seite eines Tunnels: erste Nachricht ist die Anmeldung, danach nur Binärdaten
function keepAlive(ws) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
}

function tunnelAgentSide(ws) {
  keepAlive(ws);
  let sid = null;
  const timer = setTimeout(() => ws.close(4001, 'auth timeout'), 10000);
  ws.on('message', (data, isBinary) => {
    if (!sid) {
      let m;
      try { m = JSON.parse(data); } catch { return ws.close(4003, 'denied'); }
      const a = store.data.agents[m.id];
      const t = tunnels.get(m.sid);
      if (!a || !a.secretHash || !safeEqual(sha256hex(m.secret || ''), a.secretHash) || !t || t.hostId !== a.id || t.agentWs) return ws.close(4003, 'denied');
      clearTimeout(timer);
      sid = m.sid;
      t.agentWs = ws;
      for (const [d, b] of t.toAgent.splice(0)) ws.send(d, { binary: b });
      t.onAgent?.(ws);
      return;
    }
    const t = tunnels.get(sid);
    if (!t) return;
    if (t.sink) return t.sink(data, isBinary); // z.B. Datei-Download direkt in die HTTP-Antwort
    if (t.adminWs?.readyState === 1) t.adminWs.send(data, { binary: isBinary });
    else t.toAdmin.push([data, isBinary]);
  });
  ws.on('close', () => { clearTimeout(timer); if (sid) closeTunnel(sid, 'von der VM getrennt'); });
  ws.on('error', () => {});
}

function tunnelAdminSide(ws, sid) {
  keepAlive(ws);
  const t = tunnels.get(sid);
  if (!t || t.adminWs) return ws.close();
  clearTimeout(t.timer);
  t.adminWs = ws;
  t.connectedAt = Date.now();
  for (const [d, b] of t.toAdmin.splice(0)) ws.send(d, { binary: b });
  ws.on('message', (data, isBinary) => {
    if (t.agentWs?.readyState === 1) t.agentWs.send(data, { binary: isBinary });
    else t.toAgent.push([data, isBinary]);
  });
  ws.on('close', () => closeTunnel(sid, 'geschlossen'));
  ws.on('error', () => {});
}

// Wie Express' "trust proxy": Weitergeleitete Adressen nur von Proxys im eigenen Netz annehmen und
// von rechts lesen – der linke Teil von X-Forwarded-For kann vom Absender gefälscht sein.
const isProxyAddr = (ip) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i.test(ip);
function clientIp(req) {
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim().replace(/^::ffff:/, '')).filter(Boolean);
  if (!fwd.length || !isProxyAddr(remote)) return remote;
  for (let i = fwd.length - 1; i > 0; i--) if (!isProxyAddr(fwd[i])) return fwd[i];
  return fwd[0];
}

// Was ein Agent über sich meldet, wird gespeichert und an die App verteilt – Größe begrenzen
function bounded(v, maxChars) {
  try { return v && typeof v === 'object' && JSON.stringify(v).length <= maxChars ? v : undefined; } catch { return undefined; }
}

wssAgent.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let agentId = null;
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 15000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!agentId) {
      const a = msg.type === 'hello' && store.data.agents[msg.id];
      if (!a || !a.secretHash || !safeEqual(sha256hex(msg.secret || ''), a.secretHash)) {
        audit.add({ cat: 'connection', action: 'Agent abgewiesen', actor: 'Agent', ip: clientIp(req), agentId: a ? a.id : undefined, target: a ? agentLabel(a) : String(msg.id || '').slice(0, 64), detail: a ? 'Falsches Geheimnis' : 'Unbekannter oder entfernter Client', ok: false });
        sendJson(ws, { type: 'denied', reason: a ? 'secret' : 'unknown' });
        ws.close(4003, 'denied');
        return;
      }
      clearTimeout(authTimer);
      agentId = a.id;
      const old = conns.get(agentId);
      if (old) old.ws.close(4002, 'replaced');
      conns.set(agentId, { ws, pending: new Map() });
      Object.assign(a, {
        info: bounded(msg.info, 256e3) || a.info || {},
        version: String(msg.version || '').slice(0, 20),
        agentHash: String(msg.hash || '').slice(0, 64),
        serverUrl: String(msg.serverUrl || '').slice(0, 300),
        publicIp: clientIp(req),
        lastSeen: Date.now(),
      });
      store.save();
      sendJson(ws, { type: 'welcome' });
      if (store.data.settings.autoUpdateAgents && agentOutdated(a) && Date.now() - (a.lastAutoUpdate || 0) > 10 * 60e3) {
        const id = agentId;
        setTimeout(() => updateAgent(id, 'automatisch').catch((e) => log(`[update] Agent-Update fehlgeschlagen: ${e.message}`)), 3000);
      }
      log(`[agent] online: ${a.info?.hostname} (${clientIp(req)})`);
      audit.add({ cat: 'connection', action: 'Online', actor: 'Agent', ip: clientIp(req), agentId, target: agentLabel(a), detail: `Agent ${msg.version || '?'}` });
      broadcastAgent(agentId);
      network.agentChanged(agentId);
      network.agentOnline(agentId);
      return;
    }
    handleAgentMessage(agentId, msg);
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!agentId) return;
    const c = conns.get(agentId);
    if (!c || c.ws !== ws) return; // bereits durch neue Verbindung ersetzt
    conns.delete(agentId);
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.reject(httpError(409, 'Verbindung zum Client getrennt'));
    }
    for (const [sid, s] of shells) {
      if (s.agentId === agentId) {
        sendJson(s.adminWs, { type: 'shell.exit', sid, code: null });
        endShell(sid, 'Verbindung zum Client getrennt');
      }
    }
    for (const [sid, t] of tunnels) if (t.hostId === agentId) closeTunnel(sid, 'Proxmox-Host getrennt');
    const a = store.data.agents[agentId];
    if (a) {
      a.lastSeen = Date.now();
      store.save();
      log(`[agent] offline: ${a.info?.hostname}`);
      audit.add({ cat: 'connection', action: 'Offline', actor: 'Agent', ip: clientIp(req), agentId, target: agentLabel(a) });
      broadcastAgent(agentId);
      network.agentChanged(agentId);
    }
  });
});

function handleAgentMessage(agentId, msg) {
  const a = store.data.agents[agentId];
  if (!a) return;
  switch (msg.type) {
    case 'metrics': {
      if (!bounded(msg.metrics, 64e3) || typeof msg.metrics.cpu !== 'number') return;
      const l = liveOf(agentId);
      l.metrics = msg.metrics;
      const memPct = msg.metrics.mem?.total ? (100 * msg.metrics.mem.used) / msg.metrics.mem.total : 0;
      l.history.push([Date.now(), Math.round(msg.metrics.cpu * 10) / 10, Math.round(memPct * 10) / 10]);
      if (l.history.length > HISTORY_POINTS) l.history.splice(0, l.history.length - HISTORY_POINTS);
      a.lastSeen = Date.now();
      broadcast({ type: 'metrics', id: agentId, metrics: msg.metrics, alerts: computeAlerts(a, true, msg.metrics) });
      break;
    }
    case 'info':
      if (!bounded(msg.info, 256e3)) return;
      a.info = msg.info;
      store.save();
      broadcastAgent(agentId);
      break;
    case 'result': {
      const c = conns.get(agentId);
      const p = c?.pending.get(msg.reqId);
      if (!p) return;
      c.pending.delete(msg.reqId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(httpError(502, msg.error || 'Fehler auf dem Client'));
      break;
    }
    case 'shell.out':
    case 'shell.exit': {
      const s = shells.get(msg.sid);
      if (!s || s.agentId !== agentId) return;
      sendJson(s.adminWs, msg);
      if (msg.type === 'shell.exit') endShell(msg.sid, msg.code != null ? `beendet (Code ${msg.code})` : 'beendet');
      break;
    }
  }
}

// Terminal-Sitzungen protokollieren (nur Öffnen/Schließen – Eingaben nicht, darin können Passwörter stehen)
function endShell(sid, reason) {
  const s = shells.get(sid);
  if (!s) return;
  shells.delete(sid);
  if (!s.openedAt) return;
  const secs = Math.round((Date.now() - s.openedAt) / 1000);
  const dur = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
  audit.add({ cat: 'shell', action: `${s.label} geschlossen`, actor: s.actor, ip: s.ip, agentId: s.who.agentId, target: s.who.target, detail: `${reason}, Dauer ${dur}` });
}

wssAdmin.on('connection', (ws, req) => {
  const wsActor = ws.session?.device ? `Admin (${ws.session.device})` : 'Admin';
  const wsIp = clientIp(req);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  admins.add(ws);
  sendJson(ws, { type: 'hello', agents: Object.values(store.data.agents).map((a) => summarize(a, true)), settings: store.data.settings, folders: store.data.folders, net: network.list() });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = shells.get(msg.sid);
    switch (msg.type) {
      case 'shell.open': {
        if (!msg.sid || shells.has(msg.sid)) return;
        const a = store.data.agents[msg.agentId];
        const lxc = msg.lxc != null ? Number(msg.lxc) : null;
        // Container-Konsole: läuft auf dem Proxmox-Host (pct enter), protokolliert beim Container
        const who = lxc != null && a ? guestAudit(a, lxc, 'lxc', msg.name) : { agentId: msg.agentId, target: agentLabel(a) || msg.agentId };
        const label = lxc != null ? 'Container-Konsole' : 'Terminal';
        shells.set(msg.sid, { adminWs: ws, agentId: msg.agentId, actor: wsActor, ip: wsIp, label, who });
        try {
          const r = await agentRequest(msg.agentId, 'shell.open', { sid: msg.sid, cols: msg.cols, rows: msg.rows, ...(lxc != null ? { lxc } : {}) });
          sendJson(ws, { type: 'shell.opened', sid: msg.sid, mode: r.mode, shell: r.shell });
          log(`[shell] geöffnet auf ${a?.info?.hostname}${lxc != null ? ` (Container ${lxc})` : ''}`);
          const s = shells.get(msg.sid);
          if (s) s.openedAt = Date.now();
          audit.add({ cat: 'shell', action: `${label} geöffnet`, actor: wsActor, ip: wsIp, ...who, detail: lxc != null ? who.detail : r.shell });
        } catch (e) {
          shells.delete(msg.sid);
          sendJson(ws, { type: 'shell.error', sid: msg.sid, error: e.message });
          audit.add({ cat: 'shell', action: `${label} geöffnet`, actor: wsActor, ip: wsIp, ...who, ok: false, result: e.message });
        }
        break;
      }
      case 'shell.in':
      case 'shell.close':
        if (!s || s.adminWs !== ws) return;
        sendJson(conns.get(s.agentId)?.ws, msg);
        if (msg.type === 'shell.close') endShell(msg.sid, 'geschlossen');
        break;
    }
  });

  ws.on('close', () => {
    admins.delete(ws);
    for (const [sid, s] of shells) {
      if (s.adminWs === ws) {
        sendJson(conns.get(s.agentId)?.ws, { type: 'shell.close', sid });
        endShell(sid, 'App getrennt');
      }
    }
  });
});

// Tote Verbindungen erkennen; das JSON-Ping lässt den Agent seinerseits Ausfälle bemerken.
setInterval(() => {
  for (const wss of [wssAgent, wssAdmin, wssTunnel]) {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
  for (const c of conns.values()) sendJson(c.ws, { type: 'ping' });
  for (const ws of admins) if (ws.sessionKey && !sessionByKey(ws.sessionKey)) ws.close(4001, 'Sitzung abgelaufen');
  // Fehlversuche beim Anmelden nicht ewig im Speicher halten
  const since = Date.now() - 10 * 60e3;
  for (const [ip, list] of loginFails) if (!list.some((t) => t > since)) loginFails.delete(ip);
}, 30000);

// lastSeen regelmäßig sichern
setInterval(() => store.save(), 60000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  log(`[bolzo-rmm] Server läuft auf http://${HOST}:${PORT}  (Daten: ${DATA_DIR})`);
  audit.add({ cat: 'system', action: 'Server gestartet', actor: 'System', detail: `Version ${SERVER_VERSION.commit}${SERVER_VERSION.message ? ` – ${SERVER_VERSION.message}` : ''}` });
});
