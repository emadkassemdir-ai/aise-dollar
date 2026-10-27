'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../money.js');

test('parseAmount converts text to exact integer cents', () => {
  assert.equal(M.parseAmount('12'), 1200);
  assert.equal(M.parseAmount('12.5'), 1250);
  assert.equal(M.parseAmount('0.29'), 29); // float math would give 28.999…
  assert.equal(M.parseAmount(' 1,250.75 '), 125075);
  for (const bad of ['', '0', '0.00', '-5', 'abc', '1.234', '1e3', '.5', '9999999999']) {
    assert.throws(() => M.parseAmount(bad), M.MoneyError, `should reject "${bad}"`);
  }
  assert.throws(() => M.parseAmount('1000001'), /unrealistically/);
});

test('peg is exactly 1 AISE$ = 10 EGP', () => {
  assert.equal(M.EGP_PER_AISE, 10);
  assert.equal(M.toEgpCents(100), 1000);
  assert.equal(M.formatEgp(1250), 'EGP 125.00');
  assert.equal(M.formatAise(12345678), 'AISE$ 123,456.78');
  assert.equal(M.formatAise(-5), 'AISE$ -0.05');
  assert.equal(M.plainCents(123456), '1234.56');
});

test('egpToAise rounds down and reports exact change', () => {
  assert.deepEqual(M.egpToAise(12500), { aiseCents: 1250, changeEgpCents: 0 });
  assert.deepEqual(M.egpToAise(1255), { aiseCents: 125, changeEgpCents: 5 });
  assert.deepEqual(M.egpToAise(9), { aiseCents: 0, changeEgpCents: 9 });
  assert.throws(() => M.egpToAise(-1), M.MoneyError);
});

test('the currency can be renamed without changing amounts', () => {
  M.setCurrency('Adam Coins');
  assert.equal(M.formatAise(1250), 'Adam Coins 12.50');
  assert.equal(M.formatEgp(1250), 'EGP 125.00');
  M.setCurrency('   ');
  assert.equal(M.formatAise(1250), 'AISE$ 12.50', 'blank goes back to the default');
});
