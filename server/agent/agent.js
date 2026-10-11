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

const VERSION = '1.3.0';
// Fingerabdruck des eigenen Codes – der Server erkennt daran veraltete Agents
const CODE_HASH = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const IS_WIN = process.platform === 'win32';
// BOLZO_TEST_VNC=host:port: Testmodus ohne Proxmox (spielt einen Host mit zwei Gästen vor)
const TEST_PVE = !!process.env.BOLZO_TEST_VNC;
const IS_PVE = TEST_PVE || (!IS_WIN && fs.existsSync('/usr/bin/pvesh'));
const pveNode = () => os.hostname().split('.')[0];
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
    const v = (await exec('pveversion', [])).stdout.match(/pve-manager\/([^/\s]+)/);
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
function runScript({ body, shell, timeout = 300 }) {
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
    const [cmd, args] = cmds[shell];
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
      const target = lxc != null ? `pct enter ${lxc}` : `${sh} -l`;
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
  const r = await exec('pvesh', [method, apiPath, ...args, '--output-format', 'json'], { timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'pvesh-Fehler');
  try { return JSON.parse(r.stdout || 'null'); } catch { return r.stdout.trim(); }
}

// MAC-Adressen aus der Gast-Konfiguration (für die automatische Zuordnung)
function guestMacs(type, vmid) {
  const conf = readFile(`/etc/pve/nodes/${pveNode()}/${PVE_TYPES[type]}/${vmid}.conf`).split(/^\[/m)[0]; // ohne Snapshots
  return [...conf.matchAll(/^net\d+:.*?=([0-9a-f]{2}(?::[0-9a-f]{2}){5})/gim)].map((m) => m[1].toLowerCase());
}

async function pveGuests() {
  if (TEST_PVE) {
    const mac = (interfaces()[0]?.mac || '').toLowerCase();
    return { node: 'test', guests: [
      { vmid: 101, type: 'qemu', name: 'test-vm', status: 'running', template: false, cpu: 0.12, cpus: 2, mem: 1.2e9, maxmem: 4e9, uptime: 7300, macs: [mac] },
      { vmid: 102, type: 'lxc', name: 'test-ct', status: 'stopped', template: false, cpu: 0, cpus: 1, mem: 0, maxmem: 1e9, uptime: 0, macs: [] },
    ] };
  }
  const node = pveNode();
  const [vms, cts] = await Promise.all([pvesh('get', `/nodes/${node}/qemu`), pvesh('get', `/nodes/${node}/lxc`)]);
  const map = (type) => (g) => ({
    vmid: Number(g.vmid), type, name: g.name || '', status: g.status || '', template: !!g.template,
    cpu: g.cpu || 0, cpus: g.cpus || g.maxcpu || 0, mem: g.mem || 0, maxmem: g.maxmem || 0, uptime: g.uptime || 0,
    macs: guestMacs(type, g.vmid),
  });
  return { node, guests: [...(vms || []).map(map('qemu')), ...(cts || []).map(map('lxc'))].sort((a, b) => a.vmid - b.vmid) };
}

// Starten/Herunterfahren können lange dauern: kurz auf Fehler warten, dann im Hintergrund weiterlaufen lassen
async function pvePower(p) {
  const { vmid, type } = checkGuest(p);
  if (!PVE_OPS.includes(p.op)) throw new Error('Unbekannte Aktion');
  if (!IS_PVE) throw new Error('Kein Proxmox-Host');
  if (TEST_PVE) return { ok: true, test: true };
  const child = cp.spawn('pvesh', ['create', `/nodes/${pveNode()}/${type}/${vmid}/status/${p.op}`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    child.on('close', (c) => { clearTimeout(t); resolve(c); });
    child.on('error', () => { clearTimeout(t); resolve(-1); });
  });
  child.unref();
  if (code !== null && code !== 0) throw new Error(out.trim().split('\n').filter(Boolean).pop() || `Fehler (${code})`);
  return { ok: true, pending: code === null };
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
  processes: () => (IS_WIN ? windowsProcesses() : linuxProcesses()),
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
  'pve.guests': pveGuests,
  'pve.power': pvePower,
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
