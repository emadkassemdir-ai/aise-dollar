# AISE Dollar (AISE$)

The school currency of the **American International School in Egypt**.

> **1 AISE$ = 10 EGP**, a fixed peg that never changes.

Students and staff each get a wallet. They can hand in Egyptian pounds at the Bank Office to load
AISE$, send money to each other, pay merchants like the canteen or clubs, and cash back out to EGP
at any time.

## Features

| | |
|---|---|
| **Wallets** | Sign in with your account and PIN. See your balance in AISE$ and EGP, and your full history. |
| **Transfers** | Send AISE$ to any student, staff or merchant account. Needs a PIN, shows a confirmation, and can't overdraw. |
| **Deposits** | The Bank Office takes EGP cash and credits AISE$ at 10:1. It also works out exact change, e.g. EGP 12.55 → AISE$ 1.25 + 5 pt back. |
| **Cash out** | Debit AISE$ and pay out EGP. Needs the account holder's PIN. |
| **Reserve tracking** | Shows how much EGP must be in the cash box: AISE$ in circulation × 10. |
| **Account admin** | Open accounts, freeze/unfreeze them, reset PINs. |
| **Converter** | Live AISE$ ⇄ EGP calculator. |
| **Backup** | Export/restore JSON backups and export the ledger as CSV for Excel. |

## Run it

No install and no build step. Just open `index.html` in a browser.

To host it for the whole school: GitHub repo → **Settings → Pages → Deploy from branch → `main` / root**.

First run: go to **Bank Office**, choose an admin PIN, then open accounts.

## How it's built

```
ledger.js   pure money logic (no DOM), unit-tested
app.js      UI: rendering, PINs, storage
styles.css  AISE navy & gold theme, dark mode, mobile layout
tests/      node --test suite
```

The rules that keep the money correct:

- **Integer cents only.** `"0.29"` is parsed straight from the string to `29`, so floating-point rounding can never hit a balance.
- **Append-only ledger.** Balances are *computed* from the transaction log, never stored, so they can't drift out of sync.
- **Conservation.** Every account's balance adds up to exactly the money in circulation, and the tests check this.
- **Immutable state.** Each operation returns a new state and never changes its input.
- **Validated imports.** A backup is replayed transaction by transaction before it's accepted. If any balance would go negative, the file is rejected.
- **XSS-safe rendering.** User text is always inserted as `textContent`, never as HTML.
- **Safer CSV.** Cells starting with `=`, `+`, `-` or `@` are neutralised so Excel won't run them as formulas.

## Tests

```bash
node --test
```

## Security, honestly

This version stores everything in **one browser's localStorage**. That makes it great for a single
Bank Office computer or a classroom pilot. PINs are salted and SHA-256 hashed, wrong guesses lock the
account for 30 s after 5 tries, and sessions auto-lock after 3 minutes idle. However, anyone with access
to that computer's browser dev tools could edit the data. Before running it school-wide, with students
using their own phones, the ledger needs to move to a real server with proper authentication. `ledger.js`
is written so that this step needs no changes to the money logic.
