import { api, LS } from '../api.js';
import { icon, esc, $, $$, toast, modal, copyText, confirmDialog } from '../ui.js';

function installHtml(info) {
  return `
    <div class="field">
      <div class="os-head">${icon('linux')}Linux (Debian, Ubuntu, Proxmox, Raspberry Pi ...)</div>
      <span class="hint">Als root bzw. mit sudo im Terminal des Clients ausführen. Benötigt systemd und curl.</span>
      <div class="cmd-box"><pre>${esc(info.linux)}</pre><button class="btn icon-only" data-copy="linux" title="Kopieren">${icon('copy', 'sm')}</button></div>
    </div>
    <div class="field">
      <div class="os-head">${icon('windows')}Windows 10 / 11 / Server</div>
      <span class="hint">In einer PowerShell <b>als Administrator</b> ausführen.</span>
      <div class="cmd-box"><pre>${esc(info.windows)}</pre><button class="btn icon-only" data-copy="windows" title="Kopieren">${icon('copy', 'sm')}</button></div>
    </div>
    <div class="hint" style="font-size:12.5px;color:var(--muted)">Der Client erscheint nach etwa 10–30 Sekunden automatisch im Dashboard. Das Skript lädt eine eigene Node.js-Laufzeit (~30 MB) nach <span class="mono">/opt/rmm-agent</span> bzw. <span class="mono">C:\\Program Files\\RMMDeskAgent</span>.</div>`;
}

function bindCopy(root, info) {
  $$('[data-copy]', root).forEach((b) => (b.onclick = () => copyText(info[b.dataset.copy])));
}

export async function addClientDialog() {
  let info;
  try { info = await api.get('/api/enroll'); } catch (e) { return toast(e.message, 'err'); }
  const m = modal({ title: 'Client hinzufügen', wide: true, body: installHtml(info), foot: '<button class="btn primary" data-close>Fertig</button>' });
  bindCopy(m.el, info);
}

export function renderSettings(root, { go }) {
  root.innerHTML = `
    <div class="page-head"><h1>Einstellungen</h1></div>
    <div style="display:flex;flex-direction:column;gap:14px;max-width:900px">
      <div class="card">
        <div class="card-head">${icon('download', 'sm')}<h3>Clients hinzufügen (Install-Skripte)</h3><span class="spacer"></span>
          <button class="btn sm" data-rotate>${icon('key', 'sm')}Neuen Schlüssel erzeugen</button></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:18px" data-install><span class="muted">Lade ...</span></div>
      </div>

      <div class="card">
        <div class="card-head">${icon('alert', 'sm')}<h3>Warnschwellen</h3></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
            <div class="field"><label>CPU ab (%)</label><input class="input" type="number" min="10" max="100" data-t="cpu"></div>
            <div class="field"><label>RAM ab (%)</label><input class="input" type="number" min="10" max="100" data-t="mem"></div>
            <div class="field"><label>Datenträger ab (%)</label><input class="input" type="number" min="10" max="100" data-t="disk"></div>
          </div>
          <div class="row"><span class="hint muted grow" style="font-size:12.5px">Werte darüber erscheinen als Warnung im Dashboard.</span><button class="btn primary" data-savet>Speichern</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">${icon('bell', 'sm')}<h3>Benachrichtigungen</h3></div>
        <div class="card-pad">
          <label class="row" style="gap:10px;cursor:pointer"><input type="checkbox" class="check" data-notify> Windows-Benachrichtigung, wenn ein Client offline oder wieder online geht</label>
        </div>
      </div>

      <div class="card">
        <div class="card-head">${icon('server', 'sm')}<h3>Server</h3></div>
        <div class="card-pad kv">
          <div class="k">Adresse</div><div class="v mono">${esc(api.server)}</div>
          <div class="k">Verbindung</div><div class="v" data-conn></div>
        </div>
        <div class="card-pad" style="border-top:1px solid var(--border)"><button class="btn danger" data-logout>${icon('logout', 'sm')}Abmelden</button></div>
      </div>
    </div>`;

  const loadInstall = (info) => {
    $('[data-install]', root).innerHTML = installHtml(info);
    bindCopy(root, info);
  };
  api.get('/api/enroll').then(loadInstall).catch((e) => ($('[data-install]', root).textContent = e.message));
  $('[data-rotate]', root).onclick = async () => {
    if (!(await confirmDialog({ title: 'Neuen Installationsschlüssel erzeugen?', text: 'Bisherige Install-Befehle funktionieren danach nicht mehr. Bereits installierte Clients sind nicht betroffen.', okText: 'Erzeugen' }))) return;
    loadInstall(await api.post('/api/enroll/rotate'));
    toast('Neuer Schlüssel erzeugt');
  };

  const t = api.settings.thresholds;
  $$('[data-t]', root).forEach((i) => (i.value = t[i.dataset.t]));
  $('[data-savet]', root).onclick = async () => {
    const thresholds = Object.fromEntries($$('[data-t]', root).map((i) => [i.dataset.t, Number(i.value)]));
    try {
      api.settings = await api.put('/api/settings', { thresholds });
      toast('Warnschwellen gespeichert');
    } catch (e) { toast(e.message, 'err'); }
  };

  const notify = $('[data-notify]', root);
  notify.checked = LS.get('notify', true);
  notify.onchange = () => LS.set('notify', notify.checked);

  const drawConn = () => ($('[data-conn]', root).innerHTML = api.connected ? '<span class="status"><span class="dot online"></span>Verbunden</span>' : '<span class="status"><span class="dot offline"></span>Getrennt – verbinde neu ...</span>');
  drawConn();
  $('[data-logout]', root).onclick = () => api.logout();
  return api.on('conn', drawConn);
}
