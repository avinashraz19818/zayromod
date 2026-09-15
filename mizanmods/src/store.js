import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export class Store {
  constructor(data) {
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(data, 'mizanmods.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, config TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, log TEXT NOT NULL DEFAULT '', sha256 TEXT, bytes INTEGER);
      CREATE INDEX IF NOT EXISTS builds_created ON builds(created);`);
  }
  decode(row) { return row ? { ...row, config: JSON.parse(row.config) } : null; }
  list() { return this.db.prepare('SELECT * FROM builds ORDER BY created DESC LIMIT 100').all().map(r => this.decode(r)); }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM builds WHERE id=?').get(id)); }
  create(config) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO builds(id,config,status,created,updated) VALUES(?,?,?,?,?)').run(id, JSON.stringify(config), 'queued', now, now);
    return this.get(id);
  }
  update(id, patch) {
    const allowed = ['status', 'progress', 'log', 'sha256', 'bytes'];
    const keys = Object.keys(patch).filter(k => allowed.includes(k));
    if (!keys.length) return;
    this.db.prepare(`UPDATE builds SET ${keys.map(k => `${k}=?`).join(',')}, updated=? WHERE id=?`).run(...keys.map(k => patch[k]), new Date().toISOString(), id);
  }
  log(id, message) { this.update(id, { log: (this.get(id).log + message + '\n').slice(-24000) }); }
  pending() { return this.db.prepare("SELECT id FROM builds WHERE status='queued' ORDER BY created").all().map(r => r.id); }
  recover() { this.db.prepare("UPDATE builds SET status='failed', log=log || 'Build interrupted by server restart. Please rebuild.\n' WHERE status='building'").run(); }
  expired(cutoff) { return this.db.prepare("SELECT id FROM builds WHERE status IN ('ready','failed','expired') AND updated < ?").all(cutoff); }
  close() { this.db.close(); }
}
