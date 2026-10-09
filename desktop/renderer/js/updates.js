// Updates für Dashboard-App, Server und Agents.
import { api } from './api.js';
import { icon, esc, $, toast, confirmDialog } from './ui.js';

const desk = window.rmmDesk?.update ? window.rmmDesk : null;

export const updates = {
  app: { status: desk ? 'idle' : 'browser', version: null, percent: 0, message: '' },
  appVersion: '',
  server: null, // Antwort von /api/update
  listeners: new Set(),
  emit() { for (const fn of this.listeners) fn(); },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },

  get anyAvailable() {
    return this.app.status === 'ready' || !!this.server?.updateAvailable || (this.server?.agent?.outdatedOnline || 0) > 0;
  },

  async refreshServer(force = false) {
    try {
      this.server = await api.get(`/api/update${force ? '?force=1' : ''}`);
    } catch {
      this.server = null;
    }
    this.emit();
    return this.server;
  },
};

export async function initUpdates() {
  if (desk) {
    const info = await desk.appInfo();
    updates.appVersion = info.version;
    updates.app = await desk.update.state();
    desk.update.onState((s) => {
      const wasReady = updates.app.status === 'ready';
      updates.app = s;
      if (s.status === 'ready' && !wasReady) toast(`Dashboard-Update ${s.version} ist bereit`);
      updates.emit();
    });
  }
  updates.refreshServer();
  setInterval(() => updates.refreshServer(), 30 * 60e3);
  // Nach einem Server-Neustart (z.B. durch ein Update) Versionen neu laden
  api.on('conn', (on) => on && setTimeout(() => updates.refreshServer(), 1500));
  api.on('agent', () => {
    // Agents verbinden sich nach ihrem Auto-Update neu -> Zähler aktualisieren
    clearTimeout(updates._t);
    updates._t = setTimeout(() => updates.refreshServer(), 4000);
  });
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '');

