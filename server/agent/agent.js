'use strict';
// BOLZO RMM Agent – läuft auf jedem verwalteten Client (Linux & Windows).
// Benötigt Node.js >= 22 (eingebauter WebSocket-Client), sonst keine Abhängigkeiten.
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');

const VERSION = '1.7.0';
// Fingerabdruck des eigenen Codes – der Server erkennt daran veraltete Agents
const CODE_HASH = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const IS_WIN = process.platform === 'win32';
// BOLZO_TEST_VNC=host:port: Testmodus ohne Proxmox (spielt einen Host mit zwei Gästen vor)
const TEST_PVE = !!process.env.BOLZO_TEST_VNC;
const IS_PVE = TEST_PVE || (!IS_WIN && fs.existsSync('/usr/bin/pvesh'));
const pveNode = () => os.hostname().split('.')[0];
// Der Agent-Dienst hat ein Speicherlimit (MemoryMax), das auch für alle gestarteten Programme gilt.
// Die Proxmox-Werkzeuge (Perl, je ~100 MB) würden daran ersticken: auf Proxmox-Hosts deshalb
// Proxmox-Befehle, Skripte und Terminals in einem eigenen Scope außerhalb des Agent-Limits starten.
const SCOPE = IS_PVE && !TEST_PVE && fs.existsSync('/usr/bin/systemd-run');
const SCOPE_PREFIX = ['systemd-run', '--scope', '--quiet', '--collect'];
const outside = (cmd, args) => (SCOPE ? [SCOPE_PREFIX[0], [...SCOPE_PREFIX.slice(1), cmd, ...args]] : [cmd, args]);
const outsideSh = (cmdline) => (SCOPE ? `${SCOPE_PREFIX.join(' ')} ${cmdline}` : cmdline);
const CFG_PATH = process.env.RMM_AGENT_CONFIG || path.join(__dirname, 'config.json');
const METRICS_INTERVAL = 5000;
const DISK_INTERVAL = 30000;

let cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const saveCfg = () => fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
function exec(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const PS_PREFIX = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
async function ps(script, opts) {
  return exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PREFIX + script], opts);
}
async function psJson(script, opts) {
  const r = await ps(`ConvertTo-Json -Compress -Depth 3 -InputObject @(${script})`, opts);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'PowerShell-Fehler');
  return JSON.parse(r.stdout || '[]');
}
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) cp.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

// ---------------------------------------------------------------------------
// Systeminformationen
// ---------------------------------------------------------------------------
function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address, mac: a.mac });
    }
  }
  // Physische LAN-Adapter zuerst, VPN/virtuelle Adapter ans Ende (die erste Adresse gilt als Haupt-IP)
  const rank = (i) => (i.mac === '00:00:00:00:00:00' ? 2 : 0) + (/^(vEthernet|docker|br-|veth|virbr|tun|tap|wg|tailscale|zt|lxc|vmnet|VirtualBox)/i.test(i.name) ? 1 : 0) + (i.ip.startsWith('169.254.') ? 3 : 0);
  return out.sort((x, y) => rank(x) - rank(y));
}

async function machineId() {
  if (IS_WIN) {
    const r = await exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    return (r.stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || '';
  }
  return readFile('/etc/machine-id').trim() || readFile('/var/lib/dbus/machine-id').trim();
}

let staticInfo = null;
async function getStaticInfo() {
  if (staticInfo) return staticInfo;
  let osName = `${os.type()} ${os.release()}`;
  let model = '';
  if (IS_WIN) {
    try {
      const [o] = await psJson("Get-CimInstance Win32_OperatingSystem | Select-Object Caption,BuildNumber");
      osName = `${o.Caption} (Build ${o.BuildNumber})`;
      const [c] = await psJson("Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model");
      model = `${c.Manufacturer} ${c.Model}`.trim();
    } catch {}
  } else {
    const rel = readFile('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (rel) osName = rel[1];
    const vendor = readFile('/sys/class/dmi/id/sys_vendor').trim();
    const product = readFile('/sys/class/dmi/id/product_name').trim();
    model = `${vendor} ${product}`.trim();
    if (!model && fs.existsSync('/proc/1/environ') && /container=lxc/.test(readFile('/proc/1/environ'))) model = 'LXC-Container';
  }
  let proxmox;
  if (TEST_PVE) proxmox = { node: 'test', version: 'Testmodus' };
  else if (IS_PVE) {
    const v = (await exec(...outside('pveversion', []))).stdout.match(/pve-manager\/([^/\s]+)/);
    proxmox = { node: pveNode(), version: v ? v[1] : '' };
  }
  staticInfo = { os: osName, model, proxmox };
  return staticInfo;
}

async function getInfo() {
  const s = await getStaticInfo();
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: os.arch(),
    os: s.os,
    model: s.model,
    kernel: os.release(),
    cpuModel: (cpus[0]?.model || '').trim(),
    cores: cpus.length,
    memTotal: memInfo().total,
    bootTime: Date.now() - os.uptime() * 1000,
    interfaces: interfaces(),
    agentVersion: VERSION,
    nodeVersion: process.version,
    ...(s.proxmox ? { proxmox: s.proxmox } : {}),
  };
}

// ---------------------------------------------------------------------------
// Live-Metriken
// ---------------------------------------------------------------------------
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}
let prevCpu = cpuTimes();
function cpuPercent() {
  const cur = cpuTimes();
  const di = cur.idle - prevCpu.idle, dt = cur.total - prevCpu.total;
  prevCpu = cur;
  return dt > 0 ? Math.min(100, Math.max(0, 100 * (1 - di / dt))) : 0;
}

