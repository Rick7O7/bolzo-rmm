// Dialog „Symbol & Tags“: eigenes Symbol, Farbe und Tags eines BOLZO-Clients
import { api } from './api.js';
import { icon, esc, $, $$, toast, modal, tagHtml, clientIcon } from './ui.js';
import { FOLDER_COLORS } from './folders.js';

export const CLIENT_ICONS = ['monitor', 'laptop', 'server', 'database', 'cloud', 'box', 'cpu', 'disk', 'network', 'router', 'wifi', 'globe',
  'shield', 'lock', 'gamepad', 'tv', 'film', 'music', 'camera', 'printer', 'phone', 'home', 'building', 'briefcase', 'users', 'terminal',
  'code', 'star', 'heart', 'flag', 'rocket', 'zap'];

export function clientStyleDialog(id) {
  const a = api.agents.get(id);
  if (!a) return;
  let ic = a.icon || '';
  let col = a.color || '';
  let tags = [...(a.tags || [])];
  // Tags, die es bei anderen Clients schon gibt – ein Klick übernimmt sie (gleiche Schreibweise)
  const known = [...new Set([...api.agents.values()].flatMap((x) => x.tags || []))].sort((x, y) => x.localeCompare(y, 'de'));

  const { el: m, close } = modal({
    title: `Symbol & Tags für „${a.name}“`,
    body: `<div class="fs-preview" data-prev></div>
      <div class="field"><label>Symbol</label><div class="fs-grid" data-icons>
        <button class="fs-ic" data-ic="" title="Automatisch (nach Betriebssystem)">${clientIcon({ ...a, icon: '', color: '' })}</button>
        ${CLIENT_ICONS.map((n) => `<button class="fs-ic" data-ic="${n}" title="${n}">${icon(n)}</button>`).join('')}</div></div>
      <div class="field"><label>Farbe</label><div class="fs-colors" data-colors>${FOLDER_COLORS.map((c) => `<button class="fs-col ${c ? '' : 'none'}" data-col="${c}" style="${c ? `background:${c}` : ''}" title="${c || 'Standard'}"></button>`).join('')}</div></div>
      <div class="field"><label>Tags</label>
        <div class="tag-row" data-tags style="margin-bottom:8px"></div>
        <input class="input" placeholder="Tag eingeben + Enter (z.B. Spiele, Büro)" data-newtag>
        <div class="tag-row cs-suggest" data-suggest style="margin-top:8px"></div></div>`,
    foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>`,
  });

  const addTag = (t) => {
    t = t.trim().slice(0, 32);
    if (!t) return;
    const same = tags.find((x) => x.toLowerCase() === t.toLowerCase()) || known.find((x) => x.toLowerCase() === t.toLowerCase());
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(same || t);
    draw();
  };
  function draw() {
    const look = { ...a, icon: ic, color: col };
    $('[data-prev]', m).innerHTML = `<span class="f-ic">${clientIcon(look)}</span><span class="grow">${esc(a.name)}</span>`;
    $$('[data-ic]', m).forEach((b) => { b.classList.toggle('on', b.dataset.ic === ic); b.style.color = b.dataset.ic === ic && col ? col : ''; });
    $$('[data-col]', m).forEach((b) => b.classList.toggle('on', b.dataset.col === col));
    $('[data-tags]', m).innerHTML = tags.map((t) => tagHtml(t, { removable: true })).join('') || '<span class="muted" style="font-size:12.5px">Noch keine Tags</span>';
    const rest = known.filter((t) => !tags.includes(t));
    $('[data-suggest]', m).innerHTML = rest.length
      ? `<span class="muted" style="font-size:12px;align-self:center">Vorhanden:</span>${rest.map((t) => `<button class="cs-add" data-add="${esc(t)}" title="Hinzufügen">${tagHtml(t, { small: true })}</button>`).join('')}`
      : '';
  }
  $('[data-icons]', m).onclick = (e) => { const b = e.target.closest('[data-ic]'); if (b) { ic = b.dataset.ic; draw(); } };
  $('[data-colors]', m).onclick = (e) => { const b = e.target.closest('[data-col]'); if (b) { col = b.dataset.col; draw(); } };
  $('[data-tags]', m).onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { tags = tags.filter((t) => t !== b.dataset.rm); draw(); } };
  $('[data-suggest]', m).onclick = (e) => { const b = e.target.closest('[data-add]'); if (b) addTag(b.dataset.add); };
  $('[data-newtag]', m).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addTag(e.target.value);
    e.target.value = '';
  });
  $('[data-save]', m).onclick = async () => {
    const pending = $('[data-newtag]', m).value; // eingetippt, aber Enter vergessen
    if (pending.trim()) addTag(pending);
    try {
      await api.patch(`/api/agents/${id}`, { icon: ic, color: col, tags });
      close();
      toast('Gespeichert');
    } catch (e) { toast(e.message, 'err'); }
  };
  draw();
}
