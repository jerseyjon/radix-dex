# Code quality review — 21 Nov 2026

Scope: `packages/core`, `apps/server`, `apps/web`, `scripts`, `scrypto/dex-contracts` (OrderBook read for clarity only), docs. Commit `c13042b`.
What was run: `npm test` (34 tests, all pass, ~1.2 s), `npx tsc --noEmit -p .` and the same with `--noUnusedLocals --noUnusedParameters` (both clean, root and `apps/web`), and a strict type-check of `scripts/*.ts` (38 errors, see below). The Scrypto tests were not run (they need Docker). No mainnet script was run.

## Verdict

The core library is in good shape for something built this fast: amounts are Decimal strings almost everywhere that matters, everything that reaches a manifest goes through `addr()`/`dec()`/`bucket()`, signed orders are checked byte-for-byte against the template, pools are allow-listed by on-ledger package, and the TypeScript is strict and has no unused code warnings. The weak part is the solver's *handling of outcomes* rather than its maths. A fill that times out, or whose bookkeeping throws after it commits, is recorded as a failed fill. A failure caused by the taker is blamed on the makers it was paired with. Nothing is previewed before submission, so every failure costs the solver a fee. And the work per 5-second tick grows with every open order until three-minute market orders can expire waiting. None of these can take users' funds beyond what they signed. They can make the site show wrong statuses (including telling a user a filled market order did not fill), bleed the solver's float, and stall filling. The `Solver` class, where all of this lives, has no tests at all. The front end has two real money-adjacent bugs: floating-point maths for signed amounts, and a stale-response guard that does not work. Operationally the server is running from an interactive shell with no health endpoint, no shutdown handling and no backup. Fix the "Do first" list before announcing the site.

## Recommended changes

### Do first (risk to funds or uptime)

**1. A fill whose outcome is unknown is recorded as a failure. A user can be told a filled market order did not fill.**
`apps/server/src/solver.ts:124-128, 296-312`, `packages/core/src/tx.ts:163-173`, `apps/server/src/store.ts:91-95`, `apps/web/src/OrderForm.tsx:143-151`.
- `submitAndWait` returns `Timeout` after 60 s. The intent window is 120 s / 10 epochs (`solver.ts:110-113`), so the transaction can still commit afterwards. The solver treats `Timeout` as a failure and calls `fail()`.
- If the status poll throws (Gateway outage after `/transaction/submit`, which `Gateway.post` retries only 3 times), the exception reaches the `catch` at `solver.ts:312` and calls `fail()`.
- If anything throws *after* a successful commit (`store.markFilled`, for example `SQLITE_BUSY` with no `busy_timeout`), the same `catch` records a fill failure for an order that filled.
- On later ticks the order's account no longer holds the sell amount, so `funded()` fails (`solver.ts:292`). After 3 failures the order is marked `cancelled` with "Dropped after 3 failed fills". `close()` only moves an order out of `open`, so a fill that is learnt about later can never be recorded.
- The market-order path in the browser polls until expiry and then says "Market order not filled: the price moved beyond your slippage limit" (`OrderForm.tsx:144`). A user who sees that will place the order again and trade twice.

Change: (a) before submitting, store the fill's `intentHashId` against every order in it (a `pending_tx` column). (b) Treat `Timeout` and any throw after `/transaction/submit` as *pending*, not failed. (c) At the start of each tick, resolve pending orders with `/transaction/status`, or per order with `/transaction/subintent-status` (already used in `scripts/stokenet-e2e.ts:85`). (d) Let `markFilled` succeed from `cancelled`/`expired` when the ledger shows the commit, and log it loudly. (e) Move post-commit bookkeeping out of the `try` whose `catch` calls `fail()`. (f) In the form, say "still working, check Trades" rather than "not filled" when the order is still `open` or has a pending transaction.

**2. A taker's own failure is blamed on the resting orders it was paired with. Three cheap failures drop any signed order.**
`apps/server/src/solver.ts:274-276, 290, 305, 135-142`.
`blame = makers` whenever makers are present, so the taker is never charged for a combined failure. An attacker can post a signed order that crosses a victim's resting order and then hard-cancel it on the registry (one small transaction). The fill fails in the taker's `assert_live`, the victim's order takes the failure, and after three rounds the victim's order is cancelled. Each round costs the solver a committed-failure fee, because `lock_fee` is the first instruction and nothing is previewed (`solver.ts:124-128`; DESIGN.md says it previews, but it does not).