function memInfo() {
  if (!IS_WIN) {
    // /proc/meminfo berücksichtigt Cache korrekt (und ist in LXC per lxcfs virtualisiert)
    const mi = readFile('/proc/meminfo');
    const kb = (k) => Number((mi.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0) * 1024;
    const total = kb('MemTotal');
    if (total) {
      return { total, used: total - (kb('MemAvailable') || kb('MemFree')), swapTotal: kb('SwapTotal'), swapUsed: kb('SwapTotal') - kb('SwapFree') };
    }
  }
  return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
}

let prevNet = null;
function netRate() {
  if (IS_WIN) return null;
  let rx = 0, tx = 0;
  for (const line of readFile('/proc/net/dev').split('\n').slice(2)) {
    const [iface, rest] = line.split(':');
    if (!rest || iface.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0];
    tx += f[8];
  }
  const now = Date.now();
  const res = prevNet ? { rx: Math.max(0, (rx - prevNet.rx) / ((now - prevNet.t) / 1000)), tx: Math.max(0, (tx - prevNet.tx) / ((now - prevNet.t) / 1000)) } : { rx: 0, tx: 0 };
  prevNet = { rx, tx, t: now };
  return res;
}

let disks = [];
async function refreshDisks() {
  try {
    if (IS_WIN) {
      const d = await psJson('Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace');
      disks = d.filter((x) => x.Size).map((x) => ({ mount: x.DeviceID, label: x.VolumeName || '', fs: '', size: x.Size, used: x.Size - x.FreeSpace }));
    } else {
      const r = await exec('df', ['-kPT', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs', '-x', 'efivarfs']);
      const seen = new Set();
      disks = [];
      for (const line of r.stdout.trim().split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 7 || seen.has(f[0])) continue;
        seen.add(f[0]);
        const size = Number(f[2]) * 1024;
        if (!size) continue;
        disks.push({ mount: f.slice(6).join(' '), label: f[0], fs: f[1], size, used: Number(f[3]) * 1024 });
      }
    }
  } catch (e) {
    log('Datenträger konnten nicht gelesen werden:', e.message);
  }
}

function collectMetrics() {
  return {
    cpu: Math.round(cpuPercent() * 10) / 10,
    mem: memInfo(),
    disks,
    net: netRate(),
    load: IS_WIN ? null : os.loadavg(),
    uptime: os.uptime(),
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Prozesse & Dienste
// ---------------------------------------------------------------------------
async function linuxProcesses() {
  const CLK = 100, PAGE = 4096;
  const users = {};
  for (const l of readFile('/etc/passwd').split('\n')) {
    const f = l.split(':');
    if (f.length > 2) users[f[2]] = f[0];
  }
  const snapshot = () => {
    const m = new Map();
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const stat = readFile(`/proc/${pid}/stat`);
      const end = stat.lastIndexOf(')');
      if (end < 0) continue;
      const name = stat.slice(stat.indexOf('(') + 1, end);
      const f = stat.slice(end + 2).split(' ');
      m.set(pid, { name, ticks: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * PAGE });
    }
    return m;
  };
  const a = snapshot();
  const t0 = Date.now();
  await sleep(700);
  const b = snapshot();
  const secs = (Date.now() - t0) / 1000;
  const cores = os.cpus().length;
  const out = [];
  for (const [pid, p] of b) {
    const prev = a.get(pid);
    const cpu = prev ? ((p.ticks - prev.ticks) / CLK / secs / cores) * 100 : 0;
    const uid = (readFile(`/proc/${pid}/status`).match(/^Uid:\s+(\d+)/m) || [])[1];
    const cmd = readFile(`/proc/${pid}/cmdline`).replace(/\0/g, ' ').trim();
    out.push({ pid: Number(pid), name: p.name, user: users[uid] || uid || '', cpu: Math.round(cpu * 10) / 10, mem: p.rss, cmd: cmd.slice(0, 300) });
  }
  return out.sort((x, y) => y.cpu - x.cpu || y.mem - x.mem);
}

async function quickProcesses() {
  if (!IS_WIN) {
    return fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).map((pid) => {
      const stat = readFile(`/proc/${pid}/stat`);
      return { pid: Number(pid), name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) };
    }).filter((p) => p.name);
  }
  const r = await exec('tasklist', ['/fo', 'csv', '/nh'], { timeout: 20000 });
  if (r.code !== 0) return windowsProcesses();
  return r.stdout.split(/\r?\n/).map((l) => l.match(/^"([^"]*)","(\d+)"/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[2]), name: m[1].replace(/\.exe$/i, '') }));
}

async function windowsProcesses() {
  const cores = os.cpus().length;
  const list = await psJson(
    "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Select-Object IDProcess,Name,PercentProcessorTime,WorkingSetPrivate",
    { timeout: 40000 }
  );
  return list
    .map((p) => ({ pid: p.IDProcess, name: String(p.Name).replace(/#\d+$/, ''), user: '', cpu: Math.round((p.PercentProcessorTime / cores) * 10) / 10, mem: Number(p.WorkingSetPrivate), cmd: '' }))
    .sort((x, y) => y.cpu - x.cpu || y.mem - x.mem);
}

async function services() {
  if (IS_WIN) {
    const list = await psJson("Get-Service | ForEach-Object { [pscustomobject]@{ name=$_.Name; display=$_.DisplayName; status=[string]$_.Status; startType=[string]$_.StartType } }", { timeout: 40000 });
    return list.map((s) => ({ name: s.name, description: s.display, active: s.status === 'Running', state: s.status, startup: s.startType }));
  }
  const [units, files] = await Promise.all([
    exec('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain']),
    exec('systemctl', ['list-unit-files', '--type=service', '--no-pager', '--no-legend']),
  ]);
  const startup = {};
  for (const l of files.stdout.split('\n')) {
    const [u, st] = l.trim().split(/\s+/);
    if (u) startup[u] = st;
  }
  const out = [];
  for (const l of units.stdout.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 4 || !f[0].endsWith('.service')) continue;
    out.push({ name: f[0], description: f.slice(4).join(' '), active: f[2] === 'active', state: `${f[2]} (${f[3]})`, startup: startup[f[0]] || '' });
  }
  return out;
}

async function serviceAction({ name, op }) {
  if (!/^[\w@.:\-]+$/.test(name || '')) throw new Error('Ungültiger Dienstname');
  if (!['start', 'stop', 'restart'].includes(op)) throw new Error('Ungültige Aktion');
  const r = IS_WIN
    ? await ps(`${{ start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' }[op]} -Name ${psQuote(name)} -Force -ErrorAction Stop`, { timeout: 60000 })
    : await exec('systemctl', [op, name], { timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'Fehlgeschlagen');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Skripte ausführen
// ---------------------------------------------------------------------------
const MAX_OUTPUT = 512 * 1024;
// Skripte und Jobs laufen unter Linux in einem eigenen systemd-Scope (wie auf Proxmox-Hosts alles).
// Was sie im Hintergrund starten – z.B. einen Minecraft-Server in tmux – hängt dann nicht am
// Speicherlimit des Agents und wird bei dessen Neustart oder Update nicht mit beendet.
let scriptScope = null;
async function useScriptScope() {
  if (scriptScope === null) {
    scriptScope = SCOPE || (!IS_WIN && !TEST_PVE && fs.existsSync('/run/systemd/system')
      && (await exec(SCOPE_PREFIX[0], [...SCOPE_PREFIX.slice(1), 'true'], { timeout: 10000 })).code === 0);
    if (!IS_WIN) log(`Skripte laufen ${scriptScope ? 'in eigenem systemd-Scope' : 'im Agent-Dienst (kein systemd-Scope möglich)'}`);
  }
  return scriptScope;
}

async function runScript({ body, shell, timeout = 300 }) {
  const scoped = await useScriptScope();
  return new Promise((resolve, reject) => {
    const ext = { powershell: '.ps1', cmd: '.cmd', bash: '.sh', sh: '.sh', python: '.py' }[shell];
    if (!ext) return reject(new Error('Unbekannte Shell'));
    if (IS_WIN && (shell === 'bash' || shell === 'sh')) return reject(new Error('Bash-Skripte laufen nicht auf Windows'));
    if (!IS_WIN && shell === 'cmd') return reject(new Error('CMD-Skripte laufen nur auf Windows'));
    const file = path.join(os.tmpdir(), `rmm-${crypto.randomBytes(6).toString('hex')}${ext}`);
    let content = String(body || '');
    // Ausgabe als UTF-8, sonst gehen Umlaute über die Pipe verloren
    if (shell === 'cmd') content = '@chcp 65001 >nul\r\n' + content.replace(/\r?\n/g, '\r\n');
    if (shell === 'powershell') content = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8\n" + content;
    // PowerShell 5.1 liest UTF-8 nur mit BOM korrekt (Umlaute!)
    fs.writeFileSync(file, (shell === 'powershell' ? '﻿' : '') + content, { mode: 0o700 });

    const cmds = {
      powershell: IS_WIN ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]] : ['pwsh', ['-NoLogo', '-NoProfile', '-File', file]],
      cmd: ['cmd.exe', ['/d', '/c', file]],
      bash: ['bash', [file]],
      sh: ['sh', [file]],
      python: [IS_WIN ? 'python' : 'python3', [file]],
    };
    const [cmd, args] = scoped ? [SCOPE_PREFIX[0], [...SCOPE_PREFIX.slice(1), ...cmds[shell].flat()]] : cmds[shell];
    const start = Date.now();
    let output = '';
    let timedOut = false;
    const child = cp.spawn(cmd, args, { cwd: os.homedir(), windowsHide: true, detached: !IS_WIN, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    const add = (d) => {
      if (output.length < MAX_OUTPUT) output += d.toString();
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout * 1000);
    const done = (exitCode, err) => {
      clearTimeout(timer);
      fs.rm(file, { force: true }, () => {});
      if (err) output += `\n[Fehler] ${err.message}`;
      if (output.length >= MAX_OUTPUT) output += '\n[Ausgabe gekürzt]';
      resolve({ exitCode, timedOut, durationMs: Date.now() - start, output });
    };
    child.on('error', (e) => done(-1, e));
    child.on('close', (code) => done(code));
  });
}

// ---------------------------------------------------------------------------
// Terminal-Sitzungen
// ---------------------------------------------------------------------------
// Windows: kleine PowerShell-REPL über Pipes (ohne ConPTY), die Desktop-App
// übernimmt Zeilenbearbeitung und Echo ("line"-Modus).
const WIN_REPL = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
Set-Location $env:SystemDrive\\
function __p { [Console]::Out.Write("PS $((Get-Location).Path)> "); [Console]::Out.Flush() }
"Windows PowerShell auf $env:COMPUTERNAME  ($([Environment]::UserName))"
""
__p
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line.Trim() -eq 'exit') { break }
  if ($line.Trim()) {
    try {
      Invoke-Expression $line 2>&1 | Out-String -Stream -Width 160 | ForEach-Object { [Console]::Out.WriteLine($_) }
    } catch {
      [Console]::Out.WriteLine(($_ | Out-String).TrimEnd())
    }
  }
  __p
}`;

const shells = new Map();
let hasScriptCmd = null;

async function openShell({ sid, cols = 120, rows = 30, lxc }) {
  if (shells.has(sid)) throw new Error('Sitzung existiert bereits');
  if (lxc != null) {
    if (!IS_PVE || IS_WIN) throw new Error('Kein Proxmox-Host');
    lxc = checkGuest({ vmid: lxc, type: 'lxc' }).vmid;
  }
  cols = Math.max(20, Math.min(500, Number(cols) || 120));
  rows = Math.max(5, Math.min(200, Number(rows) || 30));
  let child, mode, shellName;
  if (IS_WIN) {
    child = cp.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_REPL, 'utf16le').toString('base64')], { windowsHide: true });
    mode = 'line';
    shellName = 'PowerShell';
  } else {
    if (hasScriptCmd === null) hasScriptCmd = (await exec('sh', ['-c', 'command -v script'])).code === 0;
    const sh = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const env = { ...process.env, TERM: 'xterm-256color', HOME: os.homedir(), LANG: process.env.LANG || 'C.UTF-8' };
    if (hasScriptCmd) {
      // "script" stellt ein echtes Pseudo-Terminal bereit -> vim, top, htop funktionieren
      const target = outsideSh(lxc != null ? `pct enter ${lxc}` : `${sh} -l`);
      child = cp.spawn('script', ['-qfc', `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${target}`, '/dev/null'], { cwd: os.homedir(), env, detached: true });
      mode = 'pty';
    } else if (lxc != null) {
      throw new Error('Für die Container-Konsole wird "script" (util-linux) benötigt');
    } else {
      child = cp.spawn(sh, ['-i'], { cwd: os.homedir(), env, detached: true });
      mode = 'line';
    }
    shellName = lxc != null ? `Container ${lxc}` : path.basename(sh);
  }
  const out = (d) => send({ type: 'shell.out', sid, data: d.toString('base64') });
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('error', (e) => send({ type: 'shell.out', sid, data: Buffer.from(`\r\n[Fehler] ${e.message}\r\n`).toString('base64') }));
  child.on('close', (code) => {
    shells.delete(sid);
    send({ type: 'shell.exit', sid, code });
  });
  shells.set(sid, { child, mode });
  return { mode, shell: shellName };
}

function closeShell(sid) {
  const s = shells.get(sid);
  if (!s) return;
  try { s.child.stdin.end(); } catch {}
  killTree(s.child);
  shells.delete(sid);
}

// ---------------------------------------------------------------------------
// Proxmox VE – nur auf einem Proxmox-Host: Gäste auflisten und steuern,
// VM-Bildschirm (VNC) über einen eigenen Tunnel zum Server weiterreichen
// ---------------------------------------------------------------------------
const PVE_TYPES = { qemu: 'qemu-server', lxc: 'lxc' };
const PVE_OPS = ['start', 'shutdown', 'stop', 'reboot'];

function checkGuest({ vmid, type }) {
  vmid = Number(vmid);
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999999999) throw new Error('Ungültige VM-ID');
  if (!PVE_TYPES[type]) throw new Error('Ungültiger Gast-Typ');
  return { vmid, type };
}

async function pvesh(method, apiPath, args = [], timeout = 60000) {
  if (!IS_PVE) throw new Error('Kein Proxmox-Host');
  const r = await exec(...outside('pvesh', [method, apiPath, ...args, '--output-format', 'json']), { timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'pvesh-Fehler');
  try { return JSON.parse(r.stdout || 'null'); } catch { return r.stdout.trim(); }
}

// Proxmox speichert die Beschreibung URL-kodiert in #-Zeilen
function decodeDesc(raw) {
  let t = raw;
  try { t = decodeURIComponent(raw); } catch {}
  return t.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120) || '';
}

// Gast-Konfiguration lesen (nur der aktuelle Stand, ohne Snapshot-Abschnitte); MACs für die automatische Zuordnung
const guestConfText = (type, vmid) => readFile(`/etc/pve/nodes/${pveNode()}/${PVE_TYPES[type]}/${vmid}.conf`).split(/^\[/m)[0];
function guestConf(type, vmid) {
  const text = guestConfText(type, vmid);
  const get = (key) => (text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')) || [])[1]?.trim() || '';
  const nets = [...text.matchAll(/^net\d+:\s*(.+)$/gm)].map((m) => m[1]);
  return {
    macs: nets.map((n) => (n.match(/=([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i) || [])[1]?.toLowerCase()).filter(Boolean),
    staticIps: nets.map((n) => (n.match(/(?:^|,)ip=(\d+\.\d+\.\d+\.\d+)/) || [])[1]).filter(Boolean),
    onboot: get('onboot') === '1',
    ostype: get('ostype'),
    cores: Number(get('cores')) || 0,
    description: decodeDesc([...text.matchAll(/^#(.*)$/gm)].map((m) => m[1]).join('\n')),
  };
}

// IP-Adressen der Gäste: feste aus der Konfiguration, laufende Container per lxc-info,
// sonst über die Nachbartabelle des Hosts (MAC -> IP)
const lxcIpCache = new Map(); // vmid -> { at, ips }
async function guestIps(guests) {
  const neigh = new Map();
  try {
    for (const n of JSON.parse((await exec('ip', ['-j', 'neigh'])).stdout || '[]')) {
      if (n.lladdr && /^\d+\.\d+\.\d+\.\d+$/.test(n.dst) && n.state?.[0] !== 'FAILED') neigh.set(n.lladdr.toLowerCase(), n.dst);
    }
  } catch {}
  await Promise.all(guests.map(async (g) => {
    const ips = new Set(g.conf.staticIps);
    if (g.type === 'lxc' && g.status === 'running') {
      let c = lxcIpCache.get(g.vmid);
      if (!c || Date.now() - c.at > 60000 || c.uptime > g.uptime) {
        const r = await exec('lxc-info', ['-n', String(g.vmid), '-iH'], { timeout: 5000 });
        c = { at: Date.now(), uptime: g.uptime, ips: r.stdout.split(/\s+/).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.')) };
        lxcIpCache.set(g.vmid, c);
      }
      for (const ip of c.ips) ips.add(ip);
    }
    for (const mac of g.conf.macs) if (neigh.has(mac)) ips.add(neigh.get(mac));
    g.ips = [...ips];
  }));
}

// Mehrere offene Fenster/Ansichten fragen oft gleichzeitig: ein pvesh-Aufruf für alle, 4 s gültig.
// Nach Aktionen (Start, Einstellungen ...) wird der Speicher verworfen, damit die Liste sofort stimmt.
let guestsCache = null; // { at, promise }
function pveGuestsCached() {
  const c = guestsCache;
  if (c && (!c.at || Date.now() - c.at < 4000)) return c.promise;
  const entry = { at: 0, promise: null };
  entry.promise = pveGuestsLoad().then(
    (r) => { entry.at = Date.now(); return r; },
    (e) => { if (guestsCache === entry) guestsCache = null; throw e; },
  );
  guestsCache = entry;
  return entry.promise;
}
const pveFresh = (fn) => async (p) => { guestsCache = null; try { return await fn(p); } finally { guestsCache = null; } };

async function pveGuestsLoad() {
  if (TEST_PVE) {
    const mac = (interfaces()[0]?.mac || '').toLowerCase();
    return { node: 'test', guests: [
      { vmid: 101, type: 'qemu', name: 'test-vm', status: 'running', template: false, cpu: 0.0123, cpus: 2, mem: 1.2e9, maxmem: 4e9, disk: 0, maxdisk: 32e9, netin: 5.2e9, netout: 1.1e9, uptime: 7300, tags: ['web', 'prod'], onboot: true, ostype: 'win11', ips: ['10.2.30.51'], macs: [mac] },
      { vmid: 102, type: 'lxc', name: 'test-ct', status: 'stopped', template: false, cpu: 0, cpus: 1, mem: 0, maxmem: 1e9, disk: 1.4e9, maxdisk: 8e9, netin: 0, netout: 0, uptime: 0, tags: [], onboot: false, ostype: 'debian', ips: ['10.2.30.52'], macs: [] },
    ] };
  }
  const node = pveNode();
  // Ein Aufruf liefert alles Wichtige für alle Gäste (pvesh ist Perl und startet langsam)
  const res = (await pvesh('get', '/cluster/resources', ['--type', 'vm'])) || [];
  const guests = res.filter((g) => g.node === node && (g.type === 'qemu' || g.type === 'lxc')).map((g) => {
    const conf = guestConf(g.type, g.vmid);
    return {
      vmid: Number(g.vmid), type: g.type, name: g.name || '', status: g.status || '', template: !!g.template,
      cpu: g.cpu || 0, cpus: g.maxcpu || conf.cores || 0, mem: g.mem || 0, maxmem: g.maxmem || 0,
      disk: g.disk || 0, maxdisk: g.maxdisk || 0, netin: g.netin || 0, netout: g.netout || 0, uptime: g.uptime || 0,
      tags: String(g.tags || '').split(/[;,\s]+/).filter(Boolean), lock: g.lock || '', hastate: g.hastate || '',
      onboot: conf.onboot, ostype: conf.ostype, description: conf.description, macs: conf.macs, conf,
    };
  });
  await guestIps(guests);
  for (const g of guests) delete g.conf;
  return { node, guests: guests.sort((a, b) => a.vmid - b.vmid) };
}

// BOLZO-Agent in einem Gast neu starten (z.B. wenn er hängt) – Container per pct exec,
// Linux-VMs über den QEMU-Gast-Agent
async function pveRestartAgent(p) {
  const { vmid, type } = checkGuest(p);
  if (TEST_PVE) return { ok: true, test: true };
  const cmd = ['systemctl', 'restart', 'bolzo-rmm-agent'];
  const [c, a] = type === 'lxc'
    ? outside('pct', ['exec', String(vmid), '--', ...cmd])
    : outside('qm', ['guest', 'exec', String(vmid), '--', ...cmd]);
  const r = await exec(c, a, { timeout: 45000 });
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').pop() || `Fehler (${r.code})`;
    throw new Error(type === 'qemu' && /agent/i.test(msg) ? 'Kein QEMU-Gast-Agent in der VM – Agent bitte dort selbst neu starten' : msg);
  }
  return { ok: true };
}

// VM/Container endgültig löschen – nur ausgeschaltet; samt Disks, Backup-Jobs und Replikation.
// Der Proxmox-Schutz ("protection") verhindert das Löschen weiterhin (pvesh meldet dann einen Fehler).
async function pveDestroy(p) {
  const { vmid, type } = checkGuest(p);
  if (!IS_PVE) throw new Error('Kein Proxmox-Host');
  if (TEST_PVE) return { ok: true, test: true };
  const node = pveNode();
  const st = await pvesh('get', `/nodes/${node}/${type}/${vmid}/status/current`);
  if (st?.status === 'running') throw new Error('Läuft noch – bitte zuerst herunterfahren');
  if (String(st?.protection) === '1' || guestConfText(type, vmid).match(/^protection:\s*1/m)) {
    throw new Error('Schutz vor Löschen ist aktiv – erst in den Optionen ausschalten');
  }
  const r = await pveRun(['delete', `/nodes/${node}/${type}/${vmid}`, '--purge', '1', '--destroy-unreferenced-disks', '1'], 20000);
  return { ok: true, pending: !r.done };
}

// Starten/Herunterfahren können lange dauern: kurz auf Fehler warten, dann im Hintergrund weiterlaufen lassen
async function pvePower(p) {
  const { vmid, type } = checkGuest(p);
  if (!PVE_OPS.includes(p.op)) throw new Error('Unbekannte Aktion');
  if (!IS_PVE) throw new Error('Kein Proxmox-Host');
  if (TEST_PVE) return { ok: true, test: true };
  const r = await pveRun(['create', `/nodes/${pveNode()}/${type}/${vmid}/status/${p.op}`], 8000);
  return { ok: true, pending: !r.done };
}

// pvesh im Hintergrund starten und kurz auf Fehler warten. Lange Aufgaben (Backup, Snapshot mit
// RAM-Zustand) laufen danach weiter; ihr Ergebnis steht unter "Aufgaben".
async function pveRun(args, waitMs = 10000) {
  if (!IS_PVE) throw new Error('Kein Proxmox-Host');
  const child = cp.spawn(...outside('pvesh', args), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), waitMs);
    child.on('close', (c) => { clearTimeout(t); resolve(c); });
    child.on('error', () => { clearTimeout(t); resolve(-1); });
  });
  child.unref();
  if (code !== null && code !== 0) throw new Error(out.trim().split('\n').filter(Boolean).pop() || `Fehler (${code})`);
  return { done: code !== null, output: out.trim() };
}

// ---------- Einstellungen von VMs/Containern ----------
const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/;
const SNAP_RE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const STORAGE_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const IFACE_RE = /^[a-zA-Z][\w.-]{0,14}$/;
const IPV4 = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`;
const CIDR_RE = new RegExp(`^${IPV4}/(?:[0-9]|[12]\\d|3[0-2])$`);
const IP_RE = new RegExp(`^${IPV4}$`);
const guestBase = (vmid, type) => `/nodes/${pveNode()}/${type}/${vmid}`;
const intIn = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what}: ${min} bis ${max}`);
  return n;
};
const normTags = (tags) => [...new Set((Array.isArray(tags) ? tags : String(tags || '').split(/[;,\s]+/))
  .map((t) => String(t).trim().toLowerCase()).filter((t) => /^[a-z0-9_][a-z0-9_+.-]*$/.test(t)))];

// "virtio=BC:24:11:..,bridge=vmbr0,tag=10" -> geordnete Schlüssel/Werte
function parseNet(str) {
  const parts = String(str || '').split(',').filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)];
  });
  const kv = Object.fromEntries(parts);
  const model = parts[0] && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(parts[0][1]) ? parts[0][0] : '';
  return {
    parts, model, mac: (model ? kv[model] : kv.hwaddr) || '', name: kv.name || '', bridge: kv.bridge || '',
    tag: kv.tag || '', firewall: kv.firewall === '1', ip: kv.ip || '', gw: kv.gw || '', rate: kv.rate || '',
  };
}
const buildNet = (parts) => parts.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(',');
function setPart(parts, key, value) {
  const i = parts.findIndex(([k]) => k === key);
  if (value === '' || value == null) { if (i >= 0) parts.splice(i, 1); return; }
  if (i >= 0) parts[i][1] = String(value); else parts.push([key, String(value)]);
}

async function pveConfigGet(p) {
  const { vmid, type } = checkGuest(p);
  if (TEST_PVE) return testFixture('config', type);
  const base = guestBase(vmid, type);
  const [c, pending] = await Promise.all([pvesh('get', `${base}/config`), pvesh('get', `${base}/pending`).catch(() => [])]);
  const startup = Object.fromEntries(String(c.startup || '').split(',').filter(Boolean).map((x) => x.split('=')));
  return {
    name: c.name || c.hostname || '', cores: Number(c.cores) || 1, sockets: Number(c.sockets) || 1,
    memory: Number(c.memory) || 512, swap: Number(c.swap) || 0, onboot: Number(c.onboot) === 1,
    startup: { order: startup.order || '', up: startup.up || '', down: startup.down || '' },
    tags: normTags(c.tags), description: c.description || '', ostype: c.ostype || '',
    protection: Number(c.protection) === 1,
    disks: Object.keys(c).filter((k) => /^(scsi|virtio|sata|ide|efidisk|tpmstate|unused)\d+$|^rootfs$|^mp\d+$/.test(k)).sort()
      .map((k) => {
        const v = String(c[k]);
        return { key: k, volume: v.split(',')[0], size: (v.match(/(?:^|,)size=([^,]+)/) || [])[1] || '', cdrom: /media=cdrom/.test(v), mount: (v.match(/(?:^|,)mp=([^,]+)/) || [])[1] || '' };
      }),
    nets: Object.keys(c).filter((k) => /^net\d+$/.test(k)).sort().map((k) => {
      const { parts, ...n } = parseNet(c[k]);
      return { key: k, ...n };
    }),
    pending: (pending || []).filter((x) => x.pending !== undefined || x.delete).map((x) => x.key),
  };
}

async function pveConfigSet(p) {
  const { vmid, type } = checkGuest(p);
  const ch = p.changes || {};
  const args = [];
  const del = [];
  if ('name' in ch) {
    if (!NAME_RE.test(ch.name)) throw new Error('Name: nur Buchstaben, Ziffern, Punkt und Bindestrich');
    args.push(type === 'lxc' ? '--hostname' : '--name', ch.name);
  }
  if ('cores' in ch) args.push('--cores', String(intIn(ch.cores, 1, 512, 'Kerne')));
  if ('sockets' in ch && type === 'qemu') args.push('--sockets', String(intIn(ch.sockets, 1, 16, 'Sockel')));
  if ('memory' in ch) args.push('--memory', String(intIn(ch.memory, 16, 8388608, 'RAM (MB)')));
  if ('swap' in ch && type === 'lxc') args.push('--swap', String(intIn(ch.swap, 0, 8388608, 'Swap (MB)')));
  if ('onboot' in ch) args.push('--onboot', ch.onboot ? '1' : '0');
  if ('protection' in ch) args.push('--protection', ch.protection ? '1' : '0');
  for (const key of Array.isArray(ch.removeNets) ? ch.removeNets : []) {
    if (!/^net\d+$/.test(key)) throw new Error('Ungültige Netzwerkkarte');
    del.push(key);
  }
  if ('startup' in ch) {
    const st = ch.startup || {};
    const sp = [];
    if (st.order !== '' && st.order != null) sp.push(`order=${intIn(st.order, 0, 99999, 'Startreihenfolge')}`);
    if (st.up !== '' && st.up != null) sp.push(`up=${intIn(st.up, 0, 86400, 'Startverzögerung')}`);
    if (st.down !== '' && st.down != null) sp.push(`down=${intIn(st.down, 0, 86400, 'Herunterfahr-Wartezeit')}`);
    if (sp.length) args.push('--startup', sp.join(',')); else del.push('startup');
  }
  if ('tags' in ch) {
    const t = normTags(ch.tags);
    if (t.length) args.push('--tags', t.join(';')); else del.push('tags');
  }
  if ('description' in ch) {
    const d = String(ch.description || '').slice(0, 8000);
    if (d.trim()) args.push('--description', d); else del.push('description');
  }
  if (Array.isArray(ch.nets) && ch.nets.length) {
    const cur = TEST_PVE ? {} : await pvesh('get', `${guestBase(vmid, type)}/config`);
    for (const n of ch.nets) {
      if (!/^net\d+$/.test(n.key)) throw new Error(`Ungültige Netzwerkkarte ${n.key}`);
      if (n.create && cur[n.key]) throw new Error(`${n.key} gibt es bereits`);
      if (!n.create && !TEST_PVE && !cur[n.key]) throw new Error(`Unbekannte Netzwerkkarte ${n.key}`);
      // Neue Karte: Proxmox vergibt die MAC-Adresse selbst
      const { parts } = n.create
        ? { parts: type === 'lxc' ? [['name', `eth${n.key.slice(3)}`], ['type', 'veth'], ['ip', 'dhcp']] : [['virtio', '']] }
        : parseNet(cur[n.key] || '');
      if (n.create && !n.bridge) throw new Error('Bitte eine Brücke wählen');
      if ('bridge' in n) {
        if (!IFACE_RE.test(n.bridge)) throw new Error('Ungültige Brücke');
        setPart(parts, 'bridge', n.bridge);
      }
      if ('tag' in n) setPart(parts, 'tag', n.tag === '' || n.tag == null ? '' : intIn(n.tag, 1, 4094, 'VLAN-Tag'));
      if ('firewall' in n) setPart(parts, 'firewall', n.firewall ? '1' : '0');
      if (type === 'lxc' && 'ip' in n) {
        if (n.ip !== 'dhcp' && n.ip !== 'manual' && !CIDR_RE.test(n.ip)) throw new Error('IP: "dhcp" oder z.B. 10.2.30.50/24');
        setPart(parts, 'ip', n.ip);
        const gw = CIDR_RE.test(n.ip) ? String(n.gw || '') : '';
        if (gw && !IP_RE.test(gw)) throw new Error('Ungültiges Gateway');
        setPart(parts, 'gw', gw);
      }
      args.push(`--${n.key}`, buildNet(parts));
    }
  }
  if (del.length) args.push('--delete', del.join(','));
  if (!args.length) return { ok: true, changed: false };
  if (TEST_PVE) return { ok: true, changed: true, args, pending: [] };
  await pvesh('set', `${guestBase(vmid, type)}/config`, args);
  const pending = await pvesh('get', `${guestBase(vmid, type)}/pending`).catch(() => []);
  return { ok: true, changed: true, pending: (pending || []).filter((x) => x.pending !== undefined || x.delete).map((x) => x.key) };
}

// Messwerte der letzten Stunde/des letzten Tages aus der Proxmox-Statistik
async function pveRrd(p) {
  const { vmid, type } = checkGuest(p);
  const timeframe = ['hour', 'day', 'week'].includes(p.timeframe) ? p.timeframe : 'hour';
  if (TEST_PVE) {
    const now = Date.now();
    return Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 60e3, cpu: 5 + 4 * Math.sin(i / 5) + (i % 7), mem: 40 + 3 * Math.sin(i / 9), netin: 2e4 * (1 + Math.sin(i / 4)), netout: 8e3 * (1 + Math.cos(i / 6)) }));
  }
  const rows = (await pvesh('get', `${guestBase(vmid, type)}/rrddata`, ['--timeframe', timeframe, '--cf', 'AVERAGE'])) || [];
  return rows.filter((r) => r.time && r.cpu != null).map((r) => ({
    t: r.time * 1000, cpu: Math.round((r.cpu || 0) * 1000) / 10, mem: r.maxmem ? Math.round((1000 * (r.mem || 0)) / r.maxmem) / 10 : 0,
    netin: r.netin || 0, netout: r.netout || 0,
  }));
}

// ---------- Snapshots ----------
async function pveSnapList(p) {
  const { vmid, type } = checkGuest(p);
  if (TEST_PVE) return testFixture('snapshots');
  const list = (await pvesh('get', `${guestBase(vmid, type)}/snapshot`)) || [];
  const current = list.find((x) => x.name === 'current');
  return {
    current: current?.parent || '',
    snapshots: list.filter((x) => x.name !== 'current').map((x) => ({ name: x.name, description: x.description || '', snaptime: (x.snaptime || 0) * 1000, vmstate: !!x.vmstate, parent: x.parent || '' }))
      .sort((a, b) => b.snaptime - a.snaptime),
  };
}

async function pveSnap(p) {
  const { vmid, type } = checkGuest(p);
  const name = String(p.snapname || '');
  if (!SNAP_RE.test(name)) throw new Error('Snapshot-Name: Buchstabe am Anfang, dann Buchstaben, Ziffern, _ oder - (2–40 Zeichen)');
  if (TEST_PVE) return { ok: true, test: true };
  const base = guestBase(vmid, type);
  if (p.op === 'create') {
    const args = ['create', `${base}/snapshot`, '--snapname', name];
    if (p.description) args.push('--description', String(p.description).slice(0, 2000));
    if (type === 'qemu' && p.vmstate) args.push('--vmstate', '1');
    return pveRun(args, 20000);
  }
  if (p.op === 'rollback') return pveRun(['create', `${base}/snapshot/${name}/rollback`], 20000);
  if (p.op === 'delete') return pveRun(['delete', `${base}/snapshot/${name}`], 20000);
  throw new Error('Unbekannte Snapshot-Aktion');
}

// ---------- Backups ----------
async function pveBackupInfo(p) {
  const { vmid } = checkGuest(p);
  if (TEST_PVE) return testFixture('backups');
  const node = pveNode();
  const storages = ((await pvesh('get', `/nodes/${node}/storage`, ['--content', 'backup'])) || []).filter((x) => x.active !== 0 && x.enabled !== 0);
  const lists = await Promise.all(storages.map((st) => pvesh('get', `/nodes/${node}/storage/${st.storage}/content`, ['--content', 'backup', '--vmid', String(vmid)]).catch(() => [])));
  return {
    storages: storages.map((x) => ({ storage: x.storage, type: x.type, avail: x.avail || 0, total: x.total || 0, used: x.used || 0 })),
    backups: lists.flatMap((l, i) => (l || []).map((b) => ({ volid: b.volid, storage: storages[i].storage, size: b.size || 0, ctime: (b.ctime || 0) * 1000, notes: b.notes || '', protected: !!b.protected })))
      .sort((a, b) => b.ctime - a.ctime),
  };
}

async function pveBackupRun(p) {
  const { vmid } = checkGuest(p);
  if (!STORAGE_RE.test(String(p.storage || ''))) throw new Error('Ungültiger Speicher');
  const mode = ['snapshot', 'suspend', 'stop'].includes(p.mode) ? p.mode : 'snapshot';
  if (TEST_PVE) return { ok: true, test: true };
  const args = ['create', `/nodes/${pveNode()}/vzdump`, '--vmid', String(vmid), '--storage', p.storage, '--mode', mode, '--compress', 'zstd'];
  if (p.notes) args.push('--notes-template', String(p.notes).slice(0, 500));
  return pveRun(args, 6000);
}

// ---------- Host: Status, Speicher, Updates, Aufgaben ----------
async function pveHostInfo() {
  if (TEST_PVE) return testFixture('host');
  const node = pveNode();
  const [status, storages, updates] = await Promise.all([
    pvesh('get', `/nodes/${node}/status`),
    pvesh('get', `/nodes/${node}/storage`),
    pvesh('get', `/nodes/${node}/apt/update`).catch(() => []),
  ]);
  return {
    status: {
      pveversion: status.pveversion || '', kversion: status.kversion || '', uptime: status.uptime || 0, loadavg: status.loadavg || [],
      cpu: status.cpu || 0, cpus: status.cpuinfo?.cpus || 0, cpuModel: status.cpuinfo?.model || '',
      memory: status.memory || {}, swap: status.swap || {}, rootfs: status.rootfs || {},
    },
    storages: (storages || []).map((x) => ({ storage: x.storage, type: x.type, content: x.content || '', active: x.active !== 0, enabled: x.enabled !== 0, shared: !!x.shared, used: x.used || 0, total: x.total || 0, avail: x.avail || 0 }))
      .sort((a, b) => a.storage.localeCompare(b.storage)),
    updates: (updates || []).map((u) => ({ package: u.Package, title: u.Title || '', from: u.OldVersion || '', to: u.Version || '', priority: u.Priority || '' }))
      .sort((a, b) => a.package.localeCompare(b.package)),
    rebootRequired: fs.existsSync('/run/reboot-required') || fs.existsSync('/var/run/reboot-required'),
  };
}

async function pveAptRefresh() {
  if (TEST_PVE) return { ok: true, test: true };
  return pveRun(['create', `/nodes/${pveNode()}/apt/update`], 120000);
}

async function pveTasks() {
  if (TEST_PVE) return testFixture('tasks');
  const list = (await pvesh('get', `/nodes/${pveNode()}/tasks`, ['--limit', '40', '--source', 'all'])) || [];
  return list.map((t) => ({ upid: t.upid, type: t.type, id: t.id || '', user: t.user || '', status: t.status || (t.endtime ? '' : 'läuft'), start: (t.starttime || 0) * 1000, end: (t.endtime || 0) * 1000 }));
}

// ---------- Netzwerk-Brücken des Hosts ----------
async function pveNetList() {
  if (TEST_PVE) return testFixture('network');
  const list = (await pvesh('get', `/nodes/${pveNode()}/network`)) || [];
  let diff = '';
  if (fs.existsSync('/etc/network/interfaces.new')) diff = (await exec('diff', ['-u', '/etc/network/interfaces', '/etc/network/interfaces.new'])).stdout;
  return {
    ifaces: list.map((i) => ({
      iface: i.iface, type: i.type, active: !!i.active, autostart: !!i.autostart, cidr: i.cidr || (i.address && i.netmask ? `${i.address}/${i.netmask}` : ''),
      gateway: i.gateway || '', ports: i.bridge_ports || i.slaves || '', vlanAware: !!i.bridge_vlan_aware, comments: (i.comments || '').trim(), method: i.method || '',
    })).sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true })),
    pending: !!diff,
    diff,
  };
}

async function pveNetSave(p) {
  const iface = String(p.iface || '');
  if (!/^vmbr\d{1,4}$/.test(iface)) throw new Error('Brücken heißen vmbr0, vmbr1, …');
  const args = ['--type', 'bridge'];
  const del = [];
  const cidr = String(p.cidr || '').trim();
  if (cidr && !CIDR_RE.test(cidr)) throw new Error('IP/Netz z.B. 192.168.10.1/24');
  if (cidr) args.push('--cidr', cidr); else if (!p.create) del.push('cidr');
  const gw = String(p.gateway || '').trim();
  if (gw && !IP_RE.test(gw)) throw new Error('Ungültiges Gateway');
  if (gw && !cidr) throw new Error('Ein Gateway braucht eine IP-Adresse');
  if (gw) args.push('--gateway', gw); else if (!p.create) del.push('gateway');
  const ports = String(p.ports || '').trim().split(/\s+/).filter(Boolean);
  if (ports.some((x) => !IFACE_RE.test(x))) throw new Error('Ungültiger Port-Name');
  if (ports.length) args.push('--bridge_ports', ports.join(' ')); else if (!p.create) del.push('bridge_ports');
  args.push('--bridge_vlan_aware', p.vlanAware ? '1' : '0', '--autostart', p.autostart === false ? '0' : '1');
  const comments = String(p.comments || '').replace(/[\r\n]+/g, ' ').slice(0, 200).trim();
  if (comments) args.push('--comments', comments); else if (!p.create) del.push('comments');
  if (del.length) args.push('--delete', del.join(','));
  if (TEST_PVE) return { ok: true, test: true, args };
  const node = pveNode();
  if (p.create) await pvesh('create', `/nodes/${node}/network`, ['--iface', iface, ...args]);
  else await pvesh('set', `/nodes/${node}/network/${iface}`, args);
  return { ok: true };
}

async function pveNetDelete(p) {
  const iface = String(p.iface || '');
  if (!/^vmbr\d{1,4}$/.test(iface)) throw new Error('Nur Brücken (vmbr…) können hier gelöscht werden');
  if (TEST_PVE) return { ok: true, test: true };
  await pvesh('delete', `/nodes/${pveNode()}/network/${iface}`);
  return { ok: true };
}

async function pveNetRevert() {
  if (TEST_PVE) return { ok: true, test: true };
  await pvesh('delete', `/nodes/${pveNode()}/network`);
  return { ok: true };
}

// Netzwerk-Änderungen anwenden – mit Sicherheitsnetz: Ist der BOLZO-Server danach nicht mehr
// erreichbar, wird die vorherige Konfiguration wiederhergestellt (sonst wäre der Host ausgesperrt).
async function pveNetApply() {
  if (TEST_PVE) return { ok: true, test: true };
  const backup = readFile('/etc/network/interfaces');
  if (!backup) throw new Error('/etc/network/interfaces nicht lesbar');
  if (!fs.existsSync('/etc/network/interfaces.new')) return { ok: true, changed: false };
  fs.writeFileSync('/etc/network/interfaces.bolzo-backup', backup);
  const r = await exec(...outside('pvesh', ['set', `/nodes/${pveNode()}/network`]), { timeout: 120000 });
  const reachable = async () => {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      try {
        const res = await fetch(`${cfg.server}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return true;
      } catch {}
      await sleep(3000);
    }
    return false;
  };
  await sleep(3000);
  if (await reachable()) return { ok: true, changed: true, output: (r.stdout + r.stderr).trim().slice(-2000) };
  log('Server nach Netzwerkänderung nicht erreichbar – stelle vorherige Konfiguration wieder her');
  fs.writeFileSync('/etc/network/interfaces', backup);
  await exec('ifreload', ['-a'], { timeout: 60000 });
  return { ok: false, rolledBack: true, message: 'Server danach nicht erreichbar – alte Netzwerk-Konfiguration wurde wiederhergestellt' };
}

