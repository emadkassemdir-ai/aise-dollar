/**
 * AISE Dollar data layer — every Firebase call lives here.
 *
 * There is no server. Money moves in atomic batched writes: a new immutable
 * transaction plus `increment()` on each wallet. firestore.rules re-checks
 * every batch (right wallet owner, exact amounts, never below zero), so a
 * modified copy of this file still can't create money.
 */
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  initializeAuth, inMemoryPersistence, onAuthStateChanged, browserLocalPersistence, connectAuthEmulator,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  reauthenticateWithCredential, updatePassword, EmailAuthProvider, GoogleAuthProvider, signInWithPopup,
  browserPopupRedirectResolver,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, collection, query,
  where, limit, startAfter, writeBatch, runTransaction, serverTimestamp, increment, onSnapshot, Timestamp,
  getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const M = window.Money;
const EMAIL_DOMAIN = 'aise-dollar.app'; // sign-in emails are internal; nobody is ever emailed
export const REQUEST_TTL_MS = 15 * 60 * 1000; // must match firestore.rules
export const ROLES = { student: 'Student', staff: 'Staff', merchant: 'Merchant', banker: 'Bank Office' };

export class BankError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BankError';
  }
}

// ================================================================ init ===

/** `?emulator` on localhost talks to the local Firebase emulators (development). */
const useEmulator = ['localhost', '127.0.0.1'].includes(location.hostname) &&
  new URLSearchParams(location.search).has('emulator');
const config = useEmulator ? { apiKey: 'demo-key', projectId: 'demo-aise', authDomain: 'demo-aise.firebaseapp.com' } : firebaseConfig;

export const configured = Boolean(config?.apiKey && config?.projectId);

let app, auth, db;
if (configured) {
  app = initializeApp(config);
  // initializeAuth leaves out the popup machinery unless it's passed in explicitly.
  auth = initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  db = getFirestore(app);
  if (useEmulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
}

/**
 * Creating or checking another person's login with the client SDK would sign
 * the Bank Office out. A throwaway second app with in-memory auth avoids that.
 */
async function withSecondaryAuth(fn) {
  const second = initializeApp(config, `helper-${Date.now()}-${Math.random()}`);
  const secondAuth = initializeAuth(second, { persistence: inMemoryPersistence });
  if (useEmulator) connectAuthEmulator(secondAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  try {
    return await fn(secondAuth);
  } finally {
    await signOut(secondAuth).catch(() => {});
    await deleteApp(second).catch(() => {});
  }
}

// ============================================================ helpers ===

const ref = (path) => doc(db, path);
const cleanText = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const emailFor = (username, suffix = '') => `${username}${suffix}@${EMAIL_DOMAIN}`;

function cleanUsername(raw) {
  const u = cleanText(raw, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(u)) {
    throw new BankError('Username must be 3–40 characters: letters, numbers, dot, dash or underscore.');
  }
  return u;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw new BankError('Password must be at least 6 characters.');
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) throw new BankError('Password needs at least one letter and one number.');
}

/** Easy for a 10-year-old to type once: "lion482". They change it on first sign-in. */
export function temporaryPassword() {
  const words = ['lion', 'kite', 'nile', 'palm', 'wave', 'star', 'moon', 'sand', 'reef', 'hawk',
    'leaf', 'rain', 'gold', 'pine', 'rose', 'tide', 'dune', 'bird', 'sun', 'camel'];
  const r = crypto.getRandomValues(new Uint32Array(2));
  return `${words[r[0] % words.length]}${String(r[1] % 1000).padStart(3, '0')}`;
}

/**
 * Transaction ids sort NEWEST FIRST by name, so "latest history" is a plain
 * query with no composite index to set up in the Firebase console.
 */
export function newTxId() {
  const inverted = (8e12 - Date.now()).toString(36).padStart(9, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(36).padStart(2, '0')).join('');
  return `${inverted}-${rand}`;
}

function friendlyAuthError(err) {
  const code = err?.code || '';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(code)) {
    return new BankError('Wrong username or password.');
  }
  if (code === 'auth/too-many-requests') return new BankError('Too many tries. Wait a few minutes and try again.');
  if (code === 'auth/network-request-failed') return new BankError('No internet connection. Check Wi-Fi and try again.');
  if (code === 'auth/weak-password') return new BankError('Password must be at least 6 characters.');
  if (code === 'auth/requires-recent-login') return new BankError('Please sign out and in again, then retry.');
  // Setup mistakes in the Firebase console: say exactly what to fix.
  if (code === 'auth/unauthorized-domain') {
    return new BankError(`Firebase doesn't allow sign-in from ${location.hostname} yet. In Firebase: Authentication → Settings → Authorized domains → add ${location.hostname}.`);
  }
  if (code === 'auth/operation-not-allowed') {
    return new BankError('That sign-in type is switched off. In Firebase: Authentication → Sign-in method → turn on Google and Email/Password.');
  }
  if (code.startsWith('auth/api-key') || code === 'auth/invalid-api-key') {
    return new BankError('firebase-config.js has the wrong apiKey. Copy the config again from Firebase project settings.');
  }
  return err;
}

