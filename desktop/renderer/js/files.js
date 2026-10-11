// Dateimanager eines Clients: Laufwerke/Ordner durchsuchen, Ordner anlegen, umbenennen, löschen,
// Dateien vom PC hineinziehen (auch ganze Ordner) und aus der App auf den PC ziehen.
import { api, LS } from './api.js';
import { icon, esc, el, $, $$, toast, confirmDialog, promptDialog, fmtBytes } from './ui.js';

const CHUNK = 512 * 1024;
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const fsCall = (id, op, params) => api.post(`/api/agents/${id}/files`, { op, ...params });

// ---------- Übertragungen (unten rechts) ----------
let tray = null;
function transferTray() {
  if (tray && document.body.contains(tray)) return tray;
  tray = el('<div class="xfer-tray" hidden><div class="xfer-head"><span data-title>Übertragungen</span><span class="grow"></span><button class="btn ghost sm icon-only" data-close title="Ausblenden">' + icon('x', 'sm') + '</button></div><div class="xfer-list"></div></div>');
  document.body.append(tray);
  $('[data-close]', tray).onclick = () => { tray.hidden = true; $('.xfer-list', tray).innerHTML = ''; };
  return tray;
}
function transferRow(name, size) {
  const t = transferTray();
  t.hidden = false;
  const row = el(`<div class="xfer"><div class="xfer-top"><span class="n">${icon('upload', 'sm')}${esc(name)}</span><span class="s" data-s>0 %</span><button class="btn ghost sm icon-only" data-cancel title="Abbrechen">${icon('x', 'sm')}</button></div><div class="xfer-bar"><i data-bar></i></div></div>`);
  $('.xfer-list', t).prepend(row);
  return {
    row,
    progress(done) { const p = size ? Math.min(100, (100 * done) / size) : 100; $('[data-bar]', row).style.width = `${p}%`; $('[data-s]', row).textContent = `${Math.floor(p)} % · ${fmtBytes(done)} / ${fmtBytes(size)}`; },
    finish(ok, msg) { row.classList.add(ok ? 'ok' : 'err'); $('[data-s]', row).textContent = msg; $('[data-cancel]', row)?.remove(); },
  };
}

// Eine Datei über einen eigenen WebSocket hochladen (kein Größenlimit durch nginx)
async function uploadFile(agentId, dir, file, name = file.name) {
  const ui = transferRow(name, file.size);
  let ws = null;
  let cancelled = false;
  $('[data-cancel]', ui.row).onclick = () => { cancelled = true; try { ws?.close(); } catch {} };
  try {
    const { sid } = await api.post(`/api/agents/${agentId}/files/upload`, { dir, name, size: file.size });
    ws = new WebSocket(`${api.server.replace(/^http/, 'ws')}/ws/stream?token=${encodeURIComponent(api.token)}&sid=${encodeURIComponent(sid)}`);
    ws.binaryType = 'arraybuffer';
    const result = new Promise((resolve, reject) => {
      ws.onmessage = (e) => { if (typeof e.data === 'string') { try { resolve(JSON.parse(e.data)); } catch { resolve({}); } } };
      ws.onclose = () => reject(new Error(cancelled ? 'Abgebrochen' : 'Verbindung getrennt'));
      ws.onerror = () => reject(new Error('Verbindung fehlgeschlagen'));
    });
    await new Promise((r, j) => { ws.onopen = r; ws.addEventListener('error', () => j(new Error('Verbindung fehlgeschlagen')), { once: true }); });
    for (let i = 0; i < file.size; i += CHUNK) {
      if (cancelled) throw new Error('Abgebrochen');
      ws.send(await file.slice(i, i + CHUNK).arrayBuffer());
      while (ws.bufferedAmount > 8 * 1024 * 1024 && !cancelled) await new Promise((r) => setTimeout(r, 30));
      ui.progress(i + CHUNK - ws.bufferedAmount);
    }
    ws.send('EOF');
    const r = await result;
    if (r.error) throw new Error(r.error);
    ui.progress(file.size);
    ui.finish(true, `fertig · ${fmtBytes(file.size)}`);
    try { ws.close(); } catch {}
    return true;
  } catch (e) {
    ui.finish(false, e.message);
    try { ws?.close(); } catch {}
    return false;
  }
}

