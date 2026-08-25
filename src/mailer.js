'use strict';
/**
 * Mailer — sends account emails (verification, welcome) two ways:
 *
 *   1. Resend transactional email HTTP API (preferred). Configure:
 *        RESEND_API_KEYS        comma-separated list of Resend API keys, used
 *                                in round-robin order with automatic rotation
 *                                when a key hits its sending limit (429 /
 *                                quota-exhausted response from Resend).
 *                                Example: "re_abc123,re_def456,re_ghi789"
 *        RESEND_API_KEY         single-key alternative to RESEND_API_KEYS
 *                                (kept for back-compat — if both are set,
 *                                RESEND_API_KEYS wins).
 *        RESEND_SENDER_EMAIL    must be a verified sender/domain in Resend.
 *        RESEND_SENDER_NAME     optional, defaults to "StreamVerse Studio".
 *        RESEND_KEY_COOLDOWN_MS optional, ms before an exhausted key is
 *                                tried again (default 24h — Resend limits
 *                                are typically daily/monthly).
 *
 *   2. SMTP fallback (used automatically when no Resend key is configured,
 *      or when every configured Resend key is exhausted / the Resend API
 *      call fails and SMTP is configured). Configure:
 *        SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE ("true"/"false")
 *        SMTP_FROM_EMAIL, SMTP_FROM_NAME
 *
 *      SMTP sending uses nodemailer — add it to package.json dependencies
 *      and `npm install` before using the SMTP path. The Resend HTTP path
 *      has no extra dependency (uses the existing axios).
 */

const axios = require('axios');

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_KEY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

function _senderName() {
  return process.env.RESEND_SENDER_NAME || process.env.SMTP_FROM_NAME || 'StreamVerse Studio';
}