Change: count a combined failure against the taker. Put the makers on a short hold *without* adding to their failure count, and count a failure against a maker only when it fails in a transaction where it is the only signed order besides a taker that has since filled through pools alone. Before submitting a combined fill, re-check the taker: funded, not past expiry, and a cheap V1 preview of `registry.assert_live(key)`, which is one Gateway call. The proper fix is a V2 preview of the whole transaction before submit (PLAN.md lists it), which would also stop the fee bleed in item 5.

**3. Sell amounts are never checked against the token's divisibility. Doomed fills cost the solver, and doomed book orders cost the user.**
`packages/core/src/validate.ts:44-46` (accepts up to 18 dp), `apps/web/src/format.ts:44-49` (`cleanAmount` allows 18 dp), `apps/web/src/OrderForm.tsx:99-105` (`setPct` produces up to 8 dp), `apps/web/src/OrderForm.tsx:54` (buy-side size from `p * a`).
A withdraw of an amount with more decimal places than the token allows fails in the engine. The quote hides this, because `Quoter.simulate` rounds to divisibility first (`packages/core/src/quote.ts:84`). The solver's `funded()` check passes, the fill commits as a failure (the solver pays), and the order is retried and dropped. For "In parts" orders the user's own wallet transaction fails. This affects any token with divisibility below 18 (bridged stablecoins and BTC wrappers commonly use 6 or 8).
Change: in `POST /api/orders`, load the sell token's divisibility (`data.quoter.divisibility`) and reject a `sellAmount` with more places. Add `divisibility` to the tokens in `/api/markets`, and round every amount in the form down to it before signing.

**4. The solver's work per tick grows with every open order, and market orders wait behind it.**
`apps/server/src/solver.ts:157-183, 250-347`, `apps/server/src/main.ts:13`, `apps/server/src/app.ts:149-167, 249`.
On every 5-second tick, every open signed order is re-quoted. `bestExecution` runs up to five sequential `quoter.best()` calls, each up to four parallel previews, and they bypass `MarketData`'s quote cache. Every live book order then gets at least one preview in `arbitrage()` (`solver.ts:209`). Ticks run one at a time (`running` flag), and the kick from `POST /api/orders` returns at once if a tick is already running (`app.ts:249`). At roughly 0.5 s per `best()`, about 100 open signed orders make a tick last minutes. A market order lives 180 s (`app.ts:15`), less the 15 s taken off by `expire(now + 15)`, so it can expire unfilled. The same Gateway client also serves public `/api/quote` (four uncached previews per distinct amount) and `/api/balances` (up to 20 pages per request), each at 240 requests a minute per visitor. A burst can get the server throttled by the public Gateway (429s are retried with backoff in `gateway.ts:36-61`, so ticks slow down further).
Change: (a) run market orders on their own fast path, so a new market order is tried at once and is never queued behind resting orders. (b) Skip a resting order on a tick when the cached depth mid is more than a few per cent from its trigger. Re-quote it only when the mid moves or every N ticks. (c) Share one quote cache between the solver and the API, keyed by pair and amount, valid for one tick. (d) Put a small concurrency limiter in front of `Gateway.preview` that serves the solver first. (e) Log each tick's duration and the number of previews it made.

**5. Buying from the book can spend the XRD needed for the fee lock, and failed book purchases retry for ever.**
`apps/server/src/solver.ts:210-213, 218, 242, 324-327, 334`, `packages/core/src/orderbook.ts:81-82, 250-251`.
When a book order wants XRD, `arbitrage()` compares the cost with the solver's whole XRD balance. The manifest locks 10 XRD (`FEE_LOCK_XRD`) and then withdraws the cost, so a cost within 10 XRD of the balance fails after the lock and the solver pays a fee. `bookRetryAt` then waits only 60 s, has no failure cap (unlike signed orders' `MAX_FILL_FAILURES`), lives only in memory, and starts again with the largest share. `planBookCross` is given the same unreserved float at `solver.ts:324-327`.
Change: when the payment token is XRD, use `float = balance − FEE_LOCK_XRD − 2` (or a configured reserve). Give book orders the same backoff-and-give-up rule as signed orders (`60 * 4^n`, then skip until the book order changes). Log the solver's XRD balance on every purchase.

