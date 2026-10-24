// Security-rules tests: every way a student might try to fake money.
// Run with:  npm run test:rules   (starts the Firestore emulator for you)
import { readFileSync } from 'node:fs';
import { test, before, after, beforeEach } from 'node:test';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
  collection, query, where, getDocs, Timestamp, increment,
} from 'firebase/firestore';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-aise',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env.cleanup());

const PEOPLE = {
  bank: { acct: 'AISE-1001', role: 'banker', name: 'Ms. Nadia', balance: 0 },
  omar: { acct: 'AISE-1002', role: 'student', name: 'Omar Hassan', balance: 1000 },
  layla: { acct: 'AISE-1003', role: 'student', name: 'Layla Farouk', balance: 0 },
  canteen: { acct: 'AISE-1004', role: 'merchant', name: 'School Canteen', balance: 0 },
};

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'config/bank'), { setupBy: 'bank', nextAccount: 1005 });
    for (const [uid, p] of Object.entries(PEOPLE)) {
      await setDoc(doc(db, `users/${uid}`), { username: uid, accountNo: p.acct, role: p.role, mustChange: false, disabled: false });
      await setDoc(doc(db, `wallets/${p.acct}`), { uid, name: p.name, role: p.role, grade: '', balance: p.balance, frozen: false, lastTx: '' });
      await setDoc(doc(db, `directory/${p.acct}`), { name: p.name, role: p.role, grade: '', frozen: false });
      await setDoc(doc(db, `logins/${uid}`), { email: `${uid}@aise-dollar.app`, accountNo: p.acct });
    }
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
let n = 0;
const newId = () => `tx${++n}${Date.now()}`;

function transfer(db, { uid, from, to, amount, debit = amount, credit = amount, fromBal, toBal, txId = newId(), requestId }) {
  const batch = writeBatch(db);
  batch.set(doc(db, `transactions/${txId}`), {
    type: 'transfer', from, to, amount, memo: '', actor: uid, createdAt: serverTimestamp(),
    parties: [from, to], ...(requestId && { requestId }),
  });
  batch.update(doc(db, `wallets/${from}`), { balance: fromBal - debit, lastTx: txId });
  batch.update(doc(db, `wallets/${to}`), { balance: toBal + credit, lastTx: txId });
  return { commit: () => batch.commit(), batch, txId };
}

test('a normal transfer from your own wallet works', async () => {
  const db = as('omar');
  await assertSucceeds(transfer(db, { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 250, fromBal: 1000, toBal: 0 }).commit());
});

test('cannot overdraw', async () => {
  await assertFails(transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 1001, fromBal: 1000, toBal: 0 }).commit());
});

test("cannot spend someone else's money", async () => {
  await assertFails(transfer(as('layla'), { uid: 'layla', from: 'AISE-1002', to: 'AISE-1003', amount: 500, fromBal: 1000, toBal: 0 }).commit());
});

test('cannot just edit your own balance', async () => {
  const db = as('layla');
  await assertFails(updateDoc(doc(db, 'wallets/AISE-1003'), { balance: 999999 }));
  await assertFails(updateDoc(doc(db, 'wallets/AISE-1003'), { balance: 999999, lastTx: 'made-up' }));
});

test('cannot send 1 cent but credit 100', async () => {
  await assertFails(transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 1, credit: 100, fromBal: 1000, toBal: 0 }).commit());
});

test('cannot replay an old transaction to get paid twice', async () => {
  const t = transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 100, fromBal: 1000, toBal: 0 });
  await assertSucceeds(t.commit());
  const layla = as('layla');
  await updateDoc(doc(layla, 'wallets/AISE-1003'), { balance: 200, lastTx: 'reset' }).catch(() => {});
  await assertFails(updateDoc(doc(layla, 'wallets/AISE-1003'), { balance: 200, lastTx: t.txId }));
});

