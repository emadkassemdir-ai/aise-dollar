# AISE Dollar (AISE$)

The class currency of the **American International School in Egypt**.

> **1 AISE$ = 10 EGP**, a fixed rate that never changes.

Every student has their own login on their own iPad. They can see their balance, send money to
friends, and pay the canteen by scanning a QR code. The teacher runs the **Bank Office**: adding
students, turning EGP cash into AISE$, and cashing back out.

The website is hosted free on **GitHub Pages**. Balances and logins are stored in a free **Firebase**
database. There's nothing to install, and everything can be set up from an iPad.

---

## Set it up (one time, about 15 minutes, all in Safari)

### 1. Create the Firebase database (free, no credit card)

1. Go to **[console.firebase.google.com](https://console.firebase.google.com)** and sign in with a Google account.
2. Tap **Create a project**, name it `aise-dollar`, turn **off** Google Analytics, then tap **Create project**.
3. **Turn on logins:** in the left menu choose **Build → Authentication → Get started**. Tap **Email/Password**,
   switch on the **first** toggle only, and tap **Save**.
4. **Create the database:** go to **Build → Firestore Database → Create database**. Pick the location **eur3 (Europe)**
   (closest to Egypt), choose **Start in production mode**, and tap **Create**.
5. **Add the security rules.** These are what stop anyone faking money:
   - Open [`firestore.rules`](firestore.rules) in this repo and tap the **Copy raw file** button.
   - In Firebase, go to **Firestore Database → Rules**, delete everything there, paste, and tap **Publish**.
6. **Allow the website to connect:** go to **Authentication → Settings → Authorized domains → Add domain** and enter
   `emadkassemdir-ai.github.io`.
7. **Get the config:** tap ⚙️ **Project settings**. Under **Your apps**, tap the **`</>`** (Web) button, name it `aise-dollar`,
   and tap **Register app**. Leave "Firebase Hosting" unticked. Copy the `firebaseConfig = { … }` block it shows.
8. Put that config into [`firebase-config.js`](firebase-config.js): open the file on GitHub, tap ✏️ **Edit**, and replace `null`
   with the `{ … }` part you copied. Then tap **Commit changes**.
   *(Or just paste it to Claude and it'll do this step.)*

### 2. Publish the website on GitHub Pages

1. In this repo, go to **Settings → General → Danger Zone → Change visibility** and choose **Public**.
   GitHub Pages is free only for public repos. No passwords or student data are stored in the code.
2. Go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, then **`main`** and **`/ (root)`**, and tap **Save**.
3. Wait 1–2 minutes. Your website is:
   **https://emadkassemdir-ai.github.io/hetookabiteofabonelesswing/**

### 3. Open the Bank Office

Open the website **right away** and create the **Bank Office** account (your name, a username, and a password).
The first person to do this becomes the Bank Office, so do it before you share the link.

### 4. Add your class

- **Bank Office → Accounts → Add a whole class:** paste one student per line, like
  `Omar Hassan, omar.h, 5B`. Add a canteen with `School Canteen, canteen, , merchant`.
- Tap **Print slips**. Each student gets a slip with their username and a simple first password like `lion482`.
  The first time they sign in, they make their own password.
- **Tip for students:** in Safari, tap **Share → Add to Home Screen** and AISE Dollar opens like an app.

---

## How the class uses it

| Who | What they do |
|---|---|
| **Students** | See their balance in AISE$ and EGP. **Send** money to classmates (with a "Review" step before it goes). **Receive** with their own QR code. **Scan to pay** with the iPad Camera app. See their full history. |
| **Canteen / class shop** (merchant) | Open the **Till**, type the price (or tap 1, 2, 5, 10…), and a QR code appears. The student scans it with their iPad camera and taps **Pay**. The till turns green with a "ka-ching" and shows who paid. Shows today's sales total. |
| **Teacher** (Bank Office) | Add students and print login slips. **Deposit:** take EGP cash and add AISE$ (it works out the change). **Cash out:** pay EGP back; the student types their own password. **Freeze** an account, make a **New password** for a student who forgot, see the full **Ledger**, download it as **CSV**. |

The Bank Office always shows the **EGP cash reserve**: all AISE$ × 10. That's how much cash should be in the cash box.

---

## Why balances can't be faked

There's no server. The [security rules](firestore.rules) run inside Google's database and check **every** change:

- **Every change must be a recorded payment:** a balance can only change together with a brand-new payment record
  for **exactly** that amount, in one all-or-nothing step. Balances can never go below zero.
- **You can only spend your own money,** and only the Bank Office can add or remove money.
- **Old payments can't be reused:** reusing an old payment's ID to get paid twice is rejected.
- **The ledger is permanent:** payments can never be edited or deleted, not even by the Bank Office.
- **Balances are private:** students see only their own balance. Everyone else just sees names.
- **QR codes are single-use:** each code is used once, expires after 15 minutes, and can't be paid twice even if two iPads scan it at the same moment.
- **Forgotten passwords:** "New password" switches off the old login completely, and the money stays in the wallet.

These rules are tested by 20 automated attack tests (`tests/rules.test.mjs`): editing your own balance, spending
someone else's money, sending 1 and crediting 100, replaying an old payment, paying a cancelled or expired QR code,
promoting yourself to Bank Office, reading other people's balances, and more.

**Free limits:** Firebase's free plan allows 50,000 reads and 20,000 writes a day, which is far more than a school needs.
New logins are limited to about 100 per hour, so add big groups one class at a time.

---

## For developers

```
index.html  styles.css  app.js     the website (UI only)
bank.js                            every Firebase call (data layer)
money.js                           exact money maths: integer cents, 1 AISE$ = 10 EGP
firestore.rules                    the security rules = the bank
firebase-config.js                 your project's public web config
vendor/qrcode.js                   QR encoder (MIT, Kazuhiko Arase)
tests/                             money tests + security-rules attack tests
```

```bash
npm install
npm test        # money maths + all security-rules tests (starts the Firestore emulator; needs Java)
npm run dev     # runs everything locally on fake Firebase: open http://localhost:5000/?emulator
```
