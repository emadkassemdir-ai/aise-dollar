'use strict';
/**
 * Passwords, sessions and brute-force protection.
 *
 * Passwords: scrypt (memory-hard) with a per-user random salt, compared in
 * constant time. Sessions: 256-bit random tokens in an HttpOnly cookie; only
 * the token's SHA-256 is stored, so a database leak doesn't leak logins.
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;

const SESSION_IDLE_MS = 30 * 60 * 1000;      // log out after 30 min idle
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;  // and after 12 h no matter what

const MIN_PASSWORD = 8;

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD} characters.`, 400);
  }
  if (password.length > 200) throw new AuthError('Password is too long.', 400);
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) {
    throw new AuthError('Password needs at least one letter and one number.', 400);
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || typeof password !== 'string') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** A hash to compare against when the username doesn't exist, so response
 *  time doesn't reveal which usernames are real. Computed once, lazily. */
let dummyHash;
async function burnTime(password) {
  dummyHash ??= await hashPassword('timing-equaliser-1');
  await verifyPassword(String(password ?? ''), dummyHash);
}

/** Readable temporary passwords: no 0/O/1/l/I confusion. e.g. "kite-7mr4-wave" */
function temporaryPassword() {
  const words = ['kite', 'nile', 'palm', 'wave', 'lamp', 'star', 'moon', 'sand', 'reef', 'lion',
    'hawk', 'leaf', 'rain', 'gold', 'pine', 'rose', 'tide', 'peak', 'dune', 'bird'];
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = (list) => list[crypto.randomInt(list.length)];
  const mid = Array.from({ length: 4 }, () => pick(chars)).join('');
  return `${pick(words)}-${mid}-${pick(words)}${crypto.randomInt(10)}`;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sha256(token), userId, now, now, now + SESSION_MAX_MS);
  return token;
}

/** Look up a session, enforcing idle + absolute expiry, and slide last_seen. */
function readSession(db, token, now = Date.now()) {
  if (!token) return null;
  const hash = sha256(token);
  const row = db.prepare(`
    SELECT s.last_seen, s.expires_at, u.id, u.account_no, u.username, u.name, u.role,
           u.grade, u.must_change, u.frozen
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(hash);
  if (!row) return null;
  if (now > row.expires_at || now - row.last_seen > SESSION_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  // Throttle writes: only bump last_seen once a minute.
  if (now - row.last_seen > 60_000) {
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
  }
  return {
    id: row.id, accountNo: row.account_no, username: row.username, name: row.name, role: row.role,
    grade: row.grade, mustChange: Boolean(row.must_change), frozen: Boolean(row.frozen),
  };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function destroyUserSessions(db, userId, exceptToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?')
    .run(userId, exceptToken ? sha256(exceptToken) : null);
}

function pruneSessions(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?').run(now, now - SESSION_IDLE_MS);
}

/**
 * Login throttle keyed by IP *and* by username, so an attacker can neither
 * hammer one account from many IPs nor spray many accounts from one IP.
 * Lockout doubles each time: 1 min, 2 min, 4 min … capped at 1 hour.
 */
class Throttle {
  constructor({ maxFails = 5, baseLockMs = 60_000, maxLockMs = 3_600_000 } = {}) {
    Object.assign(this, { maxFails, baseLockMs, maxLockMs, entries: new Map() });
  }

  check(keys, now = Date.now()) {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry && entry.lockedUntil > now) {
        const seconds = Math.ceil((entry.lockedUntil - now) / 1000);
        throw new AuthError(`Too many failed attempts. Try again in ${seconds}s.`, 429);
      }
    }
  }

  fail(keys, now = Date.now()) {
    if (this.entries.size > 50_000) this.sweep(now); // bound memory under a spraying attack
    for (const key of keys) {
      const entry = this.entries.get(key) || { fails: 0, lockedUntil: 0, strikes: 0 };
      entry.fails += 1;
      if (entry.fails >= this.maxFails) {
        entry.lockedUntil = now + Math.min(this.baseLockMs * 2 ** entry.strikes, this.maxLockMs);
        entry.strikes += 1;
        entry.fails = 0;
      }
      this.entries.set(key, entry);
    }
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil < now) this.entries.delete(key);
    }
  }

  succeed(keys) {
    for (const key of keys) this.entries.delete(key);
  }
}

module.exports = {
  AuthError,
  MIN_PASSWORD,
  validatePassword,
  hashPassword,
  verifyPassword,
  burnTime,
  temporaryPassword,
  createSession,
  readSession,
  destroySession,
  destroyUserSessions,
  pruneSessions,
  Throttle,
  sha256,
};