test('cannot pay into a different wallet than the transaction says', async () => {
  const db = as('omar');
  const txId = newId();
  const batch = writeBatch(db);
  batch.set(doc(db, `transactions/${txId}`), { type: 'transfer', from: 'AISE-1002', to: 'AISE-1003', amount: 100, memo: '', actor: 'omar', createdAt: serverTimestamp(), parties: ['AISE-1002', 'AISE-1003'] });
  batch.update(doc(db, 'wallets/AISE-1002'), { balance: 900, lastTx: txId });
  batch.update(doc(db, 'wallets/AISE-1004'), { balance: 100, lastTx: txId });
  await assertFails(batch.commit());
});

test('only the Bank Office can create money (deposit)', async () => {
  const deposit = (db, uid) => {
    const txId = newId();
    const batch = writeBatch(db);
    batch.set(doc(db, `transactions/${txId}`), { type: 'deposit', from: null, to: 'AISE-1003', amount: 5000, memo: '', actor: uid, createdAt: serverTimestamp(), parties: ['AISE-1003'] });
    batch.update(doc(db, 'wallets/AISE-1003'), { balance: 5000, lastTx: txId });
    return batch.commit();
  };
  await assertFails(deposit(as('layla'), 'layla'));
  await assertSucceeds(deposit(as('bank'), 'bank'));
});

test('the ledger cannot be edited or deleted, even by the Bank Office', async () => {
  const t = transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 100, fromBal: 1000, toBal: 0 });
  await t.commit();
  await assertFails(updateDoc(doc(as('bank'), `transactions/${t.txId}`), { amount: 1 }));
  await assertFails(deleteDoc(doc(as('bank'), `transactions/${t.txId}`)));
});

test("you can read your own history but not other people's", async () => {
  const t = transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 100, fromBal: 1000, toBal: 0 });
  await t.commit();
  await assertSucceeds(getDoc(doc(as('layla'), `transactions/${t.txId}`)));
  await assertFails(getDoc(doc(as('canteen'), `transactions/${t.txId}`)));
  const mine = query(collection(as('layla'), 'transactions'), where('parties', 'array-contains', 'AISE-1003'));
  await assertSucceeds(getDocs(mine));
  const snoop = query(collection(as('canteen'), 'transactions'), where('parties', 'array-contains', 'AISE-1003'));
  await assertFails(getDocs(snoop));
});

test('frozen accounts cannot pay or be paid', async () => {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'wallets/AISE-1003'), { frozen: true }));
  await assertFails(transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 100, fromBal: 1000, toBal: 0 }).commit());
});

test('a disabled (old) login cannot spend', async () => {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/omar'), { disabled: true }));
  await assertFails(transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 100, fromBal: 1000, toBal: 0 }).commit());
});

test('QR request: pay once with the exact amount; no double pay', async () => {
  const canteen = as('canteen');
  await assertSucceeds(setDoc(doc(canteen, 'requests/r1'), {
    merchant: 'AISE-1004', merchantName: 'School Canteen', amount: 300, memo: 'Wrap', status: 'open', createdAt: serverTimestamp(),
  }));

  const pay = (uid, from, fromBal, amount = 300) => {
    const db = as(uid);
    const t = transfer(db, { uid, from, to: 'AISE-1004', amount, fromBal, toBal: 0, requestId: 'r1' });
    t.batch.update(doc(db, 'requests/r1'), { status: 'paid', paidBy: from, paidByName: PEOPLE[uid].name, txId: t.txId });
    return t.commit();
  };
  await assertFails(pay('omar', 'AISE-1002', 1000, 1)); // wrong amount
  await assertSucceeds(pay('omar', 'AISE-1002', 1000));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'wallets/AISE-1003'), { balance: 1000 }));
  await assertFails(pay('layla', 'AISE-1003', 1000)); // already paid
});

