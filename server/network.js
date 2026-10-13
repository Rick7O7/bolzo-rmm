'use strict';
// Netzwerkgeräte: OPNsense-Firewalls, Switches und sonstige Geräte (Drucker, Access Points ...).
// Der Server spricht sie nie selbst an. Ein "Abfrage-Client" – ein BOLZO-Agent im Netz der Geräte,
// z.B. ein kleiner LXC-Container – führt Ping, SNMP und OPNsense-API-Aufrufe aus. Zugangsdaten liegen
// nur hier auf dem Server und gehen mit jeder einzelnen Anfrage an den Abfrage-Client.
const crypto = require('crypto');

const KINDS = { opnsense: 'OPNsense', switch: 'Switch', device: 'Gerät' };
const POLL_MS = 30000;
const PROBE_MIN_VERSION = '1.7.0';
const LAT_POINTS = 120; // Antwortzeiten der letzten Stunde (alle 30 s)

// ---- SNMP ----------------------------------------------------------------------
const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0', sysObjectID: '1.3.6.1.2.1.1.2.0', sysUpTime: '1.3.6.1.2.1.1.3.0', sysContact: '1.3.6.1.2.1.1.4.0', sysName: '1.3.6.1.2.1.1.5.0', sysLocation: '1.3.6.1.2.1.1.6.0',
  ifDescr: '1.3.6.1.2.1.2.2.1.2', ifType: '1.3.6.1.2.1.2.2.1.3', ifSpeed: '1.3.6.1.2.1.2.2.1.5', ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7', ifOperStatus: '1.3.6.1.2.1.2.2.1.8', ifLastChange: '1.3.6.1.2.1.2.2.1.9',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10', ifInErrors: '1.3.6.1.2.1.2.2.1.14', ifOutOctets: '1.3.6.1.2.1.2.2.1.16', ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  ifName: '1.3.6.1.2.1.31.1.1.1.1', ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6', ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10', ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15', ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  basePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  dot1dTpFdbPort: '1.3.6.1.2.1.17.4.3.1.2',
  dot1qTpFdbPort: '1.3.6.1.2.1.17.7.1.2.2.1.2',
  dot1qVlanStaticName: '1.3.6.1.2.1.17.7.1.4.3.1.1', dot1qVlanStaticEgressPorts: '1.3.6.1.2.1.17.7.1.4.3.1.2', dot1qVlanStaticUntaggedPorts: '1.3.6.1.2.1.17.7.1.4.3.1.4',
  dot1qPvid: '1.3.6.1.2.1.17.7.1.4.5.1.1',
  pethPsePortAdminEnable: '1.3.6.1.2.1.105.1.1.1.3', pethPsePortDetectionStatus: '1.3.6.1.2.1.105.1.1.1.6',
  pethMainPsePower: '1.3.6.1.2.1.105.1.3.1.1.2', pethMainPseOperStatus: '1.3.6.1.2.1.105.1.3.1.1.3', pethMainPseConsumptionPower: '1.3.6.1.2.1.105.1.3.1.1.4',
  lldpRemChassisId: '1.0.8802.1.1.2.1.4.1.1.5', lldpRemPortId: '1.0.8802.1.1.2.1.4.1.1.7', lldpRemPortDesc: '1.0.8802.1.1.2.1.4.1.1.8', lldpRemSysName: '1.0.8802.1.1.2.1.4.1.1.9',
  entPhysicalClass: '1.3.6.1.2.1.47.1.1.1.1.5', entPhysicalSoftwareRev: '1.3.6.1.2.1.47.1.1.1.1.10', entPhysicalSerialNum: '1.3.6.1.2.1.47.1.1.1.1.11', entPhysicalModelName: '1.3.6.1.2.1.47.1.1.1.1.13',
};
const IF_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };
const POE_STATUS = { 1: 'disabled', 2: 'searching', 3: 'delivering', 4: 'fault', 5: 'test', 6: 'otherFault' };
// Physische Ports: ethernetCsmacd, fastEther, fastEtherFX, gigabitEthernet
const PHYS_TYPES = new Set([6, 62, 69, 117]);
// Spalten der Port-Tabelle, die sich ständig ändern (Zähler, Zustand) – für die schnelle Aktualisierung
const LIVE_COLS = ['ifAdminStatus', 'ifOperStatus', 'ifInOctets', 'ifOutOctets', 'ifInErrors', 'ifOutErrors'];
const LIVE_COLS_V2 = ['ifHCInOctets', 'ifHCOutOctets'];

