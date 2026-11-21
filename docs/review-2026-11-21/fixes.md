# Fixes for the 21 November 2026 reviews (server, core, scripts, docs)

Branch `overnight-fixes`, from `main` at `c13042b`. Not pushed, not deployed. Front end (`apps/web`)
and the Scrypto contracts were out of scope and are untouched.

Reports: `security-audit.md` (H, M, L, I), `quality-review.md` (Q1 to Q27, tests T1 to T13, docs),
`bug-report.md` (B1 to B20). The reports themselves are in the live checkout, not on this branch.

## Commits

| Commit | What |
|---|---|
| `2cdc78a` | Core: preview whole V2 transactions (exact intent and signed children), transaction status/fee calls, Gateway timeouts, registry check, pool holders |
| `a2e58d5` | Core: honour a signed network allowance down to 75% of the estimate |
| `8456381` | Store: sent transactions, fill time and gross, order-key index, files mode 600 (migration) |
| `9dd90ca` | Solver: preview before sending, loss limit, blame, pending outcomes, listed markets, bounded passes; Solver unit tests |
| `7b730ae` | API: never wait on the ledger, refuse unfillable orders, `/api/health`, headers, 400s |
| `2b77338` | Stokenet e2e scripts updated for the new rules |
| `a3b4f7b` | Scripts type-check, withdrawal arithmetic, `scripts/backup-db.ts`, store tests |
| `56f9aa2` | README, MAINNET, deploy units as they really are |
| `0b2df8b`, `f73c835` | DESIGN and PLAN match the code |
| `3b1da0a` | Tokens of orders arriving mid-pass; quote funders re-read hourly; cross-loop fix |
| `a3d2cfe` | The solver's own fee-lock failure is never charged to an order |

Every commit type-checks (`npx tsc --noEmit -p .`) and passes `npm test` on its own (checked by
extracting each one). At the tip: 62 unit tests pass, `npm run typecheck` (now including `scripts/`)
is clean, and the three Stokenet e2e scripts pass (see the end).

## Status of every finding

### Security audit