test('QR request: cannot pay a cancelled or expired code; only the owner cancels', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'requests/old'), { merchant: 'AISE-1004', merchantName: 'School Canteen', amount: 100, memo: '', status: 'open', createdAt: Timestamp.fromMillis(Date.now() - 16 * 60 * 1000) });
    await setDoc(doc(db, 'requests/c1'), { merchant: 'AISE-1004', merchantName: 'School Canteen', amount: 100, memo: '', status: 'open', createdAt: Timestamp.now() });
  });
  const pay = (id) => {
    const db = as('omar');
    const t = transfer(db, { uid: 'omar', from: 'AISE-1002', to: 'AISE-1004', amount: 100, fromBal: 1000, toBal: 0, requestId: id });
    t.batch.update(doc(db, `requests/${id}`), { status: 'paid', paidBy: 'AISE-1002', paidByName: 'Omar Hassan', txId: t.txId });
    return t.commit();
  };
  await assertFails(pay('old'));
  await assertFails(updateDoc(doc(as('omar'), 'requests/c1'), { status: 'cancelled' }));
  await assertSucceeds(updateDoc(doc(as('canteen'), 'requests/c1'), { status: 'cancelled' }));
  await assertFails(pay('c1'));
});

test("cannot create a request in someone else's name", async () => {
  await assertFails(setDoc(doc(as('omar'), 'requests/fake'), {
    merchant: 'AISE-1004', merchantName: 'School Canteen', amount: 300, memo: '', status: 'open', createdAt: serverTimestamp(),
  }));
});

test('students cannot promote themselves, but can clear mustChange', async () => {
  const db = as('omar');
  await assertFails(updateDoc(doc(db, 'users/omar'), { role: 'banker' }));
  await assertSucceeds(updateDoc(doc(db, 'users/omar'), { mustChange: false }));
  await assertFails(setDoc(doc(db, 'wallets/AISE-2000'), { uid: 'omar', name: 'Fake', role: 'student', grade: '', balance: 0, frozen: false, lastTx: '' }));
});

test('usernames can be looked up one at a time but not listed', async () => {
  const anon = env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(anon, 'logins/omar')));
  await assertFails(getDocs(collection(anon, 'logins')));
  await assertFails(getDoc(doc(anon, 'wallets/AISE-1002')));
});

test('first-run setup: one person becomes Bank Office, then nobody else can', async () => {
  await env.clearFirestore();
  const setup = (uid) => {
    const db = as(uid);
    const batch = writeBatch(db);
    batch.set(doc(db, 'config/bank'), { setupBy: uid, nextAccount: 1002 });
    batch.set(doc(db, `users/${uid}`), { username: uid, accountNo: 'AISE-1001', role: 'banker', mustChange: false, disabled: false });
    batch.set(doc(db, `logins/${uid}`), { email: `${uid}@aise-dollar.app`, accountNo: 'AISE-1001' });
    batch.set(doc(db, 'wallets/AISE-1001'), { uid, name: 'Teacher', role: 'banker', grade: '', balance: 0, frozen: false, lastTx: '' });
    return batch.commit();
  };
  await assertSucceeds(setup('teacher'));
  await assertFails(setup('intruder'));
});

test('balances are private; the name directory is not', async () => {
  await assertSucceeds(getDoc(doc(as('omar'), 'wallets/AISE-1002')));
  await assertFails(getDoc(doc(as('omar'), 'wallets/AISE-1003')));
  await assertSucceeds(getDoc(doc(as('bank'), 'wallets/AISE-1003')));
  await assertSucceeds(getDocs(collection(as('omar'), 'directory')));
  await assertFails(updateDoc(doc(as('omar'), 'directory/AISE-1002'), { name: 'Hacker' }));
});

test('atomic increments (what the app uses) pass the same checks', async () => {
  const db = as('omar');
  const send = (amount) => {
    const txId = newId();
    const batch = writeBatch(db);
    batch.set(doc(db, `transactions/${txId}`), { type: 'transfer', from: 'AISE-1002', to: 'AISE-1003', amount, memo: '', actor: 'omar', createdAt: serverTimestamp(), parties: ['AISE-1002', 'AISE-1003'] });
    batch.update(doc(db, 'wallets/AISE-1002'), { balance: increment(-amount), lastTx: txId });
    batch.update(doc(db, 'wallets/AISE-1003'), { balance: increment(amount), lastTx: txId });
    return batch.commit();
  };
  await assertSucceeds(send(600));
  await assertFails(send(600)); // only 400 left
  await assertSucceeds(send(400));
});

