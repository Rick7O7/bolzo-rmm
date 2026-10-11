// Karte "Verbindung der Agents": zeigt, über welche Adresse jeder Agent verbunden ist,
// und zieht alle auf die beste erreichbare Adresse um.
import { api } from './api.js';
import { icon, esc, $, toast, modal, confirmDialog } from './ui.js';

const host = (u) => String(u || '').replace(/^https?:\/\//, '');
const versionAtLeast = (v, min) => {
  const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};

export function renderMigrateCard(box) {
  let targets = [];

  function draw() {
    const agents = [...api.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
    const groups = new Map();
    for (const a of agents) {
      const key = a.serverUrl || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const primary = targets[0];
    const tooOld = agents.filter((a) => a.online && !versionAtLeast(a.version, '1.2.0')).length;
    const rows = [...groups.entries()]
      .sort(([a], [b]) => (b === primary) - (a === primary) || a.localeCompare(b))
      .map(([url, list]) => `
        <div class="alert-row" style="cursor:default;align-items:flex-start">
          <div class="grow">
            <div style="font-weight:600" class="mono">${url ? esc(host(url)) : '<span class="muted">unbekannt (Agent zu alt)</span>'}</div>
            <div class="muted" style="font-size:12px;margin-top:3px">${list.map((a) => `${a.online ? '' : '○ '}${esc(a.name)}`).join(' · ')}</div>
          </div>
          ${url && url === primary ? `<span class="badge good">${icon('check')}Ziel</span>` : url && targets.includes(url) ? `<span class="badge accent">Heimnetz</span>` : `<span class="badge warning">alt</span>`}
          <span class="badge">${list.length}</span>
        </div>`).join('');

    box.innerHTML = `
      <div class="card-head">${icon('link', 'sm')}<h3>Verbindung der Agents</h3></div>
      <div class="alert-list">${rows || '<div class="empty" style="padding:20px">Keine Agents</div>'}</div>
      <div class="card-pad" style="border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px">
        <div class="hint" style="font-size:12.5px;color:var(--text-2)">
          Beim Umziehen probiert jeder Agent ${targets.map((t, i) => `${i ? ' dann ' : ''}<span class="mono">${esc(host(t))}</span>`).join(',')} und wechselt nur, wenn er dort diesen Server erreicht.
          Klappt die Verbindung danach nicht, kehrt er nach etwa einer Minute selbst zur alten Adresse zurück.
        </div>
        ${tooOld ? `<div class="hint" style="font-size:12.5px;color:var(--warning)">${icon('alert', 'sm')} ${tooOld} Agent(s) sind älter als Version 1.2.0 und müssen zuerst aktualisiert werden (Updates → „Alle Agents aktualisieren").</div>` : ''}
        <div class="row"><span class="grow"></span><button class="btn primary" data-migrate>${icon('refresh', 'sm')}Alle Online-Agents umziehen</button></div>
      </div>`;
    $('[data-migrate]', box).onclick = migrate;
  }

  async function migrate() {
    if (!(await confirmDialog({ title: 'Agents umziehen?', text: `Alle verbundenen Agents wechseln auf die erste erreichbare Adresse:<br><span class="mono">${targets.map((t) => esc(host(t))).join(' → ')}</span>`, okText: 'Umziehen' }))) return;
    const btn = $('[data-migrate]', box);
    btn.disabled = true;
    btn.innerHTML = `${icon('refresh', 'sm spin')}Läuft ...`;
    try {
      const r = await api.post('/api/agents/migrate', { urls: targets });
      showResults(r);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('refresh', 'sm')}Alle Online-Agents umziehen`;
    }
  }

  function showResults({ results }) {
    const changed = results.filter((r) => r.ok && r.changed).length;
    modal({
      title: 'Ergebnis des Umzugs',
      wide: true,
      body: `<div class="muted">${changed} gewechselt · ${results.filter((r) => r.ok && !r.changed).length} unverändert · ${results.filter((r) => !r.ok).length} Fehler</div>
        <div class="card"><table class="tbl"><thead><tr><th>Client</th><th>Vorher</th><th>Jetzt</th><th>Hinweis</th></tr></thead><tbody>
        ${results.map((r) => `<tr>
          <td style="font-weight:500">${esc(r.hostname)}</td>
          <td class="mono muted">${esc(host(r.from) || '–')}</td>
          <td>${!r.ok ? `<span class="badge critical">${icon('x')}Fehler</span>` : r.changed ? `<span class="badge good">${icon('check')}${esc(host(r.url))}</span>` : `<span class="mono">${esc(host(r.url))}</span>`}</td>
          <td class="muted" style="font-size:12px">${esc(r.error || r.note || '')}${(r.tried || []).map((t) => `<div>${esc(host(t.url))}: ${esc(t.error)}</div>`).join('')}</td>
        </tr>`).join('')}
        </tbody></table></div>`,
    });
    toast(`${changed} Agent(s) umgezogen`);
  }

  api.get('/api/enroll').then((info) => {
    targets = (info.variants || [{ url: info.serverUrl }]).map((v) => v.url);
    draw();
  }).catch(() => draw());
  draw();
  return api.on('agent', () => draw());
}