**6. Signed amounts and on-ledger prices are worked out with JavaScript `Number` in the browser.**
`apps/web/src/OrderForm.tsx:54, 61, 89-96, 139, 153, 161`, `apps/web/src/format.ts:52-57`.
The signed minimum (`limitMinBuy`), the market-order floor and the "In parts" contract price are all floating-point results passed through `toPlain`. `toPlain`'s comment says "at most 18 places", but it caps at 12 (`10 ** Math.min(p, 12)`). For a buy order in the book, the contract price is `1/p` floored to 12 decimal places (`OrderForm.tsx:161`). The higher the base token's price in the quote token, the fewer significant figures survive. At `p = 2e10` only two remain (5e-11), which can set the maker's price up to about 2% worse than the price typed. `Decimal` is already exported from `@radix-dex/core/browser` (through `manifest.ts`).
Change: compute every figure that is signed or sent to a contract with `Decimal`. Round the book price in the maker's favour (`new Decimal(1).div(price).toDecimalPlaces(18, ROUND_UP)` for bids). Keep `Number` for display only. Move this maths into a pure `orderTerms()` function in `apps/web/src/book.ts` so it can be tested (see test 5).

**7. The "ignore stale responses" guard in the polling hooks does not work. The book can show another market's prices, and clicking one sets the limit price.**
`apps/web/src/App.tsx:16-25, 73-84`.
`setDepth((cur) => (id === market.id ? d : cur))` compares `id` with the `market` captured in the same closure, so it is always true. `usePolling`'s `live` flag is checked only before the request starts. After a market switch, a slow response for the old market overwrites `depth`, and the next poll is 20 s away. `Book` rows and the depth chart call `onPick`, and `OrderForm.tsx:47` turns that into a limit price. An "In parts" order placed at another market's price would be bought at once by the solver's own `arbitrage()`. The same flaw lets one account's balances show after switching to another (`App.tsx:86-93`).
Change: pass a `isCurrent()` callback (or an `AbortSignal`) from `usePolling` into `load`, and check it after every `await`. Or hold the selected market id in a `useRef` and compare against `ref.current`.

**8. How the server runs: no supervisor, two data directories, no shutdown handling, no backups.**
- At review time both servers were running as `npm exec tsx apps/server/src/main.ts` children of a desktop session, and `systemctl is-active radix-dex` reported `inactive`. A crash or logout stops filling, and the logs go to a terminal.
- `scripts/run-mainnet.sh` uses the default `DEX_DATA_DIR=data`. `deploy/radix-dex.service:14` uses `/var/lib/radix-dex`. Switching to the unit would start with an empty order database: open signed orders would silently disappear from the book and never fill.
- `apps/server/src/main.ts` has no `SIGTERM`/`SIGINT` handler. A restart in the middle of `submitAndWait` leaves the outcome unknown (see item 1), and the database is never closed.
- No backups (MAINNET.md lists them as to-do). In `data/`, `orders-mainnet.sqlite` is 4 KB and its `-wal` file is 152 KB: copying the `.sqlite` file alone backs up nothing. Both database files are mode 644. They hold signed orders and cancel-key hashes, while the key file is checked for 600.
- The unit runs `/usr/bin/npx tsx`, but `tsx` is a devDependency (`package.json`), so `npm ci --omit=dev` would break it.

Change: run under the unit, with `UMask=0077`, `TimeoutStopSec=90` and one agreed `DEX_DATA_DIR`. Move the existing database across with the server stopped, copying all three files. Add a shutdown handler: stop the intervals, wait for the current tick (90 s at most), then `db.close()`. Add a nightly `VACUUM INTO '/var/backups/radix-dex/orders-YYYYMMDD.sqlite'` (from a timer or inside the server). Move `tsx` to `dependencies`.