// ---------------------------------------------------------------- Google sign-in

const google = (uid, email, provider = 'google.com', verified = true) =>
  env.authenticatedContext(uid, { email, email_verified: verified, firebase: { sign_in_provider: provider } }).firestore();

async function inviteSara() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'wallets/AISE-1005'), { uid: '', name: 'Sara Adel', role: 'student', grade: '5B', balance: 0, frozen: false, lastTx: '' });
    await setDoc(doc(db, 'directory/AISE-1005'), { name: 'Sara Adel', role: 'student', grade: '5B', frozen: false });
    await setDoc(doc(db, 'invites/sara@school.edu.eg'), { accountNo: 'AISE-1005', role: 'student' });
  });
}

function claim(db, uid, email, acct = 'AISE-1005', role = 'student') {
  const batch = writeBatch(db);
  batch.set(doc(db, `users/${uid}`), { username: email, accountNo: acct, role, mustChange: false, disabled: false });
  batch.update(doc(db, `wallets/${acct}`), { uid });
  return batch.commit();
}

test('Google: a student claims the wallet invited for their school email', async () => {
  await inviteSara();
  const db = google('sara-uid', 'sara@school.edu.eg');
  await assertSucceeds(getDoc(doc(db, 'invites/sara@school.edu.eg')));
  await assertSucceeds(claim(db, 'sara-uid', 'sara@school.edu.eg'));
  await assertSucceeds(getDoc(doc(db, 'wallets/AISE-1005')));
});

test('Google: a password account typing the same email cannot claim it', async () => {
  await inviteSara();
  await assertFails(claim(google('fake', 'sara@school.edu.eg', 'password', true), 'fake', 'sara@school.edu.eg'));
  await assertFails(claim(google('fake2', 'sara@school.edu.eg', 'google.com', false), 'fake2', 'sara@school.edu.eg'));
});

test("Google: cannot claim someone else's invite, a bigger role, or a claimed wallet", async () => {
  await inviteSara();
  await assertFails(claim(google('bad', 'bad@school.edu.eg'), 'bad', 'sara@school.edu.eg'));
  await assertFails(getDoc(doc(google('bad', 'bad@school.edu.eg'), 'invites/sara@school.edu.eg')));
  await assertFails(claim(google('sara-uid', 'sara@school.edu.eg'), 'sara-uid', 'sara@school.edu.eg', 'AISE-1005', 'banker'));
  await assertFails(claim(google('sara-uid', 'sara@school.edu.eg'), 'sara-uid', 'sara@school.edu.eg', 'AISE-1002'));
  await assertSucceeds(claim(google('sara-uid', 'sara@school.edu.eg'), 'sara-uid', 'sara@school.edu.eg'));
  await assertFails(claim(google('sara-2', 'sara@school.edu.eg'), 'sara-2', 'sara@school.edu.eg'));
});

test('Google: only the Bank Office can create invites', async () => {
  await assertFails(setDoc(doc(as('omar'), 'invites/omar2@school.edu.eg'), { accountNo: 'AISE-1002', role: 'banker' }));
  await assertSucceeds(setDoc(doc(as('bank'), 'invites/new@school.edu.eg'), { accountNo: 'AISE-1009', role: 'student' }));
});

test('nobody can download the whole ledger except the Bank Office', async () => {
  await transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 100, fromBal: 1000, toBal: 0 }).commit();
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDocs(collection(anon, 'transactions')));
  await assertFails(getDocs(collection(as('omar'), 'transactions')));
  await assertFails(getDocs(collection(anon, 'wallets')));
  await assertFails(getDocs(collection(as('omar'), 'users')));
  await assertSucceeds(getDocs(collection(as('bank'), 'transactions')));
});