function _keyCooldownMs() {
  const raw = parseInt(process.env.RESEND_KEY_COOLDOWN_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KEY_COOLDOWN_MS;
}

// ── Resend API key pool / rotation ──────────────────────────────────────────
//
// Keys are read once at module load and kept in memory along with a
// "exhausted until" timestamp per key. sendMail() always asks the pool for
// the next usable key; when Resend reports a key has hit its sending limit
// we mark that key exhausted and immediately retry with the next one, so a
// single call to sendMail() transparently rotates through the whole pool
// before falling back to SMTP.

class ResendKeyPool {
  constructor(keys) {
    this.keys = keys;
    this.cursor = 0;
    this.exhaustedUntil = new Map(); // key -> timestamp (ms) it becomes usable again
  }

  static fromEnv() {
    const list = (process.env.RESEND_API_KEYS || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (list.length === 0 && process.env.RESEND_API_KEY) {
      list.push(process.env.RESEND_API_KEY.trim());
    }

    return new ResendKeyPool(list);
  }

  get configured() {
    return this.keys.length > 0;
  }

  _isUsable(key) {
    const until = this.exhaustedUntil.get(key);
    return !until || until <= Date.now();
  }

  /** Returns the ordered list of keys to try this send, starting at the
   *  current rotation cursor and wrapping around once. */
  candidates() {
    const n = this.keys.length;
    const ordered = [];
    for (let i = 0; i < n; i++) {
      ordered.push(this.keys[(this.cursor + i) % n]);
    }
    // Prefer usable keys first, but still include exhausted ones at the end
    // in case every key is currently marked exhausted (better to try than
    // to fail outright — Resend limits sometimes reset early).
    const usable = ordered.filter((k) => this._isUsable(k));
    const notUsable = ordered.filter((k) => !this._isUsable(k));
    return [...usable, ...notUsable];
  }

  markExhausted(key) {
    this.exhaustedUntil.set(key, Date.now() + _keyCooldownMs());
    // Advance the cursor so the *next* sendMail() call starts on a fresh key
    // instead of re-trying the one we just exhausted first.
    const idx = this.keys.indexOf(key);
    if (idx !== -1) this.cursor = (idx + 1) % this.keys.length;
  }

  markSucceeded(key) {
    const idx = this.keys.indexOf(key);
    if (idx !== -1) this.cursor = idx; // stick with a working key next time
  }

  allExhausted() {
    return this.keys.length > 0 && this.keys.every((k) => !this._isUsable(k));
  }
}

const resendPool = ResendKeyPool.fromEnv();

function _smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** True when the Resend error indicates the key's sending limit/quota was
 *  hit, as opposed to some other failure (bad request, invalid recipient,
 *  auth error, etc.) that rotating keys wouldn't fix. */
function _isLimitExhaustedError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  const name = body?.name || '';
  const message = (body?.message || '').toLowerCase();

  if (status === 429) return true; // rate limited
  if (name === 'rate_limit_exceeded' || name === 'daily_quota_exceeded') return true;
  if (message.includes('rate limit') || message.includes('quota') || message.includes('limit exceeded')) return true;

  return false;
}

async function _sendViaResendKey(key, { to, subject, html, text }) {
  return axios.post(
    RESEND_API_URL,
    {
      from:    `${_senderName()} <${process.env.RESEND_SENDER_EMAIL}>`,
      to:      [to],
      subject,
      html,
      text,
    },
    {
      headers: {
        Authorization:  `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
}

/** Tries every usable key in the pool in rotation order. Throws the last
 *  error if every key fails; throws a dedicated "exhausted" error if every
 *  key is specifically limit-exhausted (so callers/logs can tell the two
 *  cases apart). */
async function _sendViaResend(payload) {
  if (!resendPool.configured) {
    throw new Error('Resend is not configured — set RESEND_API_KEYS or RESEND_API_KEY.');
  }

  const candidates = resendPool.candidates();
  let lastErr;

  for (const key of candidates) {
    try {
      const result = await _sendViaResendKey(key, payload);
      resendPool.markSucceeded(key);
      return result;
    } catch (err) {
      lastErr = err;
      if (_isLimitExhaustedError(err)) {
        console.warn(`[Mailer] Resend key ...${key.slice(-4)} hit its sending limit — rotating to next key.`);
        resendPool.markExhausted(key);
        continue; // try the next key in the pool
      }
      // Non-limit error (bad request, invalid sender, auth failure, etc.) —
      // rotating keys won't help, so bail out immediately.
      throw err;
    }
  }

  // Every key was limit-exhausted.
  const exhaustedErr = new Error('All configured Resend API keys are limit-exhausted.');
  exhaustedErr.cause = lastErr;
  exhaustedErr.allKeysExhausted = true;
  throw exhaustedErr;
}

async function _sendViaSmtp({ to, subject, html, text }) {
  // Lazy-required so the app still boots if nodemailer isn't installed and
  // only Resend is being used.
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    throw new Error('SMTP fallback requires the "nodemailer" package — run npm install.');
  }

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from:    `"${_senderName()}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text,
  });
}

/**
 * Send an email, preferring Resend's HTTP API (rotating across all
 * configured keys as each one hits its sending limit) and falling back to
 * SMTP. Throws if neither transport is configured or both fail.
 */
async function sendMail({ to, subject, html, text }) {
  if (resendPool.configured) {
    try {
      return await _sendViaResend({ to, subject, html, text });
    } catch (err) {
      const reason = err.allKeysExhausted
        ? 'all Resend keys are limit-exhausted'
        : (err.response?.data || err.message);
      console.error('[Mailer] Resend send failed:', reason);
      if (!_smtpConfigured()) throw err;
      console.warn('[Mailer] Falling back to SMTP...');
    }
  }
  if (_smtpConfigured()) {
    return _sendViaSmtp({ to, subject, html, text });
  }
  throw new Error('No email transport configured — set RESEND_API_KEYS (+ RESEND_SENDER_EMAIL) or SMTP_HOST/SMTP_USER/SMTP_PASS.');
}

// ── Templates ────────────────────────────────────────────────────────────────

function _emailShell({ preheader, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StreamVerse Studio</title>
</head>
<body style="margin:0;padding:0;background-color:#030307;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#030307;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:linear-gradient(180deg,#0e0e1a 0%,#0a0a14 100%);border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;">
          <tr>
            <td style="padding:36px 36px 24px 36px;text-align:center;">
              <div style="font-family:Georgia,serif;font-weight:800;font-size:22px;letter-spacing:0.5px;color:#ffffff;">
                Stream<span style="background:linear-gradient(90deg,#8b5cf6,#22d3ee);-webkit-background-clip:text;background-clip:text;color:#8b5cf6;">Verse</span>
              </div>
              <div style="font-size:10px;letter-spacing:3px;color:#8b8b9e;text-transform:uppercase;margin-top:2px;">Studio</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 36px 36px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 36px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
              <p style="margin:0;font-size:11px;color:#5c5c6e;">© ${new Date().getFullYear()} StreamVerse Studio. If you didn't request this email, you can safely ignore it.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function verificationEmail({ verifyUrl }) {
  const bodyHtml = `
    <h1 style="margin:0 0 12px 0;font-size:20px;color:#ffffff;font-weight:700;">Confirm your email</h1>
    <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#b3b3c2;">
      Welcome to StreamVerse Studio. Confirm your email address to activate your account and start watching.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px auto;">
      <tr>
        <td style="border-radius:999px;background:linear-gradient(90deg,#8b5cf6,#6d28d9);">
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">
            Verify Email Address
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#6c6c7e;">
      Or paste this link into your browser:<br>
      <a href="${verifyUrl}" style="color:#22d3ee;word-break:break-all;">${verifyUrl}</a>
    </p>
    <p style="margin:20px 0 0 0;font-size:12px;color:#6c6c7e;">This link expires in 24 hours.</p>
  `;
  return {
    subject: 'Confirm your StreamVerse Studio account',
    html: _emailShell({ preheader: 'Confirm your email to activate your StreamVerse Studio account.', bodyHtml }),
    text: `Welcome to StreamVerse Studio! Confirm your email: ${verifyUrl}`,
  };
}

function welcomeEmail({ appUrl }) {
  const bodyHtml = `
    <h1 style="margin:0 0 12px 0;font-size:20px;color:#ffffff;font-weight:700;">You're verified 🎬</h1>
    <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#b3b3c2;">
      Your email is confirmed and your StreamVerse Studio account is ready. New episodes publish daily.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
      <tr>
        <td style="border-radius:999px;background:linear-gradient(90deg,#8b5cf6,#6d28d9);">
          <a href="${appUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">
            Start Watching
          </a>
        </td>
      </tr>
    </table>
  `;
  return {
    subject: 'Your StreamVerse Studio account is ready',
    html: _emailShell({ preheader: 'Your account is verified — start watching now.', bodyHtml }),
    text: `Your StreamVerse Studio account is verified. Start watching: ${appUrl}`,
  };
}

module.exports = { sendMail, verificationEmail, welcomeEmail };