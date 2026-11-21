# Bug report: radix-dex, 21 Nov 2026

Tested at commit `c13042b` (branch `main`). Stokenet instance at `http://127.0.0.1:8788` / `https://127.0.0.1:8789`;
mainnet `https://dex.difd.net` looked at read-only (page loads, market switching, a handful of GETs on six markets, no orders).
No source files were changed.

## Baseline

| Check | Result |
|---|---|
| `npm test` | 34 / 34 pass |
| `npx tsc --noEmit -p .` | clean (exit 0) |
| `scripts/stokenet-server-e2e.ts` | ALL CHECKS PASSED |
| `scripts/stokenet-pool-e2e.ts` | **SOME CHECKS FAILED** (4 FAIL, see B4) |
| `scripts/stokenet-book-e2e.ts` | ALL CHECKS PASSED |
| `scripts/stokenet-set-price.ts 0.095` afterwards | done: pool price 0.093275 → 0.095003 |

## Summary

| # | Severity | Where | Bug |
|---|---|---|---|
| B1 | High | `apps/web/src/App.tsx:76,83` | After switching market, a late reply for the old market replaces the new market's order book (and trades) |
| B2 | High | `apps/server/src/app.ts:118` (`readBookSoon`) | When the Gateway is slow or down, every `/api/config`, `/api/depth`, `/api/trades`, `/api/orders`, `/api/history` call hangs 62 s |
| B3 | Medium | `packages/core/src/gateway.ts:196-214` | Trades tab lists phantom trades at nonsense prices (any non-account component counted as a swap) |
| B4 | Medium | solver `fillGasXrd` vs `scripts/stokenet-pool-e2e.ts`, DESIGN.md | Pool e2e fails: an order signed with the documented "about 1 XRD" fee allowance does not fill at its price; it then sits in the book crossed with the pool |
| B5 | Medium | `apps/web/src/OrderForm.tsx:99-104`, `format.ts toPlain` | 100% button can fill in more than the account holds |
| B6 | Medium | `apps/server/src/app.ts:39,45` (`marketTrades`) | Trades made here show the price after fees and the order's placement time, not the trade price and time |
| B7 | Medium | `apps/server/src/marketdata.ts:147-184` | Over a third to a half of mainnet candles have open outside high–low |
| B8 | Low | `apps/web/src/OrderForm.tsx:64,97` | Market order estimate shows a full fill at a price when the book cannot fill it |
| B9 | Low | `apps/web/src/App.tsx:100,111` | Header briefly shows the previous market's price and change after switching |
| B10 | Low | `apps/server/src/marketdata.ts:146,204`; `app.ts:146` | Bad `resolution` gives 500; `__proto__`/`toString` give 200 with `time: null` |
| B11 | Low | `apps/server/src/http.ts:55,98`; `app.ts:255` | Malformed percent-encoding or a `null` JSON body gives 500 |
| B12 | Low | `apps/server/src/app.ts:163-208`; `core/manifest.ts:27` | A well-formed account address with a bad checksum gives 500 on `/api/balances` and `/api/history` |
| B13 | Low | `apps/server/src/app.ts:154-157` | `/api/quote` accepts `0x10` / `0b1010` as amounts; amounts below 1e-18 give 404 instead of 400 |
| B14 | Low | `apps/web/src/OrderForm.tsx:181` | Inputs silently change typed or pasted numbers (`1e-5` becomes `15`, `-5e3` becomes `53`) |
| B15 | Low | `apps/web/src/OrderForm.tsx:47` | Picking a price fills a rounded price; picking the same row again does nothing |
| B16 | Low | `apps/web/src/format.ts:88-98` | Sizes below 0.000001 shown as `9.000e-7`; very large as `123450000000.00B`; 999,999 as `1000.0K` |
| B17 | Low | `apps/web/src/Chart.tsx:123` | Price-axis labels clipped for large prices (hWBTC, xwBTC) |
| B18 | Low | `apps/server/src/app.ts:234-236` | Off mainnet, every refused order POST writes a file to `data/rejected/` (unbounded) |
| B19 | Low | `apps/web/src/OrderForm.tsx:140,162`; `format.ts:124` | Some invalid orders do nothing when "Buy/Sell" is pressed: no message |
| B20 | Low | `apps/web/src/App.tsx:212-218` | One failed first load (for example a 429) leaves a dead error page; no retry |