// Testdaten für den Testmodus ohne Proxmox
function testFixture(kind, type) {
  const now = Date.now();
  switch (kind) {
    case 'config': return {
      name: type === 'lxc' ? 'test-ct' : 'test-vm', cores: 2, sockets: 1, memory: 4096, swap: 512, onboot: true,
      startup: { order: '2', up: '30', down: '' }, tags: ['web', 'prod'], description: 'Testgast\nzweite Zeile', ostype: type === 'lxc' ? 'debian' : 'win11',
      protection: false,
      disks: type === 'lxc'
        ? [{ key: 'rootfs', volume: 'local-lvm:vm-102-disk-0', size: '8G', cdrom: false, mount: '' }, { key: 'mp0', volume: 'nas:102/vm-102-disk-1.raw', size: '100G', cdrom: false, mount: '/data' }]
        : [{ key: 'scsi0', volume: 'local-lvm:vm-101-disk-0', size: '64G', cdrom: false, mount: '' }, { key: 'ide2', volume: 'local:iso/virtio-win.iso', size: '', cdrom: true, mount: '' }],
      nets: [type === 'lxc'
        ? { key: 'net0', model: '', mac: 'bc:24:11:00:00:02', name: 'eth0', bridge: 'vmbr0', tag: '', firewall: true, ip: '10.2.30.52/24', gw: '10.2.30.1', rate: '' }
        : { key: 'net0', model: 'virtio', mac: 'bc:24:11:00:00:01', name: '', bridge: 'vmbr0', tag: '20', firewall: false, ip: '', gw: '', rate: '' }],
      pending: [],
    };
    case 'snapshots': return { current: 'vor-update', snapshots: [
      { name: 'vor-update', description: 'Vor dem großen Update', snaptime: now - 3 * 864e5, vmstate: true, parent: 'basis' },
      { name: 'basis', description: '', snaptime: now - 40 * 864e5, vmstate: false, parent: '' },
    ] };
    case 'backups': return {
      storages: [{ storage: 'local', type: 'dir', avail: 80e9, total: 100e9, used: 20e9 }, { storage: 'nas-backup', type: 'nfs', avail: 1.2e12, total: 2e12, used: 0.8e12 }],
      backups: [{ volid: 'nas-backup:backup/vzdump-qemu-101-2026_10_10-03_00_01.vma.zst', storage: 'nas-backup', size: 12.4e9, ctime: now - 864e5, notes: 'nächtlich', protected: false }],
    };
    case 'host': return {
      status: { pveversion: 'pve-manager/9.2.21', kversion: 'Linux 6.14.8-2-pve', uptime: 1820000, loadavg: ['0.52', '0.61', '0.70'], cpu: 0.21, cpus: 16, cpuModel: 'AMD Ryzen 7 5700G', memory: { used: 26e9, total: 32e9 }, swap: { used: 0, total: 8e9 }, rootfs: { used: 30e9, total: 100e9 } },
      storages: [
        { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup', active: true, enabled: true, shared: false, used: 20e9, total: 100e9, avail: 80e9 },
        { storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir', active: true, enabled: true, shared: false, used: 310e9, total: 450e9, avail: 140e9 },
        { storage: 'nas-backup', type: 'nfs', content: 'backup', active: true, enabled: true, shared: true, used: 0.8e12, total: 2e12, avail: 1.2e12 },
      ],
      updates: [
        { package: 'pve-manager', title: 'Proxmox Virtual Environment Management Tools', from: '9.2.21', to: '9.2.22', priority: 'important' },
        { package: 'proxmox-kernel-6.14', title: 'Latest Proxmox Kernel Image', from: '6.14.8-2', to: '6.14.11-1', priority: 'optional' },
      ],
      rebootRequired: false,
    };
    case 'tasks': return [
      { upid: 'UPID:test:1', type: 'vzdump', id: '101', user: 'root@pam', status: 'läuft', start: now - 120e3, end: 0 },
      { upid: 'UPID:test:2', type: 'qmsnapshot', id: '101', user: 'root@pam', status: 'OK', start: now - 3600e3, end: now - 3590e3 },
      { upid: 'UPID:test:3', type: 'vzstart', id: '102', user: 'root@pam', status: 'command failed: exit code 1', start: now - 7200e3, end: now - 7199e3 },
    ];
    case 'network': return {
      ifaces: [
        { iface: 'enp3s0', type: 'eth', active: true, autostart: false, cidr: '', gateway: '', ports: '', vlanAware: false, comments: '', method: 'manual' },
        { iface: 'vmbr0', type: 'bridge', active: true, autostart: true, cidr: '10.2.30.2/24', gateway: '10.2.30.1', ports: 'enp3s0', vlanAware: true, comments: 'LAN', method: 'static' },
        { iface: 'vmbr1', type: 'bridge', active: true, autostart: true, cidr: '', gateway: '', ports: '', vlanAware: false, comments: 'intern', method: 'manual' },
      ],
      pending: false, diff: '',
    };
    default: return null;
  }
}


const tunnels = new Map();

// Verbindet ein lokales Ziel (VNC-Socket der VM) mit einem eigenen WebSocket zum Server.
// Die Daten laufen binär durch, der Server reicht sie unverändert an die App weiter.
function openTunnel(sid, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(target);
    let tun = null;
    let finished = false;
    const close = () => {
      if (finished) return;
      finished = true;
      tunnels.delete(sid);
      sock.destroy();
      try { tun?.close(); } catch {}
    };
    tunnels.set(sid, { close });
    setTimeout(() => { if (!tun || tun.readyState !== 1) { reject(new Error('Zeitüberschreitung beim Tunnelaufbau')); close(); } }, 15000);
    sock.once('error', (e) => { reject(new Error(`VNC nicht erreichbar: ${e.message}`)); close(); });
    sock.on('close', close);
    sock.once('connect', () => {
      tun = new WebSocket(cfg.server.replace(/^http/, 'ws') + '/ws/tunnel');
      tun.binaryType = 'arraybuffer';
      tun.onopen = () => {
        tun.send(JSON.stringify({ type: 'hello', id: cfg.id, secret: cfg.secret, sid }));
        // erst jetzt lesen – bis dahin puffert der Socket (der VNC-Server spricht sofort)
        sock.on('data', (d) => { if (tun.readyState === 1) tun.send(d); });
        resolve();
      };
      tun.onmessage = (e) => { if (typeof e.data !== 'string') sock.write(Buffer.from(e.data)); };
      tun.onclose = close;
      tun.onerror = () => { reject(new Error('Tunnel zum Server fehlgeschlagen')); close(); };
    });
  });
}

