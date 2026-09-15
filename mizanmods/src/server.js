import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { Queue } from './queue.js';
import { validate } from './validation.js';
import { preflight } from './builder.js';
export function createApp(c, store, queue) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.get('/api/health', (req, res) => res.json({ service: 'MizanMods', status: 'ok' }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Retry in a minute.' } }));
  const digest = text => createHash('sha256').update(text).digest();
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = (req.get('authorization') || '').replace(/^Bearer /, '');
    if (!timingSafeEqual(digest(token), digest(c.token))) return res.status(401).json({ error: 'Unlock the workspace with your MizanMods admin token.' });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/settings', (req, res) => res.json({ brand: 'MizanMods', storage: 'Independent SQLite', retentionDays: c.retention, concurrency: 1, checks: preflight(c) }));
  app.get('/api/builds', (req, res) => res.json(store.list()));
  app.post('/api/builds', rateLimit({ windowMs: 60000, limit: 10, message: { error: 'Build request limit reached. Retry shortly.' } }), (req, res) => {
    let input; try { input = validate(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (store.pending().length + Number(!!queue.active) >= c.maxQueue) return res.status(429).json({ error: 'Build queue is full. Please try again shortly.' });
    const job = store.create(input); queue.kick(); res.status(202).json(job);
  });
  app.param('id', (req, res, next, id) => {
    if (!/^[a-f0-9-]{36}$/.test(id) || !store.get(id)) return res.status(404).json({ error: 'Build not found' });
    next();
  });
  app.get('/api/builds/:id', (req, res) => res.json(store.get(req.params.id)));
  app.get('/api/builds/:id/download', (req, res) => {
    const job = store.get(req.params.id), file = path.join(c.data, 'artifacts', job.id, 'MizanMods.apk');
    if (job.status !== 'ready') return res.status(409).json({ error: 'A verified APK is not available for this build.' });
    if (!fs.existsSync(file)) return res.status(410).json({ error: 'Artifact is no longer available.' });
    res.download(file, `${job.config.appName.replace(/[^a-zA-Z0-9_-]/g, '_')}.apk`);
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
  app.use(express.static(path.join(c.root, 'public')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status === 413 ? 413 : err.type === 'entity.parse.failed' ? 400 : 500).json({ error: err.status === 413 ? 'Request too large' : err.type === 'entity.parse.failed' ? 'Invalid JSON' : 'MizanMods encountered an internal error.' });
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const c = config(); fs.mkdirSync(c.data, { recursive: true, mode: 0o700 });
  const lock = path.join(c.data, 'server.lock');
  // Exclusive lock: one server/queue per data directory. Remove only after confirming an old process is dead.
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const store = new Store(c.data), queue = new Queue(c, store);
  const server = createApp(c, store, queue).listen(c.port, '0.0.0.0', () => console.log(`MizanMods listening on port ${c.port}`));
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true; queue.stop();
    server.close(() => { fs.rmSync(lock, { force: true }); process.exit(0); });
    setTimeout(() => { fs.rmSync(lock, { force: true }); process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  server.on('error', e => { fs.rmSync(lock, { force: true }); console.error(e.message); process.exit(1); });
}
