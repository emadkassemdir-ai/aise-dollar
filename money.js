/**
 * AISE Dollar money helpers — shared by the server and the browser.
 *
 * Money is always an integer number of cents. Floats never touch a balance:
 * user input is parsed digit-by-digit from the string, and the EGP peg is an
 * integer multiply, so every conversion is exact.
 *
 * Loaded via require() on the server and as a classic <script> in the browser
 * (where it exposes `window.Money`).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Money = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Fixed peg: 1 AISE$ = 10 EGP. */
  const EGP_PER_AISE = 10;
  const CENTS = 100;
  const MAX_CENTS = 1_000_000 * CENTS; // AISE$ 1M per operation — stops fat-finger typos

  class MoneyError extends Error {
    constructor(message) {
      super(message);
      this.name = 'MoneyError';
    }
  }

  function assertAmount(cents) {
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      throw new MoneyError('Amount must be greater than zero.');
    }
    if (cents > MAX_CENTS) throw new MoneyError('That amount is unrealistically large.');
    return cents;
  }

  /** "12", "12.5", "1,250.75" → integer cents. "0.29" is exactly 29. */
  function parseAmount(input) {
    const text = String(input ?? '').trim().replace(/,/g, '');
    const match = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(text);
    if (!match) throw new MoneyError('Enter an amount like 25 or 12.50 (max 2 decimals).');
    return assertAmount(Number(match[1]) * CENTS + Number((match[2] || '').padEnd(2, '0')));
  }

  function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / CENTS).toLocaleString('en-US');
    return `${sign}${whole}.${String(abs % CENTS).padStart(2, '0')}`;
  }

  /** Plain "1250.50" with no thousands separator — for inputs and CSV. */
  const plainCents = (cents) => formatCents(cents).replace(/,/g, '');

  const toEgpCents = (aiseCents) => aiseCents * EGP_PER_AISE;
  // The currency's display name. The Bank Office can rename it (e.g. "Adam Coins");
  // only the label changes — amounts and the 1 : 10 EGP rate never do.
  const DEFAULT_CURRENCY = 'AISE$';
  let currency = DEFAULT_CURRENCY;
  const setCurrency = (name) => { currency = String(name || '').trim() || DEFAULT_CURRENCY; };
  const currencyName = () => currency;
  const formatAise = (cents) => `${currency} ${formatCents(cents)}`;
  const formatEgp = (aiseCents) => `EGP ${formatCents(toEgpCents(aiseCents))}`;

  /**
   * EGP → AISE for cash deposits. Rounds DOWN to the nearest AISE cent and
   * reports the leftover piastres so the bank can hand back exact change.
   */
  function egpToAise(egpCents) {
    if (!Number.isSafeInteger(egpCents) || egpCents < 0) throw new MoneyError('Invalid EGP amount.');
    const aiseCents = Math.floor(egpCents / EGP_PER_AISE);
    return { aiseCents, changeEgpCents: egpCents - aiseCents * EGP_PER_AISE };
  }

  return {
    EGP_PER_AISE,
    DEFAULT_CURRENCY,
    setCurrency,
    currencyName,
    MAX_CENTS,
    MoneyError,
    assertAmount,
    parseAmount,
    formatCents,
    plainCents,
    formatAise,
    formatEgp,
    toEgpCents,
    egpToAise,
  };
});
