/**
 * AISE Dollar — the website (UI only).
 *
 * All data access lives in bank.js. All DOM is built with `h()`, which adds
 * user text as text nodes, so names and notes can never become HTML.
 */
import * as B from './bank.js';
import { DEFAULT_WORDS, WORD_GROUPS } from './words.js';

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

/**
 * The site's wording: the Bank Office's version of a word if they changed it,
 * else the default from words.js. {cur} and {rate} are always filled in.
 */
function t(key, vars = {}, brand = state.brand) {
  const text = brand?.words?.[key] || DEFAULT_WORDS[key] || key;
  return text.replace(/\{(\w+)\}/g, (whole, k) =>
    (k in vars ? String(vars[k]) : k === 'cur' ? M.currencyName() : k === 'rate' ? String(M.EGP_PER_AISE) : whole));
}
const roleName = (role) => t(`role.${role}`);

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
function amountInput({ name = 'amount', value = '', label = t('common.amount'), autofocus = false } = {}) {
  const hint = h('span.hint', '≈ EGP 0.00');
  const input = h('input', { name, value, inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off', autofocus, oninput: update });
  function update() {
    try { hint.textContent = `≈ ${M.formatEgp(M.parseAmount(input.value))}`; }
    catch { hint.textContent = input.value ? t('common.amountHint') : '≈ EGP 0.00'; }
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

const state = { user: null, directory: null, refreshBankStats: null, brand: null };

// ================================================================ brand ===

/** The site's look before the Bank Office customises it. */
const DEFAULT_BRAND = {
  name: 'AISE Dollar',
  tagline: 'the class money of AIS Egypt 🪙',
  coinText: 'A$',
  logo: '',
  loginTitle: 'Hey there! 👋',
  loginText: 'Sign in with your school Google account to see your money.',
  footer: 'Made by students, for students 💛',
  currency: '',  // '' = AISE$
  words: {},     // only words the Bank Office changed
  theme: {},     // { primary, coin, paper, ink, font, pattern } — unset = default look
};
state.brand = { ...DEFAULT_BRAND };

/** Colours the theme starts from (match styles.css). */
const DEFAULT_COLORS = { primary: '#3355c4', coin: '#ffc93c', paper: '#fff8ec', ink: '#23263f' };
const FONT_STACKS = {
  rounded: null, // the stylesheet's default
  classic: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
  handwritten: '"Chalkboard SE", "Marker Felt", "Comic Sans MS", "Comic Neue", cursive',
  typewriter: '"American Typewriter", "Courier New", ui-monospace, monospace',
};
const THEMED_VARS = ['--blue', '--sun', '--on-blue', '--on-sun', '--paper', '--ink', '--surface', '--line', '--muted', '--paper-dot', '--sky', '--font', 'color-scheme'];

/** Is this #rrggbb colour light enough to need dark text on top? */
function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
}

/** Apply the Bank Office's colours, font and background. Text colours on top
 *  of each colour flip between dark and light automatically so it stays readable. */
function applyTheme(theme = {}) {
  const css = document.documentElement.style;
  THEMED_VARS.forEach((v) => css.removeProperty(v));
  if (theme.primary) {
    css.setProperty('--blue', theme.primary);
    css.setProperty('--on-blue', isLight(theme.primary) ? '#1d1d1d' : '#ffffff');
  }
  if (theme.coin) {
    css.setProperty('--sun', theme.coin);
    css.setProperty('--on-sun', isLight(theme.coin) ? '#3d2a00' : '#ffffff');
  }
  if (theme.paper || theme.ink) {
    const paper = theme.paper || DEFAULT_COLORS.paper;
    const light = isLight(paper);
    const ink = theme.ink || (light ? DEFAULT_COLORS.ink : '#f4eee2');
    const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
    css.setProperty('--paper', paper);
    css.setProperty('--ink', ink);
    css.setProperty('--surface', light ? mix(paper, 25, '#ffffff') : mix(paper, 88, '#ffffff'));
    css.setProperty('--line', mix(ink, 16, paper));
    css.setProperty('--muted', mix(ink, 65, paper));
    css.setProperty('--paper-dot', mix(ink, 9, paper));
    css.setProperty('--sky', mix('var(--blue)', 14, light ? '#ffffff' : paper));
    css.setProperty('color-scheme', light ? 'light' : 'dark');
  }
  if (FONT_STACKS[theme.font]) css.setProperty('--font', FONT_STACKS[theme.font]);
  document.body.dataset.pattern = theme.pattern || 'dots';
}

/** A round coin showing the uploaded logo, or the coin letters. */
function coinEl(tag, brand = state.brand) {
  return brand.logo
    ? h(`${tag}.has-logo`, { 'aria-hidden': 'true' }, h('img', { src: brand.logo, alt: '' }))
    : h(tag, { 'aria-hidden': 'true' }, brand.coinText || DEFAULT_BRAND.coinText);
}

/** Put the brand into the header, footer, tab title and favicon. */
function applyBrand(brand = state.brand) {
  M.setCurrency(brand.currency);
  applyTheme(brand.theme);
  document.querySelector('.peg').textContent = t('nav.peg', {}, brand);
  document.getElementById('brand-name').textContent = brand.name;
  document.getElementById('brand-sub').textContent = brand.tagline;
  document.getElementById('brand-foot').textContent = brand.footer;
  document.getElementById('brand-coin').replaceWith(Object.assign(coinEl('span.coin', brand), { id: 'brand-coin' }));
  document.title = brand.name;
  const icon = document.getElementById('favicon');
  icon.href = brand.logo || 'icon.svg';
  icon.type = brand.logo ? brand.logo.slice(5, brand.logo.indexOf(';')) : 'image/svg+xml';
}

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
    if (!(err instanceof B.BankError || err instanceof M.MoneyError)) console.error(err); // expected messages aren't bugs
    app.replaceChildren(h('section.card.narrow',
      h('h2', t('common.somethingWrong')), h('p.muted', err.message),
      h('button', { onclick: () => route() }, t('common.tryAgain'))));
  }
}

function renderChrome() {
  const u = state.user?.needsSetup ? null : state.user;
  const signedIn = u && !u.mustChange;
  const hash = (location.hash || '#/').split('?')[0];
  const tabs = [
    signedIn && ['#/', t('nav.wallet'), ['#/', '#/send', '#/receive', '#/scan']],
    signedIn && ['#/till', u.role === 'merchant' ? t('nav.till') : t('nav.request')],
    ['#/convert', t('nav.convert')],
    signedIn && u.role === 'banker' && ['#/bank', t('nav.bank')],
  ].filter(Boolean);
  document.getElementById('nav').replaceChildren(...tabs.map(([href, label, also]) => {
    const active = hash === href || (also || []).includes(hash) || (href === '#/bank' && hash.startsWith('#/bank')) ||
      (href === '#/' && hash.startsWith('#/pay/'));
    return h('a', { href, 'aria-current': active ? 'page' : null }, label);
  }));
  document.getElementById('user-area').replaceChildren(u
    ? h('div.user-chip', h('span.user-name', firstName(u.name)), h('button.ghost.small', { onclick: logout }, t('nav.signOut')))
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
    h('h2', 'Almost there! 🛠️'),
    h('p', 'AISE Dollar needs its Firebase database connected before anyone can sign in.'),
    h('p.muted', 'Follow “Connect Firebase” in the README, then paste the config into firebase-config.js.'));
}

/** "Sign in with Google". signInWithGoogle runs first in the tap so Safari allows the popup. */
function googleButton(label = t('signin.google')) {
  const button = h('button.google-btn', {
    type: 'button',
    onclick: async () => {
      button.disabled = true;
      try {
        await B.signInWithGoogle();
      } catch (err) {
        // iPad Safari can report a popup error even though Google signed you in.
        if (!B.signedIn()) {
          notify(err.message, 'error');
          return;
        }
      } finally {
        button.disabled = false;
      }
      afterSignIn();
    },
  }, h('span.g-logo', { 'aria-hidden': 'true' }, 'G'), label);
  return button;
}

/** Google said yes: load who this is and go to setup, the wallet, or where they were. */
let continuing = false;
async function afterSignIn() {
  if (continuing) return;
  continuing = true;
  try {
    state.user = null;
    await refreshMe();
    if (state.user?.needsSetup) return go('#/setup');
    notify(t('signin.welcome', { name: firstName(state.user.name) }));
    go(sessionTake('returnTo') || '#/');
  } catch (err) {
    state.user = null;
    renderChrome();
    notify(err.message, 'error');
  } finally {
    continuing = false;
  }
}

async function viewSetup() {
  if (!(await B.needsSetup())) { go('#/login'); return h('div'); }
  if (!state.user?.needsSetup) {
    return h('section.card.narrow.login',
      coinEl('div.login-coin'),
      h('h2', t('setup.title')),
      h('p.muted', t('setup.text')),
      googleButton(t('setup.google')));
  }
  return h('section.card.narrow',
    h('h2', t('setup.almost')),
    h('p.muted', t('setup.signedInAs', { email: state.user.email })),
    h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        await B.setup({ name: fd.get('name') });
        state.user = null;
        await refreshMe();
        notify(t('setup.done'));
        go('#/bank/accounts');
      }),
    },
      field(t('setup.nameLabel'), h('input', { name: 'name', required: true, autocomplete: 'name', placeholder: t('setup.namePlaceholder') })),
      h('button.primary', { type: 'submit' }, t('setup.create'))));
}