async function vncOpen(p) {
  const sid = String(p.sid || '');
  if (!/^[\w-]{8,64}$/.test(sid)) throw new Error('Ungültige Sitzung');
  if (process.env.BOLZO_TEST_VNC) { // nur für Tests ohne Proxmox
    const [host, port] = process.env.BOLZO_TEST_VNC.split(':');
    await openTunnel(sid, { host, port: Number(port) });
    return { password: null };
  }
  const { vmid } = checkGuest({ vmid: p.vmid, type: 'qemu' });
  const node = pveNode();
  const st = await pvesh('get', `/nodes/${node}/qemu/${vmid}/status/current`);
  if (st?.status !== 'running') throw new Error('Die VM läuft nicht – bitte zuerst starten');
  // Einmal-Passwort für den VNC-Zugang setzen (wie die Proxmox-Weboberfläche), gilt 60 s für die Anmeldung
  let password = crypto.randomBytes(6).toString('base64url').slice(0, 8);
  try {
    const r = await pvesh('create', `/nodes/${node}/qemu/${vmid}/monitor`, ['--command', `set_password vnc ${password}`]);
    if (/error|could not/i.test(String(r || ''))) password = null;
    else await pvesh('create', `/nodes/${node}/qemu/${vmid}/monitor`, ['--command', 'expire_password vnc +60']);
  } catch {
    password = null;
  }
  await openTunnel(sid, { path: `/var/run/qemu-server/${vmid}.vnc` });
  return { password };
}

