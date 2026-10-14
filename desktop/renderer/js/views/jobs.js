// Jobs: vorbereitete Aufgaben mit festem Befehl auf festen Rechnern, z.B. "Minecraft-Server starten"
// auf SRV-MC. Per Klick oder per Telefon (Recht "Jobs ausführen" im API-Zugang) abrufbar.
import { api } from '../api.js';
import { icon, esc, $, $$, toast, confirmDialog, enableTabIndent, osIcon, exitBadge, fmtAgo } from '../ui.js';

const SHELLS = { bash: 'Bash', sh: 'sh', powershell: 'PowerShell', cmd: 'CMD', python: 'Python' };
const COMPAT = { powershell: ['win32'], cmd: ['win32'], bash: ['linux', 'darwin'], sh: ['linux', 'darwin'], python: ['win32', 'linux', 'darwin'] };

// Vorlagen für Programme, die dauerhaft weiterlaufen sollen (Spieleserver u.ä.). Der Agent startet
// Jobs in einem eigenen systemd-Scope – eine tmux-Sitzung überlebt so auch Agent-Neustarts.
const TEMPLATES = {
  'tmux-start': {
    label: 'tmux: Programm starten',
    body: `# Programm dauerhaft in einer tmux-Sitzung starten.
# Ansehen auf dem Server: tmux attach -t mc  (verlassen ohne zu beenden: Strg+B, dann D)
SESSION=mc
DIR=/opt/minecraft
CMD='java -Xms2G -Xmx4G -jar server.jar nogui'
AS=""   # z.B. AS="runuser -u minecraft --", sonst läuft es als root

command -v tmux >/dev/null || { echo "tmux fehlt (apt install tmux)"; exit 1; }
if $AS tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Läuft bereits (tmux-Sitzung $SESSION)."
  exit 0
fi
cd "$DIR" || exit 1
$AS tmux new-session -d -s "$SESSION" "$CMD"
sleep 3
if $AS tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Gestartet (tmux-Sitzung $SESSION)."
else
  echo "Start fehlgeschlagen – das Programm hat sich gleich wieder beendet."
  exit 1
fi
`,
  },
  'tmux-stop': {
    label: 'tmux: Programm sauber beenden',
    body: `# Programm in einer tmux-Sitzung sauber beenden: Befehl eintippen lassen und warten, bis es aus ist.
SESSION=mc
STOP_CMD='stop'   # Minecraft: stop – bei anderen Programmen z.B. exit oder quit
AS=""             # wie beim Starten, z.B. AS="runuser -u minecraft --"

if ! $AS tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Läuft nicht."
  exit 0
fi
$AS tmux send-keys -t "$SESSION" "$STOP_CMD" Enter
for i in $(seq 1 90); do
  sleep 1
  $AS tmux has-session -t "$SESSION" 2>/dev/null || { echo "Beendet nach $i s."; exit 0; }
done
echo "Nach 90 s noch nicht beendet."
exit 1
`,
  },
  'tmux-status': {
    label: 'tmux: Läuft es?',
    body: `# Prüfen, ob die tmux-Sitzung noch läuft.
SESSION=mc
AS=""   # wie beim Starten

if $AS tmux has-session -t "$SESSION" 2>/dev/null; then echo "Läuft."; else echo "Läuft nicht."; fi
`,
  },
};

const lastRunBadge = (j) => (j.lastRun
  ? `<span class="badge ${j.lastRun.ok ? 'good' : 'critical'}" style="height:19px;font-size:11px" title="${esc(j.lastRun.by || '')}">${icon(j.lastRun.ok ? 'check' : 'alert')}${fmtAgo(j.lastRun.ts)}</span>`
  : '');
const targetNames = (j) => j.agentIds.map((id) => api.agents.get(id)?.name).filter(Boolean).join(', ') || 'kein Rechner';

