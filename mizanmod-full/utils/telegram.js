const TelegramBot = require('./telegram-adapter');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

let bot = null;
let deliveryBot = null;
let pollingAgent = null;
let deliveryAgent = null;
let apkDeliveryQueue = Promise.resolve();
let _db  = null;

// ── Telegram Premium Custom Emojis ──
const PE = {
  wave: '👋',
  gift: '🎁',
  star: '⭐️',
  fire: '🔥',
  crown: '👑',
  diamond: '💎',
  money: '💰',
  check: '✅',
  alert: '‼️',
  lock: '🔒',
  sparkles: '✨',
  rocket: '🚀',
  bell: '🔔',
  dot: '🔘',
  down: '🔽',
  party: '🥳',
  bot: '🤖',
  stats: '📊',
  phone: '📞',
  arrow: '👉',
  verified: '✔️',
  card: '📇',
  telegram: '✈️',
  mobile: '📱',
  trophy: '🏆',
  user: '👤',
  gear: '⚙️',
  broadcast: '📡'
};

function getSiteUrl() { return String(process.env.BASE_URL || ''); }

function getSupportUrl() {
  if (!_db) return null;
  const sup = _db.prepare("SELECT value FROM settings WHERE key='telegram_support_user'").get()?.value;
  if (sup && sup.trim()) {
    const clean = sup.trim().replace(/^@/, '');
    return `https://t.me/${clean}`;
  }
  const adminId = _db.prepare("SELECT value FROM settings WHERE key='telegram_admin_id'").get()?.value || process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (adminId && /^[1-9]\d*$/.test(String(adminId).trim())) return `tg://user?id=${adminId.trim()}`;
  return null;
}

