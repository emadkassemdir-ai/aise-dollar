/**
 * AISE Dollar ledger — the pure, framework-free core of the app.
 *
 * Design rules:
 *  - Money is always an integer number of cents. Floats never touch a balance,
 *    so 0.1 + 0.2 bugs are impossible.
 *  - The transaction log is append-only and is the single source of truth.
 *    Balances are derived from it, never stored, so they can't drift.
 *  - Every operation returns a NEW state object; inputs are never mutated.
 *    That makes undo, persistence and testing trivial.
 *
 * Loaded as a classic <script> in the browser (exposes `window.AISE`) and via
 * require() in Node for the test suite, so the app works straight from file://.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AISE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Fixed peg: 1 AISE$ = 10 EGP. */
  const EGP_PER_AISE = 10;
  const CENTS = 100;
  const MAX_CENTS = 100_000_000_00; // 100M AISE$ — guards against typos like 1e12
  const ACCOUNT_KINDS = ['student', 'staff', 'merchant'];
  const SCHEMA_VERSION = 1;

  class LedgerError extends Error {
    constructor(message) {
      super(message);
      this.name = 'LedgerError';
    }
  }

  // ---------------------------------------------------------------- money ---

  /**
   * Parse a user-typed amount ("12", "12.5", "1,250.75") into integer cents.
   * Done on the string itself so "0.29" is exactly 29 cents, not 28.999….
   */
  function parseAmount(input) {
    const text = String(input ?? '').trim().replace(/,/g, '');
    const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
    if (!match) throw new LedgerError('Enter an amount like 25 or 12.50 (max 2 decimals).');
    const cents = Number(match[1]) * CENTS + Number((match[2] || '').padEnd(2, '0'));
    assertAmount(cents);
    return cents;
  }

  function assertAmount(cents) {
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      throw new LedgerError('Amount must be greater than zero.');
    }
    if (cents > MAX_CENTS) throw new LedgerError('That amount is unrealistically large.');
  }

  function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / CENTS).toLocaleString('en-US');
    return `${sign}${whole}.${String(abs % CENTS).padStart(2, '0')}`;
  }

  const formatAise = (cents) => `AISE$ ${formatCents(cents)}`;
  /** AISE cents → EGP piastres is a pure integer multiply, so it's exact. */
  const toEgpCents = (aiseCents) => aiseCents * EGP_PER_AISE;
  const formatEgp = (aiseCents) => `EGP ${formatCents(toEgpCents(aiseCents))}`;

  /**
   * EGP → AISE for cash deposits. Rounds DOWN to the nearest AISE cent and
   * reports the leftover so the bank can hand back exact change.
   */
  function egpToAise(egpCents) {
    if (!Number.isSafeInteger(egpCents) || egpCents < 0) {
      throw new LedgerError('Invalid EGP amount.');
    }
    const aiseCents = Math.floor(egpCents / EGP_PER_AISE);
    return { aiseCents, changeEgpCents: egpCents - aiseCents * EGP_PER_AISE };
  }

  // ---------------------------------------------------------------- state ---

  function createState() {
    return { version: SCHEMA_VERSION, accounts: [], transactions: [] };
  }

  function defaultId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Injectable clock + id generator keeps tests deterministic. */
  function context(ctx = {}) {
    return { now: ctx.now || (() => new Date()), id: ctx.id || defaultId };
  }

  function findAccount(state, id) {
    return state.accounts.find((a) => a.id === id) || null;
  }

  function requireAccount(state, id, role = 'Account') {
    const account = findAccount(state, id);
    if (!account) throw new LedgerError(`${role} not found.`);
    if (account.frozen) throw new LedgerError(`${account.name}'s account is frozen.`);
    return account;
  }

  function cleanMemo(memo) {
    return String(memo ?? '').trim().slice(0, 140);
  }

  // ------------------------------------------------------------- accounts ---

  /**
   * Open an account. `pinHash` is produced by the UI layer (salted SHA-256);
   * the ledger never sees a raw PIN.
   */
  function openAccount(state, { name, kind = 'student', grade = '', pinHash, pinSalt }, ctx) {
    const { id, now } = context(ctx);
    const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2) throw new LedgerError('Name must be at least 2 characters.');
    if (!ACCOUNT_KINDS.includes(kind)) throw new LedgerError('Unknown account type.');
    if (!pinHash || !pinSalt) throw new LedgerError('A PIN is required.');
    const duplicate = state.accounts.some(
      (a) => a.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (duplicate) throw new LedgerError(`An account named "${cleanName}" already exists.`);

    const account = {
      id: id(),
      number: nextAccountNumber(state),
      name: cleanName,
      kind,
      grade: String(grade ?? '').trim().slice(0, 20),
      pinHash,
      pinSalt,
      frozen: false,
      openedAt: now().toISOString(),
    };
    return { state: { ...state, accounts: [...state.accounts, account] }, account };
  }

  /** Human-friendly sequential numbers: AISE-1001, AISE-1002, … */
  function nextAccountNumber(state) {
    const max = state.accounts.reduce(
      (m, a) => Math.max(m, Number(a.number.split('-')[1]) || 0),
      1000
    );
    return `AISE-${max + 1}`;
  }

  function updateAccount(state, accountId, patch) {
    if (!findAccount(state, accountId)) throw new LedgerError('Account not found.');
    const allowed = ['frozen', 'pinHash', 'pinSalt', 'grade'];
    const safe = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    return {
      ...state,
      accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, ...safe } : a)),
    };
  }

  // --------------------------------------------------------- transactions ---

  /**
   * Transaction shapes (amount is always positive cents):
   *   deposit  — bank → `to`     (cash EGP handed in at the office)
   *   withdraw — `from` → bank   (AISE$ cashed out to EGP)
   *   transfer — `from` → `to`   (peer-to-peer or paying a merchant)
   */
  function record(state, tx, ctx) {
    const { id, now } = context(ctx);
    const full = { id: id(), at: now().toISOString(), ...tx, memo: cleanMemo(tx.memo) };
    return { state: { ...state, transactions: [...state.transactions, full] }, tx: full };
  }

  function deposit(state, { to, amount, memo }, ctx) {
    assertAmount(amount);
    requireAccount(state, to, 'Recipient');
    return record(state, { type: 'deposit', from: null, to, amount, memo }, ctx);
  }

  function withdraw(state, { from, amount, memo }, ctx) {
    assertAmount(amount);
    const account = requireAccount(state, from);
    assertFunds(state, account, amount);
    return record(state, { type: 'withdraw', from, to: null, amount, memo }, ctx);
  }

  function transfer(state, { from, to, amount, memo }, ctx) {
    assertAmount(amount);
    if (from === to) throw new LedgerError("You can't send money to yourself.");
    const sender = requireAccount(state, from, 'Sender');
    requireAccount(state, to, 'Recipient');
    assertFunds(state, sender, amount);
    return record(state, { type: 'transfer', from, to, amount, memo }, ctx);
  }

  function assertFunds(state, account, amount) {
    const available = balanceOf(state, account.id);
    if (available < amount) {
      throw new LedgerError(
        `Insufficient funds: ${account.name} has ${formatAise(available)}, needs ${formatAise(amount)}.`
      );
    }
  }

  // -------------------------------------------------------------- queries ---

  /** One pass over the log → Map<accountId, cents>. O(transactions). */
  function balances(state) {
    const map = new Map(state.accounts.map((a) => [a.id, 0]));
    for (const tx of state.transactions) {
      if (tx.from) map.set(tx.from, (map.get(tx.from) || 0) - tx.amount);
      if (tx.to) map.set(tx.to, (map.get(tx.to) || 0) + tx.amount);
    }
    return map;
  }

  function balanceOf(state, accountId) {
    let total = 0;
    for (const tx of state.transactions) {
      if (tx.from === accountId) total -= tx.amount;
      if (tx.to === accountId) total += tx.amount;
    }
    return total;
  }

  /** Newest first, with a signed `delta` from this account's point of view. */
  function historyOf(state, accountId) {
    return state.transactions
      .filter((tx) => tx.from === accountId || tx.to === accountId)
      .map((tx) => ({ ...tx, delta: tx.to === accountId ? tx.amount : -tx.amount }))
      .reverse();
  }

  /**
   * Money supply invariant: everything in circulation was deposited and not
   * yet withdrawn. The bank must hold exactly `inCirculation × 10` EGP in cash.
   */
  function stats(state) {
    let deposited = 0;
    let withdrawn = 0;
    let transferred = 0;
    for (const tx of state.transactions) {
      if (tx.type === 'deposit') deposited += tx.amount;
      else if (tx.type === 'withdraw') withdrawn += tx.amount;
      else if (tx.type === 'transfer') transferred += tx.amount;
    }
    const inCirculation = deposited - withdrawn;
    return {
      accounts: state.accounts.length,
      transactions: state.transactions.length,
      deposited,
      withdrawn,
      transferred,
      inCirculation,
      egpReserveCents: toEgpCents(inCirculation),
    };
  }

  // -------------------------------------------------------- import/export ---

  /** Validate an imported backup thoroughly before it can replace live data. */
  function validateState(raw) {
    const fail = (why) => {
      throw new LedgerError(`Invalid backup file: ${why}`);
    };
    if (!raw || typeof raw !== 'object') fail('not a JSON object.');
    if (raw.version !== SCHEMA_VERSION) fail(`unsupported version ${raw.version}.`);
    if (!Array.isArray(raw.accounts) || !Array.isArray(raw.transactions)) fail('missing data.');

    const ids = new Set();
    for (const a of raw.accounts) {
      if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') fail('bad account.');
      if (!ACCOUNT_KINDS.includes(a.kind)) fail(`bad account type for ${a.name}.`);
      if (ids.has(a.id)) fail('duplicate account id.');
      ids.add(a.id);
    }
    // Replay the log to prove no account ever went negative.
    const running = new Map();
    for (const tx of raw.transactions) {
      if (!['deposit', 'withdraw', 'transfer'].includes(tx?.type)) fail('bad transaction type.');
      if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) fail('bad transaction amount.');
      for (const side of [tx.from, tx.to]) if (side && !ids.has(side)) fail('unknown account.');
      if (tx.from) {
        const next = (running.get(tx.from) || 0) - tx.amount;
        if (next < 0) fail('a balance goes negative.');
        running.set(tx.from, next);
      }
      if (tx.to) running.set(tx.to, (running.get(tx.to) || 0) + tx.amount);
    }
    return raw;
  }

  return {
    EGP_PER_AISE,
    ACCOUNT_KINDS,
    LedgerError,
    parseAmount,
    formatCents,
    formatAise,
    formatEgp,
    toEgpCents,
    egpToAise,
    createState,
    openAccount,
    updateAccount,
    findAccount,
    deposit,
    withdraw,
    transfer,
    balances,
    balanceOf,
    historyOf,
    stats,
    validateState,
  };
});
