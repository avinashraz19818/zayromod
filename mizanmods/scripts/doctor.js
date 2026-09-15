import { config } from '../src/config.js';
import { preflight } from '../src/builder.js';
try {
  const checks = preflight(config());
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'MISSING'}  ${check.name}`);
  if (checks.some(c => !c.ok)) process.exitCode = 1;
} catch (e) { console.error(e.message); process.exitCode = 1; }
