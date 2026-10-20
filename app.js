/**
 * AISE Dollar — the website (UI only).
 *
 * All data access lives in bank.js. All DOM is built with `h()`, which adds
 * user text as text nodes, so names and notes can never become HTML.
 */
import * as B from './bank.js';

const M = window.Money;
const app = document.getElementById('app');

// ================================================================ utils ===

/** h('div.card#id', {props}, ...children) → HTMLElement */
function h(tag, props, ...children) {
  const [, name = 'div', rest = ''] = /^([a-z0-9]+)?(.*)$/i.exec(tag);
  const el = document.createElement(name);
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const field = (label, input, hint) =>
  h('label.field', h('span.label', label), input, hint && (hint instanceof Node ? hint : h('span.hint', hint)));

let toastTimer;
function notify(message, kind = 'ok') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.className = ''), 4500);
}

const fmtDate = (d) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const fmtTime = (d) => d.toLocaleTimeString('en-GB', { timeStyle: 'short' });
/** "Omar Hassan" → "Omar", but "Ms. Nadia" stays "Ms. Nadia". */
const firstName = (name) => (/^(mr|mrs|ms|miss|dr|mx)\.?$/i.test(name.split(' ')[0]) ? name : name.split(' ')[0]);

function money(cents, cls = '') {
  return h(`div.money${cls}`, h('span.aise', M.formatAise(cents)), h('span.egp', `≈ ${M.formatEgp(cents)}`));
}

/** Amount input showing its EGP value live underneath. */
function amountInput({ name = 'amount', value = '', label = 'Amount (AISE$)', autofocus = false } = {}) {
  const hint = h('span.hint', '≈ EGP 0.00');
  const input = h('input', { name, value, inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off', autofocus, oninput: update });
  function update() {
    try { hint.textContent = `≈ ${M.formatEgp(M.parseAmount(input.value))}`; }
    catch { hint.textContent = input.value ? 'Enter an amount like 12.50' : '≈ EGP 0.00'; }
  }
  if (value) update();
  return field(label, input, hint);
}

const passwordInput = (name, autocomplete) =>
  h('input', { name, type: 'password', required: true, autocomplete, autocapitalize: 'none', spellcheck: false });

/** Form submit wrapper: no reload, buttons disabled while busy, errors shown. */
function onSubmit(handler) {
  return async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await handler(new FormData(form), form);
    } catch (err) {
      if (!(err instanceof B.BankError || err instanceof M.MoneyError)) console.error(err);
      notify(err.message, 'error');
    } finally {
      buttons.forEach((b) => b.isConnected && (b.disabled = false));
    }
  };
}

function sessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private mode */ } }
function sessionTake(key) {
  try { const v = sessionStorage.getItem(key); sessionStorage.removeItem(key); return v; } catch { return null; }
}

// ================================================================ state ===

const state = { user: null, directory: null, refreshBankStats: null };

async function refreshMe() {
  state.user = await B.me();
  renderChrome();
  return state.user;
}

async function directory(force = false) {
  if (!state.directory || force) state.directory = await B.directory();
  return state.directory;
}

/** Transactions store account numbers; show names from the directory. */
async function nameOf() {
  const dir = await directory();
  const map = new Map(dir.map((a) => [a.accountNo, a.name]));
  return (acct) => map.get(acct) || acct;
}

// =============================================================== router ===

let cleanups = [];
const onLeave = (fn) => cleanups.push(fn);
const go = (hash) => (location.hash === hash ? route() : (location.hash = hash));