// ---------------------------------------------------------------- self-join (open domain)

async function openDomain(domain) {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'config/bank'), { openDomain: domain }));
}

/** What the app writes when a student joins by themselves. config/bank.nextAccount is 1005 in setup. */
function selfJoin(db, uid, email, { acct = 'AISE-1005', role = 'student', next = 1006, name = 'Sara Adel', balance = 0 } = {}) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'config/bank'), { nextAccount: next });
  batch.set(doc(db, `users/${uid}`), { username: email, accountNo: acct, role, mustChange: false, disabled: false });
  batch.set(doc(db, `wallets/${acct}`), { uid, name, role, grade: '', balance, frozen: false, lastTx: '' });
  batch.set(doc(db, `directory/${acct}`), { name, role, grade: '', frozen: false });
  return batch.commit();
}

test('self-join: works for the open school domain when switched on', async () => {
  await openDomain('stu.aisegypt.com');
  const db = google('s1', 'id11111@stu.aisegypt.com');
  await assertSucceeds(selfJoin(db, 's1', 'id11111@stu.aisegypt.com'));
  await assertSucceeds(getDoc(doc(db, 'wallets/AISE-1005')));
});

test('self-join: refused when switched off, for other domains, or for password accounts', async () => {
  await assertFails(selfJoin(google('s1', 'id11111@stu.aisegypt.com'), 's1', 'id11111@stu.aisegypt.com'));
  await openDomain('stu.aisegypt.com');
  await assertFails(selfJoin(google('h1', 'hacker@gmail.com'), 'h1', 'hacker@gmail.com'));
  await assertFails(selfJoin(google('h2', 'x@evilstu.aisegypt.com'), 'h2', 'x@evilstu.aisegypt.com'));
  await assertFails(selfJoin(google('h3', 'id1@stu.aisegypt.com', 'password'), 'h3', 'id1@stu.aisegypt.com'));
  await assertFails(selfJoin(google('h4', 'id1@stu.aisegypt.com', 'google.com', false), 'h4', 'id1@stu.aisegypt.com'));
});

test('self-join: cannot become a banker, start with money, skip numbers, or overwrite a wallet', async () => {
  await openDomain('stu.aisegypt.com');
  const db = google('s1', 'id11111@stu.aisegypt.com');
  await assertFails(selfJoin(db, 's1', 'id11111@stu.aisegypt.com', { role: 'banker' }));
  await assertFails(selfJoin(db, 's1', 'id11111@stu.aisegypt.com', { balance: 100000 }));
  await assertFails(selfJoin(db, 's1', 'id11111@stu.aisegypt.com', { acct: 'AISE-1099', next: 1100 }));
  await assertFails(selfJoin(db, 's1', 'id11111@stu.aisegypt.com', { acct: 'AISE-1002', next: 1006 }));
  await assertFails(selfJoin(db, 's1', 'id11111@stu.aisegypt.com', { next: 1007 }));
});

test('self-join: only once per person; existing users cannot join again', async () => {
  await openDomain('stu.aisegypt.com');
  const db = google('s1', 'id11111@stu.aisegypt.com');
  await assertSucceeds(selfJoin(db, 's1', 'id11111@stu.aisegypt.com'));
  await assertFails(selfJoin(db, 's1', 'id11111@stu.aisegypt.com', { acct: 'AISE-1006', next: 1007 }));
});

test('self-join switch: only the Bank Office can flip it', async () => {
  await assertFails(updateDoc(doc(as('omar'), 'config/bank'), { openDomain: 'gmail.com' }));
  await assertSucceeds(updateDoc(doc(as('bank'), 'config/bank'), { openDomain: 'stu.aisegypt.com' }));
  await assertSucceeds(updateDoc(doc(as('bank'), 'config/bank'), { openDomain: '' }));
  await assertFails(updateDoc(doc(as('omar'), 'config/bank'), { nextAccount: 1006 }));
});