/** Errors that mean the Firestore database itself isn't set up yet. */
function setupDbError(err) {
  if (err?.code === 'permission-denied') {
    return new BankError('The security rules aren’t published yet. In Firebase: Firestore Database → Rules → paste firestore.rules → Publish.');
  }
  if (err?.code === 'not-found' || err?.code === 'failed-precondition' || /does not exist/i.test(err?.message || '')) {
    return new BankError('The Firestore database hasn’t been created yet. In Firebase: Databases & Storage → Firestore Database → Create database.');
  }
  return null;
}

function friendlyDbError(err) {
  if (err?.code === 'permission-denied') return new BankError('Not allowed. Check the amount and your balance, then try again.');
  if (err?.code === 'unavailable') return new BankError('No internet connection. Check Wi-Fi and try again.');
  return err;
}

async function guard(fn) {
  try { return await fn(); } catch (err) { throw err instanceof BankError ? err : friendlyDbError(friendlyAuthError(err)); }
}

// ============================================================== setup ===

/** config/bank is readable by anyone, so failing here means Firebase itself isn't set up. */
export async function needsSetup() {
  try {
    return !(await getDoc(ref('config/bank'))).exists();
  } catch (err) {
    throw setupDbError(err) || friendlyDbError(err);
  }
}

/** First run: the signed-in Google user becomes the Bank Office (wallet AISE-1001). */
export function setup({ name }) {
  return guard(async () => {
    name = cleanText(name, 60);
    if (name.length < 2) throw new BankError('Name must be at least 2 characters.');
    const user = auth.currentUser;
    if (!user?.email) throw new BankError('Sign in with Google first.');
    const batch = writeBatch(db);
    batch.set(ref('config/bank'), { setupBy: user.uid, nextAccount: 1002 });
    batch.set(ref(`users/${user.uid}`), { username: user.email.toLowerCase(), accountNo: 'AISE-1001', role: 'banker', mustChange: false, disabled: false });
    batch.set(ref('wallets/AISE-1001'), { uid: user.uid, name, role: 'banker', grade: '', balance: 0, frozen: false, lastTx: '' });
    batch.set(ref('directory/AISE-1001'), { name, role: 'banker', grade: '', frozen: false });
    await batch.commit();
  });
}

// =============================================================== auth ===

export const ready = () => (configured ? auth.authStateReady() : Promise.resolve());
export const signedIn = () => Boolean(auth?.currentUser);
/** Calls `fn(isSignedIn)` whenever someone signs in or out — even if the
 *  sign-in popup itself reported an error (iPad Safari sometimes does). */
export const onAuthChange = (fn) => (configured ? onAuthStateChanged(auth, (u) => fn(Boolean(u))) : () => {});

export function login(username, password) {
  return guard(async () => {
    const name = cleanText(username, 40).toLowerCase();
    const login = name && /^[a-z0-9._-]+$/.test(name) ? await getDoc(ref(`logins/${name}`)) : null;
    if (!login?.exists()) throw new BankError('Wrong username or password.');
    await signInWithEmailAndPassword(auth, login.data().email, String(password ?? ''));
    return me();
  });
}

