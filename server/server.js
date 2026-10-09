'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const dgram = require('dgram');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');

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
    publicIp: a.publicIp || '',
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
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function validSession(token) {
  if (!token) return false;
  const s = store.data.sessions[sha256hex(token)];
  return !!s && s.expires > Date.now();
}

function requireAdmin(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!validSession(token)) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true, agents: Object.keys(store.data.agents).length, online: conns.size }));

// ---- Login ----------------------------------------------------------------
const loginFails = new Map(); // ip -> [timestamps]
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip;
  const recent = (loginFails.get(ip) || []).filter((t) => t > Date.now() - 10 * 60e3);
  if (recent.length >= 5) return res.status(429).json({ error: 'Zu viele Fehlversuche – bitte 10 Minuten warten' });
  const { password } = req.body || {};
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    recent.push(Date.now());
    loginFails.set(ip, recent);
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const [k, s] of Object.entries(store.data.sessions)) if (s.expires < now) delete store.data.sessions[k];
  store.data.sessions[sha256hex(token)] = { created: now, expires: now + SESSION_DAYS * 864e5 };
  store.save();
  res.json({ token });
}));

app.post('/api/logout', requireAdmin, (req, res) => {
  const token = req.get('authorization').replace(/^Bearer\s+/i, '');
  delete store.data.sessions[sha256hex(token)];
  store.save();
  res.json({ ok: true });
});

// ---- Clients --------------------------------------------------------------
app.get('/api/agents', requireAdmin, (req, res) => {
  res.json(Object.values(store.data.agents).map((a) => summarize(a, true)));
});

function getAgent(req) {
  const a = store.data.agents[req.params.id];
  if (!a) throw httpError(404, 'Client nicht gefunden');
  return a;
}

app.get('/api/agents/:id', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  res.json({ ...summarize(a), history: live.get(a.id)?.history || [] });
}));

app.patch('/api/agents/:id', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const { name, tags, notes } = req.body || {};
  if (typeof name === 'string') a.name = name.trim().slice(0, 80) || undefined;
  if (Array.isArray(tags)) a.tags = [...new Set(tags.map((t) => String(t).trim().slice(0, 32)).filter(Boolean))].slice(0, 20);
  if (typeof notes === 'string') a.notes = notes.slice(0, 20000);
  store.save();
  broadcastAgent(a.id);
  res.json(summarize(a));
}));

app.delete('/api/agents/:id', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const c = conns.get(a.id);
  delete store.data.agents[a.id];
  live.delete(a.id);
  store.save();
  if (c) {
    sendJson(c.ws, { type: 'revoked' });
    c.ws.close(4003, 'revoked');
  }
  broadcast({ type: 'agent.removed', id: a.id });
  res.json({ ok: true });
}));

const ACTIONS = new Set(['processes', 'kill', 'services', 'service', 'reboot', 'shutdown', 'update', 'uninstall', 'info']);
app.post('/api/agents/:id/action', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const { action, params } = req.body || {};
  if (!ACTIONS.has(action)) throw httpError(400, 'Unbekannte Aktion');
  log(`[action] ${action} -> ${a.info?.hostname || a.id}`);
  const result = await agentRequest(a.id, action, params || {}, action === 'services' || action === 'processes' ? 45000 : 30000);
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
app.post('/api/agents/:id/wake', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
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
      return res.json({ ok: true, via: other.name || other.info.hostname });
    }
  }
  await sendMagicPacket(macs);
  res.json({ ok: true, via: 'Server' });
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

app.get('/api/scripts', requireAdmin, (req, res) => res.json(store.data.scripts));

app.post('/api/scripts', requireAdmin, wrap(async (req, res) => {
  const s = { id: crypto.randomUUID(), ...validateScript(req.body || {}), createdAt: Date.now() };
  store.data.scripts.push(s);
  store.save();
  res.json(s);
}));

app.put('/api/scripts/:sid', requireAdmin, wrap(async (req, res) => {
  const s = store.data.scripts.find((x) => x.id === req.params.sid);
  if (!s) throw httpError(404, 'Skript nicht gefunden');
  Object.assign(s, validateScript(req.body || {}), { updatedAt: Date.now() });
  store.save();
  res.json(s);
}));

app.delete('/api/scripts/:sid', requireAdmin, (req, res) => {
  store.data.scripts = store.data.scripts.filter((x) => x.id !== req.params.sid);
  store.save();
  res.json({ ok: true });
});

async function runOn(agentId, script) {
  const a = store.data.agents[agentId];
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    agentId,
    hostname: a ? a.name || a.info?.hostname : agentId,
    scriptName: script.name || 'Ad-hoc',
    shell: script.shell,
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
  return entry;
}

// Ad-hoc-Befehl/Skript auf einem Client
app.post('/api/agents/:id/run', requireAdmin, wrap(async (req, res) => {
  const a = getAgent(req);
  const s = validateScript({ name: 'Ad-hoc', ...req.body });
  log(`[run] ${s.name} (${s.shell}) -> ${a.info?.hostname}`);
  res.json(await runOn(a.id, s));
}));

// Bibliotheks-Skript auf mehreren Clients parallel
app.post('/api/scripts/:sid/run', requireAdmin, wrap(async (req, res) => {
  const s = store.data.scripts.find((x) => x.id === req.params.sid);
  if (!s) throw httpError(404, 'Skript nicht gefunden');
  const ids = Array.isArray(req.body?.agentIds) ? req.body.agentIds : [];
  if (!ids.length) throw httpError(400, 'Keine Clients ausgewählt');
  log(`[run] ${s.name} -> ${ids.length} Client(s)`);
  res.json(await Promise.all(ids.map((id) => runOn(id, s))));
}));