function viewLogin() {
  if (state.user) { go(sessionTake('returnTo') || '#/'); return h('div'); }
  return h('section.card.narrow.login',
    coinEl('div.login-coin'),
    h('h2', state.brand.loginTitle),
    state.brand.loginText && h('p.muted', state.brand.loginText),
    googleButton(),
    h('details.username-login',
      h('summary', t('signin.usernameToggle')),
      h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        state.user = await B.login(fd.get('username'), fd.get('password'));
        if (state.user.mustChange) return go('#/password');
        notify(t('signin.welcome', { name: firstName(state.user.name) }));
        go(sessionTake('returnTo') || '#/');
      }),
    },
      field(t('signin.username'), h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false })),
      field(t('signin.password'), passwordInput('password', 'current-password')),
      h('button.primary', { type: 'submit' }, t('signin.button'))),
      h('p.muted.small-print', t('signin.forgot'))));
}

function viewPassword() {
  if (state.user?.google) { go('#/'); return h('div'); } // Google accounts have no AISE password
  const forced = state.user?.mustChange;
  return h('section.card.narrow',
    h('h2', forced ? t('pw.makeOwn') : t('pw.change')),
    forced && h('p.muted', t('pw.intro')),
    h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        if (fd.get('next') !== fd.get('next2')) throw new B.BankError(t('pw.mismatch'));
        await B.changePassword(fd.get('current'), fd.get('next'));
        await refreshMe();
        notify(t('pw.saved'));
        go(sessionTake('returnTo') || '#/');
      }),
    },
      // Lets Safari/Chrome save the new password against the right username.
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: state.user?.username || '', hidden: true, readOnly: true }),
      field(forced ? t('pw.fromSlip') : t('pw.current'), passwordInput('current', 'current-password')),
      field(t('pw.new'), passwordInput('next', 'new-password'), t('pw.newHint')),
      field(t('pw.again'), passwordInput('next2', 'new-password')),
      h('button.primary', { type: 'submit' }, t('pw.save'))));
}

// ========================================================== wallet views ===

