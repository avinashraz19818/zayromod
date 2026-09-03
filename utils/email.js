'use strict';

// Transactional email delivery is intentionally server-side only.  The
// Resend API key and sender address are read from the environment and are
// never returned by an API route or embedded in the browser bundle.

function htmlEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function getEmailConfig() {
  return {
    apiKey: String(process.env.RESEND_API_KEY || '').trim(),
    from: String(process.env.EMAIL_FROM || '').trim(),
    replyTo: String(process.env.EMAIL_REPLY_TO || '').trim(),
    baseUrl: String(process.env.BASE_URL || '').trim().replace(/\/+$/, '')
  };
}

function isEmailDeliveryConfigured() {
  const config = getEmailConfig();
  if (!config.apiKey || !config.from || !config.baseUrl) return false;
  try {
    getBaseUrl();
    return true;
  } catch (_) {
    return false;
  }
}

function getBaseUrl() {
  const { baseUrl } = getEmailConfig();
  if (!baseUrl) throw new Error('BASE_URL is not configured');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (_) {
    throw new Error('BASE_URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('BASE_URL must use http(s)');
  }
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' && parsed.protocol !== 'https:') {
    throw new Error('BASE_URL must use HTTPS in production');
  }
  return baseUrl;
}

function makeActionUrl(pathname, token) {
  const url = new URL(`${getBaseUrl()}/${String(pathname || '').replace(/^\/+/, '')}`);
  url.searchParams.set('token', String(token || ''));
  return url.toString();
}

async function sendEmail({ to, subject, html, text }) {
  const { apiKey, from, replyTo } = getEmailConfig();
  if (!apiKey || !from) throw new Error('Transactional email is not configured');
  if (!to || !String(to).trim()) throw new Error('Recipient email is missing');

  const payload = {
    from,
    to: [String(to).trim()],
    subject: String(subject || '').slice(0, 200),
    html: String(html || ''),
    text: String(text || '')
  };
  if (replyTo) payload.reply_to = replyTo;

  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new Error(`Email delivery failed: ${error.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
  }

  if (!response.ok) {
    // Do not include the provider response in the error: it can contain
    // account metadata and should never reach a client response or log.
    throw new Error(`Email delivery failed with status ${response.status}`);
  }
  return true;
}

async function sendVerificationEmail({ to, username, token }) {
  const safeName = htmlEscape(username || 'there');
  const url = makeActionUrl('auth/verify-email', token);
  const subject = 'Verify your Zayro Mod Builder email';
  const text = `Hi ${username || 'there'},\n\nVerify your email address by opening this link:\n${url}\n\nThis link expires soon. If you did not create this account, you can ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#171525"><h2>Verify your email</h2><p>Hi ${safeName},</p><p>Confirm your email address to activate your account.</p><p><a href="${htmlEscape(url)}" style="display:inline-block;padding:12px 18px;background:#5b4bdb;color:#fff;text-decoration:none;border-radius:6px">Verify email</a></p><p>This link expires soon and can only be used once. If you did not create this account, you can ignore this email.</p></body></html>`;
  return sendEmail({ to, subject, html, text });
}

async function sendPasswordResetEmail({ to, username, token }) {
  const safeName = htmlEscape(username || 'there');
  const url = makeActionUrl('auth/reset-password', token);
  const subject = 'Reset your Zayro Mod Builder password';
  const text = `Hi ${username || 'there'},\n\nReset your password by opening this link:\n${url}\n\nThis link expires soon and can only be used once. If you did not request a reset, you can ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#171525"><h2>Password reset</h2><p>Hi ${safeName},</p><p>We received a request to reset your password.</p><p><a href="${htmlEscape(url)}" style="display:inline-block;padding:12px 18px;background:#5b4bdb;color:#fff;text-decoration:none;border-radius:6px">Reset password</a></p><p>This link expires soon and can only be used once. If you did not request a reset, you can ignore this email.</p></body></html>`;
  return sendEmail({ to, subject, html, text });
}

module.exports = {
  getBaseUrl,
  isEmailDeliveryConfigured,
  sendVerificationEmail,
  sendPasswordResetEmail
};
