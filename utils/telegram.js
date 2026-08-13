const TelegramBot = require('node-telegram-bot-api');
const fs   = require('fs');
const path = require('path');

let bot = null;
let _db  = null;

function getSiteUrl() {
  if (!_db) return 'https://devlopedwithzayro.site';
  return _db.prepare("SELECT value FROM settings WHERE key='site_url'").get()?.value
    || 'https://devlopedwithzayro.site';
}

function initBot(token, db) {
  if (db) _db = db;
  try {
    // stop existing bot before creating new one
    if (bot) {
      try { bot.stopPolling(); } catch(_) {}
      bot = null;
    }
    if (!token || !String(token).trim()) return;

    bot = new TelegramBot(String(token).trim(), { polling: true });

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

async function sendApkReady(user, order, apkPaths = [], downloadUrls = []) {
  if (!bot) return;
  const telegramId = user.telegram_id;
  if (!telegramId) return;

  const appName = order.app_name.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

  // Send APK files if paths provided
  if (apkPaths && apkPaths.length > 0) {
    const msg =
      `✅ *Your APK is Ready\\!*\n\n` +
      `📱 App: *${appName}*\n` +
      `📦 \`${order.package_name}\`\n\n` +
      `Sending APK file now\\.\\.\\.`;
    try {
      await bot.sendMessage(telegramId, msg, { parse_mode: 'MarkdownV2' });
    } catch (_) {}

    for (const apkPath of apkPaths) {
      if (!apkPath || !fs.existsSync(apkPath)) continue;
      const filename = path.basename(apkPath);
      try {
        await bot.sendDocument(
          telegramId,
          fs.createReadStream(apkPath),
          { caption: `📱 ${filename}` },
          { filename }
        );
      } catch (e) {
        console.error('Bot sendDocument error:', e.message);
      }
    }
  }

  // Send download links if URLs provided
  if (downloadUrls && downloadUrls.length > 0) {
    const linksMsg = downloadUrls.map((url, i) =>
      `🔗 [Download APK ${i + 1}](${url})`
    ).join('\n');
    const finalMsg =
      `✅ *Your APK is Ready\\!*\n\n` +
      `📱 App: *${appName}*\n` +
      `📦 \`${order.package_name}\`\n\n` +
      linksMsg;
    try {
      await bot.sendMessage(telegramId, finalMsg, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false
      });
    } catch (e) {
      console.error('Bot sendMessage links error:', e.message);
    }
  }
}

module.exports = { initBot, sendCoinRequest, sendApkReady };
