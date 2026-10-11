'use strict';
// Audit-Log: wer hat wann was getan. Jeder Eintrag wird sofort als eine JSON-Zeile an
// audit.jsonl angehängt (nur anhängen, aus der App nicht löschbar). Die letzten Einträge
// liegen zusätzlich im Speicher, damit die App schnell filtern kann.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 20 * 1024 * 1024; // danach nach audit.1.jsonl rotieren (eine alte Datei bleibt)
const MAX_MEMORY = 20000;

class AuditLog {
  constructor(dir) {
    this.file = path.join(dir, 'audit.jsonl');
    this.old = path.join(dir, 'audit.1.jsonl');
    this.entries = []; // neueste zuerst
    this.listeners = new Set();
    for (const f of [this.old, this.file]) this._read(f);
    this.entries.reverse();
    if (this.entries.length > MAX_MEMORY) this.entries.length = MAX_MEMORY;
  }

  _read(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { this.entries.push(JSON.parse(line)); } catch {}
    }
  }

  // e: { cat, action, actor, ip, agentId, target, detail, ok, ref }
  add(e) {
    const entry = { id: crypto.randomUUID(), ts: Date.now(), ok: true, ...e };
    for (const k of Object.keys(entry)) if (entry[k] === undefined || entry[k] === '') delete entry[k];
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_FILE) fs.renameSync(this.file, this.old);
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error('[audit] Schreiben fehlgeschlagen:', err.message);
    }
    this.entries.unshift(entry);
    if (this.entries.length > MAX_MEMORY) this.entries.pop();
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  onEntry(fn) { this.listeners.add(fn); }

  query({ cat, agentId, q, before, limit = 200 } = {}) {
    const cats = cat ? new Set(String(cat).split(',')) : null;
    const needle = q ? String(q).toLowerCase() : '';
    const out = [];
    let more = false;
    for (const e of this.entries) {
      if (before && e.ts >= before) continue;
      if (cats && !cats.has(e.cat)) continue;
      if (agentId && e.agentId !== agentId) continue;
      if (needle && ![e.action, e.actor, e.ip, e.target, e.detail].some((v) => v && String(v).toLowerCase().includes(needle))) continue;
      if (out.length >= limit) { more = true; break; }
      out.push(e);
    }
    return { items: out, more };
  }
}

module.exports = { AuditLog };