// ================================================================ attack pack 2: 20 more ways to cheat

/** Build a raw money batch exactly as an attacker could, field by field. */
function rawTx(db, tx, walletUpdates) {
  const batch = writeBatch(db);
  const txId = tx.id || newId();
  batch.set(doc(db, `transactions/${txId}`), {
    type: 'transfer', memo: '', createdAt: serverTimestamp(), ...tx.data,
  });
  for (const [acct, upd] of Object.entries(walletUpdates)) batch.update(doc(db, `wallets/${acct}`), { lastTx: txId, ...upd });
  return batch.commit();
}

test('attack: negative amount (send -500 to pull money from a friend)', async () => {
  await assertFails(rawTx(as('layla'), { data: { from: 'AISE-1003', to: 'AISE-1002', amount: -500, actor: 'layla', parties: ['AISE-1003', 'AISE-1002'] } },
    { 'AISE-1003': { balance: 500 }, 'AISE-1002': { balance: 500 } }));
});

test('attack: zero and fractional amounts', async () => {
  for (const amount of [0, 0.5, 12.75]) {
    await assertFails(rawTx(as('omar'), { data: { from: 'AISE-1002', to: 'AISE-1003', amount, actor: 'omar', parties: ['AISE-1002', 'AISE-1003'] } },
      { 'AISE-1002': { balance: 1000 - amount }, 'AISE-1003': { balance: amount } }));
  }
});

test('attack: absurdly huge amount', async () => {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'wallets/AISE-1002'), { balance: 999999999999 }));
  await assertFails(transfer(as('omar'), { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 100000001, fromBal: 999999999999, toBal: 0 }).commit());
});

test('attack: credit yourself without debiting anyone', async () => {
  await assertFails(rawTx(as('layla'), { data: { from: 'AISE-1002', to: 'AISE-1003', amount: 300, actor: 'layla', parties: ['AISE-1002', 'AISE-1003'] } },
    { 'AISE-1003': { balance: 300 } }));
});

test('attack: debit a victim and keep it (only the victim wallet moves)', async () => {
  await assertFails(rawTx(as('layla'), { data: { from: 'AISE-1002', to: 'AISE-1003', amount: 300, actor: 'layla', parties: ['AISE-1002', 'AISE-1003'] } },
    { 'AISE-1002': { balance: 700 } }));
});

test('attack: lie about who pressed the button (actor = someone else)', async () => {
  await assertFails(rawTx(as('omar'), { data: { from: 'AISE-1002', to: 'AISE-1003', amount: 100, actor: 'bank', parties: ['AISE-1002', 'AISE-1003'] } },
    { 'AISE-1002': { balance: 900 }, 'AISE-1003': { balance: 100 } }));
});

test('attack: backdate the transaction (fake createdAt)', async () => {
  await assertFails(rawTx(as('omar'), { data: { from: 'AISE-1002', to: 'AISE-1003', amount: 100, actor: 'omar', parties: ['AISE-1002', 'AISE-1003'], createdAt: Timestamp.fromMillis(0) } },
    { 'AISE-1002': { balance: 900 }, 'AISE-1003': { balance: 100 } }));
});

test('attack: hide from history (parties list leaves out the sender)', async () => {
  await assertFails(rawTx(as('omar'), { data: { from: 'AISE-1002', to: 'AISE-1003', amount: 100, actor: 'omar', parties: ['AISE-1003'] } },
    { 'AISE-1002': { balance: 900 }, 'AISE-1003': { balance: 100 } }));
});

test('attack: student pretends a transfer is a bank deposit', async () => {
  await assertFails(rawTx(as('layla'), { data: { type: 'deposit', from: null, to: 'AISE-1003', amount: 5000, actor: 'layla', parties: ['AISE-1003'] } },
    { 'AISE-1003': { balance: 5000 } }));
});

