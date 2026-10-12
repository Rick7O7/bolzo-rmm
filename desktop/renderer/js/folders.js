// Ordnerstruktur für Clients: Baum links in der Client-Liste, Verschieben per Menü oder Drag & Drop
import { api, LS } from './api.js';
import { icon, esc, el, $, $$, toast, confirmDialog, promptDialog, modal } from './ui.js';

export const folderById = (id) => api.folders.find((f) => f.id === id);

// Auswahl an Symbolen und Farben für Ordner
export const FOLDER_ICONS = ['folder', 'home', 'building', 'briefcase', 'server', 'database', 'cloud', 'monitor', 'laptop', 'gamepad',
  'users', 'globe', 'network', 'wifi', 'shield', 'lock', 'code', 'terminal', 'box', 'printer', 'camera', 'star', 'heart', 'flag', 'rocket', 'zap', 'linux', 'windows'];
export const FOLDER_COLORS = ['', '#4797ff', '#22b8cf', '#2fbf71', '#f0a63a', '#e8853a', '#ef5c5c', '#d36ba6', '#9a7cf6'];
// Symbol eines Ordners als HTML (mit Farbe)
export const folderIcon = (f, size = 'sm') => `<span class="f-ic" ${f?.color ? `style="color:${f.color}"` : ''}>${icon(f?.icon && FOLDER_ICONS.includes(f.icon) ? f.icon : 'folder', size)}</span>`;

