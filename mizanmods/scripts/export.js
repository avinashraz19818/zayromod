import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/config.js';
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mizanmods-export-'));
try {
  const dest = path.join(staging, 'MizanMods');
  const allowed = ['package.json', 'package-lock.json', 'playwright.config.js', '.gitignore', '.env.example', 'README.md', 'src', 'public', 'tests', 'docs', 'scripts', 'android-template'];
  const exclude = new Set(['.git', '.gradle', 'build', 'node_modules', 'runtime', 'local.properties']);
  for (const name of allowed) fs.cpSync(path.join(ROOT, name), path.join(dest, name), { recursive: true, filter: p => !exclude.has(path.basename(p)) });
  fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
  const output = path.join(ROOT, 'runtime', 'MizanMods-source.tar.gz');
  execFileSync('tar', ['-czf', output, '-C', staging, 'MizanMods']);
  console.log(output);
} finally { fs.rmSync(staging, { recursive: true, force: true }); }
