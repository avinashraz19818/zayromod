'use strict';
// Compatibility boundary for the maintained v2 Telegram client.
const { Bot, InputFile } = require('node-telegram-bot-api');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
class TelegramAdapter extends EventEmitter {
  constructor(token, options = {}) {
    super();
    this.client = new Bot(token);
    this.rules = [];
    this.client.use(async ctx => {
      const update = ctx.update;
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
    this.client.catch(() => this.emit('polling_error', new Error('Telegram update failed; check bot configuration')));
    if (options.polling) setImmediate(() => {
      this.loop = this.client.startPolling().catch(() => this.emit('polling_error', new Error('Telegram polling failed')));
    });
  }
  onText(regex, callback) { this.rules.push([regex, callback]); }
  async stopPolling() { this.client.stop(); await this.loop; }
  async call(method, args) {
    try { return await this.client.api[method](args); }
    catch (e) {
      const safe = new Error(`Telegram ${method} failed (${e.error_code || e.status || 'network'})`);
      safe.response = { statusCode: e.error_code || e.status, body: { parameters: e.parameters } };
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
