const crypto = require('crypto');

const AUTH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Verifies a Telegram Login Widget authorization payload (the object the
 * `onTelegramAuth` callback receives) against the bot token.
 *
 * Per Telegram's spec: build "data_check_string" from all fields except
 * `hash`, sorted by key as `key=value` lines joined with "\n", HMAC-SHA256 it
 * using the SHA-256 of the bot token as the key, and constant-time compare
 * with the provided `hash`.
 *
 * @param {object} payload - `{ id, first_name?, last_name?, username?, auth_date, hash }`
 * @param {string} botToken - the Telegram bot token
 * @param {number} now - current epoch ms (Date.now())
 * @returns {boolean} true only if signature is valid and fresh
 */
function verifyLoginWidget(payload, botToken, now) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.id === 'undefined') return false;
  if (typeof payload.auth_date !== 'number' || !Number.isFinite(payload.auth_date)) return false;
  if (typeof payload.hash !== 'string' || !payload.hash) return false;

  // Freshness: auth_date (seconds) must be recent.
  const authMs = payload.auth_date * 1000;
  if (now - authMs > AUTH_WINDOW_MS || now - authMs < -60 * 1000) return false;

  const fields = {};
  for (const key of Object.keys(payload)) {
    if (key === 'hash') continue;
    fields[key] = payload[key];
  }

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  const secret = crypto.createHash('sha256').update(String(botToken), 'utf8').digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString, 'utf8').digest();

  const a = Buffer.from(computed.toString('hex'), 'utf8');
  const b = Buffer.from(String(payload.hash), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Human-friendly display name from a Telegram auth payload.
 * @param {object} payload
 * @returns {string}
 */
function telegramName(payload) {
  const first = (payload.first_name || '').trim();
  const last = (payload.last_name || '').trim();
  if (first && last) return `${first} ${last}`;
  return first || last || `user_${payload.id}`;
}

module.exports = { verifyLoginWidget, telegramName, AUTH_WINDOW_MS };