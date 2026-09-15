'use strict';
function telegramAllowed(id) {
  const allowed = String(process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
  return /^\d+$/.test(String(id)) && (allowed.includes('*') || allowed.includes(String(id)));
}
module.exports = { telegramAllowed };
