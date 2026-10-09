// Kleine DOM-Helfer, Icons, Formatierung, Toasts und Dialoge.

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  memory: '<path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M12 11V9M2 15h20"/><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.8V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.8z"/>',
  disk: '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  tag: '<path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l8.59-8.59a1 1 0 0 0 0-1.41z"/><path d="M7 7h.01"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  windows: '<path d="M3 5.5 10.5 4.5v7H3zM12 4.3 21 3v8.5h-9zM3 12.5h7.5v7L3 18.5zM12 12.5h9V21l-9-1.3z" fill="currentColor" stroke="none"/>',
  linux: '<path d="M12 2c-2.2 0-3.5 1.8-3.5 4.3 0 1.5.3 2.3-.6 3.7C6.7 11.8 5 14 5 16.3c0 .8.2 1.4.5 1.9-.6.4-1.5.6-1.5 1.5 0 1.3 2.2 1.1 3.4 1.6 1 .4 1.7.7 2.4.2.5-.4.6-.8 2.2-.8s1.7.4 2.2.8c.7.5 1.4.2 2.4-.2 1.2-.5 3.4-.3 3.4-1.6 0-.9-.9-1.1-1.5-1.5.3-.5.5-1.1.5-1.9 0-2.3-1.7-4.5-2.9-6.3-.9-1.4-.6-2.2-.6-3.7C15.5 3.8 14.2 2 12 2z"/><circle cx="10.5" cy="7" r=".6" fill="currentColor"/><circle cx="13.5" cy="7" r=".6" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
};

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Erzeugt ein Element aus einem HTML-String
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Formatierung ----------
export function fmtBytes(b, digits = 1) {
  if (b == null || isNaN(b)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : b < 10 ? digits : b < 100 ? Math.min(digits, 1) : 0).replace('.', ',')} ${u[i]}`;
}
export const fmtRate = (b) => (b == null ? '–' : `${fmtBytes(b)}/s`);
export const fmtPct = (v) => (v == null || isNaN(v) ? '–' : `${Math.round(v)} %`);

export function fmtDuration(sec) {
  if (sec == null) return '–';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} T ${h} Std`;
  if (h) return `${h} Std ${m} Min`;
  if (m) return `${m} Min`;
  return `${sec} s`;
}

export function fmtAgo(ts) {
  if (!ts) return 'nie';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std`;
  return `vor ${Math.floor(s / 86400)} T`;
}

export const fmtTime = (ts) => new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtClock = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

export function osIcon(platform) {
  return platform === 'win32' ? icon('windows') : icon('linux');
}
export function osLabel(platform) {
  return { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[platform] || platform || '?';
}

// ---------- Kennzahlen eines Clients ----------
export function memPct(m) {
  return m?.mem?.total ? (100 * m.mem.used) / m.mem.total : null;
}
export function worstDisk(m) {
  let worst = null;
  for (const d of m?.disks || []) {
    const pct = d.size ? (100 * d.used) / d.size : 0;
    if (!worst || pct > worst.pct) worst = { ...d, pct };
  }
  return worst;
}
export function primaryIp(a) {
  return a.info?.interfaces?.[0]?.ip || '';
}
export function level(value, threshold) {
  if (value == null) return '';
  if (value >= Math.max(threshold, 97)) return 'critical';
  if (value >= threshold) return 'warning';
  return '';
}

export function meter({ label, iconName, value, text, kind = '', threshold = 101 }) {
  const lv = level(value, threshold);
  const w = value == null ? 0 : Math.min(100, Math.max(0, value));
  return `<div class="meter">
    <div class="meter-top"><span class="k">${iconName ? icon(iconName, 'sm') : ''}${esc(label)}</span><span class="v">${lv ? icon('alert', 'sm') + ' ' : ''}${esc(text ?? fmtPct(value))}</span></div>
    <div class="meter-track"><div class="meter-fill ${kind} ${lv}" style="width:${w}%"></div></div>
  </div>`;
}

export function statusHtml(a) {
  if (!a.online) return `<span class="status"><span class="dot offline"></span>Offline · ${fmtAgo(a.lastSeen)}</span>`;
  if (a.alerts?.length) return `<span class="status"><span class="dot alert"></span>Online · ${a.alerts.length} Warnung${a.alerts.length > 1 ? 'en' : ''}</span>`;
  return `<span class="status"><span class="dot online"></span>Online</span>`;
}

// ---------- Toasts ----------
export function toast(msg, type = 'ok') {
  const t = el(`<div class="toast ${type}">${icon(type === 'ok' ? 'check' : 'alert')}<span>${esc(msg)}</span></div>`);
  $('#toasts').append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, type === 'ok' ? 2800 : 5000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('In die Zwischenablage kopiert');
  } catch {
    toast('Kopieren fehlgeschlagen', 'err');
  }
}

// ---------- Modale Dialoge ----------
export function modal({ title, body, foot = '', wide = false, onClose }) {
  const back = el(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost icon-only sm" data-close>${icon('x')}</button></div>
    <div class="modal-body"></div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div></div>`);
  const bodyEl = $('.modal-body', back);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => e.target === back && close());
  $$('[data-close]', back).forEach((b) => b.addEventListener('click', close));
  document.body.append(back);
  return { el: back, body: bodyEl, close };
}