const routes = [
  [/^#\/setup$/, viewSetup, { public: true }],
  [/^#\/login$/, viewLogin, { public: true }],
  [/^#\/password$/, viewPassword, { allowMustChange: true }],
  [/^#\/$/, viewWallet],
  [/^#\/send$/, viewSend],
  [/^#\/receive$/, viewReceive],
  [/^#\/pay\/([a-f0-9]+)$/, viewPay],
  [/^#\/till$/, viewTill],
  [/^#\/scan$/, viewScan],
  [/^#\/convert$/, viewConvert, { public: true }],
  [/^#\/bank(?:\/(\w+))?$/, viewBank, { role: 'banker' }],
];

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  cleanups.forEach((fn) => fn());
  cleanups = [];
  if (!B.configured) return app.replaceChildren(viewNotConfigured());

  const [path, search = ''] = (location.hash || '#/').split('?');
  const params = new URLSearchParams(search);
  const [re, view, opts = {}] = routes.find(([r]) => r.test(path)) || routes[3];
  const match = re.exec(path) || [];

  try {
    await B.ready();
    if (!state.user && B.signedIn()) {
      await refreshMe().catch((err) => { state.user = null; notify(err.message, 'error'); });
    }
    if (state.user?.needsSetup && path !== '#/setup') return go('#/setup');
    if (!opts.public) {
      if (!state.user) {
        if (seq !== routeSeq) return;
        sessionSet('returnTo', location.hash);
        return go((await B.needsSetup()) ? '#/setup' : '#/login');
      }
      if (state.user.mustChange && !opts.allowMustChange) return go('#/password');
      if (opts.role && state.user.role !== opts.role) return go('#/');
    }
    const el = await view({ params, match });
    if (seq !== routeSeq) return; // a newer navigation won
    app.replaceChildren(el);
    renderChrome();
    window.scrollTo(0, 0);
  } catch (err) {
    if (seq !== routeSeq) return;
    console.error(err);
    app.replaceChildren(h('section.card.narrow',
      h('h2', 'Something went wrong'), h('p.muted', err.message),
      h('button', { onclick: () => route() }, 'Try again')));
  }
}

function renderChrome() {
  const u = state.user?.needsSetup ? null : state.user;
  const signedIn = u && !u.mustChange;
  const hash = (location.hash || '#/').split('?')[0];
  const tabs = [
    signedIn && ['#/', 'Wallet', ['#/', '#/send', '#/receive', '#/scan']],
    signedIn && ['#/till', u.role === 'merchant' ? 'Till' : 'Request'],
    ['#/convert', 'Converter'],
    signedIn && u.role === 'banker' && ['#/bank', 'Bank Office'],
  ].filter(Boolean);
  document.getElementById('nav').replaceChildren(...tabs.map(([href, label, also]) => {
    const active = hash === href || (also || []).includes(hash) || (href === '#/bank' && hash.startsWith('#/bank')) ||
      (href === '#/' && hash.startsWith('#/pay/'));
    return h('a', { href, 'aria-current': active ? 'page' : null }, label);
  }));
  document.getElementById('user-area').replaceChildren(u
    ? h('div.user-chip', h('span.user-name', firstName(u.name)), h('button.ghost.small', { onclick: logout }, 'Sign out'))
    : '');
}

async function logout() {
  await B.logout();
  Object.assign(state, { user: null, directory: null });
  renderChrome();
  go('#/login');
}

// ========================================================== auth views ===

function viewNotConfigured() {
  return h('section.card.narrow',
    h('h2', 'Almost there!'),
    h('p', 'AISE Dollar needs its Firebase database connected before anyone can sign in.'),
    h('p.muted', 'Follow “Connect Firebase” in the README, then paste the config into firebase-config.js.'));
}

/** "Sign in with Google". signInWithGoogle runs first in the tap so Safari allows the popup. */
function googleButton(label = 'Sign in with Google') {
  const button = h('button.google-btn', {
    type: 'button',
    onclick: async () => {
      button.disabled = true;
      try {
        await B.signInWithGoogle();
        state.user = null;
        await refreshMe();
        if (state.user?.needsSetup) return go('#/setup');
        notify(`Welcome, ${firstName(state.user.name)}!`);
        go(sessionTake('returnTo') || '#/');
      } catch (err) {
        state.user = null;
        renderChrome();
        notify(err.message, 'error');
      } finally {
        button.disabled = false;
      }
    },
  }, h('span.g-logo', { 'aria-hidden': 'true' }, 'G'), label);
  return button;
}

async function viewSetup() {
  if (!(await B.needsSetup())) { go('#/login'); return h('div'); }
  if (!state.user?.needsSetup) {
    return h('section.card.narrow.login',
      h('div.login-coin', { 'aria-hidden': 'true' }, 'A$'),
      h('h2', 'Set up AISE Dollar'),
      h('p.muted', 'Sign in with your school Google account. You’ll become the Bank Office and add your class from there.'),
      googleButton('Sign in with Google to start'));
  }
  return h('section.card.narrow',
    h('h2', 'Set up AISE Dollar'),
    h('p.muted', `Signed in as ${state.user.email}. This account becomes the Bank Office.`),
    h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        await B.setup({ name: fd.get('name') });
        state.user = null;
        await refreshMe();
        notify('Bank Office ready! Now add your class.');
        go('#/bank/accounts');
      }),
    },
      field('Your name (as students will see it)', h('input', { name: 'name', required: true, autocomplete: 'name', placeholder: 'e.g. Ms. Nadia' })),
      h('button.primary', { type: 'submit' }, 'Create Bank Office')));
}

function viewLogin() {
  if (state.user) { go('#/'); return h('div'); }
  return h('section.card.narrow.login',
    h('div.login-coin', { 'aria-hidden': 'true' }, 'A$'),
    h('h2', 'Sign in'),
    h('p.muted', 'Use your school email.'),
    googleButton(),
    h('details.username-login',
      h('summary', 'No school email? Use a username'),
      h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        state.user = await B.login(fd.get('username'), fd.get('password'));
        if (state.user.mustChange) return go('#/password');
        notify(`Welcome, ${firstName(state.user.name)}!`);
        go(sessionTake('returnTo') || '#/');
      }),
    },
      field('Username', h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false })),
      field('Password', passwordInput('password', 'current-password')),
      h('button.primary', { type: 'submit' }, 'Sign in')),
      h('p.muted.small-print', 'Forgot your password? Ask the Bank Office for a new slip.')));
}

function viewPassword() {
  const forced = state.user?.mustChange;
  return h('section.card.narrow',
    h('h2', forced ? 'Make your own password' : 'Change password'),
    forced && h('p.muted', 'You signed in with the password on your slip. Now pick a new one that only you know.'),
    h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        if (fd.get('next') !== fd.get('next2')) throw new B.BankError('New passwords do not match.');
        await B.changePassword(fd.get('current'), fd.get('next'));
        await refreshMe();
        notify('Password saved!');
        go(sessionTake('returnTo') || '#/');
      }),
    },
      field(forced ? 'Password from your slip' : 'Current password', passwordInput('current', 'current-password')),
      field('New password', passwordInput('next', 'new-password'), 'At least 6 characters with a letter and a number.'),
      field('Type it again', passwordInput('next2', 'new-password')),
      h('button.primary', { type: 'submit' }, 'Save password')));
}