function txItem(tx, name) {
  const signed = tx.delta !== undefined;
  const value = signed ? tx.delta : tx.amount;
  let title;
  if (tx.type === 'deposit') title = signed ? t('tx.deposit') : t('tx.depositTo', { name: name(tx.to) });
  else if (tx.type === 'withdraw') title = signed ? t('tx.withdraw') : t('tx.withdrawBy', { name: name(tx.from) });
  else if (!signed) title = t('tx.fromTo', { from: name(tx.from), to: name(tx.to) });
  else title = value > 0 ? t('tx.from', { name: name(tx.from) }) : t('tx.to', { name: name(tx.to) });
  const badge = { deposit: t('tx.badgeDeposit'), withdraw: t('tx.badgeWithdraw'), transfer: t('tx.badgeTransfer') }[tx.type];
  return h('li',
    h(`span.badge.${tx.type}`, tx.viaQr ? t('tx.badgeQr') : badge),
    h('div.tx-main', h('strong', title), tx.memo && h('span.memo', tx.memo)),
    h('div.tx-side',
      h(`span.amt${signed ? (value > 0 ? '.in' : '.out') : ''}`, `${signed && value > 0 ? '+' : ''}${M.formatCents(value)}`),
      h('time', { dateTime: tx.at.toISOString() }, fmtDate(tx.at))));
}

/** A transaction list with "Load more" paging. */
function txFeed(loadPage, { pageSize = 25, empty = t('wallet.empty') } = {}) {
  const list = h('ul.txs');
  const more = h('button.ghost.more', { hidden: true, onclick: load }, t('wallet.loadMore'));
  let last = null;
  async function load() {
    more.disabled = true;
    try {
      const [page, name] = await Promise.all([loadPage({ pageSize, after: last }), nameOf()]);
      list.append(...page.map((tx) => txItem(tx, name)));
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
    ['#/send', t('wallet.send'), '💸'],
    ['#/receive', t('wallet.getPaid'), '🤲'],
    ['#/scan', t('wallet.scan'), '📷'],
    ['#/till', u.role === 'merchant' ? t('wallet.openTill') : t('wallet.request'), '🧾'],
  ];
  return h('div.grid',
    h('section.card.balance-card',
      h('div.row',
        h('div', h('p.muted', `${roleName(u.role)} · ${u.accountNo}${u.grade ? ` · ${u.grade}` : ''}`), h('h2', u.name)),
        !u.google && h('a.ghost-link', { href: '#/password' }, t('wallet.passwordLink'))),
      h('p.muted', t('wallet.youveGot')),
      money(u.balance, '.big'),
      u.frozen && h('p.warn', t('wallet.frozen')),
      h('div.actions-row', actions.map(([href, label, icon]) =>
        h('a.action', { href }, h('span.action-icon', { 'aria-hidden': 'true' }, icon), label)))),
    h('section.card.span',
      h('h3', t('wallet.history')),
      txFeed((opts) => B.history(u.accountNo, opts))));
}

/** Pick a person: type a name or account number, with autocomplete. */
function recipientPicker(accounts, { initial = '', exclude = state.user.accountNo, label = t('common.to') } = {}) {
  const listId = `dir-${Math.random().toString(36).slice(2)}`;
  const resolved = h('span.hint', t('common.pickHint'));
  const input = h('input', {
    name: 'to', required: true, autocomplete: 'off', list: listId, value: initial,
    placeholder: t('common.pickPlaceholder'), oninput: update,
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
    resolved.textContent = a ? `✓ ${a.name} · ${roleName(a.role)}${a.grade ? ` · ${a.grade}` : ''}` : t('common.pickHint');
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
    h('h2', t('send.title')),
    h('p.muted', t('send.youveGot', { amount: M.formatAise(state.user.balance) })),
    h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        const to = picker.find();
        if (!to) throw new B.BankError(t('send.pickFromList'));
        const amount = M.parseAmount(fd.get('amount'));
        if (amount > state.user.balance) throw new B.BankError(t('send.onlyHave', { amount: M.formatAise(state.user.balance) }));
        formCard.replaceWith(confirmCard(to, amount, String(fd.get('memo') || '')));
      }),
    },
      picker.el,
      amountInput({ value: params.get('amount') || '', autofocus: Boolean(preset) }),
      field(t('common.note'), h('input', { name: 'memo', maxLength: 140, value: params.get('memo') || '', placeholder: t('send.notePlaceholder') })),
      h('button.primary', { type: 'submit' }, t('send.review'))));

  function confirmCard(to, amount, memo) {
    const card = h('section.card.narrow.confirm',
      h('p.muted', t('send.sending')),
      money(amount, '.big'),
      h('p', `${t('send.to')} `, h('strong', to.name), ` (${to.accountNo})`),
      memo && h('p.memo-line', `“${memo}”`),
      h('form.row', {
        onsubmit: onSubmit(async () => {
          const balance = await B.transfer({ from: state.user.accountNo, to: to.accountNo, amount, memo, txId });
          txId = B.newTxId();
          state.user.balance = balance;
          card.replaceWith(successCard(t('send.sent', { amount: M.formatAise(amount), name: to.name }), balance));
        }),
      },
        h('button', { type: 'button', onclick: () => card.replaceWith(formCard) }, t('common.back')),
        h('button.primary', { type: 'submit' }, t('send.sendIt'))));
    return card;
  }

  return h('div', formCard);
}

function successCard(title, balance, { sendAgain = true } = {}) {
  return h('section.card.narrow.success',
    h('div.check', { 'aria-hidden': 'true' }, '✓'),
    h('h2', title),
    balance !== undefined && h('p.muted', t('send.nowGot', { amount: M.formatAise(balance), egp: M.formatEgp(balance) })),
    h('div.row.center-row',
      h(sendAgain ? 'a.button' : 'a.button.primary', { href: '#/' }, t('common.backToWallet')),
      // go() re-renders even when we're already on #/send (a plain link would do nothing).
      sendAgain && h('a.button.primary', { href: '#/send', onclick: (e) => { e.preventDefault(); go('#/send'); } }, t('send.again'))));
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
    notify(t('common.linkCopied'));
  } catch {
    prompt(t('common.copyPrompt'), text);
  }
}

