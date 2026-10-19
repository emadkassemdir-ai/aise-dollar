'use strict';
/**
 * End-to-end API tests: a real HTTP server on a random port with an
 * in-memory database, driven through fetch() like the browser would.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app.js');

const SETUP_CODE = 'test-setup-code';
const silent = { info() {}, error() {} };

async function startServer() {
  const app = createApp({ setupCode: SETUP_CODE, log: silent });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, close: () => new Promise((r) => app.server.close(r)) };
}

/** A tiny cookie-keeping client, one per simulated person/device. */
function client(base) {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(cookie && { cookie }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(method !== 'GET' && { 'x-aise': '1' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b = {}, h) => call('POST', p, b, h),
    patch: (p, b = {}, h) => call('PATCH', p, b, h),
    raw: call,
  };
}

/** Bank + two students + a canteen, all logged in and passwords changed. */
async function world() {
  const srv = await startServer();
  const bank = client(srv.base);
  let r = await bank.post('/api/setup', { code: SETUP_CODE, name: 'Ms. Nadia', username: 'nadia', password: 'banker123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const people = {};
  for (const [username, name, role] of [['omar', 'Omar Hassan', 'student'], ['layla', 'Layla Farouk', 'student'], ['canteen', 'School Canteen', 'merchant']]) {
    r = await bank.post('/api/admin/users', { username, name, role, grade: role === 'student' ? '10B' : '' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = client(srv.base);
    const login = await c.post('/api/login', { username, password: r.data.tempPassword });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.mustChange, true);
    const changed = await c.post('/api/me/password', { current: r.data.tempPassword, next: `${username}pass1` });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    people[username] = { c, accountNo: r.data.user.accountNo, id: r.data.user.id, password: `${username}pass1` };
  }
  return { ...srv, bank, ...people };
}

test('first-run setup requires the code and only works once', async () => {
  const srv = await startServer();
  const c = client(srv.base);
  assert.deepEqual((await c.get('/api/setup')).data, { needed: true });
  assert.equal((await c.post('/api/setup', { code: 'nope', name: 'X Y', username: 'xy', password: 'abc12345' })).status, 403);
  assert.equal((await c.post('/api/setup', { code: SETUP_CODE, name: 'Admin', username: 'admin', password: 'short' })).status, 400);
  const ok = await c.post('/api/setup', { code: SETUP_CODE, name: 'Admin', username: 'admin', password: 'abc12345' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'banker');
  assert.equal((await c.post('/api/setup', { code: SETUP_CODE, name: 'Evil', username: 'evil', password: 'abc12345' })).status, 409);
  await srv.close();
});

test('login, session cookie, logout and wrong passwords', async () => {
  const w = await world();
  const anon = client(w.base);
  assert.equal((await anon.get('/api/me')).status, 401);
  assert.equal((await anon.post('/api/login', { username: 'omar', password: 'wrongpass1' })).status, 401);
  assert.equal((await anon.post('/api/login', { username: 'ghost', password: 'whatever1' })).status, 401);

  const res = await anon.post('/api/login', { username: 'OMAR', password: w.omar.password }); // case-insensitive
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await anon.get('/api/me')).data.user.accountNo, w.omar.accountNo);

  await anon.post('/api/logout');
  assert.equal((await anon.get('/api/me')).status, 401);
  await w.close();
});

test('brute force is locked out after 5 failures', async () => {
  const w = await world();
  const attacker = client(w.base);
  for (let i = 0; i < 5; i++) await attacker.post('/api/login', { username: 'layla', password: `guess${i}xx` });
  const locked = await attacker.post('/api/login', { username: 'layla', password: w.layla.password });
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
  await w.close();
});

test('new accounts must change their temporary password first', async () => {
  const w = await world();
  const r = await w.bank.post('/api/admin/users', { username: 'newkid', name: 'New Kid', role: 'student' });
  const kid = client(w.base);
  await kid.post('/api/login', { username: 'newkid', password: r.data.tempPassword });
  const blocked = await kid.get('/api/me/transactions');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.mustChange, true);
  assert.equal((await kid.post('/api/me/password', { current: r.data.tempPassword, next: 'weak' })).status, 400);
  assert.equal((await kid.post('/api/me/password', { current: r.data.tempPassword, next: 'strongpass9' })).status, 200);
  assert.equal((await kid.get('/api/me/transactions')).status, 200);
  await w.close();
});

test('deposit EGP → AISE$ at 10:1, then transfer, with exact balances', async () => {
  const w = await world();
  let r = await w.bank.post('/api/admin/deposit', { to: w.omar.accountNo, egp: '505.05' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.transaction.amount, 5050); // AISE$ 50.50
  assert.equal(r.data.changeEgpCents, 5); // 5 piastres back

  r = await w.omar.c.post('/api/transfer', { to: w.layla.accountNo, amount: '12.50', memo: 'Book', ref: 'ref-00000001' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.balance, 3800);

  // Same idempotency key again (double-tap): no second charge.
  r = await w.omar.c.post('/api/transfer', { to: w.layla.accountNo, amount: '12.50', memo: 'Book', ref: 'ref-00000001' });
  assert.equal(r.data.balance, 3800);

  assert.equal((await w.layla.c.get('/api/me')).data.user.balance, 1250);
  const hist = (await w.layla.c.get('/api/me/transactions')).data.transactions;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].delta, 1250);
  assert.equal(hist[0].from.name, 'Omar Hassan');

  const stats = (await w.bank.get('/api/admin/stats')).data.stats;
  assert.equal(stats.inCirculation, 5050);
  assert.equal(stats.egpReserve, 50500);
  await w.close();
});

test('overdrafts, self-transfers, bad amounts and frozen accounts are refused', async () => {
  const w = await world();
  await w.bank.post('/api/admin/deposit', { to: w.omar.accountNo, egp: '100' });
  const send = (body) => w.omar.c.post('/api/transfer', { to: w.layla.accountNo, ...body });
  assert.equal((await send({ amount: '10.01' })).status, 402);
  assert.equal((await send({ amount: '-5' })).status, 400);
  assert.equal((await send({ amount: '0.001' })).status, 400);
  assert.equal((await send({ amount: 1.5 })).status, 400, 'non-integer cents are rejected');
  assert.equal((await w.omar.c.post('/api/transfer', { to: w.omar.accountNo, amount: '1' })).status, 400);
  assert.equal((await w.omar.c.post('/api/transfer', { to: 'AISE-9999', amount: '1' })).status, 404);

  await w.bank.patch(`/api/admin/users/${w.layla.id}`, { frozen: true });
  assert.equal((await send({ amount: '1' })).status, 403);
  assert.equal((await w.layla.c.get('/api/me')).status, 401, 'freezing signs the user out');
  await w.close();
});

test('concurrent spends cannot overdraw (no double-spend)', async () => {
  const w = await world();
  await w.bank.post('/api/admin/deposit', { to: w.omar.accountNo, egp: '100' }); // AISE$ 10
  const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    w.omar.c.post('/api/transfer', { to: w.layla.accountNo, amount: '3', ref: `race-${String(i).padStart(4, '0')}` })));
  const ok = attempts.filter((r) => r.status === 200).length;
  assert.equal(ok, 3, 'only 3 × AISE$3 fit in AISE$10');
  assert.equal((await w.omar.c.get('/api/me')).data.user.balance, 100);
  await w.close();
});