app.get('/api/history', requireAdmin, (req, res) => {
  let h = store.data.history;
  if (req.query.agentId) h = h.filter((x) => x.agentId === req.query.agentId);
  res.json(h.slice(0, 200));
});

app.delete('/api/history', requireAdmin, (req, res) => {
  store.data.history = [];
  store.save();
  res.json({ ok: true });
});

// ---- Einstellungen & Enrollment ------------------------------------------
app.get('/api/settings', requireAdmin, (req, res) => res.json(store.data.settings));

app.put('/api/settings', requireAdmin, wrap(async (req, res) => {
  const t = req.body?.thresholds || {};
  for (const k of ['cpu', 'mem', 'disk']) {
    const v = Number(t[k]);
    if (v >= 10 && v <= 100) store.data.settings.thresholds[k] = v;
  }
  store.save();
  for (const id of Object.keys(store.data.agents)) broadcastAgent(id);
  res.json(store.data.settings);
}));

function enrollInfo(req) {
  const url = baseUrl(req);
  const key = store.data.enrollKey;
  return {
    serverUrl: url,
    key,
    linux: `curl -fsSL "${url}/install/linux.sh?key=${key}" | sudo bash`,
    windows: `[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm "${url}/install/windows.ps1?key=${key}" | iex`,
  };
}

app.get('/api/enroll', requireAdmin, (req, res) => res.json(enrollInfo(req)));

app.post('/api/enroll/rotate', requireAdmin, (req, res) => {
  store.data.enrollKey = crypto.randomBytes(18).toString('base64url');
  store.save();
  res.json(enrollInfo(req));
});

// ---- Öffentlich: Install-Skripte, Agent-Download, Enrollment -------------
function checkKey(req) {
  const key = String(req.query.key || req.body?.key || '');
  if (!key || !safeEqual(key, store.data.enrollKey)) throw httpError(403, 'Ungültiger Installationsschlüssel');
}

function renderTemplate(name, req) {
  return fs.readFileSync(path.join(__dirname, 'templates', name), 'utf8')
    .replaceAll('__SERVER_URL__', baseUrl(req))
    .replaceAll('__ENROLL_KEY__', store.data.enrollKey);
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

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/agent') {
    wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit('connection', ws, req));
  } else if (url.pathname === '/ws/admin' && validSession(url.searchParams.get('token'))) {
    wssAdmin.handleUpgrade(req, socket, head, (ws) => wssAdmin.emit('connection', ws, req));
  } else {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
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
        sendJson(ws, { type: 'denied', reason: a ? 'secret' : 'unknown' });
        ws.close(4003, 'denied');
        return;
      }
      clearTimeout(authTimer);
      agentId = a.id;
      const old = conns.get(agentId);
      if (old) old.ws.close(4002, 'replaced');
      conns.set(agentId, { ws, pending: new Map() });
      Object.assign(a, { info: msg.info, version: msg.version, publicIp: clientIp(req), lastSeen: Date.now() });
      store.save();
      sendJson(ws, { type: 'welcome' });
      log(`[agent] online: ${a.info?.hostname} (${clientIp(req)})`);
      broadcastAgent(agentId);
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
        shells.delete(sid);
      }
    }
    const a = store.data.agents[agentId];
    if (a) {
      a.lastSeen = Date.now();
      store.save();
      log(`[agent] offline: ${a.info?.hostname}`);
      broadcastAgent(agentId);
    }
  });
});

function handleAgentMessage(agentId, msg) {
  const a = store.data.agents[agentId];
  if (!a) return;
  switch (msg.type) {
    case 'metrics': {
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
      if (msg.type === 'shell.exit') shells.delete(msg.sid);
      break;
    }
  }
}

wssAdmin.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  admins.add(ws);
  sendJson(ws, { type: 'hello', agents: Object.values(store.data.agents).map((a) => summarize(a, true)), settings: store.data.settings });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = shells.get(msg.sid);
    switch (msg.type) {
      case 'shell.open': {
        if (!msg.sid || shells.has(msg.sid)) return;
        shells.set(msg.sid, { adminWs: ws, agentId: msg.agentId });
        try {
          const r = await agentRequest(msg.agentId, 'shell.open', { sid: msg.sid, cols: msg.cols, rows: msg.rows });
          sendJson(ws, { type: 'shell.opened', sid: msg.sid, mode: r.mode, shell: r.shell });
          log(`[shell] geöffnet auf ${store.data.agents[msg.agentId]?.info?.hostname}`);
        } catch (e) {
          shells.delete(msg.sid);
          sendJson(ws, { type: 'shell.error', sid: msg.sid, error: e.message });
        }
        break;
      }
      case 'shell.in':
      case 'shell.close':
        if (!s || s.adminWs !== ws) return;
        sendJson(conns.get(s.agentId)?.ws, msg);
        if (msg.type === 'shell.close') shells.delete(msg.sid);
        break;
    }
  });

  ws.on('close', () => {
    admins.delete(ws);
    for (const [sid, s] of shells) {
      if (s.adminWs === ws) {
        sendJson(conns.get(s.agentId)?.ws, { type: 'shell.close', sid });
        shells.delete(sid);
      }
    }
  });
});

// Tote Verbindungen erkennen; das JSON-Ping lässt den Agent seinerseits Ausfälle bemerken.
setInterval(() => {
  for (const wss of [wssAgent, wssAdmin]) {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
  for (const c of conns.values()) sendJson(c.ws, { type: 'ping' });
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
});
