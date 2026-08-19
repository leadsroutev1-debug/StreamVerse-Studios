'use strict';
/**
 * Token / session store abstraction.
 *
 * Provides createToken() / getToken() / deleteToken() so the streaming
 * gateway (and anything else that needs short-lived, scoped tokens) doesn't
 * scatter raw `Map` calls throughout the codebase.
 *
 * The current implementation is an in-memory Map — fine for a single
 * process/instance deployment. The public surface (create/get/delete/purge)
 * is deliberately storage-agnostic so this can be swapped for a Redis-backed
 * implementation later (e.g. SET key val PX ttl / GET / DEL) without
 * touching the streaming API that calls it.
 */

const crypto = require('crypto');

class TokenStore {
  /**
   * @param {string} name         Store name, used only for logging.
   * @param {number} purgeEveryMs How often to sweep expired entries.
   */
  constructor(name, purgeEveryMs = 5 * 60 * 1000) {
    this._name = name;
    this._map  = new Map();
    this._timer = setInterval(() => this._purgeExpired(), purgeEveryMs);
    this._timer.unref?.(); // don't keep the process alive just for this
  }

  _purgeExpired() {
    const now = Date.now();
    for (const [token, entry] of this._map) {
      if (entry.expiresAt < now) this._map.delete(token);
    }
  }

  /**
   * Create a new token bound to arbitrary session data plus a TTL.
   * @param {object} data     Arbitrary session payload (e.g. episodeId, sessionId).
   * @param {number} ttlMs    Time-to-live in milliseconds.
   * @returns {string} the newly minted token
   */
  createToken(data, ttlMs) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this._map.set(token, {
      ...data,
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    return token;
  }

  /**
   * Retrieve token data if the token exists and has not expired.
   * Expired tokens are removed and treated as not found.
   * @returns {object|null}
   */
  getToken(token) {
    if (!token || typeof token !== 'string') return null;
    const entry = this._map.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this._map.delete(token);
      return null;
    }
    return entry;
  }

  /** Delete a token (e.g. after one-time use). */
  deleteToken(token) {
    this._map.delete(token);
  }

  /** Current live (non-expired-sweep-pending) size — for diagnostics only. */
  size() {
    return this._map.size;
  }
}

module.exports = { TokenStore };
