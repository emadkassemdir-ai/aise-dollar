'use strict';
/**
 * HTTP layer: static files, JSON API, auth, CSRF and security headers.
 * Built on node:http only — no framework, no dependencies to audit.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Money = require('../shared/money.js');
const db_ = require('./db.js');
const auth = require('./auth.js');
const { createBank, BankError } = require('./bank.js');

const ROOT = path.join(__dirname, '..');
const MAX_BODY = 64 * 1024;
const COOKIE = 'aise_session';

/** Only these files are ever served — no path traversal is possible. */
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/money.js': ['shared/money.js', 'text/javascript; charset=utf-8'],
  '/vendor/qrcode.js': ['public/vendor/qrcode.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
    "connect-src 'self'", "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    Object.assign(this, { status, extra });
  }
}

function createApp({
  dbFile = ':memory:',
  setupCode = process.env.AISE_SETUP_CODE || crypto.randomBytes(6).toString('hex'),
  trustProxy = process.env.TRUST_PROXY === '1',
  secureCookies = process.env.COOKIE_SECURE === '1',
  log = console,
} = {}) {
  const db = db_.open(dbFile);
  const bank = createBank(db);
  const throttle = new auth.Throttle();
  const needsSetup = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;

  const assets = Object.fromEntries(Object.entries(STATIC).map(([route, [file, type]]) => {
    const body = fs.readFileSync(path.join(ROOT, file));
    const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
    return [route, { body, type, etag }];
  }));

  // ------------------------------------------------------------- helpers ---

  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
    req.socket.remoteAddress || 'unknown';

  const isSecure = (req) => secureCookies || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
  }

  const cookieName = (req) => (isSecure(req) ? `__Host-${COOKIE}` : COOKIE);

  function setSessionCookie(req, res, token) {
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', isSecure(req) && 'Secure',
      token ? 'Max-Age=43200' : 'Max-Age=0'].filter(Boolean);
    res.setHeader('Set-Cookie', `${cookieName(req)}=${token || ''}; ${attrs.join('; ')}`);
  }

  function send(res, status, body, headers = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(json), ...headers,
    });
    res.end(json);
  }

  async function readJson(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Expected application/json.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch {
      throw new HttpError(400, 'Malformed JSON.');
    }
  }

  /**
   * CSRF defence in depth: SameSite=Strict cookies, plus every state-changing
   * request must carry a custom header (impossible cross-site without a CORS
   * preflight, which we never grant) and, if present, a same-origin Origin.
   */
  function assertSameOrigin(req) {
    if (req.headers['x-aise'] !== '1') throw new HttpError(403, 'Missing request header.');
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
    }
  }

  const amountFrom = (value) => (typeof value === 'number' ? Money.assertAmount(value) : Money.parseAmount(value));

  // --------------------------------------------------------------- routes ---

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, regex, keys, handler, auth: opts.auth ?? true, role: opts.role, allowMustChange: opts.allowMustChange });
  };

  const meView = (user) => ({ ...user, balance: bank.balanceOf(user.id) });

  // Setup: create the first Bank Office account using the one-time setup code.
  route('GET', '/api/setup', () => ({ needed: needsSetup() }), { auth: false });
  route('POST', '/api/setup', async ({ req, res, body }) => {
    if (!needsSetup()) throw new HttpError(409, 'Setup is already complete.');
    const given = Buffer.from(String(body.code || '').trim());
    const expected = Buffer.from(setupCode);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new HttpError(403, 'Wrong setup code. It is printed in the server log on first start.');
    }
    auth.validatePassword(body.password);
    const user = bank.createUser({
      name: body.name, username: body.username, role: 'banker',
      passwordHash: await auth.hashPassword(body.password), mustChange: false,
    });
    setSessionCookie(req, res, auth.createSession(db, user.id));
    log.info?.(`Setup complete: Bank Office account "${user.username}" created.`);
    return { user: meView(user) };
  }, { auth: false });

  route('POST', '/api/login', async ({ req, res, body, ip }) => {
    const username = String(body.username || '').trim().toLowerCase().slice(0, 40);
    const keys = [`ip:${ip}`, `user:${username}`];
    throttle.check(keys);
    const row = username && bank.userByUsername(username);
    const ok = row ? await auth.verifyPassword(String(body.password ?? ''), row.password_hash)
      : (await auth.burnTime(body.password), false);
    if (!ok) {
      throttle.fail(keys);
      throw new HttpError(401, 'Wrong username or password.');
    }
    throttle.succeed(keys);
    if (row.frozen) throw new HttpError(403, 'This account is frozen. Visit the Bank Office.');
    setSessionCookie(req, res, auth.createSession(db, row.id));
    return { user: meView(bank.publicUser(row)) };
  }, { auth: false });

  route('POST', '/api/logout', ({ req, res, token }) => {
    auth.destroySession(db, token);
    setSessionCookie(req, res, null);
    return { ok: true };
  }, { auth: false });

  route('GET', '/api/me', ({ user }) => ({ user: meView(user) }), { allowMustChange: true });

  route('POST', '/api/me/password', async ({ user, body, token, ip }) => {
    const keys = [`ip:${ip}`, `user:${user.username}`];
    throttle.check(keys);
    const row = bank.userById(user.id);
    if (!(await auth.verifyPassword(String(body.current ?? ''), row.password_hash))) {
      throttle.fail(keys);
      throw new HttpError(401, 'Current password is wrong.');
    }
    throttle.succeed(keys);
    auth.validatePassword(body.next);
    if (body.next === body.current) throw new HttpError(400, 'Choose a different password.');
    bank.setPassword(user.id, await auth.hashPassword(body.next), false);
    auth.destroyUserSessions(db, user.id, token); // sign out every other device
    return { ok: true };
  }, { allowMustChange: true });

  route('GET', '/api/me/transactions', ({ user, query }) =>
    ({ transactions: bank.history(user.id, { limit: query.get('limit'), before: query.get('before') }) }));

  route('GET', '/api/directory', () => ({ accounts: bank.directory() }));

  route('GET', '/api/accounts/:accountNo', ({ params }) => {
    const u = bank.findByAccountNo(params.accountNo);
    return { account: { accountNo: u.account_no, name: u.name, role: u.role, frozen: Boolean(u.frozen) } };
  });

  route('POST', '/api/transfer', ({ user, body }) => {
    const tx = bank.transfer({
      fromId: user.id, toAccountNo: body.to, amount: amountFrom(body.amount), memo: body.memo, ref: body.ref,
    });
    return { transaction: bank.publicTx(rowWithNames(tx), user.id), balance: bank.balanceOf(user.id) };
  });

  route('POST', '/api/requests', ({ user, body }) =>
    ({ request: bank.createRequest({ merchantId: user.id, amount: amountFrom(body.amount), memo: body.memo }) }));
  route('GET', '/api/requests/:id', ({ params }) => ({ request: bank.getRequest(params.id) }));
  route('POST', '/api/requests/:id/pay', ({ user, params }) => {
    const { request } = bank.payRequest({ requestId: params.id, payerId: user.id });
    return { request, balance: bank.balanceOf(user.id) };
  });
  route('POST', '/api/requests/:id/cancel', ({ user, params }) =>
    ({ request: bank.cancelRequest({ requestId: params.id, userId: user.id }) }));

  // ---- Bank Office (banker role only) ----
  const banker = { role: 'banker' };

  route('GET', '/api/admin/stats', () => ({ stats: bank.stats() }), banker);
  route('GET', '/api/admin/users', () => ({ users: bank.listUsers() }), banker);

  route('POST', '/api/admin/users', async ({ body }) => {
    const tempPassword = auth.temporaryPassword();
    const user = bank.createUser({
      name: body.name, username: body.username, role: body.role, grade: body.grade,
      passwordHash: await auth.hashPassword(tempPassword),
    });
    return { user, tempPassword };
  }, banker);

  route('POST', '/api/admin/users/import', async ({ body }) => {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new HttpError(400, 'No rows to import.');
    if (rows.length > 200) throw new HttpError(400, 'Import at most 200 accounts at a time.');
    const results = [];
    for (const r of rows) {
      try {
        const tempPassword = auth.temporaryPassword();
        const user = bank.createUser({ ...r, role: r.role || 'student', passwordHash: await auth.hashPassword(tempPassword) });
        results.push({ ok: true, name: user.name, username: user.username, accountNo: user.accountNo, tempPassword });
      } catch (err) {
        if (!(err instanceof BankError)) throw err;
        results.push({ ok: false, name: String(r?.name ?? ''), username: String(r?.username ?? ''), error: err.message });
      }
    }
    return { results };
  }, banker);

  route('PATCH', '/api/admin/users/:id', ({ user, params, body }) => {
    const id = Number(params.id);
    if (id === user.id && (body.frozen || (body.role && body.role !== 'banker'))) {
      throw new HttpError(400, "You can't freeze or demote your own account.");
    }
    const updated = bank.updateUser(id, body);
    if (updated.frozen) auth.destroyUserSessions(db, id);
    return { user: updated };
  }, banker);

  route('POST', '/api/admin/users/:id/reset-password', async ({ params }) => {
    const id = Number(params.id);
    if (!bank.userById(id)) throw new HttpError(404, 'Account not found.');
    const tempPassword = auth.temporaryPassword();
    bank.setPassword(id, await auth.hashPassword(tempPassword), true);
    auth.destroyUserSessions(db, id);
    return { tempPassword };
  }, banker);

  route('POST', '/api/admin/deposit', ({ user, body }) => {
    const target = bank.findByAccountNo(body.to);
    const { aiseCents, changeEgpCents } = Money.egpToAise(Money.parseAmount(body.egp));
    if (aiseCents <= 0) throw new HttpError(400, 'Minimum deposit is EGP 0.10.');
    const tx = bank.deposit({ actorId: user.id, toId: target.id, amount: aiseCents, memo: body.memo, ref: body.ref });
    return { transaction: bank.publicTx(rowWithNames(tx)), changeEgpCents };
  }, banker);

  /** Cash-out needs the holder's own password, typed by them at the counter,
   *  so a Bank Office account alone can't drain someone's wallet. */
  route('POST', '/api/admin/withdraw', async ({ user, body, ip }) => {
    const target = bank.findByAccountNo(body.from);
    const keys = [`ip:${ip}`, `user:${target.username}`];
    throttle.check(keys);
    if (!(await auth.verifyPassword(String(body.holderPassword ?? ''), target.password_hash))) {
      throttle.fail(keys);
      throw new HttpError(401, "The account holder's password is wrong.");
    }
    throttle.succeed(keys);
    const tx = bank.withdraw({ actorId: user.id, fromId: target.id, amount: amountFrom(body.amount), memo: body.memo, ref: body.ref });
    return { transaction: bank.publicTx(rowWithNames(tx)) };
  }, banker);

  route('GET', '/api/admin/transactions', ({ query }) =>
    ({ transactions: bank.ledger({ limit: query.get('limit'), before: query.get('before') }) }), banker);

  route('GET', '/api/admin/export.csv', ({ res }) => {
    // Quote every cell; prefix =+-@ so spreadsheet apps can't execute formulas.
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`;
    const lines = [['Id', 'Date (UTC)', 'Type', 'From', 'To', 'AISE$', 'EGP', 'Note', 'Entered by'].map(cell).join(',')];
    for (const t of bank.ledgerRows()) {
      lines.push([t.id, t.created_at, t.type, t.from_name ? `${t.from_name} (${t.from_account})` : 'BANK',
        t.to_name ? `${t.to_name} (${t.to_account})` : 'BANK', Money.plainCents(t.amount),
        Money.plainCents(Money.toEgpCents(t.amount)), t.memo, t.actor_name].map(cell).join(','));
    }
    const csv = `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel reads Arabic names correctly
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="aise-ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.end(csv);
  }, banker);

  route('GET', '/api/health', () => ({ ok: true }), { auth: false });

  /** Bank returns a bare row; re-read it with names joined for the response. */
  function rowWithNames(tx) {
    return db.prepare(`
      SELECT t.*, f.name AS from_name, f.account_no AS from_account,
             r.name AS to_name, r.account_no AS to_account, a.name AS actor_name
      FROM transactions t LEFT JOIN users f ON f.id = t.from_id
      LEFT JOIN users r ON r.id = t.to_id JOIN users a ON a.id = t.actor_id
      WHERE t.id = ?`).get(tx.id);
  }

  // -------------------------------------------------------------- dispatch ---

  async function handleApi(req, res, url) {
    const match = routes
      .map((r) => ({ r, m: r.regex.exec(url.pathname) }))
      .filter(({ m }) => m);
    if (!match.length) throw new HttpError(404, 'Not found.');
    const found = match.find(({ r }) => r.method === req.method);
    if (!found) throw new HttpError(405, 'Method not allowed.');
    const { r, m } = found;

    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating) assertSameOrigin(req);

    const token = readCookie(req, cookieName(req));
    const user = auth.readSession(db, token);
    if (r.auth && !user) throw new HttpError(401, 'Please sign in.', { signedOut: true });
    if (user?.mustChange && r.auth && !r.allowMustChange) {
      throw new HttpError(403, 'Please choose a new password first.', { mustChange: true });
    }
    if (r.role && user?.role !== r.role) throw new HttpError(403, 'Bank Office access only.');

    let params;
    try {
      params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    } catch {
      throw new HttpError(400, 'Malformed URL.');
    }
    const body = mutating ? await readJson(req) : {};
    const result = await r.handler({ req, res, url, user, token, params, body, query: url.searchParams, ip: clientIp(req) });
    if (!res.headersSent) send(res, 200, result);
  }

  function serveStatic(req, res, url) {
    const asset = assets[url.pathname] || (!url.pathname.includes('.') && assets['/']);
    if (!asset || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, { ETag: asset.etag });
      return res.end();
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': asset.type, 'Content-Length': asset.body.length,
      'Cache-Control': 'no-cache', ETag: asset.etag,
    });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      const known = err instanceof HttpError || err instanceof BankError ||
        err instanceof auth.AuthError || err instanceof Money.MoneyError;
      const status = known ? err.status || 400 : 500;
      if (!known) log.error?.(err);
      if (!res.headersSent) send(res, status, { error: known ? err.message : 'Something went wrong.', ...err.extra });
      else res.end();
    } finally {
      if (url?.pathname.startsWith('/api/')) {
        log.info?.(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  const pruner = setInterval(() => auth.pruneSessions(db), 10 * 60 * 1000).unref();
  server.on('close', () => {
    clearInterval(pruner);
    db.close();
  });

  return { server, db, bank, setupCode, needsSetup };
}

module.exports = { createApp };
