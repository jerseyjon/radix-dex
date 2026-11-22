# Overnight review and fixes, 21–22 November 2026: morning briefing

Everything is on the local branch **`overnight-all`**. Nothing has been pushed or deployed: the live
site and the live Stokenet instance are exactly as they were last night.

## What was reviewed, and by whom

Four separate reviews of the code as it stood on `main` (commit `c13042b`):

1. **Security audit** ([security-audit.md](security-audit.md)): ways someone could cost you money
   or stop the exchange working.
2. **Quality review** ([quality-review.md](quality-review.md)): how sound the code is, what is
   untested, what would break under load or after a restart.
3. **Bug report** ([bug-report.md](bug-report.md)): things that are simply wrong today, found by
   using the site and running the Stokenet tests.
4. **Design review** ([design/NOTES.md](design/NOTES.md)): the look of the trading screen, with
   before and after screenshots.

Three agents then fixed what they found, each on its own branch: one restyled the site, one fixed
the front end, one fixed the server. A fourth (this note) joined the three, made the front end use
the server's new features, checked that the two sides agree on every number a user signs, and
tested the result.

## Headline results

- **No way was found to take users' funds.** The order book contract held up: no route to escrowed
  tokens without paying the maker's price.
- **Three high-risk problems were about the solver's own XRD**, not users' money. Two are fixed
  (orders certain to fail are now caught by a free trial run before anything is sent; and a "loss
  limit" stops all sending for an hour if failed transactions cost more than 3 XRD). The third,
  **H3, fees paid in a worthless token, needs your decision** (below).
- **Real bugs users could see are fixed**: the order book could show the previous market's data
  after switching; a filled market order could be reported as "not filled"; the 100% button could
  ask for more than the balance; amounts were worked out with rounding errors; the site hung for a
  minute when the Radix Gateway was slow; the Trades tab listed phantom trades; a third to a half
  of chart candles were malformed.

## What is on `overnight-all`

| Part | What | Detail |
|---|---|---|
| Design | New look for the trading screen at every width, from wide desktop to phone | [design/NOTES.md](design/NOTES.md) and the `before-*` / `after-*` screenshots in [design/](design/) |
| Front-end fixes | Stale-reply guard, exact decimal maths for everything signed, on-ledger cancel, number input and formatting, retries, accessibility | [frontend-fixes.md](frontend-fixes.md) |
| Server fixes | Trial run (preview) before sending, loss limit, fair blame when a fill fails, "pending" outcomes settled from the ledger, listed markets only, `/api/health`, backups, the bugs B2, B3, B4, B6, B7 and more | [fixes.md](fixes.md) |
| Integration | The front end now uses the server's new figures; the server publishes three small extra fields the front end asked for; tests that the two sides agree | below |

### The integration, in plain terms

- **Network fee allowance.** A "whole only" limit order now allows the network fee the server
  quotes for its route **plus 25%**, which is what the solver now expects. Before, orders were
  signed with too small an allowance and could sit unfilled at their price (bug B4). The fee row
  in the form is exactly the figure signed. If there is no quote, the form uses the server's
  fallback (1.5 XRD plus 25%); for a pair with no XRD on either side it will not sign without a
  quote.
- **Decimal places.** The server now says how many decimal places each token allows; the form
  rounds amounts down to that before signing (and says so), so the server never has to refuse them.
- **"Still working".** When a fill has been sent but the ledger has not answered, the order now
  reads "filling: waiting for the ledger, check Trades", and a market order no longer says "not
  filled" in that case. This is what stops someone trading twice.
- **Server messages.** Refusals (wrong decimals, a key already used, too many requests, Gateway
  down) are shown to the user word for word. After "too many requests" the site waits as long as
  the server asks before trying again.
- **Trade prices.** Filled orders in Order history show the price the trade really achieved.
- **On-ledger cancel** is offered only for orders that were signed with the registry check, so
  the button never does nothing.
- **Pool check.** If the solver is ever off and a market order goes straight to a pool, the site
  refuses a route through any pool it does not list.

I traced a market order, a "whole only" limit order (buy and sell) and an "in parts" order from
the form's sums through the server's checks to the solver's fill test, with real numbers; they
agree, and this is now an automatic test (`apps/web/test/agreement.test.ts`).

## What changes for users

- Orders fill more reliably at the price they set; the "at least" figure is a little lower than
  before (by about a quarter of the network fee, roughly 0.3 XRD's worth), which is what lets the
  solver fill at the user's price when fees move.
- Fewer confusing messages: no false "not filled", clear reasons when an order is refused.
- Orders can only be placed in markets the site lists.
- A new **On ledger** cancel button for signed limit orders (a small wallet transaction that stops
  the order whatever the server does).
- The new look.
- If the loss limit ever trips, nothing fills for up to an hour; `/api/health` says so.

## What could not be tested without a wallet

All the numbers, screens and server checks were tested, and the three Stokenet end-to-end tests
passed with the new server (they sign orders with test keys, not the wallet). What no one could
do overnight is **press the buttons with a real Radix Wallet**: signing in the wallet, the wallet's
own display of the "at least" amount, the on-ledger cancel, the cancel of a book order, and how
the Orders panel looks with real orders in it.

### Try this on Stokenet before deploying

Run the branch as the Stokenet site (the current Stokenet instance runs the old code):

    cd /home/jon/Radix/dex
    git worktree add ../dex-stokenet-test overnight-all
    cd ../dex-stokenet-test && npm ci && npm run build -w apps/web
    mkdir -m 700 data && cp ../dex/data/stokenet-keys.json ../dex/data/stokenet-solver.key ../dex/data/stokenet-markets.json data/ && cp -r ../dex/data/tls data/
    ss -ltnp | grep 8788          # note the pid of the old Stokenet server, then: kill -INT <pid>
    scripts/run-stokenet.sh       # same addresses as before: https://<this PC>:8789

Then, with the wallet on Stokenet:

1. **Connect the wallet.** Your account and TUSD/XRD balances appear.
2. **Market order.** Buy XRD with 10 TUSD. The wallet's "at least" should match "You receive"
   less the slippage. It should say "filled" within a few seconds and appear under Trades.
3. **Whole-only limit order.** Limit, Whole only, a price just below the market. Check the wallet
   shows the form's "You receive at least" exactly. Then one well away from the market: it
   should sit in Open orders with a sensible "Fills when".
4. **In-parts limit order.** Limit, In parts, a small order. The wallet moves the tokens into the
   order book; it appears in the book and in Open orders.
5. **Cancel a book order.** Cancel the in-parts order: the unsold tokens come back to the wallet.
6. **On-ledger cancel.** For the resting whole-only order, press **On ledger**, approve in the
   wallet, and check it moves to Order history as cancelled.
7. **Switch markets quickly.** Stokenet has only XRD/TUSD, so do this on the live site after
   deploying (read only): flick between several markets and check the book and price always match
   the market named in the header.

Afterwards stop that server (Ctrl+C), restart the old one the way you normally do if you want it
back, and `git worktree remove ../dex-stokenet-test` when finished.

## Decisions waiting for you

1. **H3, fees in a worthless token (security, high).** Someone can list their own token with a
   pool, place orders that buy it, and the solver pays real XRD network fees and is "paid" in that
   token. Each fill costs about 1 to 1.4 XRD. Options:
   - (a) only accept fees in a short vetted list (XRD, hUSDC, hUSDT, perhaps a few deep tokens);
   - (b) take the fee from the side the user sells, when that is XRD or another vetted token;
   - (c) measure pool depth on ledger and raise the listing floor (only makes the attack dearer).

   **Recommendation: (b) with (a)**: take fees in whichever side of the pair is vetted, and skip
   pairs where neither is. Every market with XRD or a stablecoin keeps working; no contract
   change. Stopgap until then: raise `DEX_MIN_POOL_TVL_USD` (for example to 2,000). Details in
   [fixes.md](fixes.md), section H3.
2. **Lost cancel keys.** A signed order's cancel key lives only in the browser that placed it.
   Clear the site's data and the order cannot be cancelled until it expires. A fix needs a design
   choice: derive the key from a wallet signature, or let users export and import keys.
3. **Run the service as its own user.** Today the solver's key is readable by anything running as
   `jon` (npm installs, tools, agents). A separate system user, as in `deploy/radix-dex.service`,
   closes that. Steps in `docs/MAINNET.md`.
4. **Light theme.** Not built; the new design makes it a contained job if you want it.
5. **Full content security policy.** The site now refuses to be shown inside other sites, but a
   full policy (which scripts may run) must first be tested with the Radix connect button on
   Stokenet.

## Deploying to mainnet

In `/home/jon/Radix/dex` (it is on `main` at `c13042b`, which `overnight-all` builds on):

    cd /home/jon/Radix/dex
    mv docs/review-2026-11-21 ~/review-2026-11-21-untracked   # these three report files are on the branch, unchanged; git would refuse to overwrite them
    git merge --ff-only overnight-all                            # the running server is not affected until it restarts
    npx tsx scripts/backup-db.ts data/orders-mainnet.sqlite data/backups   # consistent copy while it runs
    npm test && npm run typecheck                                # must end with "fail 0" and no errors
    npm run build -w apps/web                                    # the site's pages change as soon as this finishes
    systemctl --user restart radix-dex-mainnet                   # do this straight after the build
    journalctl --user -u radix-dex-mainnet -n 50                 # look for "radix-dex server on", no errors
    curl -s http://127.0.0.1:8787/api/health                     # within a minute: "ok":true

Then open https://dex.difd.net, reload, and switch between a few markets. No new packages are
needed. The database is upgraded automatically on start; the change only adds columns and tables.

**To roll back:**

    cd /home/jon/Radix/dex
    curl -s http://127.0.0.1:8787/api/health      # wait until "pendingTransactions" is 0
    git checkout c13042b
    npm run build -w apps/web
    systemctl --user restart radix-dex-mainnet

The upgraded database still works with the old code (it ignores the new columns). Return with
`git checkout main` when ready.

## Detailed reports

- [security-audit.md](security-audit.md), [quality-review.md](quality-review.md), [bug-report.md](bug-report.md): the four reviews' findings (design in [design/NOTES.md](design/NOTES.md))
- [fixes.md](fixes.md): server fixes, the status of every finding, H3 options, deployment notes
- [frontend-fixes.md](frontend-fixes.md): front-end fixes and exactly what changes in what users sign
- [design/](design/): before and after screenshots at 1750, 1280, 900 and 390 px
