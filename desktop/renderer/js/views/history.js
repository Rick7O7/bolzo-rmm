import { api } from '../api.js';
import { icon, esc, $, $$, fmtTime, modal, toast, confirmDialog, exitBadge, throttle } from '../ui.js';

export function showRunResult(r) {
  modal({
    title: `${r.scriptName} · ${r.hostname}`,
    wide: true,
    body: `<div class="row" style="justify-content:space-between"><span class="muted">${fmtTime(r.ts)}</span>${exitBadge(r)}</div>
      <pre class="output" style="max-height:60vh">${esc(r.error ? `Fehler: ${r.error}` : r.output || '(keine Ausgabe)')}</pre>`,
  });
}

// ---------- Protokoll (Audit-Log) ----------
export const AUDIT_CATS = {
  auth: { label: 'Anmeldung', color: '#9085e9' },
  client: { label: 'Client', color: '#3987e5' },
  power: { label: 'Energie', color: '#d95926' },
  action: { label: 'Aktion', color: '#c98500' },
  script: { label: 'Skript', color: '#199e70' },
  shell: { label: 'Terminal', color: '#22a03a' },
  settings: { label: 'Einstellungen', color: '#d55181' },
  system: { label: 'System', color: '#8a8f98' },
  connection: { label: 'Verbindung', color: '#5c7290' },
};
// Standardansicht ohne Online/Offline-Meldungen, die sonst alles überfluten
const WITHOUT_CONN = Object.keys(AUDIT_CATS).filter((c) => c !== 'connection').join(',');
const PAGE = 200;

const catBadge = (cat) => {
  const c = AUDIT_CATS[cat] || { label: cat, color: '#8a8f98' };
  return `<span class="cat-badge" style="--cat-c:${c.color}">${esc(c.label)}</span>`;
};
const okBadge = (e) => (e.ok === false
  ? `<span class="badge critical" title="${esc(e.result || '')}">${icon('x')}${esc(shorten(e.result || 'Fehlgeschlagen', 28))}</span>`
  : `<span class="badge good">${icon('check')}${esc(e.result || 'OK')}</span>`);
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

function showAuditEntry(e) {
  const rows = [
    ['Zeitpunkt', fmtTime(e.ts)],
    ['Kategorie', catBadge(e.cat), true],
    ['Ereignis', e.action],
    ['Client', e.target],
    ['Von', e.actor],
    ['IP-Adresse', e.ip],
    ['Ergebnis', okBadge(e), true],
  ].filter(([, v]) => v);
  const long = e.detail && (e.detail.length > 80 || e.detail.includes('\n'));
  const { el } = modal({
    title: e.action,
    wide: !!long,
    body: `<div class="kv">${rows.map(([k, v, raw]) => `<div class="k">${k}</div><div class="v">${raw ? v : esc(v)}</div>`).join('')}
      ${e.detail && !long ? `<div class="k">Details</div><div class="v">${esc(e.detail)}</div>` : ''}</div>
      ${long ? `<pre class="output" style="max-height:50vh;margin-top:14px">${esc(e.detail)}</pre>` : ''}`,
    foot: e.ref ? `<button class="btn" data-out>${icon('terminal', 'sm')}Ausgabe anzeigen</button>` : '',
  });
  const out = el && $('[data-out]', el);
  if (out) {
    out.onclick = async () => {
      const h = await api.get(`/api/history${e.agentId ? `?agentId=${e.agentId}` : ''}`).catch(() => []);
      const r = h.find((x) => x.id === e.ref);
      if (r) showRunResult(r);
      else toast('Die Ausgabe ist nicht mehr gespeichert (es werden nur die letzten 300 aufbewahrt).', 'err');
    };
  }
}

function toCsv(items) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Zeitpunkt', 'Kategorie', 'Ereignis', 'Client', 'Details', 'Von', 'IP-Adresse', 'Erfolgreich', 'Ergebnis'];
  const lines = items.map((e) => [fmtTime(e.ts), AUDIT_CATS[e.cat]?.label || e.cat, e.action, e.target, e.detail, e.actor, e.ip, e.ok === false ? 'nein' : 'ja', e.result].map(cell).join(';'));
  return '﻿' + [head.map(cell).join(';'), ...lines].join('\r\n'); // BOM + Semikolon: Excel öffnet es direkt richtig
}

