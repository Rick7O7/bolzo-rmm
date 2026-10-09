import { api } from '../api.js';
import { icon, esc, $, $$, toast, confirmDialog, modal, enableTabIndent, osIcon, exitBadge } from '../ui.js';

const SHELLS = { powershell: 'PowerShell', cmd: 'CMD', bash: 'Bash', sh: 'sh', python: 'Python' };
// Auf welchen Plattformen eine Shell läuft
const COMPAT = { powershell: ['win32'], cmd: ['win32'], bash: ['linux', 'darwin'], sh: ['linux', 'darwin'], python: ['win32', 'linux', 'darwin'] };

export function renderScripts(root) {
  let scripts = [];
  let current = null; // ausgewähltes Skript (oder neues)

  root.innerHTML = `
    <div class="page-head">
      <h1>Skripte</h1><span class="sub">Bibliothek für wiederkehrende Aufgaben</span>
      <span class="spacer"></span>
      <button class="btn primary" data-new>${icon('plus')}Neues Skript</button>
    </div>
    <div class="scripts-layout">
      <div class="card script-list" data-list></div>
      <div data-editor></div>
    </div>`;

  async function load(selectId) {
    scripts = await api.get('/api/scripts');
    drawList();
    const s = scripts.find((x) => x.id === (selectId ?? current?.id)) || scripts[0];
    if (s) select(s);
    else drawEmpty();
  }

  function drawList() {
    $('[data-list]', root).innerHTML = scripts.length
      ? scripts.map((s) => `<div class="script-item ${current?.id === s.id ? 'on' : ''}" data-id="${s.id}"><div class="n">${esc(s.name)}<span class="badge" style="margin-left:auto;height:19px;font-size:11px">${SHELLS[s.shell]}</span></div><div class="d">${esc(s.description || '—')}</div></div>`).join('')
      : `<div class="empty" style="padding:24px">Noch keine Skripte</div>`;
    $$('.script-item', root).forEach((i) => (i.onclick = () => select(scripts.find((s) => s.id === i.dataset.id))));
  }

  function drawEmpty() {
    $('[data-editor]', root).innerHTML = `<div class="card empty">${icon('code')}<h3>Kein Skript ausgewählt</h3><div>Lege ein neues Skript an.</div></div>`;
  }

  function select(s) {
    current = s;
    drawList();
    const isNew = !s.id;
    const ed = $('[data-editor]', root);
    ed.innerHTML = `
      <div class="card">
        <div class="card-head">${icon('edit', 'sm')}<h3>${isNew ? 'Neues Skript' : 'Skript bearbeiten'}</h3><span class="spacer"></span>
          ${isNew ? '' : `<button class="btn primary sm" data-runon>${icon('play', 'sm')}Ausführen auf ...</button>`}
        </div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div class="form-grid">
            <div class="field"><label>Name</label><input class="input" data-f="name" value="${esc(s.name || '')}" placeholder="z.B. Updates installieren"></div>
            <div class="field"><label>Shell</label><select class="select" data-f="shell">${Object.entries(SHELLS).map(([k, v]) => `<option value="${k}" ${s.shell === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="field"><label>Timeout (s)</label><input class="input" type="number" min="5" max="7200" data-f="timeout" value="${s.timeout || 300}"></div>
          </div>
          <div class="field"><label>Beschreibung</label><input class="input" data-f="description" value="${esc(s.description || '')}" placeholder="Was macht das Skript?"></div>
          <div class="field"><label>Inhalt</label><textarea class="textarea code editor" spellcheck="false" data-f="body" style="min-height:380px"></textarea>
            <span class="hint" data-compat></span></div>
          <div class="row">
            ${isNew ? '' : `<button class="btn danger" data-del>${icon('trash', 'sm')}Löschen</button>`}
            <span class="grow"></span>
            <button class="btn primary" data-save>${icon('check', 'sm')}Speichern</button>
          </div>
        </div>
      </div>`;
    const body = $('[data-f="body"]', ed);
    body.value = s.body || '';
    enableTabIndent(body);
    const compat = () => {
      const sh = $('[data-f="shell"]', ed).value;
      $('[data-compat]', ed).textContent = `Läuft auf: ${COMPAT[sh].map((p) => ({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[p])).join(', ')}${sh === 'python' ? ' (Python muss installiert sein)' : ''}`;
    };
    $('[data-f="shell"]', ed).onchange = compat;
    compat();
    body.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); }
    });

    async function save() {
      const data = Object.fromEntries($$('[data-f]', ed).map((i) => [i.dataset.f, i.value]));
      data.timeout = Number(data.timeout);
      try {
        const saved = isNew ? await api.post('/api/scripts', data) : await api.put(`/api/scripts/${s.id}`, data);
        toast('Skript gespeichert');
        await load(saved.id);
      } catch (e) { toast(e.message, 'err'); }
    }
    $('[data-save]', ed).onclick = save;
    $('[data-del]', ed)?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Skript löschen?', text: `„${esc(s.name)}“ wird endgültig gelöscht.`, okText: 'Löschen', danger: true }))) return;
      await api.del(`/api/scripts/${s.id}`);
      current = null;
      toast('Skript gelöscht');
      load();
    });
    $('[data-runon]', ed)?.addEventListener('click', () => runScriptDialog({ script: s }));
  }

  $('[data-new]', root).onclick = () => select({ name: '', shell: 'bash', timeout: 300, body: '' });
  load().catch((e) => toast(e.message, 'err'));
}

// Dialog: Skript auswählen (falls nicht vorgegeben), Clients wählen, ausführen, Ergebnisse zeigen.
export async function runScriptDialog({ script = null, preselect = [] } = {}) {
  const scripts = script ? [script] : await api.get('/api/scripts').catch(() => []);
  if (!scripts.length) return toast('Keine Skripte vorhanden – lege zuerst eines an', 'err');
  let s = script || scripts[0];
  const selected = new Set(preselect);

  const m = modal({
    title: 'Skript ausführen',
    wide: true,
    body: `
      ${script ? '' : `<div class="field"><label>Skript</label><select class="select" data-script>${scripts.map((x) => `<option value="${x.id}">${esc(x.name)} (${SHELLS[x.shell]})</option>`).join('')}</select></div>`}
      <div class="field"><label class="row" style="justify-content:space-between"><span>Clients</span><span><button class="btn ghost sm" data-allon>Alle passenden online</button><button class="btn ghost sm" data-none>Keine</button></span></label><div class="pick-list" data-pick></div></div>
      <div data-results style="display:flex;flex-direction:column;gap:10px"></div>`,
    foot: `<button class="btn" data-close>Schließen</button><button class="btn primary" data-go>${icon('play', 'sm')}Ausführen</button>`,
  });

  const fits = (a) => a.online && COMPAT[s.shell].includes(a.platform);
  function drawPick() {
    const agents = [...api.agents.values()].sort((a, b) => fits(b) - fits(a) || a.name.localeCompare(b.name));
    for (const id of selected) if (!agents.find((a) => a.id === id && fits(a))) selected.delete(id);
    $('[data-pick]', m.el).innerHTML = agents.map((a) => `<label class="pick-item ${fits(a) ? '' : 'disabled'}">
      <input type="checkbox" class="check" value="${a.id}" ${selected.has(a.id) ? 'checked' : ''} ${fits(a) ? '' : 'disabled'}>
      <span class="os">${osIcon(a.platform)}</span><span class="grow">${esc(a.name)}</span>
      <span class="muted" style="font-size:12px">${!a.online ? 'offline' : fits(a) ? esc(a.os) : 'passt nicht zur Shell'}</span></label>`).join('') || '<div class="empty">Keine Clients</div>';
    $('[data-go]', m.el).disabled = !selected.size;
  }
  $('[data-pick]', m.el).addEventListener('change', (e) => {
    if (e.target.checked) selected.add(e.target.value);
    else selected.delete(e.target.value);
    $('[data-go]', m.el).disabled = !selected.size;
  });
  $('[data-script]', m.el)?.addEventListener('change', (e) => { s = scripts.find((x) => x.id === e.target.value); drawPick(); });
  $('[data-allon]', m.el).onclick = () => { for (const a of api.agents.values()) if (fits(a)) selected.add(a.id); drawPick(); };
  $('[data-none]', m.el).onclick = () => { selected.clear(); drawPick(); };
  drawPick();

  $('[data-go]', m.el).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `${icon('refresh', 'sm spin')}Läuft auf ${selected.size} Client(s) ...`;
    const res = $('[data-results]', m.el);
    res.innerHTML = '';
    try {
      const results = await api.post(`/api/scripts/${s.id}/run`, { agentIds: [...selected] });
      res.innerHTML = `<div class="section-title" style="margin:6px 0 0">Ergebnisse</div>` + results.map((r, i) => `
        <div class="result"><div class="result-head" data-i="${i}"><span class="grow" style="font-weight:500">${esc(r.hostname)}</span>${exitBadge(r)}</div>
        <pre class="output" ${results.length > 3 ? 'style="display:none"' : ''}>${esc(r.error ? `Fehler: ${r.error}` : r.output || '(keine Ausgabe)')}</pre></div>`).join('');
      $$('.result-head', res).forEach((h) => (h.onclick = () => { const o = h.nextElementSibling; o.style.display = o.style.display === 'none' ? '' : 'none'; }));
      const ok = results.filter((r) => !r.error && r.exitCode === 0).length;
      toast(`${ok} von ${results.length} erfolgreich`, ok === results.length ? 'ok' : 'err');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('play', 'sm')}Erneut ausführen`;
    }
  };
}
