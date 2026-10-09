// Fern-Terminal auf Basis von xterm.js.
// Linux-Agents liefern ein echtes PTY ("pty"), Windows-Agents eine Pipe-Shell ("line"):
// dort übernimmt diese Klasse Echo, Zeilenbearbeitung und Befehlsverlauf.
import { api } from './api.js';

const enc = new TextEncoder();
function toB64(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export class RemoteTerminal {
  constructor(host, agentId, { onStatus } = {}) {
    this.host = host;
    this.agentId = agentId;
    this.onStatus = onStatus || (() => {});
    this.sid = null;
    this.mode = null;
    this.line = '';
    this.history = [];
    this.histIdx = -1;

    this.term = new window.Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#0b0b0c',
        foreground: '#dcdcd6',
        cursor: '#3987e5',
        selectionBackground: 'rgba(57,135,229,0.35)',
        black: '#1d1e22', brightBlack: '#5c5d64',
        red: '#e66767', brightRed: '#ff8a8a',
        green: '#3ccf3c', brightGreen: '#6be06b',
        yellow: '#fab219', brightYellow: '#ffd166',
        blue: '#3987e5', brightBlue: '#6da7ec',
        magenta: '#d55181', brightMagenta: '#e87ba4',
        cyan: '#1baf7a', brightCyan: '#4fd6a4',
        white: '#c3c2b7', brightWhite: '#f4f4f2',
      },
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.fit.fit();

    this.term.onData((d) => this._input(d));
    // Strg+C kopiert, wenn Text markiert ist; Strg+V fügt ein
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.key === 'c' && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.key === 'v') {
        navigator.clipboard.readText().then((t) => this._input(t));
        return false;
      }
      return true;
    });

    this.offShell = api.on('shell', (m) => this._onShell(m));
    this.ro = new ResizeObserver(() => { try { this.fit.fit(); } catch {} });
    this.ro.observe(host);
  }

  connect() {
    if (this.sid) api.send({ type: 'shell.close', sid: this.sid });
    this.sid = crypto.randomUUID();
    this.mode = null;
    this.line = '';
    this.onStatus('connecting');
    this.term.write('\x1b[90mVerbinde ...\x1b[0m\r\n');
    api.send({ type: 'shell.open', sid: this.sid, agentId: this.agentId, cols: this.term.cols, rows: this.term.rows });
    this.term.focus();
  }

  _onShell(m) {
    if (m.sid !== this.sid) return;
    switch (m.type) {
      case 'shell.opened':
        this.mode = m.mode;
        this.term.options.convertEol = m.mode === 'line';
        this.onStatus('open', m);
        break;
      case 'shell.out':
        this.term.write(fromB64(m.data));
        break;
      case 'shell.error':
        this.term.write(`\r\n\x1b[31m${m.error}\x1b[0m\r\n`);
        this.sid = null;
        this.onStatus('closed');
        break;
      case 'shell.exit':
        this.term.write('\r\n\x1b[90m[Sitzung beendet]\x1b[0m\r\n');
        this.sid = null;
        this.onStatus('closed');
        break;
    }
  }

  _send(str) {
    if (this.sid) api.send({ type: 'shell.in', sid: this.sid, data: toB64(str) });
  }

  _input(data) {
    if (!this.sid || !this.mode) return;
    if (this.mode === 'pty') return this._send(data);

    // Zeilenmodus: lokale Bearbeitung, gesendet wird erst bei Enter
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (data.startsWith('\x1b[A', i) || data.startsWith('\x1b[B', i)) {
        const up = data[i + 2] === 'A';
        if (this.history.length) {
          this.histIdx = up ? Math.min(this.history.length - 1, this.histIdx + 1) : Math.max(-1, this.histIdx - 1);
          this._replaceLine(this.histIdx >= 0 ? this.history[this.history.length - 1 - this.histIdx] : '');
        }
        i += 3;
        continue;
      }
      if (ch === '\x1b') { i += data.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z~]?/)?.[0].length || 1; continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && data[i + 1] === '\n') i++;
        this.term.write('\r\n');
        this._send(this.line + '\n');
        if (this.line.trim() && this.history[this.history.length - 1] !== this.line) this.history.push(this.line);
        this.line = '';
        this.histIdx = -1;
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line.length) {
          const last = [...this.line].pop();
          this.line = this.line.slice(0, -last.length);
          this.term.write('\b \b');
        }
      } else if (ch === '\x03') {
        // Strg+C: Eingabe verwerfen bzw. laufenden Befehl durch neue Sitzung abbrechen
        if (this.line) {
          this.term.write('^C\r\n');
          this.line = '';
          this._send('\n');
        } else {
          this.term.write('^C\r\n\x1b[90mBefehl abgebrochen – starte neue Sitzung\x1b[0m\r\n');
          this.connect();
          return;
        }
      } else if (ch === '\x15') {
        this._replaceLine('');
      } else if (ch >= ' ' || ch === '\t') {
        this.line += ch;
        this.term.write(ch);
      }
      i++;
    }
  }

  _replaceLine(text) {
    this.term.write('\b \b'.repeat([...this.line].length));
    this.line = text;
    this.term.write(text);
  }

  dispose() {
    if (this.sid) api.send({ type: 'shell.close', sid: this.sid });
    this.sid = null;
    this.offShell();
    this.ro.disconnect();
    this.term.dispose();
  }
}