Suspicions (not reproduced) are listed at the end.

---

## High

### B1. Old market's order book shown under the new market after switching

- **Where:** `apps/web/src/App.tsx:76` (depth) and `:83` (trades), inside `usePolling`.
- **Steps (mainnet, read-only):** open `https://dex.difd.net`, then in the console delay only the DFP2/XRD depth reply
  (`window.fetch` wrapper that holds `/api/depth?market=resource_rdx1t5yw…%2F…` for 8 s), click **DFP2/XRD**, then
  within 300 ms click **REDDICKS/XRD**.
- **Expected:** REDDICKS/XRD shows its own book (mid ≈ 1.0042).
- **Actual:** at 4 s it shows REDDICKS (mid 1.0042, best bid 0.99211, best ask 1.0163); at 10 s, when the held reply
  lands, the header still says REDDICKS/XRD but the book, mid and header price are DFP2/XRD's (mid 1.2267, bid 1.2206,
  ask 1.2329). It stays wrong until the next 20 s poll. Clicking a row then puts the wrong market's price into the
  limit form.
- **Cause:** the guard `id === market.id` compares two values from the same closure, so it is always true; the effect's
  `live` flag is not checked after the `await`. Uncached mainnet depth takes 1–2 s, so this happens on ordinary
  quick switching, not only with an artificial delay. The same pattern applies to account switching in `refreshAccount`.
- **Fix:** have `usePolling` pass a cancelled flag (or an `AbortSignal`) to `load` and drop results when the effect has
  been cleaned up; or keep the current market id in a ref and compare against the ref.

### B2. Site hangs for about a minute per request when the Gateway is slow or down

- **Where:** `apps/server/src/app.ts:118-120,139,171,188,213` (`await readBookSoon()`), `apps/server/src/book.ts:344-369`,
  `packages/core/src/gateway.ts post()` (20 s timeout × 3 attempts plus back-off).
- **Steps:** throwaway script (`slowgw.mts` in the scratch dir) runs `createApp` with `DEX_ORDER_BOOK` set and
  `DEX_GATEWAY_URL` pointing at a local server that accepts connections and never answers; then `GET /api/config` twice.
- **Expected:** `/api/config` answers at once (it needs nothing from the ledger except the cached book fee).
- **Actual:** `/api/config -> 200 after 62.1s`, and again `62.1s` for the second call: a failed read does not update
  `refreshedAt`, so every request starts a new 62 s attempt. The page cannot load at all (it waits for `/api/config`),
  and `/api/depth`, `/api/trades`, `/api/orders`, `/api/history` all wait the same way. Mainnet has an order book
  configured, so it is exposed.
- **Fix:** never await the book in request handlers; serve the last copy and refresh in the background (stale-while-revalidate),
  with a back-off after a failed read. Consider a shorter Gateway timeout for read paths.

## Medium

### B3. Phantom trades at nonsense prices in the Trades tab

- **Where:** `packages/core/src/gateway.ts:196-214` (`swapsInTransaction`), used by `MarketData.venueTrades`.
- **Steps:** `GET https://dex.difd.net/api/trades?market=<REDDICKS/XRD>`; or open REDDICKS/XRD → **Trades**.
- **Expected:** one row for transaction `txid_rdx1snftnts6h97dz9ttfq6jz443rwmssmtav67vhy8e5m6rjjru75qqhcz8kz`
  (a buy of 1,558.43 REDDICKS at ≈ 1.012).
- **Actual:** two rows for that transaction: the real one and a "sell 1,558.43 at **2.0298**", about twice the market.
  The ledger shows the extra row is an arbitrage component (`component_rdx1cp7zmhw6…`) that received 1,558 REDDICKS and
  paid 3,163 XRD as part of a three-token route; the code treats every non-account entity whose holdings of the two
  tokens moved in opposite directions as a trade.
- **Fix:** count only entities that are the market's pools (`market.pools.map(p => p.address)`, plus our order-book
  component); ignore any other component.

### B4. Pool e2e fails: orders signed with a "1 XRD" fee allowance no longer fill at their price

