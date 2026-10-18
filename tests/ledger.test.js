'use strict';
// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ledger.js');

/** Deterministic context: sequential ids and a fixed clock. */
function ctx() {
  let n = 0;
  return { id: () => `id${++n}`, now: () => new Date('2026-10-18T08:00:00Z') };
}

const PIN = { pinHash: 'h', pinSalt: 's' };

function setup() {
  const c = ctx();
  let state = L.createState();
  let r = L.openAccount(state, { name: 'Omar Hassan', grade: '10B', ...PIN }, c);
  const omar = r.account;
  r = L.openAccount(r.state, { name: 'Layla Farouk', ...PIN }, c);
  const layla = r.account;
  r = L.openAccount(r.state, { name: 'Canteen', kind: 'merchant', ...PIN }, c);
  return { state: r.state, omar, layla, canteen: r.account, c };
}

test('parseAmount converts text to exact integer cents', () => {
  assert.equal(L.parseAmount('12'), 1200);
  assert.equal(L.parseAmount('12.5'), 1250);
  assert.equal(L.parseAmount('0.29'), 29); // float math would give 28.999…
  assert.equal(L.parseAmount(' 1,250.75 '), 125075);
  for (const bad of ['', '0', '0.00', '-5', 'abc', '1.234', '1e3', '.5']) {
    assert.throws(() => L.parseAmount(bad), L.LedgerError, `should reject "${bad}"`);
  }
});

test('peg is exactly 1 AISE$ = 10 EGP', () => {
  assert.equal(L.EGP_PER_AISE, 10);
  assert.equal(L.toEgpCents(100), 1000);
  assert.equal(L.formatEgp(1250), 'EGP 125.00');
  assert.equal(L.formatAise(123456789), 'AISE$ 1,234,567.89');
  assert.deepEqual(L.egpToAise(12500), { aiseCents: 1250, changeEgpCents: 0 });
  // EGP 12.55 → AISE$ 1.25, with 5 piastres handed back as change
  assert.deepEqual(L.egpToAise(1255), { aiseCents: 125, changeEgpCents: 5 });
});

test('accounts get sequential numbers and unique names', () => {
  const { state, omar, layla, canteen, c } = setup();
  assert.deepEqual([omar.number, layla.number, canteen.number], ['AISE-1001', 'AISE-1002', 'AISE-1003']);
  assert.throws(() => L.openAccount(state, { name: 'omar  hassan', ...PIN }, c), /already exists/);
  assert.throws(() => L.openAccount(state, { name: 'X', ...PIN }, c), /at least 2/);
  assert.throws(() => L.openAccount(state, { name: 'No Pin' }, c), /PIN is required/);
  assert.throws(() => L.openAccount(state, { name: 'Bad Kind', kind: 'admin', ...PIN }, c), /Unknown/);
});

test('deposit, transfer and withdraw move money correctly', () => {
  let { state, omar, layla, canteen, c } = setup();
  state = L.deposit(state, { to: omar.id, amount: 5000 }, c).state; // 500 EGP handed in
  state = L.transfer(state, { from: omar.id, to: layla.id, amount: 1250, memo: 'Book' }, c).state;
  state = L.transfer(state, { from: layla.id, to: canteen.id, amount: 300 }, c).state;
  state = L.withdraw(state, { from: canteen.id, amount: 300 }, c).state;

  assert.equal(L.balanceOf(state, omar.id), 3750);
  assert.equal(L.balanceOf(state, layla.id), 950);
  assert.equal(L.balanceOf(state, canteen.id), 0);

  const map = L.balances(state);
  assert.equal(map.get(omar.id), 3750);
  assert.equal(map.get(layla.id), 950);

  const s = L.stats(state);
  assert.equal(s.inCirculation, 4700);
  assert.equal(s.egpReserveCents, 47000); // bank must hold EGP 470.00
  // Conservation: sum of balances === money in circulation
  assert.equal([...map.values()].reduce((a, b) => a + b, 0), s.inCirculation);
});

test('overdrafts, self-transfers and frozen accounts are rejected', () => {
  let { state, omar, layla, c } = setup();
  state = L.deposit(state, { to: omar.id, amount: 1000 }, c).state;

  assert.throws(() => L.transfer(state, { from: omar.id, to: layla.id, amount: 1001 }, c), /Insufficient/);
  assert.throws(() => L.withdraw(state, { from: layla.id, amount: 1 }, c), /Insufficient/);
  assert.throws(() => L.transfer(state, { from: omar.id, to: omar.id, amount: 1 }, c), /yourself/);
  assert.throws(() => L.transfer(state, { from: omar.id, to: 'ghost', amount: 1 }, c), /Recipient not found/);
  assert.throws(() => L.deposit(state, { to: omar.id, amount: 0 }, c), /greater than zero/);
  assert.throws(() => L.deposit(state, { to: omar.id, amount: 1.5 }, c), /greater than zero/);

  const frozen = L.updateAccount(state, layla.id, { frozen: true });
  assert.throws(() => L.transfer(frozen, { from: omar.id, to: layla.id, amount: 1 }, c), /frozen/);
});

test('operations never mutate their input state', () => {
  const { state, omar, c } = setup();
  const snapshot = JSON.stringify(state);
  L.deposit(state, { to: omar.id, amount: 100 }, c);
  L.updateAccount(state, omar.id, { frozen: true });
  assert.equal(JSON.stringify(state), snapshot);
});

test('updateAccount only allows whitelisted fields', () => {
  const { state, omar } = setup();
  const next = L.updateAccount(state, omar.id, { name: 'Hacker', number: 'AISE-1', frozen: true });
  const updated = L.findAccount(next, omar.id);
  assert.equal(updated.name, 'Omar Hassan');
  assert.equal(updated.number, 'AISE-1001');
  assert.equal(updated.frozen, true);
});

test('history is newest-first with signed deltas', () => {
  let { state, omar, layla, c } = setup();
  state = L.deposit(state, { to: omar.id, amount: 1000 }, c).state;
  state = L.transfer(state, { from: omar.id, to: layla.id, amount: 400, memo: '  hi  ' }, c).state;
  const h = L.historyOf(state, omar.id);
  assert.deepEqual(h.map((t) => [t.type, t.delta]), [['transfer', -400], ['deposit', 1000]]);
  assert.equal(h[0].memo, 'hi');
  assert.equal(L.historyOf(state, layla.id)[0].delta, 400);
});

test('validateState accepts real data and rejects tampered backups', () => {
  let { state, omar, layla, c } = setup();
  state = L.deposit(state, { to: omar.id, amount: 1000 }, c).state;
  state = L.transfer(state, { from: omar.id, to: layla.id, amount: 400 }, c).state;
  const roundTrip = JSON.parse(JSON.stringify(state));
  assert.equal(L.validateState(roundTrip), roundTrip);

  const inflated = JSON.parse(JSON.stringify(state));
  inflated.transactions[1].amount = 99999; // transfer more than was deposited
  assert.throws(() => L.validateState(inflated), /negative/);

  assert.throws(() => L.validateState({ version: 99, accounts: [], transactions: [] }), /version/);
  assert.throws(() => L.validateState(null), /JSON object/);
  const orphan = JSON.parse(JSON.stringify(state));
  orphan.transactions[0].to = 'nobody';
  assert.throws(() => L.validateState(orphan), /unknown account/);
});