export function confirmDialog({ title, text, okText = 'Bestätigen', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title,
      body: `<p style="margin:0;color:var(--text-2)">${text}</p>`,
      foot: `<button class="btn" data-close>Abbrechen</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button>`,
      onClose: () => resolve(result),
    });
    const ok = $('[data-ok]', m.el);
    ok.addEventListener('click', () => { result = true; m.close(); });
    ok.focus();
  });
}

export function promptDialog({ title, label, value = '', okText = 'Speichern' }) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({
      title,
      body: `<div class="field"><label>${esc(label)}</label><input class="input" value="${esc(value)}"></div>`,
      foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-ok>${esc(okText)}</button>`,
      onClose: () => resolve(result),
    });
    const input = $('input', m.el);
    const ok = () => { result = input.value; m.close(); };
    $('[data-ok]', m.el).addEventListener('click', ok);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
    input.focus();
    input.select();
  });
}

// Tab-Taste in Textareas als Einrückung statt Fokuswechsel
export function enableTabIndent(textarea) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = textarea;
    textarea.value = value.slice(0, s) + '    ' + value.slice(en);
    textarea.selectionStart = textarea.selectionEnd = s + 4;
    textarea.dispatchEvent(new Event('input'));
  });
}

export function throttle(fn, ms) {
  let last = 0, timer = null;
  return (...args) => {
    const now = Date.now();
    clearTimeout(timer);
    if (now - last >= ms) { last = now; fn(...args); }
    else timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last));
  };
}

export function exitBadge(r) {
  if (r.error) return `<span class="badge critical">${icon('x')}Fehler</span>`;
  if (r.timedOut) return `<span class="badge warning">${icon('clock')}Timeout</span>`;
  const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1).replace('.', ',')} s` : '';
  return r.exitCode === 0
    ? `<span class="badge good">${icon('check')}Exit 0${dur}</span>`
    : `<span class="badge critical">${icon('alert')}Exit ${r.exitCode}${dur}</span>`;
}

// ---------- Tags ----------
// Jeder Tag-Name bekommt dauerhaft dieselbe Farbe (feste Reihenfolge, per Hash zugeordnet)
const TAG_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#22a03a', '#9085e9', '#e66767'];
export function tagColor(name) {
  let h = 0;
  for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}
export function tagHtml(name, { removable = false, small = false } = {}) {
  return `<span class="tag ${small ? 'sm' : ''}" style="--tag-c:${tagColor(name)}">${esc(name)}${removable ? `<button data-rm="${esc(name)}" title="Entfernen">${icon('x', 'sm')}</button>` : ''}</span>`;
}
