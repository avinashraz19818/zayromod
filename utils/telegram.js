const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const fs   = require('fs');
const path = require('path');

let bot = null;
let deliveryBot = null;
let pollingAgent = null;
let deliveryAgent = null;
let apkDeliveryQueue = Promise.resolve();
let _db  = null;

function getSiteUrl() {
  if (!_db) return 'https://devlopedwithzayro.site';
  return _db.prepare("SELECT value FROM settings WHERE key='site_url'").get()?.value
    || 'https://devlopedwithzayro.site';
}

function getSupportUrl() {
  if (!_db) return 'https://t.me/';
  const sup = _db.prepare("SELECT value FROM settings WHERE key='telegram_support_user'").get()?.value;
  if (sup && sup.trim()) {
    const clean = sup.trim().replace(/^@/, '');
    return `https://t.me/${clean}`;
  }
  const adminId = _db.prepare("SELECT value FROM settings WHERE key='telegram_admin_id'").get()?.value;
  if (adminId && adminId.trim()) return `tg://user?id=${adminId.trim()}`;
  return 'https://t.me/';
}

function getChannelUrl() {
  if (!_db) return 'https://t.me/';
  const ch = _db.prepare("SELECT value FROM settings WHERE key='telegram_channel_url'").get()?.value;
  return (ch && ch.trim()) ? ch.trim() : 'https://t.me/';
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function initBot(token, db) {
  if (db) _db = db;
  try {
    if (bot) {
      try { bot.stopPolling({ cancel: true, reason: 'Bot reconfigured' }).catch(() => {}); }
      catch (_) {}
    }
    bot = null;
    deliveryBot = null;
    pollingAgent?.destroy();
    deliveryAgent?.destroy();
    pollingAgent = null;
    deliveryAgent = null;

    if (!token || !String(token).trim()) return;

    const cleanToken = String(token).trim();

    pollingAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
    deliveryAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
    bot = new TelegramBot(cleanToken, {
      polling: { interval: 200, params: { timeout: 10 } },
      request: { agent: pollingAgent, timeout: 30_000 }
    });
    deliveryBot = new TelegramBot(cleanToken, {
      polling: false,
      request: { agent: deliveryAgent, timeout: 10 * 60_000 }
    });

    // ── /start Handler — Ultra-Premium VIP Hub ──
    bot.onText(/\/start/, async (msg) => {
      const chatId    = String(msg.chat.id);
      const username  = msg.from?.username ? `@${msg.from.username}` : '';
      const firstName = escapeHtml(msg.from?.first_name || 'VIP Member');
      const siteUrl   = getSiteUrl();
      const supportUrl = getSupportUrl();
      const channelUrl = getChannelUrl();

      // Check user details if in DB
      let userCoins = 0;
      let userOrders = 0;
      if (_db) {
        try {
          const u = _db.prepare('SELECT id, coins FROM users WHERE telegram_id=?').get(chatId);
          if (u) {
            userCoins = u.coins || 0;
            const oc = _db.prepare('SELECT count(*) as c FROM orders WHERE user_id=?').get(u.id);
            userOrders = oc?.c || 0;
          }
        } catch (_) {}
      }

      const welcomeMsg =
`╔══════════════════════════════════╗
║    💎  <b>𝐙𝐀𝐘𝐑𝐎 𝐌𝐎𝐃 𝐁𝐔𝐈𝐋𝐃𝐄𝐑 𝐕𝐈𝐏</b>  💎    ║
╚══════════════════════════════════╝

👋 Welcome, <b>${firstName}</b> ${username ? `(<code>${username}</code>)` : ''}!

⚡ <b>System Status:</b> <code>ONLINE 🟢</code>
🪙 <b>Your Balance:</b> <code>${userCoins} Coins 💰</code>
📦 <b>Total Orders:</b> <code>${userOrders} APKs Built 🚀</code>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔥 <b>Fastest Sideload & Auto-Bypass Cloud Engine:</b>
• 🛡️ <i>100% Antivirus & Phone Manager Clean</i>
• ⚡ <i>Universal DhaniWin & Multi-Game Dynamic Engine</i>
• ☁️ <i>Live Firebase Sync & Auto-Recharge Gateway</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👇 <b>Choose an action below to get started:</b>`;

      const reply_markup = {
        inline_keyboard: [
          [
            { text: '🚀 ᴏᴘᴇɴ ᴀᴘᴋ ʙᴜɪʟᴅᴇʀ ᴘᴀɴᴇʟ', web_app: { url: siteUrl } }
          ],
          [
            { text: '📦 ᴍʏ ᴏʀᴅᴇʀꜱ', web_app: { url: `${siteUrl}#orders` } },
            { text: '🪙 ᴀᴅᴅ ᴄᴏɪɴꜱ', web_app: { url: `${siteUrl}#coins` } }
          ],
          [
            { text: '👨‍💻 ᴀᴅᴍɪɴ ꜱᴜᴘᴘᴏʀᴛ', url: supportUrl },
            { text: '📢 ᴏꜰꜰɪᴄɪᴀʟ ᴄʜᴀɴɴᴇʟ', url: channelUrl }
          ]
        ]
      };

      try {
        await bot.sendMessage(chatId, welcomeMsg, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup
        });
      } catch (e) {
        console.error('Bot /start error:', e.message);
      }
    });

    // ── /orders command ──
    bot.onText(/\/orders|\/myorders/, async (msg) => {
      const chatId = String(msg.chat.id);
      const siteUrl = getSiteUrl();
      if (!_db) return;

      try {
        const u = _db.prepare('SELECT id, username FROM users WHERE telegram_id=?').get(chatId);
        if (!u) {
          return bot.sendMessage(chatId, `⚠️ <b>Account not linked</b>\nPlease link your Telegram ID from your website profile.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🚀 Open Web Panel', web_app: { url: siteUrl } }]] }
          });
        }

        const orders = _db.prepare('SELECT id, app_name, status, created_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5').all(u.id);
        if (!orders.length) {
          return bot.sendMessage(chatId, `📦 <b>No orders yet!</b>\nYou haven't created any APK orders yet. Tap below to create your first app.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔨 Build First APK', web_app: { url: siteUrl } }]] }
          });
        }

        let txt = `📦 <b>Your Recent Orders (${orders.length}):</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        orders.forEach(o => {
          const st = o.status === 'done' ? '✅ Ready' : o.status === 'failed' ? '❌ Failed' : '⏳ Building';
          txt += `• <b>#${o.id} - ${escapeHtml(o.app_name)}</b>\n  Status: ${st} | 🕒 <code>${new Date(o.created_at).toLocaleDateString()}</code>\n\n`;
        });
        txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        await bot.sendMessage(chatId, txt, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '📲 Manage in Web App', web_app: { url: siteUrl } }]]
          }
        });
      } catch (e) {
        console.error('Bot /orders error:', e.message);
      }
    });

    // ── /help command — Play Protect & Install Guide ──
    bot.onText(/\/help|\/guide/, async (msg) => {
      const chatId = String(msg.chat.id);
      const helpMsg =
`╔══════════════════════════════════╗
║     📖 <b>𝐀𝐏𝐊 𝐈𝐍𝐒𝐓𝐀𝐋𝐋𝐀𝐓𝐈𝐎𝐍 𝐆𝐔𝐈𝐃𝐄</b>    ║
╚══════════════════════════════════╝

⚡ <b>How to install APKs smoothly:</b>

1️⃣ <b>Download:</b> Tap the APK file sent by this bot.
2️⃣ <b>Permission:</b> Allow installation from Telegram / Browser.
3️⃣ <b>Play Protect prompt:</b>
   • If Android shows <i>"App scan recommended"</i>, simply tap <b>"Scan app"</b> or <b>"Install without scanning"</b>.
   • Google will verify the clean APK in 5 seconds and complete install!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️ <b>Security Guarantee:</b>
Our APKs are built with 100% clean architecture, without malicious permissions.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

      await bot.sendMessage(chatId, helpMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '👨‍💻 Contact Support', url: getSupportUrl() }
          ]]
        }
      });
    });

    // Approve / Reject button callbacks
    bot.on('callback_query', async (query) => {
      const data   = query.data || '';
      const chatId = query.message?.chat?.id;
      const msgId  = query.message?.message_id;

      if (!_db) {
        try { await bot.answerCallbackQuery(query.id, { text: '⚠️ Server not ready' }); } catch(_) {}
        return;
      }

      if (data.startsWith('approve_') || data.startsWith('reject_')) {
        const action = data.startsWith('approve_') ? 'approve' : 'reject';
        const reqId  = parseInt(data.split('_')[1]);
        const row    = _db.prepare('SELECT * FROM coin_requests WHERE id=?').get(reqId);

        if (!row) {
          try { await bot.answerCallbackQuery(query.id, { text: '❌ Request not found' }); } catch(_) {}
          return;
        }
        if (row.status !== 'pending') {
          try { await bot.answerCallbackQuery(query.id, { text: `Already ${row.status}` }); } catch(_) {}
          return;
        }

        if (action === 'approve') {
          _db.prepare('UPDATE coin_requests SET status=?,approved_by=? WHERE id=?')
            .run('approved', 'telegram_admin', reqId);
          _db.prepare('UPDATE users SET coins = coins + ? WHERE id=?')
            .run(row.coins_requested, row.user_id);
          try {
            await bot.answerCallbackQuery(query.id, { text: `✅ Approved +${row.coins_requested} coins!` });
            const cap =
`✅ <b>COIN REQUEST APPROVED</b> 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> <code>#${row.user_id}</code>
🪙 <b>Coins Added:</b> <b>+${row.coins_requested}</b>
💵 <b>Amount Paid:</b> ₹${row.amount_paid}
🔖 <b>UTR:</b> <code>${escapeHtml(row.utr)}</code>
🆔 <b>Request ID:</b> <code>#${reqId}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
            await bot.editMessageCaption(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' })
              .catch(() => bot.editMessageText(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }));
          } catch(_) {}
        } else {
          _db.prepare('UPDATE coin_requests SET status=?,approved_by=? WHERE id=?')
            .run('rejected', 'telegram_admin', reqId);
          try {
            await bot.answerCallbackQuery(query.id, { text: '❌ Request rejected' });
            const cap =
`❌ <b>COIN REQUEST REJECTED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> <code>#${row.user_id}</code>
🔖 <b>UTR:</b> <code>${escapeHtml(row.utr)}</code>
🆔 <b>Request ID:</b> <code>#${reqId}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
            await bot.editMessageCaption(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' })
              .catch(() => bot.editMessageText(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }));
          } catch(_) {}
        }
      }
    });

    bot.on('polling_error', (err) => {
      if (!err.message?.includes('ETELEGRAM')) console.error('Bot polling error:', err.message);
    });

  } catch (e) {
    console.error('Telegram bot init failed:', e.message);
  }
}

// ── Send Coin Request to Admin with Rich Styling ──
async function sendCoinRequest(adminChatId, user, request, screenshotPath) {
  if (!bot || !adminChatId) return null;

  const msg =
`╔══════════════════════════════════╗
║    💰  <b>𝐍𝐄𝐖 𝐂𝐎𝐈𝐍 𝐑𝐄𝐐𝐔𝐄𝐒𝐓</b>  💰    ║
╚══════════════════════════════════╝

👤 <b>Username:</b> <code>${escapeHtml(user.username)}</code>
📧 <b>Email:</b> <code>${escapeHtml(user.email)}</code>
🪙 <b>Coins Requested:</b> <b>${request.coins_requested} 💰</b>
💵 <b>Amount:</b> <b>₹${request.amount_paid}</b>
🔖 <b>UTR:</b> <code>${escapeHtml(request.utr)}</code>
🆔 <b>Request ID:</b> <code>#${request.id}</code>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Verify payment and choose action below:</i>`;

  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ ᴀᴘᴘʀᴏᴠᴇ (+ᴄᴏɪɴꜱ)', callback_data: `approve_${request.id}` },
      { text: '❌ ʀᴇᴊᴇᴄᴛ', callback_data: `reject_${request.id}` }
    ]]
  };

  try {
    let sent;
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      sent = await bot.sendPhoto(adminChatId, fs.createReadStream(screenshotPath), {
        caption: msg, parse_mode: 'HTML', reply_markup
      });
    } else {
      sent = await bot.sendMessage(adminChatId, msg, { parse_mode: 'HTML', reply_markup });
    }
    return sent.message_id;
  } catch (e) {
    console.error('Telegram sendCoinRequest error:', e.message);
    return null;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(error, attempt) {
  const body = error?.response?.body;
  let parsedBody = body;
  if (typeof body === 'string') {
    try { parsedBody = JSON.parse(body); } catch (_) {}
  }

  const retryAfter = Number(parsedBody?.parameters?.retry_after || 0);
  if (retryAfter > 0) return retryAfter * 1000;

  const status = Number(error?.response?.statusCode || 0);
  const code = error?.code || error?.cause?.code;
  const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE']);
  if (status === 429 || status >= 500 || retryableCodes.has(code)) {
    return Math.min(2_000 * (attempt + 1), 10_000);
  }
  return null;
}

async function sendDocumentWithRetry(sender, telegramId, apkPath, caption) {
  const filename = path.basename(apkPath);
  const maxAttempts = 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await sender.sendDocument(
        telegramId,
        apkPath,
        { caption, parse_mode: 'HTML' },
        { filename, contentType: 'application/vnd.android.package-archive' }
      );
    } catch (error) {
      const delay = getRetryDelay(error, attempt);
      if (attempt === maxAttempts - 1 || delay === null) throw error;
      await wait(delay);
    }
  }
}