| Id | Status | Notes |
|---|---|---|
| H1 | **Fixed** (`2cdc78a`, `9dd90ca`, `7b730ae`) | Every transaction is previewed with `/transaction/preview-v2` as the exact transaction (root intent plus the signed orders as children, signers by public key, no free credit, no assumed signatures) and only sent if that succeeds. Verified on Stokenet with real signed orders. A key already used by any stored order is refused (409); a key cancelled in the registry is refused at submission (400) and closes the order before a fill. Failures count per order and per account (6 a day bars the account). Loss limit (circuit breaker) on failed-transaction fees. |
| H2 | **Fixed** (`9dd90ca`) | Book orders and signed orders are only considered when their two tokens form a listed market; frozen or recalled vaults now fail in preview (free); book purchases and crosses back off 1, 4, 16 min and then wait until the order changes. Reading token roles (recall/freeze locked) was not added: with previews it would only save Gateway calls. |
| H3 | **Needs owner decision** | Not changed, as instructed. Options and recommendation below. |
| M1 | **Fixed** (`9dd90ca`) | See "Blame" below. |
| M2 | **Partly fixed** (`9dd90ca`, `7b730ae`) | Resting orders and book orders capped per pass (20 each) and taken in turns; resting orders far from the market re-quoted at most once a minute; book crossing compares price-sorted groups (no O(n²)); book orders under 5 XRD ignored by the solver; `/api/quote` counts as 4 requests and refuses non-plain amounts. Not done: rounding quote amounts for the cache, one quote per market per pass, own Gateway, and `BookWatcher` still re-reads every open book order on each refresh. |
| M3 | Not fixed | Front end (hard cancel in the UI, recoverable secrets): out of scope tonight. |
| M4 | **Partly fixed** (`8456381`, `9dd90ca`, `56f9aa2`) | The database and its WAL/SHM are now created and kept mode 600; server runs with umask 077. Moving to a separate user is an owner decision: `deploy/radix-dex.service` is marked as the template for it, with what the move involves, in `docs/MAINNET.md`. |
| L1 | **Fixed** (`9dd90ca`) | A pool quote that would hand back part of the input is not used as a route (the cleaner of the two fixes; the remainder goes elsewhere or the order waits). |
| L2 | **Fixed** (`9dd90ca`) | 30 s expiry margin for book arbitrage and crossing. |
| L3 | **Fixed** (`8456381`, `9dd90ca`) | Outcome left pending and settled from the ledger; see Q1. |
| L4 | **Fixed except the full CSP and HSTS** (`7b730ae`) | Rate-limit table evicts ended windows instead of clearing; IPv6 keyed by /64; `Retry-After` on 429; `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy`, `nosniff` on every response; malformed percent-escapes give 400. A script/style CSP was not added (it must be tested with the Radix connect button); HSTS is left to Cloudflare. Recommendation: test `default-src 'self'` plus the wallet connector's origins on Stokenet, then add it. |
| L5 | Not fixed | Front end. |
| L6 | Not fixed | Front end. |
| L7 | Not fixed | Contract is immutable; mitigation is in the UI (out of scope). |
| I1 | No change | Informational; UI warning recommended. |
| I2 | No change | Informational. |
| I3 | No change (owner's call) | Note: the B4 change lets an order whose allowance covers 75% of the network fee fill, with the service fee then taken only from what is left; the solver bears at most 25% of the network fee on such a fill. |
| I4 | No change | Dependency updates not taken tonight. |
| I5 | **Fixed** (`0b2df8b`) | DESIGN now describes the preview, which is now true. |

### Quality review

| Id | Status | Notes |
|---|---|---|
| Q1 unknown outcomes | **Fixed** (`8456381`, `9dd90ca`) | (a) intent hash stored before sending, (b) timeout, status error and submit error leave the fill pending, (c) settled at the start of each pass from `/transaction/status` (an intent unknown after its expiry is settled as never committed), (d) `markFilledFromLedger` records a commit even if the order was marked expired or cancelled, (e) bookkeeping is outside the failure path, orders in flight are not expired or re-sent. (f), the form's wording, is front end: order views now carry `pending: true`, which the form should show as "still working". |
| Q2 blame | **Fixed** (`9dd90ca`) | See "Blame" below. |
| Q3 divisibility | **Fixed server side** (`7b730ae`) | `POST /api/orders` refuses a sell amount with more places than the token allows. Not done: `divisibility` in `/api/markets` and rounding in the form (front end). |
| Q4 tick scaling | **Partly fixed** (`9dd90ca`) | (a) market orders first and again between resting orders (`kick()`), (b) far-from-market orders skipped for a minute, caps per pass. Not done: (c) shared quote cache between solver and API, (d) Gateway concurrency limiter with solver priority; (e) only slow passes (>15 s) are logged. |
| Q5 XRD float, retries | **Fixed** (`9dd90ca`) | XRD spent on book purchases never touches the 10 XRD fee lock plus 1 XRD margin; book retries back off and give up until the order changes. |
| Q6 float maths in browser | Not fixed | Front end. |
| Q7 stale polling | Not fixed | Front end (B1). |
| Q8 operations | **Partly fixed** (`9dd90ca`, `a3b4f7b`, `56f9aa2`) | SIGTERM/SIGINT handler (stop timers, close listeners, finish the pass, close the database, 90 s limit); files mode 600; `scripts/backup-db.ts` and a nightly user timer; the real user unit documented. The premise "not under systemd" was wrong (it runs as user service `radix-dex-mainnet`). Not done: `tsx` is still a devDependency (fine with `npm ci`, noted in the template unit). |
| Q9 health, logging | **Fixed** (`9dd90ca`, `7b730ae`) | `/api/health` (200 or 503 with problems); accepted orders, cancels, fills, settlements, loss-limit changes logged; Gateway failures logged once per 5 minutes with a count; a failed `xrdValueIn` probe is not cached. Pointing an uptime monitor at it is for the owner. |
| Q10 quote error vs no route | **Fixed** (`2cdc78a`, `9dd90ca`) | The Quoter counts errors; a taker whose quote errored is skipped for the pass instead of handing the remainder to a maker. |
| Q11 real amounts and time | **Partly fixed** (`8456381`) | `filled_at` and `gross` stored and used. Received amounts are still the solver's prediction, not read from the committed transaction's balance changes. |
| Q12 balance dip | **Fixed** (`9dd90ca`) | An unfunded order is held 10 minutes, not charged; it lives to its expiry. |
| Q13 constants in one place | Not done | Fallback `gasXrd` raised to 1.5 and `/api/quote` gives a per-route allowance; the constants still live in `solver.ts`. |
| Q14 strict config | **Fixed** (`9dd90ca`) | Numbers are parsed strictly with ranges; a bad value stops start-up. |
| Q15 funder refresh | **Fixed** (`3b1da0a`) | Re-read hourly. |
| Q16 book history | **Partly fixed** (`7b730ae`) | `fills` capped at 5,000; `eventsFrom` still resets on restart. |
| Q17 split the solver | **Partly** (`9dd90ca`) | `tick()` is now `pass()` with `fillTaker`/`fillOnce`/`afterSend`/`crossBook`/`arbitrage`; `errText` added. |
| Q18 scripts type-check | **Fixed** (`a3b4f7b`) | `scripts/tsconfig.json`, part of `npm run typecheck`; `mainnet-withdraw.ts` uses core's Decimal via `planWithdrawal` (tested; script not run). |
| Q19 CI | Not done | |
| Q20 Scrypto artefact traceability | Not done | Owner/ops; noted in MAINNET.md. |
| Q21 hard cancel in UI | Not fixed | Front end. |
| Q22 dead code | **Partly** (`a3b4f7b`, `7b730ae`) | `stokenet-e2e.ts` clearly marked first-version (it still creates the test keys, so not deleted); `DELETE` dropped from the allowed methods. The other leftovers remain. |
| Q23 duplication | Not done | |
| Q24 accessibility | Not fixed | Front end. |
| Q25 small server issues | **Fixed server parts** (`7b730ae`) | Malformed percent-escape and unknown candle resolution now 400. `/api/markets` loaded once and the eslint comments are front end. |
| Q26 tooling | **Partly** | `typecheck` covers scripts. Not added: `--noUnused*`, Node engine pin. |
| Q27 contract comments | Not done | |
| T1 outcome reconciled | **Done** | `apps/server/test/solver.test.ts` |
| T2 taker failure not charged to makers | **Done** | both directions of the blame rule |
| T3 book purchases keep the fee lock; retries stop | **Done** | |
| T4 choosing the execution | **Partly** | combined vs pool-only covered in the blame tests; no dedicated cases |
| T5 order-form maths | Not done | front end |
| T6 divisibility at intake | **Done** | `api.test.ts` |
| T7 stale polling | Not done | front end |
| T8 Gateway client | Not done | |
| T9 reading the order book | Not done | |
| T10 HTTP edge cases | **Partly** | 400s, headers, /64 keys; 413 already tested |
| T11 store migration | **Done** | `store.test.ts` |
| T12 venue listing | Not done | |
| T13 withdrawal arithmetic | **Done** | `withdrawal.test.ts` |
| Docs (README, DESIGN, MAINNET, PLAN) | **Fixed** (`56f9aa2`, `0b2df8b`, `f73c835`) | Every statement listed in the review, plus the new behaviour |

### Bug report

| Id | Status | Notes |
|---|---|---|
| B1 | Not fixed | Front end (other agent). |
| B2 | **Fixed** (`7b730ae`, `9dd90ca`) | Handlers never await the book: they serve the copy held and refresh in the background (no retry within 30 s of a failed read); `/api/config` makes no Gateway call; visitors' requests use a Gateway client with 8 s × 2 attempts; the server reads the book once at start-up. Checked with a Gateway that never answers: `/api/config` 200 in 26 ms then 8 ms, `/api/orders` 3 ms. |
| B3 | **Fixed** (`2cdc78a`, `9dd90ca`) | Only the pool's own holdings count: the component itself or the native `pool_` entities named in its state (read when pools are allow-listed). Checked on mainnet: an Ociswap basic pool names one `pool_` entity (field `liquidity_pool`), a DefiPlaza pair two (`base_pool`, `quote_pool`), a precision pool none (it holds its funds itself). |
| B4 | **Fixed** (`a2e58d5`, `7b730ae`, `2b77338`, `0b2df8b`) | `/api/quote` adds `gasAllowanceInBuyToken` (the route's estimate × 1.25), `/api/config` `gasXrd` fallback is now 1.5, and the solver fills an order at its trigger when the allowance covers at least 75% of its current estimate. `stokenet-pool-e2e.ts` passes. **Front end must change**: compute the signed minimum from `gasAllowanceInBuyToken` instead of `gasInBuyToken` (keep `gasInBuyToken` for display); fall back to `limitOrders.gasXrd × gasAllowanceMargin`. |
| B5 | Not fixed | Front end. |
| B6 | **Fixed** (`8456381`, `7b730ae`) | Fills record `filled_at` and `gross` (what the trade produced before fees); the trades list uses them, falling back to the old fields for older fills. Order views gain `gross`, `filledAt`, `pending` (added, nothing renamed). Gross for the taker is the solver's prediction of the pool leg (see Q11). |
| B7 | **Fixed** (`9dd90ca`) | Each candle is normalised (high = max(o,h,c), low = min(o,l,c)). On the method: for XRD-quoted pairs the feed's own candles are used and only needed this fix. For other pairs the candle is the ratio of the two XRD-priced series at the same bar time: open and close are a fair approximation of the cross rate, but true highs and lows cannot be recovered (the code already sets them from open and close), a thinly traded quote token is carried forward from its last bar (stale), and volume is the base token's XRD-side volume. Sound enough for a chart, not for anything priced from it. |
| B8, B9 | Not fixed | Front end. |
| B10 | **Fixed** (`7b730ae`) | Unknown resolutions, `__proto__` and `toString` give 400. |
| B11 | **Fixed** (`7b730ae`) | Malformed percent-encoding and a non-object cancel body give 400. |
| B12 | **Fixed** (`7b730ae`) | A Gateway 4xx on `/api/balances` and `/api/history` gives 400. |
| B13 | **Fixed** (`7b730ae`) | Plain decimals only (same rule as order validation). |
| B14 to B17 | Not fixed | Front end. |
| B18 | **Fixed** (`7b730ae`) | At most 200 refused submissions kept on disk. |
| B19 | Not fixed | Front end. |
| B20 | **Server part fixed** (`7b730ae`) | 429s carry `Retry-After: 60`; the retry itself is front end. |
| README "OrderBook not on mainnet" | **Fixed** (`56f9aa2`) | Live since 21 Nov 2026, unaudited, owner accepted the risk. |
| Suspicion: funders never refreshed | **Fixed** (`3b1da0a`) | |
| Suspicion: rate-limit wipe | **Fixed** (`7b730ae`) | |
| Other suspicions | Not done | 40-transaction history, 405, DefiPlaza quote side, chart/mid gap. |

## How the main changes work

**Preview.** `buildTransaction` now also returns `previewHex`, a compiled `PreviewTransactionV2`.
The toolkit cannot produce one, so `previewTransactionV2Hex` (packages/core/src/tx.ts) writes it in
Manifest SBOR around the exact compiled transaction intent (with the exact signed subintents, so
their hashes match): `4d 22 0f 03`, the intent as a tuple, the root signer keys (none: the node adds
the notary, which is a signatory), and each child's Ed25519 public key. The Gateway accepted it on
Stokenet and returned real receipts (Succeeded / Failed / Rejected), with and without children, and
all three Stokenet e2e scripts now fill through it. Preview flags: no free credit, no assumed
signatures, epoch checked. Limits: a preview cannot see a transaction sent at the same moment, so
a race can still fail on ledger (the loss limit covers that); signatures are not checked by the
preview (they are checked when an order is accepted).

**Loss limit.** Fees of transactions that failed on ledger (from `/transaction/committed-details`
`fee_paid`, or 1 XRD if not reported) are summed over the last hour from the `transactions` table.
At `DEX_FAILED_FEE_LIMIT_XRD` (3) the solver logs `!!! LOSS LIMIT REACHED` and sends nothing;
`/api/health` returns 503. It resumes by itself when the hour has passed (and logs that). The
counting survives restarts.

**Blame.** A pool-only fill that fails is the taker's. A fill that used other orders and failed
(in preview or on ledger) holds those orders back for two minutes uncharged, and the taker is tried
again at once without them. If the taker then fills and exactly one resting order had been in the
failed fill, that order is charged; if the taker fails again, the taker is charged; if the taker
cannot be filled without them, nobody is charged. An order whose key is cancelled in the registry
is closed; an account short of funds is held, not charged; a preview rejected for the solver's own
fee lock, or a solver below its fee lock, charges nobody.

## H3: fees in a worthless token (owner's decision)

The network fee and the 0.10% are taken in the token the order buys, valued through that token's
best listed pool. An attacker's own token, with its own pool over the $300 listing floor, can make
that worthless, and the fills succeed, so neither previews, the loss limit nor the per-account
failure count stop it.

Options:

1. **A vetted fee-token list.** Only XRD and the listed stablecoins (hUSDC, hUSDT), perhaps a few
   deep tokens, may be used to pay fees. Orders whose bought token is not on the list are refused
   (or only filled when the fee can be taken another way, see 2). Simple; narrows what can be
   traded with signed orders.
2. **Take the fees from the sell side when the sell token is XRD** (or another vetted token). The
   signed template already yields the whole sell bucket to the solver's transaction, so the solver
   can keep the fee in XRD before routing the rest, and the engine still enforces the user's
   minimum on what they receive. No re-signing and no contract change. The order form must then
   compute the minimum from (sell amount less fee) instead of (proceeds less fee).
3. Measure pool depth on ledger (XRD side) instead of the venue's TVL figure, and raise the floor.
   Raises the attacker's cost but does not remove the problem.

**Recommendation: 2 combined with 1.** Take both fees in whichever side of the pair is vetted,
preferring the sell side; skip pairs where neither side is vetted. Every listed market with XRD or a
stablecoin on one side keeps working, the fees are always in something worth having, and users'
signed orders keep their shape. The front-end change is the allowance calculation only.

**Interim protection from tonight's changes: essentially none against H3 itself.** Orders are now
limited to listed markets, but the attack lists its own market. The losses per fill stay bounded
at the network fee (about 1 to 1.4 XRD each). A configuration-only stopgap the owner could apply
before a code change: raise `DEX_MIN_POOL_TVL_USD` (for example to 2,000), which raises the
capital the attacker must put in their pool (they can take it out again) and delists small real
markets; and watch the non-XRD tokens the solver collects (`scripts/mainnet-withdraw.ts` lists them
without sending).

## Deployment notes

**Migration.** Automatic on start, additive only: `orders` gains `pending_tx`, `filled_at`, `gross`
and an index on `order_key`; new tables `transactions` and `account_failures`. Old rows are kept;
an older server can still read the file (it ignores the new columns). Existing files are chmodded
to 600. Take a backup first.

**New settings (all optional):**

| Variable | Default |
|---|---|
| `DEX_FAILED_FEE_LIMIT_XRD` | `3` |
| `DEX_ACCOUNT_FAILURE_LIMIT` | `6` (failures per account in 24 h) |
| `DEX_MAX_RESTING_PER_TICK` | `20` |
| `DEX_MAX_BOOK_PER_TICK` | `20` |
| `DEX_MIN_BOOK_ORDER_XRD` | `5` |
| `DEX_LOW_XRD` | `30` (health reports "low" below this) |

Existing numeric settings are now validated: a malformed value stops start-up instead of becoming
NaN. `run-mainnet.sh` sets none of the new ones, so the defaults apply.

**What behaves differently for users:**
- Orders are refused (400) unless their two tokens form a listed market; with an order key already
  used (409); with a key cancelled on ledger (400); with more sell decimals than the token allows
  (400); from an account with 6 failed fills in 24 h (429). If the registry cannot be checked
  (Gateway down) submission answers 503. If the market list has not loaded, 503.
- Open signed orders in a pair that stops being listed are not filled until it is listed again.
- Orders signed with an allowance a little under the solver's estimate now fill at their price.
- `/api/quote` refuses `0x10`, `1e-5` and similar; counts as 4 requests against the rate limit;
  has the new field `gasAllowanceInBuyToken`. `/api/config` `gasXrd` is `1.5` (was `1`).
- Trades list shows our fills at their gross price and fill time.
- Market orders no longer wait behind resting orders.
- If the loss limit trips, nothing fills for up to an hour (`/api/health` says so).
- API responses carry `X-Frame-Options: DENY` and `frame-ancestors 'none'`: the site can no
  longer be shown inside a frame.

**Front end to follow (not in this branch):** use `gasAllowanceInBuyToken` for the signed minimum;
show `pending: true` orders as "still working, check Trades" rather than "not filled"; round amounts
to the token's divisibility; surface the new 400/409/429/503 messages; retry after `Retry-After`.

**To deploy** (in `/home/jon/Radix/dex`, on `main`, nothing uncommitted there that conflicts):

    git merge --ff-only overnight-fixes              # the running server is not affected until restarted
    npx tsx scripts/backup-db.ts data/orders-mainnet.sqlite data/backups   # consistent copy while it runs
    npm test && npm run typecheck
    systemctl --user restart radix-dex-mainnet
    journalctl --user -u radix-dex-mainnet -f        # look for "radix-dex server on", no errors
    curl -s http://127.0.0.1:8787/api/health         # expect 200 and "ok": true within a minute

No web rebuild is needed (apps/web is unchanged) and no new packages. Optionally: add `UMask=0077`
and `TimeoutStopSec=90` to the user unit (see `deploy/radix-dex-mainnet.service`), install the
backup timer (`deploy/radix-dex-backup.*`), and point an uptime monitor at `/api/health`.

Rollback: `git checkout c13042b` (or the previous main) and restart. The database stays readable.
One caution: the old server does not know about transactions recorded as pending; if a rollback
happens while `/api/health` shows `pendingTransactions` above 0, wait for it to reach 0 first.

## Test results

- `npm test`: 62 pass, 0 fail. `npm run typecheck` (server, core, scripts): clean.
- Stokenet, from this worktree, run one at a time with nothing else running:
  `stokenet-server-e2e.ts` ALL CHECKS PASSED; `stokenet-pool-e2e.ts` ALL CHECKS PASSED (it failed
  4 checks before, B4); `stokenet-book-e2e.ts` ALL CHECKS PASSED. One earlier book run stopped
  because the test seller account had run out of XRD (185 left, the test places 300); it was topped
  up from the Stokenet faucet and the rerun passed. Afterwards the test pool price was restored with
  `stokenet-set-price.ts 0.095` (0.088928 → 0.095009).
