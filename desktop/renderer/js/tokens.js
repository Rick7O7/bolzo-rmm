// Karte "API-Zugänge": eingeschränkte Schlüssel für Dienste wie die Telefon-Sprachsteuerung.
import { api } from './api.js';
import { icon, esc, $, $$, toast, modal, confirmDialog, copyText, fmtAgo } from './ui.js';

const SCOPES = {
  status: { label: 'Status lesen', hint: 'Clients und Auslastung abfragen', def: true },
  power: { label: 'Neustart / Herunterfahren / Aufwecken', hint: 'Clients neu starten, herunterfahren, per Wake-on-LAN wecken', def: true },
  processes: { label: 'Prozesse beenden', hint: 'Laufende Programme anzeigen und beenden' },
  services: { label: 'Dienste steuern', hint: 'Dienste anzeigen, starten, stoppen, neu starten' },
  proxmox: { label: 'Proxmox-Gäste steuern', hint: 'VMs und Container starten, herunterfahren, neu starten' },
  scripts: { label: 'Skripte ausführen', hint: 'Nur gespeicherte Skripte aus der Bibliothek – keine frei eingegebenen Befehle' },
  jobs: { label: 'Jobs ausführen', hint: 'Nur vorbereitete Jobs mit festem Befehl und festen Rechnern, z.B. „Minecraft-Server starten“', def: true },
  pvedelete: { label: 'VMs/Container löschen', hint: 'Endgültig, nur ausgeschaltete Gäste. Am Telefon zusätzlich VM-Nummer eintippen' },
};
const scopeChecks = (on) => Object.entries(SCOPES).map(([k, s]) => `<label class="tk-scope" title="${esc(s.hint)}">
  <input type="checkbox" class="check" value="${k}" ${on(k, s) ? 'checked' : ''} data-scope><span><b>${esc(s.label)}</b><small>${esc(s.hint)}</small></span></label>`).join('');

export function renderTokenCard(box) {
  let tokens = [];

  async function load() {
    try { tokens = await api.get('/api/tokens'); } catch (e) { tokens = []; toast(e.message, 'err'); }
    draw();
  }

  function draw() {
    box.innerHTML = `
      <div class="card-head">${icon('key', 'sm')}<h3>API-Zugänge</h3></div>
      <div class="alert-list">
        ${tokens.length ? tokens.map((t) => `
          <div class="alert-row" style="cursor:default">
            <div class="grow">
              <div style="font-weight:600">${esc(t.name)}</div>
              <div class="muted" style="font-size:12px">${t.scopes.map((s) => esc(SCOPES[s]?.label || s)).join(' · ')} · angelegt ${new Date(t.createdAt).toLocaleDateString('de-DE')} · zuletzt benutzt ${t.lastUsed ? fmtAgo(t.lastUsed) : 'nie'}</div>
            </div>
            <button class="btn sm" data-edit="${t.id}">${icon('key', 'sm')}Rechte</button>
            <button class="btn sm danger" data-del="${t.id}" data-name="${esc(t.name)}">${icon('trash', 'sm')}Löschen</button>
          </div>`).join('') : '<div class="empty" style="padding:20px">Noch keine API-Zugänge</div>'}
      </div>
      <div class="card-pad" style="border-top:1px solid var(--border);display:flex;flex-direction:column;gap:12px">
        <div class="hint" style="font-size:12.5px;color:var(--text-2)">Für Dienste wie die Telefon-Sprachsteuerung. Ein Zugang darf nur, was du hier ankreuzt – nie Terminal, frei eingegebene Befehle oder Einstellungen.</div>
        <div class="tk-scopes" data-new-scopes>${scopeChecks((k, s) => s.def)}</div>
        <div class="row" style="flex-wrap:wrap">
          <input class="input" style="max-width:260px" placeholder="Name, z.B. Telefon" data-name-input>
          <span class="grow"></span>
          <button class="btn primary" data-create>${icon('plus', 'sm')}Zugang anlegen</button>
        </div>
      </div>`;

    $('[data-create]', box).onclick = create;
    $$('[data-edit]', box).forEach((b) => (b.onclick = () => editScopes(tokens.find((t) => t.id === b.dataset.edit))));
    $$('[data-del]', box).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: 'API-Zugang löschen?', text: `„${esc(b.dataset.name)}" funktioniert danach sofort nicht mehr.`, okText: 'Löschen', danger: true }))) return;
      await api.del(`/api/tokens/${b.dataset.del}`);
      toast('API-Zugang gelöscht');
      load();
    }));
  }

  async function create() {
    const name = $('[data-name-input]', box).value.trim();
    const scopes = $$('[data-new-scopes] [data-scope]', box).filter((c) => c.checked).map((c) => c.value);
    try {
      const t = await api.post('/api/tokens', { name, scopes });
      const m = modal({
        title: 'API-Zugang angelegt',
        body: `<p style="margin:0;color:var(--text-2)">Kopiere den Schlüssel jetzt – er wird <b>nur dieses eine Mal</b> angezeigt. Trag ihn auf dem Gerät in die Konfiguration ein (z.B. <span class="mono">RMM_TOKEN=</span> in <span class="mono">/etc/bolzo-voice/voice.env</span>).</p>
          <div class="cmd-box"><pre>${esc(t.token)}</pre><button class="btn icon-only" data-copy title="Kopieren">${icon('copy', 'sm')}</button></div>`,
        foot: '<button class="btn primary" data-close>Fertig</button>',
        closeOnBackdrop: false, // Schlüssel wird nur einmal angezeigt – nicht versehentlich wegklicken
      });
      $('[data-copy]', m.el).onclick = () => copyText(t.token);
      load();
    } catch (e) { toast(e.message, 'err'); }
  }

  function editScopes(t) {
    if (!t) return;
    const m = modal({
      title: `Rechte von „${t.name}“`,
      body: `<p style="margin:0 0 12px;color:var(--text-2)">Der Schlüssel bleibt gleich – auf dem Gerät musst du nichts ändern. Jede Aktion muss am Telefon trotzdem bestätigt werden.</p>
        <div class="tk-scopes">${scopeChecks((k) => t.scopes.includes(k))}</div>`,
      foot: '<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>',
    });
    $('[data-save]', m.el).onclick = async () => {
      const scopes = $$('[data-scope]', m.el).filter((c) => c.checked).map((c) => c.value);
      try {
        await api.patch(`/api/tokens/${t.id}`, { scopes });
        m.close();
        toast('Rechte gespeichert');
        load();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  load();
  return () => {};
}
