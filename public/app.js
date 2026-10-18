/**
 * AISE Dollar — browser app.
 *
 * A dependency-free single-page app. The server is the source of truth for
 * every balance and rule; this file only renders and calls the JSON API.
 * All DOM is built with `h()`, which inserts user text via text nodes, so
 * names and memos can never be interpreted as HTML.
 */
(function () {
  'use strict';

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
      else if (key === 'dataset') Object.assign(el.dataset, value);
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

  /** Works on plain-http LAN deployments too, where randomUUID is unavailable. */
  function uid() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
  }

  let toastTimer;
  function notify(message, kind = 'ok') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.className = ''), 4500);
  }

  const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeStyle: 'short' });
  const roleLabel = { student: 'Student', staff: 'Staff', merchant: 'Merchant', banker: 'Bank Office' };

  function money(cents, cls = '') {
    return h(`div.money${cls}`, h('span.aise', M.formatAise(cents)), h('span.egp', `≈ ${M.formatEgp(cents)}`));
  }

  /** Amount input showing its EGP value live underneath. */
  function amountInput({ name = 'amount', value = '', label = 'Amount (AISE$)', autofocus = false } = {}) {
    const hint = h('span.hint', '≈ EGP 0.00');
    const input = h('input', {
      name, value, inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off', autofocus,
      oninput: update,
    });
    function update() {
      try { hint.textContent = `≈ ${M.formatEgp(M.parseAmount(input.value))}`; }
      catch { hint.textContent = input.value ? 'Enter an amount like 12.50' : '≈ EGP 0.00'; }
    }
    if (value) update();
    return field(label, input, hint);
  }

  // ================================================================== api ===

  class ApiError extends Error {
    constructor(status, data) {
      super(data?.error || `Request failed (${status}).`);
      Object.assign(this, { status, data });
    }
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'x-aise': '1', ...(body && { 'content-type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, { error: 'Network error — check your connection and try again.' });
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    throw new ApiError(res.status, data);
  }

  /** Session expired or password change required mid-use → send the user
   *  to the right screen and remember where they were. Returns true if handled. */
  function handleAuthError(err) {
    if (!(err instanceof ApiError)) return false;
    if (err.status === 401 && err.data?.signedOut) {
      state.user = null;
      sessionStorageSet('returnTo', location.hash);
      notify('Your session ended. Please sign in again.', 'error');
      go('#/login');
      return true;
    }
    if (err.status === 403 && err.data?.mustChange) {
      go('#/password');
      return true;
    }
    return false;
  }

  function sessionStorageSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
  }
  function sessionStorageTake(key) {
    try { const v = sessionStorage.getItem(key); sessionStorage.removeItem(key); return v; } catch { return null; }
  }

  /** Form submit wrapper: no reload, button disabled while busy, errors toasted. */
  function onSubmit(handler) {
    return async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const buttons = [...form.querySelectorAll('button')];
      buttons.forEach((b) => (b.disabled = true));
      try {
        await handler(new FormData(form), form);
      } catch (err) {
        if (handleAuthError(err)) return;
        if (!(err instanceof ApiError || err instanceof M.MoneyError)) console.error(err);
        notify(err.message, 'error');
      } finally {
        buttons.forEach((b) => b.isConnected && (b.disabled = false));
      }
    };
  }

  // ================================================================ state ===

  const state = { user: null, directory: null, refreshBankStats: null };

  async function refreshMe() {
    state.user = (await api('GET', '/api/me')).user;
    renderChrome();
    return state.user;
  }

  async function directory(force = false) {
    if (!state.directory || force) state.directory = (await api('GET', '/api/directory')).accounts;
    return state.directory;
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
    [/^#\/pay\/([A-Za-z0-9_-]+)$/, viewPay],
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

    const [path, search = ''] = (location.hash || '#/').split('?');
    const params = new URLSearchParams(search);
    const found = routes.find(([re]) => re.test(path)) || routes[3];
    const [re, view, opts = {}] = found;
    const match = re.exec(path) || [];

    try {
      if (opts.public && !state.user) await refreshMe().catch(() => {});
      if (!opts.public) {
        if (!state.user) {
          try { await refreshMe(); } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              const { needed } = await api('GET', '/api/setup');
              if (seq !== routeSeq) return;
              sessionStorageSet('returnTo', location.hash);
              return go(needed ? '#/setup' : '#/login');
            }
            throw err;
          }
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
      if (seq !== routeSeq || handleAuthError(err)) return;
      console.error(err);
      app.replaceChildren(h('section.card.narrow',
        h('h2', 'Something went wrong'), h('p.muted', err.message),
        h('button', { onclick: () => route() }, 'Try again')));
    }
  }

  function renderChrome() {
    const u = state.user;
    const signedIn = u && !u.mustChange;
    const hash = (location.hash || '#/').split('?')[0];
    const tabs = [
      signedIn && ['#/', 'Wallet', ['#/', '#/send', '#/receive', '#/scan']],
      signedIn && ['#/till', 'Till'],
      ['#/convert', 'Converter'],
      signedIn && u.role === 'banker' && ['#/bank', 'Bank Office'],
    ].filter(Boolean);
    document.getElementById('nav').replaceChildren(...tabs.map(([href, label, also]) => {
      const active = hash === href || (also || []).includes(hash) || (href === '#/bank' && hash.startsWith('#/bank')) ||
        (href === '#/' && hash.startsWith('#/pay/'));
      return h('a', { href, 'aria-current': active ? 'page' : null }, label);
    }));
    document.getElementById('user-area').replaceChildren(u
      ? h('div.user-chip',
        h('span.user-name', u.name.split(' ')[0]),
        h('button.ghost.small', { onclick: logout }, 'Sign out'))
      : '');
  }

  async function logout() {
    try { await api('POST', '/api/logout', {}); } catch { /* already gone */ }
    state.user = null;
    state.directory = null;
    renderChrome();
    go('#/login');
  }

  // ========================================================== auth views ===

  async function viewSetup() {
    const { needed } = await api('GET', '/api/setup');
    if (!needed) { go('#/login'); return h('div'); }
    return h('section.card.narrow',
      h('h2', 'Set up AISE Dollar'),
      h('p.muted', 'Create the first Bank Office account. The setup code is printed in the server log the first time it starts.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          if (fd.get('password') !== fd.get('password2')) throw new Error('Passwords do not match.');
          const { user } = await api('POST', '/api/setup', Object.fromEntries(fd));
          state.user = user;
          notify('Bank Office ready. Open the first accounts.');
          go('#/bank/accounts');
        }),
      },
        field('Setup code', h('input', { name: 'code', required: true, autocomplete: 'off', spellcheck: false })),
        field('Your full name', h('input', { name: 'name', required: true, autocomplete: 'name' })),
        field('Username', h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none' })),
        field('Password', h('input', { name: 'password', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' }),
          'At least 8 characters with a letter and a number.'),
        field('Repeat password', h('input', { name: 'password2', type: 'password', required: true, autocomplete: 'new-password' })),
        h('button.primary', { type: 'submit' }, 'Create Bank Office account')));
  }

  function viewLogin() {
    return h('section.card.narrow.login',
      h('div.login-coin', { 'aria-hidden': 'true' }, 'A$'),
      h('h2', 'Sign in'),
      h('p.muted', 'Use the username and password from the Bank Office.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          const { user } = await api('POST', '/api/login', { username: fd.get('username'), password: fd.get('password') });
          state.user = user;
          if (user.mustChange) return go('#/password');
          notify(`Welcome, ${user.name.split(' ')[0]}!`);
          go(sessionStorageTake('returnTo') || '#/');
        }),
      },
        field('Username', h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false, autofocus: true })),
        field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        h('button.primary', { type: 'submit' }, 'Sign in')),
      h('p.muted.small-print', 'Forgot your password? Visit the Bank Office to reset it.'));
  }

  function viewPassword() {
    const forced = state.user?.mustChange;
    return h('section.card.narrow',
      h('h2', forced ? 'Choose your own password' : 'Change password'),
      forced && h('p.muted', 'You signed in with a temporary password. Pick a new one only you know.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          if (fd.get('next') !== fd.get('next2')) throw new Error('New passwords do not match.');
          await api('POST', '/api/me/password', { current: fd.get('current'), next: fd.get('next') });
          await refreshMe();
          notify('Password updated. Other devices were signed out.');
          go(sessionStorageTake('returnTo') || '#/');
        }),
      },
        field(forced ? 'Temporary password' : 'Current password',
          h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
        field('New password', h('input', { name: 'next', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' }),
          'At least 8 characters with a letter and a number.'),
        field('Repeat new password', h('input', { name: 'next2', type: 'password', required: true, autocomplete: 'new-password' })),
        h('button.primary', { type: 'submit' }, 'Save password')));
  }

  // ========================================================== wallet views ===

  function describeTx(tx) {
    const ledgerView = tx.delta === undefined; // Bank Office sees both sides
    if (tx.type === 'deposit') return ledgerView ? `Cash deposit → ${tx.to.name}` : 'Cash deposit';
    if (tx.type === 'withdraw') return ledgerView ? `${tx.from.name} cashed out` : 'Cashed out to EGP';
    if (ledgerView) return `${tx.from.name} → ${tx.to.name}`;
    return tx.delta > 0 ? `From ${tx.from.name}` : `To ${tx.to.name}`;
  }

  function txItem(tx) {
    const signed = tx.delta !== undefined;
    const value = signed ? tx.delta : tx.amount;
    return h('li',
      h(`span.badge.${tx.type}`, tx.viaQr ? 'QR' : tx.type),
      h('div.tx-main', h('strong', describeTx(tx)), tx.memo && h('span.memo', tx.memo)),
      h('div.tx-side',
        h(`span.amt${signed ? (value > 0 ? '.in' : '.out') : ''}`, `${signed && value > 0 ? '+' : ''}${M.formatCents(value)}`),
        h('time', { dateTime: tx.at }, fmtDate(tx.at))));
  }

  /** A transaction list with keyset "Load more" pagination. */
  function txFeed(path, { pageSize = 25, empty = 'No transactions yet.' } = {}) {
    const list = h('ul.txs');
    const more = h('button.ghost.more', { hidden: true, onclick: load }, 'Load more');
    let before = null;
    async function load() {
      more.disabled = true;
      try {
        const q = `?limit=${pageSize}${before ? `&before=${before}` : ''}`;
        const { transactions } = await api('GET', path + q);
        list.append(...transactions.map(txItem));
        if (transactions.length) before = transactions[transactions.length - 1].id;
        more.hidden = transactions.length < pageSize;
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
          h('div', h('p.muted', `${roleLabel[u.role]} · ${u.accountNo}${u.grade ? ` · ${u.grade}` : ''}`), h('h2', u.name)),
          h('a.ghost-link', { href: '#/password' }, 'Password')),
        h('p.muted', 'Available balance'),
        money(u.balance, '.big'),
        u.frozen && h('p.warn', 'This account is frozen. Visit the Bank Office.'),
        h('div.actions-row', actions.map(([href, label, icon]) =>
          h('a.action', { href }, h('span.action-icon', { 'aria-hidden': 'true' }, icon), label)))),
      h('section.card.span',
        h('h3', 'History'),
        txFeed('/api/me/transactions')));
  }

  /** Recipient picker: type a name or account number, with autocomplete. */
  function recipientPicker(accounts, { initial = '', exclude = state.user.accountNo, label = 'To' } = {}) {
    const listId = `dir-${uid()}`;
    const resolved = h('span.hint', 'Type a name or account number.');
    const input = h('input', {
      name: 'to', required: true, autocomplete: 'off', list: listId, value: initial,
      placeholder: 'e.g. Layla or AISE-1002', oninput: update,
    });
    const dl = h('datalist', { id: listId },
      accounts.filter((a) => a.accountNo !== exclude)
        .map((a) => h('option', { value: `${a.name} — ${a.accountNo}` })));
    function find() {
      const v = input.value.trim();
      const no = /AISE-\d+/i.exec(v)?.[0]?.toUpperCase();
      const hits = no ? accounts.filter((a) => a.accountNo === no)
        : accounts.filter((a) => a.name.toLowerCase() === v.toLowerCase());
      return hits.length === 1 && hits[0].accountNo !== exclude ? hits[0] : null;
    }
    function update() {
      const a = find();
      resolved.textContent = a ? `✓ ${a.name} · ${roleLabel[a.role]}${a.grade ? ` · ${a.grade}` : ''}` : 'Type a name or account number.';
      resolved.classList.toggle('ok', Boolean(a));
    }
    if (initial) update();
    return { el: h('label.field', h('span.label', label), input, dl, resolved), find };
  }

  async function viewSend({ params }) {
    const accounts = await directory();
    const initialTo = params.get('to') || '';
    const preset = accounts.find((a) => a.accountNo === initialTo.toUpperCase());
    const picker = recipientPicker(accounts, { initial: preset ? `${preset.name} — ${preset.accountNo}` : initialTo });
    let ref = uid(); // idempotency key: retries of this exact send can't double-charge

    const formCard = h('section.card.narrow',
      h('h2', 'Send AISE$'),
      h('p.muted', `Balance: ${M.formatAise(state.user.balance)}`),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          const to = picker.find();
          if (!to) throw new Error('Choose who to send to from the list.');
          const amount = M.parseAmount(fd.get('amount'));
          if (amount > state.user.balance) throw new Error(`You only have ${M.formatAise(state.user.balance)}.`);
          formCard.replaceWith(confirmCard(to, amount, String(fd.get('memo') || '')));
        }),
      },
        picker.el,
        amountInput({ value: params.get('amount') || '', autofocus: Boolean(preset) }),
        field('Note (optional)', h('input', { name: 'memo', maxLength: 140, value: params.get('memo') || '', placeholder: 'e.g. Lunch, book, club fee' })),
        h('button.primary', { type: 'submit' }, 'Review')));

    function confirmCard(to, amount, memo) {
      const card = h('section.card.narrow.confirm',
        h('p.muted', 'You are sending'),
        money(amount, '.big'),
        h('p', 'to ', h('strong', to.name), ` (${to.accountNo})`),
        memo && h('p.memo-line', `“${memo}”`),
        h('form.row', {
          onsubmit: onSubmit(async () => {
            const res = await api('POST', '/api/transfer', { to: to.accountNo, amount: M.plainCents(amount), memo, ref });
            ref = uid();
            state.user.balance = res.balance;
            card.replaceWith(successCard(`Sent ${M.formatAise(amount)} to ${to.name}`, res.balance));
          }),
        },
          h('button', { type: 'button', onclick: () => card.replaceWith(formCard) }, 'Back'),
          h('button.primary', { type: 'submit' }, 'Confirm & send')));
      return card;
    }

    return h('div', formCard);
  }

  function successCard(title, balance) {
    return h('section.card.narrow.success',
      h('div.check', { 'aria-hidden': 'true' }, '✓'),
      h('h2', title),
      balance !== undefined && h('p.muted', `New balance: ${M.formatAise(balance)} (${M.formatEgp(balance)})`),
      h('div.row.center-row',
        h('a.button', { href: '#/' }, 'Back to wallet'),
        h('a.button.primary', { href: '#/send' }, 'Send again')));
  }

  // ================================================================== QR ===

  /** Draw a QR code onto a canvas. Error correction M survives smudged screens. */
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
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return canvas;
  }

  const appUrl = (hash) => `${location.origin}${location.pathname}${hash}`;

  function viewReceive() {
    const u = state.user;
    const link = appUrl(`#/send?to=${encodeURIComponent(u.accountNo)}`);
    return h('div.grid',
      h('section.card.center',
        h('h2', 'Receive AISE$'),
        h('p.muted', 'Let the payer scan this code with their phone camera, or tell them your account number.'),
        h('div.qr-wrap', qrCanvas(link)),
        h('p.account-big', u.accountNo),
        h('p', u.name),
        h('button', { onclick: () => copy(link) }, 'Copy payment link')),
      h('section.card.center',
        h('h3', 'Need an exact amount?'),
        h('p.muted', 'Create a one-time payment code. It closes automatically once paid.'),
        h('a.button.primary', { href: '#/till' }, 'Request a payment')));
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      notify('Link copied.');
    } catch {
      prompt('Copy this link:', text);
    }
  }

  // =================================================================== till ===

  /**
   * Point of sale. The cashier enters an amount → a one-time QR appears →
   * the customer scans and confirms on their phone → the till turns green.
   */
  function viewTill() {
    const u = state.user;
    const container = h('div.till');
    let poll = null;
    onLeave(() => clearInterval(poll));

    const QUICK = [5, 10, 15, 20, 25, 50];

    function entry(prefill = '') {
      clearInterval(poll);
      const amount = amountInput({ value: prefill, label: 'Charge (AISE$)', autofocus: true });
      const input = amount.querySelector('input');
      container.replaceChildren(h('section.card.narrow',
        h('h2', u.role === 'merchant' ? `${u.name} till` : 'Request a payment'),
        h('p.muted', 'Enter the amount, then show the customer the QR code.'),
        h('form.stack', {
          onsubmit: onSubmit(async (fd) => {
            const cents = M.parseAmount(fd.get('amount'));
            const { request } = await api('POST', '/api/requests', { amount: M.plainCents(cents), memo: fd.get('memo') });
            showCode(request);
          }),
        },
          amount,
          h('div.quick', QUICK.map((n) => h('button', {
            type: 'button',
            onclick: () => { input.value = String(n); input.dispatchEvent(new Event('input')); },
          }, `${n}`))),
          field('Item / note (optional)', h('input', { name: 'memo', maxLength: 140, placeholder: 'e.g. Chicken wrap + juice' })),
          h('button.primary.big-btn', { type: 'submit' }, 'Show payment code'))),
        todaysSales());
    }

    function showCode(request) {
      const status = h('p.status.waiting', 'Waiting for payment…');
      const timer = h('span.muted');
      container.replaceChildren(h('section.card.center.till-code',
        h('p.muted', `Pay ${request.merchant.name}`),
        money(request.amount, '.big'),
        request.memo && h('p.memo-line', request.memo),
        h('div.qr-wrap', qrCanvas(appUrl(`#/pay/${request.id}`), 300)),
        h('p.muted', 'Scan with your phone camera'),
        status,
        timer,
        h('div.row.center-row',
          h('button', { onclick: cancel }, 'Cancel'),
          h('button.ghost', { onclick: () => copy(appUrl(`#/pay/${request.id}`)) }, 'Copy link'))));

      async function cancel() {
        clearInterval(poll);
        try { await api('POST', `/api/requests/${request.id}/cancel`, {}); } catch { /* already closed */ }
        entry();
      }

      const expires = new Date(request.expiresAt).getTime();
      let busy = false;
      async function check() {
        const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
        timer.textContent = `Code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        if (busy) return;
        busy = true;
        try {
          const { request: r } = await api('GET', `/api/requests/${request.id}`);
          if (r.status === 'paid') return paid(r);
          if (r.status !== 'open') {
            clearInterval(poll);
            status.textContent = r.status === 'expired' ? 'This code expired.' : 'Cancelled.';
            status.className = 'status failed';
          }
        } catch { /* transient network blip: keep polling */ } finally {
          busy = false;
        }
      }
      poll = setInterval(check, 1500);
      check();
    }

    function paid(r) {
      clearInterval(poll);
      chime();
      container.replaceChildren(h('section.card.center.success.till-paid',
        h('div.check', { 'aria-hidden': 'true' }, '✓'),
        h('h2', 'Paid'),
        money(r.amount, '.big'),
        h('p', 'by ', h('strong', r.paidBy)),
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
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.12 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.12 + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.12);
        osc.stop(ctx.currentTime + i * 0.12 + 0.3);
      });
      setTimeout(() => ctx.close(), 800);
    } catch { /* audio is optional */ }
  }

  function todaysSales() {
    const body = h('div', h('p.muted', 'Loading…'));
    api('GET', '/api/me/transactions?limit=200').then(({ transactions }) => {
      const today = new Date().toDateString();
      const sales = transactions.filter((t) => t.delta > 0 && t.type === 'transfer' && new Date(t.at).toDateString() === today);
      const total = sales.reduce((s, t) => s + t.amount, 0);
      body.replaceChildren(
        h('div.row', h('strong', `${sales.length} payment${sales.length === 1 ? '' : 's'} today`), h('strong', M.formatAise(total))),
        sales.length ? h('ul.txs.compact', sales.slice(0, 10).map((t) =>
          h('li', h('span.muted', fmtTime(t.at)), h('div.tx-main', h('strong', t.from.name), t.memo && h('span.memo', t.memo)),
            h('span.amt.in', `+${M.formatCents(t.amount)}`)))) : h('p.empty', 'No payments yet today.'));
    }).catch(() => body.replaceChildren(h('p.muted', 'Could not load sales.')));
    return h('section.card.narrow', h('h3', 'Today'), body);
  }

  // ================================================================= pay ===

  async function viewPay({ match }) {
    const id = match[1];
    const { request } = await api('GET', `/api/requests/${id}`);
    const container = h('div');

    if (request.status !== 'open') {
      const text = { paid: `Already paid${request.paidBy ? ` by ${request.paidBy}` : ''}.`, cancelled: 'This request was cancelled.', expired: 'This code has expired. Ask for a new one.' };
      return h('section.card.narrow.center', h('h2', 'Payment unavailable'), h('p.muted', text[request.status]), h('a.button', { href: '#/' }, 'Back to wallet'));
    }

    const short = request.amount > state.user.balance;
    container.append(h('section.card.narrow.confirm',
      h('p.muted', 'Pay'),
      h('h2', request.merchant.name),
      money(request.amount, '.big'),
      request.memo && h('p.memo-line', request.memo),
      h('p.muted', `Your balance: ${M.formatAise(state.user.balance)}`),
      short && h('p.warn', 'Not enough AISE$. Top up at the Bank Office.'),
      h('form.row', {
        onsubmit: onSubmit(async () => {
          const res = await api('POST', `/api/requests/${id}/pay`, {});
          state.user.balance = res.balance;
          container.replaceChildren(successCard(`Paid ${M.formatAise(request.amount)} to ${request.merchant.name}`, res.balance));
        }),
      },
        h('a.button', { href: '#/' }, 'Cancel'),
        h('button.primary', { type: 'submit', disabled: short }, `Pay ${M.formatAise(request.amount)}`))));
    return container;
  }

  // ================================================================ scan ===

  /** In-app scanner using the native BarcodeDetector where supported
   *  (Chrome/Edge on Android). Everywhere else, the phone camera app works. */
  async function viewScan() {
    const supported = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia && window.isSecureContext;
    if (!supported) {
      return h('section.card.narrow.center',
        h('h2', 'Scan to pay'),
        h('p', 'Open your phone’s ', h('strong', 'Camera app'), ' and point it at the AISE$ QR code. Tap the link that appears and it opens right here, ready to pay.'),
        h('p.muted', 'In-app scanning needs Chrome on Android and an https:// address.'),
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
          if (codes.length) msg.textContent = 'That QR code is not an AISE$ code.';
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (err) {
        msg.textContent = err.name === 'NotAllowedError' ? 'Camera permission was denied.' : `Camera unavailable: ${err.message}`;
      }
    })();

    return h('section.card.narrow.center', h('h2', 'Scan to pay'), video, msg, h('a.button', { href: '#/' }, 'Cancel'));
  }

  /** Only follow QR links to this very site — never navigate to arbitrary URLs. */
  function isOurLink(text) {
    try {
      const url = new URL(text);
      return url.origin === location.origin && /^#\/(pay\/[A-Za-z0-9_-]+|send\?)/.test(url.hash);
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
      h('h2', 'Currency converter'),
      h('p.muted', `Fixed rate: 1 AISE$ = ${M.EGP_PER_AISE} EGP. It never changes and there are no fees.`),
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
      const { stats } = await api('GET', '/api/admin/stats');
      tiles.replaceChildren(
        tile('In circulation', M.formatAise(stats.inCirculation)),
        tile('EGP cash reserve', `EGP ${M.formatCents(stats.egpReserve)}`, 'Must match the cash box'),
        tile('Accounts', String(stats.users)),
        tile('Spent today', M.formatAise(stats.today), `${stats.transactions} transaction${stats.transactions === 1 ? '' : 's'} all time`));
    }
    state.refreshBankStats = () => refreshStats().catch(() => {});
    onLeave(() => (state.refreshBankStats = null));
    const [panel] = await Promise.all([(panels[tab] || bankAccounts)(), refreshStats()]);
    return h('div.stack',
      tiles,
      h('div.subtabs', tabs.map(([key, label]) =>
        h('a', { href: `#/bank/${key}`, 'aria-current': key === tab ? 'page' : null }, label))),
      panel);
  }

  /** A printable slip with someone's first-time login details. */
  function credentialSlip({ name, username, accountNo, tempPassword }) {
    return h('div.slip',
      h('div.slip-head', h('span.coin.small', 'A$'), h('strong', 'AISE Dollar — your account')),
      h('dl',
        h('dt', 'Name'), h('dd', name),
        h('dt', 'Account'), h('dd', accountNo || '—'),
        h('dt', 'Username'), h('dd.mono', username),
        h('dt', 'Temporary password'), h('dd.mono', tempPassword)),
      h('p.muted', `Sign in at ${location.host} — you’ll be asked to choose your own password.`));
  }

  function slipsCard(slips, title) {
    return h('section.card.span.slips-card',
      h('div.row', h('h3', title), h('button.primary', { onclick: () => window.print() }, 'Print slips')),
      h('p.warn', 'Temporary passwords are shown only once. Print or hand them out now.'),
      h('div.slips', slips.map(credentialSlip)));
  }

  async function bankAccounts() {
    const { users } = await api('GET', '/api/admin/users');
    const output = h('div.span');
    const search = h('input', { type: 'search', placeholder: 'Search name, username, account or grade…', oninput: filter });
    const tbody = h('tbody');
    const count = h('h3');

    function rows(list) {
      return list.map((a) => h(a.frozen ? 'tr.frozen' : 'tr',
        h('td.mono', a.accountNo),
        h('td', h('strong', a.name), h('div.muted', `@${a.username}${a.grade ? ` · ${a.grade}` : ''}`)),
        h('td', roleLabel[a.role]),
        h('td.num', M.formatCents(a.balance)),
        h('td', h('div.actions',
          h('button.small', { onclick: () => toggleFreeze(a) }, a.frozen ? 'Unfreeze' : 'Freeze'),
          h('button.small', { onclick: () => resetPassword(a) }, 'Reset password')))));
    }
    function filter() {
      const q = search.value.trim().toLowerCase();
      const shown = users.filter((a) =>
        !q || [a.name, a.username, a.accountNo, a.grade].some((v) => v.toLowerCase().includes(q)));
      tbody.replaceChildren(...rows(shown));
      count.textContent = q ? `Accounts (${shown.length} of ${users.length})` : `All accounts (${users.length})`;
      state.refreshBankStats?.();
    }
    filter();

    async function toggleFreeze(a) {
      if (!confirm(`${a.frozen ? 'Unfreeze' : 'Freeze'} ${a.name}'s account?${a.frozen ? '' : ' They will be signed out and cannot pay or be paid.'}`)) return;
      try {
        await api('PATCH', `/api/admin/users/${a.id}`, { frozen: !a.frozen });
        notify(`${a.name} ${a.frozen ? 'unfrozen' : 'frozen'}.`);
        route();
      } catch (err) { notify(err.message, 'error'); }
    }

    async function resetPassword(a) {
      if (!confirm(`Reset ${a.name}'s password? They will be signed out everywhere.`)) return;
      try {
        const { tempPassword } = await api('POST', `/api/admin/users/${a.id}/reset-password`, {});
        output.replaceChildren(slipsCard([{ ...a, tempPassword }], `New password for ${a.name}`));
        output.scrollIntoView({ behavior: 'smooth' });
      } catch (err) { notify(err.message, 'error'); }
    }

    const createForm = h('form.stack', {
      onsubmit: onSubmit(async (fd, form) => {
        const { user, tempPassword } = await api('POST', '/api/admin/users', Object.fromEntries(fd));
        form.reset();
        state.directory = null;
        users.push({ ...user, balance: 0 });
        users.sort((x, y) => x.name.localeCompare(y.name));
        filter();
        output.replaceChildren(slipsCard([{ ...user, tempPassword }], `Account opened: ${user.accountNo}`));
        notify(`Opened ${user.accountNo} for ${user.name}.`);
      }),
    },
      field('Full name', h('input', { name: 'name', required: true, maxLength: 60 })),
      field('Username', h('input', { name: 'username', required: true, maxLength: 40, autocapitalize: 'none', spellcheck: false, placeholder: 'e.g. omar.hassan' })),
      field('Type', h('select', { name: 'role' },
        Object.entries(roleLabel).map(([value, label]) => h('option', { value }, label)))),
      field('Grade / class (optional)', h('input', { name: 'grade', maxLength: 20, placeholder: 'e.g. 10B' })),
      h('button.primary', { type: 'submit' }, 'Open account'));

    const importForm = h('form.stack', {
      onsubmit: onSubmit(async (fd) => {
        const rows = parseCsv(String(fd.get('csv')));
        if (!rows.length) throw new Error('Paste at least one line: name, username, grade, role');
        const { results } = await api('POST', '/api/admin/users/import', { rows });
        const ok = results.filter((r) => r.ok);
        const bad = results.filter((r) => !r.ok);
        state.directory = null;
        output.replaceChildren(
          bad.length ? h('section.card.span', h('h3', `${bad.length} row(s) skipped`),
            h('ul', bad.map((r) => h('li', `${r.name || r.username || '(blank)'}: ${r.error}`)))) : '',
          ok.length ? slipsCard(ok, `${ok.length} account(s) created`) : '');
        notify(`Imported ${ok.length} of ${results.length}.`, bad.length ? 'error' : 'ok');
        const refreshed = await api('GET', '/api/admin/users');
        users.splice(0, users.length, ...refreshed.users);
        filter();
      }),
    },
      field('One account per line', h('textarea', { name: 'csv', rows: 5, required: true, spellcheck: false,
        placeholder: 'Omar Hassan, omar.hassan, 10B, student\nLayla Farouk, layla.farouk, 10B\nSchool Canteen, canteen, , merchant' }),
        'Format: name, username, grade, role (role defaults to student). Max 200 per import.'),
      h('button', { type: 'submit' }, 'Import accounts'));

    return h('div.grid',
      h('section.card', h('h3', 'Open an account'), createForm),
      h('section.card', h('h3', 'Bulk import'), importForm),
      output,
      h('section.card.span',
        count,
        search,
        h('div.table-wrap', h('table',
          h('thead', h('tr', ['Account', 'Name', 'Type', 'AISE$', ''].map((t) => h('th', t)))),
          tbody))));
  }

  function parseCsv(text) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .filter((line) => !/^name\s*,\s*username/i.test(line)) // skip a header row
      .map((line) => {
        const [name = '', username = '', grade = '', role = ''] = line.split(/[,\t;]/).map((s) => s.trim());
        return { name, username, grade, role: role.toLowerCase() || 'student' };
      });
  }

  async function bankDeposit() {
    const accounts = await directory(true);
    let ref = uid();
    const preview = h('p.preview', 'Enter the EGP cash received.');
    const egpInput = h('input', {
      name: 'egp', inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off',
      oninput: () => {
        try {
          const { aiseCents, changeEgpCents } = M.egpToAise(M.parseAmount(egpInput.value));
          preview.textContent = `Credits ${M.formatAise(aiseCents)}${changeEgpCents ? ` · give back EGP ${M.formatCents(changeEgpCents)} change` : ''}`;
        } catch { preview.textContent = 'Enter the EGP cash received.'; }
      },
    });
    const picker = accountPicker(accounts);
    return h('section.card.narrow',
      h('h3', 'Cash deposit'),
      h('p.muted', 'Take Egyptian pounds and credit the wallet at 10 EGP → 1 AISE$.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd, form) => {
          const to = picker.find();
          if (!to) throw new Error('Choose an account from the list.');
          const egp = M.parseAmount(fd.get('egp'));
          const { aiseCents } = M.egpToAise(egp);
          if (!confirm(`Credit ${M.formatAise(aiseCents)} to ${to.name} for EGP ${M.formatCents(egp)} cash?`)) return;
          const res = await api('POST', '/api/admin/deposit', { to: to.accountNo, egp: M.plainCents(egp), memo: fd.get('memo'), ref });
          ref = uid();
          form.reset();
          preview.textContent = 'Enter the EGP cash received.';
          state.refreshBankStats?.();
          notify(`Credited ${M.formatAise(res.transaction.amount)} to ${to.name}.`);
        }),
      },
        picker.el,
        field('EGP cash received', egpInput),
        preview,
        field('Receipt / note (optional)', h('input', { name: 'memo', maxLength: 140 })),
        h('button.primary', { type: 'submit' }, 'Credit account')));
  }

  async function bankCashout() {
    const accounts = await directory(true);
    let ref = uid();
    const picker = accountPicker(accounts);
    return h('section.card.narrow',
      h('h3', 'Cash out to EGP'),
      h('p.muted', 'The account holder types their own password. Then pay them the EGP shown.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd, form) => {
          const from = picker.find();
          if (!from) throw new Error('Choose an account from the list.');
          const amount = M.parseAmount(fd.get('amount'));
          await api('POST', '/api/admin/withdraw', {
            from: from.accountNo, amount: M.plainCents(amount), holderPassword: fd.get('holderPassword'), memo: fd.get('memo'), ref,
          });
          ref = uid();
          form.reset();
          state.refreshBankStats?.();
          notify(`Done. Pay ${from.name} ${M.formatEgp(amount)} in cash.`);
        }),
      },
        picker.el,
        amountInput(),
        field('Account holder’s password', h('input', { name: 'holderPassword', type: 'password', required: true, autocomplete: 'off' })),
        field('Note (optional)', h('input', { name: 'memo', maxLength: 140 })),
        h('button.primary', { type: 'submit' }, 'Cash out')));
  }

  /** Same picker as Send, but every account is selectable (incl. your own). */
  const accountPicker = (accounts) => recipientPicker(accounts, { exclude: null, label: 'Account' });

  function bankLedger() {
    return h('section.card',
      h('div.row', h('h3', 'Full ledger'), h('a.button.small', { href: '/api/admin/export.csv', download: '' }, 'Export CSV')),
      h('p.muted', 'Every transaction ever made. Entries can never be edited or deleted.'),
      txFeed('/api/admin/transactions', { pageSize: 50 }));
  }

  // ================================================================= boot ===

  window.addEventListener('hashchange', route);
  if (!location.hash) history.replaceState(null, '', '#/');
  route();
})();
