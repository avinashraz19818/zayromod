const reserved = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null'.split(' '));
export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid build configuration');
  const { appName, packageName, versionCode = 1, versionName = '1.0.0', welcome = 'Your space. Your possibilities.', accent = '#176b5b' } = input;
  if (typeof appName !== 'string' || !/^[\p{L}\p{N} ._-]{1,48}$/u.test(appName) || !appName.trim()) throw new Error('App name: use 1–48 letters, numbers, spaces, dots, underscores or hyphens');
  if (typeof packageName !== 'string' || packageName.length > 150 || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(packageName) || packageName.split('.').some(p => reserved.has(p))) throw new Error('Use a valid lowercase package, e.g. com.mizanmods.app');
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) throw new Error('Version code must be an integer from 1 to 2100000000');
  if (typeof versionName !== 'string' || !/^\d+\.\d+\.\d+$/.test(versionName) || versionName.length > 30) throw new Error('Version name must be major.minor.patch');
  if (typeof welcome !== 'string' || welcome.length > 160 || /[\x00-\x1f]/.test(welcome)) throw new Error('Welcome message must be at most 160 printable characters');
  if (typeof accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(accent)) throw new Error('Choose a valid accent color');
  return { appName: appName.trim(), packageName, versionCode, versionName, welcome, accent };
}
export const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
