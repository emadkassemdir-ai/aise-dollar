/**
 * AISE Dollar — UI layer.
 *
 * All money logic lives in ledger.js (window.AISE). This file only handles
 * persistence, PIN checks, and rendering. Rendering uses the `h()` helper,
 * which sets text via textContent — user input is never parsed as HTML.
 */
(function () {
  'use strict';

  const L = window.AISE;
  const STORAGE_KEY = 'aise-dollar.v1';
  const IDLE_LOGOUT_MS = 3 * 60 * 1000; // shared school computers: log out fast
  const MAX_PIN_ATTEMPTS = 5;
  const LOCKOUT_MS = 30 * 1000;

  // ------------------------------------------------------------ persistence ---

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        return { ledger: L.validateState(data.ledger), admin: data.admin || null };
      }
    } catch (err) {
      console.error('Could not load saved data:', err);
      notify('Saved data could not be read. Starting fresh — restore a backup if you have one.', 'error');
    }
    return { ledger: L.createState(), admin: null };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (err) {
      console.error('Could not save:', err);
      notify('Could not save to this browser. Export a backup now!', 'error');
    }
  }

  // ------------------------------------------------------------------ PINs ---

  function randomSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashPin(pin, salt) {
    if (!crypto?.subtle) throw new Error('This browser cannot hash PINs securely.');
    const data = new TextEncoder().encode(`${salt}:${pin}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function assertPinFormat(pin) {
    if (!/^\d{4,6}$/.test(pin)) throw new L.LedgerError('PIN must be 4–6 digits.');
  }

  async function makePin(pin) {
    assertPinFormat(pin);
    const pinSalt = randomSalt();
    return { pinSalt, pinHash: await hashPin(pin, pinSalt) };
  }

  /** Brute-force throttle, keyed per account (or "admin"). In-memory only. */
  const attempts = new Map();

  async function checkPin(key, pin, { pinHash, pinSalt }) {
    const entry = attempts.get(key) || { fails: 0, lockedUntil: 0 };
    const wait = entry.lockedUntil - Date.now();
    if (wait > 0) throw new L.LedgerError(`Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)}s.`);

    if ((await hashPin(pin, pinSalt)) === pinHash) {
      attempts.delete(key);
      return;
    }
    entry.fails += 1;
    if (entry.fails >= MAX_PIN_ATTEMPTS) {
      entry.fails = 0;
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    attempts.set(key, entry);
    throw new L.LedgerError('Wrong PIN.');
  }

  // ------------------------------------------------------------------ state ---

  let db = load();
  const session = { view: 'wallet', walletId: null, bankUnlocked: false, bankTab: 'accounts' };

  /** Apply a ledger operation, persist, re-render. Returns the op's result. */
  function commit(result) {
    db.ledger = result.state || result;
    save();
    render();
    return result;
  }

  // ------------------------------------------------------------ DOM helpers ---

  /** h('div.card#main', {onclick}, child, 'text', [more]) → HTMLElement */
  function h(tag, props, ...children) {
    const [, name = 'div', rest = ''] = /^([a-z0-9]+)?(.*)$/i.exec(tag);
    const el = document.createElement(name);
    for (const part of rest.match(/[.#][^.#]+/g) || []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
    if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
      children.unshift(props);
      props = null;
    }
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const field = (label, input, hint) =>
    h('label.field', h('span.label', label), input, hint && h('span.hint', hint));

  let toastTimer;
  function notify(message, kind = 'ok') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.className = ''), 4000);
  }

  /** Wrap a form submit: prevent reload, surface errors, disable while busy. */
  function onSubmit(handler) {
    return async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type=submit]');
      if (button) button.disabled = true;
      try {
        await handler(new FormData(form), form);
      } catch (err) {
        if (!(err instanceof L.LedgerError)) console.error(err);
        notify(err.message, 'error');
      } finally {
        if (button && button.isConnected) button.disabled = false;
      }
    };
  }

  const fmtDate = (iso) =>
    new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  const accountLabel = (a) => `${a.name} · ${a.number}${a.grade ? ` · ${a.grade}` : ''}`;

  function accountOptions(filter = () => true, placeholder = 'Choose an account…') {
    return [
      h('option', { value: '' }, placeholder),
      ...db.ledger.accounts
        .filter(filter)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a) => h('option', { value: a.id }, accountLabel(a))),
    ];
  }

  function moneyBlock(cents, { big = false } = {}) {
    return h(
      big ? 'div.money.big' : 'div.money',
      h('span.aise', L.formatAise(cents)),
      h('span.egp', `≈ ${L.formatEgp(cents)}`)
    );
  }

  function describe(tx, perspectiveId) {
    const name = (id) => L.findAccount(db.ledger, id)?.name || 'Unknown';
    if (tx.type === 'deposit') return 'Cash deposit at Bank Office';
    if (tx.type === 'withdraw') return 'Cashed out to EGP';
    if (!perspectiveId) return `${name(tx.from)} → ${name(tx.to)}`;
    return tx.to === perspectiveId ? `From ${name(tx.from)}` : `To ${name(tx.to)}`;
  }

  function txList(items, perspectiveId) {
    if (!items.length) return h('p.empty', 'No transactions yet.');
    return h(
      'ul.txs',
      items.map((tx) => {
        const delta = perspectiveId ? tx.delta : tx.amount;
        const cls = !perspectiveId ? '' : delta > 0 ? '.in' : '.out';
        return h(
          'li',
          h(`span.badge.${tx.type}`, tx.type),
          h('div.tx-main', h('strong', describe(tx, perspectiveId)), tx.memo && h('span.memo', tx.memo)),
          h('div.tx-side',
            h(`span.amt${cls}`, `${perspectiveId && delta > 0 ? '+' : ''}${L.formatCents(delta)}`),
            h('time', { dateTime: tx.at }, fmtDate(tx.at)))
        );
      })
    );
  }

  // ---------------------------------------------------------------- wallet ---

  function renderWallet() {
    const account = session.walletId && L.findAccount(db.ledger, session.walletId);
    return account ? walletDashboard(account) : walletLogin();
  }

  function walletLogin() {
    if (!db.ledger.accounts.length) {
      return h('section.card.center',
        h('h2', 'Welcome to AISE Dollar'),
        h('p', 'No accounts exist yet. Ask the Bank Office to open one for you.'));
    }
    return h('section.card.narrow',
      h('h2', 'Sign in to your wallet'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          const account = L.findAccount(db.ledger, fd.get('account'));
          if (!account) throw new L.LedgerError('Choose your account.');
          await checkPin(account.id, fd.get('pin'), account);
          session.walletId = account.id;
          render();
          notify(`Welcome, ${account.name.split(' ')[0]}!`);
        }),
      },
        field('Account', h('select', { name: 'account', required: true }, accountOptions())),
        field('PIN', h('input', { name: 'pin', type: 'password', inputMode: 'numeric',
          autocomplete: 'current-password', pattern: '\\d{4,6}', maxLength: 6, required: true })),
        h('button.primary', { type: 'submit' }, 'Sign in')));
  }

  function walletDashboard(account) {
    const balance = L.balanceOf(db.ledger, account.id);
    return h('div.grid',
      h('section.card.balance-card',
        h('div.row',
          h('div', h('p.muted', 'Signed in as'), h('h2', account.name),
            h('p.muted', `${account.number} · ${account.kind}`)),
          h('button.ghost', { onclick: logoutWallet }, 'Sign out')),
        h('p.muted', 'Available balance'),
        moneyBlock(balance, { big: true }),
        account.frozen && h('p.warn', 'This account is frozen. Contact the Bank Office.')),

      h('section.card',
        h('h3', 'Send AISE$'),
        h('form.stack', {
          onsubmit: onSubmit(async (fd, form) => {
            const amount = L.parseAmount(fd.get('amount'));
            const to = fd.get('to');
            const recipient = L.findAccount(db.ledger, to);
            if (!recipient) throw new L.LedgerError('Choose who to send to.');
            await checkPin(account.id, fd.get('pin'), account);
            const ok = confirm(`Send ${L.formatAise(amount)} (${L.formatEgp(amount)}) to ${recipient.name}?`);
            if (!ok) return;
            commit(L.transfer(db.ledger, { from: account.id, to, amount, memo: fd.get('memo') }));
            form.reset();
            notify(`Sent ${L.formatAise(amount)} to ${recipient.name}.`);
          }),
        },
          field('To', h('select', { name: 'to', required: true },
            accountOptions((a) => a.id !== account.id && !a.frozen))),
          amountField(),
          field('Note (optional)', h('input', { name: 'memo', maxLength: 140, placeholder: 'e.g. Canteen lunch' })),
          field('Confirm with your PIN', h('input', { name: 'pin', type: 'password', inputMode: 'numeric',
            pattern: '\\d{4,6}', maxLength: 6, required: true })),
          h('button.primary', { type: 'submit', disabled: account.frozen || balance <= 0 }, 'Send'))),

      h('section.card.span',
        h('h3', 'History'),
        txList(L.historyOf(db.ledger, account.id), account.id)));
  }

  /** Amount input with a live EGP equivalent underneath. */
  function amountField(label = 'Amount (AISE$)') {
    const hint = h('span.hint', '≈ EGP 0.00');
    const input = h('input', {
      name: 'amount', inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off',
      oninput: () => {
        try { hint.textContent = `≈ ${L.formatEgp(L.parseAmount(input.value))}`; }
        catch { hint.textContent = input.value ? 'Enter a valid amount' : '≈ EGP 0.00'; }
      },
    });
    return h('label.field', h('span.label', label), input, hint);
  }

  function logoutWallet() {
    session.walletId = null;
    render();
  }

  // ------------------------------------------------------------- converter ---

  function renderConverter() {
    const aise = h('input', { id: 'conv-aise', inputMode: 'decimal', placeholder: '0.00' });
    const egp = h('input', { id: 'conv-egp', inputMode: 'decimal', placeholder: '0.00' });
    const sync = (from, to, convert) => () => {
      try { to.value = from.value ? convert(L.parseAmount(from.value)) : ''; }
      catch { to.value = ''; }
    };
    aise.addEventListener('input', sync(aise, egp, (c) => L.formatCents(L.toEgpCents(c)).replace(/,/g, '')));
    egp.addEventListener('input', sync(egp, aise, (c) => L.formatCents(L.egpToAise(c).aiseCents).replace(/,/g, '')));

    return h('section.card.narrow',
      h('h2', 'Currency converter'),
      h('p.muted', `Fixed rate: 1 AISE$ = ${L.EGP_PER_AISE} EGP. It never changes, so there are no conversion fees.`),
      h('div.converter',
        field('AISE$', aise),
        h('span.swap', { 'aria-hidden': 'true' }, '⇄'),
        field('EGP', egp)),
      h('table.ref',
        h('caption', 'Quick reference'),
        h('tbody', [1, 5, 10, 20, 50, 100].map((n) =>
          h('tr', h('td', L.formatAise(n * 100)), h('td', L.formatEgp(n * 100)))))));
  }

  // ------------------------------------------------------------ bank office ---

  function renderBank() {
    if (!db.admin) return bankSetup();
    if (!session.bankUnlocked) return bankLogin();

    const tabs = [['accounts', 'Accounts'], ['deposit', 'Deposit'], ['withdraw', 'Cash out'],
      ['ledger', 'Ledger'], ['backup', 'Backup']];
    const panels = { accounts: bankAccounts, deposit: bankDeposit, withdraw: bankWithdraw,
      ledger: bankLedger, backup: bankBackup };

    return h('div.stack',
      bankStats(),
      h('div.subtabs',
        tabs.map(([key, label]) => h('button', {
          className: session.bankTab === key ? 'active' : '',
          onclick: () => { session.bankTab = key; render(); },
        }, label)),
        h('button.ghost.lock', { onclick: () => { session.bankUnlocked = false; render(); } }, 'Lock')),
      panels[session.bankTab]());
  }

  function bankSetup() {
    return h('section.card.narrow',
      h('h2', 'Set up the Bank Office'),
      h('p.muted', 'Choose an admin PIN. Only Bank Office staff should know it — it controls deposits, cash-outs and accounts.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          if (fd.get('pin') !== fd.get('pin2')) throw new L.LedgerError('PINs do not match.');
          db.admin = await makePin(fd.get('pin'));
          session.bankUnlocked = true;
          save();
          render();
          notify('Bank Office ready. Open the first account.');
        }),
      },
        field('Admin PIN', h('input', { name: 'pin', type: 'password', inputMode: 'numeric', pattern: '\\d{4,6}', maxLength: 6, required: true })),
        field('Repeat PIN', h('input', { name: 'pin2', type: 'password', inputMode: 'numeric', pattern: '\\d{4,6}', maxLength: 6, required: true })),
        h('button.primary', { type: 'submit' }, 'Create Bank Office')));
  }

  function bankLogin() {
    return h('section.card.narrow',
      h('h2', 'Bank Office'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd) => {
          await checkPin('admin', fd.get('pin'), db.admin);
          session.bankUnlocked = true;
          render();
        }),
      },
        field('Admin PIN', h('input', { name: 'pin', type: 'password', inputMode: 'numeric', pattern: '\\d{4,6}', maxLength: 6, required: true, autofocus: true })),
        h('button.primary', { type: 'submit' }, 'Unlock')));
  }

  function bankStats() {
    const s = L.stats(db.ledger);
    const tile = (label, value, sub) => h('div.tile', h('span.muted', label), h('strong', value), sub && h('span.muted', sub));
    return h('section.tiles',
      tile('In circulation', L.formatAise(s.inCirculation)),
      tile('EGP cash reserve needed', `EGP ${L.formatCents(s.egpReserveCents)}`, 'Must match the cash box'),
      tile('Accounts', String(s.accounts)),
      tile('Transferred (all time)', L.formatAise(s.transferred), `${s.transactions} transaction${s.transactions === 1 ? '' : 's'}`));
  }

  function bankAccounts() {
    const balances = L.balances(db.ledger);
    const rows = db.ledger.accounts.slice().sort((a, b) => a.name.localeCompare(b.name));
    return h('div.grid',
      h('section.card',
        h('h3', 'Open an account'),
        h('form.stack', {
          onsubmit: onSubmit(async (fd, form) => {
            const pin = await makePin(fd.get('pin'));
            const { account } = commit(L.openAccount(db.ledger, {
              name: fd.get('name'), kind: fd.get('kind'), grade: fd.get('grade'), ...pin,
            }));
            form.reset();
            notify(`Opened ${account.number} for ${account.name}.`);
          }),
        },
          field('Full name', h('input', { name: 'name', required: true, minLength: 2, maxLength: 60 })),
          field('Type', h('select', { name: 'kind' },
            h('option', { value: 'student' }, 'Student'),
            h('option', { value: 'staff' }, 'Staff'),
            h('option', { value: 'merchant' }, 'Merchant (canteen, store, club…)'))),
          field('Grade / class (optional)', h('input', { name: 'grade', maxLength: 20, placeholder: 'e.g. 10B' })),
          field('Starting PIN', h('input', { name: 'pin', type: 'password', inputMode: 'numeric', pattern: '\\d{4,6}', maxLength: 6, required: true }),
            'Give this to the account holder privately.'),
          h('button.primary', { type: 'submit' }, 'Open account'))),

      h('section.card.span',
        h('h3', `All accounts (${rows.length})`),
        rows.length ? h('div.table-wrap', h('table',
          h('thead', h('tr', ['Account', 'Name', 'Type', 'Balance', 'EGP value', ''].map((t) => h('th', t)))),
          h('tbody', rows.map((a) => {
            const bal = balances.get(a.id) || 0;
            return h(a.frozen ? 'tr.frozen' : 'tr',
              h('td', a.number), h('td', a.name, a.grade && h('span.muted', ` · ${a.grade}`)),
              h('td', a.kind), h('td.num', L.formatCents(bal)), h('td.num', L.formatCents(L.toEgpCents(bal))),
              h('td', h('div.actions',
                h('button.small', { onclick: () => toggleFreeze(a) }, a.frozen ? 'Unfreeze' : 'Freeze'),
                h('button.small', { onclick: () => resetPin(a) }, 'Reset PIN'))));
          })))) : h('p.empty', 'No accounts yet.')));
  }

  function toggleFreeze(account) {
    const verb = account.frozen ? 'Unfreeze' : 'Freeze';
    if (!confirm(`${verb} ${account.name}'s account?`)) return;
    commit(L.updateAccount(db.ledger, account.id, { frozen: !account.frozen }));
    notify(`${account.name} ${account.frozen ? 'unfrozen' : 'frozen'}.`);
  }

  async function resetPin(account) {
    const pin = prompt(`New 4–6 digit PIN for ${account.name}:`);
    if (pin == null) return;
    try {
      commit(L.updateAccount(db.ledger, account.id, await makePin(pin.trim())));
      attempts.delete(account.id);
      notify(`PIN reset for ${account.name}.`);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  function bankDeposit() {
    const preview = h('p.preview', 'Enter the EGP cash received.');
    const egpInput = h('input', {
      name: 'egp', inputMode: 'decimal', placeholder: '0.00', required: true, autocomplete: 'off',
      oninput: () => {
        try {
          const { aiseCents, changeEgpCents } = L.egpToAise(L.parseAmount(egpInput.value));
          preview.textContent = `Credits ${L.formatAise(aiseCents)}` +
            (changeEgpCents ? ` · give back EGP ${L.formatCents(changeEgpCents)} change` : '');
        } catch { preview.textContent = 'Enter the EGP cash received.'; }
      },
    });
    return h('section.card.narrow',
      h('h3', 'Cash deposit'),
      h('p.muted', 'A student or staff member hands in Egyptian pounds; their wallet is credited at 10 EGP → 1 AISE$.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd, form) => {
          const { aiseCents } = L.egpToAise(L.parseAmount(fd.get('egp')));
          if (aiseCents <= 0) throw new L.LedgerError('Minimum deposit is EGP 0.10.');
          const account = L.findAccount(db.ledger, fd.get('to'));
          commit(L.deposit(db.ledger, { to: fd.get('to'), amount: aiseCents, memo: fd.get('memo') }));
          form.reset();
          preview.textContent = 'Enter the EGP cash received.';
          notify(`Credited ${L.formatAise(aiseCents)} to ${account.name}.`);
        }),
      },
        field('Account', h('select', { name: 'to', required: true }, accountOptions((a) => !a.frozen))),
        field('EGP cash received', egpInput),
        preview,
        field('Note (optional)', h('input', { name: 'memo', maxLength: 140, placeholder: 'Receipt #' })),
        h('button.primary', { type: 'submit' }, 'Credit account')));
  }

  function bankWithdraw() {
    return h('section.card.narrow',
      h('h3', 'Cash out to EGP'),
      h('p.muted', 'Debit AISE$ from a wallet and pay out the Egyptian pounds from the cash box. Requires the holder\'s PIN.'),
      h('form.stack', {
        onsubmit: onSubmit(async (fd, form) => {
          const account = L.findAccount(db.ledger, fd.get('from'));
          if (!account) throw new L.LedgerError('Choose an account.');
          const amount = L.parseAmount(fd.get('amount'));
          await checkPin(account.id, fd.get('pin'), account);
          commit(L.withdraw(db.ledger, { from: account.id, amount, memo: fd.get('memo') }));
          form.reset();
          notify(`Pay ${account.name} ${L.formatEgp(amount)} in cash.`);
        }),
      },
        field('Account', h('select', { name: 'from', required: true }, accountOptions((a) => !a.frozen))),
        amountField(),
        field('Account holder\'s PIN', h('input', { name: 'pin', type: 'password', inputMode: 'numeric', pattern: '\\d{4,6}', maxLength: 6, required: true })),
        field('Note (optional)', h('input', { name: 'memo', maxLength: 140 })),
        h('button.primary', { type: 'submit' }, 'Cash out')));
  }

  function bankLedger() {
    const all = db.ledger.transactions.slice().reverse();
    return h('section.card',
      h('div.row', h('h3', 'Full ledger'),
        h('button.small', { onclick: exportCsv, disabled: !all.length }, 'Export CSV')),
      txList(all.slice(0, 500), null),
      all.length > 500 && h('p.muted', `Showing newest 500 of ${all.length}. Export CSV for everything.`));
  }

  function bankBackup() {
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true,
      onchange: async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const ledger = L.validateState(data.ledger);
          if (!confirm(`Replace ALL current data with this backup (${ledger.accounts.length} accounts, ${ledger.transactions.length} transactions)?`)) return;
          db = { ledger, admin: data.admin || db.admin };
          save();
          render();
          notify('Backup restored.');
        } catch (err) {
          notify(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error');
        }
      },
    });
    return h('section.card.narrow',
      h('h3', 'Backup & restore'),
      h('p.muted', 'Everything lives in this browser. Export a backup at the end of every school day and keep it somewhere safe.'),
      h('div.stack',
        h('button.primary', { onclick: exportJson }, 'Download backup (.json)'),
        h('button', { onclick: () => fileInput.click() }, 'Restore from backup…'),
        fileInput,
        h('hr'),
        h('button.danger', { onclick: wipe }, 'Erase all data')));
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportJson() {
    download(`aise-dollar-backup-${stamp()}.json`, JSON.stringify(db, null, 2), 'application/json');
  }

  function exportCsv() {
    const name = (id) => (id ? L.findAccount(db.ledger, id)?.name ?? '' : 'BANK');
    // Quote every cell and neutralise leading =+-@ so Excel can't run formulas.
    const cell = (v) => `"${String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    const rows = [['Date', 'Type', 'From', 'To', 'AISE$', 'EGP', 'Note']].concat(
      db.ledger.transactions.map((t) => [t.at, t.type, name(t.from), name(t.to),
        L.formatCents(t.amount).replace(/,/g, ''), L.formatCents(L.toEgpCents(t.amount)).replace(/,/g, ''), t.memo]));
    download(`aise-dollar-ledger-${stamp()}.csv`, rows.map((r) => r.map(cell).join(',')).join('\r\n'), 'text/csv');
  }

  function wipe() {
    const typed = prompt('This deletes every account and transaction. Type ERASE to confirm.');
    if (typed !== 'ERASE') return;
    db = { ledger: L.createState(), admin: null };
    Object.assign(session, { walletId: null, bankUnlocked: false, bankTab: 'accounts' });
    save();
    render();
    notify('All data erased.');
  }

  // ---------------------------------------------------------------- router ---

  const views = { wallet: renderWallet, convert: renderConverter, bank: renderBank };

  function render() {
    for (const tab of document.querySelectorAll('.tabs [data-view]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === session.view));
    }
    document.getElementById('app').replaceChildren(views[session.view]());
  }

  document.querySelector('.tabs').addEventListener('click', (event) => {
    const view = event.target.closest('[data-view]')?.dataset.view;
    if (!view || view === session.view) return;
    session.view = view;
    render();
  });

  // Auto-lock wallet + bank after inactivity — essential on shared computers.
  let idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!session.walletId && !session.bankUnlocked) return;
      Object.assign(session, { walletId: null, bankUnlocked: false });
      render();
      notify('Signed out after inactivity.');
    }, IDLE_LOGOUT_MS);
  }
  ['pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, resetIdle, { passive: true }));
  resetIdle();

  // Keep multiple open tabs consistent.
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    db = load();
    if (session.walletId && !L.findAccount(db.ledger, session.walletId)) session.walletId = null;
    render();
  });

  render();
})();