// Gezogene Elemente (Dateien und Ordner) rekursiv einsammeln
async function collectDropped(dt) {
  const out = []; // { rel: 'ordner/unter', file } oder { rel, dir: true }
  const readAll = (reader) => new Promise((resolve) => {
    const all = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) return resolve(all); all.push(...batch); next(); }, () => resolve(all));
    next();
  });
  const walk = async (entry, rel) => {
    if (entry.isFile) await new Promise((r) => entry.file((f) => { out.push({ rel, file: f }); r(); }, r));
    else if (entry.isDirectory) {
      const sub = rel ? `${rel}/${entry.name}` : entry.name;
      out.push({ rel: sub, dir: true });
      for (const e of await readAll(entry.createReader())) await walk(e, sub);
    }
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e, '');
  else for (const f of dt.files) out.push({ rel: '', file: f });
  return out;
}

export function renderFiles(body, agentId) {
  const agent = () => api.agents.get(agentId);
  const lsKey = `files.path.${agentId}`;
  let cur = LS.get(lsKey, null);
  let data = null;
  const selected = new Set();

  body.innerHTML = `
    <div class="card fm">
      <div class="fm-bar">
        <button class="btn sm icon-only" data-up title="Eine Ebene höher">${icon('up', 'sm')}</button>
        <button class="btn sm icon-only" data-reload title="Aktualisieren">${icon('refresh', 'sm')}</button>
        <div class="fm-crumbs" data-crumbs title="Doppelklick: Pfad eingeben"></div>
        <span class="grow"></span>
        <div class="fm-sel" data-selbar hidden><span class="muted" data-selcount></span>
          <button class="btn sm" data-dlsel>${icon('download', 'sm')}Herunterladen</button>
          <button class="btn sm danger" data-delsel>${icon('trash', 'sm')}Löschen</button></div>
        <button class="btn sm" data-mkdir>${icon('folderPlus', 'sm')}Neuer Ordner</button>
        <button class="btn sm primary" data-pick>${icon('upload', 'sm')}Hochladen</button>
        <input type="file" multiple hidden data-file>
      </div>
      <div class="fm-body" data-drop>
        <table class="tbl fm-tbl"><thead><tr><th style="width:34px"><input type="checkbox" class="check" data-all></th><th>Name</th><th class="r">Größe</th><th>Geändert</th><th></th></tr></thead><tbody></tbody></table>
        <div class="fm-dropzone">${icon('upload')}<div>Hier ablegen zum Hochladen nach<br><b data-droppath></b></div></div>
      </div>
      <div class="fm-foot muted" data-foot></div>
    </div>`;
  const tbody = $('tbody', body);

  async function load(path = cur, { keepSel = false } = {}) {
    if (!agent()?.online) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty">${icon('monitor')}<h3>Client ist offline</h3></div></td></tr>`;
      return;
    }
    try {
      data = await fsCall(agentId, 'list', { path: path ?? (agent().platform === 'win32' ? '' : '/') });
    } catch (e) {
      if (path) { toast(e.message, 'err'); if (data) return; return load(null); }
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty err-text">${esc(e.message)}</div></td></tr>`;
      return;
    }
    cur = data.path;
    LS.set(lsKey, cur);
    if (!keepSel) selected.clear();
    draw();
  }

  function crumbs() {
    const box = $('[data-crumbs]', body);
    const win = data.sep === '\\';
    const parts = [];
    if (win) parts.push({ label: 'Laufwerke', path: '' });
    if (data.path) {
      const segs = data.path.split(/[\\/]/).filter(Boolean);
      let acc = win ? '' : '/';
      if (!win) parts.push({ label: '/', path: '/' });
      segs.forEach((s, i) => {
        acc = win ? (i === 0 ? `${s}\\` : `${acc}${acc.endsWith('\\') ? '' : '\\'}${s}`) : `${acc}${acc.endsWith('/') ? '' : '/'}${s}`;
        parts.push({ label: s, path: acc });
      });
    }
    box.innerHTML = parts.map((p, i) => `${i ? `<span class="sep">${icon('chevron', 'sm')}</span>` : ''}<button class="crumb-btn" data-go="${esc(p.path)}">${esc(p.label)}</button>`).join('');
    $('[data-droppath]', body).textContent = data.path || '–';
  }

  function draw() {
    crumbs();
    const rows = data.entries;
    const dl = (e) => `${api.server}/api/files/dl?agent=${encodeURIComponent(agentId)}&key=${encodeURIComponent(data.dlKey)}&path=${encodeURIComponent(e.path)}`;
    tbody.innerHTML = rows.map((e) => {
      const isDir = e.type === 'dir' || e.type === 'drive';
      return `<tr class="click ${selected.has(e.path) ? 'sel' : ''}" data-p="${esc(e.path)}" data-dir="${isDir ? 1 : ''}" ${e.type === 'file' ? `draggable="true" data-dl="${esc(dl(e))}"` : ''}>
        <td>${e.type === 'drive' ? '' : `<input type="checkbox" class="check" data-sel ${selected.has(e.path) ? 'checked' : ''}>`}</td>
        <td><span class="fm-name">${icon(e.type === 'drive' ? 'disk' : isDir ? 'folder' : 'file', 'sm')}<span class="${isDir ? 'dir' : ''}">${esc(e.name)}</span>${e.link ? '<span class="muted" style="font-size:11px">Verknüpfung</span>' : ''}</span></td>
        <td class="r num muted">${e.type === 'file' ? fmtBytes(e.size) : ''}</td>
        <td class="muted num">${e.type === 'drive' ? '' : fmtDate(e.mtime)}</td>
        <td class="actions">${e.type === 'drive' ? '' : `
          ${e.type === 'file' ? `<a class="btn sm ghost icon-only" href="${esc(dl(e))}" download="${esc(e.name)}" title="Herunterladen">${icon('download', 'sm')}</a>` : ''}
          <button class="btn sm ghost icon-only" data-rename title="Umbenennen">${icon('edit', 'sm')}</button>
          <button class="btn sm ghost icon-only" data-del title="Löschen">${icon('trash', 'sm')}</button>`}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="5"><div class="empty">${icon('folder')}<h3>Leerer Ordner</h3><div>Dateien vom PC hierher ziehen, um sie hochzuladen.</div></div></td></tr>`;
    const dirs = rows.filter((e) => e.type === 'dir').length;
    $('[data-foot]', body).textContent = data.path ? `${dirs} Ordner · ${rows.length - dirs} Dateien${data.truncated ? ' · nur die ersten 5000 Einträge' : ''}` : `${rows.length} Laufwerke`;
    $('[data-up]', body).disabled = data.parent == null;
    $('[data-mkdir]', body).disabled = !data.path;
    $('[data-pick]', body).disabled = !data.path;
    $('[data-selbar]', body).hidden = !selected.size;
    $('[data-selcount]', body).textContent = `${selected.size} ausgewählt`;
    $('[data-all]', body).checked = rows.length > 0 && rows.filter((e) => e.type !== 'drive').every((e) => selected.has(e.path));
  }

  const join = (dir, name) => (data.sep === '\\' ? `${dir.replace(/\\$/, '')}\\${name}` : `${dir.replace(/\/$/, '')}/${name}`);

  async function uploadAll(items) {
    if (!data?.path) return toast('Bitte zuerst einen Ordner öffnen', 'err');
    const base = data.path;
    let ok = 0;
    for (const it of items.filter((x) => x.dir)) {
      try { await fsCall(agentId, 'mkdir', { path: join(base, it.rel.split('/').join(data.sep)) }); } catch (e) { toast(e.message, 'err'); }
    }
    for (const it of items.filter((x) => x.file)) {
      const dir = it.rel ? join(base, it.rel.split('/').join(data.sep)) : base;
      if (await uploadFile(agentId, dir, it.file)) ok++;
    }
    if (cur === base) load(base, { keepSel: true });
    const files = items.filter((x) => x.file).length;
    if (files > 1) toast(`${ok} von ${files} Dateien hochgeladen`, ok === files ? 'ok' : 'err');
  }

  // ---------- Bedienung ----------
  body.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go) return load(go.dataset.go);
    if (e.target.closest('[data-up]')) return load(data.parent);
    if (e.target.closest('[data-reload]')) return load(cur, { keepSel: true });
    if (e.target.closest('[data-pick]')) return $('[data-file]', body).click();
    if (e.target.closest('[data-mkdir]')) {
      const name = await promptDialog({ title: 'Neuer Ordner', label: `Name (in ${data.path})`, okText: 'Anlegen' });
      if (!name?.trim()) return;
      try { await fsCall(agentId, 'mkdir', { path: join(data.path, name.trim()) }); load(cur); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (e.target.matches('[data-all]')) {
      for (const x of data.entries) if (x.type !== 'drive') e.target.checked ? selected.add(x.path) : selected.delete(x.path);
      return draw();
    }
    if (e.target.closest('[data-delsel]')) return remove([...selected]);
    if (e.target.closest('[data-dlsel]')) {
      const files = data.entries.filter((x) => selected.has(x.path) && x.type === 'file');
      if (!files.length) return toast('Nur Dateien können heruntergeladen werden (keine Ordner)', 'err');
      for (const f of files) { $(`tr[data-p="${CSS.escape(f.path)}"] a[download]`, body)?.click(); await new Promise((r) => setTimeout(r, 300)); }
      return;
    }
    const tr = e.target.closest('tr[data-p]');
    if (!tr) return;
    const entry = data.entries.find((x) => x.path === tr.dataset.p);
    if (e.target.matches('[data-sel]')) { e.target.checked ? selected.add(entry.path) : selected.delete(entry.path); return draw(); }
    if (e.target.closest('[data-del]')) return remove([entry.path]);
    if (e.target.closest('[data-rename]')) {
      const name = await promptDialog({ title: 'Umbenennen', label: 'Neuer Name', value: entry.name });
      if (!name?.trim() || name.trim() === entry.name) return;
      try { await fsCall(agentId, 'rename', { from: entry.path, name: name.trim() }); load(cur); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (e.target.closest('a')) return;
    if (tr.dataset.dir) return load(entry.path);
  });
  body.addEventListener('dblclick', async (e) => {
    if (!e.target.closest('[data-crumbs]')) return;
    const p = await promptDialog({ title: 'Pfad öffnen', label: 'Pfad', value: data?.path || '', okText: 'Öffnen' });
    if (p?.trim()) load(p.trim());
  });
  $('[data-file]', body).addEventListener('change', (e) => {
    const files = [...e.target.files].map((f) => ({ rel: '', file: f }));
    e.target.value = '';
    uploadAll(files);
  });

  async function remove(paths) {
    if (!paths.length) return;
    const names = paths.map((p) => data.entries.find((x) => x.path === p)?.name || p);
    if (!(await confirmDialog({ title: paths.length === 1 ? `„${names[0]}“ löschen?` : `${paths.length} Einträge löschen?`, text: `Wird auf <b>${esc(agent().name)}</b> endgültig gelöscht – Ordner samt Inhalt. Es gibt keinen Papierkorb.${paths.length > 1 ? `<br><span class="muted">${esc(names.slice(0, 8).join(', '))}${names.length > 8 ? ' …' : ''}</span>` : ''}`, okText: 'Löschen', danger: true }))) return;
    try { await fsCall(agentId, 'delete', { paths }); toast('Gelöscht'); load(cur); } catch (err) { toast(err.message, 'err'); }
  }

  // Aus der App auf den PC ziehen: Chromium lädt die Datei per "DownloadURL" an den Zielort
  body.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-dl]');
    if (!tr) return;
    const name = data.entries.find((x) => x.path === tr.dataset.p)?.name || 'datei';
    e.dataTransfer.setData('DownloadURL', `application/octet-stream:${name}:${tr.dataset.dl}`);
    e.dataTransfer.effectAllowed = 'copy';
  });

  // Vom PC in die App ziehen
  const zone = $('[data-drop]', body);
  const isOsDrag = (e) => [...e.dataTransfer.types].includes('Files');
  zone.addEventListener('dragover', (e) => {
    if (!isOsDrag(e) || !data?.path) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragging'); });
  zone.addEventListener('drop', async (e) => {
    zone.classList.remove('dragging');
    if (!isOsDrag(e)) return;
    e.preventDefault();
    uploadAll(await collectDropped(e.dataTransfer));
  });

  load();
  const off = api.on('agent', ({ agent: a, prev }) => { if (a.id === agentId && a.online && prev && !prev.online) load(cur); });
  return off;
}
