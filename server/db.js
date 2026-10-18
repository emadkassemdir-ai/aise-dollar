'use strict';
/**
 * SQLite storage via Node's built-in `node:sqlite` — zero dependencies.
 *
 * The ledger rules are enforced by the database itself, not just app code:
 *  - amounts are positive integers (CHECK constraints)
 *  - transactions are append-only (triggers reject UPDATE and DELETE)
 *  - each transaction type has the right shape (deposit has no sender, etc.)
 */
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  account_no    TEXT    NOT NULL UNIQUE,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('student','staff','merchant','banker')),
  grade         TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 1,
  frozen        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,           -- SHA-256 of the cookie; a DB leak can't hijack sessions
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY,
  type       TEXT    NOT NULL CHECK (type IN ('deposit','withdraw','transfer')),
  from_id    INTEGER REFERENCES users(id),
  to_id      INTEGER REFERENCES users(id),
  amount     INTEGER NOT NULL CHECK (amount > 0 AND typeof(amount) = 'integer'),
  memo       TEXT    NOT NULL DEFAULT '',
  actor_id   INTEGER NOT NULL REFERENCES users(id),  -- who pressed the button (audit trail)
  request_id TEXT    REFERENCES payment_requests(id),
  client_ref TEXT,                                   -- idempotency key from the client
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (type = 'deposit'  AND from_id IS NULL     AND to_id IS NOT NULL) OR
    (type = 'withdraw' AND from_id IS NOT NULL AND to_id IS NULL) OR
    (type = 'transfer' AND from_id IS NOT NULL AND to_id IS NOT NULL AND from_id <> to_id)
  )
);
CREATE INDEX IF NOT EXISTS tx_from ON transactions(from_id);
CREATE INDEX IF NOT EXISTS tx_to   ON transactions(to_id);
CREATE UNIQUE INDEX IF NOT EXISTS tx_idempotency ON transactions(actor_id, client_ref)
  WHERE client_ref IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS tx_no_update BEFORE UPDATE ON transactions
  BEGIN SELECT RAISE(ABORT, 'transactions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tx_no_delete BEFORE DELETE ON transactions
  BEGIN SELECT RAISE(ABORT, 'transactions are append-only'); END;

CREATE TABLE IF NOT EXISTS payment_requests (
  id          TEXT    PRIMARY KEY,           -- unguessable random id, encoded in the QR
  merchant_id INTEGER NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  memo        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled')),
  paid_by     INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function open(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  }
  db.exec(SCHEMA);
  return db;
}

/**
 * Run `fn` inside BEGIN IMMEDIATE … COMMIT. The write lock is taken up front,
 * so a balance read inside `fn` can't be invalidated by a concurrent writer
 * before the debit is inserted (no double-spend, even across processes).
 */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, transaction };