function viewReceive() {
  const u = state.user;
  const link = appUrl(`#/send?to=${encodeURIComponent(u.accountNo)}`);
  return h('div.grid',
    h('section.card.center',
      h('h2', t('receive.title')),
      h('p.muted', t('receive.text')),
      h('div.qr-wrap', qrCanvas(link)),
      h('p.account-big', u.accountNo),
      h('p', u.name),
      h('button', { onclick: () => copy(link) }, t('receive.copy'))),
    h('section.card.center',
      h('h3', t('receive.exactTitle')),
      h('p.muted', t('receive.exactText')),
      h('a.button.primary', { href: '#/till' }, t('receive.requestButton'))));
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
    const amount = amountInput({ label: t('till.price'), autofocus: true });
    const input = amount.querySelector('input');
    container.replaceChildren(h('section.card.narrow',
      h('h2', u.role === 'merchant' ? t('till.titleShop', { name: u.name }) : t('till.titleRequest')),
      h('p.muted', t('till.text')),
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
        field(t('till.memoLabel'), h('input', { name: 'memo', maxLength: 140, placeholder: t('till.memoPlaceholder') })),
        h('button.primary.big-btn', { type: 'submit' }, t('till.show')))),
      todaysSales());
  }

  function showCode(id, cents, memo) {
    const link = appUrl(`#/pay/${id}`);
    const status = h('p.status.waiting', t('till.waiting'));
    const timer = h('span.muted');
    container.replaceChildren(h('section.card.center.till-code',
      h('p.muted', t('till.payName', { name: u.name })),
      money(cents, '.big'),
      memo && h('p.memo-line', memo),
      h('div.qr-wrap', qrCanvas(link, 300)),
      h('p.muted', t('till.scanHint')),
      status, timer,
      h('div.row.center-row',
        h('button', { onclick: cancel }, t('common.cancel')),
        h('button.ghost', { onclick: () => copy(link) }, t('till.copyLink')))));

    async function cancel() {
      stop();
      await B.cancelRequest(id).catch(() => {});
      entry();
    }

    let expiresAt = Date.now() + B.REQUEST_TTL_MS;
    tick = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      timer.textContent = t('till.expiresIn', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
      if (!left) {
        stop();
        status.textContent = t('till.expired');
        status.className = 'status failed';
      }
    }, 500);
    unwatch = B.watchRequest(id, (r) => {
      if (!r) return;
      expiresAt = r.expiresAt;
      if (r.status === 'paid') paid(r);
      else if (r.status === 'cancelled') { status.textContent = t('till.cancelled'); status.className = 'status failed'; }
    });
  }

  function paid(r) {
    stop();
    chime();
    container.replaceChildren(h('section.card.center.success.till-paid',
      h('div.check', { 'aria-hidden': 'true' }, '✓'),
      h('h2', t('till.paid')),
      money(r.amount, '.big'),
      h('p', `${t('till.by')} `, h('strong', r.paidByName)),
      r.memo && h('p.memo-line', r.memo),
      h('button.primary.big-btn', { onclick: () => entry(), autofocus: true }, t('till.next'))));
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
      const at = ctx.currentTime + i * 0.12;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.3);
    });
    setTimeout(() => ctx.close(), 800);
  } catch { /* sound is optional */ }
}

function todaysSales() {
  const body = h('div', h('p.muted', t('common.loading')));
  Promise.all([B.history(state.user.accountNo, { pageSize: 200 }), nameOf()]).then(([txs, name]) => {
    const today = new Date().toDateString();
    const sales = txs.filter((tx) => tx.delta > 0 && tx.type === 'transfer' && tx.at.toDateString() === today);
    const total = sales.reduce((sum, tx) => sum + tx.amount, 0);
    body.replaceChildren(
      h('div.row', h('strong', sales.length === 1 ? t('till.todayOne') : t('till.todayMany', { n: sales.length })), h('strong', M.formatAise(total))),
      sales.length ? h('ul.txs.compact', sales.slice(0, 10).map((tx) =>
        h('li', h('span.muted', fmtTime(tx.at)), h('div.tx-main', h('strong', name(tx.from)), tx.memo && h('span.memo', tx.memo)),
          h('span.amt.in', `+${M.formatCents(tx.amount)}`)))) : h('p.empty', t('till.noneToday')));
  }).catch(() => body.replaceChildren(h('p.muted', t('till.loadFail'))));
  return h('section.card.narrow', h('h3', t('till.today')), body);
}

// ================================================================= pay ===

async function viewPay({ match }) {
  const id = match[1];
  const [request] = await Promise.all([B.getRequest(id), refreshMe()]);
  if (!request || request.status !== 'open') {
    const text = !request ? t('pay.notExist')
      : { paid: request.paidByName ? t('pay.alreadyPaidBy', { name: request.paidByName }) : t('pay.alreadyPaid'), cancelled: t('pay.cancelled'), expired: t('pay.expired') }[request.status];
    return h('section.card.narrow.center', h('h2', t('pay.cantTitle')), h('p.muted', text), h('a.button', { href: '#/' }, t('common.backToWallet')));
  }
  if (request.merchant === state.user.accountNo) {
    return h('section.card.narrow.center', h('h2', t('pay.ownTitle')), h('p.muted', t('pay.ownText')), h('a.button', { href: '#/till' }, t('pay.backToTill')));
  }
  const short = request.amount > state.user.balance;
  const container = h('div');
  let txId = B.newTxId();
  container.append(h('section.card.narrow.confirm',
    h('p.muted', t('pay.pay')),
    h('h2', request.merchantName),
    money(request.amount, '.big'),
    request.memo && h('p.memo-line', request.memo),
    h('p.muted', t('pay.youHave', { amount: M.formatAise(state.user.balance) })),
    short && h('p.warn', t('pay.short')),
    h('form.row', {
      onsubmit: onSubmit(async () => {
        const res = await B.payRequest({ id, payer: state.user, txId });
        txId = B.newTxId();
        state.user.balance = res.balance;
        container.replaceChildren(successCard(t('pay.paid', { amount: M.formatAise(request.amount), name: request.merchantName }), res.balance, { sendAgain: false }));
      }),
    },
      h('a.button', { href: '#/' }, t('common.cancel')),
      h('button.primary', { type: 'submit', disabled: short }, t('pay.button', { amount: M.formatAise(request.amount) })))));
  return container;
}