export const logout = () => (auth ? signOut(auth) : Promise.resolve());
export const currentEmail = () => auth?.currentUser?.email || '';

/**
 * Sign in with a school Google account. Must be called straight from a tap
 * (before any other await) or Safari blocks the popup.
 */
export function signInWithGoogle() {
  return guard(async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(err?.code)) throw new BankError('Sign-in was cancelled.');
      if (err?.code === 'auth/popup-blocked') throw new BankError('Safari blocked the sign-in window. Tap the button again.');
      throw err;
    }
  });
}

/**
 * First Google sign-in: link this login to the wallet the Bank Office made for
 * the email — or, if the Bank Office opened sign-ups for this email's school
 * domain, create a fresh student wallet.
 */
async function claimInvite(user) {
  const email = (user.email || '').toLowerCase();
  const isGoogle = user.providerData.some((p) => p.providerId === 'google.com');
  const invite = isGoogle && email ? await getDoc(ref(`invites/${email}`)).catch(() => null) : null;
  if (!invite?.exists()) {
    const openDomain = (await getDoc(ref('config/bank'))).data()?.openDomain || '';
    if (isGoogle && openDomain && email.split('@')[1] === openDomain) return selfJoin(user, email);
    await signOut(auth);
    throw new BankError(`${email || 'This account'} isn't in AISE Dollar yet. Ask the Bank Office to add it.`);
  }
  const { accountNo, role } = invite.data();
  const batch = writeBatch(db);
  batch.set(ref(`users/${user.uid}`), { username: email, accountNo, role, mustChange: false, disabled: false });
  batch.update(ref(`wallets/${accountNo}`), { uid: user.uid });
  try {
    await batch.commit();
  } catch (err) {
    await signOut(auth);
    throw err?.code === 'permission-denied' ? new BankError('This account is already linked. Ask the Bank Office for help.') : err;
  }
}

/** Join as a student with a new, empty wallet (only while sign-ups are open). */
async function selfJoin(user, email) {
  let name = cleanText(user.displayName, 60);
  if (name.length < 2) name = email.split('@')[0].slice(0, 60);
  try {
    await runTransaction(db, async (t) => {
      const cfg = (await t.get(ref('config/bank'))).data();
      const acct = `AISE-${cfg.nextAccount}`;
      t.update(ref('config/bank'), { nextAccount: cfg.nextAccount + 1 });
      t.set(ref(`users/${user.uid}`), { username: email, accountNo: acct, role: 'student', mustChange: false, disabled: false });
      t.set(ref(`wallets/${acct}`), { uid: user.uid, name, role: 'student', grade: '', balance: 0, frozen: false, lastTx: '' });
      t.set(ref(`directory/${acct}`), { name, role: 'student', grade: '', frozen: false });
    });
  } catch (err) {
    await signOut(auth);
    throw err?.code === 'permission-denied'
      ? new BankError('Sign-ups were just closed. Ask the Bank Office to add you.') : err;
  }
}

/** The signed-in person: login record + their private wallet. */
export function me() {
  return guard(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return null;
    let userSnap = await getDoc(ref(`users/${uid}`));
    if (!userSnap.exists() && !(await needsSetup())) {
      await claimInvite(auth.currentUser);
      userSnap = await getDoc(ref(`users/${uid}`));
    }
    if (!userSnap.exists()) return { uid, needsSetup: true, email: auth.currentUser.email };
    if (userSnap.data().disabled) {
      await signOut(auth);
      throw new BankError('This login was replaced. Use the new password from the Bank Office.');
    }
    const u = userSnap.data();
    const w = (await getDoc(ref(`wallets/${u.accountNo}`))).data();
    if (!w) throw new BankError(`Wallet ${u.accountNo} is missing. Ask the Bank Office for help.`);
    return {
      uid, username: u.username, accountNo: u.accountNo, role: u.role, mustChange: u.mustChange,
      google: u.username.includes('@'), // usernames can't contain @, so this is a Google login
      name: w.name, grade: w.grade, balance: w.balance, frozen: w.frozen,
    };
  });
}