test('attack: a "withdraw" that actually adds money', async () => {
  await assertFails(rawTx(as('bank'), { data: { type: 'withdraw', from: 'AISE-1002', to: null, amount: 100, actor: 'bank', parties: ['AISE-1002'] } },
    { 'AISE-1002': { balance: 1100 } }));
});

test('attack: smuggle extra fields into a transaction', async () => {
  await assertFails(rawTx(as('omar'), { data: { from: 'AISE-1002', to: 'AISE-1003', amount: 100, actor: 'omar', parties: ['AISE-1002', 'AISE-1003'], bonus: 99999 } },
    { 'AISE-1002': { balance: 900 }, 'AISE-1003': { balance: 100 } }));
});

test('attack: one transaction id used to credit two wallets', async () => {
  const id = newId();
  await assertFails(rawTx(as('omar'), { id, data: { from: 'AISE-1002', to: 'AISE-1003', amount: 100, actor: 'omar', parties: ['AISE-1002', 'AISE-1003'] } },
    { 'AISE-1002': { balance: 900 }, 'AISE-1003': { balance: 100 }, 'AISE-1004': { balance: 100 } }));
});

test('attack: create a brand-new wallet that already has money', async () => {
  await assertFails(setDoc(doc(as('omar'), 'wallets/AISE-7777'), { uid: 'omar', name: 'Rich Omar', role: 'student', grade: '', balance: 100000, frozen: false, lastTx: '' }));
});

test("attack: steal someone's wallet by pointing it at your login", async () => {
  await assertFails(updateDoc(doc(as('layla'), 'wallets/AISE-1002'), { uid: 'layla' }));
});

test('attack: unfreeze yourself, or freeze a rival', async () => {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'wallets/AISE-1003'), { frozen: true }));
  await assertFails(updateDoc(doc(as('layla'), 'wallets/AISE-1003'), { frozen: false }));
  await assertFails(updateDoc(doc(as('layla'), 'wallets/AISE-1002'), { frozen: true }));
});

test('attack: rename someone in the directory, or make yourself "Bank Office"', async () => {
  await assertFails(updateDoc(doc(as('layla'), 'directory/AISE-1002'), { name: 'Omar the Thief' }));
  await assertFails(updateDoc(doc(as('layla'), 'directory/AISE-1003'), { role: 'banker' }));
});

test("attack: read another user's private login record", async () => {
  await assertFails(getDoc(doc(as('layla'), 'users/omar')));
});

test("attack: hijack a username by rewriting its sign-in email", async () => {
  await assertFails(updateDoc(doc(as('layla'), 'logins/omar'), { email: 'layla@aise-dollar.app' }));
  await assertFails(setDoc(doc(as('layla'), 'logins/newname'), { email: 'layla@aise-dollar.app', accountNo: 'AISE-1002' }));
});

test('attack: wipe or reset the bank (delete config, reset the counter)', async () => {
  await assertFails(deleteDoc(doc(as('omar'), 'config/bank')));
  await assertFails(updateDoc(doc(as('bank'), 'config/bank'), { nextAccount: 1001 }));
  await assertFails(updateDoc(doc(as('bank'), 'config/bank'), { setupBy: 'omar' }));
});

test('attack: pay a QR code but send the money to yourself instead', async () => {
  await assertSucceeds(setDoc(doc(as('canteen'), 'requests/q1'), {
    merchant: 'AISE-1004', merchantName: 'School Canteen', amount: 300, memo: '', status: 'open', createdAt: serverTimestamp(),
  }));
  const db = as('omar');
  const t = transfer(db, { uid: 'omar', from: 'AISE-1002', to: 'AISE-1003', amount: 300, fromBal: 1000, toBal: 0, requestId: 'q1' });
  t.batch.update(doc(db, 'requests/q1'), { status: 'paid', paidBy: 'AISE-1002', paidByName: 'Omar Hassan', txId: t.txId });
  await assertFails(t.commit());
});