// ================================================================ scan ===

/** In-app scanner where the browser supports it; otherwise the Camera app works. */
async function viewScan() {
  const supported = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  if (!supported) {
    return h('section.card.narrow.center',
      h('h2', t('scan.title')),
      h('ol.steps', h('li', t('scan.step1')), h('li', t('scan.step2')), h('li', t('scan.step3'))),
      h('a.button', { href: '#/' }, t('common.backToWallet')));
  }
  const video = h('video.scanner', { playsInline: true, muted: true });
  const msg = h('p.muted', t('scan.point'));
  let stream;
  let stopped = false;
  onLeave(() => { stopped = true; stream?.getTracks().forEach((track) => track.stop()); });
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (stopped) return stream.getTracks().forEach((track) => track.stop());
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      while (!stopped) {
        const codes = await detector.detect(video).catch(() => []);
        const hit = codes.map((c) => c.rawValue).find(isOurLink);
        if (hit) return go(new URL(hit).hash);
        if (codes.length) msg.textContent = t('scan.notOurs');
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (err) {
      msg.textContent = err.name === 'NotAllowedError' ? t('scan.denied') : t('scan.unavailable', { error: err.message });
    }
  })();
  return h('section.card.narrow.center', h('h2', t('scan.title')), video, msg, h('a.button', { href: '#/' }, t('common.cancel')));
}

/** Only follow QR links to this very site — never arbitrary URLs. */
function isOurLink(text) {
  try {
    const url = new URL(text);
    const page = (p) => p.replace(/index\.html$/, ''); // /repo/ and /repo/index.html are the same page
    return url.origin === location.origin && page(url.pathname) === page(location.pathname) && /^#\/(pay\/[a-f0-9]+|send\?)/.test(url.hash);
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
    h('h2', t('convert.title')),
    h('p.muted', t('convert.text')),
    h('div.converter', field(M.currencyName(), aise), h('span.swap', { 'aria-hidden': 'true' }, '⇄'), field('EGP', egp)),
    h('table.ref',
      h('caption', t('convert.ref')),
      h('tbody', [1, 5, 10, 20, 50, 100].map((n) => h('tr', h('td', M.formatAise(n * 100)), h('td', M.formatEgp(n * 100)))))));
}

// ========================================================= bank office ===

async function viewBank({ match }) {
  const tab = match[1] || 'accounts';
  const tabs = [['accounts', t('bank.tabAccounts')], ['deposit', t('bank.tabDeposit')], ['cashout', t('bank.tabCashout')], ['ledger', t('bank.tabLedger')], ['look', t('bank.tabLook')]];
  const panels = { accounts: bankAccounts, deposit: bankDeposit, cashout: bankCashout, ledger: bankLedger, look: bankLook };
  const tiles = h('section.tiles');
  const tile = (label, value, sub) => h('div.tile', h('span.muted', label), h('strong', value), sub && h('span.muted', sub));
  async function refreshStats() {
    const s = await B.stats();
    tiles.replaceChildren(
      tile(t('bank.circulation'), M.formatAise(s.inCirculation)),
      tile(t('bank.reserve'), `EGP ${M.formatCents(s.egpReserve)}`, t('bank.reserveHint')),
      tile(t('bank.accounts'), String(s.accounts)),
      tile(t('bank.spentToday'), M.formatAise(s.spentToday), s.transactions === 1 ? t('bank.txOne') : t('bank.txMany', { n: s.transactions })));
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
    h('div.slip-head', coinEl('span.coin.small'), h('strong', t('slip.head', { site: state.brand.name }))),
    h('dl',
      h('dt', t('slip.name')), h('dd', name),
      h('dt', t('slip.account')), h('dd', accountNo),
      h('dt', t('slip.username')), h('dd.mono', username),
      h('dt', t('slip.password')), h('dd.mono', tempPassword)),
    h('p.muted', t('slip.goTo', { url: `${location.host}${location.pathname}` })));
}

/** Results of adding people: Google accounts need nothing; username accounts get slips. */
function slipsCard(results, title) {
  const google = results.filter((r) => r.google);
  const slips = results.filter((r) => !r.google);
  return h('section.card.span.slips-card',
    h('div.row', h('h3', title), slips.length ? h('button.primary', { onclick: () => window.print() }, t('slip.print')) : ''),
    google.length ? h('div.google-added',
      h('p', h('strong', t('slip.googleCount', { n: google.length })), t('slip.googleHint')),
      h('ul', google.map((g) => h('li', `${g.name} — ${g.username} (${g.accountNo})`)))) : '',
    slips.length ? h('p.warn', t('slip.once')) : '',
    slips.length ? h('div.slips', slips.map(credentialSlip)) : '');
}