**9. Nothing tells an operator that the solver has stopped working.**
`packages/core/src/quote.ts:139`, `apps/server/src/solver.ts:163, 198, 230, 279`, `apps/server/src/marketdata.ts:105-110`.
When the Gateway is down, every quote error becomes `undefined`, `bestExecution` returns nothing, and the order is skipped without a log line. The UI shows "checking…" for ever. `xrdValueIn` caches a failed rate (`perXrd: undefined`) for 120 s, so one blip stops all fills in that token for two minutes. Accepted orders, cancels and ticks are not logged at all. Only rejections, fills and fill failures are.
Change: add `GET /api/health` returning `{ lastTickAt, lastTickMs, previewsLastTick, quoteErrorsLastTick, openSigned, liveBook, solverXrd, gatewayOk, marketsRefreshedAt, bookRefreshedAt }`, with HTTP 503 when the last tick is over 60 s old or the solver holds less than `FEE_LOCK_XRD + 20` XRD. Point an uptime monitor at it (for example the ntfy set-up already used for validator alerts). Log one line per tick when quotes failed with errors (as opposed to no route). Log accepted orders (id, kind, pair, amounts) and cancels. Do not cache a failed `xrdValueIn` result.

### Do soon

10. **Tell "the quote failed" apart from "there is no route".** `quote.ts:139`, `solver.ts:163-176`. When the remainder cannot be quoted and a signed maker is in the plan, the solver hands the whole remainder to that maker as a better price (`solver.ts:171-174`). That is right for markets with no pool. During a Gateway error it gives the remainder away instead of waiting. Make `Quoter.best` return `{ kind: 'none' } | { kind: 'error' } | Quote`, and skip the order on `error`.
11. **Record what was really received, and when.** `solver.ts:306-307` stores `plan.userReceives`, which is a prediction: the pool leg pays whatever the pool gives. `app.ts:45` uses `o.createdAt` as the trade time, and `store.ts:85` sorts fills by `created_at`, so a limit order that rested for a week shows as traded on the day it was placed. Add `filled_at`, and read the taker's real receipt from the committed transaction's balance changes (`opt_ins.balance_changes`) when reconciling (item 1).
12. **Don't drop an order because its balance dipped.** `solver.ts:292` counts "account no longer holds the sell amount" as a fill failure, so three checks about 21 minutes apart cancel the order although nothing was spent. Keep a separate `unfunded_since` and leave such orders to expiry, or drop them only after hours.
13. **Put all fee and gas constants in one place.** They are spread across `solver.ts:20-47` (0.7, 0.38, 0.5, 0.6, 0.45, `GAS_XRD = '1'`, `FEE_LOCK_XRD = '10'`), `app.ts:125` (sends `GAS_XRD` to the browser as `gasXrd`), `OrderForm.tsx:89` (uses it as a fallback) and `OrderForm.tsx:221` ("about 0.8 XRD"). DESIGN.md:168 states yet another figure (1 + 0.35). The book-cross path charges a flat `GAS_XRD` (`solver.ts:325`) while fills use measured costs. Move them to `packages/core/src/costs.ts` with the measurement date beside each number, and have `/api/config` publish `fillGasXrd(0)` rather than a separate constant.
14. **Make config parsing strict.** `apps/server/src/config.ts:59-76`: `Number('abc')` gives `NaN`, and `DEX_RATE_PER_MINUTE=NaN` turns the rate limit off (`++count > NaN` is always false, `http.ts:44-50`). The same applies to the port, the maximum lifetime and the open-order cap. Add an `int(name, default, min, max)` helper that throws.
15. **Refresh the quote funders.** `quote.ts:70-80` caches the top holders of each token for the life of the process. As holders move funds, previews fail at `withdraw` and fall through to the next holder. Once all three cached holders fail, every quote for that token is `undefined` until a restart. Give the cache a TTL of about an hour, and re-fetch once when all funders fail.
16. **Bound and persist the book history.** `apps/server/src/book.ts:12, 39`: `fills` grows without limit, and `eventsFrom` resets to 1 on every restart, so each restart re-reads the order book's whole event history (30 pages at a time, on each `refresh`). Store fills and `eventsFrom` in SQLite next to the orders.
17. **Split and document the solver.** `tick()` (`solver.ts:250-352`) does three unrelated jobs in one `try`. Split it into `fillSignedOrders(open, now)`, `crossBookOrders(solver)` and `buyBookOrdersFromPools(solver)`, each returning its counts. In `bestExecution` (`solver.ts:153-185`), move the no-pool remainder branch (`165-176`) into a named `giveRemainderToFirstMaker()`, and state the invariant on `Execution`: the sum of `items[].cost` plus `poolIn` equals the taker's `sellAmount`, except for dust of at most 1e-9 that goes to the solver. In `arbitrage()` (`192-247`), the two strategies share the submit/backoff/log code. Pull that into `submitBookPurchase()`. The comment at `274-275` says the taker "can try again at once": it cannot, it waits for the next tick.
18. **Type-check the scripts, and fix the withdrawal script's arithmetic.** The root `tsconfig.json` includes neither `scripts/` nor `apps/web`. A strict check of `scripts/*.ts` gives 35 errors in `stokenet-e2e.ts` and 3 in `mainnet-withdraw.ts`. `mainnet-withdraw.ts:10` imports `decimal.js` directly. That copy has the library defaults (20 significant digits, round half up), not core's 60/round-down, so `have.minus(keep).minus(1)` at line 37 can round an 18-decimal XRD balance *up* and fail the preview. Import `Decimal` from `packages/core/src/index.ts`, and add `scripts` to `include` (or give them their own tsconfig run by `npm run typecheck`, which should also run `tsc -p apps/web`).
19. **Add CI.** There is no `.github/`. One workflow is enough: `npm ci`, `npm test`, `tsc -p .`, `tsc -p apps/web`, `npm run build -w apps/web`, and, when `scrypto/**` changes, `scrypto/run.sh test`.
20. **Make the Scrypto artefact traceable.** `data/` is git-ignored, so the deployed `data/contracts/dex_contracts.wasm` (sha256 `b3954135…f4082a`) is not tied to any commit. `scrypto/run.sh` builds into a Docker volume and nothing documents how the files reached `data/contracts/`. The base image is a tag (`rust:1.92-bookworm`), not a digest. Record the commit, the wasm and rpd sha256, the package address and the build command in a tracked `deploy/mainnet-package.json`. Pin the image by digest, and add a script step that rebuilds and compares the hash with the package's code hash on the ledger.
21. **Offer the hard cancel in the UI.** Every signed order carries `registry.assert_live` (`OrderForm.tsx:130`), but `Orders.tsx:54-65` offers only the soft cancel, which relies on the server and on the secret in this browser's `localStorage`. Add a "Cancel on ledger" action that sends `registry.cancel(secret)` from the wallet, and warn that losing the browser storage loses both kinds of cancel.

