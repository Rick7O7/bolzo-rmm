import { api } from '../api.js';
import {
  icon, esc, el, $, $$, meter, memPct, fmtBytes, fmtRate, fmtDuration, fmtTime, fmtAgo, osIcon, osLabel,
  statusHtml, toast, confirmDialog, promptDialog, enableTabIndent, throttle, exitBadge,
} from '../ui.js';
import { lineChart } from '../charts.js';
import { RemoteTerminal } from '../terminal.js';
import { showRunResult } from './history.js';

const TABS = [
  { key: 'overview', label: 'Übersicht', icon: 'activity' },
  { key: 'terminal', label: 'Terminal', icon: 'terminal' },
  { key: 'processes', label: 'Prozesse', icon: 'list' },
  { key: 'services', label: 'Dienste', icon: 'box' },
  { key: 'scripts', label: 'Skripte', icon: 'code' },
  { key: 'notes', label: 'Notizen', icon: 'note' },
];

export function renderClient(root, { go, params }) {
  const id = params[0];
  let tab = TABS.some((t) => t.key === params[1]) ? params[1] : 'overview';
  let cleanupTab = null;

  if (!api.agents.get(id)) {
    root.innerHTML = `<button class="crumb" data-back>${icon('back', 'sm')}Zurück</button><div class="card empty">${icon('monitor')}<h3>Client nicht gefunden</h3></div>`;
    $('[data-back]', root).onclick = () => go('#/clients');
    return () => {};
  }
  const agent = () => api.agents.get(id);

  root.innerHTML = `
    <button class="crumb" data-back style="margin-bottom:10px">${icon('back', 'sm')}Clients</button>
    <div class="detail-head" data-head></div>
    <div class="tabs">${TABS.map((t) => `<button class="tab" data-tab="${t.key}">${icon(t.icon, 'sm')}${t.label}</button>`).join('')}</div>
    <div data-body></div>`;
  $('[data-back]', root).onclick = () => history.length > 1 ? history.back() : go('#/clients');

  // ---------- Kopfzeile ----------
  function drawHead() {
    const a = agent();
    if (!a) return;
    const head = $('[data-head]', root);
    head.innerHTML = `
      <div class="detail-icon">${osIcon(a.platform)}</div>
      <div class="detail-title grow">
        <h1>${esc(a.name)} <button class="btn ghost sm icon-only" title="Umbenennen" data-rename>${icon('edit', 'sm')}</button></h1>
        <div class="meta">${statusHtml(a)}<span>${esc(a.os || osLabel(a.platform))}</span><span class="mono">${esc(a.info?.interfaces?.[0]?.ip || '')}</span>${a.version ? `<span>Agent ${esc(a.version)}</span>` : ''}</div>
      </div>
      <div class="btn-group">
        ${a.online ? `
          <button class="btn" data-act="terminal">${icon('terminal', 'sm')}Terminal</button>
          <button class="btn" data-act="reboot">${icon('refresh', 'sm')}Neustart</button>
          <button class="btn" data-act="shutdown">${icon('power', 'sm')}Herunterfahren</button>
        ` : `<button class="btn" data-act="wake">${icon('zap', 'sm')}Aufwecken (WoL)</button>`}
        <button class="btn icon-only" data-act="more" title="Weitere Aktionen">⋯</button>
      </div>`;
    $('[data-rename]', head).onclick = rename;
    $$('[data-act]', head).forEach((b) => (b.onclick = (e) => action(b.dataset.act, e)));
  }

  async function rename() {
    const a = agent();
    const name = await promptDialog({ title: 'Client umbenennen', label: 'Anzeigename (leer = Hostname)', value: a.name === a.hostname ? '' : a.name });
    if (name === null) return;
    try { await api.patch(`/api/agents/${id}`, { name }); toast('Name gespeichert'); } catch (e) { toast(e.message, 'err'); }
  }

  async function action(kind, ev) {
    const a = agent();
    try {
      if (kind === 'terminal') return switchTab('terminal');
      if (kind === 'reboot' || kind === 'shutdown') {
        const label = kind === 'reboot' ? 'neu starten' : 'herunterfahren';
        if (!(await confirmDialog({ title: `${a.name} ${label}?`, text: `Der Client wird sofort ${label === 'neu starten' ? 'neu gestartet' : 'heruntergefahren'}. Nicht gespeicherte Arbeit geht verloren.`, okText: kind === 'reboot' ? 'Neu starten' : 'Herunterfahren', danger: true }))) return;
        await api.action(id, kind);
        return toast(kind === 'reboot' ? 'Neustart wird ausgeführt' : 'Wird heruntergefahren');
      }
      if (kind === 'wake') {
        const r = await api.post(`/api/agents/${id}/wake`);
        return toast(`Magic Packet gesendet (über ${r.via})`);
      }
      if (kind === 'more') return moreMenu(ev.currentTarget);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function moreMenu(anchor) {
    const a = agent();
    const items = [
      { k: 'rename', label: 'Umbenennen', icon: 'edit' },
      ...(a.online ? [
        { k: 'update', label: 'Agent aktualisieren', icon: 'download' },
        { k: 'uninstall', label: 'Agent deinstallieren', icon: 'trash', danger: true },
      ] : []),
      { k: 'delete', label: 'Aus BOLZO RMM entfernen', icon: 'x', danger: true },
    ];
    const r = anchor.getBoundingClientRect();
    const menu = el(`<div class="menu" style="top:${r.bottom + 6}px;right:${window.innerWidth - r.right}px">${items.map((i) => `<button class="menu-item ${i.danger ? 'danger' : ''}" data-k="${i.k}">${icon(i.icon, 'sm')}${i.label}</button>`).join('')}</div>`);
    document.body.append(menu);
    const close = () => { menu.remove(); document.removeEventListener('mousedown', outside); };
    const outside = (e) => !menu.contains(e.target) && close();
    setTimeout(() => document.addEventListener('mousedown', outside));
    menu.onclick = async (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (!k) return;
      close();
      try {
        if (k === 'rename') return rename();
        if (k === 'update') {
          await api.action(id, 'update');
          return toast('Agent wird aktualisiert und neu gestartet');
        }
        if (k === 'uninstall') {
          if (!(await confirmDialog({ title: 'Agent deinstallieren?', text: `Der Agent wird von <b>${esc(a.name)}</b> entfernt. Der Client bleibt in der Liste, bis du ihn löschst.`, okText: 'Deinstallieren', danger: true }))) return;
          await api.action(id, 'uninstall');
          return toast('Agent wird deinstalliert');
        }
        if (k === 'delete') {
          if (!(await confirmDialog({ title: 'Client entfernen?', text: `<b>${esc(a.name)}</b> wird aus BOLZO RMM gelöscht. Ein noch installierter Agent kann sich danach nicht mehr verbinden.`, okText: 'Entfernen', danger: true }))) return;
          await api.del(`/api/agents/${id}`);
          toast('Client entfernt');
          return go('#/clients');
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  // ---------- Tabs ----------
  function switchTab(key) {
    tab = key;
    history.replaceState(null, '', `#/client/${id}/${key}`);
    $$('[data-tab]', root).forEach((b) => b.classList.toggle('on', b.dataset.tab === key));
    cleanupTab?.();
    const body = $('[data-body]', root);
    body.innerHTML = '';
    cleanupTab = { overview, terminal, processes, services, scripts, notes }[key](body) || null;
  }
  $$('[data-tab]', root).forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  // Übersicht
  function overview(body) {
    body.innerHTML = `
      <div class="overview">
        <div class="stack">
          <div class="tiles" data-live></div>
          <div class="card card-pad"><div class="row" style="margin-bottom:6px"><h3 style="margin:0;font-size:14px" class="grow">Auslastung · letzte Stunde</h3></div><div data-chart></div></div>
          <div class="card"><div class="card-head">${icon('disk', 'sm')}<h3>Datenträger</h3></div><div class="card-pad disk-list" data-disks></div></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-head">${icon('monitor', 'sm')}<h3>System</h3></div><div class="card-pad kv" data-sys></div></div>
          <div class="card"><div class="card-head">${icon('network', 'sm')}<h3>Netzwerk</h3></div><div class="card-pad kv" data-net></div></div>
          <div class="card"><div class="card-head">${icon('tag', 'sm')}<h3>Tags</h3></div><div class="card-pad" data-tags></div></div>
        </div>
      </div>`;
    const chart = lineChart($('[data-chart]', body));
    let hist = [];
    api.get(`/api/agents/${id}`).then((d) => { hist = d.history || []; chart.update(hist); }).catch(() => {});

    function draw() {
      const a = agent();
      if (!a) return;
      const m = a.metrics;
      const t = api.settings.thresholds;
      const mp = memPct(m);
      $('[data-live]', body).innerHTML = a.online && m ? `
        <div class="card tile"><div class="label">${icon('cpu', 'sm')}CPU</div><div class="value num">${Math.round(m.cpu)} %</div><div class="foot">${m.load ? `Load ${m.load.map((x) => x.toFixed(2)).join(' · ')}` : `${a.info?.cores || '?'} Kerne`}</div></div>
        <div class="card tile"><div class="label">${icon('memory', 'sm')}Arbeitsspeicher</div><div class="value num">${Math.round(mp)} %</div><div class="foot">${fmtBytes(m.mem.used)} von ${fmtBytes(m.mem.total)}</div></div>
        <div class="card tile"><div class="label">${icon('clock', 'sm')}Uptime</div><div class="value num" style="font-size:22px;padding:4px 0">${fmtDuration(m.uptime)}</div><div class="foot">seit ${new Date(Date.now() - m.uptime * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div></div>
        <div class="card tile"><div class="label">${icon('network', 'sm')}Netzwerk</div>${m.net ? `<div class="value num" style="font-size:16px;padding:6px 0 2px">↓ ${fmtRate(m.net.rx)}</div><div class="foot">↑ ${fmtRate(m.net.tx)}</div>` : `<div class="value" style="font-size:16px;padding:6px 0 2px">–</div><div class="foot">unter Windows nicht erfasst</div>`}</div>
      ` : `<div class="card tile" style="grid-column:1/-1"><div class="label"><span class="dot offline"></span>Offline</div><div class="foot">Zuletzt gesehen ${fmtAgo(a.lastSeen)} (${new Date(a.lastSeen).toLocaleString('de-DE')})</div></div>`;

      const disks = m?.disks || [];
      $('[data-disks]', body).innerHTML = disks.length
        ? disks.map((d) => meter({ label: `${d.mount}${d.label && d.label !== d.mount ? ` · ${d.label}` : ''}`, value: (100 * d.used) / d.size, threshold: t.disk, text: `${fmtBytes(d.used)} / ${fmtBytes(d.size)} · ${Math.round((100 * d.used) / d.size)} %` })).join('')
        : '<span class="muted">Keine Daten</span>';

      const i = a.info || {};
      $('[data-sys]', body).innerHTML = [
        ['Hostname', i.hostname],
        ['System', i.os],
        ['Kernel', i.kernel],
        ['Architektur', i.arch],
        ['Modell', i.model],
        ['CPU', i.cpuModel ? `${i.cpuModel} (${i.cores} Threads)` : ''],
        ['RAM', fmtBytes(i.memTotal)],
        ['Agent', `${a.version || '?'} · Node ${i.nodeVersion || '?'}`],
        ['Registriert', a.createdAt ? new Date(a.createdAt).toLocaleDateString('de-DE') : ''],
      ].filter(([, v]) => v).map(([k, v]) => `<div class="k">${k}</div><div class="v">${esc(v)}</div>`).join('');

      $('[data-net]', body).innerHTML = [
        ...(i.interfaces || []).flatMap((n) => [[n.name, `<span class="mono">${esc(n.ip)}</span><br><span class="muted mono" style="font-size:11.5px">${esc(n.mac)}</span>`]]),
        ['Öffentlich', `<span class="mono">${esc(a.publicIp || '–')}</span>`],
      ].map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join('');
    }

    function drawTags() {
      const a = agent();
      const box = $('[data-tags]', body);
      box.innerHTML = `<div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:${a.tags.length ? 12 : 0}px">${a.tags.map((t) => `<span class="tag">${esc(t)}<button data-rm="${esc(t)}">${icon('x', 'sm')}</button></span>`).join('')}</div>
        <input class="input" placeholder="Tag hinzufügen + Enter (z.B. Server, Büro)" data-newtag>`;
      const save = async (tags) => {
        try { await api.patch(`/api/agents/${id}`, { tags }); } catch (e) { toast(e.message, 'err'); }
      };
      $$('[data-rm]', box).forEach((b) => (b.onclick = () => save(agent().tags.filter((t) => t !== b.dataset.rm))));
      $('[data-newtag]', box).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) save([...agent().tags, e.target.value.trim()]);
      });
    }

    draw();
    drawTags();
    const offM = api.on('metrics', ({ id: mid, metrics }) => {
      if (mid !== id) return;
      hist.push([Date.now(), metrics.cpu, metrics.mem?.total ? (100 * metrics.mem.used) / metrics.mem.total : 0]);
      if (hist.length > 720) hist.shift();
      chart.update(hist);
    });
    const offA = api.on('agent', ({ agent: a, prev }) => {
      if (a.id !== id) return;
      if (JSON.stringify(a.tags) !== JSON.stringify(prev?.tags)) drawTags();
    });
    const offD = api.on('agents', throttle(draw, 1000));
    return () => { offM(); offA(); offD(); chart.destroy(); };
  }

  // Terminal
  function terminal(body) {
    const a = agent();
    body.innerHTML = `
      <div class="term-wrap">
        <div class="term-bar"><span class="dot" data-dot></span><span data-state class="grow">Getrennt</span>
          <span class="muted" data-hint></span>
          <button class="btn sm" data-reconnect>${icon('refresh', 'sm')}Neu verbinden</button>
        </div>
        <div class="term-host" data-host></div>
      </div>`;
    const setState = (s, info) => {
      $('[data-dot]', body).className = `dot ${s === 'open' ? 'online' : s === 'connecting' ? 'alert' : 'offline'}`;
      $('[data-state]', body).textContent = s === 'open' ? `Verbunden · ${info?.shell || ''} auf ${agent()?.name}` : s === 'connecting' ? 'Verbinde ...' : 'Getrennt';
      $('[data-hint]', body).textContent = s === 'open' && info?.mode === 'line' ? 'Zeilenmodus: Enter sendet, ↑/↓ Verlauf, Strg+C bricht ab' : '';
    };
    const rt = new RemoteTerminal($('[data-host]', body), id, { onStatus: setState });
    $('[data-reconnect]', body).onclick = () => rt.connect();
    if (a.online) rt.connect();
    else rt.term.write('\x1b[90mClient ist offline.\x1b[0m\r\n');
    return () => rt.dispose();
  }

  // Prozesse
  function processes(body) {
    let list = [];
    let q = '';
    let auto = null;
    body.innerHTML = `
      <div class="toolbar">
        <div class="search grow" style="max-width:320px">${icon('search', 'sm')}<input class="input" placeholder="Prozess suchen ..." data-q></div>
        <span class="muted" data-info></span><span class="grow"></span>
        <label class="row" style="gap:8px;font-size:13px;color:var(--text-2)"><input type="checkbox" class="check" data-auto>Automatisch aktualisieren</label>
        <button class="btn" data-refresh>${icon('refresh', 'sm')}Aktualisieren</button>
      </div>
      <div class="card table-wrap" style="max-height:calc(100vh - 300px)"><table class="tbl"><thead><tr><th class="r">PID</th><th>Name</th><th>Benutzer</th><th class="r">CPU</th><th class="r">RAM</th><th>Befehl</th><th></th></tr></thead><tbody></tbody></table></div>`;

    async function load() {
      const btn = $('[data-refresh] .icon', body);
      btn?.classList.add('spin');
      try {
        list = await api.action(id, 'processes');
        $('[data-info]', body).textContent = `${list.length} Prozesse`;
        draw();
      } catch (e) {
        $('tbody', body).innerHTML = `<tr><td colspan="7"><div class="empty">${esc(e.message)}</div></td></tr>`;
      } finally {
        btn?.classList.remove('spin');
      }
    }
    function draw() {
      const rows = list.filter((p) => !q || `${p.pid} ${p.name} ${p.user} ${p.cmd}`.toLowerCase().includes(q)).slice(0, 300);
      $('tbody', body).innerHTML = rows.map((p) => `<tr>
        <td class="r num muted">${p.pid}</td>
        <td style="font-weight:500">${esc(p.name)}</td>
        <td class="muted">${esc(p.user)}</td>
        <td class="r num">${p.cpu.toFixed(1).replace('.', ',')} %</td>
        <td class="r num">${fmtBytes(p.mem)}</td>
        <td class="mono muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.cmd)}">${esc(p.cmd)}</td>
        <td class="actions"><button class="btn sm danger" data-kill="${p.pid}" data-name="${esc(p.name)}">${icon('x', 'sm')}Beenden</button></td>
      </tr>`).join('') || `<tr><td colspan="7"><div class="empty">Keine Prozesse</div></td></tr>`;
    }
    $('[data-q]', body).addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(); });
    $('[data-refresh]', body).onclick = load;
    $('[data-auto]', body).onchange = (e) => {
      clearInterval(auto);
      auto = e.target.checked ? setInterval(load, 5000) : null;
    };
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-kill]');
      if (!b) return;
      if (!(await confirmDialog({ title: 'Prozess beenden?', text: `<b>${esc(b.dataset.name)}</b> (PID ${b.dataset.kill}) wird sofort beendet.`, okText: 'Beenden', danger: true }))) return;
      try {
        await api.action(id, 'kill', { pid: Number(b.dataset.kill) });
        toast('Prozess beendet');
        load();
      } catch (err) { toast(err.message, 'err'); }
    });
    $('tbody', body).innerHTML = `<tr><td colspan="7"><div class="empty">Lade Prozesse ...</div></td></tr>`;
    load();
    return () => clearInterval(auto);
  }

  // Dienste
  function services(body) {
    let list = [];
    let q = '';
    let f = 'all';
    body.innerHTML = `
      <div class="toolbar">
        <div class="search grow" style="max-width:320px">${icon('search', 'sm')}<input class="input" placeholder="Dienst suchen ..." data-q></div>
        <div class="seg" data-seg><button data-f="all" class="on">Alle</button><button data-f="on">Laufend</button><button data-f="off">Gestoppt</button></div>
        <span class="grow"></span>
        <button class="btn" data-refresh>${icon('refresh', 'sm')}Aktualisieren</button>
      </div>
      <div class="card table-wrap" style="max-height:calc(100vh - 300px)"><table class="tbl"><thead><tr><th>Dienst</th><th>Beschreibung</th><th>Status</th><th>Start</th><th></th></tr></thead><tbody></tbody></table></div>`;
    async function load() {
      try {
        list = await api.action(id, 'services');
        draw();
      } catch (e) {
        $('tbody', body).innerHTML = `<tr><td colspan="5"><div class="empty">${esc(e.message)}</div></td></tr>`;
      }
    }
    function draw() {
      const rows = list
        .filter((s) => f === 'all' || (f === 'on' ? s.active : !s.active))
        .filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
      $('tbody', body).innerHTML = rows.map((s) => `<tr>
        <td style="font-weight:500">${esc(s.name)}</td>
        <td class="muted" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.description)}</td>
        <td><span class="badge ${s.active ? 'good' : ''}">${s.active ? icon('play') : icon('stop')}${esc(s.state)}</span></td>
        <td class="muted">${esc(s.startup)}</td>
        <td class="actions">
          ${s.active ? `<button class="btn sm" data-op="restart" data-n="${esc(s.name)}">${icon('refresh', 'sm')}Neustart</button> <button class="btn sm danger" data-op="stop" data-n="${esc(s.name)}">${icon('stop', 'sm')}Stopp</button>`
            : `<button class="btn sm" data-op="start" data-n="${esc(s.name)}">${icon('play', 'sm')}Start</button>`}
        </td></tr>`).join('') || `<tr><td colspan="5"><div class="empty">Keine Dienste</div></td></tr>`;
    }
    $('[data-q]', body).addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(); });
    $('[data-seg]', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      f = b.dataset.f;
      $$('[data-f]', body).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    });
    $('[data-refresh]', body).onclick = load;
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const ops = { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet' };
      b.disabled = true;
      try {
        await api.action(id, 'service', { name: b.dataset.n, op: b.dataset.op });
        toast(`${b.dataset.n} ${ops[b.dataset.op]}`);
        load();
      } catch (err) {
        toast(err.message, 'err');
        b.disabled = false;
      }
    });
    $('tbody', body).innerHTML = `<tr><td colspan="5"><div class="empty">Lade Dienste ...</div></td></tr>`;
    load();
  }

  // Skripte
  function scripts(body) {
    const a = agent();
    const isWin = a.platform === 'win32';
    body.innerHTML = `
      <div class="overview">
        <div class="stack">
          <div class="card">
            <div class="card-head">${icon('code', 'sm')}<h3>Befehl / Skript ausführen</h3><span class="spacer"></span>
              <select class="select" style="width:200px;height:30px" data-lib><option value="">Aus Bibliothek laden ...</option></select>
            </div>
            <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
              <textarea class="textarea code editor" spellcheck="false" data-body placeholder="${isWin ? 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10' : 'df -h && free -h'}"></textarea>
              <div class="row">
                <select class="select" style="width:160px" data-shell>
                  ${(isWin ? ['powershell', 'cmd', 'python'] : ['bash', 'sh', 'python', 'powershell']).map((s) => `<option value="${s}">${{ powershell: 'PowerShell', cmd: 'CMD', bash: 'Bash', sh: 'sh', python: 'Python' }[s]}</option>`).join('')}
                </select>
                <div class="row" style="gap:8px"><span class="muted" style="font-size:13px">Timeout</span><input class="input" type="number" min="5" max="7200" value="300" style="width:90px" data-timeout><span class="muted" style="font-size:13px">s</span></div>
                <span class="grow"></span>
                <button class="btn primary" data-run>${icon('play', 'sm')}Ausführen</button>
              </div>
            </div>
          </div>
          <div class="card" data-outcard style="display:none">
            <div class="card-head">${icon('terminal', 'sm')}<h3>Ausgabe</h3><span class="spacer"></span><span data-meta></span></div>
            <div class="card-pad"><pre class="output" data-out></pre></div>
          </div>
        </div>
        <div class="card"><div class="card-head">${icon('clock', 'sm')}<h3>Verlauf auf diesem Client</h3></div><div data-hist class="alert-list"></div></div>
      </div>`;
    const ta = $('[data-body]', body);
    enableTabIndent(ta);
    let lib = [];
    api.get('/api/scripts').then((s) => {
      lib = s.filter((x) => (isWin ? ['powershell', 'cmd', 'python'] : ['bash', 'sh', 'python', 'powershell']).includes(x.shell));
      $('[data-lib]', body).innerHTML = `<option value="">Aus Bibliothek laden ...</option>` + lib.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    });
    $('[data-lib]', body).onchange = (e) => {
      const s = lib.find((x) => x.id === e.target.value);
      if (!s) return;
      ta.value = s.body;
      $('[data-shell]', body).value = s.shell;
      $('[data-timeout]', body).value = s.timeout;
      e.target.value = '';
    };
    $('[data-run]', body).onclick = async (e) => {
      const btn = e.currentTarget;
      if (!ta.value.trim()) return toast('Bitte einen Befehl eingeben', 'err');
      btn.disabled = true;
      btn.innerHTML = `${icon('refresh', 'sm spin')}Läuft ...`;
      $('[data-outcard]', body).style.display = '';
      $('[data-out]', body).textContent = 'Wird ausgeführt ...';
      $('[data-meta]', body).innerHTML = '';
      try {
        const r = await api.post(`/api/agents/${id}/run`, { shell: $('[data-shell]', body).value, body: ta.value, timeout: Number($('[data-timeout]', body).value) || 300 });
        $('[data-out]', body).textContent = r.error ? `Fehler: ${r.error}` : r.output || '(keine Ausgabe)';
        $('[data-meta]', body).innerHTML = exitBadge(r);
      } catch (err) {
        $('[data-out]', body).textContent = `Fehler: ${err.message}`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${icon('play', 'sm')}Ausführen`;
      }
    };
    async function loadHist() {
      const h = await api.get(`/api/history?agentId=${id}`).catch(() => []);
      const box = $('[data-hist]', body);
      if (!box) return;
      box.innerHTML = h.length ? h.slice(0, 30).map((x, i) => `<div class="alert-row" data-i="${i}" style="cursor:pointer"><div class="grow"><div style="font-weight:500">${esc(x.scriptName)}</div><div class="muted" style="font-size:12px">${fmtTime(x.ts)}</div></div>${exitBadge(x)}</div>`).join('')
        : `<div class="empty" style="padding:24px">Noch nichts ausgeführt</div>`;
      $$('[data-i]', box).forEach((r) => (r.onclick = () => showRunResult(h[r.dataset.i])));
    }
    loadHist();
    return api.on('history', loadHist);
  }

  // Notizen
  function notes(body) {
    body.innerHTML = `
      <div class="card">
        <div class="card-head">${icon('note', 'sm')}<h3>Notizen</h3><span class="spacer"></span><span class="muted" style="font-size:12.5px" data-saved></span></div>
        <div class="card-pad"><textarea class="textarea" style="min-height:360px" placeholder="Zugangsdaten-Hinweise, Standort, Besonderheiten ... (werden auf dem Server gespeichert)" data-notes></textarea></div>
      </div>`;
    const ta = $('[data-notes]', body);
    ta.value = agent().notes || '';
    let timer;
    const save = async () => {
      try {
        await api.patch(`/api/agents/${id}`, { notes: ta.value });
        $('[data-saved]', body).textContent = 'Gespeichert';
      } catch (e) { toast(e.message, 'err'); }
    };
    ta.addEventListener('input', () => {
      $('[data-saved]', body).textContent = 'Ungespeichert ...';
      clearTimeout(timer);
      timer = setTimeout(save, 800);
    });
    return () => { if (timer) { clearTimeout(timer); save(); } };
  }

  drawHead();
  switchTab(tab);
  const offHead = api.on('agent', ({ agent: a, prev }) => {
    if (a.id !== id) return;
    drawHead();
    // Terminal-Tab beim Wiederkommen des Clients neu aufbauen
    if (tab === 'terminal' && a.online && prev && !prev.online) switchTab('terminal');
  });
  const offRemoved = api.on('agents', () => { if (!agent()) go('#/clients'); });
  return () => { offHead(); offRemoved(); cleanupTab?.(); };
}