function getChannelUrl() {
  if (!_db) return null;
  const ch = _db.prepare("SELECT value FROM settings WHERE key='telegram_channel_url'").get()?.value;
  return (ch && /^https:\/\//.test(ch.trim())) ? ch.trim() : null;
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

    // ── /start Handler — MizanMod Studio workspace hub ──
    bot.onText(/\/start/, async (msg) => {
      const chatId    = String(msg.chat.id);
      if (msg.chat.type !== 'private' || !require('./telegram-access').telegramAllowed(msg.from?.id)) return;
      const rawUsername = msg.from?.username ? msg.from.username.trim() : '';
      const firstName = escapeHtml(msg.from?.first_name || 'there');
      const siteUrl   = getSiteUrl();
      const supportUrl = getSupportUrl();
      const channelUrl = getChannelUrl();

      let userCoins = 0;
      let userOrders = 0;

      // ── Auto-Register / Sync User on Telegram Start ──
      if (_db) {
        try {
          let u = _db.prepare('SELECT * FROM users WHERE telegram_id=?').get(chatId);
          if (!u) {
            let finalUsername = rawUsername || `tg_${chatId}`;
            let attempt = 1;
            while (_db.prepare('SELECT 1 FROM users WHERE username=?').get(finalUsername)) {
              finalUsername = `${rawUsername || `tg_${chatId}`}_${attempt++}`;
            }
            const email = `${chatId}@telegram.user`;
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 12);
            const result = _db.prepare(`
              INSERT INTO users(
                username,email,password,auth_provider,email_verified_at,
                coins,telegram_id,first_name,tg_username,is_telegram
              ) VALUES(?,?,?,'telegram',?,0,?,?,?,1)
            `).run(finalUsername, email, passwordHash, Date.now(), chatId, msg.from?.first_name || '', rawUsername);
            u = _db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
            sendLogEvent('user_registered', {
              id: u.id,
              username: u.username,
              email: u.email,
              coins: 0,
              ip: 'Telegram Bot'
            });
          } else {
            _db.prepare('UPDATE users SET first_name=?, tg_username=? WHERE id=?').run(
              msg.from?.first_name || u.first_name || '',
              rawUsername || u.tg_username || '',
              u.id
            );
          }
          userCoins = u.coins || 0;
          const oc = _db.prepare('SELECT count(*) as c FROM orders WHERE user_id=?').get(u.id);
          userOrders = oc?.c || 0;
        } catch (e) {
          console.error('User sync error:', e.message);
        }
      }

      const welcomeMsg =
`<b>MizanMod Studio</b>
<i>Your ideas. Your apps. One workspace.</i>

Hi ${firstName} 👋
Your workspace is ready.

<b>${userCoins} credits</b> available · <b>${userOrders} orders</b>

Choose a design, customize your app, and follow its build from Studio. Your order status and downloads stay together.

<b>Where would you like to go?</b>`;

      // ── Bot API 9.4+ Colored Inline Buttons (Attached directly to message) ──
      const reply_markup = {
        inline_keyboard: [
          [
            { text: 'Open Studio ↗', web_app: { url: siteUrl }, style: 'success' }
          ],
          [
            { text: 'My builds', web_app: { url: `${siteUrl}#orders` }, style: 'primary' },
            { text: 'Credits', web_app: { url: `${siteUrl}#wallet` }, style: 'success' }
          ],
          ...(supportUrl || channelUrl ? [[
            ...(supportUrl ? [{text:'Contact support',url:supportUrl}] : []),
            ...(channelUrl ? [{text:'Studio updates',url:channelUrl}] : [])
          ]] : [])
        ]
      };

      try {
        // Send welcome message with inline buttons attached directly
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
          return bot.sendMessage(chatId, `${PE.alert} <b>Account not found</b>\nTap /start to register automatically.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🟢 🚀 Open Builder Panel', web_app: { url: siteUrl } }]] }
          });
        }

        const orders = _db.prepare('SELECT id, app_name, status, created_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5').all(u.id);
        if (!orders.length) {
          return bot.sendMessage(chatId, `${PE.mobile} <b>No orders yet!</b>\nYou haven't created any APK orders yet. Tap below to create your first app.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔨 Build First APK', web_app: { url: siteUrl } }]] }
          });
        }

        let txt = `${PE.mobile} <b>Your Recent Orders (${orders.length}):</b>\n\n\n`;
        orders.forEach(o => {
          const st = o.status === 'done' ? `${PE.check} Ready` : o.status === 'failed' ? `❌ Failed` : `⏳ Building`;
          txt += `${PE.dot} <b>#${o.id} - ${escapeHtml(o.app_name)}</b>\n  Status: ${st} | ${PE.card} <code>${new Date(o.created_at).toLocaleDateString()}</code>\n\n`;
        });
        txt += ``;

        await bot.sendMessage(chatId, txt, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'View builds in Studio', web_app: { url: `${siteUrl}#orders` } }]
            ]
          }
        });
      } catch (e) {
        console.error('Bot /orders error:', e.message);
      }
    });

    // ── /wallet or /coins command ──
    bot.onText(/\/wallet|\/coins|\/balance|\/deposit/, async (msg) => {
      const chatId = String(msg.chat.id);
      const siteUrl = getSiteUrl();
      if (!_db) return;

      try {
        const u = _db.prepare('SELECT id, coins FROM users WHERE telegram_id=?').get(chatId);
        const coins = u?.coins || 0;
        const upiId = _db.prepare("SELECT value FROM settings WHERE key='upi_id'").get()?.value || '';

        const txt =
`<b>MizanMod · Your credits</b>

<b>${coins} coins</b> available for your next build.
${upiId ? `\nPayment ID: <code>${escapeHtml(upiId)}</code>\n` : ''}
Open Credits to choose an amount and submit your payment request. Your balance updates after approval.`;

        await bot.sendMessage(chatId, txt, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Top up credits', web_app: { url: `${siteUrl}#wallet` } }]
            ]
          }
        });
      } catch (e) {
        console.error('Bot /wallet error:', e.message);
      }
    });

    // ── /help command — Play Protect & Install Guide ──
    bot.onText(/\/help|\/guide/, async (msg) => {
      const chatId = String(msg.chat.id);
      const helpMsg =
`
  ${PE.sparkles} <b>APK INSTALLATION GUIDE</b> ${PE.sparkles}

${PE.fire} <b>How to install APKs smoothly:</b>

1️⃣ <b>Download:</b> Tap the APK file sent by this bot.
2️⃣ <b>Permission:</b> Allow installation from Telegram / Browser.
3️⃣ <b>Play Protect prompt:</b>
   • If Android shows <i>"App scan recommended"</i>, use the scan option and review any warning before installation.
   • Do not disable device protection to install an app.

${PE.lock} <b>Before you install:</b>
Install only builds and designs you trust. Signing is not a malware safety guarantee.
`;

      await bot.sendMessage(chatId, helpMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Open Studio', web_app: {url: getSiteUrl()} }
          ]]
        }
      });
    });

    // Approve / Reject button callbacks
    bot.on('callback_query', async (query) => {
      const approvers = String(process.env.TELEGRAM_APPROVER_IDS || '').split(',').map(s=>s.trim());
      if (!approvers.includes(String(query.from?.id))) {
        await bot.answerCallbackQuery(query.id, {text:'Admin approval access required'}).catch(()=>{});
        return;
      }
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
`${PE.check} <b>COIN REQUEST APPROVED</b> ${PE.money}

${PE.user} <b>User:</b> <code>#${row.user_id}</code>
${PE.money} <b>Coins Added:</b> <b>+${row.coins_requested}</b>
${PE.gift} <b>Amount Paid:</b> ₹${row.amount_paid}
${PE.verified} <b>UTR:</b> <code>${escapeHtml(row.utr)}</code>
${PE.dot} <b>Request ID:</b> <code>#${reqId}</code>
`;
            await bot.editMessageCaption(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' })
              .catch(() => bot.editMessageText(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }));

            // Notify user directly
            const targetUser = _db.prepare('SELECT telegram_id, coins FROM users WHERE id=?').get(row.user_id);
            if (targetUser?.telegram_id) {
              const userNotice =
`
  ${PE.party} <b>COIN DEPOSIT APPROVED!</b> ${PE.money}

${PE.check} <b>+${row.coins_requested} Coins</b> have been added to your account!
${PE.money} <b>Current Balance:</b> <code>${targetUser.coins} Coins</code>
${PE.verified} <b>UTR / Ref:</b> <code>${escapeHtml(row.utr)}</code>

${PE.rocket} <i>Aapka balance update ho chuka hai. Ab aap instant APK build kar sakte hain!</i>`;

              bot.sendMessage(targetUser.telegram_id, userNotice, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🟢 Open Studio ↗', web_app: { url: getSiteUrl() } }],
                    [{ text: 'My builds', web_app: { url: `${getSiteUrl()}#orders` } }]
                  ]
                }
              }).catch(() => {});
            }
          } catch(_) {}
        } else {
          _db.prepare('UPDATE coin_requests SET status=?,approved_by=? WHERE id=?')
            .run('rejected', 'telegram_admin', reqId);
          try {
            await bot.answerCallbackQuery(query.id, { text: '❌ Request rejected' });
            const cap =
`${PE.alert} <b>COIN REQUEST REJECTED</b>

${PE.user} <b>User:</b> <code>#${row.user_id}</code>
${PE.verified} <b>UTR:</b> <code>${escapeHtml(row.utr)}</code>
${PE.dot} <b>Request ID:</b> <code>#${reqId}</code>
`;
            await bot.editMessageCaption(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' })
              .catch(() => bot.editMessageText(cap, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }));

            const targetUser = _db.prepare('SELECT telegram_id FROM users WHERE id=?').get(row.user_id);
            if (targetUser?.telegram_id) {
              const userNotice =
`
  ${PE.alert} <b>COIN DEPOSIT UPDATE</b> ${PE.alert}

${PE.alert} <b>Deposit Request #${reqId} could not be approved.</b>
${PE.verified} <b>UTR:</b> <code>${escapeHtml(row.utr)}</code>

Agar aapne payment ki hai to please payment screenshot ke saath <b>Admin Support</b> se contact karein.`;

              bot.sendMessage(targetUser.telegram_id, userNotice, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[{ text: 'Open Studio', web_app: {url: getSiteUrl()} }]]
                }
              }).catch(() => {});
            }
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
`
  ${PE.money} <b>NEW COIN REQUEST</b> ${PE.money}

${PE.user} <b>Username:</b> <code>${escapeHtml(user.username)}</code>
${PE.card} <b>Email:</b> <code>${escapeHtml(user.email)}</code>
${PE.money} <b>Coins Requested:</b> <b>${request.coins_requested}</b>
${PE.gift} <b>Amount:</b> <b>₹${request.amount_paid}</b>
${PE.verified} <b>UTR:</b> <code>${escapeHtml(request.utr)}</code>
${PE.dot} <b>Request ID:</b> <code>#${request.id}</code>

<i>Verify payment and choose action below:</i>`;

  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ APPROVE (+COINS)', callback_data: `approve_${request.id}`, style: 'success' },
      { text: '❌ REJECT', callback_data: `reject_${request.id}`, style: 'danger' }
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