async function bankAccounts() {
  let accounts = await B.accounts();
  const output = h('div.span');
  const search = h('input', { type: 'search', placeholder: t('acct.search'), oninput: render });
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
        !a.claimed && h('span.badge.pending', t('acct.notSignedIn'))),
      h('td', roleName(a.role)),
      h('td.num', M.formatCents(a.balance)),
      h('td', h('div.actions',
        a.accountNo !== state.user.accountNo && h('button.small', { onclick: () => toggleFreeze(a) }, a.frozen ? t('acct.unfreeze') : t('acct.freeze')),
        a.login === 'password' && h('button.small', { onclick: () => resetPassword(a) }, t('acct.newPassword')))))));
    count.textContent = q ? t('acct.filtered', { shown: shown.length, n: accounts.length }) : t('acct.all', { n: accounts.length });
    state.refreshBankStats?.();
  }
  render();

  async function toggleFreeze(a) {
    if (!confirm(a.frozen ? t('acct.unfreezeConfirm', { name: a.name }) : t('acct.freezeConfirm', { name: a.name }))) return;
    try {
      await B.setFrozen(a.accountNo, !a.frozen);
      notify(a.frozen ? t('acct.unfrozenToast', { name: a.name }) : t('acct.frozenToast', { name: a.name }));
      await reload();
    } catch (err) { notify(err.message, 'error'); }
  }

  async function resetPassword(a) {
    if (!confirm(t('acct.newPasswordConfirm', { name: a.name }))) return;
    try {
      const slip = await B.resetPassword(a);
      output.replaceChildren(slipsCard([slip], t('acct.newPasswordTitle', { name: a.name })));
      output.scrollIntoView({ behavior: 'smooth' });
      await reload();
    } catch (err) { notify(err.message, 'error'); }
  }

  const createForm = h('form.stack', {
    onsubmit: onSubmit(async (fd, form) => {
      const slip = await B.createAccount(Object.fromEntries(fd));
      form.reset();
      output.replaceChildren(slipsCard([slip], t('acct.openedTitle', { acct: slip.accountNo })));
      notify(t('acct.opened', { acct: slip.accountNo, name: slip.name }));
      await reload();
    }),
  },
    field(t('acct.fullName'), h('input', { name: 'name', required: true, maxLength: 60 })),
    field(t('acct.email'), h('input', { name: 'username', required: true, maxLength: 80, autocapitalize: 'none', spellcheck: false, inputMode: 'email', placeholder: t('acct.emailPlaceholder') }),
      t('acct.emailHint')),
    field(t('acct.type'), h('select', { name: 'role' }, Object.keys(B.ROLES).map((value) => h('option', { value }, roleName(value))))),
    field(t('acct.class'), h('input', { name: 'grade', maxLength: 20, placeholder: t('acct.classPlaceholder') })),
    h('button.primary', { type: 'submit' }, t('acct.open')));

  const progress = h('p.muted');
  const importForm = h('form.stack', {
    onsubmit: onSubmit(async (fd) => {
      const rows = parseCsv(String(fd.get('csv')));
      if (!rows.length) throw new B.BankError(t('acct.classEmpty'));
      const ok = [];
      const bad = [];
      for (const [i, row] of rows.entries()) {
        progress.textContent = t('acct.creating', { i: i + 1, n: rows.length });
        try { ok.push(await B.createAccount(row)); } catch (err) { bad.push(`${row.name || row.username || '(blank)'}: ${err.message}`); }
      }
      progress.textContent = '';
      output.replaceChildren(
        bad.length ? h('section.card.span', h('h3', t('acct.skipped', { n: bad.length })), h('ul', bad.map((b) => h('li', b)))) : '',
        ok.length ? slipsCard(ok, ok.length === 1 ? t('acct.createdOne') : t('acct.createdMany', { n: ok.length })) : '');
      notify(t('acct.createdToast', { ok: ok.length, n: rows.length }), bad.length ? 'error' : 'ok');
      await reload();
    }),
  },
    field(t('acct.classLabel'), h('textarea', { name: 'csv', rows: 5, required: true, spellcheck: false,
      placeholder: 'Omar Hassan, omar.h@school.edu.eg, 5B\nLayla Farouk, layla.f@school.edu.eg, 5B\nSchool Canteen, canteen, , merchant' }),
      t('acct.classHint')),
    progress,
    h('button', { type: 'submit' }, t('acct.createAll')));

  // The self-join switch, for the Bank Office's own school email domain.
  const domain = (state.user.username.split('@')[1] || '').toLowerCase();
  const openNow = domain ? await B.getOpenDomain() : '';
  const joinSwitch = domain && h('section.card.span.join-switch',
    h('label.check-row',
      h('input', {
        type: 'checkbox', checked: openNow === domain,
        onchange: async (e) => {
          const on = e.target.checked;
          if (on && !confirm(t('acct.joinConfirm', { domain }))) {
            e.target.checked = false;
            return;
          }
          e.target.disabled = true;
          try {
            await B.setOpenDomain(on ? domain : '');
            notify(on ? t('acct.joinOn', { domain }) : t('acct.joinOff'));
          } catch (err) {
            e.target.checked = !on;
            notify(err.message, 'error');
          } finally {
            e.target.disabled = false;
          }
        },
      }),
      ` ${t('acct.joinSwitch', { domain })}`),
    h('p.muted', t('acct.joinHint')));

  return h('div.grid',
    joinSwitch,
    h('section.card', h('h3', t('acct.openTitle')), createForm),
    h('section.card', h('h3', t('acct.classTitle')), importForm),
    output,
    h('section.card.span', count, search,
      h('div.table-wrap', h('table',
        h('thead', h('tr', [t('acct.colAccount'), t('acct.colName'), t('acct.colType'), t('acct.colBalance'), ''].map((label) => h('th', label)))),
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
  const picker = recipientPicker(accounts.filter((a) => !a.frozen), { exclude: null, label: t('common.account') });
  const preview = h('p.preview', t('deposit.typeHint'));
  const egpInput = h('input', {
    name: 'egp', inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off',
    oninput: () => {
      try {
        const { aiseCents, changeEgpCents } = M.egpToAise(M.parseAmount(egpInput.value));
        preview.textContent = t('deposit.adds', { amount: M.formatAise(aiseCents) }) +
          (changeEgpCents ? t('deposit.change', { change: M.formatCents(changeEgpCents) }) : '');
      } catch { preview.textContent = t('deposit.typeHint'); }
    },
  });
  return h('section.card.narrow',
    h('h3', t('deposit.title')),
    h('p.muted', t('deposit.text')),
    h('form.stack', {
      onsubmit: onSubmit(async (fd, form) => {
        const to = picker.find();
        if (!to) throw new B.BankError(t('common.pickFromList'));
        const egpCents = M.parseAmount(fd.get('egp'));
        const { aiseCents } = M.egpToAise(egpCents);
        if (!confirm(t('deposit.confirm', { amount: M.formatAise(aiseCents), name: to.name, egp: M.formatCents(egpCents) }))) return;
        await B.deposit({ to: to.accountNo, egpCents, memo: fd.get('memo'), txId });
        txId = B.newTxId();
        form.reset();
        preview.textContent = t('deposit.typeHint');
        state.refreshBankStats?.();
        notify(t('deposit.done', { amount: M.formatAise(aiseCents), name: to.name }));
      }),
    },
      picker.el,
      field(t('deposit.egp'), egpInput),
      preview,
      field(t('common.note'), h('input', { name: 'memo', maxLength: 140 })),
      h('button.primary', { type: 'submit' }, t('deposit.button'))));
}

async function bankCashout() {
  const accounts = await B.accounts();
  let txId = B.newTxId();
  const picker = recipientPicker(accounts.filter((a) => !a.frozen), { exclude: null, label: t('common.account') });
  const selected = () => accounts.find((a) => a.accountNo === picker.find()?.accountNo);

  // Username accounts prove it's them with their password; Google accounts
  // have no password here, so the Bank Office confirms they're present.
  const passwordInput_ = h('input', { name: 'holderPassword', type: 'password', autocomplete: 'off' });
  const passwordField = field(t('cashout.password'), passwordInput_);
  const presentField = h('label.check-row', h('input', { name: 'present', type: 'checkbox' }), t('cashout.present'));
  function sync() {
    const google = selected()?.login === 'google';
    passwordField.hidden = google;
    passwordInput_.required = !google;
    presentField.hidden = !google;
  }
  picker.el.addEventListener('input', sync);
  sync();

  return h('section.card.narrow',
    h('h3', t('cashout.title')),
    h('p.muted', t('cashout.text')),
    h('form.stack', {
      onsubmit: onSubmit(async (fd, form) => {
        const account = selected();
        if (!account) throw new B.BankError(t('common.pickFromList'));
        const amount = M.parseAmount(fd.get('amount'));
        await B.withdraw({
          account, amount, holderPassword: fd.get('holderPassword'), present: fd.get('present') === 'on', memo: fd.get('memo'), txId,
        });
        txId = B.newTxId();
        account.balance -= amount;
        form.reset();
        sync();
        state.refreshBankStats?.();
        notify(t('cashout.done', { name: account.name, egp: M.formatEgp(amount) }));
      }),
    },
      picker.el,
      amountInput(),
      passwordField,
      presentField,
      field(t('common.note'), h('input', { name: 'memo', maxLength: 140 })),
      h('button.primary', { type: 'submit' }, t('cashout.button'))));
}

/**
 * Bank Office → 🎨 Look: change the name, logo, colours, font, currency name
 * and every word on the site. The header previews colours and names live;
 * leaving without saving puts the saved look back. (This editor's own labels
 * stay fixed so it can never be renamed into something confusing.)
 */
function bankLook() {
  const L = B.BRAND_LIMITS;
  const copy = (b) => ({ ...b, words: { ...(b.words || {}) }, theme: { ...(b.theme || {}) } });
  let draft = copy(state.brand);
  onLeave(() => applyBrand());
  const root = h('div.stack');

  function render() {
    applyBrand(draft);

    // -- name & logo
    const logoRow = h('div.logo-row');
    const fileInput = h('input', {
      type: 'file', accept: 'image/*', hidden: true,
      onchange: async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        try {
          draft.logo = await squareLogo(file);
          drawLogo();
          applyBrand(draft);
        } catch {
          notify('That picture didn’t work. Try a different one.', 'error');
        }
      },
    });
    function drawLogo() {
      logoRow.replaceChildren(coinEl('div.login-coin', draft),
        h('div.stack',
          h('label.button', { tabIndex: 0 }, '📷 Choose a logo picture', fileInput),
          draft.logo && h('button', { type: 'button', onclick: () => { draft.logo = ''; drawLogo(); applyBrand(draft); } }, 'Remove picture')));
    }
    drawLogo();
    const text = (key, label, hint) => field(label, h('input', {
      name: key, value: draft[key] ?? '', maxLength: L[key],
      oninput: (e) => { draft[key] = e.target.value; applyBrand(draft); },
    }), hint);

    // -- colours, font, pattern
    const color = (key, label) => field(label, h('input', {
      type: 'color', value: draft.theme[key] || DEFAULT_COLORS[key],
      oninput: (e) => { draft.theme[key] = e.target.value; applyBrand(draft); },
    }));
    const choice = (key, label, options) => field(label, h('select', {
      onchange: (e) => { draft.theme[key] = e.target.value; applyBrand(draft); },
    }, options.map(([value, name]) => h('option', { value, selected: (draft.theme[key] || options[0][0]) === value }, name))));

    // -- every word
    const search = h('input', { type: 'search', placeholder: '🔎 Find a word… (e.g. send, sign in, till)' });
    const groups = WORD_GROUPS.map(([title, items]) => {
      const rows = items.map(([key, def]) => {
        const holes = def.match(/\{\w+\}/g);
        const input = h('input', {
          value: draft.words[key] || '', placeholder: def, maxLength: 300,
          className: draft.words[key] ? 'changed' : '',
          oninput: (e) => {
            const v = e.target.value;
            if (v.trim()) draft.words[key] = v; else delete draft.words[key];
            e.target.classList.toggle('changed', Boolean(v.trim()));
          },
        });
        const row = field(def, input, holes && `Keep ${holes.join(' ')} in it — it gets filled in automatically.`);
        row.dataset.search = `${title} ${def} ${key}`.toLowerCase();
        return row;
      });
      const box = h('details.word-group', h('summary', `${title} (${items.length})`), h('div.stack', rows));
      return { box, rows };
    });
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const { box, rows } of groups) {
        let any = false;
        for (const row of rows) { const hit = !q || row.dataset.search.includes(q); row.hidden = !hit; any ||= hit; }
        box.hidden = !any;
        box.open = Boolean(q) && any;
      }
    });

    root.replaceChildren(
      h('section.card.narrow',
        h('h3', 'Make it yours 🎨'),
        h('p.muted', 'Change anything everyone sees. Colours and names preview at the top as you go — press Save to show everyone.'),
        h('div.look-section',
          h('h4', '🏷️ Name & logo'),
          h('div.stack',
            h('div.field', h('span.label', 'Logo'), logoRow),
            text('coinText', 'Coin letters (if no picture)', 'Up to 4 letters, like A$ or 🪙'),
            text('name', 'Site name'),
            text('tagline', 'Tagline (under the name)'),
            text('loginTitle', 'Sign-in greeting'),
            text('loginText', 'Sign-in message'),
            text('footer', 'Footer (bottom of every page)'))),
        h('div.look-section',
          h('h4', '🎨 Colours & style'),
          h('div.color-grid',
            color('primary', 'Buttons'),
            color('coin', 'Coin & wallet card'),
            color('paper', 'Background'),
            color('ink', 'Text')),
          h('div.color-grid',
            choice('font', 'Font', [['rounded', 'Rounded'], ['classic', 'Classic'], ['serif', 'Fancy (serif)'], ['handwritten', 'Handwritten'], ['typewriter', 'Typewriter']]),
            choice('pattern', 'Background pattern', [['dots', 'Dots'], ['grid', 'Grid'], ['lines', 'Notebook lines'], ['plain', 'Plain']])),
          h('button', { type: 'button', onclick: () => { draft.theme = {}; render(); } }, '↩️ Original colours')),
        h('div.look-section',
          h('h4', '🪙 Currency name'),
          field('What is your money called?', h('input', {
            value: draft.currency || '', placeholder: M.DEFAULT_CURRENCY, maxLength: 12,
            oninput: (e) => { draft.currency = e.target.value; applyBrand(draft); },
          }), 'Only the name changes. 1 is always worth 10 EGP, so the cash box keeps matching.')),
        h('div.look-section',
          h('h4', '✏️ Every word on the site'),
          h('p.muted', 'Type in a box to replace that word. Leave it empty to keep the original (shown in grey).'),
          search,
          groups.map((g) => g.box))),
      h('div.row.sticky-save.narrow',
        h('button', {
          type: 'button',
          onclick: () => {
            if (!confirm('Put EVERYTHING back to the original look and words? (Press Save after.)')) return;
            draft = copy(DEFAULT_BRAND);
            render();
          },
        }, '↩️ Original everything'),
        h('button.primary', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await B.saveBrand(draft);
              state.brand = copy(draft);
              renderChrome();
              notify('Saved! Everyone sees the new look now 🎉');
            } catch (err) {
              notify(err.message, 'error');
            } finally {
              e.target.disabled = false;
            }
          },
        }, 'Save')));
  }

  render();
  return root;
}