// ========================================================== wallet views ===

function txItem(tx, name) {
  const signed = tx.delta !== undefined;
  const value = signed ? tx.delta : tx.amount;
  let title;
  if (tx.type === 'deposit') title = signed ? 'Cash deposit' : `Cash deposit → ${name(tx.to)}`;
  else if (tx.type === 'withdraw') title = signed ? 'Cashed out to EGP' : `${name(tx.from)} cashed out`;
  else if (!signed) title = `${name(tx.from)} → ${name(tx.to)}`;
  else title = value > 0 ? `From ${name(tx.from)}` : `To ${name(tx.to)}`;
  return h('li',
    h(`span.badge.${tx.type}`, tx.viaQr ? 'QR' : tx.type),
    h('div.tx-main', h('strong', title), tx.memo && h('span.memo', tx.memo)),
    h('div.tx-side',
      h(`span.amt${signed ? (value > 0 ? '.in' : '.out') : ''}`, `${signed && value > 0 ? '+' : ''}${M.formatCents(value)}`),
      h('time', { dateTime: tx.at.toISOString() }, fmtDate(tx.at))));
}

/** A transaction list with "Load more" paging. */
function txFeed(loadPage, { pageSize = 25, empty = 'No transactions yet.' } = {}) {
  const list = h('ul.txs');
  const more = h('button.ghost.more', { hidden: true, onclick: load }, 'Load more');
  let last = null;
  async function load() {
    more.disabled = true;
    try {
      const [page, name] = await Promise.all([loadPage({ pageSize, after: last }), nameOf()]);
      list.append(...page.map((t) => txItem(t, name)));
      if (page.length) last = page[page.length - 1];
      more.hidden = page.length < pageSize;
      if (!list.children.length) list.replaceWith(h('p.empty', empty));
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      more.disabled = false;
    }
  }
  load();
  return h('div', list, more);
}

async function viewWallet() {
  const u = await refreshMe();
  const actions = [
    ['#/send', 'Send', '↗'],
    ['#/receive', 'Receive', '↙'],
    ['#/scan', 'Scan to pay', '⌗'],
    ['#/till', u.role === 'merchant' ? 'Open till' : 'Request', '▦'],
  ];
  return h('div.grid',
    h('section.card.balance-card',
      h('div.row',
        h('div', h('p.muted', `${B.ROLES[u.role]} · ${u.accountNo}${u.grade ? ` · ${u.grade}` : ''}`), h('h2', u.name)),
        h('a.ghost-link', { href: '#/password' }, 'Password')),
      h('p.muted', 'My balance'),
      money(u.balance, '.big'),
      u.frozen && h('p.warn', 'This account is frozen. Visit the Bank Office.'),
      h('div.actions-row', actions.map(([href, label, icon]) =>
        h('a.action', { href }, h('span.action-icon', { 'aria-hidden': 'true' }, icon), label)))),
    h('section.card.span',
      h('h3', 'History'),
      txFeed((opts) => B.history(u.accountNo, opts))));
}

/** Pick a person: type a name or account number, with autocomplete. */
function recipientPicker(accounts, { initial = '', exclude = state.user.accountNo, label = 'To' } = {}) {
  const listId = `dir-${Math.random().toString(36).slice(2)}`;
  const resolved = h('span.hint', 'Type a name or account number.');
  const input = h('input', {
    name: 'to', required: true, autocomplete: 'off', list: listId, value: initial,
    placeholder: 'e.g. Layla or AISE-1002', oninput: update,
  });
  const dl = h('datalist', { id: listId },
    accounts.filter((a) => a.accountNo !== exclude).map((a) => h('option', { value: `${a.name} — ${a.accountNo}` })));
  function find() {
    const v = input.value.trim();
    const no = /AISE-\d+/i.exec(v)?.[0]?.toUpperCase();
    const hits = no ? accounts.filter((a) => a.accountNo === no)
      : accounts.filter((a) => a.name.toLowerCase() === v.toLowerCase());
    return hits.length === 1 && hits[0].accountNo !== exclude ? hits[0] : null;
  }
  function update() {
    const a = find();
    resolved.textContent = a ? `✓ ${a.name} · ${B.ROLES[a.role]}${a.grade ? ` · ${a.grade}` : ''}` : 'Type a name or account number.';
    resolved.classList.toggle('ok', Boolean(a));
  }
  if (initial) update();
  return { el: h('label.field', h('span.label', label), input, dl, resolved), find };
}