### Nice to have

22. **Dead and first-version code.**
- `poolFillManifest` (`packages/core/src/orders.ts:86`) has no callers.
- `inventoryFillManifest` and `crossFillManifest` (`orders.ts:111, 127`) are used only by `scripts/stokenet-e2e.ts`.
- `planCross`, `findCrosses` and `pickMakers` (`packages/core/src/solver.ts:49, 58, 112`) are used only by tests. `pickLiquidity` replaced them, so four of the twelve solver tests give comfort about code that does not run.
- `data/contracts/v1/` is referenced nowhere.
- `scripts/stokenet-e2e.ts` is the first-version flow, but other scripts need it to create `data/stokenet-keys.json`. Move key generation into `stokenet-setup.ts`, then delete it.
- Smaller leftovers: the `DELETE` in `http.ts:78` (no such route); `Quote.stateVersion` (never set); the `radixdex` `VenueId` (no allow-listed package); the orphaned doc comment at `gateway.ts:73-76` (it belongs to `accountActivity`, not `swapsAt`); `inspect-rejected.ts` with `networkId = 2` hard-coded.
- PLAN.md is largely stale (see the docs section).

23. **Duplication.**
- Two divisibility caches: `quote.ts:56-68` and `solver.ts:92-104`.
- `String((e as Error).message ?? e).slice(0, 200)` appears eight times in the server. Add `errText(e)`.
- The pool-listing pipeline (list, allow-list, ledger token names, `buildMarkets`) is repeated in `marketdata.ts:69-87`, `scripts/live-check.ts`, `scripts/depth-check.ts` and `scripts/snapshot.ts`. `live-check.ts` already drifts: it ranks quote currencies by XRD only and ignores the stablecoins.
- Converting the order book's "buy per sell" price into the market's quote-per-base price is done separately in `app.ts:61-83`, `Orders.tsx:29-36` and `OrderForm.tsx:161`. Add one Decimal helper in core.
- The explorer URL is built twice (`App.tsx:153, 157`).
- The expiry `<select>` is repeated (`OrderForm.tsx:226, 237`).
- The arbitrage branches (item 17).

