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
      { chat_id: config.telegramChatId, text: String(text ?? ''), parse_mode: 'HTML' },
      { timeout: 10000 }
    );
  } catch (err) {
    // Telegram rejects malformed HTML with HTTP 400. This is especially easy
    // to trigger when a model-generated diagnostic contains '<', '>' or '&'.
    // Retry once as plain text so notifications never become a secondary
    // pipeline failure.
    if (err?.response?.status === 400) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
          { chat_id: config.telegramChatId, text: String(text ?? '') },
          { timeout: 10000 }
        );
        console.warn('[Telegram] HTML notification rejected with 400; resent as plain text.');
        return;
      } catch (fallbackErr) {
        console.error('[Telegram] Plain-text notification retry failed:', fallbackErr.message);
        return;
      }
    }
    console.error('[Telegram] Notification failed:', err.message);
  }
}

module.exports = { sendTelegram };
