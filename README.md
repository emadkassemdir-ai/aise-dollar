# AISE Dollar (AISE$)

The school currency of the **American International School in Egypt**.

> **1 AISE$ = 10 EGP**, a fixed peg that never changes.

Everyone at school gets their own login and wallet. You load AISE$ by handing in Egyptian pounds at
the Bank Office. Then you can send money to friends, pay the canteen by scanning a QR code, and cash
back out to EGP whenever you like.

## What it does

| Who | What they can do |
|---|---|
| **Students & staff** | Sign in with their own username and password. See their balance in AISE$ and EGP. **Send** money to anyone by name or account number, with a review step before confirming. **Receive** with a personal QR code. **Scan to pay**. Full transaction history. |
| **Canteen, store & clubs** (merchant accounts) | A **till**: type the price (or tap a quick amount) and a one-time QR code appears. The customer scans it with their phone camera and confirms. The till turns green with a chime and shows who paid. Today's sales total is shown too. |
| **Bank Office** (banker accounts) | Open accounts one at a time or **bulk import** up to 200 from a spreadsheet paste. Print **login slips** with temporary passwords. **Deposit** EGP cash (exact change worked out). **Cash out** to EGP, which needs the holder's own password. Freeze accounts, reset passwords, view the full **ledger**, export **CSV**. |
| **Anyone** | AISE$ ⇄ EGP converter. |

The Bank Office dashboard always shows the **EGP cash reserve**: AISE$ in circulation × 10. That's
exactly how much cash should be in the cash box, which makes the daily count a quick check.

## Run it

You need **Node.js 22.13 or newer** and nothing else. There are no npm packages to install.

```bash
npm start
```

Then open http://localhost:3000. On the very first start, the server prints a **setup code** in the
terminal. Enter it on the website to create the first Bank Office account.

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `AISE_DB` | `./data/aise.db` | Where the SQLite database lives. **Back this file up.** |
| `COOKIE_SECURE` | off | Set to `1` when served over HTTPS |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy (Render, Railway, nginx…) so client IPs and HTTPS are detected |
| `LOG_REQUESTS` | off | Set to `1` to log every API call |

### Deploying for the whole school

Any host that runs a Docker container **with a persistent disk** works. Examples are Render, Railway,
Fly.io, or a small server in the IT room:

```bash
docker build -t aise-dollar .
docker run -d -p 3000:3000 -v aise-data:/data -e COOKIE_SECURE=1 -e TRUST_PROXY=1 aise-dollar
docker logs <container>   # shows the one-time setup code
```

Serve it over **HTTPS**. It protects passwords on school Wi-Fi, and phone cameras need it for in-app QR
scanning. Students can then use **Add to Home Screen** to install it like an app.

> GitHub Pages can't run this version, because it needs a server to keep everyone's balances in one place.

## Security

- **Passwords** are hashed with **scrypt** (memory-hard), with a unique salt per user and constant-time comparison.
  New accounts get a readable temporary password (e.g. `kite-7mr4-wave3`) and **must change it** on first sign-in.
- **Sessions** use a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (`__Host-` prefixed on HTTPS).
  Only a SHA-256 of the token is stored, so a leaked database can't be used to log in.
  Sessions expire after 30 min idle or 12 h at most. Changing your password signs out your other devices.
  Freezing an account signs it out immediately.
- **Brute force:** 5 wrong passwords lock that username *and* that IP. Each further lockout doubles the wait (1 min, 2 min, 4 min…).
  Response times are the same whether or not a username exists.
- **CSRF:** strict same-site cookies, plus a required custom header and an `Origin` check on every change.
- **XSS:** a strict Content-Security-Policy with no inline scripts or styles, and all user text is rendered as text, never HTML.
- **Least privilege:** Bank Office routes check the role on the server. A banker can't cash out someone's money without that person's password.
  Every ledger entry records **who pressed the button**.
- **QR safety:** payment codes are unguessable, single-use and expire after 15 minutes. The in-app scanner only follows links to this site.

## How the money stays correct

- **Integer cents only:** `"0.29"` is parsed straight from the text to `29`. Floating-point rounding never touches a balance.
- **Append-only ledger:** balances are *calculated* from the transaction log, never stored. SQLite triggers block any `UPDATE` or `DELETE` on transactions,
  and `CHECK` constraints reject negative amounts and malformed entries.
- **No double-spending:** every payment runs in a `BEGIN IMMEDIATE` transaction that checks the balance and writes the entry atomically.
  A test fires 10 simultaneous payments at an account that can only afford 3, and exactly 3 succeed.
- **No double charges:** each Send/Deposit/Cash-out carries an idempotency key, so a double-tap or a retry on flaky Wi-Fi is processed once.
  A QR code can be paid only once, even if two phones scan it at the same moment.

## Project layout

```
server/
  index.js     start-up, setup code, graceful shutdown
  app.js       HTTP routes, auth checks, CSRF, security headers, static files
  bank.js      every money movement (deposit, transfer, QR requests, cash-out)
  auth.js      scrypt passwords, sessions, login throttling
  db.js        SQLite schema and constraints (node:sqlite, built into Node)
shared/
  money.js     exact money parsing/formatting, used by server and browser
public/
  index.html, app.js, styles.css   single-page app, mobile-first, dark mode
  vendor/qrcode.js                 QR encoder (MIT, Kazuhiko Arase)
tests/         node --test suites: money maths + full HTTP API
```

## Tests

```bash
npm test
```

The tests cover:
- setup and login
- lockouts and forced password changes
- deposits, transfers and cash-outs
- overdrafts and frozen accounts
- concurrent double-spend attempts
- QR double-pay races
- CSRF rejection, bank-only access and the append-only ledger
- CSV export, bulk import, and static-file hardening