24. **Accessibility.**
- The price chart canvas has no label (`Chart.tsx:143`). DepthChart has one.
- Neither chart supports touch or the keyboard. The book rows are buttons, so picking a price is still possible by keyboard.
- `role="tab"` is used without `tabpanel`/`aria-controls` or arrow keys (`App.tsx:142-146`, `Book.tsx:34-37`). `Orders.tsx:70-74` and the Buy/Sell, Market/Limit, slippage and In parts/Whole only toggles (`OrderForm.tsx:185-191, 214, 218, 230`) show their selected state only by colour. Add `aria-pressed`.
- Error paragraphs (`OrderForm.tsx:244`, `Orders.tsx:76`) need `role="alert"`.
- The expiry selects have no accessible name.
- Contrast is acceptable: muted text `#7c8697` on `#11151c` is about 5:1. But much of the text is 10–11 px.

25. **Small server issues.**
- A malformed percent-escape in a static path makes `decodeURIComponent` throw (`http.ts:55`), which is a 500, not a 400.
- An unknown candle resolution rejects with a plain `Error` (`marketdata.ts:147`), also a 500.
- `/api/markets` is loaded once per page (`App.tsx:47-53`), so a tab opened while the server's first refresh failed never sees markets.
- The `// eslint-disable-next-line` comments (`App.tsx:23`, `DepthChart.tsx:114`) refer to a linter the project does not have. Either add `eslint-plugin-react-hooks` alone (catching stale closures like item 7 is exactly its job), or remove the comments.

26. **Tooling hygiene.**
- Add `--noUnusedLocals --noUnusedParameters` to `npm run typecheck`. The code is already clean, so it costs nothing to keep it so.
- Pin the Node major version (`"engines": { "node": "22.x" }` plus `.nvmrc`), because `node:sqlite` is still experimental in 22 (the server logs an `ExperimentalWarning` at start).
- `@steleaio/radix-engine-toolkit@2.0.0-dev` is a pre-release from a personal scope. It notarises every fill. It is pinned exactly and locked by integrity hash, which is right; record why that build is needed and check for a release before each upgrade.

27. **Contract clarity (OrderBook is live and cannot change; for the TypeScript beside it).**
- `price` is buy tokens per sell token, so a bid's price is the inverse of the market price. That inversion is the source of item 6 and of the duplication in item 23, so state it once in `orderbook.ts` next to `BookOrder.price`.
- `fill` returns `(bought, change)`. In `takeFillManifest` the change (at most rounding dust) goes to the solver's `deposit_batch`, not to the taker. Write that down beside `bookFillInstructions`.
- `OrderClosedEvent` is emitted but never read. That is harmless, and worth a comment in `readBookEvents`.

## Test gaps

What is covered: `payout`, `planPoolFill`, `grossNeeded`, `pickLiquidity`, `takeFillManifest`'s shape, `planBookCross`, `validateLimitOrder` (template match, signer, expiry, badge, registry key, tampering), manifest injection guards, `buildMarkets`, `mergeDepth`, the order HTTP lifecycle (place, list, cancel, cap, duplicate), store failure counting, `fillGasXrd`, `marketTrades`, `orderLevels` and `swapsInTransaction`.

What is not covered at all: the `Solver` class, `Gateway`, `Quoter`, `readBook`/`readBookOrders`/`readBookEvents`, `BookWatcher`, `MarketData`, venue listing and `filterAllowedPools`, `bookArbManifest`, `bookArbPoolFirstManifest`, `bookCrossManifest`, `bookPlaceManifest`, `bookCancelManifest`, `bookLevels`, `http.ts` (static files, rate limit, body cap), the store's migrations, every file in `apps/web` (no web test runner), and every script.