// ── Ultra-Sleek APK Delivery with Premium Emojis ──
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
`
  ${PE.rocket} <b>APK BUILD COMPLETED!</b> ${PE.rocket}

${PE.crown} <b>App Name:</b>  <code>${escapeHtml(appNamePlain)}</code>
${PE.card} <b>Package:</b>   <code>${escapeHtml(order.package_name || 'com.client.app')}</code>
${PE.lock} <b>Protection:</b> <b>Signed Android build</b>
${PE.verified} <b>Status:</b>     <b>Ready to Install</b> ${PE.check}

${PE.down} <i>Uploading your APK files now… Please wait.</i>
`;

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
        ? `${PE.check} <b>REAL PRODUCTION APK</b>\n📁 <code>${escapeHtml(filename)}</code>\n\n${PE.bell} <i><b>Tip:</b> If "App scan recommended" appears, tap "Scan app" and review the result.</i>`
        : `${PE.sparkles} <b>FAKE PREVIEW APK</b>\n📁 <code>${escapeHtml(filename)}</code>\n\n${PE.star} <i>Multi-game clone variant.</i>`;

      try {
        await sendDocumentWithRetry(sender, telegramId, apkPath, caption);
        sentCount++;
      } catch (error) {
        failedFiles.push(filename);
        console.error(`Bot sendDocument error (${filename}):`, error.message);
      }
    }

    const completionCard = failedFiles.length === 0
      ? `${PE.party} <b>All ${sentCount} APK file(s) delivered successfully!</b>\nTap the attached file above to install directly on your phone.`
      : `${PE.alert} <b>${sentCount}/${validApkPaths.length} APK file(s) sent.</b>\nPlease open My Orders to download remaining files.`;

    const deliveryButtons = {
      inline_keyboard: [
        [
          { text: 'Create another app', web_app: { url: siteUrl }, style: 'success' }
        ],
        [
          { text: 'My builds', web_app: { url: `${siteUrl}#orders` }, style: 'primary' },
          ...(supportUrl ? [{ text: 'Contact support', url: supportUrl }] : [])
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

// ── Broadcast Announcement to All Telegram Bot Users with Premium Emojis ──
async function broadcastAnnouncement(announcement) {
  if (!bot || !_db) throw new Error('Telegram bot is not configured or running');

  const users = _db.prepare("SELECT DISTINCT telegram_id FROM users WHERE telegram_id IS NOT NULL AND telegram_id != ''").all();
  if (!users.length) return { total: 0, sent: 0, failed: 0 };

  const { title, message, image_url, button_text, button_url } = announcement;
  const siteUrl = getSiteUrl();
  const supportUrl = getSupportUrl();

  const text =
`
  ${PE.broadcast} <b>${escapeHtml(title.toUpperCase())}</b> ${PE.bell}

${escapeHtml(message)}

${PE.rocket} <b>Official Portal:</b> <a href="${siteUrl}">${siteUrl}</a>`;

  const inlineKeyboard = [];
  if (button_text && button_url) {
    inlineKeyboard.push([{ text: `✨ ${button_text}`, url: button_url.startsWith('http') ? button_url : `https://${button_url}`, style: 'success' }]);
  }
  inlineKeyboard.push([
    { text: 'Open Studio', web_app: { url: siteUrl }, style: 'success' },
    ...(supportUrl ? [{ text: 'Contact support', url: supportUrl }] : [])
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
      await wait(40);
    } catch (e) {
      failed++;
    }
  }

  return { total: users.length, sent, failed };
}

// ── Log Channel & Group Activity Logger with Premium Emojis ──
async function sendLogEvent(eventType, data = {}, attachments = []) {
  if (!bot || !_db) return;
  try {
    const isLogEnabled = _db.prepare("SELECT value FROM settings WHERE key='telegram_log_enabled'").get()?.value;
    if (isLogEnabled === '0' || isLogEnabled === 'false') return;

    const logChannelId = _db.prepare("SELECT value FROM settings WHERE key='telegram_log_channel_id'").get()?.value;
    if (!logChannelId || !logChannelId.trim()) return;

    const targetChat = logChannelId.trim();
    let text = '';

    if (eventType === 'user_registered') {
      text =
`
  ${PE.user} <b>NEW USER REGISTRATION</b> ${PE.party}

${PE.user} <b>Username:</b> <code>${escapeHtml(data.username)}</code>
${PE.card} <b>Email:</b> <code>${escapeHtml(data.email)}</code>
${PE.money} <b>Starting Balance:</b> <code>${data.coins || 0} Coins</code>
${PE.dot} <b>User ID:</b> <code>#${data.id}</code>
${PE.broadcast} <b>IP Address:</b> <code>${escapeHtml(data.ip || 'Unknown')}</code>
${PE.card} <b>Timestamp:</b> <code>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</code>`;
      await bot.sendMessage(targetChat, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } else if (eventType === 'order_created') {
      const modeLabel = data.build_mode === 'fake' ? '🎭 Fake / Clone APK Only' : data.build_mode === 'both' ? '⚡ Real + Fake Both APKs' : '👑 Real Production APK';
      text =
`
  ${PE.rocket} <b>NEW APK BUILD STARTED</b> ${PE.fire}

${PE.user} <b>User:</b> <code>${escapeHtml(data.username)}</code> (ID: <code>#${data.user_id}</code>)
${PE.crown} <b>App Name:</b> <code>${escapeHtml(data.app_name)}</code>
${PE.card} <b>Package:</b> <code>${escapeHtml(data.package_name)}</code>
${PE.sparkles} <b>Template:</b> <b>${escapeHtml(data.design_name || 'Universal')}</b>
${PE.gear} <b>Build Mode:</b> <b>${modeLabel}</b>
${PE.money} <b>Cost:</b> <b>${data.coins_spent} Coins</b>${data.coupon_code ? ` (${PE.gift} Coupon: <code>${escapeHtml(data.coupon_code)}</code> -${data.discount_coins})` : ''}
${PE.arrow} <b>Link:</b> <code>${escapeHtml(data.register_url || data.fake_register_url || '')}</code>
${PE.dot} <b>Order ID:</b> <code>#${data.id}</code>
${PE.card} <b>Timestamp:</b> <code>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</code>`;
      await bot.sendMessage(targetChat, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } else if (eventType === 'order_completed') {
      text =
`
  ${PE.trophy} <b>APK BUILD SUCCESSFUL!</b> ${PE.trophy}

${PE.user} <b>User:</b> <code>${escapeHtml(data.username)}</code> (#${data.user_id})
${PE.crown} <b>App:</b> <code>${escapeHtml(data.app_name)}</code> (Order: <code>#${data.order_id}</code>)
${PE.lock} <b>Security:</b> <b>Signed build · review before installation</b>
${PE.check} <b>Status:</b> <b>Compiled & Archived ✅</b>

📦 <i>APK file(s) attached below for archive.</i>`;
      await bot.sendMessage(targetChat, text, { parse_mode: 'HTML', disable_web_page_preview: true });

      if (Array.isArray(attachments) && attachments.length > 0) {
        for (const apkPath of attachments) {
          if (apkPath && fs.existsSync(apkPath)) {
            const filename = path.basename(apkPath);
            await bot.sendDocument(targetChat, apkPath, {
              caption: `${PE.mobile} <b>Archive:</b> <code>${escapeHtml(filename)}</code>\nOrder: #${data.order_id} | User: ${escapeHtml(data.username)}`,
              parse_mode: 'HTML'
            }, { filename, contentType: 'application/vnd.android.package-archive' });
            await wait(200);
          }
        }
      }
    } else if (eventType === 'coin_requested') {
      text =
`
  ${PE.money} <b>NEW COIN DEPOSIT</b> ${PE.money}

${PE.user} <b>User:</b> <code>${escapeHtml(data.username)}</code> (ID: <code>#${data.user_id}</code>)
${PE.money} <b>Coins Requested:</b> <b>+${data.coins_requested}</b>
${PE.gift} <b>Amount Paid:</b> <b>₹${data.amount_paid}</b>
${PE.verified} <b>UTR:</b> <code>${escapeHtml(data.utr)}</code>
${PE.dot} <b>Request ID:</b> <code>#${data.id}</code>`;
      if (data.screenshot_path && fs.existsSync(data.screenshot_path)) {
        await bot.sendPhoto(targetChat, fs.createReadStream(data.screenshot_path), {
          caption: text,
          parse_mode: 'HTML'
        });
      } else {
        await bot.sendMessage(targetChat, text, { parse_mode: 'HTML' });
      }
    }
  } catch (err) {
    console.error('Telegram sendLogEvent error:', err.message);
  }
}

module.exports = { initBot, sendCoinRequest, sendApkReady, broadcastAnnouncement, sendLogEvent };