- **Where:** `apps/server/src/solver.ts:31-36` (`fillGasXrd`: measured pool swap fee + 0.5 XRD), `packages/core/src/solver.ts:82-91`
  (`planPoolFill`), `scripts/stokenet-pool-e2e.ts:116-133`; DESIGN.md "the network fee, about 1 XRD"; `/api/config` `gasXrd: "1"`.
- **Steps:** `npx tsx scripts/stokenet-pool-e2e.ts`.
- **Output:**
  ```
  FAIL  a limit order priced just under the market fills (open), fee paid by solver: ? XRD
  FAIL  it paid 0.000000 TUSD: below its price of 5.617620 by the fees, above its signed minimum
  FAIL  market order and resting order filled in the same transaction (filled, open), fee paid by solver: 1.3411305938 XRD
  FAIL  Bob paid exactly 15.14341567177 TUSD and Alice exactly 150 XRD
  FAIL  Alice received her price less 0.10%: 5.612003 TUSD
  ```
- **Why:** a 60 XRD order now costs `0.5876 + 0.5 = 1.0876 XRD` by the solver's estimate (`/api/quote … amount=60` gives
  `networkFeeXrd 0.587649`). The test signs a minimum of trigger − 1 XRD − 0.1%. The solver needs
  `out ≥ 1.0005 × min + gas`, which works out at ≈ 1.0005 × the market quote, so an order 0.05% inside the market never
  fills. The last three failures follow from the first: the stuck order is the cheapest ask, so Bob's market order takes
  it instead of Alice's. The change came in commit `27d0e15` ("Network fee charge follows each route's measured swap
  cost"); the test and DESIGN.md were not updated.