async function viewSend({ params }) {
  const [accounts] = await Promise.all([directory(true), refreshMe()]);
  const usable = accounts.filter((a) => !a.frozen);
  const initialTo = (params.get('to') || '').toUpperCase();
  const preset = usable.find((a) => a.accountNo === initialTo);
  const picker = recipientPicker(usable, { initial: preset ? `${preset.name} — ${preset.accountNo}` : initialTo });
  let txId = B.newTxId(); // one id per send: a retry can never pay twice

  const formCard = h('section.card.narrow',
    h('h2', 'Send AISE$'),
    h('p.muted', `You have ${M.formatAise(state.user.balance)}`),
    h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        const to = picker.find();
        if (!to) throw new B.BankError('Pick who to send to from the list.');
        const amount = M.parseAmount(fd.get('amount'));
        if (amount > state.user.balance) throw new B.BankError(`You only have ${M.formatAise(state.user.balance)}.`);
        formCard.replaceWith(confirmCard(to, amount, String(fd.get('memo') || '')));
      }),
    },
      picker.el,
      amountInput({ value: params.get('amount') || '', autofocus: Boolean(preset) }),
      field('Note (optional)', h('input', { name: 'memo', maxLength: 140, value: params.get('memo') || '', placeholder: 'e.g. Snack, book, club' })),
      h('button.primary', { type: 'submit' }, 'Review')));

  function confirmCard(to, amount, memo) {
    const card = h('section.card.narrow.confirm',
      h('p.muted', 'You are sending'),
      money(amount, '.big'),
      h('p', 'to ', h('strong', to.name), ` (${to.accountNo})`),
      memo && h('p.memo-line', `“${memo}”`),
      h('form.row', {
        onsubmit: onSubmit(async () => {
          const balance = await B.transfer({ from: state.user.accountNo, to: to.accountNo, amount, memo, txId });
          txId = B.newTxId();
          state.user.balance = balance;
          card.replaceWith(successCard(`Sent ${M.formatAise(amount)} to ${to.name}`, balance));
        }),
      },
        h('button', { type: 'button', onclick: () => card.replaceWith(formCard) }, 'Back'),
        h('button.primary', { type: 'submit' }, 'Send it')));
    return card;
  }

  return h('div', formCard);
}

function successCard(title, balance) {
  return h('section.card.narrow.success',
    h('div.check', { 'aria-hidden': 'true' }, '✓'),
    h('h2', title),
    balance !== undefined && h('p.muted', `You now have ${M.formatAise(balance)} (${M.formatEgp(balance)})`),
    h('div.row.center-row',
      h('a.button', { href: '#/' }, 'Back to wallet'),
      // go() re-renders even when we're already on #/send (a plain link would do nothing).
      h('a.button.primary', { href: '#/send', onclick: (e) => { e.preventDefault(); go('#/send'); } }, 'Send again')));
}

// ================================================================== QR ===

/** Draw a QR code on a canvas. Error correction M survives smudged screens. */
function qrCanvas(text, size = 260) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const scale = Math.max(2, Math.floor(size / (count + quiet * 2)));
  const px = (count + quiet * 2) * scale;
  const canvas = h('canvas.qr', { width: px, height: px, role: 'img', 'aria-label': 'QR code' });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#0b2a5b';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }
  return canvas;
}

/** Full link to a page of this site, e.g. https://…github.io/repo/#/pay/abc */
const appUrl = (hash) => `${location.origin}${location.pathname}${location.search}${hash}`;

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    notify('Link copied.');
  } catch {
    prompt('Copy this link:', text);
  }
}

function viewReceive() {
  const u = state.user;
  const link = appUrl(`#/send?to=${encodeURIComponent(u.accountNo)}`);
  return h('div.grid',
    h('section.card.center',
      h('h2', 'Get paid'),
      h('p.muted', 'Let your friend scan this with their iPad camera, or tell them your account number.'),
      h('div.qr-wrap', qrCanvas(link)),
      h('p.account-big', u.accountNo),
      h('p', u.name),
      h('button', { onclick: () => copy(link) }, 'Copy my payment link')),
    h('section.card.center',
      h('h3', 'Need an exact amount?'),
      h('p.muted', 'Make a one-time code. It closes by itself once paid.'),
      h('a.button.primary', { href: '#/till' }, 'Request a payment')));
}

// =================================================================== till ===