export function changePassword(current, next) {
  return guard(async () => {
    validatePassword(next);
    if (next === current) throw new BankError('Choose a different password.');
    const user = auth.currentUser;
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
    } catch (err) {
      if (err?.code === 'auth/too-many-requests') throw friendlyAuthError(err);
      throw new BankError('Current password is wrong.');
    }
    await updatePassword(user, next);
    await updateDoc(ref(`users/${user.uid}`), { mustChange: false });
  });
}

// ========================================================== directory ===

/** Everyone you can pay: names only, never balances. */
export function directory() {
  return guard(async () => (await getDocs(collection(db, 'directory'))).docs
    .map((d) => ({ accountNo: d.id, ...d.data() }))
    .sort((a, b) => a.name.localeCompare(b.name)));
}

// ======================================================== transactions ===

function txView(snap, perspective) {
  const t = snap.data();
  return {
    id: snap.id, type: t.type, amount: t.amount, memo: t.memo, from: t.from, to: t.to,
    at: t.createdAt?.toDate?.() || new Date(), viaQr: Boolean(t.requestId),
    ...(perspective && { delta: t.to === perspective ? t.amount : -t.amount }),
    _snap: snap,
  };
}

/** Newest first (see newTxId). Pass the last item back as `after` for the next page. */
export function history(accountNo, { pageSize = 25, after } = {}) {
  return guard(async () => {
    const parts = [where('parties', 'array-contains', accountNo), limit(pageSize)];
    if (after) parts.push(startAfter(after._snap));
    const snap = await getDocs(query(collection(db, 'transactions'), ...parts));
    return snap.docs.map((d) => txView(d, accountNo));
  });
}

/** Commit a money batch exactly once, even if the network drops mid-way. */
async function commitOnce(batch, txId) {
  try {
    await batch.commit();
  } catch (err) {
    // If the write actually landed before the error, treat it as success.
    const landed = await getDoc(ref(`transactions/${txId}`)).then((s) => s.exists()).catch(() => false);
    if (!landed) throw err;
  }
}

function moneyBatch({ txId, type, from = null, to = null, amount, memo, requestId }) {
  M.assertAmount(amount);
  const batch = writeBatch(db);
  batch.set(ref(`transactions/${txId}`), {
    type, from, to, amount, memo: cleanText(memo, 140), actor: auth.currentUser.uid,
    createdAt: serverTimestamp(), parties: [from, to].filter(Boolean), ...(requestId && { requestId }),
  });
  if (from) batch.update(ref(`wallets/${from}`), { balance: increment(-amount), lastTx: txId });
  if (to) batch.update(ref(`wallets/${to}`), { balance: increment(amount), lastTx: txId });
  return batch;
}

export function transfer({ from, to, amount, memo, txId = newTxId() }) {
  return guard(async () => {
    if (from === to) throw new BankError("You can't send money to yourself.");
    const mine = (await getDoc(ref(`wallets/${from}`))).data();
    if (!mine) throw new BankError('Your wallet could not be found. Sign out and in again.');
    if (mine.frozen) throw new BankError('Your account is frozen. Visit the Bank Office.');
    if (mine.balance < amount) throw new BankError(`Not enough money: you have ${M.formatAise(mine.balance)}.`);
    const them = await getDoc(ref(`directory/${to}`));
    if (!them.exists()) throw new BankError('No account with that number.');
    if (them.data().frozen) throw new BankError(`${them.data().name}'s account is frozen.`);
    await commitOnce(moneyBatch({ txId, type: 'transfer', from, to, amount, memo }), txId);
    return mine.balance - amount;
  });
}

// ===================================================== payment requests ===

export function createRequest({ merchant, merchantName, amount, memo }) {
  return guard(async () => {
    M.assertAmount(amount);
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await setDoc(ref(`requests/${id}`), {
      merchant, merchantName, amount, memo: cleanText(memo, 140), status: 'open', createdAt: serverTimestamp(),
    });
    return id;
  });
}

function requestView(snap) {
  if (!snap.exists()) return null;
  const r = snap.data();
  const created = r.createdAt?.toMillis?.() ?? Date.now();
  const expiresAt = created + REQUEST_TTL_MS;
  const status = r.status === 'open' && Date.now() > expiresAt ? 'expired' : r.status;
  return { id: snap.id, ...r, status, expiresAt };
}