// ---------------------------------------------------------------------------
// Dateimanager: auflisten, Ordner anlegen, umbenennen, löschen, hoch-/herunterladen
// ---------------------------------------------------------------------------
const MAX_ENTRIES = 5000;

function absPath(p) {
  const s = String(p || '');
  if (!s) throw new Error('Pfad fehlt');
  return path.resolve(s);
}
// Schutz vor Versehen: Laufwerks-/Dateisystem-Wurzel nie löschen oder umbenennen
const isRoot = (p) => path.parse(p).root === p;

async function fsList({ path: p }) {
  if (!p && IS_WIN) {
    const drives = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      try { await fs.promises.access(`${l}:\\`); drives.push({ name: `${l}:`, path: `${l}:\\`, type: 'drive' }); } catch {}
    }
    return { path: '', parent: null, sep: '\\', entries: drives };
  }
  const dir = p ? absPath(p) : '/';
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries = [];
  await Promise.all(dirents.slice(0, MAX_ENTRIES).map(async (d) => {
    const full = path.join(dir, d.name);
    let st = null;
    try { st = await fs.promises.stat(full); } catch {}
    const type = st?.isDirectory() ? 'dir' : st?.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other';
    entries.push({ name: d.name, path: full, type, size: st?.size ?? null, mtime: st?.mtimeMs ?? null, link: d.isSymbolicLink() });
  }));
  entries.sort((a, b) => (b.type === 'dir') - (a.type === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = isRoot(dir) ? (IS_WIN ? '' : null) : path.dirname(dir);
  return { path: dir, parent, sep: path.sep, entries, truncated: dirents.length > MAX_ENTRIES };
}

async function fsMkdir({ path: p }) {
  await fs.promises.mkdir(absPath(p), { recursive: true });
  return { ok: true };
}

async function fsRename({ from, name }) {
  const src = absPath(from);
  const n = String(name || '');
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') throw new Error('Ungültiger Name');
  if (isRoot(src)) throw new Error('Die Wurzel kann nicht umbenannt werden');
  const dst = path.join(path.dirname(src), n);
  if (fs.existsSync(dst)) throw new Error(`„${n}“ gibt es dort bereits`);
  await fs.promises.rename(src, dst);
  return { ok: true, path: dst };
}

async function fsDelete({ paths }) {
  const list = (Array.isArray(paths) ? paths : []).map(absPath);
  if (!list.length) throw new Error('Nichts ausgewählt');
  if (list.some(isRoot)) throw new Error('Die Wurzel eines Laufwerks kann nicht gelöscht werden');
  for (const p of list) await fs.promises.rm(p, { recursive: true, force: true });
  return { ok: true, deleted: list.length };
}

// Eigener WebSocket zum Server für eine Übertragung (Anmeldung wie beim VNC-Tunnel)
function openStreamTunnel(sid) {
  return new Promise((resolve, reject) => {
    const tun = new WebSocket(cfg.server.replace(/^http/, 'ws') + '/ws/tunnel');
    tun.binaryType = 'arraybuffer';
    const t = setTimeout(() => { reject(new Error('Zeitüberschreitung beim Tunnelaufbau')); try { tun.close(); } catch {} }, 15000);
    tun.onopen = () => {
      clearTimeout(t);
      tun.send(JSON.stringify({ type: 'hello', id: cfg.id, secret: cfg.secret, sid }));
      resolve(tun);
    };
    tun.onerror = () => { clearTimeout(t); reject(new Error('Tunnel zum Server fehlgeschlagen')); };
  });
}

// Herunterladen: Server schickt "go", sobald die HTTP-Antwort bereit ist, und bestätigt
// laufend, wie viel er weitergegeben hat – so bleiben höchstens 4 MB unterwegs.
async function fsDownload({ sid, path: p }) {
  const file = absPath(p);
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw new Error('Nur Dateien können heruntergeladen werden');
  const tun = await openStreamTunnel(String(sid));
  let acked = 0;
  let wake = null;
  let started = null;
  const go = new Promise((r) => (started = r));
  tun.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    if (e.data === 'go') return started();
    try { const m = JSON.parse(e.data); if (m.ack) { acked = m.ack; wake?.(); } } catch {}
  };
  tun.onclose = () => { started(); wake?.(); };
  (async () => {
    await go;
    let sent = 0;
    try {
      for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
        if (tun.readyState !== 1) return;
        tun.send(chunk);
        sent += chunk.length;
        while (sent - acked > 4 * 1024 * 1024 && tun.readyState === 1) await new Promise((r) => { wake = r; setTimeout(r, 5000); });
      }
      if (tun.readyState === 1) tun.send(JSON.stringify({ eof: true }));
    } catch (e) {
      if (tun.readyState === 1) tun.send(JSON.stringify({ error: e.message }));
    }
  })();
  return { size: st.size, name: path.basename(file) };
}