/** Point of sale: amount → one-time QR → customer pays → till turns green. */
function viewTill() {
  const u = state.user;
  const container = h('div.till');
  let unwatch = null;
  let tick = null;
  const stop = () => { unwatch?.(); clearInterval(tick); unwatch = tick = null; };
  onLeave(stop);
  const QUICK = [1, 2, 5, 10, 20, 50];

  function entry() {
    stop();
    const amount = amountInput({ label: 'Price (AISE$)', autofocus: true });
    const input = amount.querySelector('input');
    container.replaceChildren(h('section.card.narrow',
      h('h2', u.role === 'merchant' ? `${u.name} till` : 'Request a payment'),
      h('p.muted', 'Type the price, then show the QR code to the customer.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          const cents = M.parseAmount(fd.get('amount'));
          const memo = String(fd.get('memo') || '');
          const id = await B.createRequest({ merchant: u.accountNo, merchantName: u.name, amount: cents, memo });
          showCode(id, cents, memo);
        }),
      },
        amount,
        h('div.quick', QUICK.map((n) => h('button', {
          type: 'button', onclick: () => { input.value = String(n); input.dispatchEvent(new Event('input')); },
        }, `${n}`))),
        field('What is it for? (optional)', h('input', { name: 'memo', maxLength: 140, placeholder: 'e.g. Juice + cookie' })),
        h('button.primary.big-btn', { type: 'submit' }, 'Show payment code'))),
      todaysSales());
  }

  function showCode(id, cents, memo) {
    const link = appUrl(`#/pay/${id}`);
    const status = h('p.status.waiting', 'Waiting for payment…');
    const timer = h('span.muted');
    container.replaceChildren(h('section.card.center.till-code',
      h('p.muted', `Pay ${u.name}`),
      money(cents, '.big'),
      memo && h('p.memo-line', memo),
      h('div.qr-wrap', qrCanvas(link, 300)),
      h('p.muted', 'Scan with your iPad camera'),
      status, timer,
      h('div.row.center-row',
        h('button', { onclick: cancel }, 'Cancel'),
        h('button.ghost', { onclick: () => copy(link) }, 'Copy link'))));

    async function cancel() {
      stop();
      await B.cancelRequest(id).catch(() => {});
      entry();
    }

    let expiresAt = Date.now() + B.REQUEST_TTL_MS;
    tick = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      timer.textContent = `Code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (!left) {
        stop();
        status.textContent = 'This code expired.';
        status.className = 'status failed';
      }
    }, 500);
    unwatch = B.watchRequest(id, (r) => {
      if (!r) return;
      expiresAt = r.expiresAt;
      if (r.status === 'paid') paid(r);
      else if (r.status === 'cancelled') { status.textContent = 'Cancelled.'; status.className = 'status failed'; }
    });
  }

  function paid(r) {
    stop();
    chime();
    container.replaceChildren(h('section.card.center.success.till-paid',
      h('div.check', { 'aria-hidden': 'true' }, '✓'),
      h('h2', 'Paid!'),
      money(r.amount, '.big'),
      h('p', 'by ', h('strong', r.paidByName)),
      r.memo && h('p.memo-line', r.memo),
      h('button.primary.big-btn', { onclick: () => entry(), autofocus: true }, 'Next customer')));
  }

  entry();
  return container;
}

/** Short two-note "ka-ching" so cashiers notice payments without looking. */
function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.12;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
    setTimeout(() => ctx.close(), 800);
  } catch { /* sound is optional */ }
}

function todaysSales() {
  const body = h('div', h('p.muted', 'Loading…'));
  Promise.all([B.history(state.user.accountNo, { pageSize: 200 }), nameOf()]).then(([txs, name]) => {
    const today = new Date().toDateString();
    const sales = txs.filter((t) => t.delta > 0 && t.type === 'transfer' && t.at.toDateString() === today);
    const total = sales.reduce((s, t) => s + t.amount, 0);
    body.replaceChildren(
      h('div.row', h('strong', `${sales.length} payment${sales.length === 1 ? '' : 's'} today`), h('strong', M.formatAise(total))),
      sales.length ? h('ul.txs.compact', sales.slice(0, 10).map((t) =>
        h('li', h('span.muted', fmtTime(t.at)), h('div.tx-main', h('strong', name(t.from)), t.memo && h('span.memo', t.memo)),
          h('span.amt.in', `+${M.formatCents(t.amount)}`)))) : h('p.empty', 'No payments yet today.'));
  }).catch(() => body.replaceChildren(h('p.muted', 'Could not load sales.')));
  return h('section.card.narrow', h('h3', 'Today'), body);
}

// ================================================================= pay ===

async function viewPay({ match }) {
  const id = match[1];
  const [request] = await Promise.all([B.getRequest(id), refreshMe()]);
  if (!request || request.status !== 'open') {
    const text = !request ? 'This payment code does not exist.'
      : { paid: `Already paid${request.paidByName ? ` by ${request.paidByName}` : ''}.`, cancelled: 'This code was cancelled.', expired: 'This code expired. Ask for a new one.' }[request.status];
    return h('section.card.narrow.center', h('h2', 'Can’t pay this code'), h('p.muted', text), h('a.button', { href: '#/' }, 'Back to wallet'));
  }
  const short = request.amount > state.user.balance;
  const container = h('div');
  let txId = B.newTxId();
  container.append(h('section.card.narrow.confirm',
    h('p.muted', 'Pay'),
    h('h2', request.merchantName),
    money(request.amount, '.big'),
    request.memo && h('p.memo-line', request.memo),
    h('p.muted', `You have ${M.formatAise(state.user.balance)}`),
    short && h('p.warn', 'Not enough AISE$. Top up at the Bank Office.'),
    h('form.row', {
      onsubmit: onSubmit(async () => {
        const res = await B.payRequest({ id, payer: state.user, txId });
        txId = B.newTxId();
        state.user.balance = res.balance;
        container.replaceChildren(successCard(`Paid ${M.formatAise(request.amount)} to ${request.merchantName}`, res.balance));
      }),
    },
      h('a.button', { href: '#/' }, 'Cancel'),
      h('button.primary', { type: 'submit', disabled: short }, `Pay ${M.formatAise(request.amount)}`))));
  return container;
}

// ================================================================ scan ===

/** In-app scanner where the browser supports it; otherwise the Camera app works. */
async function viewScan() {
  const supported = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  if (!supported) {
    return h('section.card.narrow.center',
      h('h2', 'Scan to pay'),
      h('ol.steps',
        h('li', 'Open the ', h('strong', 'Camera'), ' app on your iPad.'),
        h('li', 'Point it at the AISE$ QR code.'),
        h('li', 'Tap the yellow link that pops up. It opens right here, ready to pay.')),
      h('a.button', { href: '#/' }, 'Back to wallet'));
  }
  const video = h('video.scanner', { playsInline: true, muted: true });
  const msg = h('p.muted', 'Point the camera at an AISE$ QR code.');
  let stream;
  let stopped = false;
  onLeave(() => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); });
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      while (!stopped) {
        const codes = await detector.detect(video).catch(() => []);
        const hit = codes.map((c) => c.rawValue).find(isOurLink);
        if (hit) return go(new URL(hit).hash);
        if (codes.length) msg.textContent = 'That is not an AISE$ code.';
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (err) {
      msg.textContent = err.name === 'NotAllowedError' ? 'Camera permission was denied.' : `Camera unavailable: ${err.message}`;
    }
  })();
  return h('section.card.narrow.center', h('h2', 'Scan to pay'), video, msg, h('a.button', { href: '#/' }, 'Cancel'));
}

/** Only follow QR links to this very site — never arbitrary URLs. */
function isOurLink(text) {
  try {
    const url = new URL(text);
    return url.origin === location.origin && url.pathname === location.pathname && /^#\/(pay\/[a-f0-9]+|send\?)/.test(url.hash);
  } catch {
    return false;
  }
}

// ============================================================ converter ===

function viewConvert() {
  const aise = h('input', { id: 'conv-aise', inputMode: 'decimal', placeholder: '0.00', autocomplete: 'off' });
  const egp = h('input', { id: 'conv-egp', inputMode: 'decimal', placeholder: '0.00', autocomplete: 'off' });
  aise.addEventListener('input', () => {
    try { egp.value = aise.value ? M.plainCents(M.toEgpCents(M.parseAmount(aise.value))) : ''; } catch { egp.value = ''; }
  });
  egp.addEventListener('input', () => {
    try { aise.value = egp.value ? M.plainCents(M.egpToAise(M.parseAmount(egp.value)).aiseCents) : ''; } catch { aise.value = ''; }
  });
  return h('section.card.narrow',
    h('h2', 'Money converter'),
    h('p.muted', `1 AISE$ is always worth ${M.EGP_PER_AISE} EGP.`),
    h('div.converter', field('AISE$', aise), h('span.swap', { 'aria-hidden': 'true' }, '⇄'), field('EGP', egp)),
    h('table.ref',
      h('caption', 'Quick reference'),
      h('tbody', [1, 5, 10, 20, 50, 100].map((n) => h('tr', h('td', M.formatAise(n * 100)), h('td', M.formatEgp(n * 100)))))));
}

// ========================================================= bank office ===

async function viewBank({ match }) {
  const tab = match[1] || 'accounts';
  const tabs = [['accounts', 'Accounts'], ['deposit', 'Deposit'], ['cashout', 'Cash out'], ['ledger', 'Ledger']];
  const panels = { accounts: bankAccounts, deposit: bankDeposit, cashout: bankCashout, ledger: bankLedger };
  const tiles = h('section.tiles');
  const tile = (label, value, sub) => h('div.tile', h('span.muted', label), h('strong', value), sub && h('span.muted', sub));
  async function refreshStats() {
    const s = await B.stats();
    tiles.replaceChildren(
      tile('In circulation', M.formatAise(s.inCirculation)),
      tile('EGP cash reserve', `EGP ${M.formatCents(s.egpReserve)}`, 'Must match the cash box'),
      tile('Accounts', String(s.accounts)),
      tile('Spent today', M.formatAise(s.spentToday), `${s.transactions} transaction${s.transactions === 1 ? '' : 's'} all time`));
  }
  state.refreshBankStats = () => refreshStats().catch(() => {});
  onLeave(() => (state.refreshBankStats = null));
  const [panel] = await Promise.all([(panels[tab] || bankAccounts)(), refreshStats()]);
  return h('div.stack',
    tiles,
    h('div.subtabs', tabs.map(([key, label]) => h('a', { href: `#/bank/${key}`, 'aria-current': key === tab ? 'page' : null }, label))),
    panel);
}