All of the tests below can run offline. `buildTransaction` and `signSubintent` use only the local toolkit, as `api.test.ts` already shows, and the Gateway and MarketData can be faked with plain objects cast `as unknown as Gateway`. In priority order:

1. **The fill outcome is reconciled, not failed** (item 1). Use a fake Gateway whose `post('/transaction/status')` throws twice and then reports `CommittedSuccess`, or reports `Timeout` and on the next tick `CommittedSuccess`. Sign a taker order with `signSubintent`, fake a quote, run `tick()` twice, and assert the order is `filled` with that txid and `failures === 0`. Today it ends `cancelled`.
   ```ts
   const gw = fakeGateway({ status: [throws, throws, { intent_status: 'CommittedSuccess' }] });
   const s = new Solver({ config, gateway: gw, store, data: fakeData({ quote }), key, badge });
   await s.tick(); await s.tick();
   assert.equal(store.get(id)!.status, 'filled');
   ```
2. **A taker's failure is not charged to its makers** (item 2). Put one resting signed order (maker) and one crossing taker in the store, and use a fake submit that returns `CommittedFailure` on the first two calls. Assert `maker.failures === 0`, the maker is still `open`, and the taker's `failures === 1`. Today the maker takes the failure.
3. **Book purchases keep the fee lock** (item 5). Set the solver's XRD balance to `cost + 5` for a book order that wants XRD. Assert `arbitrage()` either picks a smaller share or submits nothing, and never builds a manifest that withdraws more than `balance − FEE_LOCK_XRD`. Also assert that a book order failing three times is not tried a fourth time.
4. **Choosing the execution.** With a fake `quoter.best` returning given amounts, assert that `bestExecution` (i) chooses pools only when they pay more after gas, (ii) takes a cheap maker when it beats the pools by more than 0.38 XRD of gas, (iii) skips the order when `xrdValueIn` returns `undefined`, and (iv) after item 10, does not give the remainder to a maker when the quote *errored*.
5. **Order-form maths** (item 6). After moving it into `apps/web/src/book.ts` as `orderTerms()`, run it under `node:test` (it is pure TypeScript). Cases: a book bid at `p = 2e10` keeps 18 decimal places and rounds in the maker's favour; `limitMinBuy` equals `gross − network − service` exactly in Decimal; amounts are cut to divisibility 6 and 8; `toPlain` keeps 18 places.
6. **Divisibility at intake** (item 3). An order selling 1.1234567 of a 6-decimal token gets a 400. Use a fake `quoter.divisibility`.
7. **Stale polling** (item 7). Move the "is this response still current?" logic into a tiny pure helper and test it with two promises that resolve out of order. Or add `vitest` for `apps/web` only, if one dev dependency is acceptable.
8. **Gateway client.** `post` retries 5xx and 429 but not other 4xx. `fungibleBalance` adds several vaults exactly (`'0.1' + '0.2'`, 18-decimal sums, an empty list). `fungibleBalances` follows the cursor at the same `state_version`.
9. **Reading the order book.** `readBookOrders` rejects a negative or exponent amount and skips entries without fields. `readBookEvents` ignores an `OrderFilledEvent` emitted by another component and a non-`Main` module, follows `next_cursor`, and stops on the "beyond the end of the known ledger" error. Use fixtures saved from a real Gateway response.
10. **HTTP edge cases.** `GET /..%2f..%2fetc%2fpasswd` gives a 404 (and must not serve the file), `GET /%E0%A4%A` gives a 400, a 65 KB body gives a 413, the 241st request in a minute gives a 429, and with `clientIpHeader` set the limit is per header value.
11. **Store.** Opening a database made with the first schema adds `failures`, `limit_buy_amount` and `kind` and keeps the rows. After item 1, `markFilled` on a `cancelled` order backed by a committed transaction succeeds.
12. **Venue listing.** `listOciswap` stops when `next_cursor` is 0 or goes backwards, and when a page falls below the TVL floor. `filterAllowedPools` drops a pool whose package is allow-listed for a different venue.
13. **The withdrawal script's arithmetic** (item 18). Extract `planWithdrawal(balances, keep)` and check that a balance of `1234.123456789012345678` XRD never moves more than it holds.

