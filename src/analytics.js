'use strict';

const crypto = require('crypto');

const EVENT_TYPES = new Set([
  'consent','page_view','heartbeat','session_end',
  'video_start','video_progress','video_pause','video_complete','video_end','video_seek',
  'interaction','error'
]);

function safeString(value, max = 500) {
  if (value == null) return null;
  const str = String(value).trim();
  return str ? str.slice(0, max) : null;
}

function cleanId(value) {
  const id = safeString(value, 128);
  return id && /^[A-Za-z0-9._:-]{8,128}$/.test(id) ? id : null;
}

function parseUserAgent(ua) {
  const raw = safeString(ua, 1000) || '';
  const lower = raw.toLowerCase();
  let deviceType = 'desktop';
  if (/ipad|tablet|kindle|silk/.test(lower)) deviceType = 'tablet';
  else if (/mobile|iphone|ipod|android/.test(lower)) deviceType = 'mobile';

  let browser = 'Other';
  if (/edg\//.test(lower)) browser = 'Edge';
  else if (/opr\//.test(lower) || /opera/.test(lower)) browser = 'Opera';
  else if (/firefox\//.test(lower)) browser = 'Firefox';
  else if (/chrome\//.test(lower) && !/edg\//.test(lower)) browser = 'Chrome';
  else if (/safari\//.test(lower) && !/chrome\//.test(lower)) browser = 'Safari';

  let os = 'Other';
  if (/windows nt/.test(lower)) os = 'Windows';
  else if (/mac os x/.test(lower)) os = 'macOS';
  else if (/android/.test(lower)) os = 'Android';
  else if (/iphone|ipad|ipod/.test(lower)) os = 'iOS';
  else if (/linux/.test(lower)) os = 'Linux';

  return { deviceType, browser, os, userAgent: raw };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '').trim() || null;
}

function geoFromRequest(req, browser = {}) {
  const h = req.headers || {};
  const pick = (...keys) => keys.map(k => h[k]).find(v => v != null && String(v).trim()) || null;
  const countryCode = safeString(pick('cf-ipcountry', 'x-vercel-ip-country', 'x-nf-country', 'x-country-code', 'x-country'), 8)?.toUpperCase() || null;
  return {
    countryCode: countryCode && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
    countryName: safeString(pick('x-country-name', 'cf-ipcountry-name'), 120),
    region: safeString(pick('x-vercel-ip-country-region', 'x-region'), 120),
    city: safeString(pick('x-vercel-ip-city', 'x-city'), 120),
    continent: safeString(pick('x-vercel-ip-continent', 'x-continent'), 32),
    geoSource: countryCode ? 'request-header' : 'unknown',
    timezone: safeString(browser.timezone, 120),
  };
}

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.ANALYTICS_IP_SALT || process.env.SESSION_SECRET || 'streamverse-analytics';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function normalizeBrowser(browser = {}) {
  return {
    language: safeString(browser.language, 35),
    languages: Array.isArray(browser.languages) ? browser.languages.slice(0, 10).map(v => safeString(v, 35)).filter(Boolean) : null,
    timezone: safeString(browser.timezone, 120),
    platform: safeString(browser.platform, 120),
    screenWidth: Number.isFinite(Number(browser.screenWidth)) ? Math.max(0, Math.min(10000, Number(browser.screenWidth))) : null,
    screenHeight: Number.isFinite(Number(browser.screenHeight)) ? Math.max(0, Math.min(10000, Number(browser.screenHeight))) : null,
    viewportWidth: Number.isFinite(Number(browser.viewportWidth)) ? Math.max(0, Math.min(10000, Number(browser.viewportWidth))) : null,
    viewportHeight: Number.isFinite(Number(browser.viewportHeight)) ? Math.max(0, Math.min(10000, Number(browser.viewportHeight))) : null,
    deviceMemory: Number.isFinite(Number(browser.deviceMemory)) ? Math.max(0, Math.min(128, Number(browser.deviceMemory))) : null,
    hardwareConcurrency: Number.isFinite(Number(browser.hardwareConcurrency)) ? Math.max(0, Math.min(512, Number(browser.hardwareConcurrency))) : null,
  };
}

function normalizeEvent(body) {
  const eventType = safeString(body?.eventType, 40);
  if (!EVENT_TYPES.has(eventType)) throw new Error('Unsupported analytics event');
  const visitorId = cleanId(body?.visitorId);
  const sessionId = cleanId(body?.sessionId);
  if (!visitorId || !sessionId) throw new Error('Analytics visitor/session identifiers are required');

  const episodeId = safeString(body?.episodeId, 36);
  const path = safeString(body?.path, 1024) || '/';
  const durationSeconds = Number.isFinite(Number(body?.durationSeconds)) ? Math.max(0, Math.min(3600, Number(body.durationSeconds))) : 0;
  const videoSeconds = Number.isFinite(Number(body?.videoSeconds)) ? Math.max(0, Math.min(86400, Number(body.videoSeconds))) : null;
  const videoDuration = Number.isFinite(Number(body?.videoDuration)) ? Math.max(0, Math.min(86400, Number(body.videoDuration))) : 0;

  let metadata = body?.metadata;
  if (metadata == null) metadata = {};
  if (typeof metadata !== 'object') metadata = { value: safeString(metadata, 500) };
  const metadataJson = JSON.stringify(metadata).slice(0, 5000);

  return { eventType, visitorId, sessionId, episodeId: episodeId || null, path, referrer: safeString(body?.referrer, 1024), durationSeconds, videoSeconds, videoDuration, metadata: metadataJson };
}

function optionalUserId(authModule, req) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    return authModule.verifySessionToken(token)?.sub || null;
  } catch { return null; }
}

function flagEmoji(countryCode) {
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return '🌐';
  return String.fromCodePoint(...countryCode.split('').map(c => 127397 + c.charCodeAt(0)));
}

module.exports = {
  EVENT_TYPES,
  safeString,
  parseUserAgent,
  getClientIp,
  geoFromRequest,
  hashIp,
  normalizeBrowser,
  normalizeEvent,
  optionalUserId,
  flagEmoji,
};
