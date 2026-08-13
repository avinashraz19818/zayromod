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

function initBot(token, db) {
  if (db) _db = db;
  try {
    // Stop existing clients before creating new ones. Cancelling the active
    // long-poll avoids a temporary 409 conflict when an admin changes token.
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

    // APK uploads can run for a while (especially for a real+fake pair). Give
    // polling and file delivery separate HTTP connection pools so a large
    // multipart upload can never occupy the bot's update/command connection.
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

    // /start handler — send Mini App button
    bot.onText(/\/start/, async (msg) => {
      const chatId    = String(msg.chat.id);
      const firstName = (msg.from?.first_name || 'there').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
      const siteUrl   = getSiteUrl();
      try {
        await bot.sendMessage(
          chatId,
          `👋 Welcome *${firstName}*\\!\n\nBuild your custom APK in seconds\\.`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔨 Open APK Builder', web_app: { url: siteUrl } }
              ]]
            }
          }
        );
      } catch (e) {
        console.error('Bot /start error:', e.message);
      }
    });

    // Approve / Reject button callbacks
    bot.on('callback_query', async (query) => {
      const data  = query.data || '';
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
            await bot.answerCallbackQuery(query.id, { text: `✅ Approved ${row.coins_requested} coins!` });
            await bot.editMessageCaption(
              `✅ *APPROVED* by admin\n\n🪙 +${row.coins_requested} coins → user #${row.user_id}\n🔖 UTR: \`${row.utr}\`\n🆔 Request #${reqId}`,
              { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
            ).catch(() =>
              bot.editMessageText(
                `✅ *APPROVED* by admin\n\n🪙 +${row.coins_requested} coins → user #${row.user_id}\n🔖 UTR: \`${row.utr}\`\n🆔 Request #${reqId}`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
              )
            );
          } catch(_) {}
        } else {
          _db.prepare('UPDATE coin_requests SET status=?,approved_by=? WHERE id=?')
            .run('rejected', 'telegram_admin', reqId);
          try {
            await bot.answerCallbackQuery(query.id, { text: '❌ Request rejected' });
            await bot.editMessageCaption(
              `❌ *REJECTED* by admin\n\n🔖 UTR: \`${row.utr}\`\n🆔 Request #${reqId}`,
              { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
            ).catch(() =>
              bot.editMessageText(
                `❌ *REJECTED* by admin\n\n🔖 UTR: \`${row.utr}\`\n🆔 Request #${reqId}`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
              )
            );
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

async function sendCoinRequest(adminChatId, user, request, screenshotPath) {
  if (!bot || !adminChatId) return null;

  const msg =
    `💰 *New Coin Request*\n\n` +
    `👤 Username: \`${user.username}\`\n` +
    `📧 Email: ${user.email}\n` +
    `🪙 Coins: *${request.coins_requested}*\n` +
    `💵 Amount: ₹${request.amount_paid}\n` +
    `🔖 UTR: \`${request.utr}\`\n` +
    `🆔 Request #${request.id}`;

  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve_${request.id}` },
      { text: '❌ Reject',  callback_data: `reject_${request.id}`  }
    ]]
  };

  try {
    let sent;
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      sent = await bot.sendPhoto(adminChatId, fs.createReadStream(screenshotPath), {
        caption: msg, parse_mode: 'Markdown', reply_markup
      });
    } else {
      sent = await bot.sendMessage(adminChatId, msg, { parse_mode: 'Markdown', reply_markup });
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
      // Passing the local path lets node-telegram-bot-api create and close a
      // fresh stream for every attempt (important when a first upload resets).
      return await sender.sendDocument(
        telegramId,
        apkPath,
        { caption },
        { filename, contentType: 'application/vnd.android.package-archive' }
      );
    } catch (error) {
      const delay = getRetryDelay(error, attempt);
      if (attempt === maxAttempts - 1 || delay === null) throw error;
      await wait(delay);
    }
  }
}

async function deliverApkReady(sender, user, order, apkPaths, downloadUrls) {
  const telegramId = user.telegram_id;
  const validApkPaths = apkPaths.filter(apkPath => apkPath && fs.existsSync(apkPath));
  const appNamePlain = order.app_name || 'APK';
  let statusMessage = null;
  let sentCount = 0;
  const failedFiles = [];

  if (validApkPaths.length > 0) {
    const countText = validApkPaths.length === 2
      ? 'real + fake APKs'
      : `${validApkPaths.length} APK file${validApkPaths.length === 1 ? '' : 's'}`;

    try {
      statusMessage = await sender.sendMessage(
        telegramId,
        `✅ ${appNamePlain} is ready. Uploading ${countText} now…\n\nYou can keep using the bot while files are uploading.`
      );
    } catch (error) {
      console.error('Bot APK status message error:', error.message);
    }

    for (let index = 0; index < validApkPaths.length; index++) {
      const apkPath = validApkPaths[index];
      const filename = path.basename(apkPath);
      const label = validApkPaths.length === 2
        ? (index === 0 ? '✅ Real APK' : '🎭 Fake APK')
        : '📱 APK';

      try {
        await sendDocumentWithRetry(sender, telegramId, apkPath, `${label}\n${filename}`);
        sentCount++;
      } catch (error) {
        failedFiles.push(filename);
        console.error(`Bot sendDocument error (${filename}):`, error.message);
      }
    }

    const completionText = failedFiles.length === 0
      ? `✅ ${appNamePlain}: ${sentCount === 2 ? 'both APK files' : 'APK file'} sent successfully.`
      : `⚠️ ${appNamePlain}: ${sentCount}/${validApkPaths.length} APK files sent. Open My Orders to download ${failedFiles.join(', ')}.`;

    if (statusMessage?.message_id) {
      try {
        await sender.editMessageText(completionText, {
          chat_id: telegramId,
          message_id: statusMessage.message_id
        });
      } catch (_) {}
    } else {
      try { await sender.sendMessage(telegramId, completionText); } catch (_) {}
    }
  }

  // Send download links if URLs provided
  if (downloadUrls.length > 0) {
    const appName = appNamePlain.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    const linksMsg = downloadUrls.map((url, i) =>
      `🔗 [Download APK ${i + 1}](${url})`
    ).join('\n');
    const finalMsg =
      `✅ *Your APK is Ready\\!*\n\n` +
      `📱 App: *${appName}*\n` +
      `📦 \`${order.package_name}\`\n\n` +
      linksMsg;
    try {
      await sender.sendMessage(telegramId, finalMsg, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false
      });
    } catch (error) {
      console.error('Bot sendMessage links error:', error.message);
    }
  }
}

function sendApkReady(user, order, apkPaths = [], downloadUrls = []) {
  const sender = deliveryBot;
  if (!sender || !user?.telegram_id) return Promise.resolve();

  // One delivery at a time prevents multiple completed builds from saturating
  // upload bandwidth. This queue only affects the delivery client; the polling
  // bot remains completely independent and responsive.
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

module.exports = { initBot, sendCoinRequest, sendApkReady };