// Hochladen: erst in "<name>.bolzo-teil" schreiben, nach "EOF" umbenennen
async function fsUpload({ sid, dir, name }) {
  const n = String(name || '');
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') throw new Error('Ungültiger Dateiname');
  const target = path.join(absPath(dir), n);
  const part = `${target}.bolzo-teil`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const out = fs.createWriteStream(part);
  const tun = await openStreamTunnel(String(sid));
  let written = 0;
  let done = false;
  tun.onmessage = async (e) => {
    if (typeof e.data !== 'string') {
      const buf = Buffer.from(e.data);
      written += buf.length;
      out.write(buf);
      return;
    }
    if (e.data !== 'EOF') return;
    done = true;
    out.end(async () => {
      try {
        await fs.promises.rm(target, { force: true });
        await fs.promises.rename(part, target);
        tun.send(JSON.stringify({ ok: true, size: written, path: target }));
      } catch (err) {
        tun.send(JSON.stringify({ error: err.message }));
      }
      setTimeout(() => { try { tun.close(); } catch {} }, 500);
    });
  };
  tun.onclose = () => { if (!done) { out.destroy(); fs.promises.rm(part, { force: true }).catch(() => {}); } };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Energie, Wake-on-LAN, Update, Deinstallation
// ---------------------------------------------------------------------------
function power(kind) {
  setTimeout(() => {
    if (IS_WIN) cp.execFile('shutdown', [kind === 'reboot' ? '/r' : '/s', '/t', '5', '/f', '/c', 'BOLZO RMM'], { windowsHide: true }, () => {});
    else cp.execFile('systemctl', [kind === 'reboot' ? 'reboot' : 'poweroff'], (err) => {
      if (err) cp.execFile('shutdown', [kind === 'reboot' ? '-r' : '-h', 'now'], () => {});
    });
  }, 1000);
  return { ok: true };
}

function wol({ macs }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      let pending = macs.length;
      for (const mac of macs) {
        const hex = mac.replace(/[^0-9a-f]/gi, '');
        if (hex.length !== 12) { if (--pending === 0) { sock.close(); resolve({ ok: true }); } continue; }
        const buf = Buffer.alloc(102, 0xff);
        for (let i = 1; i <= 16; i++) Buffer.from(hex, 'hex').copy(buf, i * 6);
        sock.send(buf, 9, '255.255.255.255', () => {
          if (--pending === 0) { sock.close(); resolve({ ok: true }); }
        });
      }
    });
  });
}