/** A printable slip with someone's first sign-in details. */
function credentialSlip({ name, username, accountNo, tempPassword }) {
  return h('div.slip',
    h('div.slip-head', h('span.coin.small', 'A$'), h('strong', 'AISE Dollar — my account')),
    h('dl',
      h('dt', 'Name'), h('dd', name),
      h('dt', 'Account'), h('dd', accountNo),
      h('dt', 'Username'), h('dd.mono', username),
      h('dt', 'Password'), h('dd.mono', tempPassword)),
    h('p.muted', `Go to ${location.host}${location.pathname} and sign in. You’ll make your own password.`));
}

/** Results of adding people: Google accounts need nothing; username accounts get slips. */
function slipsCard(results, title) {
  const google = results.filter((r) => r.google);
  const slips = results.filter((r) => !r.google);
  return h('section.card.span.slips-card',
    h('div.row', h('h3', title), slips.length ? h('button.primary', { onclick: () => window.print() }, 'Print slips') : ''),
    google.length ? h('div.google-added',
      h('p', h('strong', `${google.length} can sign in with Google now`), ' — tell them to tap “Sign in with Google” and use their school email:'),
      h('ul', google.map((g) => h('li', `${g.name} — ${g.username} (${g.accountNo})`)))) : '',
    slips.length ? h('p.warn', 'These passwords are shown only once. Print them or hand them out now.') : '',
    slips.length ? h('div.slips', slips.map(credentialSlip)) : '');
}