export function renderJobs(root) {
  let jobs = [];
  let current = null; // ausgewählter Job (oder neuer)
  let dirty = false;

  root.innerHTML = `
    <div class="page-head">
      <h1>Jobs</h1><span class="sub">Fester Befehl auf festen Rechnern – per Klick oder per Telefon</span>
      <span class="spacer"></span>
      <button class="btn primary" data-new>${icon('plus')}Neuer Job</button>
    </div>
    <div data-scopewarn></div>
    <div class="scripts-layout">
      <div class="card script-list" data-list></div>
      <div data-editor></div>
    </div>`;

  // Ohne das Recht „Jobs ausführen“ kennt die Sprachsteuerung keine Jobs und deutet „Starte den
  // Minecraft-Server“ als „Rechner hochfahren“ – deshalb hier deutlich darauf hinweisen
  async function checkScopes() {
    const box = $('[data-scopewarn]', root);
    let tokens = [];
    try { tokens = await api.get('/api/tokens'); } catch { return; }
    const missing = jobs.some((j) => j.voice) && tokens.length && !tokens.some((t) => t.scopes.includes('jobs'));
    box.innerHTML = missing ? `<div class="card card-pad row" style="margin-bottom:14px;flex-wrap:wrap;gap:10px;border-color:color-mix(in srgb, var(--warning) 50%, transparent)">
        <span style="color:var(--warning)">${icon('alert', 'sm')}</span>
        <span class="grow">Am Telefon kennt die Sprachsteuerung noch keine Jobs: Kein API-Zugang hat das Recht <b>„Jobs ausführen“</b>.</span>
        ${tokens.map((t) => `<button class="btn sm" data-grant="${t.id}">${icon('key', 'sm')}Für „${esc(t.name)}“ freischalten</button>`).join('')}
      </div>` : '';
    $$('[data-grant]', box).forEach((b) => (b.onclick = async () => {
      const t = tokens.find((x) => x.id === b.dataset.grant);
      try {
        await api.patch(`/api/tokens/${t.id}`, { scopes: [...t.scopes, 'jobs'] });
        toast(`„${t.name}“ darf jetzt Jobs ausführen – gilt ab dem nächsten Anruf`);
        checkScopes();
      } catch (e) { toast(e.message, 'err'); }
    }));
  }

  async function load(selectId) {
    jobs = await api.get('/api/jobs');
    checkScopes();
    drawList();
    if (current && !current.id) return; // neuer, noch nicht gespeicherter Job bleibt offen
    const j = jobs.find((x) => x.id === (selectId ?? current?.id)) || jobs[0];
    if (j) select(j);
    else drawEmpty();
  }

  function drawList() {
    $('[data-list]', root).innerHTML = jobs.length
      ? jobs.map((j) => `<div class="script-item ${current?.id === j.id ? 'on' : ''}" data-id="${j.id}">
          <div class="n">${esc(j.name)}<span style="margin-left:auto;display:flex;gap:4px">${j.voice ? `<span class="badge accent" style="height:19px;font-size:11px" title="Per Telefon abrufbar">Telefon</span>` : ''}${lastRunBadge(j)}</span></div>
          <div class="d">${esc(targetNames(j))}${j.description ? ` · ${esc(j.description)}` : ''}</div></div>`).join('')
      : `<div class="empty" style="padding:24px">Noch keine Jobs</div>`;
    $$('.script-item', root).forEach((i) => (i.onclick = async () => {
      if (dirty && !(await confirmDialog({ title: 'Änderungen verwerfen?', text: 'Der Job hat ungespeicherte Änderungen.', okText: 'Verwerfen', danger: true }))) return;
      select(jobs.find((j) => j.id === i.dataset.id));
    }));
  }

  function drawEmpty() {
    $('[data-editor]', root).innerHTML = `<div class="card empty">${icon('zap')}<h3>Noch keine Jobs</h3>
      <div>Ein Job ist ein fester Befehl auf festen Rechnern, z.B. „Minecraft-Server starten“ auf SRV-MC.<br>
      Mit dem Recht „Jobs ausführen“ im API-Zugang lässt er sich auch per Telefon abrufen.</div></div>`;
  }

  function select(j) {
    current = j;
    dirty = false;
    drawList();
    const isNew = !j.id;
    const picked = new Set(j.agentIds || []);
    const ed = $('[data-editor]', root);
    ed.innerHTML = `
      <div class="card">
        <div class="card-head">${icon('edit', 'sm')}<h3>${isNew ? 'Neuer Job' : 'Job bearbeiten'}</h3><span class="spacer"></span>
          ${isNew ? '' : `<button class="btn primary sm" data-run>${icon('play', 'sm')}Jetzt ausführen</button>`}
        </div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div class="form-grid">
            <div class="field"><label>Name</label><input class="input" data-f="name" value="${esc(j.name || '')}" placeholder="z.B. Minecraft-Server starten"></div>
            <div class="field"><label>Shell</label><select class="select" data-f="shell">${Object.entries(SHELLS).map(([k, v]) => `<option value="${k}" ${j.shell === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="field"><label>Timeout (s)</label><input class="input" type="number" min="5" max="7200" data-f="timeout" value="${j.timeout || 120}"></div>
          </div>
          <div class="field"><label>Beschreibung</label><input class="input" data-f="description" value="${esc(j.description || '')}" placeholder="Hilft am Telefon beim Erkennen, z.B. „Startet den Minecraft-Server in tmux“"></div>
          <div class="field"><label>Rechner</label><div class="pick-list" data-pick style="max-height:220px"></div></div>
          <div class="tk-scopes">
            <label class="tk-scope"><input type="checkbox" class="check" data-f="voice" ${j.voice !== false ? 'checked' : ''}>
              <span><b>Per Telefon abrufbar</b><small>„Starte den Minecraft-Server“ – braucht im API-Zugang das Recht „Jobs ausführen“. Jede Ausführung wird am Telefon rückgefragt.</small></span></label>
            <label class="tk-scope"><input type="checkbox" class="check" data-f="wake" ${j.wake !== false ? 'checked' : ''}>
              <span><b>Ausgeschaltete Rechner vorher starten</b><small>Über Proxmox (zugeordnete VM) bzw. Wake-on-LAN, dann wartet der Job bis zu 4 Minuten, bis der Rechner online ist.</small></span></label>
          </div>
          <div class="field">
            <label class="row" style="justify-content:space-between"><span>Befehl</span>
              <select class="select" data-template style="width:auto;height:28px;font-size:12.5px"><option value="">Vorlage einfügen …</option>
                ${Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select></label>
            <textarea class="textarea code editor" spellcheck="false" data-f="body" style="min-height:320px"></textarea>
            <span class="hint" data-compat></span></div>
          <div data-results style="display:flex;flex-direction:column;gap:10px"></div>
          <div class="row">
            ${isNew ? '' : `<button class="btn danger" data-del>${icon('trash', 'sm')}Löschen</button>`}
            <span class="grow"></span>
            <button class="btn primary" data-save>${icon('check', 'sm')}Speichern</button>
          </div>
        </div>
      </div>`;
    const body = $('[data-f="body"]', ed);
    const shellSel = $('[data-f="shell"]', ed);
    body.value = j.body || '';
    enableTabIndent(body);
    const card = $('.card', ed);
    card.addEventListener('input', () => (dirty = true));
    card.addEventListener('change', () => (dirty = true));

    // Rechner-Auswahl: offline ist erlaubt (läuft dann eben nicht), falsche Plattform nicht
    const fits = (a) => COMPAT[shellSel.value].includes(a.platform);
    function drawPick() {
      const agents = [...api.agents.values()].sort((a, b) => fits(b) - fits(a) || a.name.localeCompare(b.name));
      $('[data-pick]', ed).innerHTML = agents.map((a) => `<label class="pick-item ${fits(a) || picked.has(a.id) ? '' : 'disabled'}">
        <input type="checkbox" class="check" value="${a.id}" ${picked.has(a.id) ? 'checked' : ''} ${fits(a) || picked.has(a.id) ? '' : 'disabled'}>
        <span class="os">${osIcon(a.platform)}</span><span class="grow">${esc(a.name)}</span>
        <span class="muted" style="font-size:12px">${!fits(a) ? 'passt nicht zur Shell' : a.online ? esc(a.os) : 'offline'}</span></label>`).join('') || '<div class="empty">Keine Clients</div>';
    }
    $('[data-pick]', ed).addEventListener('change', (e) => {
      if (e.target.checked) picked.add(e.target.value);
      else picked.delete(e.target.value);
    });
    const compat = () => {
      const sh = shellSel.value;
      $('[data-compat]', ed).textContent = `Läuft auf: ${COMPAT[sh].map((p) => ({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[p])).join(', ')}. `
        + 'Unter Linux startet der Agent Jobs in einem eigenen systemd-Scope – Programme in tmux laufen auch nach einem Agent-Update weiter.';
      $('[data-template]', ed).style.display = ['bash', 'sh'].includes(sh) ? '' : 'none';
      drawPick();
    };
    shellSel.onchange = compat;
    compat();

    $('[data-template]', ed).onchange = async (e) => {
      const t = TEMPLATES[e.target.value];
      e.target.value = '';
      if (!t) return;
      if (body.value.trim() && !(await confirmDialog({ title: 'Befehl ersetzen?', text: 'Der bisherige Inhalt wird durch die Vorlage ersetzt.', okText: 'Ersetzen' }))) return;
      body.value = t.body;
      dirty = true;
      body.focus();
    };
    body.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); }
    });

    async function save({ reload = true } = {}) {
      const data = Object.fromEntries($$('[data-f]', ed).map((i) => [i.dataset.f, i.type === 'checkbox' ? i.checked : i.value]));
      data.timeout = Number(data.timeout);
      data.agentIds = [...picked];
      try {
        const saved = isNew ? await api.post('/api/jobs', data) : await api.put(`/api/jobs/${j.id}`, data);
        dirty = false;
        current = saved;
        if (reload) {
          toast('Job gespeichert');
          await load(saved.id);
        }
        return saved;
      } catch (e) {
        toast(e.message, 'err');
        return null;
      }
    }
    $('[data-save]', ed).onclick = () => save();

    $('[data-del]', ed)?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Job löschen?', text: `„${esc(j.name)}“ wird endgültig gelöscht.`, okText: 'Löschen', danger: true }))) return;
      await api.del(`/api/jobs/${j.id}`);
      current = null;
      toast('Job gelöscht');
      load();
    });

    $('[data-run]', ed)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (dirty && !(await save({ reload: false }))) return; // geänderte Fassung zuerst speichern
      btn.disabled = true;
      btn.innerHTML = `${icon('refresh', 'sm spin')}Läuft ...`;
      const res = $('[data-results]', ed);
      res.innerHTML = '';
      try {
        const results = await api.post(`/api/jobs/${j.id}/run`);
        res.innerHTML = `<div class="section-title" style="margin:0">Ergebnis</div>` + results.map((r) => `
          <div class="result"><div class="result-head"><span class="grow" style="font-weight:500">${esc(r.hostname)}</span>${exitBadge(r)}</div>
          <pre class="output">${esc(r.error ? `Fehler: ${r.error}` : r.output || '(keine Ausgabe)')}</pre></div>`).join('');
        $$('.result-head', res).forEach((h) => (h.onclick = () => { const o = h.nextElementSibling; o.style.display = o.style.display === 'none' ? '' : 'none'; }));
        const ok = results.filter((r) => !r.error && !r.timedOut && r.exitCode === 0).length;
        toast(`${j.name}: ${ok} von ${results.length} erfolgreich`, ok === results.length ? 'ok' : 'err');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${icon('play', 'sm')}Jetzt ausführen`;
      }
    });
  }

  $('[data-new]', root).onclick = async () => {
    if (dirty && !(await confirmDialog({ title: 'Änderungen verwerfen?', text: 'Der Job hat ungespeicherte Änderungen.', okText: 'Verwerfen', danger: true }))) return;
    select({ name: '', shell: 'bash', timeout: 120, body: '', agentIds: [], voice: true });
  };
  load().catch((e) => toast(e.message, 'err'));

  // Änderungen von anderen Geräten oder letzte Ausführung (z.B. per Telefon) übernehmen
  const offJobs = api.on('jobs', async () => {
    try {
      jobs = await api.get('/api/jobs');
      drawList();
    } catch {}
  });
  return () => offJobs();
}