// ── Ultra-Sleek APK Delivery ──
async function deliverApkReady(sender, user, order, apkPaths, downloadUrls) {
  const telegramId = user.telegram_id;
  const validApkPaths = apkPaths.filter(apkPath => apkPath && fs.existsSync(apkPath));
  const appNamePlain = order.app_name || 'APK';
  const siteUrl = getSiteUrl();
  const supportUrl = getSupportUrl();
  let statusMessage = null;
  let sentCount = 0;
  const failedFiles = [];

  if (validApkPaths.length > 0) {
    const headerCard =
`╔══════════════════════════════════╗
║     ⚡ <b>𝐀𝐏𝐊 𝐁𝐔𝐈𝐋𝐃 𝐒𝐔𝐂𝐂𝐄𝐒𝐒𝐅𝐔𝐋!</b> ⚡     ║
╚══════════════════════════════════╝

👑 <b>App Name:</b>  <code>${escapeHtml(appNamePlain)}</code>
📦 <b>Package:</b>   <code>${escapeHtml(order.package_name || 'com.client.app')}</code>
🛡️ <b>Protection:</b> <b>100% Antivirus Clean • Jiagu Hardened</b>
🚀 <b>Status:</b>     <b>Ready to Install ✅</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📥 <i>Uploading your APK files now… Please wait.</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
      statusMessage = await sender.sendMessage(
        telegramId,
        headerCard,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch (error) {
      console.error('Bot APK status message error:', error.message);
    }

    for (let index = 0; index < validApkPaths.length; index++) {
      const apkPath = validApkPaths[index];
      const filename = path.basename(apkPath);
      const isReal = index === 0;
      const caption = isReal
        ? `✅ <b>REAL PRODUCTION APK</b>\n📁 <code>${escapeHtml(filename)}</code>\n\n💡 <i><b>Note:</b> If "App scan recommended" appears, tap "Scan app" — installs in 5s!</i>`
        : `🎭 <b>FAKE PREVIEW APK</b>\n📁 <code>${escapeHtml(filename)}</code>\n\n💡 <i>Multi-game clone variant.</i>`;

      try {
        await sendDocumentWithRetry(sender, telegramId, apkPath, caption);
        sentCount++;
      } catch (error) {
        failedFiles.push(filename);
        console.error(`Bot sendDocument error (${filename}):`, error.message);
      }
    }

    const completionCard = failedFiles.length === 0
      ? `🎉 <b>All ${sentCount} APK file(s) delivered successfully!</b>\nTap the attached file above to install directly on your Android phone.`
      : `⚠️ <b>${sentCount}/${validApkPaths.length} APK file(s) sent.</b>\nPlease open My Orders to download remaining files.`;

    const deliveryButtons = {
      inline_keyboard: [
        [
          { text: '🔨 ʙᴜɪʟᴅ ᴀɴᴏᴛʜᴇʀ ᴀᴘᴋ', web_app: { url: siteUrl } }
        ],
        [
          { text: '📦 ᴍʏ ᴏʀᴅᴇʀꜱ', web_app: { url: `${siteUrl}#orders` } },
          { text: '👨‍💻 ꜱᴜᴘᴘᴏʀᴛ', url: supportUrl }
        ]
      ]
    };

    if (statusMessage?.message_id) {
      try {
        await sender.editMessageText(
          `${headerCard}\n\n${completionCard}`,
          {
            chat_id: telegramId,
            message_id: statusMessage.message_id,
            parse_mode: 'HTML',
            reply_markup: deliveryButtons
          }
        );
      } catch (_) {}
    } else {
      try {
        await sender.sendMessage(telegramId, completionCard, {
          parse_mode: 'HTML',
          reply_markup: deliveryButtons
        });
      } catch (_) {}
    }
  }
}