export const getRequest = (id) => guard(async () => requestView(await getDoc(ref(`requests/${id}`))));

/** Live updates — the till turns green the instant the customer pays. */
export function watchRequest(id, onChange) {
  return onSnapshot(ref(`requests/${id}`), (snap) => onChange(requestView(snap)), () => {});
}

export function cancelRequest(id) {
  return guard(() => updateDoc(ref(`requests/${id}`), { status: 'cancelled' }));
}

export function payRequest({ id, payer, txId = newTxId() }) {
  return guard(async () => {
    const r = requestView(await getDoc(ref(`requests/${id}`)));
    if (!r) throw new BankError('Payment code not found.');
    if (r.status === 'paid') throw new BankError(r.paidBy === payer.accountNo ? 'You already paid this.' : 'This was already paid.');
    if (r.status !== 'open') throw new BankError(r.status === 'expired' ? 'This code expired. Ask for a new one.' : 'This code was cancelled.');
    if (r.merchant === payer.accountNo) throw new BankError("You can't pay your own code.");
    const mine = (await getDoc(ref(`wallets/${payer.accountNo}`))).data();
    if (!mine) throw new BankError('Your wallet could not be found. Sign out and in again.');
    if (mine.balance < r.amount) throw new BankError(`Not enough money: you have ${M.formatAise(mine.balance)}.`);
    const batch = moneyBatch({ txId, type: 'transfer', from: payer.accountNo, to: r.merchant, amount: r.amount, memo: r.memo, requestId: id });
    batch.update(ref(`requests/${id}`), { status: 'paid', paidBy: payer.accountNo, paidByName: payer.name, txId });
    try {
      await commitOnce(batch, txId);
    } catch (err) {
      const now = requestView(await getDoc(ref(`requests/${id}`)));
      if (now?.status === 'paid') throw new BankError('Someone else paid this code first.');
      throw err;
    }
    return { request: r, balance: mine.balance - r.amount };
  });
}

// ========================================================= bank office ===

export function stats() {
  return guard(async () => {
    const wallets = (await getDocs(collection(db, 'wallets'))).docs.map((d) => d.data());
    const inCirculation = wallets.reduce((s, w) => s + w.balance, 0);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [today, count] = await Promise.all([
      getDocs(query(collection(db, 'transactions'), where('createdAt', '>=', Timestamp.fromDate(startOfDay)))),
      getCountFromServer(collection(db, 'transactions')),
    ]);
    const spentToday = today.docs.map((d) => d.data()).filter((t) => t.type === 'transfer').reduce((s, t) => s + t.amount, 0);
    return { accounts: wallets.length, inCirculation, egpReserve: M.toEgpCents(inCirculation), spentToday, transactions: count.data().count };
  });
}