export function styleDialog(id) {
  const f = folderById(id);
  if (!f) return;
  let ic = f.icon || 'folder';
  let col = f.color || '';
  const { el: m, close } = modal({
    title: `Symbol für „${f.name}“`,
    body: `<div class="fs-preview" data-prev></div>
      <div class="field"><label>Symbol</label><div class="fs-grid" data-icons>${FOLDER_ICONS.map((n) => `<button class="fs-ic" data-ic="${n}" title="${n}">${icon(n)}</button>`).join('')}</div></div>
      <div class="field"><label>Farbe</label><div class="fs-colors" data-colors>${FOLDER_COLORS.map((c) => `<button class="fs-col ${c ? '' : 'none'}" data-col="${c}" style="${c ? `background:${c}` : ''}" title="${c || 'Standard'}"></button>`).join('')}</div></div>`,
    foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>`,
  });
  const draw = () => {
    $('[data-prev]', m).innerHTML = `${folderIcon({ icon: ic, color: col }, 'lg')}<span>${esc(f.name)}</span>`;
    $$('[data-ic]', m).forEach((b) => { b.classList.toggle('on', b.dataset.ic === ic); b.style.color = b.dataset.ic === ic && col ? col : ''; });
    $$('[data-col]', m).forEach((b) => b.classList.toggle('on', b.dataset.col === col));
  };
  $('[data-icons]', m).onclick = (e) => { const b = e.target.closest('[data-ic]'); if (b) { ic = b.dataset.ic; draw(); } };
  $('[data-colors]', m).onclick = (e) => { const b = e.target.closest('[data-col]'); if (b) { col = b.dataset.col; draw(); } };
  $('[data-save]', m).onclick = async () => {
    try { await api.patch(`/api/folders/${id}`, { icon: ic === 'folder' ? '' : ic, color: col }); close(); } catch (e) { toast(e.message, 'err'); }
  };
  draw();
}

export function folderPath(id) {
  const parts = [];
  for (let f = folderById(id), i = 0; f && i < 50; f = folderById(f.parentId), i++) parts.unshift(f.name);
  return parts.join(' / ');
}

// Alle Ordner-IDs unterhalb (einschließlich) eines Ordners
export function subtreeIds(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of api.folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

// Flache Liste in Baum-Reihenfolge: [{ folder, depth }]
export function flatTree() {
  const kids = new Map();
  for (const f of api.folders) {
    const k = f.parentId && folderById(f.parentId) ? f.parentId : null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(f);
  }
  for (const l of kids.values()) l.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const out = [];
  const walk = (pid, depth) => { for (const f of kids.get(pid) || []) { out.push({ folder: f, depth, hasKids: kids.has(f.id) }); walk(f.id, depth + 1); } };
  walk(null, 0);
  return out;
}

export async function moveAgents(ids, folderId) {
  if (!ids.length) return;
  try {
    await api.post('/api/agents/move', { ids, folderId: folderId || null });
    toast(`${ids.length === 1 ? '1 Client' : `${ids.length} Clients`} → ${folderId ? folderPath(folderId) : 'ohne Ordner'}`);
  } catch (e) { toast(e.message, 'err'); }
}

function menu(anchor, items, onPick) {
  document.querySelector('.menu.folder-menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const m = el(`<div class="menu folder-menu" style="top:${Math.min(r.bottom + 6, window.innerHeight - 320)}px;left:${Math.min(r.left, window.innerWidth - 260)}px;max-height:300px;overflow:auto">
    ${items.map((i) => (i.sep ? '<div class="menu-sep"></div>' : `<button class="menu-item ${i.danger ? 'danger' : ''}" data-k="${esc(i.k)}" style="padding-left:${10 + (i.depth || 0) * 14}px">${i.folder ? folderIcon(i.folder) : icon(i.icon || 'folder', 'sm')}${esc(i.label)}</button>`)).join('')}</div>`);
  document.body.append(m);
  const close = () => { m.remove(); document.removeEventListener('mousedown', outside); };
  const outside = (e) => !m.contains(e.target) && close();
  setTimeout(() => document.addEventListener('mousedown', outside));
  m.onclick = (e) => { const k = e.target.closest('[data-k]')?.dataset.k; if (k == null) return; close(); onPick(k); };
}

// Menü "In Ordner verschieben" (für Bulk-Auswahl und Client-Detail)
export function moveMenu(anchor, ids) {
  const items = [{ k: '__none', label: 'Ohne Ordner', icon: 'x' }, ...(api.folders.length ? [{ sep: true }] : []),
    ...flatTree().map(({ folder, depth }) => ({ k: folder.id, label: folder.name, depth, folder }))];
  if (!api.folders.length) items.push({ sep: true }, { k: '__new', label: 'Neuer Ordner ...', icon: 'folderPlus' });
  menu(anchor, items, async (k) => {
    if (k === '__new') {
      const f = await createFolder(null);
      if (f) moveAgents(ids, f.id);
      return;
    }
    moveAgents(ids, k === '__none' ? null : k);
  });
}

export async function createFolder(parentId) {
  const name = await promptDialog({ title: parentId ? `Unterordner in „${folderPath(parentId)}“` : 'Neuer Ordner', label: 'Name', okText: 'Anlegen' });
  if (!name?.trim()) return null;
  try { return await api.post('/api/folders', { name: name.trim(), parentId }); } catch (e) { toast(e.message, 'err'); return null; }
}

// ---------- Baum ----------
// onSelect(key): key = 'all' | 'none' | Ordner-ID
export function renderFolderTree(box, { selected, onSelect }) {
  const collapsed = new Set(LS.get('folders.collapsed', []));
  const saveCollapsed = () => LS.set('folders.collapsed', [...collapsed]);

  function counts() {
    const direct = new Map();
    let none = 0;
    for (const a of api.agents.values()) {
      if (a.folderId && folderById(a.folderId)) direct.set(a.folderId, (direct.get(a.folderId) || 0) + 1);
      else none++;
    }
    const total = (id) => [...subtreeIds(id)].reduce((s, x) => s + (direct.get(x) || 0), 0);
    return { total, none };
  }

  function draw() {
    if (selected !== 'all' && selected !== 'none' && !folderById(selected)) selected = 'all';
    const c = counts();
    const list = flatTree();
    const hidden = new Set();
    for (const { folder } of list) if (collapsed.has(folder.id)) for (const id of subtreeIds(folder.id)) if (id !== folder.id) hidden.add(id);
    const html = `
      <div class="ft-head">Ordner<span class="grow"></span><button class="btn ghost sm icon-only" data-new title="Neuer Ordner">${icon('folderPlus', 'sm')}</button></div>
      <div class="ft-item ${selected === 'all' ? 'on' : ''}" data-sel="all" data-drop="root">${icon('grid', 'sm')}<span class="n">Alle Clients</span><span class="c">${api.agents.size}</span></div>
      ${list.filter(({ folder }) => !hidden.has(folder.id)).map(({ folder, depth, hasKids }) => `
        <div class="ft-item ${selected === folder.id ? 'on' : ''}" data-sel="${folder.id}" data-drop="${folder.id}" draggable="true" style="padding-left:${8 + depth * 14}px">
          <button class="ft-caret ${hasKids ? '' : 'none'}" data-caret="${folder.id}">${hasKids ? icon(collapsed.has(folder.id) ? 'chevron' : 'chev', 'sm') : ''}</button>
          ${folderIcon(folder)}<span class="n">${esc(folder.name)}</span><span class="c">${c.total(folder.id) || ''}</span>
          <button class="ft-more" data-more="${folder.id}" title="Ordner bearbeiten">⋯</button>
        </div>`).join('')}
      <div class="ft-item ${selected === 'none' ? 'on' : ''}" data-sel="none" data-drop="none">${icon('monitor', 'sm')}<span class="n muted">Ohne Ordner</span><span class="c">${c.none || ''}</span></div>
      ${!api.folders.length ? '<div class="ft-hint">Ordner anlegen mit <b>+</b>, dann Clients aus der Liste hierher ziehen.</div>' : ''}`;
    // Nur bei Änderungen neu zeichnen: Statusmeldungen der Clients kommen alle paar Sekunden, und ein
    // Neuzeichnen zwischen Maus-Drücken und -Loslassen hat Klicks auf Ordner verschluckt
    if (html === lastHtml) return;
    lastHtml = html;
    box.innerHTML = html;
  }
  let lastHtml = '';

  async function folderMenu(anchor, id) {
    const f = folderById(id);
    menu(anchor, [
      { k: 'sub', label: 'Unterordner anlegen', icon: 'folderPlus' },
      { k: 'rename', label: 'Umbenennen', icon: 'edit' },
      { k: 'style', label: 'Symbol & Farbe', icon: 'star' },
      { k: 'root', label: 'Auf oberste Ebene verschieben', icon: 'up' },
      { sep: true },
      { k: 'delete', label: 'Ordner löschen', icon: 'trash', danger: true },
    ].filter((i) => i.k !== 'root' || f.parentId), async (k) => {
      try {
        if (k === 'sub') return createFolder(id);
        if (k === 'style') return styleDialog(id);
        if (k === 'rename') {
          const name = await promptDialog({ title: 'Ordner umbenennen', label: 'Name', value: f.name });
          if (name?.trim()) await api.patch(`/api/folders/${id}`, { name: name.trim() });
        }
        if (k === 'root') await api.patch(`/api/folders/${id}`, { parentId: null });
        if (k === 'delete') {
          if (!(await confirmDialog({ title: `Ordner „${f.name}“ löschen?`, text: 'Clients und Unterordner darin werden eine Ebene nach oben verschoben – es wird nichts gelöscht außer dem Ordner selbst.', okText: 'Löschen', danger: true }))) return;
          await api.del(`/api/folders/${id}`);
        }
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new]')) return createFolder(null);
    const caret = e.target.closest('[data-caret]');
    if (caret) {
      const id = caret.dataset.caret;
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      saveCollapsed();
      return draw();
    }
    const more = e.target.closest('[data-more]');
    if (more) return folderMenu(more, more.dataset.more);
    const it = e.target.closest('[data-sel]');
    if (it) { selected = it.dataset.sel; draw(); onSelect(selected); }
  });
  box.addEventListener('contextmenu', (e) => {
    const it = e.target.closest('[data-sel]');
    if (!it || it.dataset.sel === 'all' || it.dataset.sel === 'none') return;
    e.preventDefault();
    folderMenu(it, it.dataset.sel);
  });

  // Drag & Drop: Clients (aus der Liste) oder Ordner (im Baum) auf einen Ordner ziehen
  box.addEventListener('dragstart', (e) => {
    const it = e.target.closest('[data-sel]');
    if (!it || !folderById(it.dataset.sel)) return;
    e.dataTransfer.setData('text/x-bolzo-folder', it.dataset.sel);
    e.dataTransfer.effectAllowed = 'move';
  });
  const dropTarget = (e) => e.target.closest('[data-drop]');
  box.addEventListener('dragover', (e) => {
    const t = dropTarget(e);
    const types = e.dataTransfer.types;
    if (!t || !(types.includes('text/x-bolzo-agents') || (types.includes('text/x-bolzo-folder') && t.dataset.drop !== 'none'))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.ft-item.drop', box).forEach((x) => x !== t && x.classList.remove('drop'));
    t.classList.add('drop');
  });
  box.addEventListener('dragleave', (e) => { const t = dropTarget(e); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop'); });
  box.addEventListener('drop', async (e) => {
    const t = dropTarget(e);
    $$('.ft-item.drop', box).forEach((x) => x.classList.remove('drop'));
    if (!t) return;
    e.preventDefault();
    const target = t.dataset.drop;
    const agents = e.dataTransfer.getData('text/x-bolzo-agents');
    if (agents) return moveAgents(JSON.parse(agents), target === 'root' || target === 'none' ? null : target);
    const fid = e.dataTransfer.getData('text/x-bolzo-folder');
    if (fid && fid !== target) {
      try { await api.patch(`/api/folders/${fid}`, { parentId: target === 'root' ? null : target }); } catch (err) { toast(err.message, 'err'); }
    }
  });

  draw();
  const off1 = api.on('folders', draw);
  const off2 = api.on('agents', () => { if (!box.querySelector('.ft-item.drop')) draw(); });
  return { destroy() { off1(); off2(); }, get selected() { return selected; } };
}