function sendApkReady(user, order, apkPaths = [], downloadUrls = []) {
  const sender = deliveryBot;
  if (!sender || !user?.telegram_id) return Promise.resolve();

  const delivery = apkDeliveryQueue.then(() => deliverApkReady(
    sender,
    { ...user },
    { ...order },
    Array.isArray(apkPaths) ? [...apkPaths] : [],
    Array.isArray(downloadUrls) ? [...downloadUrls] : []
  ));

  apkDeliveryQueue = delivery.catch(error => {
    console.error('Bot APK delivery error:', error.message);
  });
  return delivery;
}

// ── Broadcast Announcement to All Telegram Bot Users ──
async function broadcastAnnouncement(announcement) {
  if (!bot || !_db) throw new Error('Telegram bot is not configured or running');

  const users = _db.prepare("SELECT DISTINCT telegram_id FROM users WHERE telegram_id IS NOT NULL AND telegram_id != ''").all();
  if (!users.length) return { total: 0, sent: 0, failed: 0 };

  const { title, message, image_url, button_text, button_url } = announcement;
  const siteUrl = getSiteUrl();
  const supportUrl = getSupportUrl();

  const text =
`╔══════════════════════════════════╗
║    📢 <b>${escapeHtml(title.toUpperCase())}</b>    ║
╚══════════════════════════════════╝

${escapeHtml(message)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 <b>Official Portal:</b> <a href="${siteUrl}">${siteUrl}</a>`;

  const inlineKeyboard = [];
  if (button_text && button_url) {
    inlineKeyboard.push([{ text: `✨ ${button_text}`, url: button_url.startsWith('http') ? button_url : `https://${button_url}` }]);
  }
  inlineKeyboard.push([
    { text: '🚀 ᴏᴘᴇɴ ʙᴜɪʟᴅᴇʀ', web_app: { url: siteUrl } },
    { text: '👨‍💻 ꜱᴜᴘᴘᴏʀᴛ', url: supportUrl }
  ]);

  const reply_markup = { inline_keyboard: inlineKeyboard };

  let sent = 0;
  let failed = 0;

  for (const u of users) {
    try {
      if (image_url && image_url.startsWith('http')) {
        await bot.sendPhoto(u.telegram_id, image_url, {
          caption: text,
          parse_mode: 'HTML',
          reply_markup
        });
      } else {
        await bot.sendMessage(u.telegram_id, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          reply_markup
        });
      }
      sent++;
      // Sleep 40ms to respect Telegram rate limits (max 30 msgs/sec)
      await wait(40);
    } catch (e) {
      failed++;
    }
  }

  return { total: users.length, sent, failed };
}

module.exports = { initBot, sendCoinRequest, sendApkReady, broadcastAnnouncement };
