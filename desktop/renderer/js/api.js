// Verbindung zum RMM-Server: REST-Aufrufe, Live-WebSocket und Client-Zustand.

const LS = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
export { LS };

const SPARK_POINTS = 60;

class Api extends EventTarget {
  constructor() {
    super();
    this.server = LS.get('server', '');
    this.token = LS.get('token', '');
    this.agents = new Map();
    this.settings = { thresholds: { cpu: 90, mem: 90, disk: 90 } };
    this.connected = false;
    this.ws = null;
    this._retry = null;
  }

  get loggedIn() { return !!(this.server && this.token); }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  async request(method, path, body) {
    let res;
    try {
      res = await fetch(this.server + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Server nicht erreichbar');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') {
      this.logout(false);
      throw new Error('Sitzung abgelaufen – bitte neu anmelden');
    }
    if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
    return data;
  }
  get(p) { return this.request('GET', p); }
  post(p, b = {}) { return this.request('POST', p, b); }
  put(p, b) { return this.request('PUT', p, b); }
  patch(p, b) { return this.request('PATCH', p, b); }
  del(p) { return this.request('DELETE', p); }

  async login(server, password) {
    server = server.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(server)) server = 'http://' + server;
    this.server = server;
    const { token } = await this.request('POST', '/api/login', { password });
    this.token = token;
    LS.set('server', server);
    LS.set('token', token);
  }

  logout(callServer = true) {
    if (callServer && this.token) this.post('/api/logout').catch(() => {});
    this.token = '';
    LS.del('token');
    this.disconnect();
    this.agents.clear();
    this.emit('logout');
  }

  // ---------- Live-Verbindung ----------
  connect() {
    this.disconnect();
    const url = this.server.replace(/^http/, 'ws') + '/ws/admin?token=' + encodeURIComponent(this.token);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.emit('conn', true);
    };
    ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.emit('conn', false);
      this._retry = setTimeout(async () => {
        // Prüfen, ob die Sitzung noch gültig ist, bevor neu verbunden wird
        try { await this.get('/api/settings'); } catch {}
        if (this.token) this.connect();
      }, 3000);
    };
  }

  disconnect() {
    clearTimeout(this._retry);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.connected = false;
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'hello':
        this.agents.clear();
        for (const a of msg.agents) this.agents.set(a.id, a);
        this.settings = msg.settings;
        this.emit('agents');
        break;
      case 'agent': {
        const prev = this.agents.get(msg.agent.id);
        this.agents.set(msg.agent.id, { ...msg.agent, spark: prev?.spark || [] });
        this.emit('agents');
        this.emit('agent', { agent: msg.agent, prev });
        break;
      }
      case 'agent.removed':
        this.agents.delete(msg.id);
        this.emit('agents');
        break;
      case 'metrics': {
        const a = this.agents.get(msg.id);
        if (!a) return;
        a.metrics = msg.metrics;
        a.alerts = msg.alerts;
        a.lastSeen = Date.now();
        const memPct = msg.metrics.mem?.total ? (100 * msg.metrics.mem.used) / msg.metrics.mem.total : 0;
        a.spark = [...(a.spark || []), [Date.now(), msg.metrics.cpu, memPct]].slice(-SPARK_POINTS);
        this.emit('metrics', { id: msg.id, metrics: msg.metrics });
        this.emit('agents');
        break;
      }
      case 'history':
        this.emit('history');
        break;
      default:
        if (msg.type?.startsWith('shell.')) this.emit('shell', msg);
    }
  }

  // ---------- Komfortfunktionen ----------
  action(id, action, params) { return this.post(`/api/agents/${id}/action`, { action, params }); }
}

export const api = new Api();
