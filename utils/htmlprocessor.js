const fs = require('fs');

/**
 * Extract domain from register URL
 * e.g. https://www.ts777.co/#/register?invitationCode=123  → ts777.co
 */
function extractDomain(registerUrl) {
  try {
    const u = new URL(registerUrl);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return registerUrl.split('/')[2]?.replace(/^www\./, '') || '';
  }
}

/**
 * Build deposit/wingo URLs from register URL by replacing the hash path
 */
function buildUrls(registerUrl) {
  try {
    const u = new URL(registerUrl);
    const base = u.origin;
    return {
      deposit: base + '/#/wallet/Recharge',
      wingo: base + '/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo'
    };
  } catch {
    const base = registerUrl.split('#')[0].replace(/\/$/, '');
    return {
      deposit: base + '/#/wallet/Recharge',
      wingo: base + '/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo'
    };
  }
}

/**
 * Inject all user params into HTML template
 * Handles both normal (zayro/wings) and dhani type HTMLs
 */
function injectParams(htmlContent, params) {
  const {
    registerUrl,
    depositUrl,
    wingoUrl,
    domain,
    firebasePath,
    minDeposit,
    brandTitle,
    appIconBase64,
    isDhani
  } = params;

  let html = htmlContent;

  // ── REGISTER URL ──
  // Matches: REGISTER_URL="...", href="...", gameFrame.src="..."
  html = html.replace(
    /(var\s+REGISTER_URL\s*=\s*["'])([^"']+)(["'])/g,
    `$1${registerUrl}$3`
  );
  // cold start: gameFrame.src = "https://..."
  html = html.replace(
    /(gameFrame\.src\s*=\s*["'])https?:\/\/[^"'#]+\/#\/register[^"']*(["'])/g,
    `$1${registerUrl}$2`
  );

  // ── DEPOSIT URL ──
  html = html.replace(
    /(var\s+DEPOSIT_URL\s*=\s*["'])([^"']+)(["'])/g,
    `$1${depositUrl}$3`
  );

  // ── WINGO URL ──
  html = html.replace(
    /(var\s+WINGO_URL\s*=\s*["'])([^"']+)(["'])/g,
    `$1${wingoUrl}$3`
  );

  // ── FIREBASE DB PATH (e.g. "zayroliveharsh", "zayrowingsbittu") ──
  // Extract current path prefix from HTML first
  const pathMatch = html.match(/rtdb\.ref\(["']([a-zA-Z0-9_]+)\/(config|users)/);
  const oldPrefix = pathMatch ? pathMatch[1] : null;

  if (oldPrefix && oldPrefix !== firebasePath) {
    // Replace only in rtdb.ref("oldPrefix/...") contexts
    // Match: rtdb.ref("oldPrefix/config") and rtdb.ref("oldPrefix/users/...)
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedOld = escapeRegex(oldPrefix);

    // Pattern: rtdb.ref("oldPrefix/
    html = html.replace(
      new RegExp(`(rtdb\\.ref\\(["'])${escapedOld}(\\/(?:config|users))`, 'g'),
      `$1${firebasePath}$2`
    );
  }

  // ── MIN DEPOSIT ──
  html = html.replace(
    /(var\s+(?:fbMinDeposit|minDeposit)\s*=\s*)(\d+)/g,
    `$1${minDeposit}`
  );
  // rechargeAmt span default content
  html = html.replace(
    /(<span\s+id=["']rechargeAmt["'][^>]*>)[^<]*/g,
    `$1&#8377;${minDeposit}`
  );

  // ── BRAND TITLE (popup card header) ──
  // Matches class="brand-name", class="card-title-line1", wo-head-title, etc.
  const brandSelectors = [
    /(<div[^>]+class=["'][^"']*brand-name[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*card-title-line1[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*wo-head-title[^"']*["'][^>]*>)[^<]*/g,
    /(<div[^>]+class=["'][^"']*wo-title["'][^>]*>)[^<]*/g,
    /(<title>)[^<]*/g
  ];
  brandSelectors.forEach(rx => {
    html = html.replace(rx, `$1${brandTitle}`);
  });

  // ── APP ICON (my_icon.png → base64 data URI embedded) ──
  if (appIconBase64) {
    // Replace src="my_icon.png" in both miniBtn img and anywhere
    html = html.replace(
      /src=["']my_icon\.png["']/g,
      `src="data:image/png;base64,${appIconBase64}"`
    );
  }

  // ── DHANI-SPECIFIC: gameIframe instead of target-game-frame ──
  // (dhani.java uses gameIframe; mainactivity.java uses target-game-frame)
  // HTML already has correct id, nothing to change here

  return html;
}

module.exports = { extractDomain, buildUrls, injectParams };