test('QR payment request: pay once, merchant sees it, no double pay', async () => {
  const w = await world();
  await w.bank.post('/api/admin/deposit', { to: w.omar.accountNo, egp: '200' });
  await w.bank.post('/api/admin/deposit', { to: w.layla.accountNo, egp: '200' });

  let r = await w.canteen.c.post('/api/requests', { amount: '7.50', memo: 'Chicken wrap' });
  assert.equal(r.status, 200);
  const id = r.data.request.id;
  assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(r.data.request.status, 'open');

  // Two customers race to pay the same code.
  const [a, b] = await Promise.all([w.omar.c.post(`/api/requests/${id}/pay`), w.layla.c.post(`/api/requests/${id}/pay`)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);

  r = await w.canteen.c.get(`/api/requests/${id}`);
  assert.equal(r.data.request.status, 'paid');
  assert.equal((await w.canteen.c.get('/api/me')).data.user.balance, 750);
  assert.equal((await w.canteen.c.post(`/api/requests/${id}/pay`)).status, 409);

  // Merchant can't pay own request; cancelled requests can't be paid.
  r = await w.canteen.c.post('/api/requests', { amount: '1' });
  assert.equal((await w.canteen.c.post(`/api/requests/${r.data.request.id}/pay`)).status, 400);
  await w.canteen.c.post(`/api/requests/${r.data.request.id}/cancel`);
  assert.equal((await w.omar.c.post(`/api/requests/${r.data.request.id}/pay`)).status, 410);
  await w.close();
});

test('cash-out requires the holder password; bank-only routes are protected', async () => {
  const w = await world();
  await w.bank.post('/api/admin/deposit', { to: w.omar.accountNo, egp: '100' });
  assert.equal((await w.bank.post('/api/admin/withdraw', { from: w.omar.accountNo, amount: '5', holderPassword: 'nope' })).status, 401);
  const ok = await w.bank.post('/api/admin/withdraw', { from: w.omar.accountNo, amount: '5', holderPassword: w.omar.password });
  assert.equal(ok.status, 200);
  assert.equal((await w.omar.c.get('/api/me')).data.user.balance, 500);

  assert.equal((await w.omar.c.get('/api/admin/users')).status, 403);
  assert.equal((await w.omar.c.post('/api/admin/deposit', { to: w.omar.accountNo, egp: '1000' })).status, 403);

  const csv = await w.bank.get('/api/admin/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /"deposit"/);
  assert.match(csv.data, /"withdraw"/);
  await w.close();
});

test('CSRF: state-changing requests need the custom header and same origin', async () => {
  const w = await world();
  const noHeader = await w.omar.c.raw('POST', '/api/transfer', { to: w.layla.accountNo, amount: '1' }, { 'x-aise': '' });
  assert.equal(noHeader.status, 403);
  const evil = await w.omar.c.raw('POST', '/api/transfer', { to: w.layla.accountNo, amount: '1' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  await w.close();
});

test('bulk import creates accounts with temp passwords and reports bad rows', async () => {
  const w = await world();
  const r = await w.bank.post('/api/admin/users/import', { rows: [
    { name: 'Youssef Ali', username: 'youssef.ali', grade: '9A' },
    { name: 'Dup', username: 'omar' },
    { name: 'Mariam Adel', username: 'mariam.adel', role: 'staff' },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x) => x.ok), [true, false, true]);
  assert.match(r.data.results[1].error, /taken/);
  const login = await client(w.base).post('/api/login', { username: 'youssef.ali', password: r.data.results[0].tempPassword });
  assert.equal(login.status, 200);
  await w.close();
});

test('ledger is append-only at the database level', async () => {
  const w = await world();
  await w.bank.post('/api/admin/deposit', { to: w.omar.accountNo, egp: '100' });
  assert.throws(() => w.app.db.exec('UPDATE transactions SET amount = 999999'), /append-only/);
  assert.throws(() => w.app.db.exec('DELETE FROM transactions'), /append-only/);
  await w.close();
});

test('static files are served with security headers; unknown paths are not', async () => {
  const w = await world();
  const page = await fetch(`${w.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${w.base}/server/app.js`)).status, 404);
  assert.equal((await fetch(`${w.base}/../package.json`)).status, 404);
  await w.close();
});

test('behind a proxy, a spoofed X-Forwarded-For cannot dodge the IP lockout', async () => {
  const app = createApp({ setupCode: SETUP_CODE, log: silent, trustProxy: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const attempt = (i) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aise': '1', 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` },
    body: JSON.stringify({ username: `victim${i}`, password: 'guess1234' }),
  });
  for (let i = 0; i < 5; i++) assert.equal((await attempt(i)).status, 401);
  assert.equal((await attempt(99)).status, 429, 'same real IP (rightmost) is locked');
  await new Promise((r) => app.server.close(r));
});
