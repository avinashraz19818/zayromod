import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function config(env = process.env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new Error('Set a unique ADMIN_TOKEN of at least 32 characters.');
  const number = (key, fallback, min, max) => {
    const n = Number(env[key] || fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const tools = env.BUILD_TOOLS_VERSION || '35.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(tools)) throw new Error('Invalid BUILD_TOOLS_VERSION');
  return {
    root: ROOT, token: env.ADMIN_TOKEN, port: number('PORT', 3000, 1, 65535),
    data: path.resolve(ROOT, env.DATA_DIR || 'runtime'), sdk: env.ANDROID_HOME || '', tools,
    timeout: number('BUILD_TIMEOUT_MS', 900000, 1000, 3600000),
    maxQueue: number('MAX_QUEUE', 10, 1, 100), retention: number('RETENTION_DAYS', 7, 1, 365),
    keystore: env.KEYSTORE_PATH || '', alias: env.KEYSTORE_ALIAS || 'mizanmods'
  };
}