// Wiederverwendbar: Verlauf-Seite (alle Clients) und Client-Detail (agentId gesetzt)
export function renderAuditLog(root, { agentId = null } = {}) {
  const clientOptions = () => [...api.agents.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  root.innerHTML = `
    <div class="toolbar">
      <div class="search grow" style="max-width:320px;min-width:200px">${icon('search', 'sm')}<input class="input" placeholder="Suchen (Ereignis, Befehl, IP ...)" data-q></div>
      <select class="select" style="width:auto" data-cat>
        <option value="${WITHOUT_CONN}">Alles außer Verbindungen</option>
        <option value="">Alles</option>
        ${Object.entries(AUDIT_CATS).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('')}
      </select>
      ${agentId ? '' : `<select class="select" style="width:auto;max-width:220px" data-agent><option value="">Alle Clients</option>${clientOptions()}</select>`}
      <label class="row muted" style="gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" data-fails>Nur Fehler</label>
      <span class="spacer grow"></span>
      <button class="btn" data-csv title="Aktuelle Auswahl als CSV speichern">${icon('download', 'sm')}Export</button>
    </div>
    <div class="card table-wrap"><table class="tbl audit-tbl"><thead><tr>
      <th style="width:90px">Uhrzeit</th><th>Ereignis</th>${agentId ? '' : '<th>Client</th>'}<th>Von</th><th class="r">Ergebnis</th>
    </tr></thead><tbody></tbody></table></div>
    <div class="row" style="justify-content:center;margin-top:14px" data-morewrap hidden><button class="btn" data-more>Ältere Einträge laden</button></div>`;

  const cols = agentId ? 4 : 5;
  let items = [];
  let more = false;
  const filters = () => {
    const p = new URLSearchParams();
    const cat = $('[data-cat]', root).value;
    const ag = agentId || $('[data-agent]', root)?.value;
    const q = $('[data-q]', root).value.trim();
    if (cat) p.set('cat', cat);
    if (ag) p.set('agentId', ag);
    if (q) p.set('q', q);
    return p;
  };
  const failsOnly = () => $('[data-fails]', root).checked;

  function draw() {
    const shown = failsOnly() ? items.filter((e) => e.ok === false) : items;
    let lastDay = '';
    const rows = [];
    shown.forEach((e) => {
      const day = dayLabel(e.ts);
      if (day !== lastDay) {
        rows.push(`<tr class="day-row"><td colspan="${cols}">${esc(day)}</td></tr>`);
        lastDay = day;
      }
      rows.push(`<tr class="click${e.ok === false ? ' failed' : ''}" data-id="${esc(e.id)}">
        <td class="num muted" title="${esc(fmtTime(e.ts))}">${new Date(e.ts).toLocaleTimeString('de-DE')}</td>
        <td><div class="audit-ev">${catBadge(e.cat)}<span class="a">${esc(e.action)}</span></div>${e.detail ? `<div class="audit-detail">${esc(shorten(e.detail.split('\n')[0], 140))}</div>` : ''}</td>
        ${agentId ? '' : `<td style="font-weight:500">${esc(e.target || '')}</td>`}
        <td><div>${esc(e.actor || '')}</div>${e.ip ? `<div class="muted" style="font-size:12px">${esc(e.ip)}</div>` : ''}</td>
        <td class="r">${okBadge(e)}</td></tr>`);
    });
    $('tbody', root).innerHTML = rows.join('')
      || `<tr><td colspan="${cols}"><div class="empty">${icon('shield')}<h3>Keine Einträge</h3><div>${items.length ? 'Kein Eintrag passt zum Filter.' : 'Hier erscheint, wer wann was getan hat.'}</div></div></td></tr>`;
    $('[data-morewrap]', root).hidden = !more;
  }

  async function load() {
    try {
      const r = await api.get(`/api/audit?${filters()}&limit=${PAGE}`);
      items = r.items;
      more = r.more;
    } catch (e) {
      toast(e.message, 'err');
      items = [];
      more = false;
    }
    draw();
  }

  $('tbody', root).onclick = (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    const e = tr && items.find((x) => x.id === tr.dataset.id);
    if (e) showAuditEntry(e);
  };
  $('[data-more]', root).onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.get(`/api/audit?${filters()}&limit=${PAGE}&before=${items[items.length - 1].ts}`);
      items = items.concat(r.items);
      more = r.more;
      draw();
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  };
  $('[data-csv]', root).onclick = async () => {
    try {
      const r = await api.get(`/api/audit?${filters()}&limit=20000`);
      const list = failsOnly() ? r.items.filter((e) => e.ok === false) : r.items;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8' }));
      a.download = `bolzo-rmm-protokoll-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(e.message, 'err'); }
  };
  const reload = throttle(load, 400);
  $('[data-q]', root).addEventListener('input', reload);
  $('[data-cat]', root).onchange = load;
  if (!agentId) $('[data-agent]', root).onchange = load;
  $('[data-fails]', root).onchange = draw;

  // Neue Einträge live einblenden, wenn sie zum Filter passen
  const off = api.on('audit', (e) => {
    const p = filters();
    const cats = p.get('cat')?.split(',');
    if (cats && !cats.includes(e.cat)) return;
    if (p.get('agentId') && e.agentId !== p.get('agentId')) return;
    if (p.get('q')) return reload();
    items.unshift(e);
    draw();
  });
  load();
  return off;
}

// ---------- Skript-Ausgaben ----------
function renderRuns(root) {
  root.innerHTML = `
    <div class="toolbar"><span class="muted" style="font-size:13px">Die letzten 300 Skript- und Befehlsausführungen mit vollständiger Ausgabe.</span>
      <span class="spacer grow"></span>
      <button class="btn danger" data-clear>${icon('trash', 'sm')}Ausgaben löschen</button></div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Zeitpunkt</th><th>Client</th><th>Skript</th><th>Shell</th><th>Ergebnis</th></tr></thead><tbody></tbody></table></div>`;

  let items = [];
  async function load() {
    items = await api.get('/api/history').catch((e) => { toast(e.message, 'err'); return []; });
    $('tbody', root).innerHTML = items.length ? items.map((r, i) => `<tr class="click" data-i="${i}">
      <td class="num muted">${fmtTime(r.ts)}</td>
      <td style="font-weight:500">${esc(r.hostname)}</td>
      <td>${esc(r.scriptName)}</td>
      <td class="muted">${esc(r.shell)}</td>
      <td>${exitBadge(r)}</td></tr>`).join('')
      : `<tr><td colspan="5"><div class="empty">${icon('clock')}<h3>Noch keine Ausgaben</h3><div>Hier erscheinen ausgeführte Skripte.</div></div></td></tr>`;
    $$('tr[data-i]', root).forEach((tr) => (tr.onclick = () => showRunResult(items[tr.dataset.i])));
  }
  $('[data-clear]', root).onclick = async () => {
    if (!(await confirmDialog({ title: 'Ausgaben löschen?', text: 'Alle gespeicherten Skript-Ausgaben werden gelöscht. Das Protokoll bleibt erhalten.', okText: 'Löschen', danger: true }))) return;
    await api.del('/api/history');
    load();
  };
  load();
  return api.on('history', load);
}

export function renderHistory(root, { params = [] } = {}) {
  let view = params[0] === 'runs' ? 'runs' : 'audit';
  root.innerHTML = `
    <div class="page-head">
      <h1>Verlauf</h1><span class="sub">Wer hat wann was getan</span>
      <span class="spacer"></span>
      <div class="seg" data-seg>
        <button data-v="audit">${icon('shield', 'sm')} Protokoll</button>
        <button data-v="runs">${icon('terminal', 'sm')} Skript-Ausgaben</button>
      </div>
    </div>
    <div data-body></div>`;
  let cleanup = null;
  function show(v) {
    view = v;
    history.replaceState(null, '', `#/history/${v}`);
    $$('[data-v]', root).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    cleanup?.();
    cleanup = (v === 'runs' ? renderRuns : renderAuditLog)($('[data-body]', root));
  }
  $$('[data-v]', root).forEach((b) => (b.onclick = () => show(b.dataset.v)));
  show(view);
  return () => cleanup?.();
}
