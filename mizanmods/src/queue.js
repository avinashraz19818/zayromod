import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export class Queue {
  constructor(c, store) {
    this.c = c; this.store = store; this.active = null; this.stopped = false;
    store.recover();
    fs.rmSync(path.join(c.data, 'work'), { recursive: true, force: true });
    // Interrupted outputs are never offered as successful downloads.
    for (const j of store.list()) if (j.status === 'failed') fs.rmSync(path.join(c.data, 'artifacts', j.id), { recursive: true, force: true });
    this.timer = setInterval(() => this.cleanup(), 3600000); this.timer.unref();
    this.cleanup(); this.kick();
  }
  cleanup() {
    for (const { id } of this.store.expired(new Date(Date.now() - this.c.retention * 86400000).toISOString())) {
      fs.rmSync(path.join(this.c.data, 'artifacts', id), { recursive: true, force: true });
      if (this.store.get(id).status !== 'expired') this.store.update(id, { status: 'expired', log: 'Artifact expired under retention policy.' });
    }
  }
  kick() {
    if (this.active || this.stopped) return;
    const id = this.store.pending()[0]; if (!id) return;
    const job = this.store.get(id);
    this.store.update(id, { status: 'building' });
    const child = fork(path.join(this.c.root, 'src/worker.js'), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.active = child;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    let outcome = null;
    const timeout = setTimeout(() => { outcome = { type: 'failure', message: 'Build timeout; process group terminated.' }; kill('SIGKILL'); }, this.c.timeout);
    child.on('message', msg => {
      if (msg.type === 'progress') { this.store.log(id, msg.message); this.store.update(id, { progress: msg.progress }); }
      else outcome = msg;
    });
    child.on('error', e => { outcome = { type: 'failure', message: e.message }; });
    child.once('close', () => {
      clearTimeout(timeout); kill('SIGKILL');
      if (outcome?.type === 'result') this.store.update(id, { status: 'ready', progress: 100, ...outcome.result });
      else {
        this.store.update(id, { status: 'failed' }); this.store.log(id, outcome?.message || 'Build worker interrupted.');
        fs.rmSync(path.join(this.c.data, 'artifacts', id), { recursive: true, force: true });
      }
      fs.rmSync(path.join(this.c.data, 'work', id), { recursive: true, force: true });
      this.active = null; this.kick();
    });
    child.send({ config: this.c, job });
  }
  stop() { this.stopped = true; clearInterval(this.timer); if (this.active) { try { process.kill(-this.active.pid, 'SIGKILL'); } catch {} } }
}