/** Every account with its balance and username (Bank Office only). */
export function accounts() {
  return guard(async () => {
    const [wallets, users, invites] = await Promise.all([
      getDocs(collection(db, 'wallets')), getDocs(collection(db, 'users')), getDocs(collection(db, 'invites'))]);
    const byAccount = new Map(users.docs.map((d) => d.data()).filter((u) => !u.disabled).map((u) => [u.accountNo, u]));
    const invited = new Map(invites.docs.map((d) => [d.data().accountNo, d.id]));
    return wallets.docs
      .map((d) => {
        const w = d.data();
        const email = invited.get(d.id) || (byAccount.get(d.id)?.username.includes('@') ? byAccount.get(d.id).username : '');
        return {
          accountNo: d.id, ...w,
          username: byAccount.get(d.id)?.username || email,
          login: email ? 'google' : 'password',
          claimed: Boolean(w.uid),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Open an account. With a school email: an invite they claim by signing in
 * with Google (no password needed). Otherwise: a username + temporary password.
 */
export function createAccount({ name, username, role = 'student', grade = '' }) {
  return guard(async () => {
    const id = cleanText(username, 80).toLowerCase();
    if (id.includes('@')) return inviteAccount({ name, email: id, role, grade });
    name = cleanText(name, 60);
    username = cleanUsername(username);
    grade = cleanText(grade, 20);
    role = String(role || 'student').toLowerCase();
    if (name.length < 2) throw new BankError('Name must be at least 2 characters.');
    if (!ROLES[role]) throw new BankError(`Unknown type "${role}". Use student, staff, merchant or banker.`);
    if ((await getDoc(ref(`logins/${username}`))).exists()) throw new BankError(`Username "${username}" is taken.`);

    const tempPassword = temporaryPassword();
    // A unique hidden sign-in email per account: if a previous attempt created
    // the Firebase login but failed before saving, the username isn't stuck.
    const email = emailFor(username, `.${Date.now().toString(36)}`);
    const uid = await withSecondaryAuth(async (a) =>
      (await createUserWithEmailAndPassword(a, email, tempPassword)).user.uid);

    const accountNo = await runTransaction(db, async (t) => {
      const cfg = (await t.get(ref('config/bank'))).data();
      const acct = `AISE-${cfg.nextAccount}`;
      t.update(ref('config/bank'), { nextAccount: cfg.nextAccount + 1 });
      t.set(ref(`users/${uid}`), { username, accountNo: acct, role, mustChange: true, disabled: false });
      t.set(ref(`logins/${username}`), { email, accountNo: acct });
      t.set(ref(`wallets/${acct}`), { uid, name, role, grade, balance: 0, frozen: false, lastTx: '' });
      t.set(ref(`directory/${acct}`), { name, role, grade, frozen: false });
      return acct;
    });
    return { name, username, accountNo, tempPassword };
  });
}

async function inviteAccount({ name, email, role, grade }) {
  name = cleanText(name, 60);
  grade = cleanText(grade, 20);
  role = String(role || 'student').toLowerCase();
  if (!EMAIL_RE.test(email)) throw new BankError(`"${email}" doesn't look like an email address.`);
  if (name.length < 2) throw new BankError('Name must be at least 2 characters.');
  if (!ROLES[role]) throw new BankError(`Unknown type "${role}". Use student, staff, merchant or banker.`);
  if ((await getDoc(ref(`invites/${email}`))).exists() ||
      !(await getDocs(query(collection(db, 'users'), where('username', '==', email), limit(1)))).empty) {
    throw new BankError(`${email} already has an account.`);
  }
  const accountNo = await runTransaction(db, async (t) => {
    const cfg = (await t.get(ref('config/bank'))).data();
    const acct = `AISE-${cfg.nextAccount}`;
    t.update(ref('config/bank'), { nextAccount: cfg.nextAccount + 1 });
    t.set(ref(`wallets/${acct}`), { uid: '', name, role, grade, balance: 0, frozen: false, lastTx: '' });
    t.set(ref(`directory/${acct}`), { name, role, grade, frozen: false });
    t.set(ref(`invites/${email}`), { accountNo: acct, role });
    return acct;
  });
  return { name, username: email, accountNo, google: true };
}

/**
 * Client apps can't change someone else's Firebase password, so a reset
 * issues a fresh login for the same wallet and switches the old one off.
 */
export function resetPassword(account) {
  return guard(async () => {
    const oldUid = account.uid;
    const oldUser = (await getDoc(ref(`users/${oldUid}`))).data();
    const tempPassword = temporaryPassword();
    const suffix = `.r${Date.now().toString(36)}`;
    const email = emailFor(oldUser.username, suffix);
    const newUid = await withSecondaryAuth(async (a) => (await createUserWithEmailAndPassword(a, email, tempPassword)).user.uid);
    const batch = writeBatch(db);
    batch.update(ref(`users/${oldUid}`), { disabled: true });
    batch.set(ref(`users/${newUid}`), { ...oldUser, mustChange: true, disabled: false });
    batch.update(ref(`logins/${oldUser.username}`), { email });
    batch.update(ref(`wallets/${account.accountNo}`), { uid: newUid });
    await batch.commit();
    return { name: account.name, username: oldUser.username, accountNo: account.accountNo, tempPassword };
  });
}

// ============================================================== brand ===

/** Text limits — keep in sync with validBrand() in firestore.rules. */
export const BRAND_LIMITS = { name: 40, tagline: 80, coinText: 4, loginTitle: 60, loginText: 160, footer: 120 };
const BRAND_KEYS = [...Object.keys(BRAND_LIMITS), 'logo'];

/** Live site look (name, tagline, logo…). Calls `fn(null)` when nothing is saved yet. */
export function watchBrand(fn) {
  if (!configured) { fn(null); return () => {}; }
  return onSnapshot(ref('config/brand'), (snap) => fn(snap.exists() ? snap.data() : null), () => fn(null));
}

export function saveBrand(brand) {
  return guard(async () => {
    const clean = {};
    for (const [key, max] of Object.entries(BRAND_LIMITS)) clean[key] = cleanText(brand[key], max);
    if (!clean.name) throw new BankError('The site needs a name.');
    clean.logo = String(brand.logo || '');
    if (clean.logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(clean.logo)) {
      throw new BankError('That logo picture didn’t work. Try a different photo.');
    }
    if (clean.logo.length > 250000) throw new BankError('That logo is too big. Try a smaller picture.');
    try {
      await setDoc(ref('config/brand'), Object.fromEntries(BRAND_KEYS.map((k) => [k, clean[k]])));
    } catch (err) {
      if (err?.code === 'permission-denied') {
        throw new BankError('Firebase is still using the old security rules. Paste the latest firestore.rules into Firestore → Rules → Publish, then try again.');
      }
      throw err;
    }
  });
}

/** Self-join switch: '' = invite only, or a school domain like 'stu.aisegypt.com'. */
export const getOpenDomain = () => guard(async () => (await getDoc(ref('config/bank'))).data()?.openDomain || '');
export const setOpenDomain = (domain) => guard(async () => {
  try {
    await updateDoc(ref('config/bank'), { openDomain: domain });
  } catch (err) {
    // Older published rules don't know about this switch yet.
    if (err?.code === 'permission-denied') {
      throw new BankError('Firebase is still using the old security rules. Paste the latest firestore.rules into Firestore → Rules → Publish, then try again.');
    }
    throw err;
  }
});

export function setFrozen(accountNo, frozen) {
  return guard(async () => {
    const batch = writeBatch(db);
    batch.update(ref(`wallets/${accountNo}`), { frozen });
    batch.update(ref(`directory/${accountNo}`), { frozen });
    await batch.commit();
  });
}

export function deposit({ to, egpCents, memo, txId = newTxId() }) {
  return guard(async () => {
    const { aiseCents, changeEgpCents } = M.egpToAise(egpCents);
    if (aiseCents <= 0) throw new BankError('Minimum deposit is EGP 0.10.');
    await commitOnce(moneyBatch({ txId, type: 'deposit', to, amount: aiseCents, memo }), txId);
    return { aiseCents, changeEgpCents };
  });
}

/** Cash out. The account holder types their own password, checked by Firebase. */
export function withdraw({ account, amount, holderPassword, present = false, memo, txId = newTxId() }) {
  return guard(async () => {
    if (account.balance < amount) throw new BankError(`${account.name} only has ${M.formatAise(account.balance)}.`);
    if (account.login === 'password') {
      const login = (await getDoc(ref(`logins/${account.username}`))).data();
      await withSecondaryAuth((a) => signInWithEmailAndPassword(a, login.email, String(holderPassword ?? '')))
        .catch((err) => { throw err?.code === 'auth/too-many-requests' ? friendlyAuthError(err) : new BankError("The account holder's password is wrong."); });
    } else if (!present) {
      throw new BankError('Tick the box to confirm the student is here in person.');
    }
    await commitOnce(moneyBatch({ txId, type: 'withdraw', from: account.accountNo, amount, memo }), txId);
  });
}

export function ledger({ pageSize = 50, after } = {}) {
  return guard(async () => {
    const parts = [limit(pageSize)];
    if (after) parts.push(startAfter(after._snap));
    return (await getDocs(query(collection(db, 'transactions'), ...parts))).docs.map((d) => txView(d));
  });
}

/** All transactions, oldest first, for the CSV export. */
export async function allTransactions() {
  const out = [];
  let after;
  for (;;) {
    const page = await ledger({ pageSize: 500, after });
    out.push(...page);
    if (page.length < 500) return out.reverse();
    after = page[page.length - 1];
  }
}
