import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/validation.js';
import { config, ROOT } from '../src/config.js';
import { generateProject } from '../src/builder.js';
import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApp } from '../src/server.js';
const valid = { appName: 'MizanMods', packageName: 'com.mizanmods.app' };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mizanmods-test-'));
test('configuration fails closed without a unique admin token', () => {
  assert.throws(() => config({}), /ADMIN_TOKEN/);
  assert.throws(() => config({ ADMIN_TOKEN: 'a'.repeat(32), RETENTION_DAYS: '-1' }), /RETENTION/);
});
test('validates app, package, versions and rejects injection', () => {
  assert.equal(validate(valid).versionCode, 1);
  for (const packageName of ['com.class.app', '../other', "com.a.b';exec('x')", 'com.a', 'com.2b.app']) assert.throws(() => validate({ ...valid, packageName }));
  for (const appName of ['<script>', 'x\n', '', '   ', 'a'.repeat(49)]) assert.throws(() => validate({ ...valid, appName }));
  for (const versionCode of [0, '1', 1.5]) assert.throws(() => validate({ ...valid, versionCode }));
  assert.throws(() => validate({ ...valid, accent: 'red; color:evil' }));
});
test('project generation injects escaped content and deterministic release paths', () => {
  const dir = temp();
  try {
    generateProject(dir, { ...valid, appName: 'My App', welcome: '<script>alert(1)</script>', accent: '#abcdef' });
    const html = fs.readFileSync(path.join(dir, 'app/src/main/assets/popup.html'), 'utf8');
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('__WELCOME__'));
    assert.ok(fs.readFileSync(path.join(dir, 'app/build.gradle'), 'utf8').includes("applicationId 'com.mizanmods.app'"));
    assert.ok(fs.readFileSync(path.join(dir, 'app/src/main/assets/popup.css'), 'utf8').includes('#abcdef'));
    assert.ok(!fs.readFileSync(path.join(dir, 'app/src/main/AndroidManifest.xml'), 'utf8').includes('INTERNET'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('SQLite isolation, durable queue, restart recovery and bounded logs', () => {
  const a = temp(), b = temp(); let first = new Store(a), second = new Store(b);
  try {
    const j = first.create(validate(valid)); first.update(j.id, { status: 'building' }); first.log(j.id, 'x'.repeat(30000));
    assert.ok(first.get(j.id).log.length <= 24000); assert.equal(second.list().length, 0);
    first.close(); first = new Store(a); first.recover(); assert.equal(first.get(j.id).status, 'failed');
  } finally { first.close(); second.close(); fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});
test('API authentication, validation, queue limits, status, download guards and security headers', async () => {
  const dir = temp(), store = new Store(dir), c = config({ ADMIN_TOKEN: 't'.repeat(64), DATA_DIR: dir, MAX_QUEUE: '1' });
  const queue = { kick() {}, active: null };
  const server = createApp(c, store, queue).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/api/builds')).status, 401);
    const index = await fetch(base + '/'); assert.equal(index.status, 200); assert.ok(index.headers.get('content-security-policy'));
    assert.equal((await fetch(base + '/api/builds', { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(base + '/api/builds', { method: 'POST', headers, body: '{' })).status, 400);
    const response = await fetch(base + '/api/builds', { method: 'POST', headers, body: JSON.stringify(valid) });
    assert.equal(response.status, 202); const job = await response.json();
    assert.equal((await fetch(base + '/api/builds', { method: 'POST', headers, body: JSON.stringify(valid) })).status, 429);
    assert.equal((await fetch(`${base}/api/builds/${job.id}/download`, { headers })).status, 409);
    assert.equal((await fetch(`${base}/api/builds/not-a-build`, { headers })).status, 404);
    store.update(job.id, { status: 'ready' });
    assert.equal((await fetch(`${base}/api/builds/${job.id}/download`, { headers })).status, 410);
    fs.mkdirSync(path.join(dir, 'artifacts', job.id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', job.id, 'MizanMods.apk'), 'TEST ARTIFACT, NOT AN APK');
    const download = await fetch(`${base}/api/builds/${job.id}/download`, { headers });
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal((await fetch(`${base}/runtime/mizanmods.sqlite`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('worker reports missing toolchain, serial queue drains and cleans workspaces', async () => {
  const dir = temp(), store = new Store(dir), c = config({ ADMIN_TOKEN: 't'.repeat(64), DATA_DIR: dir, BUILD_TIMEOUT_MS: '3000' });
  const one = store.create(validate(valid)), two = store.create(validate(valid)); const q = new Queue(c, store);
  try {
    assert.equal(store.get(one.id).status, 'building'); assert.equal(store.get(two.id).status, 'queued');
    await new Promise((resolve, reject) => {
      const start = Date.now(); const timer = setInterval(() => {
        if (!q.active && store.pending().length === 0) { clearInterval(timer); resolve(); }
        else if (Date.now() - start > 10000) { clearInterval(timer); reject(Error('Queue did not drain')); }
      }, 30);
    });
    assert.equal(store.get(one.id).status, 'failed'); assert.match(store.get(one.id).log, /Setup required/);
    assert.equal(store.get(two.id).status, 'failed'); assert.ok(!fs.existsSync(path.join(dir, 'work', one.id)));
  } finally { q.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('artifact retention expires downloads without deleting build metadata', () => {
  const dir = temp(), store = new Store(dir), c = config({ ADMIN_TOKEN: 't'.repeat(64), DATA_DIR: dir });
  const j = store.create(validate(valid)); store.update(j.id, { status: 'ready' });
  store.db.prepare('UPDATE builds SET updated=? WHERE id=?').run('2000-01-01T00:00:00.000Z', j.id);
  fs.mkdirSync(path.join(dir, 'artifacts', j.id), { recursive: true });
  const q = new Queue(c, store);
  try { assert.equal(store.get(j.id).status, 'expired'); assert.ok(!fs.existsSync(path.join(dir, 'artifacts', j.id))); }
  finally { q.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