async function bankAccounts() {
  let accounts = await B.accounts();
  const output = h('div.span');
  const search = h('input', { type: 'search', placeholder: 'Search name, username, account or class…', oninput: render });
  const tbody = h('tbody');
  const count = h('h3');

  async function reload() {
    accounts = await B.accounts();
    state.directory = null;
    render();
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    const shown = accounts.filter((a) => !q || [a.name, a.username, a.accountNo, a.grade].some((v) => v.toLowerCase().includes(q)));
    tbody.replaceChildren(...shown.map((a) => h(a.frozen ? 'tr.frozen' : 'tr',
      h('td.mono', a.accountNo),
      h('td', h('strong', a.name),
        h('div.muted', `${a.login === 'google' ? a.username : `@${a.username}`}${a.grade ? ` · ${a.grade}` : ''}`),
        !a.claimed && h('span.badge.pending', 'not signed in yet')),
      h('td', B.ROLES[a.role]),
      h('td.num', M.formatCents(a.balance)),
      h('td', h('div.actions',
        a.accountNo !== state.user.accountNo && h('button.small', { onclick: () => toggleFreeze(a) }, a.frozen ? 'Unfreeze' : 'Freeze'),
        a.login === 'password' && h('button.small', { onclick: () => resetPassword(a) }, 'New password'))))));
    count.textContent = q ? `Accounts (${shown.length} of ${accounts.length})` : `All accounts (${accounts.length})`;
    state.refreshBankStats?.();
  }
  render();

  async function toggleFreeze(a) {
    if (!confirm(`${a.frozen ? 'Unfreeze' : 'Freeze'} ${a.name}'s account?${a.frozen ? '' : ' They won’t be able to pay or be paid.'}`)) return;
    try {
      await B.setFrozen(a.accountNo, !a.frozen);
      notify(`${a.name} ${a.frozen ? 'unfrozen' : 'frozen'}.`);
      await reload();
    } catch (err) { notify(err.message, 'error'); }
  }

  async function resetPassword(a) {
    if (!confirm(`Make a new password for ${a.name}? Their old password stops working.`)) return;
    try {
      const slip = await B.resetPassword(a);
      output.replaceChildren(slipsCard([slip], `New password for ${a.name}`));
      output.scrollIntoView({ behavior: 'smooth' });
      await reload();
    } catch (err) { notify(err.message, 'error'); }
  }

  const createForm = h('form.stack', {
    onsubmit: onSubmit(async (fd, form) => {
      const slip = await B.createAccount(Object.fromEntries(fd));
      form.reset();
      output.replaceChildren(slipsCard([slip], `Account opened: ${slip.accountNo}`));
      notify(`Opened ${slip.accountNo} for ${slip.name}.`);
      await reload();
    }),
  },
    field('Full name', h('input', { name: 'name', required: true, maxLength: 60 })),
    field('School email', h('input', { name: 'username', required: true, maxLength: 80, autocapitalize: 'none', spellcheck: false, inputMode: 'email', placeholder: 'e.g. omar.h@school.edu.eg' }),
      'No email (like the canteen)? Type a username instead and they get a password slip.'),
    field('Type', h('select', { name: 'role' }, Object.entries(B.ROLES).map(([value, label]) => h('option', { value }, label)))),
    field('Class (optional)', h('input', { name: 'grade', maxLength: 20, placeholder: 'e.g. 5B' })),
    h('button.primary', { type: 'submit' }, 'Open account'));

  const progress = h('p.muted');
  const importForm = h('form.stack', {
    onsubmit: onSubmit(async (fd) => {
      const rows = parseCsv(String(fd.get('csv')));
      if (!rows.length) throw new B.BankError('Paste at least one line: name, email, class, type');
      const ok = [];
      const bad = [];
      for (const [i, row] of rows.entries()) {
        progress.textContent = `Creating ${i + 1} of ${rows.length}…`;
        try { ok.push(await B.createAccount(row)); } catch (err) { bad.push(`${row.name || row.username || '(blank)'}: ${err.message}`); }
      }
      progress.textContent = '';
      output.replaceChildren(
        bad.length ? h('section.card.span', h('h3', `${bad.length} skipped`), h('ul', bad.map((b) => h('li', b)))) : '',
        ok.length ? slipsCard(ok, `${ok.length} account${ok.length === 1 ? '' : 's'} created`) : '');
      notify(`Created ${ok.length} of ${rows.length}.`, bad.length ? 'error' : 'ok');
      await reload();
    }),
  },
    field('One person per line', h('textarea', { name: 'csv', rows: 5, required: true, spellcheck: false,
      placeholder: 'Omar Hassan, omar.h@school.edu.eg, 5B\nLayla Farouk, layla.f@school.edu.eg, 5B\nSchool Canteen, canteen, , merchant' }),
      'Format: name, school email, class, type. Type is student unless you write staff, merchant or banker. No email? Write a username instead.'),
    progress,
    h('button', { type: 'submit' }, 'Create all'));

  return h('div.grid',
    h('section.card', h('h3', 'Open an account'), createForm),
    h('section.card', h('h3', 'Add a whole class'), importForm),
    output,
    h('section.card.span', count, search,
      h('div.table-wrap', h('table',
        h('thead', h('tr', ['Account', 'Name', 'Type', 'AISE$', ''].map((t) => h('th', t)))),
        tbody))));
}