async function selfUpdate() {
  const res = await fetch(`${cfg.server}/agent/agent.js`);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const code = await res.text();
  if (!code.includes('BOLZO RMM Agent')) throw new Error('Unerwarteter Inhalt');
  const target = path.join(__dirname, 'agent.js');
  fs.writeFileSync(target + '.new', code);
  fs.renameSync(target + '.new', target);
  log('Agent aktualisiert – starte neu');
  setTimeout(() => process.exit(0), 1000); // Dienst/Aufgabe startet den Agent neu
  return { ok: true };
}

function uninstall() {
  setTimeout(() => {
    if (IS_WIN) {
      const dir = __dirname.replace(/'/g, "''");
      const cmd = `Start-Sleep 3; Unregister-ScheduledTask -TaskName 'BolzoRMMAgent' -Confirm:$false; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*BolzoRMMAgent\\run.cmd*') -or ($_.Name -eq 'node.exe' -and $_.ExecutablePath -like '${dir}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep 2; Remove-Item -Recurse -Force '${dir}'`;
      cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      cp.spawn('sh', ['-c', `sleep 2; systemctl disable --now bolzo-rmm-agent; rm -f /etc/systemd/system/bolzo-rmm-agent.service; systemctl daemon-reload; rm -rf '${__dirname}'`], { detached: true, stdio: 'ignore' }).unref();
    }
  }, 500);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Verbindung zum Server
// ---------------------------------------------------------------------------
let ws = null;
let wsSince = 0; // seit wann die aktuelle Verbindung aufgebaut wird bzw. besteht
let lastServerMsg = Date.now();

// ---------------------------------------------------------------------------
// Umzug auf eine andere Server-Adresse
// ---------------------------------------------------------------------------
// Probiert die Adressen der Reihe nach und nimmt die erste, unter der genau dieser
// Server (gleiche serverId) erreichbar ist. Klappt danach keine Verbindung, kehrt
// der Agent nach einigen Versuchen automatisch zur alten Adresse zurück.
async function probeServer(url, serverId) {
  const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const h = await res.json();
  if (!h.ok) throw new Error('keine gültige Antwort');
  if (serverId && h.id !== serverId) throw new Error('anderer Server');
}

async function setServer({ urls, serverId }) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || '').replace(/\/+$/, '')).filter((u) => /^https?:\/\/[^\s"']+$/.test(u));
  if (!list.length) throw new Error('Keine gültige Adresse');
  const tried = [];
  for (const url of list) {
    if (url === cfg.server) return { changed: false, url, tried, note: 'nutzt diese Adresse bereits' };
    try {
      await probeServer(url, serverId);
    } catch (e) {
      tried.push({ url, error: e.message });
      continue;
    }
    cfg.pendingSwitch = { previous: cfg.server, at: Date.now(), failures: 0 };
    cfg.server = url;
    saveCfg();
    log(`Server-Adresse gewechselt auf ${url} (vorher ${cfg.pendingSwitch.previous})`);
    // Antwort noch über die alte Verbindung senden lassen, dann neu verbinden
    setTimeout(() => ws?.abandon(), 500);
    return { changed: true, url, tried };
  }
  return { changed: false, url: cfg.server, tried, note: 'keine der Adressen erreichbar – alte Adresse bleibt' };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

const actions = {
  info: getInfo,
  // fast: nur Name + PID (z.B. zum Beenden per Sprachsteuerung) – ohne die langsame CPU-Messung
  processes: ({ fast } = {}) => (fast ? quickProcesses() : IS_WIN ? windowsProcesses() : linuxProcesses()),
  kill: ({ pid }) => {
    if (!Number.isInteger(pid) || pid <= 4) throw new Error('Ungültige PID');
    process.kill(pid, 'SIGKILL');
    return { ok: true };
  },
  services,
  service: serviceAction,
  run: runScript,
  reboot: () => power('reboot'),
  shutdown: () => power('shutdown'),
  wol,
  update: selfUpdate,
  setServer,
  uninstall,
  'shell.open': openShell,
  'pve.guests': pveGuestsCached,
  'pve.power': pveFresh(pvePower),
  'pve.restartAgent': pveRestartAgent,
  'pve.destroy': pveFresh(pveDestroy),
  'fs.list': fsList,
  'fs.mkdir': fsMkdir,
  'fs.rename': fsRename,
  'fs.delete': fsDelete,
  'fs.download': fsDownload,
  'fs.upload': fsUpload,
  'pve.config.get': pveConfigGet,
  'pve.config.set': pveFresh(pveConfigSet),
  'pve.rrd': pveRrd,
  'pve.snap.list': pveSnapList,
  'pve.snap': pveFresh(pveSnap),
  'pve.backup.info': pveBackupInfo,
  'pve.backup.run': pveBackupRun,
  'pve.host': pveHostInfo,
  'pve.apt.refresh': pveAptRefresh,
  'pve.tasks': pveTasks,
  'pve.net.list': pveNetList,
  'pve.net.save': pveNetSave,
  'pve.net.delete': pveNetDelete,
  'pve.net.revert': pveNetRevert,
  'pve.net.apply': pveNetApply,
  'vnc.open': vncOpen,
  'tunnel.close': ({ sid }) => { tunnels.get(sid)?.close(); return { ok: true }; },
};

async function handle(msg) {
  lastServerMsg = Date.now();
  switch (msg.type) {
    case 'request': {
      try {
        const fn = actions[msg.action];
        if (!fn) throw new Error(`Unbekannte Aktion: ${msg.action}`);
        const data = await fn(msg.params || {});
        send({ type: 'result', reqId: msg.reqId, ok: true, data });
      } catch (e) {
        send({ type: 'result', reqId: msg.reqId, ok: false, error: e.message });
      }
      break;
    }
    case 'shell.in': {
      const s = shells.get(msg.sid);
      if (s) s.child.stdin.write(Buffer.from(msg.data, 'base64'));
      break;
    }
    case 'shell.close':
      closeShell(msg.sid);
      break;
    case 'revoked':
      log('Agent wurde auf dem Server gelöscht – Verbindung wird beendet.');
      cfg.revoked = true;
      saveCfg();
      process.exit(0);
  }
}

async function enroll() {
  if (cfg.id && cfg.secret) return;
  if (!cfg.enrollKey) throw new Error('Kein Installationsschlüssel in der Konfiguration');
  const res = await fetch(`${cfg.server}/agent/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: cfg.enrollKey, hostname: os.hostname(), platform: process.platform, machineId: await machineId() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Registrierung fehlgeschlagen (${res.status})`);
  cfg.id = body.id;
  cfg.secret = body.secret;
  delete cfg.enrollKey;
  saveCfg();
  log(`Beim Server registriert als ${cfg.id}`);
}

let backoff = 2000;
let failedSince = 0;
function connect() {
  const url = cfg.server.replace(/^http/, 'ws') + '/ws/agent';
  const sock = new WebSocket(url);
  ws = sock;
  wsSince = Date.now();
  let welcomed = false;
  let finished = false;

  // Verbindung endgültig aufgeben und neu verbinden – auch wenn der Socket im Auf- oder
  // Abbau hängen bleibt und nie ein close-Ereignis liefert (z.B. Server mitten im Neustart).
  const finish = () => {
    if (finished) return;
    finished = true;
    sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
    if (ws === sock) ws = null;
    for (const sid of [...shells.keys()]) closeShell(sid);
    // Nach einem Umzug: kommt keine Verbindung zustande, zurück zur alten Adresse
    if (!welcomed && cfg.pendingSwitch && ++cfg.pendingSwitch.failures >= 4) {
      log(`Neue Adresse ${cfg.server} nicht erreichbar – zurück zu ${cfg.pendingSwitch.previous}`);
      cfg.server = cfg.pendingSwitch.previous;
      delete cfg.pendingSwitch;
      saveCfg();
      backoff = 2000;
    }
    if (welcomed) failedSince = 0;
    else if (!failedSince) {
      failedSince = Date.now();
      log(`Keine Verbindung zu ${cfg.server} – versuche es weiter`);
    }
    const wait = welcomed ? 2000 : backoff;
    if (!welcomed) backoff = Math.min(backoff * 2, 60000);
    setTimeout(connect, wait);
  };
  sock.abandon = () => {
    try { sock.close(); } catch {}
    finish();
  };

  sock.onopen = async () => {
    lastServerMsg = Date.now();
    send({ type: 'hello', id: cfg.id, secret: cfg.secret, version: VERSION, hash: CODE_HASH, serverUrl: cfg.server, info: await getInfo() });
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'welcome') {
      welcomed = true;
      backoff = 2000;
      failedSince = 0;
      log(`Verbunden mit ${cfg.server}`);
      if (cfg.pendingSwitch) {
        delete cfg.pendingSwitch; // Umzug bestätigt
        saveCfg();
      }
      send({ type: 'metrics', metrics: collectMetrics() });
      return;
    }
    if (msg.type === 'denied') {
      log(`Server lehnt Anmeldung ab (${msg.reason}).`);
      backoff = 10 * 60e3;
      return;
    }
    handle(msg);
  };
  sock.onclose = finish;
  sock.onerror = () => {};
}

async function main() {
  if (cfg.revoked) {
    log('Dieser Agent wurde vom Server entfernt. Bitte neu installieren.');
    await sleep(3600e3);
    process.exit(0);
  }
  log(`BOLZO RMM Agent ${VERSION} auf ${os.hostname()} (${process.platform}), Node ${process.version}`);
  if (typeof WebSocket === 'undefined') {
    log('Node.js >= 22 wird benötigt.');
    process.exit(1);
  }
  for (;;) {
    try {
      await enroll();
      break;
    } catch (e) {
      log('Registrierung:', e.message, '– neuer Versuch in 30 s');
      await sleep(30000);
    }
  }
  await refreshDisks();
  connect();
  setInterval(() => send({ type: 'metrics', metrics: collectMetrics() }), METRICS_INTERVAL);
  setInterval(refreshDisks, DISK_INTERVAL);
  setInterval(async () => send({ type: 'info', info: await getInfo() }), 10 * 60e3);
  // Hängende Verbindung erkennen (Server schickt alle 30 s ein Ping)
  setInterval(() => {
    if (!ws) return;
    if (ws.readyState === 1 && Date.now() - lastServerMsg > 95000) {
      log('Keine Nachricht vom Server seit 95 s – verbinde neu');
      ws.abandon();
    } else if (ws.readyState !== 1 && Date.now() - wsSince > 60000) {
      log('Verbindungsaufbau hängt seit 60 s – verbinde neu');
      ws.abandon();
    }
  }, 15000);
}

main();
