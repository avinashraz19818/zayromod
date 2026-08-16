'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// APP NAME FONT STYLES — launcher label ke liye Unicode styling
//
// Android ka launcher app ka naam system font me dikhata hai (custom font
// embed nahi kar sakte), isliye styling Unicode Mathematical Alphanumeric
// Symbols se hoti hai. Ye sirf strings.xml wale app_name (phone ke home
// screen wala label) pe lagti hai — app ke ANDAR ke HTML/templates bilkul
// unchanged rehte hain.
// ─────────────────────────────────────────────────────────────────────────────

// Mathematical Bold: A U+1D400, a U+1D41A, 0 U+1D7CE
const BOLD = buildMap(0x1D400, 0x1D41A, 0x1D7CE);
// Mathematical Sans-Serif: A U+1D5A0, a U+1D5BA, 0 U+1D7E2
const SANS = buildMap(0x1D5A0, 0x1D5BA, 0x1D7E2);
// Mathematical Monospace: A U+1D670, a U+1D68A, 0 U+1D7F6
const MONO = buildMap(0x1D670, 0x1D68A, 0x1D7F6);

// Small caps (Unicode phonetic extensions) — digits/uppercase bhi small caps
// me convert hote hain; jo letters small caps nahi hain (jaise x) wo plain
// rehte hain.
const SMALLCAPS = {
  a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
  f: '\uA730', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
  k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
  p: '\u1D18', q: '\u01EB', r: '\u0280', s: '\uA731', t: '\u1D1B',
  u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',       y: '\u028F',
  z: '\u1D22'
};

function buildMap(upBase, lowBase, digBase) {
  const m = {};
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(65 + i)] = String.fromCodePoint(upBase + i);
    m[String.fromCharCode(97 + i)] = String.fromCodePoint(lowBase + i);
  }
  for (let i = 0; i < 10; i++) {
    m[String.fromCharCode(48 + i)] = String.fromCodePoint(digBase + i);
  }
  return m;
}

function mapWith(text, map) {
  let out = '';
  for (const ch of String(text)) out += (map[ch] !== undefined ? map[ch] : ch);
  return out;
}

function smallCaps(text) {
  let out = '';
  for (const ch of String(text)) {
    const lower = ch.toLowerCase();
    out += (SMALLCAPS[lower] !== undefined ? SMALLCAPS[lower] : ch);
  }
  return out;
}

// Order me dikhane wale options — sirf 4 styled (Normal intentionally
// nahi dikhaya jata; legacy/default ke liye 'normal' internal hi rehta hai)
const FONT_STYLES = [
  { key: 'bold',      label: 'Bold' },
  { key: 'smallcaps', label: 'Small Caps' },
  { key: 'sans',      label: 'Sans Serif' },
  { key: 'mono',      label: 'Monospace' }
];

function applyFontStyle(text, style) {
  if (!text) return text;
  switch (String(style || 'normal').toLowerCase()) {
    case 'bold':      return mapWith(text, BOLD);
    case 'sans':      return mapWith(text, SANS);
    case 'mono':      return mapWith(text, MONO);
    case 'smallcaps': return smallCaps(text);
    case 'normal':
    default:          return String(text);
  }
}

function isValidStyle(style) {
  return FONT_STYLES.some(s => s.key === style);
}

module.exports = { applyFontStyle, isValidStyle, FONT_STYLES };