function parseCsv(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^name\s*[,;\t]\s*(username|email)/i.test(l))
    .map((l) => {
      const [name = '', username = '', grade = '', role = ''] = l.split(/[,\t;]/).map((s) => s.trim());
      return { name, username, grade, role: role.toLowerCase() || 'student' };
    });
}

async function bankDeposit() {
  const accounts = await directory(true);
  let txId = B.newTxId();
  const picker = recipientPicker(accounts.filter((a) => !a.frozen), { exclude: null, label: 'Account' });
  const preview = h('p.preview', 'Type the EGP cash you received.');
  const egpInput = h('input', {
    name: 'egp', inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off',
    oninput: () => {
      try {
        const { aiseCents, changeEgpCents } = M.egpToAise(M.parseAmount(egpInput.value));
        preview.textContent = `Adds ${M.formatAise(aiseCents)}${changeEgpCents ? ` · give back EGP ${M.formatCents(changeEgpCents)} change` : ''}`;
      } catch { preview.textContent = 'Type the EGP cash you received.'; }
    },
  });
  return h('section.card.narrow',
    h('h3', 'Cash deposit'),
    h('p.muted', 'Take Egyptian pounds and add AISE$ to the wallet: 10 EGP → 1 AISE$.'),
    h('form.stack', {
      onsubmit: onSubmit(async (fd, form) => {
        const to = picker.find();
        if (!to) throw new B.BankError('Pick an account from the list.');
        const egpCents = M.parseAmount(fd.get('egp'));
        const { aiseCents } = M.egpToAise(egpCents);
        if (!confirm(`Add ${M.formatAise(aiseCents)} to ${to.name} for EGP ${M.formatCents(egpCents)} cash?`)) return;
        await B.deposit({ to: to.accountNo, egpCents, memo: fd.get('memo'), txId });
        txId = B.newTxId();
        form.reset();
        preview.textContent = 'Type the EGP cash you received.';
        state.refreshBankStats?.();
        notify(`Added ${M.formatAise(aiseCents)} to ${to.name}.`);
      }),
    },
      picker.el,
      field('EGP cash received', egpInput),
      preview,
      field('Note (optional)', h('input', { name: 'memo', maxLength: 140 })),
      h('button.primary', { type: 'submit' }, 'Add money')));
}

async function bankCashout() {
  const accounts = await B.accounts();
  let txId = B.newTxId();
  const picker = recipientPicker(accounts.filter((a) => !a.frozen), { exclude: null, label: 'Account' });
  const selected = () => accounts.find((a) => a.accountNo === picker.find()?.accountNo);

  // Username accounts prove it's them with their password; Google accounts
  // have no password here, so the Bank Office confirms they're present.
  const passwordInput_ = h('input', { name: 'holderPassword', type: 'password', autocomplete: 'off' });
  const passwordField = field('Account holder’s password', passwordInput_);
  const presentField = h('label.check-row', h('input', { name: 'present', type: 'checkbox' }), ' The student is here in person');
  function sync() {
    const google = selected()?.login === 'google';
    passwordField.hidden = google;
    passwordInput_.required = !google;
    presentField.hidden = !google;
  }
  picker.el.addEventListener('input', sync);
  sync();

  return h('section.card.narrow',
    h('h3', 'Cash out to EGP'),
    h('p.muted', 'Take AISE$ out of the wallet, then pay the student the EGP shown.'),
    h('form.stack', {
      onsubmit: onSubmit(async (fd, form) => {
        const account = selected();
        if (!account) throw new B.BankError('Pick an account from the list.');
        const amount = M.parseAmount(fd.get('amount'));
        await B.withdraw({
          account, amount, holderPassword: fd.get('holderPassword'), present: fd.get('present') === 'on', memo: fd.get('memo'), txId,
        });
        txId = B.newTxId();
        account.balance -= amount;
        form.reset();
        sync();
        state.refreshBankStats?.();
        notify(`Done! Pay ${account.name} ${M.formatEgp(amount)} in cash.`);
      }),
    },
      picker.el,
      amountInput(),
      passwordField,
      presentField,
      field('Note (optional)', h('input', { name: 'memo', maxLength: 140 })),
      h('button.primary', { type: 'submit' }, 'Cash out')));
}

function bankLedger() {
  return h('section.card',
    h('div.row', h('h3', 'Full ledger'), h('button.small', { onclick: exportCsv }, 'Download CSV')),
    h('p.muted', 'Every transaction ever made. Nobody can edit or delete them — not even the Bank Office.'),
    txFeed((opts) => B.ledger(opts), { pageSize: 50 }));
}

async function exportCsv() {
  try {
    notify('Preparing CSV…');
    const [txs, name] = await Promise.all([B.allTransactions(), nameOf()]);
    // Quote every cell; prefix =+-@ so spreadsheet apps can't run formulas.
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`;
    const who = (acct) => (acct ? `${name(acct)} (${acct})` : 'BANK');
    const rows = [['Date', 'Type', 'From', 'To', 'AISE$', 'EGP', 'Note']].concat(txs.map((t) =>
      [t.at.toISOString(), t.type, who(t.from), who(t.to), M.plainCents(t.amount), M.plainCents(M.toEgpCents(t.amount)), t.memo]));
    const csv = `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = h('a', { href: url, download: `aise-ledger-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ================================================================= boot ===

window.addEventListener('hashchange', route);
if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
route();
