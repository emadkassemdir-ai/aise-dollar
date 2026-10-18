'use strict';
/**
 * Every money movement in AISE Dollar goes through this module.
 *
 * Each operation runs inside one BEGIN IMMEDIATE transaction: validate →
 * check balance → insert ledger row. Balances are always derived from the
 * append-only ledger, so they can never drift out of sync.
 */
const crypto = require('node:crypto');
const Money = require('../shared/money.js');
const { transaction } = require('./db.js');

const ROLES = ['student', 'staff', 'merchant', 'banker'];
const REQUEST_TTL_MS = 15 * 60 * 1000; // a QR payment request is valid for 15 minutes

class BankError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BankError';
    this.status = status;
  }
}

const cleanText = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function createBank(db) {
  const q = {
    balance: db.prepare(`
      SELECT COALESCE((SELECT SUM(amount) FROM transactions WHERE to_id = :id), 0)
           - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_id = :id), 0) AS balance`),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByAccount: db.prepare('SELECT * FROM users WHERE account_no = ? COLLATE NOCASE'),
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    maxAccount: db.prepare("SELECT MAX(CAST(SUBSTR(account_no, 6) AS INTEGER)) AS n FROM users"),
    insertUser: db.prepare(`
      INSERT INTO users (account_no, username, name, role, grade, password_hash, must_change)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertTx: db.prepare(`
      INSERT INTO transactions (type, from_id, to_id, amount, memo, actor_id, request_id, client_ref)
      VALUES (:type, :from, :to, :amount, :memo, :actor, :request, :ref)`),
    txByRef: db.prepare('SELECT * FROM transactions WHERE actor_id = ? AND client_ref = ?'),
    txById: db.prepare('SELECT * FROM transactions WHERE id = ?'),
    request: db.prepare(`
      SELECT r.*, m.name AS merchant_name, m.account_no AS merchant_account, p.name AS payer_name
      FROM payment_requests r
      JOIN users m ON m.id = r.merchant_id
      LEFT JOIN users p ON p.id = r.paid_by
      WHERE r.id = ?`),
  };

  // ---------------------------------------------------------------- users ---

  const publicUser = (u) => u && {
    id: u.id, accountNo: u.account_no, username: u.username, name: u.name, role: u.role,
    grade: u.grade, frozen: Boolean(u.frozen), mustChange: Boolean(u.must_change), createdAt: u.created_at,
  };

  function nextAccountNo() {
    return `AISE-${Math.max(q.maxAccount.get().n || 1000, 1000) + 1}`;
  }

  function createUser({ name, username, role, grade, passwordHash, mustChange = true }) {
    name = cleanText(name, 60);
    username = cleanText(username, 40).toLowerCase();
    grade = cleanText(grade, 20);
    if (name.length < 2) throw new BankError('Name must be at least 2 characters.');
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
      throw new BankError('Username must be 3–40 characters: letters, numbers, dot, dash or underscore.');
    }
    if (!ROLES.includes(role)) throw new BankError('Unknown role.');
    return transaction(db, () => {
      if (q.userByUsername.get(username)) throw new BankError(`Username "${username}" is taken.`, 409);
      const { lastInsertRowid } = q.insertUser.run(
        nextAccountNo(), username, name, role, grade, passwordHash, mustChange ? 1 : 0);
      return publicUser(q.userById.get(lastInsertRowid));
    });
  }

  function requireUser(id, label = 'Account') {
    const user = q.userById.get(id);
    if (!user) throw new BankError(`${label} not found.`, 404);
    if (user.frozen) throw new BankError(`${user.name}'s account is frozen.`, 403);
    return user;
  }

  function findByAccountNo(accountNo) {
    const user = q.userByAccount.get(cleanText(accountNo, 20));
    if (!user) throw new BankError('No account with that number.', 404);
    return user;
  }

  function updateUser(id, { frozen, role, grade, name }) {
    const user = q.userById.get(id);
    if (!user) throw new BankError('Account not found.', 404);
    const next = {
      frozen: frozen === undefined ? user.frozen : frozen ? 1 : 0,
      role: role === undefined ? user.role : role,
      grade: grade === undefined ? user.grade : cleanText(grade, 20),
      name: name === undefined ? user.name : cleanText(name, 60),
    };
    if (!ROLES.includes(next.role)) throw new BankError('Unknown role.');
    if (next.name.length < 2) throw new BankError('Name must be at least 2 characters.');
    db.prepare('UPDATE users SET frozen = ?, role = ?, grade = ?, name = ? WHERE id = ?')
      .run(next.frozen, next.role, next.grade, next.name, id);
    return publicUser(q.userById.get(id));
  }

  function setPassword(id, passwordHash, mustChange) {
    db.prepare('UPDATE users SET password_hash = ?, must_change = ? WHERE id = ?')
      .run(passwordHash, mustChange ? 1 : 0, id);
  }

  function listUsers() {
    return db.prepare(`
      SELECT u.*,
        COALESCE((SELECT SUM(amount) FROM transactions WHERE to_id = u.id), 0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_id = u.id), 0) AS balance
      FROM users u ORDER BY u.name COLLATE NOCASE`).all()
      .map((u) => ({ ...publicUser(u), balance: u.balance }));
  }

  /** Who you can pay: every active account, minimal fields only. */
  function directory() {
    return db.prepare(`
      SELECT account_no, name, role, grade FROM users WHERE frozen = 0 ORDER BY name COLLATE NOCASE`).all()
      .map((u) => ({ accountNo: u.account_no, name: u.name, role: u.role, grade: u.grade }));
  }

  // --------------------------------------------------------------- ledger ---

  const balanceOf = (id) => q.balance.get({ id }).balance;

  function assertFunds(user, amount) {
    const available = balanceOf(user.id);
    if (available < amount) {
      throw new BankError(`Insufficient funds: you have ${Money.formatAise(available)}, ` +
        `this needs ${Money.formatAise(amount)}.`, 402);
    }
  }

  function insert(tx) {
    const { lastInsertRowid } = q.insertTx.run({
      type: tx.type, from: tx.from ?? null, to: tx.to ?? null, amount: tx.amount,
      memo: cleanText(tx.memo, 140), actor: tx.actor, request: tx.request ?? null, ref: tx.ref ?? null,
    });
    return q.txById.get(lastInsertRowid);
  }

  /**
   * Idempotency: a client may retry the same request (double-tap, flaky
   * school Wi-Fi). If this actor already used `ref`, return the original
   * transaction instead of charging twice.
   */
  function replay(actorId, ref) {
    if (!ref) return null;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(ref)) throw new BankError('Invalid request reference.');
    return q.txByRef.get(actorId, ref) || null;
  }

  function deposit({ actorId, toId, amount, memo, ref }) {
    Money.assertAmount(amount);
    return transaction(db, () => {
      const existing = replay(actorId, ref);
      if (existing) return existing;
      requireUser(toId, 'Recipient');
      return insert({ type: 'deposit', to: toId, amount, memo, actor: actorId, ref });
    });
  }

  function withdraw({ actorId, fromId, amount, memo, ref }) {
    Money.assertAmount(amount);
    return transaction(db, () => {
      const existing = replay(actorId, ref);
      if (existing) return existing;
      const user = requireUser(fromId);
      assertFunds(user, amount);
      return insert({ type: 'withdraw', from: fromId, amount, memo, actor: actorId, ref });
    });
  }

  function transfer({ fromId, toAccountNo, amount, memo, ref }) {
    Money.assertAmount(amount);
    return transaction(db, () => {
      const existing = replay(fromId, ref);
      if (existing) return existing;
      const sender = requireUser(fromId, 'Sender');
      const recipient = findByAccountNo(toAccountNo);
      if (recipient.id === sender.id) throw new BankError("You can't send money to yourself.");
      requireUser(recipient.id, 'Recipient');
      assertFunds(sender, amount);
      return insert({ type: 'transfer', from: sender.id, to: recipient.id, amount, memo, actor: sender.id, ref });
    });
  }

  // ----------------------------------------------------- payment requests ---

  const publicRequest = (r, now = Date.now()) => r && {
    id: r.id,
    amount: r.amount,
    memo: r.memo,
    status: r.status === 'open' && now > r.expires_at ? 'expired' : r.status,
    merchant: { name: r.merchant_name, accountNo: r.merchant_account },
    paidBy: r.payer_name || null,
    expiresAt: new Date(r.expires_at).toISOString(),
  };

  function createRequest({ merchantId, amount, memo, now = Date.now() }) {
    Money.assertAmount(amount);
    requireUser(merchantId);
    const id = crypto.randomBytes(12).toString('base64url');
    db.prepare(`
      INSERT INTO payment_requests (id, merchant_id, amount, memo, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, merchantId, amount, cleanText(memo, 140), now, now + REQUEST_TTL_MS);
    return getRequest(id, now);
  }

  function getRequest(id, now = Date.now()) {
    const row = q.request.get(String(id));
    if (!row) throw new BankError('Payment request not found.', 404);
    return publicRequest(row, now);
  }

  /** Pay a QR request. The status flip and the transfer are one atomic unit,
   *  so two phones scanning the same code can't both pay it. */
  function payRequest({ requestId, payerId, now = Date.now() }) {
    return transaction(db, () => {
      const row = q.request.get(String(requestId));
      if (!row) throw new BankError('Payment request not found.', 404);
      if (row.status === 'paid') {
        throw new BankError(row.paid_by === payerId ? 'You already paid this.' : 'This was already paid.', 409);
      }
      if (row.status === 'cancelled') throw new BankError('This request was cancelled.', 410);
      if (now > row.expires_at) throw new BankError('This request has expired. Ask for a new code.', 410);
      if (row.merchant_id === payerId) throw new BankError("You can't pay your own request.");

      const payer = requireUser(payerId, 'Payer');
      requireUser(row.merchant_id, 'Merchant');
      assertFunds(payer, row.amount);
      const tx = insert({
        type: 'transfer', from: payerId, to: row.merchant_id, amount: row.amount,
        memo: row.memo, actor: payerId, request: row.id,
      });
      db.prepare("UPDATE payment_requests SET status = 'paid', paid_by = ? WHERE id = ?").run(payerId, row.id);
      return { tx, request: publicRequest(q.request.get(row.id), now) };
    });
  }

  function cancelRequest({ requestId, userId }) {
    const changes = db.prepare(`
      UPDATE payment_requests SET status = 'cancelled'
      WHERE id = ? AND merchant_id = ? AND status = 'open'`).run(String(requestId), userId).changes;
    if (!changes) throw new BankError('Request not found or already closed.', 404);
    return getRequest(requestId);
  }

  // -------------------------------------------------------------- queries ---

  const TX_SELECT = `
    SELECT t.*, f.name AS from_name, f.account_no AS from_account,
           r.name AS to_name, r.account_no AS to_account, a.name AS actor_name
    FROM transactions t
    LEFT JOIN users f ON f.id = t.from_id
    LEFT JOIN users r ON r.id = t.to_id
    JOIN users a ON a.id = t.actor_id`;

  const publicTx = (t, perspectiveId) => ({
    id: t.id, type: t.type, amount: t.amount, memo: t.memo, at: t.created_at,
    from: t.from_id ? { name: t.from_name, accountNo: t.from_account } : null,
    to: t.to_id ? { name: t.to_name, accountNo: t.to_account } : null,
    actor: t.actor_name,
    viaQr: Boolean(t.request_id),
    ...(perspectiveId !== undefined && { delta: t.to_id === perspectiveId ? t.amount : -t.amount }),
  });

  /** Keyset pagination (`before` = last id seen) stays fast on huge ledgers. */
  function history(userId, { limit = 50, before } = {}) {
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = db.prepare(`${TX_SELECT}
      WHERE (t.from_id = :u OR t.to_id = :u) AND (:before IS NULL OR t.id < :before)
      ORDER BY t.id DESC LIMIT :limit`).all({ u: userId, before: before ? Number(before) : null, limit });
    return rows.map((t) => publicTx(t, userId));
  }

  function ledger({ limit = 100, before } = {}) {
    limit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return db.prepare(`${TX_SELECT}
      WHERE (:before IS NULL OR t.id < :before) ORDER BY t.id DESC LIMIT :limit`)
      .all({ before: before ? Number(before) : null, limit }).map((t) => publicTx(t));
  }

  function* ledgerRows() {
    yield* db.prepare(`${TX_SELECT} ORDER BY t.id`).iterate();
  }

  function stats() {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'deposit'  THEN amount END), 0) AS deposited,
        COALESCE(SUM(CASE WHEN type = 'withdraw' THEN amount END), 0) AS withdrawn,
        COALESCE(SUM(CASE WHEN type = 'transfer' THEN amount END), 0) AS transferred,
        COUNT(*) AS transactions,
        COALESCE(SUM(CASE WHEN type = 'transfer' AND created_at >= date('now') THEN amount END), 0) AS today
      FROM transactions`).get();
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const inCirculation = row.deposited - row.withdrawn;
    return { ...row, users, inCirculation, egpReserve: Money.toEgpCents(inCirculation) };
  }

  return {
    ROLES,
    publicUser,
    createUser,
    updateUser,
    setPassword,
    listUsers,
    directory,
    findByAccountNo,
    userById: (id) => q.userById.get(id),
    userByUsername: (username) => q.userByUsername.get(cleanText(username, 40).toLowerCase()),
    balanceOf,
    deposit,
    withdraw,
    transfer,
    createRequest,
    getRequest,
    payRequest,
    cancelRequest,
    history,
    ledger,
    ledgerRows,
    publicTx,
    stats,
  };
}

module.exports = { createBank, BankError, ROLES, REQUEST_TTL_MS };