- **Product impact:** any order whose signed allowance is below the solver's current gas estimate (anything not built by the
  current web form, older orders, `gasXrd: "1"` from `/api/config` used as a fallback) is shown in the book at its price
  but does not fill there; the book then looks crossed (an ask below the pool's bid).
- **Fix:** either fill when `out − gas ≥ min` without the extra buffer on orders whose trigger is reached (the trigger is the
  promise), or publish the real per-route estimate everywhere instead of `gasXrd: "1"`/"about 1 XRD" and update the test to
  take its allowance from `/api/quote`'s `gasInBuyToken`.

### B5. 100% button can ask for more than the balance

- **Where:** `apps/web/src/OrderForm.tsx:99-104` (`setPct`) with `format.ts:124-130` (`toPlain`) and `:41`
  (`sellBalance = Number(balance)`).
- **Steps:** `npx tsx` on the format helpers: balance `"0.999999999999999999"` → `toPlain(Number(bal), 8)` = `"1"`;
  balance `123456789.123456789` → `"123456789.12345681"` (more than held).
- **Expected:** at most the balance.
- **Actual:** the float conversion rounds up, the 8-place floor does not undo it, and the "Not enough" check compares the
  same rounded float, so it passes. The wallet transaction or the solver's `funded` check then fails.
- **Fix:** do the percentage in decimal on the balance string (Decimal or BigInt), rounding down to the token's divisibility.

### B6. Trades made here show the after-fee price and the order's placement time

- **Where:** `apps/server/src/app.ts:39,45` (`marketTrades`: `price = received / sold`, `time = o.createdAt`).
- **Steps:** `GET http://127.0.0.1:8788/api/trades?market=<XRD/TUSD>`; row for
  `txid_tdx_2_1ya4g6twm7yww0pdzd9d00w98fym9qhzvyzek3yyqaxxwx2pu38hqtdzx2m`.
- **Expected:** price 0.092523 (the pool paid 9.252318 TUSD for 100 XRD, per the ledger).
- **Actual:** 0.091505: the user's net 9.150543 after the 0.10% fee and the ~1 XRD network fee (≈ 1.1% lower). The pool's own
  row for that transaction, which had the right price, is dropped in favour of ours. The time is `createdAt`, so a limit
  order that rests for days and then fills appears days back in the list (and may fall off the 60-row cut) instead of at the top.
- **Fix:** store the fill time and the gross amount (or read both from the ledger) and use them; keep the user's net for
  their own history only.

### B7. Mainnet candles with open outside the high–low range

- **Where:** `apps/server/src/marketdata.ts:152-184` (feed candles passed through; the filter only checks values are positive).
- **Steps:** `GET https://dex.difd.net/api/candles?market=<XRD/hUSDC>&resolution=1h` and the same for DFP2/XRD.
- **Actual:** 161 of 300 (XRD/hUSDC) and 110 of 300 (DFP2/XRD) candles have `open` outside `[low, high]`, e.g.
  `{open: 0.00025835, high: 0.00026075, low: 0.00026075, close: 0.00026075}`. Also seen on REDDICKS/XRD, xwBTC/XRD, hWBTC/XRD.
  The feed sets open to the previous close but high/low from the bar's own trades, so the chart draws bodies poking out of their wicks.
- **Fix:** normalise each candle: `high = max(o,h,c)`, `low = min(o,h,c)`.

## Low

### B8. Market estimate claims a full fill the book cannot give
`OrderForm.tsx:64,97`; `book.ts estimate`. Stokenet, Market, Buy, Spend `100000000` TUSD: the quote fails (404) and the
summary shows "You receive (estimate) 4,258.8 XRD, Average price 0.11436" as if all 100 M were spent; `filledAll: false`
is ignored and the quote error is hidden behind the "Connect your Radix Wallet" button. **Fix:** when `!filledAll`,
say how much the book can take, and show `quoteError` in the summary.

### B9. Header shows the previous market's price after switching
`App.tsx:100,111`. On mainnet, XRD/hUSDC → click xwBTC/XRD: for ~150 ms (longer when candles are not cached) the header reads
"xwBTC/XRD, Price 0.00087115, Change +237.19%" (XRD/hUSDC's figures), because depth is reset but the old candles are kept and used
as the fallback. The old chart also stays on screen under "Loading chart…". **Fix:** clear `candles` on market change, or
ignore candles whose market id does not match.

### B10. Candle resolution handling
`curl 'http://127.0.0.1:8788/api/candles?market=<id>&resolution=7x'` → **500** "Internal error" (plain `Error`, not
`HttpError`; same on mainnet path at `marketdata.ts:147`). `resolution=__proto__` or `toString` → **200** with
`"time": null` (lookup on a plain object). **Fix:** `Object.hasOwn(RESOLUTIONS, r)` and throw `HttpError(400)`.

### B11. 500s on malformed requests
`GET /%E0%A4%A` → 500 (`decodeURIComponent` in `serveStatic`); `POST /api/orders/%ZZ/cancel` → 500 (route params);
`POST /api/orders/abc/cancel` with body `null` → 500 (destructuring `null`). **Fix:** catch `URIError` → 400/404; check the
parsed body is an object.

### B12. Bad-checksum account address gives 500
`GET /api/balances?account=account_tdx_2_12yfm3nu49v4zdytzzz…` (passes `ADDRESS_RE`) → 500; same for `/api/history`.
The Gateway's 400 becomes an internal error. **Fix:** map `GatewayError` 4xx to 400, or validate the Bech32m checksum.

### B13. `/api/quote` amount parsing
`amount=0x10` is accepted as 16 and `amount=0b1010` as 10 (decimal.js parses prefixes). `amount=1e-19` passes the `> 0`
check, rounds to 0 and returns 404 "No route with enough liquidity" rather than 400. **Fix:** use the same
`/^\d{1,30}(\.\d{1,18})?$/` rule as order validation.

### B14. Number inputs silently change what is typed or pasted
`OrderForm.tsx:181` strips every character except digits and dots: typing `-5e3abc` leaves `53`; pasting `1e-5` gives `15`;
`1.2.3` is kept and treated as no amount. **Fix:** refuse the change (keep the previous value) when the input is not a
plain decimal, instead of deleting characters.

### B15. Picking a price from the book
`OrderForm.tsx:47`. The limit price is set to `fmtPrice(level)`: about five significant figures, and one decimal at
≥ 1,000 (a level at 1234.56 becomes 1234.6, and a level at 0.0955739 becomes 0.095574, so not the level's price). Clicking a row, editing
the price, then clicking the same row again does nothing (Stokenet: field stays `0.5`), because the effect only runs when the number changes.
**Fix:** pass the raw price string, and an object or counter so a repeat click re-fires.

### B16. Number formatting
`fmtAmount(9e-7)` → `9.000e-7`; `fmtAmount(1.2345e20)` → `123450000000.00B`; `fmtAmount(999999)` → `1000.0K`;
`fmtPrice(1e-20)` → `0`. Seen live: Stokenet limit form "You receive, as it fills: 123456789012345683968.00B XRD". BTC-type tokens
trade sizes near 1e-6 on mainnet, so the exponent form will appear. **Fix:** fixed-point formatting for small values; T suffix or
grouping for large ones; roll over K→M at the rounded value.

### B17. Chart axis labels clipped for large prices
`Chart.tsx:123`: hWBTC/XRD on mainnet shows `119124744.0` and `108400088.3…` cut off at the right edge (72 px axis, no grouping).
**Fix:** measure the widest label and size the axis, or use compact notation.

### B18. Refused orders written to disk without limit (Stokenet)
`app.ts:234-236`: every refused `POST /api/orders` (even `null` or `{}`) writes a file of up to 60 KB under `data/rejected/`
(three new files from this test's malformed posts). At the 240/min limit that is up to ~14 MB a minute per address. **Fix:** cap the
count or total size, or keep the last N in memory.

### B19. Silent no-ops on submit
`OrderForm.tsx:140` (`if (!minBuy) return;`) and `:162` (`if (!perSell) return;`): `toPlain` floors to 12 places, so a book buy at a
price above 1e12, or a market order whose slippage floor rounds to 0, returns without any message (the button just stops "Working…").
Also `toPlain(1.2e21)` returns `"1.2e+21"`, which `cleanAmount` rejects, so a very large limit buy shows "Moves into the order book: —".
**Fix:** set an error message on each early return; compute in decimal.

### B20. First-load errors are final
`App.tsx:212-218`: if `/api/config` or `/api/markets` fails once (for example a 429 after a burst, which I saw), the page shows
"Could not load market data: Too many requests" with a manual button and never retries. **Fix:** retry with back-off; send
`Retry-After` with 429s (`http.ts:93`).

---

## Suspicions (not reproduced)

- **Funder list never refreshed** (`packages/core/src/quote.ts:70-80`): the top holders used to fund preview quotes are cached for
  the life of the server, with their balances at that time. During the e2e runs the Stokenet book briefly had **no asks**
  (`/api/depth` returned 6 bids, 0 asks) and recovered later; stale funder balances would explain it, but I could not reproduce it on demand.
- **Account history limited to 40 transactions** (`gateway.ts:85`, no paging): a busy account's older trades vanish from "Trades".
- **Rate-limit map wiped for everyone** when more than 10,000 addresses are seen in a minute (`http.ts:48`); with
  `DEX_CLIENT_IP_HEADER` set and the origin reachable directly, a forged header could do this.
- **Wrong method gives 404, not 405** (`PUT /api/markets`); cosmetic.
- **Quote side for DefiPlaza pairs is chosen by address order** (`core/markets.ts:413`): mainnet lists `HIT/DFP2` but `DFP2/AND`,
  `DFP2/cassie`, `DFP2/RANTS`. Not wrong, but inconsistent for users.
- On mainnet XRD/hUSDC the chart (Ociswap's XRD/USD series) ends at 0.00087115 while the book mid is 0.00091862, a 5% gap
  between the header price and the chart. By design (`marketdata.ts:165-167`) but confusing.

## Checked and fine

Rate limit (240 × 200 then 429, shared by http and https, forged `cf-connecting-ip` ignored when not configured); 413 for a
200 KB body; 431 for a 20 KB URL; path traversal refused; missing/unknown parameters give 400/404; negative, zero, NaN,
Infinity amounts refused. Depth agrees with `/api/quote` to 0.000% on Stokenet and on mainnet XRD/hUSDC, DFP2/XRD,
REDDICKS/XRD, ASTRL/DFP2 (multi-pool and non-XRD quote) and xwBTC/hWBTC (8 decimals); no crossed books, mid inside the
spread, no NaN/null/negative levels; candles sorted with no duplicates; trades sorted newest first. No console errors on
either site; no horizontal overflow at 375 px or 768 px.

Other observation: the README says `Pool` and `OrderBook` must not go to mainnet without a review, but mainnet
`/api/config` names an order-book component (`component_rdx1cpzpmplyzyeglh4szf3yt4t5fp028qmwxf65mqz9zzduhy243r58cd`).
