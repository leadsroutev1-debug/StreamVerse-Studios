'use strict';
const axios = require('axios');
const config = require('./config');

async function sendTelegram(text) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn('[Telegram] Not configured, skipping notification.');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      { chat_id: config.telegramChatId, text, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
  } catch (err) {
    console.error('[Telegram] Notification failed:', err.message);
  }
}

module.exports = { sendTelegram };