## Out-of-date statements in the docs

README.md
- "Status: … Nothing here has been run on mainnet with real money." The site went live on mainnet today.
- "`Pool` and `OrderBook` … Do not deploy them to mainnet without a review." OrderBook is deployed on mainnet (MAINNET.md, `mainnet-setup.ts` step `orderBook`).
- "Limit orders are subintents … funds stay in the user's account until the fill." This is true only of "Whole only" orders. The default form setting is "In parts" (`OrderForm.tsx:33`), which moves the funds into the OrderBook contract.
- "Needs Node 22+." `package.json` requires `>=22.18`.
- The variables table leaves out `DEX_DATA_DIR`, `DEX_MIN_POOL_TVL_USD`, `DEX_MAX_ORDER_LIFETIME_SEC` and `DEX_MAX_OPEN_ORDERS` (`config.ts:61-72`).
- `npx tsx scripts/stokenet-e2e.ts` is listed as a test, but it no longer type-checks and exercises the first-version manifests.

docs/DESIGN.md
- Principle 1, "No pool, no escrow, no order-book vault. The only on-ledger code we publish (the order registry) stores hashes": OrderBook holds makers' tokens. The section added later calls it an exception, but the principle was not changed.
- "`scrypto/order-registry`" in Components: the package is `scrypto/dex-contracts` and contains three blueprints.
- Venues table, "DefiPlaza | `dex.swap(bucket, output_resource)`": the code calls `swap(bucket)` on the pair component (`venues.ts:13, 128-132`).
- "Results are cached per ledger state for a few seconds": they are cached by time (quotes 8 s, depth 20 s; `marketdata.ts:38-41`), not by ledger state.
- "Market orders: An ordinary wallet transaction … The user pays the network fee": this is now only the fallback. With a solver, a market order is a subintent filled by the solver (later section, `OrderForm.tsx:137`).
- "It previews first and submits only if the preview succeeds": the solver does not preview (`solver.ts:124-128`).
- "Order vs order … (up to 32 orders per transaction)": at most 4 items are taken (`orderbook.ts:160`).
- "Soft cancel: the server deletes the order": it marks the order `cancelled` (`store.ts:96`).
- "Float is swept regularly": only by hand, with `scripts/mainnet-withdraw.ts`.
- "Out of scope for v1: Own pools, escrow order book, partial fills": the escrow order book and partial fills are live.
- "The taker pays the network fee: 1 XRD, plus 0.35 XRD per resting order taken": the code charges 0.7 + 0.38 per item, or, with a pool leg, the measured swap cost + 0.5 + 0.38 per item (`solver.ts:26-36`).
- "taking the best one, two or three resting orders": up to four (`orderbook.ts:160`).
- "the trigger less the fee allowance (the network fee, about 1 XRD, plus the service fee)": the form uses the route's measured cost (`gasInBuyToken`, `app.ts:160`).

docs/MAINNET.md
- Step 4, "files in `data/contracts/`": that folder also holds an unreferenced `v1/` build, and nothing says how the files there were built (item 20).
- Step 6, "Install `deploy/radix-dex.service`": at review time the server was not running under it. The unit's `DEX_DATA_DIR=/var/lib/radix-dex` differs from `run-mainnet.sh` (`data/`), and the document does not say to move the database.
- "network fees (about 1 XRD per fill)": measured fills are 1.0–1.4 XRD, failed fills also cost fees, and book purchases need the float plus the 10 XRD fee lock.

docs/PLAN.md (dated 21 Nov, but describes the state before the order book and the mainnet set-up)
- "Needs the owner: dApp definition account …": done (`mainnet-setup.ts` step `dappDone`).
- "Escrow order-book blueprint with partial fills": done and live.
- "Limit orders fill whole or not at all": true only of "Whole only" orders.
- "The solver charges no network-fee recovery on pairs where neither side is XRD": it now charges the fee in any token an XRD route prices, and *refuses to fill* when none does (`solver.ts:181`), so such orders wait until they expire.
