'use strict';
/**
 * Auth — password hashing + stateless signed session tokens.
 *
 * No new crypto dependency: password hashing uses Node's built-in
 * crypto.scrypt (a proper, slow, salted KDF), and session tokens are a
 * base64url(payload) + HMAC-SHA256 signature, verified with the same
 * SESSION_SECRET already used by the streaming gateway's internal-pipeline
 * bypass header (src/streamGateway.js). This keeps the auth system entirely
 * self-contained — no jsonwebtoken/bcrypt packages required.
 */

const crypto = require('crypto');

const SESSION_SECRET   = process.env.SESSION_SECRET || '';
const TOKEN_TTL_MS      = 1000 * 60 * 60 * 24 * parseInt(process.env.AUTH_TOKEN_TTL_DAYS || '30', 10);
const SCRYPT_KEYLEN     = 64;

if (!SESSION_SECRET) {
  console.warn('[Auth] SESSION_SECRET is not set — session tokens will be insecure. Set it in your environment.');
}

// ── Password hashing ────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  try {
    const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const expected  = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// ── Session tokens ──────────────────────────────────────────────────────────

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function _sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('hex');
}

/** Issue a signed session token for a user. */
function createSessionToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payloadB64 = _b64url(JSON.stringify(payload));
  const sig = _sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/** Verify + decode a session token. Returns the payload, or null if invalid/expired. */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  try {
    const expected = _sign(payloadB64);
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(_b64urlDecode(payloadB64).toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Express middleware: requires a valid `Authorization: Bearer <token>` header. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifySessionToken(token);
  if (!payload) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }
  req.user = payload;
  next();
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createAdminSessionToken() {
  const payload = { role: 'admin', iat: Date.now(), exp: Date.now() + (1000 * 60 * 60 * 12) };
  const payloadB64 = _b64url(JSON.stringify(payload));
  return `${payloadB64}.${_sign(payloadB64)}`;
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifySessionToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ ok: false, error: 'Admin authentication required' });
  }
  req.admin = payload;
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  requireAuth,
  randomToken,
  createAdminSessionToken,
  requireAdmin,
};