const hexBuf = (h) => Buffer.from(typeof h === 'string' ? h : '', 'hex');
const hexText = (h) => hexBuf(h).toString('utf8').replace(/\0+$/, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
const fmtMac = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
const hexMac = (h) => (h && h.length === 12 ? fmtMac(hexBuf(h)) : '');
// LLDP-IDs sind entweder Text (Port "igb1") oder 6 Bytes MAC
const lldpId = (h) => (h && h.length === 12 && /[^\x20-\x7e]/.test(hexBuf(h).toString('latin1')) ? hexMac(h) : hexText(h));
// PortList: Bitmaske, höchstes Bit des ersten Bytes = Port 1
function portList(hex) {
  const out = [];
  const b = hexBuf(hex);
  for (let i = 0; i < b.length; i++) for (let j = 0; j < 8; j++) if (b[i] & (0x80 >> j)) out.push(i * 8 + j + 1);
  return out;
}
const normMac = (m) => String(m || '').toLowerCase().replace(/-/g, ':');

module.exports = function setupNetwork(ctx) {
  const { app, store, conns, agentRequest, broadcast, audit, auditReq, requireAdmin, wrap, httpError, log, agentLabel, versionAtLeast, tunnels, closeTunnel } = ctx;
  store.data.netDevices ??= [];
  const devices = () => store.data.netDevices;
  const rts = new Map(); // id -> Laufzeitzustand (nicht gespeichert)
  const rtOf = (id) => {
    if (!rts.has(id)) rts.set(id, { state: 'unknown', lat: [], fails: 0 });
    return rts.get(id);
  };

  // ---------- Abfrage-Client ----------
  function probeOf(d) {
    const a = store.data.agents[d.probeId];
    if (!a) throw httpError(409, 'Kein Abfrage-Client zugeordnet – in den Einstellungen des Geräts einen wählen');
    if (!conns.has(a.id)) throw httpError(409, `Abfrage-Client ${agentLabel(a)} ist offline`);
    if (!versionAtLeast(a.version, PROBE_MIN_VERSION)) throw httpError(409, `Abfrage-Client ${agentLabel(a)} braucht Agent ${PROBE_MIN_VERSION} oder neuer – Agent aktualisieren`);
    return a;
  }

  async function snmp(d, ops, timeout = 30000, write = false) {
    const a = probeOf(d);
    if (!d.snmp) throw httpError(400, 'SNMP ist für dieses Gerät nicht eingerichtet');
    if (write && !d.snmp.writeCommunity) throw httpError(400, 'Für Änderungen fehlt die Schreib-Community (Einstellungen des Geräts)');
    const cfg = { host: d.host, port: d.snmp.port || 161, version: d.snmp.version, community: write ? d.snmp.writeCommunity : d.snmp.community };
    return agentRequest(a.id, 'net.snmp', { snmp: cfg, ops }, timeout);
  }

  // OPNsense-API: merkt sich beim ersten Kontakt den Fingerabdruck des (meist selbst signierten) Zertifikats
  async function opn(d, calls, timeout = 30000) {
    const a = probeOf(d);
    const r = await agentRequest(a.id, 'net.opn', { opn: { url: d.opn.url, key: d.opn.key, secret: d.opn.secret, pin: d.opn.pin || null }, calls }, timeout);
    if (r.cert) {
      const c = { subject: r.cert.subject, issuer: r.cert.issuer, validTo: r.cert.validTo, trusted: !!r.cert.trusted, fingerprint: r.cert.fingerprint };
      if (!d.opn.pin && !c.trusted && c.fingerprint && r.results.some((x) => x.ok)) {
        d.opn.pin = c.fingerprint;
        store.save();
      }
      if (JSON.stringify(c) !== JSON.stringify(d.opn.cert)) { d.opn.cert = c; store.save(); }
    }
    if (r.results[0]?.code === 'CERT_CHANGED') {
      const e = httpError(502, r.results[0].error);
      e.code = 'CERT_CHANGED';
      throw e;
    }
    if (authFailed(r.results[0])) Object.assign(rtOf(d.id), { authFailAt: Date.now(), authError: why(r.results[0]) });
    return r.results;
  }
  const okData = (x) => (x?.ok && x.status >= 200 && x.status < 300 && x.data != null ? x.data : null);
  const why = (x) => (!x ? 'keine Antwort'
    : !x.ok ? x.error
    : x.status === 401 || x.status === 403 ? 'API-Zugang abgelehnt – Key/Secret und Rechte des API-Benutzers prüfen'
    : x.status === 404 ? 'gibt es auf dieser Version nicht'
    : x.data == null ? `keine gültige Antwort (HTTP ${x.status})` : `HTTP ${x.status}`);
  const authFailed = (x) => x?.ok && (x.status === 401 || x.status === 403);

  // ---------- Gerät für die App (ohne Zugangsdaten) ----------
  function publicDevice(d) {
    const rt = rtOf(d.id);
    const probe = store.data.agents[d.probeId];
    const up = rt.state === 'online' || rt.state === 'warning';
    return {
      id: d.id, kind: d.kind, name: d.name, host: d.host, webUrl: d.webUrl || defaultWebUrl(d), notes: d.notes || '', createdAt: d.createdAt,
      probeId: d.probeId || null, probeName: probe ? agentLabel(probe) : '', probeOnline: !!probe && conns.has(probe.id),
      opn: d.opn ? { url: d.opn.url, keySet: !!d.opn.key, pinned: !!d.opn.pin, cert: d.opn.cert || null } : null,
      snmp: d.snmp ? { version: d.snmp.version, port: d.snmp.port || 161, write: !!d.snmp.writeCommunity } : null,
      state: rt.state, since: rt.since || null, checkedAt: rt.checkedAt || null, error: rt.error || '', ms: rt.ms ?? null,
      lastSeen: up ? Date.now() : d.lastSeen || null,
      info: rt.info || d.lastInfo || null,
      alerts: rt.alerts || [],
    };
  }
  const broadcastDevice = (d) => broadcast({ type: 'net', device: publicDevice(d) });
  function defaultWebUrl(d) {
    if (d.kind === 'opnsense' && d.opn?.url) return d.opn.url;
    return `http://${d.host.includes(':') ? `[${d.host}]` : d.host}`;
  }

  // ---------- Regelmäßige Prüfung ----------
  const parseUptime = (s) => {
    const m = String(s || '').match(/(?:(\d+)\s*days?,?\s*)?(\d+):(\d+)(?::(\d+))?/);
    return m ? (Number(m[1] || 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] || 0)) : null;
  };
  function parseCpu(act) {
    const line = (act?.headers || []).find((h) => /^CPU:/.test(String(h)));
    const idle = line && String(line).match(/([\d.]+)%\s*idle/);
    return idle ? Math.max(0, Math.min(100, Math.round((100 - Number(idle[1])) * 10) / 10)) : null;
  }
  const parseGateways = (g) => (g?.items || []).map((x) => ({
    name: x.name, address: x.address || '', monitor: x.monitor || '', status: x.status, text: x.status_translated || x.status,
    ok: x.status === 'none' || x.status === 'online', loss: x.loss || '', delay: x.delay || '',
  }));
  function parseFirmware(s) {
    if (!s) return null;
    const pkgs = ['upgrade_packages', 'new_packages', 'reinstall_packages'].reduce((n, k) => n + (Array.isArray(s[k]) ? s[k].length : 0), 0);
    const count = Number(s.updates) || pkgs;
    return {
      status: s.status || '', message: s.status_msg || '', updates: s.status === 'update' || s.status === 'upgrade' ? count || 1 : 0,
      major: s.status === 'upgrade' ? s.upgrade_major_version || true : false,
      current: s.product_version || s.product?.product_version || '', latest: s.product_latest || s.product?.product_latest || '',
      needsReboot: s.needs_reboot === '1' || s.needs_reboot === true, lastCheck: s.last_check || '',
      packages: (s.upgrade_packages || []).slice(0, 300).map((p) => ({ name: p.name, from: p.current_version, to: p.new_version, repo: p.repository })),
    };
  }

  // Nach abgelehntem API-Zugang 10 Minuten Pause: OPNsense sperrt Adressen mit vielen Fehlversuchen
  // sonst aus ("Login protection") – dann käme auch der korrigierte Schlüssel eine Weile nicht durch.
  const AUTH_PAUSE = 10 * 60e3;
  async function checkOpn(d, rt) {
    if (rt.authFailAt && Date.now() - rt.authFailAt < AUTH_PAUSE) {
      const min = Math.ceil((AUTH_PAUSE - (Date.now() - rt.authFailAt)) / 60e3);
      return { reachable: true, error: `${rt.authError} – nächster Versuch in ${min} Min (oder sofort nach Ändern des Zugangs)` };
    }
    const calls = [
      { path: '/api/diagnostics/system/systemResources' },
      { path: '/api/diagnostics/system/systemTime' },
      { path: '/api/routes/gateway/status' },
      { path: '/api/diagnostics/activity/getActivity' },
    ];
    const needInfo = !rt.sysInfo || Date.now() - rt.sysInfoAt > 30 * 60e3;
    const needFw = Date.now() - (rt.fwAt || 0) > 6 * 3600e3;
    if (needInfo) calls.push({ path: '/api/diagnostics/system/systemInformation' });
    if (needFw) calls.push({ path: '/api/core/firmware/status' });
    const r = await opn(d, calls, 40000);
    if (!r.some((x) => okData(x))) {
      if (authFailed(r[0])) {
        rt.authFailAt = Date.now();
        rt.authError = why(r[0]);
        return { reachable: true, error: rt.authError };
      }
      return { reachable: false, error: r[0]?.error || why(r[0]) };
    }
    rt.authFailAt = 0;
    const [res, time, gw, act] = r.map(okData);
    let i = 4;
    if (needInfo) {
      const si = okData(r[i++]);
      if (si) { rt.sysInfo = si; rt.sysInfoAt = Date.now(); }
    }
    if (needFw) {
      const fw = okData(r[i++]);
      if (fw) { rt.fw = parseFirmware(fw); rt.fwAt = Date.now(); }
    }
    const gateways = parseGateways(gw);
    const mem = res?.memory ? { total: Number(res.memory.total) || 0, used: Number(res.memory.used) || 0 } : null;
    const info = {
      version: String(rt.sysInfo?.versions?.[0] || '').replace(/-amd64$|-aarch64$/, ''),
      hostname: rt.sysInfo?.name || '',
      cpu: parseCpu(act), mem, uptime: parseUptime(time?.uptime), load: time?.loadavg || '',
      gateways: gateways.map((g) => ({ name: g.name, ok: g.ok, text: g.text, delay: g.delay, loss: g.loss })),
      updates: rt.fw?.updates || 0, fwMajor: rt.fw?.major || false,
    };
    const alerts = gateways.filter((g) => !g.ok).map((g) => ({ kind: 'gateway', level: 'warning', label: `Gateway ${g.name}: ${g.text}` }));
    if (info.updates) alerts.push({ kind: 'updates', level: 'info', label: `${info.updates} Update${info.updates === 1 ? '' : 's'} verfügbar` });
    return { reachable: true, ok: true, info, alerts };
  }

  async function checkSnmp(d) {
    const r = await snmp(d, [
      { op: 'get', oids: [OID.sysDescr, OID.sysUpTime, OID.sysName, OID.sysLocation] },
      { op: 'walk', oid: OID.ifType, max: 1000 },
      { op: 'walk', oid: OID.ifOperStatus, max: 1000 },
    ], 30000);
    const sys = r.results[0];
    if (!sys?.ok) return { reachable: false, error: sys?.error || 'Keine Antwort per SNMP' };
    const v = Object.fromEntries(sys.data.map(([oid, t, val]) => [oid, val]));
    const types = new Map((r.results[1]?.data || []).map(([idx, , val]) => [idx, val]));
    const oper = r.results[2]?.data || [];
    const phys = oper.filter(([idx]) => PHYS_TYPES.has(types.get(idx)));
    const descr = hexText(v[OID.sysDescr]);
    return {
      reachable: true, ok: true,
      info: {
        sysName: hexText(v[OID.sysName]), descr, model: descr.split(/,|\s+revision\s+/i)[0].slice(0, 80),
        location: hexText(v[OID.sysLocation]), uptime: v[OID.sysUpTime] != null ? Math.floor(v[OID.sysUpTime] / 100) : null,
        ports: { up: phys.filter(([, , s]) => s === 1).length, total: phys.length },
        strip: phys.slice(0, 64).map(([, , s]) => (s === 1 ? 1 : 0)), // für die Port-Leiste auf der Kachel
      },
      alerts: [],
    };
  }

  async function ping(d) {
    try { return await agentRequest(d.probeId, 'net.ping', { host: d.host, count: 1 }, 15000); } catch { return { alive: false, ms: null }; }
  }

  async function pollDevice(d) {
    const rt = rtOf(d.id);
    if (rt.polling) return;
    rt.polling = true;
    const before = { state: rt.state, alerts: JSON.stringify((rt.alerts || []).filter((a) => a.kind === 'gateway')) };
    try {
      try {
        probeOf(d);
      } catch (e) {
        Object.assign(rt, { state: 'unknown', error: e.message, checkedAt: Date.now() });
        return;
      }
      const [res, p] = await Promise.all([
        (d.kind === 'opnsense' ? checkOpn(d, rt) : d.snmp ? checkSnmp(d) : Promise.resolve(null)).catch((e) => ({ reachable: false, error: e.message, certChanged: e.code === 'CERT_CHANGED' })),
        ping(d),
      ]);
      const ms = p?.alive ? p.ms : null;
      rt.lat.push([Date.now(), ms]);
      if (rt.lat.length > LAT_POINTS) rt.lat.splice(0, rt.lat.length - LAT_POINTS);
      rt.checkedAt = Date.now();
      rt.ms = ms;
      let state;
      let error = '';
      if (!res) state = p?.alive ? 'online' : 'offline'; // nur Ping
      else if (res.ok) state = (res.alerts || []).some((a) => a.level === 'warning' || a.level === 'critical') ? 'warning' : 'online';
      else if (res.reachable || p?.alive || res.certChanged) { state = 'warning'; error = res.error; }
      else { state = 'offline'; error = res.error || 'Keine Antwort'; }
      if (!res && !p?.alive) error = 'Antwortet nicht auf Ping';
      // Ein einzelner Aussetzer macht ein Gerät noch nicht "offline"
      if (state === 'offline' && (rt.state === 'online' || rt.state === 'warning') && ++rt.fails < 2) { rt.error = error; return; }
      if (state !== 'offline') rt.fails = 0;
      if (res?.ok) {
        rt.info = res.info;
        d.lastInfo = res.info;
      }
      rt.alerts = res?.ok ? res.alerts : [];
      rt.error = error;
      if (state !== rt.state) rt.since = Date.now();
      rt.state = state;
      if (state === 'online' || state === 'warning') d.lastSeen = Date.now();
    } finally {
      rt.polling = false;
      const now = { state: rt.state, alerts: JSON.stringify((rt.alerts || []).filter((a) => a.kind === 'gateway')) };
      const wasUp = before.state === 'online' || before.state === 'warning';
      const isUp = now.state === 'online' || now.state === 'warning';
      if (before.state !== 'unknown' && wasUp !== isUp && now.state !== 'unknown') {
        audit.add({ cat: 'connection', action: isUp ? 'Online' : 'Offline', actor: 'Abfrage-Client', agentId: d.id, target: d.name, detail: isUp ? KINDS[d.kind] : rt.error || KINDS[d.kind] });
      } else if (wasUp && isUp && before.alerts !== now.alerts) {
        const down = JSON.parse(now.alerts).map((a) => a.label);
        audit.add({ cat: 'network', action: down.length ? 'Gateway gestört' : 'Gateways wieder in Ordnung', actor: 'Abfrage-Client', agentId: d.id, target: d.name, detail: down.join(', ') || undefined, ok: !down.length });
      }
      if (devices().includes(d)) broadcastDevice(d);
    }
  }

  const pollAll = () => { for (const d of devices()) pollDevice(d).catch((e) => log('[net] Prüfung fehlgeschlagen:', e.message)); };
  setTimeout(pollAll, 5000);
  setInterval(pollAll, POLL_MS);

  // ---------- Prüfen und Speichern ----------
  const getDev = (req) => {
    const d = devices().find((x) => x.id === req.params.id);
    if (!d) throw httpError(404, 'Gerät nicht gefunden');
    return d;
  };
  function cleanHost(v) {
    const s = String(v || '').trim();
    if (!/^[a-zA-Z0-9.:_-]{1,253}$/.test(s) || s.startsWith('-')) throw httpError(400, 'Adresse: IP-Adresse oder Hostname angeben');
    return s;
  }
  function cleanUrl(v, what, { pathAllowed = true } = {}) {
    const s = String(v || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    let u;
    try { u = new URL(s); } catch { throw httpError(400, `${what}: ungültige Adresse`); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw httpError(400, `${what}: nur http:// oder https:// ohne Zugangsdaten`);
    if (!pathAllowed && (u.pathname !== '/' || u.search || u.hash)) throw httpError(400, `${what}: nur Adresse und ggf. Port, ohne Pfad`);
    return pathAllowed ? s : u.origin;
  }
  const str = (v, max) => String(v ?? '').trim().slice(0, max);

  // Übernimmt die Felder aus der App; leere Zugangsdaten = bisherige behalten
  function applyBody(d, b, { create }) {
    if (create) {
      if (!KINDS[b.kind]) throw httpError(400, 'Unbekannte Geräteart');
      d.kind = b.kind;
    }
    if (create || b.name !== undefined) d.name = str(b.name, 80) || (create ? '' : d.name);
    if (create || b.host !== undefined) d.host = cleanHost(b.host);
    if (!d.name) d.name = d.host;
    if (create || b.probeId !== undefined) {
      const a = store.data.agents[b.probeId];
      if (!a) throw httpError(400, 'Bitte einen Abfrage-Client wählen');
      if (!a.probe) throw httpError(400, `${agentLabel(a)} ist nicht als Abfrage-Client freigegeben`);
      d.probeId = a.id;
    }
    if (b.webUrl !== undefined) d.webUrl = cleanUrl(b.webUrl, 'Weboberfläche') || undefined;
    if (b.notes !== undefined) d.notes = String(b.notes || '').slice(0, 20000) || undefined;
    if (d.kind === 'opnsense' && (create || b.opn)) {
      const o = b.opn || {};
      const prev = d.opn || {};
      const url = o.url !== undefined ? cleanUrl(o.url, 'API-Adresse', { pathAllowed: false }) : prev.url;
      d.opn = {
        url: url || `https://${d.host.includes(':') ? `[${d.host}]` : d.host}`,
        key: str(o.key, 200) || prev.key || '',
        secret: str(o.secret, 200) || prev.secret || '',
        // Neue Adresse oder ausdrücklich "neu vertrauen": Zertifikat beim nächsten Kontakt neu merken
        pin: o.trust || (url && url !== prev.url) ? null : prev.pin || null,
        cert: o.trust || (url && url !== prev.url) ? null : prev.cert || null,
      };
      if (!d.opn.key || !d.opn.secret) throw httpError(400, 'API-Key und API-Secret der OPNsense angeben');
    }
    if (d.kind !== 'opnsense' && (create || b.snmp !== undefined)) {
      const s = b.snmp;
      if (!s || s.enabled === false) d.snmp = undefined;
      else {
        const prev = d.snmp || {};
        const port = Number(s.port) || 161;
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'SNMP-Port: 1 bis 65535');
        d.snmp = {
          version: s.version === '1' ? '1' : '2c',
          community: s.community !== undefined && s.community !== '' ? str(s.community, 100) : prev.community || 'public',
          writeCommunity: s.writeCommunity === null ? '' : s.writeCommunity !== undefined && s.writeCommunity !== '' ? str(s.writeCommunity, 100) : prev.writeCommunity || '',
          port,
        };
      }
    }
  }

  // Verbindung testen, bevor gespeichert wird (auch mit gespeicherten Zugangsdaten eines bestehenden Geräts)
  app.post('/api/net/test', requireAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const saved = b.id ? devices().find((x) => x.id === b.id) : null;
    const d = saved ? JSON.parse(JSON.stringify(saved)) : { id: 'test' };
    applyBody(d, b, { create: !saved });
    probeOf(d);
    const p = await ping(d);
    if (d.kind === 'opnsense') {
      const r = await opn(d, [{ path: '/api/diagnostics/system/systemInformation' }, { path: '/api/core/firmware/status' }], 30000);
      const si = okData(r[0]);
      if (!si) throw httpError(502, `OPNsense: ${why(r[0])}`);
      const fw = okData(r[1]);
      return res.json({ ok: true, ping: p, cert: d.opn.cert || null, text: `${si.name || 'OPNsense'} · ${String(si.versions?.[0] || fw?.product_version || '').replace(/-amd64$/, '')}` });
    }
    if (d.snmp) {
      const r = await snmp(d, [{ op: 'get', oids: [OID.sysName, OID.sysDescr, OID.sysUpTime] }], 20000);
      const x = r.results[0];
      if (!x?.ok) throw httpError(502, x?.error || 'Keine Antwort per SNMP');
      const v = Object.fromEntries(x.data.map(([oid, t, val]) => [oid, val]));
      let canWrite = null;
      if (d.snmp.writeCommunity) {
        // Schreibrecht prüfen, ohne etwas zu ändern: sysName auf denselben Wert setzen
        const w = await snmp(d, [{ op: 'set', varbinds: [{ oid: OID.sysName, type: 'hex', value: v[OID.sysName] || '' }] }], 20000, true).catch((e) => ({ results: [{ ok: false, error: e.message }] }));
        canWrite = !!w.results[0]?.ok;
      }
      return res.json({ ok: true, ping: p, canWrite, text: [hexText(v[OID.sysName]), hexText(v[OID.sysDescr]).slice(0, 120)].filter(Boolean).join(' · ') });
    }
    if (!p.alive) throw httpError(502, `${d.host} antwortet nicht`);
    res.json({ ok: true, ping: p, text: `Antwortet in ${p.ms} ms` });
  }));

  app.get('/api/net', requireAdmin, (req, res) => res.json(devices().map(publicDevice)));

  app.post('/api/net', requireAdmin, wrap(async (req, res) => {
    const d = { id: crypto.randomUUID(), createdAt: Date.now() };
    applyBody(d, req.body || {}, { create: true });
    devices().push(d);
    store.save();
    auditReq(req, 'network', 'Gerät hinzugefügt', { agentId: d.id, target: d.name, detail: `${KINDS[d.kind]} · ${d.host}` });
    broadcastDevice(d);
    pollDevice(d).catch(() => {});
    res.json(publicDevice(d));
  }));

  // Was sich geändert hat – fürs Protokoll (Zugangsdaten nur als "geändert", nie im Klartext)
  const snapshot = (x) => ({
    Name: x.name, Adresse: x.host, 'Abfrage-Client': x.probeId, Weboberfläche: x.webUrl || '', Notizen: x.notes || '',
    'API-Zugang': x.opn ? `${x.opn.url}|${x.opn.key}|${x.opn.secret}` : '', Zertifikat: x.opn?.pin || '', SNMP: JSON.stringify(x.snmp || null),
  });

  app.patch('/api/net/:id', requireAdmin, wrap(async (req, res) => {
    const d = getDev(req);
    const before = snapshot(d);
    applyBody(d, req.body || {}, { create: false });
    store.save();
    const after = snapshot(d);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    if (changed.length) {
      auditReq(req, 'network', req.body?.opn?.trust ? 'Zertifikat neu vertraut' : 'Gerät geändert', { agentId: d.id, target: d.name, detail: before.Name !== after.Name ? `${before.Name} → ${after.Name}` : changed.join(', ') });
    }
    broadcastDevice(d);
    if (req.body?.host !== undefined || req.body?.opn || req.body?.snmp || req.body?.probeId) {
      rtOf(d.id).authFailAt = 0; // neuer Zugang: gleich wieder versuchen
      pollDevice(d).catch(() => {});
    }
    res.json(publicDevice(d));
  }));

  app.delete('/api/net/:id', requireAdmin, (req, res) => {
    const d = devices().find((x) => x.id === req.params.id);
    if (d) {
      store.data.netDevices = devices().filter((x) => x !== d);
      rts.delete(d.id);
      store.save();
      auditReq(req, 'network', 'Gerät entfernt', { agentId: d.id, target: d.name, detail: `${KINDS[d.kind]} · ${d.host}` });
      broadcast({ type: 'net.removed', id: d.id });
    }
    res.json({ ok: true });
  });

  // Antwortzeiten der letzten Stunde
  app.get('/api/net/:id/latency', requireAdmin, (req, res) => res.json(rtOf(getDev(req).id).lat));

  // ---------- Bekannte Geräte im Netz: MAC -> Name/IP ----------
  // Aus BOLZO-Clients und aus den DHCP-/ARP-Daten der OPNsense (wird ab und zu im Hintergrund aufgefrischt)
  async function knownMacs({ fresh = false } = {}) {
    const map = new Map();
    for (const fw of devices().filter((x) => x.kind === 'opnsense')) {
      const rt = rtOf(fw.id);
      if (fresh || !rt.leases || Date.now() - rt.leases.at > 5 * 60e3) {
        await Promise.race([loadLeases(fw).catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
      }
      for (const l of rt.leases?.rows || []) if (l.mac && !map.has(l.mac)) map.set(l.mac, { name: l.hostname || '', ip: l.ip, vendor: l.vendor || '', source: fw.name });
    }
    for (const a of Object.values(store.data.agents)) {
      for (const i of a.info?.interfaces || []) {
        const mac = normMac(i.mac);
        if (!mac || mac === '00:00:00:00:00:00') continue;
        map.set(mac, { ...(map.get(mac) || {}), name: agentLabel(a), ip: i.ip || map.get(mac)?.ip || '', agentId: a.id });
      }
    }
    return map;
  }
  // Wo hängt welche MAC? Aus der letzten Port-Abfrage der Switches
  function switchPortOf(mac) {
    for (const sw of devices()) {
      const hit = rtOf(sw.id).fdb?.map.get(mac);
      if (hit) return { deviceId: sw.id, device: sw.name, port: hit };
    }
    return null;
  }

  // ---------- Switch: Port-Tabelle ----------
  const colMap = (rows) => new Map((rows || []).map(([idx, , v]) => [idx, v]));
  const idxToMac = (parts) => parts.map((n) => Number(n).toString(16).padStart(2, '0')).join(':');
  // MAC-Tabelle: Q-BRIDGE (Index VLAN.MAC) oder ältere Bridge-MIB (Index MAC) -> [{ mac, vlan, bp }]
  function parseFdb(qbridge, bridge) {
    const out = [];
    for (const [key, bp] of qbridge || []) {
      const parts = key.split('.');
      if (Number(bp)) out.push({ mac: idxToMac(parts.slice(1, 7)), vlan: Number(parts[0]), bp: Number(bp) });
    }
    for (const [key, bp] of bridge || []) if (Number(bp)) out.push({ mac: idxToMac(key.split('.')), vlan: null, bp: Number(bp) });
    return out; // Port 0 = der Switch selbst, ausgelassen
  }
  // Ports mit vielen Adressen oder LLDP-Nachbar führen zu weiteren Switches/Routern
  const UPLINK_MACS = 6;

  // Nur die MAC-Tabelle (schnell) – für die Spalte "Switch-Port" in der Geräteliste der OPNsense
  async function refreshFdb(sw) {
    const r = await snmp(sw, [
      { op: 'walk', oid: OID.ifName, max: 3000 },
      { op: 'walk', oid: OID.basePortIfIndex, max: 3000 },
      { op: 'walk', oid: OID.dot1qTpFdbPort, max: 16000 },
    ], 60000);
    if (!r.results[0]?.ok) return;
    const names = colMap(r.results[0].data);
    const bpIf = colMap(r.results[1]?.ok ? r.results[1].data : []);
    const q = r.results[2]?.ok ? r.results[2].data : [];
    let b = [];
    if (!q.length) {
      const r2 = await snmp(sw, [{ op: 'walk', oid: OID.dot1dTpFdbPort, max: 16000 }], 60000);
      b = r2.results[0]?.ok ? r2.results[0].data : [];
    }
    const entries = parseFdb(colMap(q), colMap(b));
    const perPort = new Map();
    for (const e of entries) {
      const idx = Number(bpIf.get(String(e.bp)) ?? e.bp);
      if (!perPort.has(idx)) perPort.set(idx, []);
      perPort.get(idx).push(e.mac);
    }
    const map = new Map();
    for (const [idx, macs] of perPort) {
      if (macs.length >= UPLINK_MACS) continue;
      const name = hexText(names.get(String(idx))) || String(idx);
      for (const mac of macs) map.set(mac, name);
    }
    rtOf(sw.id).fdb = { at: Date.now(), map };
  }

  async function switchPorts(d, { live = false } = {}) {
    const v2 = d.snmp.version !== '1';
    const cols = live
      ? [...LIVE_COLS, ...(v2 ? LIVE_COLS_V2 : [])]
      : ['ifDescr', 'ifType', 'ifSpeed', 'ifPhysAddress', 'ifLastChange', ...LIVE_COLS, 'ifName', 'ifAlias', 'ifHighSpeed', ...(v2 ? LIVE_COLS_V2 : []),
        'basePortIfIndex', 'dot1qPvid', 'dot1qVlanStaticName', 'dot1qVlanStaticEgressPorts', 'dot1qVlanStaticUntaggedPorts', 'dot1qTpFdbPort',
        'pethPsePortAdminEnable', 'pethPsePortDetectionStatus', 'pethMainPsePower', 'pethMainPseOperStatus', 'pethMainPseConsumptionPower',
        'lldpRemSysName', 'lldpRemPortId', 'lldpRemPortDesc', 'lldpRemChassisId'];
    const ops = [{ op: 'get', oids: [OID.sysUpTime] }, ...cols.map((k) => ({ op: 'walk', oid: OID[k], max: k === 'dot1qTpFdbPort' ? 16000 : 3000 }))];
    let r = await snmp(d, ops, 120000);
    if (!r.results[0]?.ok) throw httpError(502, r.results[0]?.error || 'Keine Antwort per SNMP');
    const c = {};
    cols.forEach((k, i) => { c[k] = colMap(r.results[i + 1]?.ok ? r.results[i + 1].data : []); });
    // Ältere Switches ohne Q-BRIDGE: MAC-Tabelle aus der einfachen Bridge-MIB
    if (!live && !c.dot1qTpFdbPort.size) {
      r = await snmp(d, [{ op: 'walk', oid: OID.dot1dTpFdbPort, max: 16000 }], 60000);
      c.dot1dTpFdbPort = colMap(r.results[0]?.ok ? r.results[0].data : []);
    }
    const rt = rtOf(d.id);
    const now = Date.now();

    // Raten aus der Differenz zur letzten Abfrage (32-Bit-Zähler laufen über)
    const prev = rt.counters;
    const counters = new Map();
    const rateOf = (idx, key, cur, hc) => {
      const p = prev?.map.get(idx);
      if (!p || cur == null || p[key] == null) return null;
      const dt = (now - prev.ts) / 1000;
      if (dt < 1) return null;
      let diff = cur - p[key];
      if (diff < 0 && !hc) diff += 2 ** 32;
      return diff >= 0 ? diff / dt : null;
    };
    const ifIdx = [...new Set([...(c.ifType || c.ifOperStatus).keys()])].sort((a, b) => Number(a) - Number(b));
    const live1 = ifIdx.map((idx) => {
      const hc = c.ifHCInOctets?.has(idx);
      const rx = hc ? c.ifHCInOctets.get(idx) : c.ifInOctets.get(idx);
      const tx = hc ? c.ifHCOutOctets.get(idx) : c.ifOutOctets.get(idx);
      counters.set(idx, { rx, tx });
      return {
        ifIndex: Number(idx), admin: IF_STATUS[c.ifAdminStatus.get(idx)] || 'unknown', oper: IF_STATUS[c.ifOperStatus.get(idx)] || 'unknown',
        rx: rateOf(idx, 'rx', rx, hc), tx: rateOf(idx, 'tx', tx, hc), rxTotal: rx ?? null, txTotal: tx ?? null,
        inErr: c.ifInErrors.get(idx) ?? null, outErr: c.ifOutErrors.get(idx) ?? null,
      };
    });
    rt.counters = { ts: now, map: counters };
    if (live) return { ts: now, live: true, ports: live1 };

    // Bridge-Port -> ifIndex (meist identisch)
    const bpIf = new Map([...c.basePortIfIndex].map(([bp, idx]) => [Number(bp), Number(idx)]));
    const ifOfBp = (bp) => bpIf.get(Number(bp)) ?? Number(bp);
    const known = await knownMacs();
    const probe = store.data.agents[d.probeId];
    const probeMacs = new Set((probe?.info?.interfaces || []).map((i) => normMac(i.mac)));

    // VLANs
    const vlans = [...new Set([...c.dot1qVlanStaticName.keys(), ...c.dot1qVlanStaticEgressPorts.keys()])].map(Number).sort((a, b) => a - b).map((vid) => ({
      vid, name: hexText(c.dot1qVlanStaticName.get(String(vid))),
      egress: portList(c.dot1qVlanStaticEgressPorts.get(String(vid))).map(ifOfBp),
      untagged: portList(c.dot1qVlanStaticUntaggedPorts.get(String(vid))).map(ifOfBp),
    }));
    const pvidOf = new Map([...c.dot1qPvid].map(([bp, vid]) => [ifOfBp(bp), Number(vid)]));

    // MAC-Tabelle
    const fdb = new Map(); // ifIndex -> [{ mac, vlan }]
    const fdbMap = new Map(); // mac -> Portname (für die Geräteliste der OPNsense)
    for (const e of parseFdb(c.dot1qTpFdbPort, c.dot1dTpFdbPort)) {
      const idx = ifOfBp(e.bp);
      if (!fdb.has(idx)) fdb.set(idx, []);
      fdb.get(idx).push({ mac: e.mac, vlan: e.vlan });
    }

    // PoE (Index Gruppe.Port; Port = Bridge-Port bzw. ifIndex bei den meisten Herstellern)
    const poe = new Map();
    for (const [key, adm] of c.pethPsePortAdminEnable) {
      const [group, port] = key.split('.').map(Number);
      poe.set(group === 1 ? ifOfBp(port) : `${group}.${port}`, { group, port, enabled: adm === 1, status: POE_STATUS[c.pethPsePortDetectionStatus.get(key)] || 'unknown' });
    }
    const main = [...c.pethMainPsePower.keys()][0];
    const poeMain = main != null ? { power: c.pethMainPsePower.get(main), used: c.pethMainPseConsumptionPower.get(main) ?? null, on: c.pethMainPseOperStatus.get(main) === 1 } : null;

    // LLDP-Nachbarn (Index Zeitmarke.lokalerPort.Nummer)
    const lldp = new Map();
    for (const [key, name] of c.lldpRemSysName) {
      const [, local] = key.split('.').map(Number);
      const idx = ifOfBp(local);
      if (!lldp.has(idx)) lldp.set(idx, []);
      lldp.get(idx).push({ name: hexText(name), port: lldpId(c.lldpRemPortId.get(key)), portDesc: hexText(c.lldpRemPortDesc.get(key)), chassis: lldpId(c.lldpRemChassisId.get(key)) });
    }

    const ports = live1.map((p) => {
      const idx = String(p.ifIndex);
      const type = Number(c.ifType.get(idx));
      const name = hexText(c.ifName.get(idx)) || hexText(c.ifDescr.get(idx)) || `Port ${idx}`;
      const macs = (fdb.get(p.ifIndex) || []).map((m) => ({ ...m, ...(known.get(m.mac) || {}), probe: probeMacs.has(m.mac) }));
      const uplink = (lldp.get(p.ifIndex) || []).length > 0 || macs.length >= UPLINK_MACS;
      if (!uplink) for (const m of macs) fdbMap.set(m.mac, name);
      const vl = vlans.filter((v) => v.egress.includes(p.ifIndex));
      const speed = Number(c.ifHighSpeed.get(idx)) || Math.round((Number(c.ifSpeed.get(idx)) || 0) / 1e6);
      return {
        ...p, name, descr: hexText(c.ifDescr.get(idx)), alias: hexText(c.ifAlias.get(idx)), type, phys: PHYS_TYPES.has(type),
        speed, mac: hexMac(c.ifPhysAddress.get(idx)), lastChange: c.ifLastChange.get(idx) ?? null,
        pvid: pvidOf.get(p.ifIndex) ?? null,
        untagged: vl.filter((v) => v.untagged.includes(p.ifIndex)).map((v) => v.vid),
        tagged: vl.filter((v) => !v.untagged.includes(p.ifIndex)).map((v) => v.vid),
        poe: poe.get(p.ifIndex) || null, lldp: lldp.get(p.ifIndex) || [], macs: macs.slice(0, 200), macCount: macs.length,
        probe: macs.some((m) => m.probe), uplink,
      };
    });
    rt.fdb = { at: now, map: fdbMap };
    return {
      ts: now, uptime: r.results[0].data[0]?.[2] != null ? Math.floor(r.results[0].data[0][2] / 100) : null,
      ports, vlans: vlans.map((v) => ({ vid: v.vid, name: v.name, ports: v.egress.length })), poe: poeMain, write: !!d.snmp.writeCommunity,
    };
  }

  async function switchInfo(d) {
    const r = await snmp(d, [
      { op: 'get', oids: [OID.sysDescr, OID.sysObjectID, OID.sysUpTime, OID.sysContact, OID.sysName, OID.sysLocation] },
      { op: 'walk', oid: OID.entPhysicalClass, max: 200 },
      { op: 'walk', oid: OID.entPhysicalModelName, max: 200 },
      { op: 'walk', oid: OID.entPhysicalSerialNum, max: 200 },
      { op: 'walk', oid: OID.entPhysicalSoftwareRev, max: 200 },
    ], 40000);
    const x = r.results[0];
    if (!x?.ok) throw httpError(502, x?.error || 'Keine Antwort per SNMP');
    const v = Object.fromEntries(x.data.map(([oid, t, val]) => [oid, val]));
    // Gehäuse (Klasse 3 = chassis) liefert Modell, Seriennummer und Firmware
    const cls = colMap(r.results[1]?.data);
    const pick = (i) => colMap(r.results[i]?.data);
    const [model, serial, sw] = [pick(2), pick(3), pick(4)];
    const chassis = [...cls].find(([, k]) => k === 3)?.[0] ?? [...model.keys()][0];
    return {
      descr: hexText(v[OID.sysDescr]), objectId: v[OID.sysObjectID] || '', uptime: v[OID.sysUpTime] != null ? Math.floor(v[OID.sysUpTime] / 100) : null,
      contact: hexText(v[OID.sysContact]), name: hexText(v[OID.sysName]), location: hexText(v[OID.sysLocation]),
      model: chassis != null ? hexText(model.get(chassis)) : '', serial: chassis != null ? hexText(serial.get(chassis)) : '', firmware: chassis != null ? hexText(sw.get(chassis)) : '',
    };
  }

  function portName(d, ifIndex) {
    const p = rtOf(d.id).lastPorts?.find((x) => x.ifIndex === ifIndex);
    return p ? `Port ${p.name}${p.alias ? ` (${p.alias})` : ''}` : `Port ${ifIndex}`;
  }
  const ifIndexOf = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 2 ** 31) throw httpError(400, 'Ungültiger Port');
    return n;
  };

  // ---------- OPNsense ----------
  async function loadLeases(d) {
    const r = await opn(d, [
      { path: '/api/dhcpv4/leases/searchLease' },
      { path: '/api/kea/leases4/search' },
      { path: '/api/dnsmasq/leases/search' },
      { path: '/api/diagnostics/interface/getArp' },
    ], 40000);
    const [isc, kea, dnsmasq, arp] = r.map(okData);
    const rows = new Map();
    const put = (mac, patch) => {
      mac = normMac(mac);
      if (!mac) return;
      const cur = rows.get(mac) || { mac };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== '' && cur[k] == null) cur[k] = v;
      rows.set(mac, cur);
    };
    for (const l of isc?.rows || []) {
      put(l.mac, { ip: l.address, hostname: l.hostname || l['client-hostname'], iface: l.if_descr || l.if, lease: l.type === 'static' ? 'static' : 'dhcp', expires: l.ends || '', vendor: l.man, state: l.state, descr: l.descr });
    }
    for (const l of [...(kea?.rows || []), ...(dnsmasq?.rows || [])]) {
      const exp = Number(l.expire);
      put(l.hwaddr, { ip: l.address, hostname: l.hostname, iface: l.if_descr || l.if, lease: l.is_reserved === '1' || l.is_reserved === true ? 'static' : 'dhcp', expires: exp ? new Date(exp * 1000).toISOString() : '' });
    }
    const arpRows = Array.isArray(arp) ? arp : arp?.rows || [];
    for (const a of arpRows) {
      const mac = normMac(a.mac);
      if (!mac || /incomplete/i.test(mac)) continue;
      put(mac, { ip: a.ip, hostname: a.hostname, iface: a.intf_description || a.intf, vendor: a.manufacturer });
      rows.get(mac).online = true;
    }
    const list = [...rows.values()];
    rtOf(d.id).leases = { at: Date.now(), rows: list };
    return {
      rows: list,
      sources: { isc: !!isc, kea: !!kea, dnsmasq: !!dnsmasq, arp: !!arp },
      errors: !isc && !kea && !dnsmasq ? { dhcp: why(r[0]) } : {},
    };
  }

  async function opnOverview(d) {
    const r = await opn(d, [
      { path: '/api/diagnostics/system/systemInformation' },
      { path: '/api/diagnostics/system/systemResources' },
      { path: '/api/diagnostics/system/systemTime' },
      { path: '/api/diagnostics/system/systemDisk' },
      { path: '/api/diagnostics/activity/getActivity' },
      { path: '/api/routes/gateway/status' },
      { path: '/api/interfaces/overview/interfacesInfo' },
      { path: '/api/diagnostics/traffic/interface' },
      { path: '/api/diagnostics/system/systemTemperature' },
      { path: '/api/core/firmware/status' },
    ], 45000);
    const [si, res, time, disk, act, gw, ifs, traffic, temp, fw] = r.map(okData);
    if (!si && !res && !gw) throw httpError(502, `OPNsense: ${why(r[0])}`);
    const rt = rtOf(d.id);
    if (si) { rt.sysInfo = si; rt.sysInfoAt = Date.now(); }
    if (fw) { rt.fw = parseFirmware(fw); rt.fwAt = Date.now(); }
    // Durchsatz je Schnittstelle aus zwei Zählerständen
    const now = Date.now();
    const tr = {};
    for (const [key, x] of Object.entries(traffic?.interfaces || {})) {
      const rx = Number(x['bytes received']);
      const tx = Number(x['bytes transmitted']);
      const p = rt.traffic?.map[key];
      const dt = rt.traffic ? (now - rt.traffic.ts) / 1000 : 0;
      tr[key] = { device: x.device, name: x.name, rxTotal: rx, txTotal: tx, rx: p && dt >= 1 && rx >= p.rx ? (rx - p.rx) / dt : null, tx: p && dt >= 1 && tx >= p.tx ? (tx - p.tx) / dt : null };
    }
    if (traffic) rt.traffic = { ts: now, map: Object.fromEntries(Object.entries(tr).map(([k, v]) => [k, { rx: v.rxTotal, tx: v.txTotal }])) };
    const rowsIf = (ifs?.rows || []).filter((x) => x.identifier || x.description);
    const interfaces = rowsIf.length
      ? rowsIf.map((x) => {
        const t = tr[x.identifier] || Object.values(tr).find((v) => v.device === x.device) || {};
        const v4 = x.addr4 || (Array.isArray(x.ipv4) ? x.ipv4.map((a) => a.ipaddr).filter(Boolean).join(', ') : '');
        return {
          id: x.identifier || x.device, name: x.description || x.identifier || x.device, device: x.device, status: x.status || '', enabled: x.enabled !== false,
          ipv4: v4 || '', ipv6: x.addr6 || '', mac: x.macaddr || '', media: x.media || '', vlan: x.vlan_tag || null, linkType: x.link_type || '',
          rx: t.rx ?? null, tx: t.tx ?? null, rxTotal: t.rxTotal ?? null, txTotal: t.txTotal ?? null,
        };
      })
      : Object.entries(tr).map(([k, t]) => ({ id: k, name: t.name || k, device: t.device, status: '', enabled: true, ipv4: '', ipv6: '', mac: '', media: '', rx: t.rx, tx: t.tx, rxTotal: t.rxTotal, txTotal: t.txTotal }));
    return {
      ts: now,
      system: {
        name: si?.name || '', version: String(si?.versions?.[0] || '').replace(/-amd64$|-aarch64$/, ''), os: si?.versions?.[1] || '',
        cpu: parseCpu(act), mem: res?.memory ? { total: Number(res.memory.total) || 0, used: Number(res.memory.used) || 0 } : null,
        uptime: parseUptime(time?.uptime), load: time?.loadavg || '', datetime: time?.datetime || '',
        disks: (disk?.devices || []).map((x) => ({ mount: x.mountpoint, device: x.device, type: x.type, used: x.used, size: x.blocks, avail: x.available, pct: Number(String(x.used_pct ?? '').replace('%', '')) })),
        temps: (Array.isArray(temp) ? temp : []).map((x) => ({ name: x.type_translated || x.device, device: x.device, value: Number(x.temperature) })).filter((x) => isFinite(x.value)),
      },
      gateways: parseGateways(gw),
      interfaces,
      firmware: rt.fw || null,
      errors: Object.fromEntries([['interfaces', ifs ? null : why(r[6])], ['gateways', gw ? null : why(r[5])]].filter(([, v]) => v)),
    };
  }

  const fwRow = (x) => ({
    uuid: x.uuid, enabled: x.enabled === '1' || x.enabled === 1 || x.enabled === true, seq: Number(x.sequence) || null,
    action: x.action || '', direction: x.direction || '', iface: x.interface || '', proto: x.protocol || '', ipproto: x.ipprotocol || '',
    src: x.source_net || x.source || '', srcPort: x.source_port || '', dst: x.destination_net || x.destination || '', dstPort: x.destination_port || '',
    descr: x.description || '', log: x.log === '1', category: x.categories || '',
  });
  const SERVICE_OPS = { start: 'Dienst gestartet', stop: 'Dienst gestoppt', restart: 'Dienst neu gestartet' };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Erlaubte Aufrufe aus der App. audit: Protokolleintrag (Text oder Funktion der Parameter)
  const CALLS = {
    // ---- Switch / SNMP ----
    'snmp.info': { kinds: ['switch', 'device'], run: (d) => switchInfo(d) },
    'snmp.ports': { kinds: ['switch', 'device'], run: async (d, p) => {
      const r = await switchPorts(d, { live: !!p.live });
      if (!r.live) rtOf(d.id).lastPorts = r.ports;
      return r;
    } },
    'snmp.port': {
      kinds: ['switch', 'device'], cat: 'network',
      audit: (p) => (p.up ? 'Port aktiviert' : 'Port deaktiviert'), detail: (p, d) => portName(d, Number(p.ifIndex)),
      run: async (d, p) => {
        const ifIndex = ifIndexOf(p.ifIndex);
        const r = await snmp(d, [{ op: 'set', varbinds: [{ oid: `${OID.ifAdminStatus}.${ifIndex}`, type: 'int', value: p.up ? 1 : 2 }] }], 20000, true);
        if (!r.results[0]?.ok) throw httpError(502, r.results[0]?.error || 'Fehlgeschlagen');
        return { ok: true };
      },
    },
    'snmp.alias': {
      kinds: ['switch', 'device'], cat: 'network', audit: 'Port-Beschreibung geändert', detail: (p, d) => `${portName(d, Number(p.ifIndex))} → ${p.alias || '(leer)'}`,
      run: async (d, p) => {
        const ifIndex = ifIndexOf(p.ifIndex);
        const alias = String(p.alias || '').slice(0, 64);
        const r = await snmp(d, [{ op: 'set', varbinds: [{ oid: `${OID.ifAlias}.${ifIndex}`, type: 'str', value: alias }] }], 20000, true);
        if (!r.results[0]?.ok) throw httpError(502, r.results[0]?.error || 'Fehlgeschlagen');
        return { ok: true };
      },
    },
    'snmp.poe': {
      kinds: ['switch', 'device'], cat: 'network',
      audit: (p) => ({ cycle: 'PoE neu gestartet', on: 'PoE eingeschaltet', off: 'PoE ausgeschaltet' })[p.op], detail: (p, d) => portName(d, Number(p.ifIndex)),
      run: async (d, p) => {
        const group = ifIndexOf(p.group);
        const port = ifIndexOf(p.port);
        if (!['cycle', 'on', 'off'].includes(p.op)) throw httpError(400, 'Unbekannte PoE-Aktion');
        const oid = `${OID.pethPsePortAdminEnable}.${group}.${port}`;
        const set = (v) => ({ op: 'set', varbinds: [{ oid, type: 'int', value: v }] });
        const ops = p.op === 'cycle' ? [set(2), { op: 'sleep', ms: 4000 }, set(1)] : [set(p.op === 'on' ? 1 : 2)];
        const r = await snmp(d, ops, 40000, true);
        const bad = r.results.find((x) => !x.ok);
        if (bad || r.results.length < ops.length) throw httpError(502, bad?.error || 'Fehlgeschlagen');
        return { ok: true };
      },
    },
    // ---- OPNsense ----
    'opn.overview': { kinds: ['opnsense'], run: (d) => opnOverview(d) },
    'opn.leases': { kinds: ['opnsense'], run: async (d) => {
      // MAC-Tabellen der Switches auffrischen (höchstens 10 s warten), damit "Switch-Port" stimmt
      const stale = devices().filter((x) => x.kind === 'switch' && x.snmp && Date.now() - (rtOf(x.id).fdb?.at || 0) > 5 * 60e3);
      const fdbs = Promise.all(stale.map((sw) => refreshFdb(sw).catch(() => {})));
      const r = await loadLeases(d);
      await Promise.race([fdbs, new Promise((ok) => setTimeout(ok, 10000))]);
      return { ...r, rows: r.rows.map((x) => ({ ...x, switchPort: switchPortOf(x.mac), agentId: Object.values(store.data.agents).find((a) => (a.info?.interfaces || []).some((i) => normMac(i.mac) === x.mac))?.id || null })) };
    } },
    'opn.services': { kinds: ['opnsense'], run: async (d) => {
      const [x] = await opn(d, [{ path: '/api/core/service/search' }]);
      const data = okData(x);
      if (!data) throw httpError(502, `Dienste: ${why(x)}`);
      return (data.rows || []).map((s) => ({ id: s.id, name: s.name, description: s.description || s.name, running: s.running === 1 || s.running === '1' || s.running === true, locked: s.locked === 1 || s.locked === '1' }));
    } },
    'opn.service': {
      kinds: ['opnsense'], cat: 'action', audit: (p) => SERVICE_OPS[p.op], detail: (p) => p.label || p.id,
      run: async (d, p) => {
        if (!SERVICE_OPS[p.op]) throw httpError(400, 'Unbekannte Aktion');
        if (!/^[\w.-]+(\/[\w.-]+)?$/.test(String(p.id || ''))) throw httpError(400, 'Ungültiger Dienst');
        const [x] = await opn(d, [{ method: 'POST', path: `/api/core/service/${p.op}/${p.id}`, timeout: 60000 }], 70000);
        if (!okData(x)) throw httpError(502, why(x));
        return okData(x);
      },
    },
    'opn.fwlog': { kinds: ['opnsense'], run: async (d, p) => {
      const limit = Math.min(Math.max(Number(p.limit) || 200, 10), 1000);
      const [x] = await opn(d, [{ path: `/api/diagnostics/firewall/log?limit=${limit}` }]);
      const data = okData(x);
      if (!Array.isArray(data)) throw httpError(502, `Firewall-Log: ${why(x)}`);
      return data.map((e) => ({
        ts: e.__timestamp__ || '', action: e.action || '', dir: e.dir || '', iface: e.interface_name || e.interface || '', proto: e.protoname || e.proto || '',
        src: e.src || '', srcPort: e.srcport || '', dst: e.dst || '', dstPort: e.dstport || '', label: e.label || '', reason: e.reason || '', rid: e.rid || '',
      }));
    } },
    'opn.rules': { kinds: ['opnsense'], run: async (d) => {
      const [x] = await opn(d, [{ method: 'POST', path: '/api/firewall/filter/searchRule', body: { current: 1, rowCount: -1, searchPhrase: '' } }]);
      const data = okData(x);
      if (!data) throw httpError(502, `Firewall-Regeln: ${why(x)}`);
      return (data.rows || []).map(fwRow);
    } },
    'opn.rule': {
      kinds: ['opnsense'], cat: 'network', audit: (p) => (p.enabled ? 'Firewall-Regel aktiviert' : 'Firewall-Regel deaktiviert'), detail: (p) => p.label || p.uuid,
      run: async (d, p) => {
        if (!UUID_RE.test(String(p.uuid || ''))) throw httpError(400, 'Ungültige Regel');
        const [t] = await opn(d, [{ method: 'POST', path: `/api/firewall/filter/toggleRule/${p.uuid}/${p.enabled ? 1 : 0}` }]);
        if (!okData(t)) throw httpError(502, why(t));
        const [a] = await opn(d, [{ method: 'POST', path: '/api/firewall/filter/apply', timeout: 60000 }], 70000);
        if (!okData(a)) throw httpError(502, `Übernehmen: ${why(a)}`);
        return { ok: true };
      },
    },
    'opn.vpn': { kinds: ['opnsense'], run: async (d) => {
      const r = await opn(d, [
        { path: '/api/wireguard/service/show' },
        { path: '/api/openvpn/service/searchSessions' },
        { path: '/api/ipsec/sessions/searchPhase1' },
      ]);
      const [wg, ovpn, ipsec] = r.map(okData);
      const wgRows = Array.isArray(wg) ? wg : wg?.rows || [];
      return {
        wireguard: wg ? wgRows.map((x) => ({
          type: x.type, iface: x.ifname || x.if || '', name: x.name || x['peer-name'] || '', endpoint: x.endpoint || '', allowed: x['allowed-ips'] || '',
          handshake: Number(x['latest-handshake']) || 0, rx: Number(x['transfer-rx']) || 0, tx: Number(x['transfer-tx']) || 0, status: x['peer-status'] || x.status || '',
        })) : null,
        openvpn: ovpn ? (ovpn.rows || []).map((x) => ({
          type: x.type, name: x.description || x.common_name || '', user: x.common_name || '', real: x.real_address || '', virtual: x.virtual_address || '',
          since: x.connected_since || '', rx: Number(x.bytes_received) || 0, tx: Number(x.bytes_sent) || 0, status: x.status || '',
        })) : null,
        ipsec: ipsec ? (ipsec.rows || []).map((x) => ({ name: x.description || x.name || '', local: x['local-addrs'] || '', remote: x['remote-addrs'] || '', connected: !!x.connected })) : null,
      };
    } },
    'opn.firmware': { kinds: ['opnsense'], run: async (d) => {
      const [x] = await opn(d, [{ path: '/api/core/firmware/status' }]);
      const data = okData(x);
      if (!data) throw httpError(502, `Updates: ${why(x)}`);
      const rt = rtOf(d.id);
      rt.fw = parseFirmware(data);
      rt.fwAt = Date.now();
      return rt.fw;
    } },
    'opn.firmware.check': { kinds: ['opnsense'], run: async (d) => {
      const [x] = await opn(d, [{ method: 'POST', path: '/api/core/firmware/check' }]);
      if (!okData(x)) throw httpError(502, why(x));
      return { ok: true };
    } },
    'opn.firmware.progress': { kinds: ['opnsense'], run: async (d) => {
      const [x] = await opn(d, [{ path: '/api/core/firmware/upgradestatus' }]);
      const data = okData(x);
      if (!data) throw httpError(502, why(x));
      return { status: data.status || '', log: String(data.log || '').slice(-6000) };
    } },
    'opn.firmware.update': {
      kinds: ['opnsense'], cat: 'network', audit: 'OPNsense-Updates gestartet',
      run: async (d) => {
        const [x] = await opn(d, [{ method: 'POST', path: '/api/core/firmware/update' }]);
        if (!okData(x)) throw httpError(502, why(x));
        rtOf(d.id).fwAt = 0; // nach dem Update neu prüfen
        return { ok: true };
      },
    },
    'opn.reboot': {
      kinds: ['opnsense'], cat: 'power', audit: 'Neustart',
      run: async (d) => {
        let [x] = await opn(d, [{ method: 'POST', path: '/api/core/system/reboot' }]);
        if (x?.ok && x.status === 404) [x] = await opn(d, [{ method: 'POST', path: '/api/core/firmware/reboot' }]);
        if (!okData(x)) throw httpError(502, why(x));
        return { ok: true };
      },
    },
    'opn.backup': {
      kinds: ['opnsense'], cat: 'network', audit: 'Konfiguration heruntergeladen',
      run: async (d) => {
        let [x] = await opn(d, [{ path: '/api/core/backup/download/this', raw: true, timeout: 60000 }], 70000);
        if (x?.ok && x.status === 404) [x] = await opn(d, [{ path: '/api/backup/backup/download', raw: true, timeout: 60000 }], 70000);
        if (!x?.ok || x.status !== 200 || !x.raw) throw httpError(502, `Sicherung: ${why(x)}`);
        const xml = Buffer.from(x.raw, 'base64');
        if (!/^\s*<\?xml/.test(xml.subarray(0, 100).toString('utf8'))) throw httpError(502, 'Sicherung: unerwartete Antwort (keine config.xml)');
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
        return { name: `config-${(d.name || 'opnsense').replace(/[^\w.-]+/g, '_')}-${stamp}.xml`, data: x.raw };
      },
    },
  };

  app.post('/api/net/:id/call', requireAdmin, wrap(async (req, res) => {
    const d = getDev(req);
    const { action, params = {} } = req.body || {};
    const def = CALLS[action];
    if (!def || !def.kinds.includes(d.kind)) throw httpError(400, 'Unbekannte Aktion für dieses Gerät');
    if (d.kind !== 'opnsense' && action.startsWith('snmp.') && !d.snmp) throw httpError(400, 'Für dieses Gerät ist kein SNMP eingerichtet');
    const rt = rtOf(d.id);
    if (d.kind === 'opnsense' && rt.authFailAt && Date.now() - rt.authFailAt < AUTH_PAUSE) {
      throw httpError(409, `${rt.authError}. Pause gegen die Sperre der OPNsense – mit korrigiertem Zugang („Bearbeiten“) geht es sofort weiter.`);
    }
    const label = typeof def.audit === 'function' ? def.audit(params) : def.audit;
    const entry = () => ({ agentId: d.id, target: d.name, detail: def.detail?.(params, d) });
    try {
      const r = await def.run(d, params);
      if (label) auditReq(req, def.cat || 'network', label, entry());
      res.json(r ?? { ok: true });
    } catch (e) {
      if (label) auditReq(req, def.cat || 'network', label, { ...entry(), ok: false, result: e.message });
      throw e;
    }
  }));

  // ---------- Weboberfläche über den Abfrage-Client ----------
  // Die App startet auf dem eigenen PC einen lokalen Port; jede Browser-Verbindung dorthin bekommt
  // einen eigenen Tunnel: App -> Server (/ws/console) -> Abfrage-Client (/ws/tunnel) -> Gerät.
  function webTarget(d) {
    const u = new URL(d.webUrl || defaultWebUrl(d));
    return { scheme: u.protocol.replace(':', ''), host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search };
  }
  app.post('/api/net/:id/web-open', requireAdmin, wrap(async (req, res) => {
    const d = getDev(req);
    probeOf(d);
    const t = webTarget(d);
    auditReq(req, 'network', 'Weboberfläche geöffnet', { agentId: d.id, target: d.name, detail: `über Abfrage-Client ${agentLabel(store.data.agents[d.probeId])} → ${t.host}:${t.port}` });
    res.json(t);
  }));
  app.post('/api/net/:id/web', requireAdmin, wrap(async (req, res) => {
    const d = getDev(req);
    const a = probeOf(d);
    const t = webTarget(d);
    const sid = crypto.randomUUID();
    const tun = { hostId: a.id, agentWs: null, adminWs: null, toAdmin: [], toAgent: [] };
    tun.timer = setTimeout(() => closeTunnel(sid, 'nicht verbunden'), 30000);
    tunnels.set(sid, tun);
    try {
      await agentRequest(a.id, 'net.tunnel', { sid, host: t.host, port: t.port }, 20000);
    } catch (e) {
      closeTunnel(sid);
      throw e;
    }
    res.json({ sid });
  }));

  return {
    list: () => devices().map(publicDevice),
    // Abfrage-Client ist (wieder) da: seine Geräte gleich prüfen
    agentOnline(agentId) {
      const mine = devices().filter((d) => d.probeId === agentId);
      if (mine.length) setTimeout(() => mine.forEach((d) => pollDevice(d).catch(() => {})), 3000);
    },
    agentChanged(agentId) {
      for (const d of devices()) if (d.probeId === agentId) broadcastDevice(d);
    },
  };
};
