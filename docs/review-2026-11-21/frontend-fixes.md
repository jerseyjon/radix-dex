# Front-end fixes, 21 Nov 2026

Branch `frontend-fixes`, on top of `design-overhaul`. Only `apps/web` changed, plus one line in
the root `package.json` (the test script now also runs `apps/web/test/*.test.ts`). Nothing is
deployed and nothing is pushed.

Commits:

- `3923904` Web: exact decimal helpers for order amounts, stale-reply guard, registry cancel manifest
  (new `apps/web/src/money.ts`, `live.ts`, `registry.ts` and their tests; not yet used by the UI)
- `36ee22b` Web: drop stale market and account replies; exact maths for signed amounts; input, format and a11y fixes
  (wires the helpers into `App.tsx`, `OrderForm.tsx`, `Orders.tsx`, `Chart.tsx`, `Book.tsx`, `format.ts`, `ui.tsx`, `styles.css`)

The second commit is larger than I would like: the changes cross the same files (props and
imports between `App`, `OrderForm`, `Orders` and `ui`), so smaller steps would not each compile.
Its message lists every fix.

## Status of each finding

| Finding | Status | Notes |
|---|---|---|
| B1 / quality 7: stale replies after switching market | Fixed, `36ee22b` | Market data (depth, trades, candles, picked price) and account data (balances, orders, history) are stored with the key they were loaded for and only read under the current key; `usePolling` passes an `isCurrent` guard checked after the await. Reproduced before the fix in the browser (REDDICKS/XRD showed DFP2/XRD's mid 1.2267 when a DFP2 reply was held 6 s); after the fix, 6 rapid switches with the DFP2 replies held 6 s left REDDICKS showing 1.0042 throughout. |
| B9: previous market's price in the header | Fixed, `36ee22b` | Same keying: 50 ms after a switch the header shows "Price —" and the book skeleton, never the old market's figures. |
| Quality 6 / B5 / audit L5: Number maths for signed amounts | Fixed, `3923904` + `36ee22b` | See "What changes what a user signs" below. Tests compare against exact decimal results, including 18-decimal amounts, prices from 1e-18 to 3e13, and 0/6/8/18-place rounding. |
| B5: 100% button above the balance | Fixed | `shareOf`: 100% is the balance string itself; other shares are rounded down. "Not enough" now compares exactly (`exceeds`). |
| Audit L6: direct-to-pool fallback asserts the route's last token | Fixed in the browser (partly) | Without a solver, the form refuses to sign unless `routePath(route, sell)` ends in the token the user chose, and the quote's sell/buy/amount match the form. Then the route's last token *is* the chosen token, so `marketOrderManifest`'s assertion is on it. **Not done (needs server work):** checking that every pool in the route belongs to this market; `/api/markets` does not list pool addresses. |
| B14: `1e-5` becomes `15` | Fixed | Plain scientific notation is converted (`1e-5` → `0.00001`); anything else that is not a plain number is refused (the field keeps its value and a hint says why). |
| B19: silent no-ops on submit | Fixed | Every early return sets a message. Very large limit buys no longer show "—" (exact maths). A book buy whose inverted price cannot be held to 1 ppm in 18 places is blocked with a reason. |
| B8: market estimate claims a full fill | Fixed | When the book shown cannot take the whole amount: "The book shown can take only X of Y". Quote errors (e.g. "No route with enough liquidity") are shown in the summary, not only behind the wallet button. |
| B15: picked price rounded; repeat click does nothing | Fixed | The level's own number goes into the field as a plain decimal (full precision, so it can look long, e.g. `0.001121678077207665`), and each click carries a counter so a repeat click re-fills it. Picks are keyed by market. |
| B20: first-load error is final | Fixed | Retries with backoff (1, 2, 4 … 30 s), shows the error and when it will retry, and a "Try now" button. The server's `Retry-After` on 429 is server work. |
| B16: `9.000e-7`, `123450000000.00B`, `1000.0K` | Fixed | Now `0.0000009`, `123,450,000T`, `1.00M`. `fmtPrice(1e-20)` shows an exponent rather than `0`. |
| B17: chart labels cut off for BTC-type prices | Fixed | The price axis is sized to its widest label (at least 72 px, at most half the chart) and large prices are grouped with no decimals (`119,124,744`). Checked on hWBTC/XRD. |
| Design note 2: last-price tag over an axis label | Fixed | A grid label within 16 px of the tag is not drawn. |
| Design note 1: header price vs chart last price | Fixed (labelled) | The header now says **Mid** (order book) or **Last** (chart, when the book has not loaded), with a tooltip explaining that the chart shows trade prices and can differ. The values themselves still differ by design (bug report's last suspicion; `marketdata.ts`). |
| Design note 3: pair button toggles a hidden drawer above 1100 px | Fixed | Above 1100 px it focuses the markets search instead (no `aria-expanded`); an open drawer closes when the window widens past 1100 px (checked by resizing 900 → 1280). |
| Design note 4: "Change (chart)" read as 24h | Fixed | On 15m and 1h candles the chip is a true 24-hour change (latest close against the last close at or before 24 h ago) and says "24h". On 4h/1d/1w it shows the change across the loaded candles, labelled with their span (e.g. "300d") and a tooltip saying it is not a 24-hour change. |
| M3: cancel secret only in one browser | Partly fixed; rest needs core/wallet design | Added an **On ledger** cancel for open signed orders whose secret is in this browser: a wallet transaction `CALL_METHOD <registry> "cancel" Bytes("<secret>");`, then the server's soft cancel. The limit-order note now warns that clearing site data loses the cancel key. **Not built:** recovery when the secret is lost. That needs the secret to be derivable (for example from a wallet-signed message plus the order's parameters, which needs a decision on the derivation and a core helper), or an export/import of secrets. Also, `OrderView` does not say whether an order was signed with `assert_live`; orders signed while the server had no registry configured are not stopped by the ledger cancel (the soft cancel still runs). Adding `registry: boolean` to `OrderView` would let the UI offer the button only where it works. |
| Quality 24 / section 7 accessibility | Fixed (quick items) | Tabs: `tabpanel`, `aria-controls`, one tab stop, arrow/Home/End keys (shared `Tabs`/`TabPanel` in `ui.tsx`; the panel wrapper is `display: contents`, so layout is unchanged). Price chart canvas has a label. Error messages have `role="alert"`. Expiry selects named. Order-type, slippage and fill-mode controls expose `aria-pressed` (order type is now a button group, not tabs). **Not done:** keyboard/touch for the charts, small (10–11 px) text. |
| Quality 3: divisibility | Partly (front end only) | The percentage buttons round to the token's places when known (XRD 18, or a `divisibility` field if the server adds one); otherwise to the places written in the balance string, which is a safe lower bound but can be coarser than needed (a balance of `1.5` gives 25% = `0.3`). Typed amounts are not rounded to divisibility. **Needs server work:** `divisibility` on tokens in `/api/markets` (quality item 3), and the server-side check on `POST /api/orders`. |
| B6: fill time on trade rows | Defensive only | `OrderView.filledAt` is optional; order history shows it when present and works without it. Market trades use `time` as before. |
| Audit: XSS review | No change needed | Nothing added uses `innerHTML`; all new text is rendered by React. The on-ledger cancel manifest refuses anything but a 32-byte lowercase hex secret and a valid address (tested). |
| B2, B3, B4, B6 (server side), B7, B10–B13, B18 | Not mine | Server, core and scripts: handled on the other branch. |

## What changes what a user signs

Before, these figures went through JavaScript `Number` and were floored to 12 decimal places.
Now they are exact `Decimal` arithmetic, rounded as stated, and passed as plain strings to the
unchanged manifest builders in `@radix-dex/core`:

1. **"Whole only" signed limit order** (`limitOrderManifest`): `sellAmount` is the typed amount
   (sell) or `price × amount` rounded **down** to 18 places (buy; to the quote token's places if
   known, XRD 18). The signed `minBuyAmount` is `gross − network fee − gross × feeBps / 10000`,
   rounded **down** to 18 places, where `gross` is `price × amount` (sell) or the amount (buy).
   The network fee is the quote's `gasInBuyToken` when present, else `gasXrd` when buying XRD,
   else `gross / sellAmount × gasXrd` when selling XRD, else 0 (same rules as before). In
   practice the signed minimum changes only beyond the 12th decimal place, and can be slightly
   higher than before (the old floor lost up to 1e-12).
2. **Market order through the solver** (`limitOrderManifest`, kind `market`): `minBuyAmount =
   (quote.buyAmount − fees) × (100 − slippage%) / 100`, rounded down to 18 places. If that is
   not positive the button is blocked ("Too small for the slippage limit").
3. **Market order without a solver** (`marketOrderManifest`): `minBuyAmount = quote.buyAmount ×
   (100 − slippage%) / 100`, rounded down to 18 places. The transaction is **refused** unless
   the quoted route runs from the token sold to the token the user chose, and the quote is for
   the current tokens and amount.
4. **"In parts" order in the on-ledger book** (`bookPlaceManifest`): a sell signs the typed
   price unchanged. A buy signs `1 / price` at 18 places rounded **up** (more base per quote, in
   the maker's favour; before, it was floored at 12 places, against the maker). The form refuses
   a buy whose inverse cannot be held within 1 ppm at 18 places (prices above roughly 10^12
   quote per base). Example: at 3 quote per base the contract price is now
   `0.333333333333333334` (was `0.333333333333`).
5. **Percentage buttons** fill different values: 100% is exactly the balance; others are rounded
   down (see the divisibility row above).
6. **New transaction: on-ledger cancel.** `CALL_METHOD Address("<registry>") "cancel"
   Bytes("<secret>");` (the wallet adds the fee lock). It publishes that order's cancel secret
   on the ledger, which can cancel only that order.

Nothing else about how orders are built or signed was changed: same manifests, same fields sent
to `POST /api/orders` (`limitBuyAmount` is now the exact gross).

## How it was checked

- `npx tsc --noEmit -p .` (root), `npm run build -w apps/web` (which type-checks `apps/web`
  including its tests) and `npm test` (57 tests: 34 existing plus 23 new web tests in
  `apps/web/test/`) pass at both commits; the first commit was checked on a clean tree.
- Browser, Vite on 127.0.0.1:5198 proxied to the mainnet server on 8787, GET requests only, no
  wallet: B1 reproduced before and gone after (above); B9 checked; awkward inputs (`1e-5`,
  `-5e3abc`, a 3e13 price, a 1e-18 price with a 21-digit amount, a 100-billion spend on
  hWBTC/XRD); keyboard tabs; widths 1750, 1280, 900 and 390 px (no horizontal scroll, drawer
  behaviour, design intact). No console errors on a clean load.
- Not exercised: anything that needs a wallet (signing, the on-ledger cancel, the retry screen
  under a real 429; the retry logic is a small loop and its backoff is unit-tested).