// Karte für die Einstellungsseite
export function renderUpdateCard(box) {
  let pollTimer = null;
  let startCommit = null;

  async function serverUpdate() {
    if (!(await confirmDialog({ title: 'Server aktualisieren?', text: 'Der Server lädt die neueste Version von GitHub und startet neu. Die App verbindet sich danach automatisch wieder (dauert ca. 1 Minute).', okText: 'Aktualisieren' }))) return;
    try {
      startCommit = updates.server?.server?.commit;
      await api.post('/api/update/server');
      toast('Server-Update gestartet');
      await updates.refreshServer();
      startPolling();
    } catch (e) { toast(e.message, 'err'); }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const s = await updates.refreshServer();
      if (s && startCommit && s.server.commit !== startCommit) {
        clearInterval(pollTimer);
        toast(`Server aktualisiert auf ${s.server.commit}`);
        startCommit = null;
      } else if (s && !s.updating) {
        clearInterval(pollTimer);
      }
    }, 4000);
  }

  async function agentsUpdate() {
    try {
      const r = await api.post('/api/update/agents');
      toast(r.requested ? `${r.ok} von ${r.requested} Agent(s) werden aktualisiert` : 'Alle Online-Agents sind aktuell');
      setTimeout(() => updates.refreshServer(), 6000);
    } catch (e) { toast(e.message, 'err'); }
  }

  function draw() {
    const a = updates.app, s = updates.server;
    const appRow = !desk
      ? `<div class="muted">Nur in der installierten Desktop-App verfügbar.</div>`
      : a.status === 'dev'
        ? `<div class="muted">Entwicklungsversion – Updates nur in der installierten App.</div>`
        : `<div class="row">
            <div class="grow">${{
              idle: 'Noch nicht geprüft',
              checking: 'Suche nach Updates ...',
              none: `${icon('check', 'sm')} Aktuell`,
              downloading: `Lade Version ${esc(a.version || '')} ... ${a.percent || 0} %`,
              ready: `<b>Version ${esc(a.version)}</b> ist heruntergeladen und bereit.`,
              error: `<span style="color:var(--critical-text)">Fehler: ${esc(a.message)}</span>`,
            }[a.status] || ''}</div>
            ${a.status === 'ready'
              ? `<button class="btn primary" data-appinstall>${icon('download', 'sm')}Jetzt installieren &amp; neu starten</button>`
              : `<button class="btn" data-appcheck ${a.status === 'checking' || a.status === 'downloading' ? 'disabled' : ''}>${icon('refresh', 'sm')}Nach Updates suchen</button>`}
          </div>`;

    let serverRow;
    if (!s) serverRow = `<div class="muted">Keine Informationen vom Server.</div>`;
    else {
      const inst = s.server, latest = s.latest;
      serverRow = `
        <div class="kv" style="grid-template-columns:110px 1fr">
          <div class="k">Installiert</div><div class="v"><span class="mono">${esc(inst.commit)}</span> <span class="muted">${esc(fmtDate(inst.date))} · ${esc(inst.message || '')}</span></div>
          <div class="k">Neueste</div><div class="v">${latest ? `<span class="mono">${esc(latest.commit)}</span> <span class="muted">${esc(fmtDate(latest.date))} · ${esc(latest.message)}</span>` : `<span class="muted">${esc(s.latestError || 'unbekannt')}</span>`}</div>
        </div>
        <div class="row" style="margin-top:12px">
          <div class="grow">${s.updating
            ? `<span class="status"><span class="dot alert"></span>Update läuft ...</span>`
            : s.updateAvailable ? `<span class="badge accent">${icon('download')}Update verfügbar</span>`
            : inst.commit === 'dev' ? `<span class="muted">Entwicklungsserver</span>`
            : `<span class="badge good">${icon('check')}Aktuell</span>`}</div>
          <button class="btn ${s.updateAvailable ? 'primary' : ''}" data-srvupdate ${!s.canSelfUpdate || s.updating ? 'disabled' : ''}>${icon('download', 'sm')}Server aktualisieren</button>
        </div>
        ${!s.canSelfUpdate && inst.commit !== 'dev' ? `<div class="hint muted" style="margin-top:8px;font-size:12.5px">Selbst-Update ist noch nicht eingerichtet: einmalig den curl-Installationsbefehl auf dem Server ausführen.</div>` : ''}
        ${s.updating && s.log ? `<pre class="output" style="margin-top:12px;max-height:200px">${esc(s.log)}</pre>` : ''}`;
    }

    const ag = s?.agent;
    const agentRow = !ag ? '' : `
      <div class="row">
        <div class="grow">${ag.outdated
          ? `${ag.outdated} von ${ag.total} Agent(s) veraltet${ag.outdatedOnline < ag.outdated ? ` <span class="muted">(${ag.outdated - ag.outdatedOnline} offline – werden beim nächsten Verbinden aktualisiert)</span>` : ''}`
          : `${icon('check', 'sm')} Alle ${ag.total} Agent(s) aktuell`} <span class="muted">· Version ${esc(ag.version)}</span></div>
        <button class="btn" data-agupdate ${ag.outdatedOnline ? '' : 'disabled'}>${icon('refresh', 'sm')}Alle Agents aktualisieren</button>
      </div>
      <label class="row" style="gap:10px;margin-top:10px;cursor:pointer;font-size:13px;color:var(--text-2)"><input type="checkbox" class="check" data-agauto ${api.settings.autoUpdateAgents !== false ? 'checked' : ''}> Agents automatisch aktualisieren, sobald eine neue Version auf dem Server liegt</label>`;

    box.innerHTML = `
      <div class="card-head">${icon('download', 'sm')}<h3>Updates</h3></div>
      <div class="card-pad" style="display:flex;flex-direction:column;gap:18px">
        <div><div class="os-head" style="margin-bottom:8px">${icon('monitor', 'sm')}Dashboard-App ${updates.appVersion ? `<span class="muted" style="font-weight:400">· Version ${esc(updates.appVersion)}</span>` : ''}</div>${appRow}</div>
        <div style="border-top:1px solid var(--border);padding-top:16px"><div class="os-head" style="margin-bottom:8px">${icon('server', 'sm')}Server</div>${serverRow}</div>
        <div style="border-top:1px solid var(--border);padding-top:16px"><div class="os-head" style="margin-bottom:8px">${icon('network', 'sm')}Agents</div>${agentRow}</div>
      </div>`;

    $('[data-appcheck]', box)?.addEventListener('click', () => desk.update.check());
    $('[data-appinstall]', box)?.addEventListener('click', () => desk.update.install());
    $('[data-srvupdate]', box)?.addEventListener('click', serverUpdate);
    $('[data-agupdate]', box)?.addEventListener('click', agentsUpdate);
    $('[data-agauto]', box)?.addEventListener('change', async (e) => {
      try { api.settings = await api.put('/api/settings', { autoUpdateAgents: e.target.checked }); } catch (err) { toast(err.message, 'err'); }
    });
  }

  draw();
  const off = updates.on(draw);
  updates.refreshServer(true).then(() => { if (updates.server?.updating) startPolling(); });
  return () => { off(); clearInterval(pollTimer); };
}
