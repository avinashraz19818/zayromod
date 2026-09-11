'use strict';

// APK compilation uses Gradle and several synchronous shell commands.
// Keeping those commands in this short-lived child process prevents them from
// blocking the API server and Telegram bot polling in the parent process.
const { buildApkInWorker } = require('./apkbuilder');

function sendToParent(message, exitCode = 0) {
  if (!process.connected) {
    process.exit(exitCode);
    return;
  }

  process.send(message, () => process.exit(exitCode));
}

process.once('message', async message => {
  if (!message || message.type !== 'build') {
    sendToParent({ type: 'error', error: 'Invalid build worker request' }, 1);
    return;
  }

  const log = text => {
    if (process.connected) {
      try { process.send({ type: 'log', message: String(text) }); }
      catch (_) {}
    }
  };

  try {
    const result = await buildApkInWorker(message.order, message.design, message.buildId, log);
    sendToParent({ type: 'result', result });
  } catch (error) {
    sendToParent({
      type: 'error',
      error: error?.stack || error?.message || String(error)
    }, 1);
  }
});