/** Turn any photo into a small square PNG (crop to the middle), so it's quick to load. */
function squareLogo(file, size = 160) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = h('canvas', { width: size, height: size });
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

function bankLedger() {
  return h('section.card',
    h('div.row', h('h3', t('ledger.title')), h('button.small', { onclick: exportCsv }, t('ledger.csv'))),
    h('p.muted', t('ledger.text')),
    txFeed((opts) => B.ledger(opts), { pageSize: 50 }));
}

async function exportCsv() {
  try {
    notify(t('ledger.preparing'));
    const [txs, name] = await Promise.all([B.allTransactions(), nameOf()]);
    // Quote every cell; prefix =+-@ so spreadsheet apps can't run formulas.
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`;
    const who = (acct) => (acct ? `${name(acct)} (${acct})` : 'BANK');
    const rows = [['Date', 'Type', 'From', 'To', M.currencyName(), 'EGP', 'Note']].concat(txs.map((tx) =>
      [tx.at.toISOString(), tx.type, who(tx.from), who(tx.to), M.plainCents(tx.amount), M.plainCents(M.toEgpCents(tx.amount)), tx.memo]));
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

// The site's look, live: when the Bank Office saves a new name or logo,
// every open page updates. The sign-in screen re-draws to show it.
B.watchBrand((saved) => {
  state.brand = { ...DEFAULT_BRAND, ...(saved || {}) };
  const path = (location.hash || '#/').split('?')[0];
  if (path === '#/bank/look') return; // don't overwrite the editor's live preview
  applyBrand();
  renderChrome();
  if (path === '#/login' && !state.user) route();
});

// Follow Google's sign-in state directly: if someone becomes signed in while
// the sign-in screen is showing, continue — even if the popup itself reported
// an error or never came back (iPad Safari). The first call is just the
// page-load state, which route() already handles.
let authKnown = false;
B.onAuthChange((isSignedIn) => {
  if (!authKnown) { authKnown = true; return; }
  const path = (location.hash || '#/').split('?')[0];
  if (isSignedIn && !state.user && (path === '#/login' || path === '#/setup')) afterSignIn();
});
if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
route();
