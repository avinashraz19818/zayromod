'use strict';
// Compatibility boundary for the maintained v2 Telegram client.
const { Bot, InputFile } = require('node-telegram-bot-api');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
function errorLabel(error) {
  const status = error?.errorCode || error?.error_code || error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return String(status);
  const code = error?.cause?.code || error?.code;
  return ['EFETCH','ETIMEOUT','EPARSE','EUNKNOWN','ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code) ? code : 'network';
}
class TelegramAdapter extends EventEmitter {
  constructor(token, options = {}) {
    super();
    this.client = new Bot(token, { timeoutMs: options.request?.timeout || 30000 });
    this.rules = [];
    this.client.use(async ctx => {
      const update = ctx.update;
      if (/^\/start(?:@\w+)?(?:\s|$)/.test(update.message?.text || '')) {
        const approved = require('./telegram-access').telegramAllowed(update.message.from?.id);
        console.log('[Telegram] /start received; approved=' + approved + '; private=' + (update.message.chat?.type === 'private'));
      }
      if (update.message?.text) {
        for (const [regex, callback] of this.rules) {
          regex.lastIndex = 0;
          const match = regex.exec(update.message.text);
          if (match) await callback(update.message, match);
        }
      }
      if (update.callback_query) {
        for (const callback of this.listeners('callback_query')) await callback(update.callback_query);
      }
    });
    this.client.catch(error => this.emit('polling_error', new Error('Telegram update failed (' + errorLabel(error) + ')')));
    if (options.polling) setImmediate(() => {
      console.log('[Telegram] polling started; message/callback updates enabled');
      let lastErrorAt = -Infinity;
      this.loop = this.client.startPolling(undefined, {
        timeout: 10,
        allowedUpdates: ['message', 'callback_query'],
        onError: error => {
          if (Date.now() - lastErrorAt < 60000) return;
          lastErrorAt = Date.now();
          this.emit('polling_error', new Error('Telegram polling retry (' + errorLabel(error) + ')'));
        }
      }).catch(error => this.emit('polling_error', new Error('Telegram polling stopped (' + errorLabel(error) + ')')));
    });
  }
  onText(regex, callback) { this.rules.push([regex, callback]); }
  async stopPolling() { this.client.stop(); await this.loop; }
  async call(method, args) {
    try { return await this.client.api[method](args); }
    catch (e) {
      const safe = new Error(`Telegram ${method} failed (${errorLabel(e)})`);
      safe.response = { statusCode: e.errorCode || e.error_code || e.status, body: { parameters: e.parameters } };
      throw safe;
    }
  }
  file(input, options = {}) {
    if (typeof input === 'string' && !fs.existsSync(input)) return input;
    const file = typeof input === 'string' ? input : input?.path;
    if (file) {
      input?.destroy?.();
      return new InputFile(fs.readFileSync(file), { filename: options.filename || path.basename(file) });
    }
    return new InputFile(input, { filename: options.filename || 'upload.bin' });
  }
  sendMessage(chat_id, text, options = {}) { return this.call('sendMessage', { chat_id, text, ...options }); }
  sendDocument(chat_id, document, options = {}, fileOptions = {}) { return this.call('sendDocument', { chat_id, document: this.file(document, fileOptions), ...options }); }
  sendPhoto(chat_id, photo, options = {}) { return this.call('sendPhoto', { chat_id, photo: this.file(photo), ...options }); }
  editMessageText(text, options = {}) { return this.call('editMessageText', { text, ...options }); }
  editMessageCaption(caption, options = {}) { return this.call('editMessageCaption', { caption, ...options }); }
  answerCallbackQuery(callback_query_id, options = {}) { return this.call('answerCallbackQuery', { callback_query_id, ...options }); }
}
module.exports = TelegramAdapter;
