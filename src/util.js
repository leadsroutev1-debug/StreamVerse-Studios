'use strict';

/**
 * Safely parse a value that may be a JSON string OR an already-parsed object.
 * mysql2 auto-parses JSON columns into objects, so calling JSON.parse on them
 * again throws "[object Object] is not valid JSON".
 */
function safeJsonParse(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = { safeJsonParse };
