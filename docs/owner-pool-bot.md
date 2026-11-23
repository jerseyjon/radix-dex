# OwnerPool market-making bot (sends on Stokenet; mainnet guarded)

`scripts/owner-pool-bot.ts` keeps a split OwnerPool's price near a reference price using only the
OPERATOR (hot) key. Its decisions are pure functions in `packages/core/src/ownerpool-bot.ts`, tested in
`packages/core/test/ownerpool-bot.test.ts`. The design it works inside is
`docs/review-2026-11-21/owner-pool-split-design.md`; the Stokenet pool is described in
`docs/review-2026-11-21/owner-pool-split-stokenet.md`.

It treats the contract's limits (budget per window, caps, floors, fee range) as a backstop it should
never reach: it plans every move with the exact TypeScript copy of the contract's checks and spends
only part of what the contract would allow.

## What it does, each tick (default every 60 s)

1. **Reads the reference price** from the on-ledger venues of the SAME pair only: each is quoted both
   ways at a realistic size, its fee-free midpoint taken, and the venues combined weighted by depth
   (see "Reference price" below). Venues whose own swap fee is over 1% are excluded. CoinGecko is read
   beside them, WATCH ONLY: it never sets a price or a trade; it only raises an alert when it is more
   than 15% from the reference. A venue counts as dropped only after failing on 2 ticks in a row,
   and as back only after quoting on 2 ticks in a row ("Two-tick venue confirmation"); on a tick where
   a confirmed venue failed once, the bot prices from the venues that quoted but does not rebalance.
   If the CONFIRMED set of live venues changed since the last tick, it starts a 15-minute hold (no
   rebalance; see "Venue-set hold"). With only ONE confirmed venue it trades cautiously: fee + 50 bps,
   half the sizes ("Single-venue caution").
2. **Reads the pool** from the ledger, vault by vault (reserves, inventory, fee, both pauses, limits,
   stored allowance, the anchor on ledger), and the contract's own `operator_status` by preview. The
   allowance is computed locally too, and the two are compared on every tick.
3. **Maps the reference onto the pool**: `target = median of the last 3 healthy references x scale`
   (no target until 3 are in; scale is always 1 on mainnet).
4. **Checks the owner's anchor.** The anchor the OWNER last stated is read from the ledger (see "The
   owner's anchor" below). If the target is more than 5% from it, the bot stops following at once; on the
   second such tick in a row it sets the operator pause, logs and alerts that the owner must restate the anchor. If the owner's anchor cannot
   be determined, the bot does not rebalance (or change the fee).
5. **Pause control.** If the reference stays unusable (no live venue, or the venues more than 4% apart)
   for 10 minutes, it sets the operator pause; it clears a pause only if it set it itself, after 15
   minutes of a healthy reference.
6. **Hold and widen.** While the live venues disagree by more than 4% it does NOT rebalance (it holds
   its position) and widens the fee by half the disagreement, inside the owner's operator fee range.
   While a venue-set hold runs, or on a tick where a confirmed venue failed once, it does not rebalance
   either; the fee may widen, not narrow.
7. **Rebalance.** If the pool price is further from the target than the dead band, it moves the curve
   toward the target by a one-sided move between inventory and reserves, as large as fits in half of
   the allowance (keeping a reserve) AND inside the rolling cap (at most 60% of the allowance in any 10
   minutes), never past a cap or floor. With a single confirmed venue: a quarter of the allowance per
   tick and 30% in any 10 minutes.
   The CoinGecko brake can block it (see "CoinGecko brake").
8. **Fee.** It sets the fee from a simple rule (base fee 100 bps, widened by volatility and when it is
   behind, + 50 bps with a single confirmed venue), clamped to the owner's operator range, with hysteresis.

Every transaction is built by code, previewed in the same tick (the exact notarised transaction, real
signature, no free credit) and sent only if the preview succeeded. Its intent hash is appended to the
sent log (`data/owner-pool-bot-sent.jsonl`, `--sent-log`) BEFORE it is submitted, so the watcher can
tell the bot's operator actions from anyone else's. One JSON line is logged per tick.

## Safety rules added after the review of 23 Nov 2026

The independent review (`docs/review-2026-11-23-bot-review.md`) found the bot not yet safe for mainnet.
Its findings are fixed as follows; the "Fixes" section of the review names the commits. Pure rules are in
`packages/core/src/ownerpool-guard.ts` (tested in `packages/core/test/ownerpool-guard.test.ts`), file
helpers in `packages/core/src/ownerpool-files.ts` (node only, not exported from the package index).

**Start-up (refused with exit 2, logged as `refused` with every problem, and alerted as `start-refused`
when an alert URL is set; systemd does not restart exit 2):**
- **Scale (C-1).** On mainnet only `--scale 1` (the default there); `auto` or any other value is refused,
  in the bot and the watcher. Stokenet keeps `auto` for the TEUR stand-in.
- **Pair (H-1).** The pool's (`resource_a`, `resource_b`) must be the reference pair in the venues'
  orientation: mainnet XRD/hUSDC, Stokenet XRD/TEUR (`OWNER_POOL_REFERENCE_PAIRS`). An inverted pool is
  named as such. Checked at start and on every tick (a mismatch on a tick stops the bot, exit 2).
- **Explicit identity (H-3).** On mainnet `--pool`, `--badge`, `--key`, `--state` and `--sent-log` must be
  given: there are no mainnet defaults. Stokenet defaults: the test pool, `data/owner-pool-bot-stokenet-state.json`.
- **State identity (H-3).** The state file carries `identity: {network, pool, badge, operatorAccount}`; a
  file without one (every file before this change) or with another is refused: start a fresh one. The
  watcher's checkpoint carries `{network, pool}` the same way.
- **Flags (L-2).** Every numeric flag is range-checked (`OWNER_POOL_FLAG_RANGES`; tighter on mainnet, e.g.
  `--max-anchor-distance` at most 0.1, `--max-tx-per-hour` at most 30, `--venue-hold` at least 300 s), and a
  flag followed by another flag (`--scale --send`) is an error, not a value. All argument problems are
  reported together.
- **Lock (L-1).** `data/locks/owner-pool-bot-<network>-<pool>.lock`, created with O_EXCL, holding the pid
  and program name; a lock whose pid is gone, or now runs another program, is stale and replaced. Released
  on every exit. Keyed on the pool, so two bots with different state files cannot run on one pool.
- **`--send` (M-6).** Needs an alert URL on every network; the start alert is the test and must be
  delivered (HTTP 2xx), or the bot refuses.
- **Mainnet `--send` guard.** All of: scale 1; explicit pool, badge, key, state, sent log; no `fixed:`/`file:`
  venues, no `--exclude-venues(-file)`, no `--owner-anchor` (L-3); CoinGecko among the watch sources (the
  brake); `OWNER_POOL_PACKAGES.mainnet` not empty; the pool in `MAINNET_SEND_POOLS`
  (`packages/core/src/ownerpool-guard.ts`, committed, EMPTY: mainnet `--send` is impossible until the owner
  adds his pool); `--mainnet-live`, a separate acknowledgement. Then, at start: the pool read from the
  ledger must be of an allow-listed package and the reference pair, and the start alert delivered.
  Checked before the key is read, so the refusals can be seen with no mainnet key at all.

**While running:**
- **Median target (H-2).** The target is the median of the last `--reference-median` (3) healthy readings
  (from the full confirmed venue set) no older than 3 x 3 intervals. With 3, a price pushed on one venue
  must be held for 2 of 3 ticks (two minutes) before the target follows it, and the first 3 ticks after a
  start have no target (no rebalance, no fee change). 3 is the smallest odd window that rejects one
  outlier; 5 would add two more minutes of lag to every real move.
- **Anchor stop (H-2).** Beyond the anchor distance the bot stops following at once, but pauses the pool
  only after `--anchor-strikes` (2) ticks in a row: one tick of a moved thin venue can no longer pause it.
- **CoinGecko brake (H-2, the owner's decision of 23 Nov 2026).** See its own section below.
- **Halt and cap (M-2).** The operator pause ON and a fee WIDEN are never blocked by the 3-failure halt or
  the hourly cap. A rebalance failing with "Reserves moved" (a swap raced it, by design harmless) does not
  count toward the halt; such races have their own limit, `--max-races` (10 in a row), logged as `race`.
- **Validity and order (M-3).** Each transaction is valid for 2 epochs and `--tx-validity` (120) seconds
  after the operated network's LEDGER time (`max_proposer_timestamp_exclusive`), so a timed-out send cannot
  commit 25 minutes later. The bot waits past that validity; a send whose status is still unknown is kept
  as `pending` in the state file and resolved first on the next tick (committed: its spend enters the
  rolling window from the ledger event, and a late pause is recorded as the bot's; failed; or expired on
  the ledger clock plus 30 s). Nothing else is sent while one is pending, so a pause or fee change can
  never land after a newer one.
- **Ledger time for quotes (M-4).** Each tick reads the mainnet Gateway's status first; every venue quote
  takes its ledger time (`proposer_round_timestamp`), and when that is more than `--max-gateway-lag` (120 s)
  behind, no venue counts (alert `gateway-lag`). The public Gateway measured 9-21 s behind on 23 Nov.
- **Heartbeat (M-5).** Both processes write `data/heartbeat/owner-pool-{bot,watch}-<network>.json` every
  tick (`--heartbeat`). `scripts/owner-pool-heartbeat-check.ts`, run every 2 minutes by
  `deploy/owner-pool-heartbeat.timer` (not installed), alerts `NO HEARTBEAT` when a file is missing,
  unreadable or older than 600 s, and `Heartbeat back` when it returns. A refusal at start (a corrupt
  state file with no usable `.bak`, an unreadable key, a stale lock held, a guard condition) is alerted.
- **Durable state (L-6).** Saved by temp file, fsync, the previous file kept as `.bak`, rename, directory
  fsync; a corrupt state file falls back to `.bak` (logged `state-recovered`), else the bot refuses.
- **Target depth (L-4).** Re-read from the reserves whenever the owner changed them (an
  `OwnerPoolLiquidityEvent` or an owner rebalance in the pool's events, seen by the anchor re-check), so
  `--side balanced` follows the owner's deposits and withdrawals instead of the depth at first start.

## CoinGecko brake

The owner's decision (23 Nov 2026): CoinGecko becomes a BRAKE, never a price source. Code
`coingeckoBrake` (`packages/core/src/ownerpool-guard.ts`), tests in `ownerpool-guard.test.ts`.

- **What is tracked.** Only the ratio `on-ledger reference / CoinGecko` (both USD per XRD), on ticks with
  a healthy reference from the full confirmed set, sampled at most once per `--brake-sample` (300 s), kept
  for 24 h in the state file (`brake.ratios`, at most 288). Its **normal** is the median of those ratios.
  On 23 Nov the ratio was about 0.972 (CoinGecko 2.8% above the one live venue): a steady premium like
  that is learned, not braked. Every healthy ratio enters the normal, braking or not, so a lasting real
  divergence is learned after about 12 h; a manipulation would have to be held that long.
- **When it brakes.** The current ratio is more than `--brake-max-deviation` (2%) from the normal. Until
  the normal has `--brake-min-readings` (12, one hour at the default sampling) the normal is 1 (parity)
  and only the 15% alarm threshold (`--brake-warmup-deviation`) brakes.
- **What it does.** No rebalance on that tick; the fee step runs with narrowing blocked (it may widen),
  as in a hold. Logged on every tick (`brake: {braking, mode, ratio, normal, deviation, threshold}`,
  decision `BRAKE: ...`); alerted once per episode (`coingecko-brake`), the key cleared when the ratio is
  back inside.
- **It never pauses the pool.** A brake that lasts (10 minutes, an hour) only keeps blocking rebalances;
  the pool keeps trading at its current curve and fee. Pausing remains the reference's (unhealthy for 10
  minutes) and the anchor's (2 ticks beyond 5%) rules.
- **CoinGecko unavailable or stale** (an error, or its own `last_updated_at` older than 15 minutes): no
  brake signal, and an episode in progress ends. Trading continues on the on-ledger median and the
  two-tick protections (the owner's preference: a CoinGecko outage must not stop the pool); logged as
  `mode: unavailable`, alerted `coingecko-unavailable` after one hour.
- **Never a price.** CoinGecko enters no reference, target, history or amount: `coingeckoBrake` returns
  only a decision, and a test reads the bot's source to check that the target, the history and
  `decideRebalance` take no watch value.
- On mainnet `--send` requires CoinGecko among the watch sources. With synthetic venues (drills) the
  ratio is meaningless and the brake is off.

## The owner's anchor (from the ledger)

What the contract stores and emits (`scrypto/owner-pool/src/lib.rs`):

- The component stores ONE anchor, `anchor: (A, B)`. The owner sets it with `set_operator` (appoint or
  replace; the anchor is required) or `set_anchor`. Both go through `state_anchor`, which emits
  `OwnerPoolAnchorEvent { anchor_a, anchor_b }` and zeroes the operator's allowance.
- A budgeted operator `rebalance` ALSO overwrites the stored anchor, with the new reserves, and emits
  only `OwnerPoolRebalanceEvent { by_owner: false, ... }`: no anchor event. So `operator_status` (and the
  `ledgerAnchor` in the bot's log) is the operator's last price after any bot move, not the owner's.
- Revoking (`set_operator(None, None)`), `owner_rebalance`, deposits and withdrawals never touch the
  anchor and emit no anchor event; instantiation stores (0, 0) and emits none.

So the owner's last statement is exactly the payload of the most recent `OwnerPoolAnchorEvent` emitted by
the pool component's Main module in a committed transaction. The bot finds it with the Gateway
transaction stream filtered on the pool's events (`event_global_emitters_filter: [pool]`, opt-in
`receipt_events`), newest first, stopping at the first page that holds one; events are trusted only
when the emitter is the pool itself (Main module), since any component can emit an event of the same
name. Code: `packages/core/src/ownerpool-events.ts` (`findOwnerAnchor`, `refreshOwnerAnchor`,
`lastOwnerAnchor`), choice in `resolveOwnerAnchor` (`ownerpool-bot.ts`).

- Cached in the state file (`ownerAnchor`: the statement, its txid and state version, and how far the
  stream has been searched); re-checked every `--anchor-recheck` seconds (default 300) by reading only
  the pool's transactions after the last one searched. A restatement is logged (`ownerAnchorChanged`)
  and alerted; the `--scale auto` calibration is redone against the new anchor.
- `--owner-anchor A:B` is now a FALLBACK only: used when the ledger cannot say (no statement found,
  the search incomplete, or the Gateway failing before any answer). If both are known and differ, the
  ledger is used and the log line carries a warning.
- Neither: the bot does not rebalance and does not change the fee (it still pauses on an unhealthy
  reference); it alerts `anchor-unknown`.
- If a re-check fails, the last ledger answer is kept (it was true at the last check).

Checked against the Stokenet history (22 Nov 2026): the search returns the re-appointment
`txid_tdx_2_1698akhqs3d3y8g5mhrkcldj9fydkavzdyade7e86dah76dhe3wvssxxvjy` (state version 34762594,
anchor 1250:1), skipping the later operator rebalances (which moved the ledger anchor to
19985.42875:15.988343, the same price) and the earlier revoke.

## How to run it

```
# dry run (default): reads, decides, previews, logs; sends nothing
npx tsx scripts/owner-pool-bot.ts --once
npx tsx scripts/owner-pool-bot.ts                 # keeps running; Ctrl-C or SIGTERM stops it after the current tick

# really send, on Stokenet (an alert URL is required; its start alert must be delivered)
npx tsx scripts/owner-pool-bot.ts --send --alert-url http://127.0.0.1:18941/bot

# a fixed reference already in pool units (tests and drills): synthetic venues
npx tsx scripts/owner-pool-bot.ts --once --scale 1 --venues fixed:0.0008,fixed:0.0008
# a reference kept in a file: {"price": 0.0008, "at": "2026-11-22T17:00:00Z"} or a bare number (the file's mtime is its time)
npx tsx scripts/owner-pool-bot.ts --scale 1 --venues file:data/ref.json,file:data/ref2.json

# read only: what the venues quote now (and CoinGecko beside them), at one or more sizes
npx tsx scripts/owner-pool-venues.ts --sizes 300,1000,3000 [--interval 120 --count 30]

# with alerts (ntfy-style POST; nothing is sent without a URL), and the read-only watcher beside it
OWNER_POOL_BOT_ALERT_URL=https://ntfy.sh/<private-topic> npx tsx scripts/owner-pool-bot.ts --send
OWNER_POOL_BOT_ALERT_URL=https://ntfy.sh/<private-topic> npx tsx scripts/owner-pool-watch.ts
```

It needs the operator key in `data/stokenet-owner-pool-operator.key` (`--key`), the operator badge
in that account (`--badge`), and the pool (`--pool`); the defaults are the Stokenet test pool's.
The key is read at start and never printed. The bot has no owner key.

`--send` on mainnet is refused unless every condition of the mainnet guard holds (above); today two of
them cannot hold (`MAINNET_SEND_POOLS` and `OWNER_POOL_PACKAGES.mainnet` are empty), so it is refused
whatever the flags say. Running it for a mainnet pool needs the owner's go-ahead AND a committed code
change listing his pool.

State lives in `data/owner-pool-bot-stokenet-state.json` on Stokenet (`--state`, required on mainnet;
`data/` is gitignored): its identity, the reference
history (6 h, for volatility), the scale calibration, the target depth, the time of the last fee
change, the send times of the last hour, the pause bookkeeping, the failure counter, the owner's
anchor statement read from the ledger, the "behind" counter, the alert rate limiter, the live
venue set with any running venue-set hold, the confirmed venue set with its two-tick streak counters
(`venueConfirm`), the current single-venue episode (`singleVenue`), the CoinGecko brake (`brake`), the
target depth and the owner reserve change it was taken after (`depth`, `ownerReserveChange`), the
anchor strikes, the race counter and any unresolved send (`pending`). The lock is per pool, in `data/locks/`.

## Reference price

Decided by the owner on 22 Nov 2026, after the first soak refused every tick (the three old sources,
Ociswap XRD/hUSDC $0.000831, CaviarNine $0.000854 and CoinGecko $0.000800, were about 7% apart):

- **The reference comes only from on-ledger pools of the SAME pair** (`--venues`). For mainnet
  XRD/hUSDC these are:

| Venue (`--venues` name) | Pool | Fee |
|---|---|---|
| `ociswap` | Ociswap BasicPool `component_rdx1cpqg9y55…pfh5fr` (constant product) | 3% (`input_fee_rate` 0.03) |
| `ociswap-precision` | Ociswap PrecisionPool `component_rdx1czy2naej…97qr` (concentrated) | 0.05% |
| `caviarnine` | CaviarNine QuantaSwap `component_rdx1cqelumvm…tyj5` (bins) | in its quotes |
| `defiplaza` | DefiPlaza PlazaPair hUSDC/XRD `component_rdx1crj9ne37…09jt0` | dynamic |

  Each component must be an instance of an allow-listed package and blueprint (`ALLOWED_PACKAGES`,
  checked on ledger before the first quote). `fixed:<price>` and `file:<path>` are synthetic venues
  (bid = ask = that price) for drills, in pool units with `--scale 1`.
- **Each venue is quoted both ways at a realistic size**, by previews of real swaps through the project's
  `Quoter` (mainnet, free, nothing signed): sell `--quote-size` XRD (default 1,000) for the BID, sell
  hUSDC worth about the same XRD for the ASK; and the same at a tenth of the size (`--small-fraction`
  0.1) for the impact. A quote that fails, or that the pool only part-fills (input handed back), drops
  the venue for that tick.
- **Midpoint, net of the venue's fee:** `mid = sqrt(bid * ask)`. A proportional fee charged on both sides
  multiplies the bid by (1 - f) and divides the ask by (1 - f), so it cancels out of the geometric mean
  (exactly, for a pure fee; to within fee x impact, 0.2 bps at 3% and 0.1% impact, for a curve).
- **Depth (the weight):** `depth = quote size / impact`, with impact the mean of the two sides' price
  change from the small size to the quote size: `(bidSmall / bid - 1 + ask / askSmall - 1) / 2`. This is
  fee-free (the fee is the same share at both sizes) and, for a constant-product pool, equals its reserve
  of XRD; for a concentrated pool it is the reserve a constant-product pool would need to show the same
  impact. The impact is floored at 10 bps (`--min-impact`): a pool whose 1,000 XRD quote barely moves
  (CaviarNine, 1.3 bps) cannot by that one quote show it is more than 1,000x the quote size deep, and
  CaviarNine in fact fails at 5,000 XRD (its hUSDC side held under 1 hUSDC on 22 Nov). Venues are
  combined by the depth-weighted GEOMETRIC mean of their midpoints.
- **A venue whose own swap fee is over 1% is excluded** (`--max-venue-fee`, default 0.01; owner's
  decision, 22 Nov 2026). Exactly 1% is kept. The fee is determined from the venue's own
  QUOTES, the same previews the midpoint comes from, not from a fee table or a venue-specific state
  field (so it covers every venue type, follows a venue that changes its fee, and needs no extra
  reads): the one-way cost at a size is `c = 1 - sqrt(bid / ask)` (fee plus impact, one way); it is
  measured at the small size and the quote size and extrapolated linearly to size zero, where impact
  vanishes: `fee = c(small) - (c(size) - c(small)) * small / (size - small)` (`venueFee`). Exact for a
  pure proportional fee; for a constant-product pool the impact is linear in size to first order, so
  it drops out (unit tests: within 0.02 bps at 800k XRD deep, 0.1 bps at 100k, for fees 0-3%). On the
  22 Nov quotes it reads Ociswap basic 3.000% (its `input_fee_rate` is 0.03), Ociswap precision
  0.052% (0.05%), CaviarNine 0.081%, DefiPlaza 10.1-10.6% (its asymmetric pricing, which is what a
  trader pays at zero size; DefiPlaza fails the round-trip rule first anyway). Each venue's estimate is
  in every tick's log line (`fee`), and an excluded venue carries
  `dropped: "fee 3.000% > 1.00% (estimated from its quotes)"`. Why: a pool with a 3% fee can sit up to
  3% from the market before arbitrage pays, and on 22 Nov Ociswap basic sat ~3% below the other two
  (which agreed to 0.12%), taking ~85% of the weight. If the rule leaves no venue live, the reference is
  "none": unhealthy, no trade (and the 10-minute pause rule applies).
- **A venue whose round trip at the quote size (`ask / bid - 1`) is wider than 10% is dropped**
  (`--max-round-trip`): its two quotes then bound the price too loosely to be a reference, and for an
  asymmetric pricer the geometric mean is not its mid. On 22 Nov this drops DefiPlaza (round trip 25%,
  mid 0.000861, 4-7% above the others); it is still quoted and logged every tick.
- **At least one live venue** (`--min-venues`, default 1). With exactly one live, the tick's log line
  carries `referenceWarning: only ONE live venue (...)`: its price is not checked against anything.
  With one CONFIRMED venue the bot trades, cautiously (see "Single-venue caution").
- **Disagreement limit 4%** (`--max-disagreement`): highest / lowest live midpoint - 1. Beyond it the bot
  HOLDS (no rebalance), widens the fee by `--disagree-fee-factor` (0.5) x the disagreement (inside the
  operator range; at 4% that is +200 bps, so in practice the top of the range), and, if the
  disagreement lasts 10 minutes, sets the operator pause (the same 10-minute unhealthy -> pause,
  15-minute healthy -> resume rule as before; it clears only a pause it set).
- **Freshness:** a quote is a preview run on the ledger state of that moment, so it is as fresh as the
  tick; one older than 300 s (a hung read) or from the future is dropped. Note what this does NOT catch:
  a pool nobody trades still gives a fresh, executable quote at an unchanging price. That is now
  deliberate (an executable quote is a price someone can trade at), but it means the reference only
  moves when the pools are traded (see the measurements below).
- **CoinGecko is WATCH ONLY** (`--watch-sources`, default `coingecko`; `--no-watch` to skip). Its USD
  price is compared with the on-ledger reference (both USD per XRD, before any `--scale`), and an alert
  `watch-coingecko-xrd-usd` fires when they are more than 15% apart (`--watch-max-deviation`). It never
  enters the reference, the fee or the pause; the comparison is skipped for synthetic venues.
- **Frozen on-ledger pools are accepted as the reference** (owner's decision, 22 Nov 2026): the bot
  follows the on-ledger pools, also when nobody trades them and their price stands still while the
  wider market moves. No code tries to detect that; the CoinGecko 15% watch alarm is the stale-pool
  signal, for a human to act on.
- **The reference can never contain the pool the bot operates, nor any OwnerPool** (hard guard, start-up).
  The owner will add OwnerPools of his own on mainnet, which the DEX router quotes; an OwnerPool's
  price is set by its owner/operator, so taking one as the reference would be following ourselves. At
  start the bot (and the watcher) read every reference venue's entity details from the Gateway and
  REFUSE TO RUN (`event: refused`, exit 2) if a venue's address is the operated pool, its blueprint is
  `OwnerPool`, its package is any package in `OWNER_POOL_PACKAGES` (any network), or the Gateway does
  not describe it. The start log line `venue-guard` lists each venue checked with its blueprint
  (BasicPool, PrecisionPool, QuantaSwap, PlazaPair on 22 Nov). Code: `referenceVenueProblems`
  (pure, tested) and `assertReferenceExcludesOwnerPools` (`scripts/owner-pool-sources.ts`).

### Two-tick venue confirmation

Owner's decision, 23 Nov 2026: one failed quote must not move the live set (each change costs a
15-minute hold). Code: `venueConfirm` and `venueGate` (pure, tested in
`packages/core/test/ownerpool-venue-confirm.test.ts`); `--confirm-ticks` (default 2; 1 = the old
behaviour).

- The bot keeps a CONFIRMED live set. "Quoting" on a tick means passing every check of
  `aggregateVenues` (quote ok, fresh, round trip, fee rule, not test-excluded).
- **A confirmed venue that does not quote** is still confirmed on its first failed tick
  (`venueConfirm.failing: [{venue, ticks: 1}]`). It is dropped only on the 2nd failed tick in a row;
  that drop is a change of the confirmed set, so the venue-set hold starts THEN (one tick later than
  before). A good tick in between resets its count.
- **On a tick where a confirmed venue failed but is not yet dropped** (`uncertain`): the reference is
  priced from the confirmed venues that did quote (as before), but the tick is a no-rebalance tick
  (`gate: "uncertain"`, decision `NO REBALANCE: venue(s) failed this tick, not dropped yet: x 1/2`).
  No hold starts. The fee step runs with narrowing blocked, as in a hold (a less certain reference
  should not narrow the spread; widening still protects). The "behind" counter is not advanced. Its
  price does NOT enter the volatility history (`volatilityEligible`, log `volatilitySample: false`). If
  no confirmed venue quoted at all, there is no reference: no trade, no fee change (as before), and
  the 10-minute pause timer runs.
- **A venue that is not confirmed and quotes** (coming back, or new) counts only after 2 good ticks
  in a row (`returning: [{venue, ticks: 1}]`); a failed tick in between resets it. Until then it is
  read and logged, with `dropped: "coming back: 1/2 good ticks in a row, not counted yet"`, but it is
  NOT in the price (otherwise one good quote would move the reference without a hold). When it is
  confirmed, the set changes and the hold starts.
- **Order of the gates** (`venueGate`): venues disagreeing (> 4%) -> hold and widen; a venue-set hold
  running -> hold (a single failure during a hold neither restarts nor ends it); a confirmed venue
  failed once -> no rebalance; no reference -> nothing; otherwise trade.
- The first tick with no state confirms whatever quotes. A state file written before this rule has
  no `venueConfirm`: it starts from the hold's last live set (`venueHold.liveSet`), so an upgrade
  neither starts a hold nor forgets a venue.
- **Persisted:** `venueConfirm: {confirmed, fails, goods}` in the state file, so a restart between the
  first and second failed (or good) tick still counts it.
- Each tick's log line has `venueConfirm: {confirmed, failing?, returning?, dropped?, added?}` and
  `gate`.

### Single-venue caution

Owner's decision, 23 Nov 2026 (from about 21:09 UTC on 22 Nov only Ociswap precision quoted XRD/hUSDC
within the rules). **When the confirmed live set has exactly one venue, the bot keeps trading, but
cautiously.** Code: `singleVenueCaution` (pure, tested); applied in `feeTargetDetail` and
`decideRebalance` / `windowSpendRoom`.

- **Fee:** the rule's target + `--single-venue-fee-add` (default 50 bps), then clamped to the operator
  range as always (on the Stokenet pool, range 10-100 at base fee 100, it is clamped away; the log
  line's `fee.rule` shows the unclamped value and `fee.singleVenueAddBps` the add).
- **Size, precisely:** `--single-venue-size-factor` (default 0.5) multiplies (a) the per-tick spend
  cap, min(allowance x 0.5, allowance - 0.1 x budget), so at most a quarter of the allowance per tick
  instead of half; and (b) the rolling-window SHARE, 60% -> 30% of the allowance at the window's
  start (room = 0.3 x (S + A) - S rather than 0.6 x (S + A) - S, which is stricter than halving the
  room once something was spent). The CAP is halved, not the move: a gap whose move costs less than
  the halved cap is still closed in one move; a gap that needs more is closed at most half as fast.
  Dead band, minimum move, reserve and the anchor rules are unchanged.
- **When:** the confirmed set has one venue (and it quoted this tick; if it failed this tick there is
  no reference and nothing trades). Two confirmed venues with one failing once is NOT single-venue: that
  tick is a no-rebalance tick. Only after the second failed tick, when the venue is dropped, does the
  caution start (together with the venue-set hold, during which the fee may already widen by the
  +50 bps). A venue coming back keeps the caution until it is confirmed (2 good ticks).
- **Zero venues:** reference unhealthy, no trade, as before. It neither starts nor ends a caution
  episode.
- **Logged** on every tick it is active: `singleVenueCaution: {active, venue, since, feeAddBps,
  sizeFactor, spendFraction: 0.25, windowShare: 0.3}`, and `spendWindow.maxShare` shows 0.3.
- **Alert** `single-venue` once when an episode starts (rate-limited like the other keys); the key is
  cleared when two or more venues are confirmed again, so the next episode alerts. Persisted
  (`singleVenue.since`), so a restart does not repeat it.

### Venue-set hold

Owner's decision, 22 Nov 2026, after CaviarNine ran out of hUSDC at 21:09, dropped out, and the
reference jumped 2% with no market move. **When the set of CONFIRMED live venues changes** (since 23 Nov
2026 a venue is dropped only after 2 failed ticks in a row and back only after 2 good ones, see above) (a venue drops out or
comes back, for any reason: a failed or part-filled quote, staleness, the round-trip rule, the fee
rule, or `--exclude-venues`), **the bot holds its position for 15 minutes** (`--venue-hold`, default
900 s): no rebalance. Another change during the hold restarts it from that change. Code:
`venueSetHold` (pure, tested).

- **Fee during the hold: widening is allowed, narrowing is not.** A wider fee only protects the pool
  while the reference may have jumped; narrowing would trust the new reference before the hold has
  passed. The fee rule (hysteresis included) runs as usual with narrowing blocked
  (`narrow to N bps held: venue-set hold ...`).
- **Persisted:** the live set last seen and the hold's end are in the state file (`venueHold`), so a
  restart neither skips a running hold nor misses a change made while the bot was down (a venue lost
  during the downtime starts a hold on the first tick). A fresh state file has no previous set: the
  first tick only records it.
- **Alert** `venue-hold` once when a hold starts; a restart of a running hold (another venue drops, or a
  venue comes back) alerts `venue-hold-restart` (since 23 Nov 2026; before that a venue coming back was
  never alerted, only the drop). The restart has its own key so the start's alert, sent minutes earlier,
  cannot suppress it; each key is rate-limited like the other keys (one per `--alert-interval`), and
  both are cleared when the hold ends, so the next hold and its first restart alert at once. Code:
  `venueHoldAlert` (pure, tested).
- Each tick's log line has `venueSet: { live, changed?: {removed, added}, holdUntil?, remainingSec?, reason? }`
  and the decision reads `HOLD: venue-set hold (dropped caviarnine) for N s more: no rebalance`.
- Pause control is unaffected (a hold is not "unhealthy"). The "behind" counter is not advanced while
  holding. A disagreement (>4%) during a hold is handled as before (hold and widen), with narrowing
  also blocked.
- `--exclude-venues a,b` and `--exclude-venues-file <path>` (names re-read every tick) are for TESTS
  and drills only: the named venues are dropped (`excluded by --exclude-venues (TEST)`), which changes
  the set and starts a hold.

Code: `aggregateVenues`, `readVenue`, `watchPriceCheck` in `packages/core/src/ownerpool-bot.ts` (pure,
tested in `packages/core/test/ownerpool-reference.test.ts`); the quoting in `scripts/owner-pool-sources.ts`.
The old median of sources (`aggregateReference`) is kept in the code for reference but no longer used.

**Why 1,000 XRD.** The bot's own moves in the first soak were 78-148 XRD on a 20,000 XRD test pool; an
arbitrageur against a mainnet OwnerPool of real size would trade several times that. 1,000 XRD is about
ten times the bot's typical move, and the largest round size at which every on-ledger venue still
quotes both ways (at 20:09 CaviarNine failed from about 1,150 XRD on the bid side; after a trade at
21:09 it could not quote even 100 XRD). At 300 XRD the midpoints are
the same to 0.01%; at 3,000 XRD CaviarNine drops out.

**Mapping onto the pool (`--scale`).** Prices are always token B per token A (the pool's
`reserveB / reserveA`; TEUR per XRD here, 0.0008 at the 1250:1 anchor). The pool aims at
`reference * scale`. TEUR is a test token with no market, so by default (`--scale auto`) the scale is
calibrated ONCE: the first healthy reference is mapped to the owner's anchor price, and the pool then
follows the reference's relative moves (XRD up 1% in dollars, the pool's TEUR-per-XRD price up 1%).
The calibration is kept in the state file and redone only when the owner's anchor changes. On mainnet,
against a real pair whose venues quote the same unit, the scale is 1 (`--scale 1`). Pass a number to
fix it.

## Rules and defaults (each with its reason)

| Setting (flag) | Default | Why |
|---|---|---|
| tick (`--interval`) | 60 s | Stokenet epochs are ~10 min and the allowance refills per epoch; a minute is fast enough to follow and cheap on Gateway calls |
| venues (`--venues`) | ociswap, ociswap-precision, caviarnine, defiplaza | every on-ledger pool of the same pair (owner's decision): prices someone can actually trade at, in the pair's own unit |
| quote size (`--quote-size`) | 1,000 XRD (small quote: 0.1 of it) | about ten times the bot's typical move; the largest round size every venue still fills both ways (see "Why 1,000 XRD") |
| impact floor (`--min-impact`) | 10 bps | one quote cannot show a pool more than 1,000x the quote size deep; stops a concentrated pool with a thin side from taking all the weight |
| max venue fee (`--max-venue-fee`) | 1% (exactly 1% kept) | the owner's decision: a pool can sit up to its own fee from the market before arbitrage pays; Ociswap basic (3%) sat 3% below the two low-fee venues. Estimated from the quotes (above) |
| venue confirmation (`--confirm-ticks`) | 2 ticks | the owner's decision: one failed quote (a blink) must not start a 15-minute hold; the failed tick is a no-rebalance tick instead |
| single-venue caution (`--single-venue-fee-add`, `--single-venue-size-factor`) | +50 bps; x0.5 | the owner's decision: one venue's price is checked against nothing, so charge more for trading against it and commit at most half as much budget per tick and per 10 minutes |
| venue-set hold (`--venue-hold`) | 900 s, restarts on another change | the owner's decision: a venue arriving or leaving moves the reference by up to the venues' spread with no market move; 15 minutes lets a blinking venue settle, and is the same order as the pause/resume timers |
| max round trip (`--max-round-trip`) | 10% | wider than that, bid and ask bound the price too loosely to be a reference (DefiPlaza: 25%); Ociswap basic's 3% fee each way (6.5%) still counts |
| live venues needed (`--min-venues`) | 1 | the owner's decision; a single live venue is logged as such on every tick |
| max quote age (`--max-age`) | 300 s | a quote is made in the tick; only a hung read is older |
| max disagreement (`--max-disagreement`) | 4% | the owner's decision. Measured on 22 Nov at 1,000 XRD: the live venues sat 3.1% apart all evening (see "Soak 4"): inside, with 0.9% to spare |
| hold-and-widen (`--disagree-fee-factor`) | fee + 0.5 x disagreement | the venues say the price is somewhere in a band that wide; half of it is the most the pool could be off from the middle of the band |
| watch sources (`--watch-sources`) | coingecko | off-ledger, so never traded on; a 15% gap (`--watch-max-deviation`) means a venue or the aggregator is broken or the market moved without the pools: a human should look |
| pause after (`--pause-after`) | 600 s | quotes blink; ten minutes of no usable reference (or of disagreement) is no longer a blink |
| resume after (`--resume-after`) | 900 s | reopen only after the reference has been healthy for longer than it took to pause |
| dead band (`--dead-band`) | half the pool's current fee | inside half the fee an arbitrageur cannot profit from the gap, so moving costs budget and gas for nothing; and a wider fee (volatile market) widens the band by itself |
| spend fraction (`--spend-fraction`) | 50% of the allowance available now | the design's alerts key on moves that spend MOST of the allowance (that is what a thief does); spending at most half keeps the bot's moves distinguishable from theft, and leaves room for the next tick |
| rolling cap (`--max-window-spend`, `--spend-window`) | 60% of the allowance in any 10 minutes | the first soak spent 50% and then 50% of the rest a minute later: 74% of the allowance in two minutes, a pattern the watcher could not tell from theft. Spent S in the window and allowance A now, the next move is at most 0.6 x (S + A) - S. The watcher's `window-spend` rule checks the same quantity |
| reserve (`--reserve-fraction`) | 10% of one full budget never spent | an always-available slice for a sudden move |
| minimum move (`--min-move`) | 3 bps of price | smaller moves are not worth a transaction (~0.5 XRD each) |
| side (`--side`) | balanced | removal (reserves to inventory) costs only its price move, an addition about 1.5x (price plus depth); `balanced` removes while the curve is deeper than its depth at the bot's first start and adds from inventory while it is shallower, so the curve neither shrinks to its floors nor fills to its caps over time. Whichever candidate closes more of the gap wins; the preferred one wins within 1 bps |
| target depth (`--target-depth`) | sqrt(Ra*Rb), re-read after every owner reserve change (state file) | the curve size the owner set up, including later deposits and withdrawals (review L-4) |
| reference median (`--reference-median`) | 3 healthy readings | a one-tick manipulation is never the target (review H-2); at least 3 on mainnet |
| anchor strikes (`--anchor-strikes`) | 2 ticks | one tick of a moved venue cannot pause the pool (review H-2) |
| CoinGecko brake (`--brake-max-deviation`, `--brake-min-readings`, `--brake-warmup-deviation`, `--brake-sample`) | 2%; 12; 15%; 300 s | the owner's decision; see "CoinGecko brake" |
| Gateway lag (`--max-gateway-lag`) | 120 s | quotes from an older ledger are not the market (review M-4) |
| validity (`--tx-validity`) | 2 epochs and 120 s of ledger time | a timed-out send must not commit minutes later (review M-3) |
| races (`--max-races`) | 10 in a row | a swap racing a rebalance is normal on a traded pool (review M-2) |
| max anchor distance (`--max-anchor-distance`) | 5% from the OWNER's anchor | the design's loss bound grows with how far the curve may be from a stated anchor (D); 5% is the distance the design's tables treat as a stale anchor. Beyond it the owner, not the bot, decides the price |
| anchor resume (`--anchor-resume-factor`) | 0.8 (within 4%) | hysteresis, so the bot does not pause and resume on every tick near the boundary |
| owner anchor | the ledger's last `OwnerPoolAnchorEvent` | the owner's own statement, not a copy that can go stale; `--owner-anchor A:B` only as a fallback (see above) |
| anchor re-check (`--anchor-recheck`) | 300 s | a restatement is noticed within five minutes; incremental, so cheap |
| alert URL (`--alert-url`, env `OWNER_POOL_BOT_ALERT_URL`) | none: nothing sent (REQUIRED with `--send`) | see "Alerts" |
| alert interval (`--alert-interval`) | 3600 s per condition | one message per problem per hour is noticed without flooding a phone |
| behind alert (`--alert-behind-ticks`) | 10 ticks in a row | ten minutes of not catching up is no longer noise |
| tick-error alert (`--alert-error-ticks`) | 3 in a row | the back-off has started |
| sent log (`--sent-log`) | `data/owner-pool-bot-sent.jsonl` on Stokenet; required on mainnet | the watcher compares operator actions on ledger with it; created empty at start |
| base fee (`--base-fee`) | 100 bps | the owner's decision: the on-ledger venues quote 0.2-6.5% round trips at 1,000 XRD, so 30 bps left the pool far the cheapest place to trade against a possibly stale price. On mainnet the owner sets an operator fee range of about 50-200 bps at pool set-up. The Stokenet test pool's range is 10-100 bps, so there the fee sits at 100 (clamped; see below) |
| volatility multiplier (`--vol-multiplier`) | 2 | the fee should cover about a two-sigma move of the reference between two ticks (the curve is stale for up to one tick) |
| volatility window (`--vol-window`) | 1 h | recent enough to react, long enough to be a measure |
| behind (`--behind-fee`) | +10 bps | when the bot cannot close the gap (allowance spent, cap reached, a failed preview), the curve is knowingly off: charge more for trading against it |
| min fee change (`--min-fee-change`) | 5 bps | each change is a transaction; smaller changes do not matter |
| widen after (`--widen-interval`) | 120 s since the last change | widening protects the pool: soon |
| narrow after (`--narrow-interval`) | 900 s since the last change | calm must last before the spread comes back in |
| fee range | the owner's [min, max] (10-100 bps on Stokenet) | the contract refuses anything else; with a single-value range the bot never touches the fee. The rule's target is clamped into the range and the log line says `clamped: max of the operator range ...`; once the fee IS the clamped target nothing is attempted (no tick after tick of refused changes), and a change that failed (preview refused or send failed) is not retried for the same fee within `--narrow-interval` |
| tx cap (`--max-tx-per-hour`) | 12 | about three times what a busy hour needs (one rebalance and a fee change every 15 min); a bug cannot burn fees or budget fast |
| failure halt (`--max-failures`, `--halt`) | 3 failed sends in a row: no sends for 1 h, except the protective pause and fee widening | a contract or ledger problem should stop it, not loop it; it must not stop the bot protecting the pool |
| fee lock (`--fee-lock`) | 5 XRD | previews measure 0.37-0.51 XRD per bot transaction |
| `--no-fee` | off | to run the bot without fee control |

Gateway errors: the tick fails (every read comes before any send, so a failed read sends nothing), is
logged, and the next one waits `interval * 2^errors`, at most 15 minutes; the third failure in a row
alerts `tick-errors` (`tickOutcome`). A tick that is sending finishes before a stop signal is obeyed.

### Rebalance in detail

With pool price P = Rb/Ra and target T: if d(P, T) = max(P/T, T/P) - 1 is inside the dead band,
nothing. Otherwise the candidates are one-sided moves that would land exactly on T: to raise the price,
remove A (A to rb/T) or add B (B to T*ra); to lower it, remove B or add A. Each candidate is checked
with `ownerPoolPlanRebalance` (the contract's checks and cost, exact); if the full move does not fit
(cost above the spendable allowance, a cap, a floor, or not enough inventory), the largest fraction
of it that fits is taken (next section: the cost is not lowest for the smallest move, so this is a
search for the cheapest point first, then the largest fraction beyond it that fits; since 47dc8fe).
Amounts are rounded toward zero to the token's places: a partial move never passes the target. A
returned move has therefore already passed every check the contract will make; the preview then
confirms it on ledger state, and the `expected` reserves guard makes it fail rather than act if a
swap lands between the read and the commit.

Spendable = min(allowance x 0.5, allowance - 0.1 x budget, rolling-window room). The bot is "behind"
when the move it can afford leaves the pool outside the dead band. Its own spends (the cost in the
ledger's `OwnerPoolRebalanceEvent`, else the planned cost) are kept in the state file for the window.

Remember (design doc): after an operator move the anchor ON LEDGER becomes the new price, and the
next move costs max(distance from the current price, distance from that anchor). That is why the bot
checks its own distance against the OWNER's stated anchor, not the ledger's.

### After a trade bigger than the budget: partial moves, and why arbitrageurs do most of it

A trade moves the curve but not the ledger anchor (the reserves after the operator's last costed
move). Say the operator left the pool at the target, then a sale moved it g away. A move t of the way
back costs

    max(t x g, (1 - t) x g)  (+ depth growth for an addition; removals have none)

because the "from the anchor" term starts at the whole trade's move g and only falls as the price
returns. So **every** move back costs at least g/2, the cheapest is the half-way move, and the full
correction costs g. The bot (since 47dc8fe) finds the cheapest point, then takes the largest move from
there whose exact contract cost fits the spendable allowance and every cap, floor and inventory limit,
and sends it if it is at least the minimum move. Three cases with spendable S:

- **S >= g:** the full correction, at once.
- **g/2 <= S < g:** a partial move past the half-way point (cost = S), then, since that move resets the
  ledger anchor to the curve, later moves cost only their own size and close the rest as the
  allowance and the rolling window refill (one budget per 72 epochs, about 4 bps per epoch at 300 bps).
- **S < g/2:** nothing fits. The log says `no move fits: the cheapest move toward the target costs C ...`
  with `cheapestCost`, and the bot is behind until the allowance has grown to C or the price has come
  back on its own. If the target is not where the anchor is (the reference moved), the cheapest point is
  not exactly half-way; the search handles that (the code before 47dc8fe bisected down from the full
  move and missed partial moves whose cheapest point lay beyond half-way).

On mainnet defaults (budget 300 bps, per tick half the allowance, window 60%, single venue halves both)
a tick spends at most 0.015 with a full allowance (0.0075 with one venue), so a trade that moves the
pool more than about 3% from where the operator left it (1.5% with one venue; less when the allowance
is not full) leaves the bot unable to move at all at first, and a
correction of a few percent takes hours of refill. **On a small pool, arbitrageurs do most of the
re-centring:** the pool after a big trade is off the market by the trade's whole move, minus only the
fee, which is exactly the profit an arbitrageur takes by trading it back. The budget is deliberately too
small for the operator to chase large moves (it is what limits a stolen hot key), so the bot's job after
a large trade is to widen the fee while behind and correct the residual; the arbitrage trade, which
pays the pool's fee, does the bulk.

## Alerts

`--alert-url <url>` or env `OWNER_POOL_BOT_ALERT_URL`; optional in a dry run, required with `--send`. Each alert is a plain HTTP POST of a
short text body (at most 1,000 characters, `content-type: text/plain`), so an ntfy topic URL
(`https://ntfy.sh/<topic>`) works as is. Nothing is sent when neither is set. The URL is never logged
(the start line shows `alertUrl: "(set)"`); each tick's log line lists the alerts raised and whether
each was sent, suppressed by the rate limit, or failed. Sending never blocks or breaks a tick (10 s
timeout); an alert that could not be delivered is retried on the next occurrence.

| Key | When |
|---|---|
| `start`, `stop` | the loop starts / stops (not with `--once` unless `--send`). NEVER rate-limited: every restart, a crash loop included, is reported. With `--send` the start alert must be delivered |
| `start-refused` | the bot refused to start (every problem listed). Never rate-limited |
| `coingecko-brake` | the CoinGecko brake engaged: no rebalance until the ratio is back inside (once per episode) |
| `coingecko-unavailable` | CoinGecko unavailable or stale for over an hour: the brake has no signal |
| `gateway-lag` | the mainnet Gateway's ledger is more than `--max-gateway-lag` behind: no venue counts |
| `pool-pause`, `pool-unpause` | the bot set or cleared the operator pause (with the txid, or "previewed only" in a dry run) |
| `anchor-stop` | the reference is beyond `--max-anchor-distance` from the owner's anchor: the owner must restate it |
| `anchor-restated` | the ledger shows a new owner anchor statement (never rate-limited since 23 Nov 2026: each restatement zeroes the allowance; a correction minutes later was suppressed before) |
| `anchor-unknown` | the owner's anchor cannot be read from the ledger (and whether the flag is used instead) |
| `halt` | `--max-failures` sends failed in a row (or `--max-races` "Reserves moved" races): sending stops for `--halt` seconds, except the protective pause and fee widening |
| `reference-unhealthy` | the on-ledger reference has been unusable (no live venue, or the venues more than 4% apart) for longer than `--pause-after` |
| `single-venue` | only one venue is confirmed live: trading cautiously (once per episode; cleared when two or more are confirmed) |
| `venue-hold` | the set of live venues changed: holding position for `--venue-hold` (which venues dropped / came back) |
| `venue-hold-restart` | the set changed again during a running hold (a venue dropped or came back): the hold restarts from now |
| `watch-coingecko-xrd-usd` | CoinGecko is more than `--watch-max-deviation` (15%) from the on-ledger reference. Information only: trading is not affected |
| `behind` | the bot could not close the gap for `--alert-behind-ticks` ticks in a row |
| `tick-errors` | `--alert-error-ticks` ticks in a row failed (Gateway down, ...) |

Rate limit (all keys but `start` and `stop`): one alert per key per `--alert-interval` (default 1 h),
kept in the state file so a restart does not repeat them. A condition that clears resets its key, so a new occurrence alerts at once;
pausing clears the "resumed" key and the reverse, so every pause and resume is reported.

The rate limiter, the sink (no URL, failures, the size cap) are unit-tested
(`packages/core/test/ownerpool-events.test.ts`); the bot's alerts were exercised against a local HTTP
listener on 127.0.0.1 during the soak (below). No real URL has been used.

## Watcher (read only)

`scripts/owner-pool-watch.ts` follows the pool's own events and alerts (same sink, same flags and env
variable) on what the audits call the theft pattern and on anything the owner should see. It holds no
key, signs nothing, and does not depend on the bot: run it where the operator key is not.

**On mainnet** it needs `--pool`, `--state` and an alert URL, scale 1 only, and the bot's sent log
(`--bot-sent-log`, which must exist: the bot creates it at start). Without the log it refuses, unless
`--no-sent-log` is given: the `not-bot` rule is then OFF, and the start line (`not-bot-rule`) and the start
alert say so. **The sent log is not trustworthy against a thief on the bot's host**: whoever stole the
operator key from that machine can append his own txids to the log before submitting. The behavioural
rules below (`move-away`, `fee-outside-rule`) and the spend rules do not use the log and are the real
theft detection; `not-bot` only catches a second key holder who cannot write that file (e.g. the watcher
reads a copy shipped append-only from the bot's host). Rules in
`packages/core/src/ownerpool-watch.ts`, tested in `packages/core/test/ownerpool-watch.test.ts`.

```
npx tsx scripts/owner-pool-watch.ts                       # live, from now; one tick a minute
npx tsx scripts/owner-pool-watch.ts --once --replay       # the pool's whole history; prints findings, sends no alerts
```

| Rule | Severity | Fires when | Default |
|---|---|---|---|
| `large-spend` | alert | one operator `rebalance` spends more than this share of the allowance available before it (cost / (cost + allowance after), both from the event) | 60% (`--max-spend-share`); the bot never spends more than 50% |
| `window-spend` | alert | operator moves within any 10 minutes (event times), two or more, spent more than this share of the allowance available when the first was made (sum of costs / (sum + allowance after the last)) | 60% (`--max-window-spend`, `--spend-window`), the bot's own cap. Catches a thief copying the bot's "half, then half": on the Stokenet history it flags the first soak's 18:58-18:59 pair (74.3%) |
| `spend-24h` | alert | operator budget spent in the last 24 h (event times) above this many full budgets | 1 + 24 h / (window_epochs x `--epoch-sec` 301): the full allowance plus a day of refill, so the bot's legitimate use never alarms (3 budgets at 144 epochs on mainnet, about 5 on Stokenet's 72); `--max-spend-24h` overrides |
| `move-away` | alert, never rate-limited | an operator `rebalance` (from its event: reserves after, minus the move) that leaves the pool further than `--move-tolerance` (10 bps) from the watcher's reference now AND from its median of 3 than it was. The bot only moves toward its target, so this is never the bot's. Live only (not in a replay) | needs no sent log |
| `move-unhealthy` | warn | an operator `rebalance` while the watcher's own reference is unusable | |
| `fee-outside-rule` | alert, never rate-limited | an operator fee change outside what the bot's fee rule can produce now: below the base fee (less 10 bps), or above base + 2 x vol x 2 (the watcher's own volatility measure, doubled) + behind + single-venue add + 10 bps, clamped to the operator range (the range's top while the venues disagree). `--bot-base-fee` etc. must match the bot's flags | needs no sent log |
| `operator-change` | alert | `OwnerPoolOperatorEvent` names a different operator (appointed, replaced, revoked) | |
| `limits-change` | alert | `OwnerPoolOperatorEvent` carries operator limits that differ from the last known (`set_operator_limits`, or a re-appointment with new limits): lists each changed field | baseline from the pool's state at a live start |
| `not-bot` | alert | an operator action (operator `rebalance`, or a fee or operator-pause change not made by the owner) whose intent hash is not in the bot's sent log; `info` for actions older than the log | `--bot-sent-log` |
| `fee-change` | warn (operator) / info (owner) | the fee in `OwnerPoolConfigEvent` changed. The owner's only when the manifest PROVES the owner badge (`create_proof_of_amount`/`_non_fungibles` on it); anything else, a call through another component included, is the operator's (review M-1) | |
| `pause-change` | warn | the owner's or the operator's pause flag changed | |
| `anchor-restated` | info | `OwnerPoolAnchorEvent` | |
| `anchor-drift` | warn | the owner's anchor is this far from the reference (mapped onto the pool) | 5% (`--max-anchor-drift`) |
| `pool-drift` | warn | the pool's price is this far from the reference | 3% (`--max-pool-drift`) |

Alerts are rate-limited per rule (one per rule per `--alert-interval`, default 1 h; every finding is
still logged), except `limits-change` and `operator-change`, which alert every time (since 23 Nov 2026:
each is a separate owner act, and on Stokenet a limits change reversed minutes later would otherwise
have gone unalerted). Code: `watchAlertMode` (pure, tested). `info` findings are never alerted.

Who changed the fee or the operator pause is decided by proof: the owner only when the root manifest
proves the owner badge from an account; otherwise the operator, whatever component made the call
(review M-1). The operator badge in force is the last one the pool announced. A replay from the pool's
first transaction starts from a fresh pool's configuration (unpaused, no operator: instantiate emits no
config event), so the owner's first pause after instantiation and the first appointment are reported. The reference is
the bot's (on-ledger venues, `--venues`, `--quote-size`; drift is checked only while they agree); with `--scale auto` the watcher takes the bot's calibration from
`--bot-state` when it matches the owner's anchor, else calibrates itself to the anchor. Its checkpoint
(identity, next state version, last config, the operator limits, the 24 h spends, the owner's anchor, its
own recent references) is `data/owner-pool-watch-stokenet-state.json` on Stokenet (`--state`, required on
mainnet); a replay never writes it.
`warn` and `alert` findings are sent (rate-limited per rule); `info` is only logged.

What it flagged on the Stokenet history (replay, 22 Nov 2026): see "Soak test" below.

## Markout: per-trade profit record (read only)

Owner's decision, 22 Nov 2026. The question it answers: **does the fee pay for the trades the pool
takes?** A trader who knows the price is about to move trades against the pool just before it does;
the fee is what the pool earns, the move afterwards is what it loses. The record is kept by the
WATCHER (`scripts/owner-pool-watch.ts`, on by default, `--markout <path>`, `--no-markout`), never by
the bot: it is not in the trading path and holds no key. Maths in `packages/core/src/ownerpool-markout.ts`
(pure, tested in `packages/core/test/ownerpool-markout.test.ts`); summary in `scripts/owner-pool-markout.ts`.

- **Trades** come from the pool's own `OwnerPoolSwapEvent` (emitted by the pool component's Main
  module; fields `input_resource`, `input_amount`, `output_resource`, `output_amount`, `fee` (in the
  input token, kept by the pool), `reserve_a`, `reserve_b` after the swap). Each is recorded with its
  txid, time, side (`sellA`: the trader sold XRD; `buyA`: bought XRD), amounts, trade price (B per A,
  fee included), the fee level in force (read off the trade: fee / input, in bps), the fee in XRD, the
  size in XRD, the pool's mid after the swap, and the **reference at trade time**: the watcher's own
  on-ledger venue reference (the bot's code and options: fee rule, the guard that refuses any OwnerPool
  as a venue), mapped onto the pool with the bot's `--scale` calibration. It is read on the watcher tick
  that sees the trade, so up to one tick (60 s) after it (`lagSec` in the log).
- **Marks** at +5 and +30 minutes (`--markout-horizons`): the reference again (and, as a second view,
  the pool's own mid), taken on the first tick at or after the due time (`lateSec`, at most a tick).
- **Signs** (everything in XRD, from the pool's side, at a price P in B per A):
  `pnl(P) = inA - outB / P` for a trader selling XRD, `inB / P - outA` for one buying XRD;
  `feeXRD` = the fee (XRD in) or fee / P0 (TEUR or hUSDC in, at the trade-time reference P0);
  **markout = pnl(P) - feeXRD: NEGATIVE means the trader was right** (the price moved their way after
  the trade); **profit = fee + markout**.
- **Break-even fee** = -markout / volume, in bps (0 when the markout is not negative): the fee that
  would have covered the markout, assuming the same trades would still have happened at that fee.
- **Kept in** `data/owner-pool-markout.jsonl` (gitignored): one `trade` line per swap, one `mark` line
  per horizon. Pending marks are worked out from the file itself (trades without their marks), so a
  restart loses nothing: a mark that came due while the watcher was down is taken at the next tick, late
  (its `lateSec` says by how much). The watcher's checkpoint (`state.next`) makes sure no swap is
  missed; a fresh watcher state starts from "now", so swaps before the first start are not recorded.

**Summary:**

```
npx tsx scripts/owner-pool-markout.ts            # table: all, by trade size, by fee level
npx tsx scripts/owner-pool-markout.ts --trades   # plus one line per trade
npx tsx scripts/owner-pool-markout.ts --json     # the same as JSON
```

Columns: trades, volume (XRD), fees (XRD), average fee (bps); then per horizon N: `nN` trades marked,
`mkNm` total markout, `profitNm` = fees + markout of the marked trades, `beNm` break-even fee (bps),
`mid-mkNm` the markout against the pool's own mid instead of the reference (a second view: the pool's
mid is where the bot was moving it, so it is not independent of the reference). Rows: ALL, by trade
size (0-10, 10-100, 100-1000, >=1000 XRD; `--sizes`), by fee level in force.

**How to read it.** Profit after markout is what matters, not the fee income. If `profit30m` is
positive over a meaningful number of trades, the fee is earning more than traders take; if it is
negative, traders are picking the pool off and the fee is too low (or the bot too slow). **The owner
should tighten (lower) the fee only while profit after markout stays positive** at the fee level being
considered, and `be30m` is the floor below which the trades seen so far would have lost money. Look
at the size split too: losses concentrated in large trades mean informed flow, which a wider fee for
size (not available in the contract) or a slower bot does not cure. A handful of trades says nothing:
the markout of one trade is mostly noise.

**On Stokenet** the reference is the mainnet XRD/hUSDC price scaled onto the TEUR test pool, and the
test swaps are made by our own test account, so the numbers test the plumbing only, not real profit.

**Tried on Stokenet (22 Nov 2026, 23:14-23:46 UTC).** The watcher with the markout record running
(`data/soak/watch5m*.log`), the bot stopped. Seven swaps by the test account alice
(`tsx scripts/stokenet-owner-pool.ts trade <xrd|teur> <amount> --send`, each asserting the exact quote,
which matched the ledger's): at fee 100, sell 50 XRD (`txid_tdx_2_1edzjc0ju…`), buy with 0.04 TEUR
(`…1hstngjja…`), sell 300 XRD (`…1tu2ev6pd…`); the fee was then set to 30; at 30, buy with 0.25 TEUR
(`…1l3g6xudu…`), sell 5 XRD (`…1n4rcj9k5…`), buy with 0.01 TEUR (`…1v09l9c2u…`), sell 20 XRD
(`…17t96egqh…`). All seven were recorded on the watcher tick after them (2-58 s), with the fee level
read off the trade (100 / 30 bps); the +5 marks came 2-57 s after due. **The watcher was stopped and
restarted at 23:21 between the +5 and +30 marks; all seven +30 marks were still taken (23:44-23:45),
nothing lost.** Between the marks the mainnet Ociswap precision pool (the only live venue) moved
0.000824 -> 0.000791 -> 0.000801, so the +30 marks differ from the +5 ones. Summary
(`data/soak/markout5-summary.txt`): 7 trades, 750 XRD volume, fees 5.05 XRD (67 bps average); +5 min
markout -0.078 XRD, profit 4.97; +30 min markout +0.194, profit 5.24, break-even fee 0 overall (by
fee level: the 100 bps trades -2.42 markout at +30, break-even 61 bps; the 30 bps trades +2.62). These
are test trades against a scaled test reference: the figures prove the recording, the signs and the
restart, nothing about profit.

## What it cannot do (owner only)

- **Restate the anchor** (`set_anchor`), or appoint/replace/revoke the operator (`set_operator`).
  When the market moves more than 5% from the owner's anchor the bot pauses and says so (log and
  alert); the owner restates the anchor (which zeroes the operator's allowance: it refills over one
  window, ~12 h on Stokenet at 72 epochs of ~10 min). The bot picks the new anchor up from the ledger
  within `--anchor-recheck`; no flag to update.
- Deposit or withdraw reserves or inventory, `owner_rebalance`, set the limits, set the fee outside
  the operator range, or clear the OWNER's pause. While the owner's pause is on the bot sends nothing.
- Clear an operator pause it did not set (the owner may set it too).
- Take profit out: swap fees accrue to the reserves; the bot's removals move tokens to the inventory,
  which only the owner can withdraw.

## Failure modes

| What happens | What the bot does |
|---|---|
| a venue's quote fails, part-fills, times out (45 s) or goes stale, or its round trip is over 10% | the venue is dropped for the tick; none left: no rebalance, no fee change; 10 min of that: operator pause |
| only one venue is live | it is used; the log line says `only ONE live venue` |
| a venue's own fee (from its quotes) is over 1% | excluded every tick it is; logged with the estimate |
| the set of live venues changes | hold: no rebalance for 15 min (restarts on another change; survives a restart); fee may widen, not narrow; alert `venue-hold` |
| a reference venue is the operated pool or any OwnerPool | the bot (and the watcher) refuse to start |
| the live venues disagree by more than 4% | HOLD: no rebalance; fee widened by half the disagreement (inside the operator range); 10 min: operator pause; resumes after 15 min of agreement |
| CoinGecko is more than 15% from the reference, or fails | alert (`watch-...`) only; trading unaffected |
| two moves inside 10 minutes would spend over 60% of the allowance | the second is clipped to the room left, or waits |
| the rule's fee is outside the operator range | clamped to the range; nothing attempted once there; a failed change is not retried at once |
| the market runs more than 5% from the owner's anchor | operator pause at once; log line `ownerMustAct` names what the owner must do |
| allowance spent (or inside the reserve) | no move; "behind" widens the fee by 10 bps |
| a move would cross a cap or floor, or inventory is short | clipped to fit, or the other side is used, or no move |
| a swap lands between the read and the commit | the `expected` guard fails the transaction ("Reserves moved"); it counts as a failure |
| a preview fails | nothing is sent; logged with the ledger's message |
| three sends fail in a row | sending halts for an hour |
| the transaction cap is reached | nothing is sent; logged |
| the Gateway is down | the tick fails; back-off up to 15 min |
| the operator was revoked or replaced | the bot sees it is not the appointed operator and sends nothing |
| the owner pauses | the bot sends nothing until the owner reopens |
| the owner's anchor cannot be read from the ledger | `--owner-anchor` if given; else no rebalance, no fee change; alert |
| SIGINT / SIGTERM | finishes the current tick, saves state, alerts "stopped" (never rate-limited), exits |
| a second copy started on the same state file | refused by the lock |

## Proven on Stokenet (22 Nov 2026, first version: median of sources, base fee 30)

Pool `component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk`, operator badge 2,
operator account `account_tdx_2_128x3s0xqj8nj55st5s38mjfsfcc2ddyejcq2vjwuctwugy3ukwcj22`. SENT means
committed on Stokenet; previewed means previewed only.

**Builders not proven before** (`tsx scripts/stokenet-owner-pool.ts builders --send`):

| Call | Key | Result |
|---|---|---|
| `operator_set_fee(101)` | operator | previewed: refused "Fee outside the operator's range" |
| `operator_set_fee(40)` | operator | SENT `txid_tdx_2_1fsm07c9a9wccfv9jvkz5q4265sfr2rpaph77f2rgw83jkfcstfmsekgrp0`, fee read back 40 |
| `operator_set_fee(30)` | operator | SENT `txid_tdx_2_1nfjrkyf4rfee6dx8wxlkwdggvvhvkta0l4p0xztcnfrw63cvsk5qx7f2q6`, fee read back 30 |
| `set_operator_paused(true)` | operator | SENT `txid_tdx_2_163ssh634d3upgr3rx8mc6x0hjpypdrs5gwrfugspgw896csdnrxsjcqlna`; ledger and local quotes "Swaps are paused"; owner pause still off |
| `set_operator_paused(false)` | operator | SENT `txid_tdx_2_1eam24at8nqygxykvkzv0c3flddnnful8uehte84ety4n9xhmye8qtul8pm`; pool open |
| `set_anchor` (the anchor already on ledger, `expected` = reserves) | owner | previewed: succeeds (not sent: the anchor was not changed) |
| `set_anchor` | operator badge | previewed: refused (owner role) |
| `withdraw_inventory(1 XRD, 0.000001 TEUR)` | owner | previewed: succeeds (not sent) |
| `withdraw_inventory` | operator badge | previewed: refused (owner role) |

**The bot** (state file `data/owner-pool-bot-live.json`, `--scale 1`, fixed references):

| Run | Result |
|---|---|
| `--once` dry, live mainnet sources | Ociswap 0.000831, CaviarNine 0.000854, CoinGecko 0.000800: "sources disagree by 6.78%": no action |
| `--once` dry, reference = pool price +0.15% | gap 15 bps = the dead band edge; rebalance planned (remove 30.03 XRD, cost 0.001869) and previewed ok |
| `--once --send`, reference = pool price +0.18% | SENT rebalance `txid_tdx_2_1y2secwhmdyq9qmzut3c7j50s93lkp7cjzfftg0vmn7gvjpsufrjs5ccky6`: -36.030216243340297291 XRD to inventory; price 0.000797312 -> 0.000798747 (= the target); ledger event cost 0.001800000000000145 = the planned cost; allowance 0.007083 -> 0.005283 |
| `--send`, sources 5% apart | "sources disagree by 5.00%": no action, no pause yet (pause after 600 s) |
| same, `--pause-after 0` | SENT `set_operator_paused(true)` `txid_tdx_2_1a4dmqaghkw7quyphnquz3u4cmx8y8n8xj98a7fs5fmxpe4nc8ddqdzp28s` |
| healthy again, default resume delay | stays paused ("healthy for 0 s (resume after 900 s)"), no rebalance or fee change while paused |
| healthy, `--resume-after 0` | SENT `set_operator_paused(false)` `txid_tdx_2_1askx0k0tz5ttnxvpg9avlgez9txq69wqy9h068pyurmrwlmasz5sc0l35u` |
| next tick | "inside the dead band": nothing to do |
| dry, reference 0.0009 (12.5% from the owner anchor) | pause planned at once and previewed ok; log `ownerMustAct`: "The OWNER must restate the anchor" |
| dry, reference 2% above | clipped rebalance (cost 0.002283 = spendable: allowance 0.005283 minus the 0.003 reserve), still 180 bps behind; fee widen 30 -> 100 previewed |
| `--send --base-fee 40 --vol-multiplier 0` | SENT `operator_set_fee(40)` `txid_tdx_2_1l8fqhxt3z3s44c9c9kdqgjxrzvueh8x84afr52mhc53yvlwzf64qesv2m8` |
| base fee back to 30 | narrow held: "last fee change 29 s ago (< 900 s)" |
| `--narrow-interval 0` | SENT `operator_set_fee(30)` `txid_tdx_2_16k5y563d6ukllr9eraj3mz9zvvrkapejvm9nzk0cajydk09yv5ds982m8w` |
| `--send --max-tx-per-hour 1` (5 sends in the last hour) | rebalance skipped: "transaction cap reached (1 per hour)"; nothing previewed or sent |
| long-running, `--send --interval 20`, reference 0.0008, SIGTERM after ~75 s | tick 1 SENT rebalance `txid_tdx_2_18g3mvvxqjj3t7x02fnxyvcjka64uwrpvdpm5tq9ss68zj9x00vns983xl4` (cost 0.001569045740593227), price 0.000798747 -> 0.0008; ticks 2-4 "nothing to do"; on SIGTERM it finished, saved state and exited |

Pool afterwards: reserves 19,985.42875 XRD / 15.988343 TEUR (price exactly 0.0008, the anchor
price), inventory 1,067.388268… XRD / 0.8 TEUR (the bot's two removals, 67.39 XRD in all, went to the
inventory), fee 30 bps, owner and operator pauses off, operator badge 2 still appointed. The ledger
anchor is now 19985.42875:15.988343 (the operator's last move), the same price as 1250:1.

Network fees seen in previews: rebalance 0.506 XRD, `operator_set_fee` 0.367, `set_operator_paused`
0.378.

## Soak test on Stokenet (22 Nov 2026, 17:01-19:59 UTC, code b723748, first version)

`--send`, real mainnet sources, `--scale auto`, alerts to a local listener on 127.0.0.1, the watcher
running alongside (read only, same listener). Logs in `data/soak/` (gitignored). Three phases:

| Phase | Settings | Time | Ticks | Sent |
|---|---|---|---|---|
| 1 | default 2% disagreement bound, sources ociswap, caviarnine, coingecko | 17:01-17:13 | 13 | 1 |
| 2 | **10% bound (TEST ONLY: the real sources disagree by ~7%)**, same sources, same state | 17:13-18:14 | 60 | 2 |
| 3 | 10% bound, sources **ociswap, coingecko** (see below), pause bookkeeping kept, fresh calibration | 18:14-19:59 | 104 | 8 |

1. **2% refuses and pauses.** Every tick "sources disagree by 7.08-7.10%": no action; at 600 s the
   operator pause, SENT `txid_tdx_2_1af895553wgtf3rmzd0qgnu9le26wl6j2kzcmcn0n4sqysdt7r60qt8a4un`;
   alerts `sources-unhealthy` and `pool-pause` delivered.
2. **10%: resumes, then pauses on a real market move.** Healthy at once (7.06%); the bot cleared its own
   pause after 915 s, SENT `txid_tdx_2_103eug2q8m0z0rgdfxf6qa9g40jhn3ufuzssvtn3ht23ttrjklnlse2wf9l`. The
   pool sat at the target (the median was the Ociswap reading, which never changed). At 17:46 CoinGecko
   fell from 0.000799 to 0.000760-0.000775 while both on-ledger pools stayed put: disagreement 10.2-12.3%,
   reference refused, and after 10 min the bot paused again, SENT
   `txid_tdx_2_1lfayzltwwtkt284t026u0708tukvxt5qhs6ekj2twa32kxlhsmvqsvlrzu`. The watcher flagged
   `pool-drift` (pool 3.2% from the reference) meanwhile.
3. **Two sources, real moves.** Because the CaviarNine and (until 18:35) the Ociswap readings never
   changed, the three-source median could not follow anything; phase 3 used Ociswap + CoinGecko (median =
   mean). It kept phase 2's pause bookkeeping, so it cleared the pause after 944 s healthy
   (`txid_tdx_2_1nqcc56nlgavmcnywlknhfgct4nn5rzs2uclkcjjd54nceuwzznusd377zr`). At 18:58 CoinGecko jumped
   ~2.7%: gap 143 bps; the bot moved three times, each clipped to half the allowance, and widened the fee:

| Time | Gap before | Move | Cost (event) | Allowance before | Gap after | txid |
|---|---|---|---|---|---|---|
| 18:58 | 143 bps | -148.42 XRD to inventory | 0.007482 | 0.014964 | 68 bps | `txid_tdx_2_1zj9aa58pe3w4k4wehkp4pdcuwyll6d4zekm40vywzymaegz8vhfsrzpf8j` |
| 18:59 | 68 bps | -78.04 XRD | 0.003949 | 0.007899 | 28 bps | `txid_tdx_2_1vwhtwmsd4auf4nx5hjxazhkmpdmrley2vtav80qn6ntng3a0qu0q4wm0ap` |
| 19:14 | 35 bps | -0.035087 TEUR to inventory | 0.002199 | 0.005199 | 13 bps | `txid_tdx_2_15l45e3r0e5wmcykcsfsax4wkdqhmj8y4nx442m9z5zuz03rzf5kqdeftdp` |

   Fee changes (all by the fee rule): 30 -> 35 (18:22, volatility), 35 -> 81 (18:58, volatility 20 bps
   + behind), 81 -> 67 (19:13), 67 -> 44 (19:57); after the soak a last `--once --send` with
   `--vol-multiplier 0 --narrow-interval 0` set it back to 30
   (`txid_tdx_2_1ct4kshyya8zd6cesj2ka8zvwy9pluala2vr7rdwzlkx92a9yahvse7gvzh`).

Figures: 177 ticks, 11 transactions sent in the soak (+1 fee reset), all `CommittedSuccess`, no preview
failure, no tick error, no back-off, no halt. Allowance spent 0.013631 of a 0.03 budget (per 72
epochs); the watcher's 24 h count after the soak was 0.018 (it includes the three operator moves made earlier that day).
Max gap between pool and reference while not paused: 143 bps (the 18:58 jump), closed to 13 bps within
17 min. The bot was "behind" for at most 1 tick in a row, so the `behind` alert never fired. Network
fees: operator account 195.0400 -> 190.4498 XRD over the soak (4.590 XRD for 11 transactions; 4.966 XRD
with the fee reset); previews estimated 0.378 (pause), 0.367 (fee), 0.506-0.510 (rebalance).

Pool afterwards: reserves 19,758.969 XRD / 15.953256 TEUR, price 0.00080739 TEUR per XRD (0.92% above
the owner's 1250:1 anchor, following the reference), inventory 1,293.85 XRD / 0.835087 TEUR, fee 30 bps,
owner and operator pauses off, operator badge 2 appointed, owner anchor still 1250:1 (ledger anchor =
the bot's last move), stored allowance 0.003.

**Watcher on the same history** (`--once --replay`, after the soak): the only `alert`-level findings are
the owner's two appointments, the revoke, and one `large-spend`: the end-to-end script's operator move
of 15:13 (`txid_tdx_2_1seac4ptgwwra...`), which spent 80.1% of the allowance available, the pattern the
rule is for (it was a test, not the bot). Operator actions before the bot's sent log began (the
16:37-16:45 drills) are `info` "cannot be attributed"; every operator action during the soak was in the
sent log, so none was flagged `not-bot`. The three soak moves spent exactly 50%, 50% and 42% of the
allowance available: not flagged. Alerts actually delivered by the live watcher: pause on/off, fee
changes, `pool-drift`; repeats of the same rule within the hour were suppressed (e.g. the 17:56 pause).

## Soak 4 on Stokenet (22 Nov 2026, 20:17-21:40 UTC, code 9faa6f5): on-ledger venue reference

`--send`, the new defaults (venues ociswap, ociswap-precision, caviarnine, defiplaza at 1,000 XRD; 4%
bound; base fee 100; rolling cap 60% / 10 min), `--scale auto` with a fresh state file (calibrated at the
first tick: reference 0.000814623 USD per XRD -> the owner's 1250:1 anchor, scale 0.98205), alerts to a
local listener on 127.0.0.1, the watcher running alongside (live, same listener), and
`scripts/owner-pool-venues.ts` sampling the venues every 2 minutes at 300, 1,000 and 3,000 XRD. Logs in
`data/soak/` (`run4a-default.log`, `run4b-2pct.log`, `run4c-default.log`, `watch4.log`,
`venues-sample.log`, `alerts4.jsonl`; gitignored).

| Phase | Settings | Time | Ticks | Sent |
|---|---|---|---|---|
| A | defaults | 20:17-21:08 (51 min) | 50 | 3 |
| B | same state, **2% bound (TEST ONLY**, to force hold-and-widen and the lasting-disagreement pause) | 21:08-21:21 | 13 | 1 |
| C | defaults, same state (the bot's own pause still on) | 21:21-21:40 | 19 | 3 |

**Venue gap measured (the 4% question).** Over the whole run, at 1,000 XRD, the live venues' midpoints
were 3.06-3.28% apart (median 3.13%, 82 bot ticks, never above 4%); Ociswap basic sat at the bottom
(0.000801 -> 0.000797), Ociswap precision and CaviarNine together at the top (0.000823-0.000826, 0.03-0.12%
apart). The 300 XRD and 3,000 XRD samples give the same picture (3,000 XRD: CaviarNine always fails;
Ociswap basic vs precision 1.44-3.27%). DefiPlaza was dropped on every tick (round trip 24.5-25.3%; its
geometric mid 0.000857-0.000861, 4-7% above the others). In the first soak, the same Ociswap basic vs
CaviarNine pair (then read as the reserve ratio and a 100 XRD geometric mean) was 2.31-3.69% apart
(median 2.78%, 73 ticks, 17:01-18:14) and, by the Ociswap readings after 18:35 against CaviarNine's
unchanged 0.000854, about 6.6% for the last hour and a half. **So 4% held all evening on live
two-sided quotes, with about 0.7-0.9% to spare; it did not hold earlier in the day.** The default stays
4% (the owner's number); the margin is thin.

1. **Phase A (defaults).** Tick 1: gap 92 bps (pool 0.000807 vs target 0.0008): SENT rebalance
   `txid_tdx_2_1t7fxmppxjuaf7ehdhhsefsn34m79efk6aufxnnp87426zzn0wygs0p8e73` (cost 0.004000 = half the
   0.008000 allowance) and `operator_set_fee(100)` `txid_tdx_2_1ql2mspp8zygrlw2fsjcs4xgqnffnqdxsea7g6tp77dn0mnh7wqaqjnez7f`
   (the rule's 110 bps, behind, clamped to the range's 100: logged `clamped`). Tick 2: gap 52 bps, above
   the new 50 bps dead band; the half-and-reserve rule would have allowed 0.001416, **the rolling cap
   allowed 0.001050** (60% of the 0.008 the window began with, minus the 0.004 already spent): SENT rebalance
   `txid_tdx_2_1qz2vdj93z8m5kwe7tgp9khgrekf7f2272y9npx3yjn03fausnkqqrz44gz` (cost 0.00104996), gap 42 bps,
   inside the band. Ticks 3-50: nothing to do (the venues did not move); fee stayed at 100 with "fee 100 bps
   is the target" on every tick (no repeated attempts). The two moves together spent exactly 60.0% of
   the allowance in the window: the watcher's `window-spend` did not fire.
2. **Phase B (2% bound, test only).** Every tick HOLD ("venues disagree by 3.06-3.28% (bound 2.0%): hold
   and widen"); the widened fee target was already the range's top (100), so no fee transaction. From 21:09
   CaviarNine could not quote (its hUSDC side emptied by a trade: "InsufficientBalance ... actual
   0.045251"); it was dropped and the reference carried on with the other two. After 10 minutes the
   `reference-unhealthy` alert and SENT `set_operator_paused(true)`
   `txid_tdx_2_1j44smw0q9cvhgn00te5a8aqtkxlmujpd3dl0jvcwcxal6m8u3dtqzfzkh6`.
3. **Phase C (defaults again).** Healthy at once (3.28% < 4%), but the pause stayed until 919 s of health:
   SENT `set_operator_paused(false)` `txid_tdx_2_146h0jxjglyc79sy2949m4uj2em8saqm4lwdgxemm9zuw9suhur0s4qsy9t`.
   With CaviarNine gone the reference had fallen to 0.0007990 (target 0.0007869, gap 208 bps). SENT
   rebalance `txid_tdx_2_1aflnvacn4y9x3gh3698xngvkpwj84ak3udnqutvjet8upr3u3ukqghjc9p` (-0.075958 TEUR to
   inventory, cost 0.004808 = half the 0.009616 allowance), then, capped by the window (room 0.001212;
   the half-and-reserve rule would have allowed 0.002225), `txid_tdx_2_10mu3ec8lfwwwlqlpzjn00t9g38udhrmckuy24n9z29682ekgnrysjepr7e`
   (-0.019117 TEUR, cost 0.001212); then "best move only 0.00 bps": the window was full, the bot 147 bps
   behind when the phase ended (the `behind` alert needs 10 ticks; it was 1).

**Figures:** 82 ticks, 7 transactions sent (4 rebalances, 1 fee change, pause, unpause), all
`CommittedSuccess`; no preview failure, no tick error, no back-off, no halt. Allowance spent 0.011070
(of a 0.03 budget per 72 epochs). Network fees: operator account 190.0745 -> 186.8552 XRD (3.219 XRD
for the 7). The venue quotes: 16 mainnet previews per tick, no Gateway refusals seen. CoinGecko stayed
0.4-6.4% from the reference (no watch alert). Alerts delivered to the listener: bot `start` x3 and
`stop` x3 (each restart reported, none suppressed), `reference-unhealthy`, `pool-pause`, `pool-unpause`;
watcher `fee-change` (30 -> 100) and `pause-change` (on); the "pause off" finding was logged and
suppressed by the watcher's per-rule hourly limit. No `not-bot`, `large-spend`, `window-spend` or
`limits-change`.

After the soak, one `--once --send --dead-band 10000 --base-fee 30 --vol-multiplier 0 --narrow-interval 0`
set the fee back to 30 bps (`txid_tdx_2_1ddy0yg9tew5ry5nm5t0gj4x67qyjpq2pkg65cqsychvnuldn7zgqt8chzc`,
0.375 XRD; operator account 186.4800 XRD after). **Pool left at:** reserves 19,758.969 XRD / 15.777956
TEUR, price 0.00079852 TEUR per XRD (0.18% below the owner's 1250:1 anchor), inventory 1,293.848 XRD /
1.010387 TEUR, fee 30 bps, owner and operator pauses off, operator badge 2 appointed, owner anchor still
1250:1, allowance 0.00443. The bot at its defaults would set the fee to 100 again on its first tick.

## Soak 5 on Stokenet (22 Nov 2026, 22:20-23:13 UTC, code c79d6ec): venue-fee rule and venue-set hold

`--send`, defaults (now with the 1% venue-fee rule and the 15-minute venue-set hold), `--scale auto`
with a fresh state file (`data/soak/state5.json`; calibrated on the first tick: reference 0.000823585
-> the owner's 1250:1 anchor, scale 0.97136), alerts to a local listener on 127.0.0.1, the watcher live
alongside. Script `data/soak/run5.sh`; logs `run5a-default.log`, `run5b1-test-fee5.log`,
`run5b2-test-fee5.log`, `run5c-default.log`, `watch5.log`, `alerts5.jsonl`, `phases5.txt`,
`balances5.txt` (all in `data/soak/`, gitignored).

All evening CaviarNine could not quote at all (its hUSDC side still ~0.045 hUSDC since 21:09), DefiPlaza
failed the round-trip rule (23.7-23.9%), and the fee rule excluded Ociswap basic on every tick (its fee
read from the quotes: 3.0001%). So the live set never changed by itself: Ociswap precision alone
(fee read 0.0525%; one live venue, flagged as such on each tick). The change was therefore forced, in a
clearly labelled test phase that lets Ociswap basic back in with `--max-venue-fee 0.05`:

| Phase | Settings | Time | Ticks | Sent |
|---|---|---|---|---|
| A | defaults | 22:20-22:30 | 10 | 2 |
| B1 | **TEST ONLY `--max-venue-fee 0.05`**: Ociswap basic back in | 22:30-22:37 | 7 | 0 |
| B2 | the same, **bot restarted mid-hold** | 22:37-22:52 | 15 | 2 |
| C | defaults: Ociswap basic excluded again | 22:52-23:13 | 21 | 0 |

1. **A.** Tick 1: gap 18.5 bps (above the 15 bps band at fee 30): SENT rebalance
   `txid_tdx_2_1zmsw9ehyclk…` (remove 36.52 XRD to inventory, cost 0.001852) and `operator_set_fee(100)`
   `txid_tdx_2_1m0dwhgxmsaf…`. Then nothing to do (pool on target).
2. **B1: the set changes, the hold starts.** Tick 1: `venueSet.changed: {added: [ociswap]}`, reference
   0.000823585 -> 0.000801317 (Ociswap basic takes 85% of the weight; venues 3.28% apart, inside 4%), gap
   **277.9 bps**, decision `HOLD: venue-set hold (back ociswap) for 900 s more: no rebalance`; alert
   `venue-hold` delivered. No transaction for the whole of B1.
3. **B2: the hold survives a restart.** Restarted at 22:37:20; the first tick read the hold from the
   state file: `holdUntil 22:45:20` unchanged, "480 s more"; still no rebalance at 277.9 bps. **The hold
   ended at 22:45:20 and the next tick (22:45:35) SENT a rebalance** `txid_tdx_2_1lrypjhff6pzt…`
   (remove 0.059558 TEUR to inventory, cost 0.003789 = half the 0.007578 allowance, gap 278 -> 239 bps),
   then at 22:46:40 `txid_tdx_2_1mxxvssflklw…` (remove 0.011903 TEUR, cost 0.000758, the rolling-cap room, gap 239 -> 231
   bps); then the window was full. So on ledger: the set changed at 22:30:20, the first rebalance came
   15 min 15 s later, nothing in between.
4. **C: the reverse change.** Tick 1: `changed: {removed: [ociswap]}`, a new hold until 23:07:22, alert
   `venue-hold` delivered again (the key had been cleared when the B hold ended). The reference went
   back to 0.000823585: gap 45.5 bps, which is inside the dead band at fee 100 (50 bps), so after the
   hold there was nothing to do: this hold blocked no transaction (fee 100 is the target and the top of
   the range, so no fee change either way).

**Figures:** 53 ticks, 4 transactions sent (3 rebalances, 1 fee change), all `CommittedSuccess`; no
preview failure, no tick error, no halt. Allowance spent 0.006399. Network fees: operator account
186.4800 -> 184.5545 XRD (1.9255 XRD for 4). Alerts delivered: bot `start`/`stop` x4 each,
`venue-hold` x2; watcher `fee-change` (30 -> 100). No `pool-drift`, `not-bot`, `large-spend` or
`window-spend`. The venue guard at each start listed the four venues as BasicPool, PrecisionPool,
QuantaSwap and PlazaPair (no OwnerPool).

**Venue gap after the fee rule.** `scripts/owner-pool-venues.ts` every 60 s, 22:19-22:44 (26 samples at
1,000 XRD, `data/soak/venues5.log`): one live venue every time (Ociswap precision, 0.000823585, not a
single change), so tonight's gap is 0 by construction: there was nothing to compare it with. The last
time two low-fee venues were live together (Soak 4 phase A, 20:17-21:08, 50 ticks), Ociswap precision
and CaviarNine were **0.115% apart on every tick** (0.03% on the two ticks of phase B at 21:08-21:09).
CoinGecko was 10.3-11.3% from the precision-only reference in these samples (watch limit 15%).

After the soak (23:14), with the bot stopped: seven test swaps by the test account (alice, not the
owner or the operator) for the markout record (see "Markout"), and one `--once --send --dead-band 10000
--base-fee 30 --vol-multiplier 0 --narrow-interval 0` with a fresh state file that set the fee back to
30 bps (`txid_tdx_2_1w2tukl59x66gag9dcq7483rd55f5d0xyy923lcv87va6n690d3pqwmz43k`, 0.375 XRD).

**Pool left at** (state version 34888730): reserves 19,717.700 XRD / 15.714268 TEUR, price 0.00079696
TEUR per XRD (0.38% below the owner's 1250:1 anchor), inventory 1,330.372 XRD / 1.081848 TEUR, **fee 30
bps, owner and operator pauses off**, operator badge 2 appointed, owner anchor 1250:1, allowance
0.00303 (stored). Operator account 184.1792 XRD. The bot at its defaults would set the fee to 100 again
on its first tick.

## Soak 6 on Stokenet (23 Nov 2026, 08:44-09:19 UTC, code 6a8fad0): two-tick confirmation and single-venue caution

`--send`, fresh state file (`data/soak/state6.json`; calibrated on the first tick: reference 0.000752273
-> the owner's 1250:1 anchor, scale 1.06344), alerts to a local listener on 127.0.0.1, the watcher
alongside. **TEST setting for the whole run: `--base-fee 30`**, so the caution's +50 bps lands inside
the Stokenet pool's 10-100 bps operator range (at the default 100 it would be clamped away). Script
`data/soak/run6.sh`; logs `run6a.log`, `run6b.log`, `run6-feereset.log`, `watch6.log`,
`alerts6.jsonl`, `phases6.txt`, `balances6.txt` (all in `data/soak/`, gitignored).

Mainnet this morning: CaviarNine still cannot quote (`InsufficientBalance`, its hUSDC side 0.00025),
Ociswap basic excluded by the fee rule (3.000%), DefiPlaza quoting a 3.1% round trip but its fee read
1.459%, so excluded by the 1% rule: **Ociswap precision alone** (mid 0.000752273), and the caution
was on naturally.

| Phase | Settings | Time | Ticks | Sent |
|---|---|---|---|---|
| A | defaults (+ TEST base fee 30) | 08:44-08:51 | 8 | 2 |
| A-T1 | **TEST**: exclusion file names `ociswap-precision` for exactly tick 5 | 08:48:39 | 1 | 0 |
| B | **TEST `--max-venue-fee 0.02`**: DefiPlaza (fee 1.46%) back in as a second venue | 08:51-09:18 | 27 | 4 |
| B-T1 | **TEST**: exclusion file names `defiplaza` for exactly tick 20 | 09:11:19 | 1 | 0 |
| B-T2 | **TEST**: exclusion file names `defiplaza` from tick 23 to the end | 09:14-09:18 | 5 | 1 |

1. **A: caution on its own.** Tick 1: one confirmed venue, `singleVenueCaution` active, alert
   `single-venue` delivered once (not repeated on the 7 further ticks). Gap 38.1 bps (band 15 at fee
   30): SENT rebalance `txid_tdx_2_1f9rkmemq3jkp…` (remove 74.865 XRD, cost 0.004550; spendable
   **0.0075 = a quarter of the 0.03 allowance**, window room 0.009 = 30%; the move fitted, so it closed
   the gap fully) and `operator_set_fee(80)` `txid_tdx_2_1ggzanhsz4ln2…` (rule 30 + 0 vol **+ 50**).
2. **A-T1: the only venue fails ONE tick.** Tick 5: `failing: [ociswap-precision 1/2]`, still confirmed,
   no live venue -> `gate: none`, "no reference", nothing sent, **no hold**. Tick 6: back, `gate: trade`,
   no hold, the same caution episode (no new alert).
3. **B: a venue coming back needs two good ticks.** Restarted with `--max-venue-fee 0.02`. B tick 1:
   DefiPlaza quoting, `returning: [defiplaza 1/2]`, logged but not priced (reference still 0.000752273,
   caution still on). Tick 2 (08:52:48): confirmed, `changed: {added: [defiplaza]}`, reference 0.000750485
   (-0.24%, DefiPlaza takes ~85% of the weight), **hold 900 s**, alert `venue-hold`; caution over (key
   cleared). During the hold the fee target fell to 40-47 but narrowing was blocked (fee stayed 80).
   Hold ended 09:07:48; tick 17 narrowed 80 -> 40 (`txid_tdx_2_1lfmhxf95f27k…`), tick 18 rebalanced at
   normal size (`txid_tdx_2_17fzxm5awlgca…`, add 46.787 XRD, cost 0.003573, spendable 0.01377 = half the
   allowance, window share 60%; gap 23.8 -> 0 bps).
4. **B-T1: one of two venues fails ONE tick.** Tick 20: `failing: [defiplaza 1/2]`, priced from
   Ociswap precision alone (0.000752273), gap 23.8 bps, outside the 20 bps band: **`gate: uncertain`,
   `NO REBALANCE`, no hold, not single-venue**. Tick 21: DefiPlaza back, no hold, pool already on
   target. (Side effect: the one-tick price jump entered the volatility history, so the fee target rose
   40 -> 43 -> 46 and tick 21 sent `operator_set_fee(46)` `txid_tdx_2_10gtl906pskzm…`.)
5. **B-T2: two failed ticks.** Tick 23: `failing 1/2`, no rebalance, no hold. Tick 24 (09:15:35):
   dropped, `changed: {removed: [defiplaza]}`, **hold 900 s starts** and **the caution starts** (alerts
   `venue-hold` and `single-venue` both delivered); fee widened during the hold 46 -> **97** (rule 47 +
   50; `txid_tdx_2_1w7dpln7w84zt…`). Ticks 25-27 held; the bot was stopped at 09:18:40 with the hold
   still running (so no cautious rebalance after a drop was seen in this run).

**Figures:** 35 ticks (8 + 27), 7 transactions sent (2 rebalances, 5 fee changes), all
`CommittedSuccess`; no preview failure, no tick error, no halt. Allowance spent 0.008123 (0.004550 +
0.003573). Then, with the bot stopped, one `--once --send --dead-band 10000 --base-fee 30
--vol-multiplier 0 --narrow-interval 0 --single-venue-fee-add 0` with a fresh state file set the fee
back to 30 (`txid_tdx_2_1tx2a6vwcxhqfwt80ns3xgczc4llrhzcfwx9typ5ktkeetmnz3v5q67je8c`). Network fees:
operator account 184.1792 -> 181.2734 XRD (2.906 XRD for 8). Alerts delivered: bot `start`/`stop` x2
each, `single-venue` x2, `venue-hold` x2; watcher `fee-change` (80 -> 40; the next three suppressed by
its rate limit). No `pool-drift`, `not-bot`, `large-spend` or `window-spend`.

**Pool left at** (state version 35046195): reserves 19,689.622 XRD / 15.714268 TEUR, price 0.00079810
TEUR per XRD, inventory 1,358.451 XRD / 1.081848 TEUR, **fee 30 bps, owner and operator pauses off**,
operator badge appointed, owner anchor 1250:1, allowance 0.02396 (stored). The bot at its defaults would
set the fee to 100 (clamped) on its first tick.

## Failure-path tests on the ledger (Stokenet, 23 Nov 2026, 10:23-11:25 UTC)

Real bot and watcher, real transactions on Stokenet; mainnet only read (venue quotes by preview). Bot
and watcher ran through `scripts/gateway-fault-proxy.ts` (127.0.0.1:18081 Stokenet, :18082 mainnet;
mode file switched mid-run), alerts to a local listener on 127.0.0.1:18931 (`/bot`, `/watch`). Drivers
`data/soak/run7-1.sh` ... `run7-5.sh`, logs `data/soak/run7-*.log`, phase times `data/soak/phases7.txt`,
balances `data/soak/balances7.txt`, alerts `data/soak/alerts7.jsonl` (cases 1-2) and `alerts8.jsonl`
(cases 3-5), watcher `data/soak/watch7.log` / `watch8.log`. TEST flags shorten intervals (`--interval`
20-30 s, `--anchor-recheck 60`, `--narrow-interval 60`, `--venue-hold 120`). All five pass; three
defects were found on ledger and fixed (fb747a5, cbbf2b9, 137bb51) and one more by reading the code
(b370d44).

**1. Halt after 3 failed sends (code fb747a5 + cbbf2b9; logs run7-1pre, run7-1, run7-1b). PASS.**
- First try, before fb747a5 (`run7-1pre`): proxy `submit-503` (submission refused, nothing reaches the
  network). Each failed submit was a THROWN tick error: alert `tick-errors` "3 in a row (backing off
  240 s)", never a halt. Fixed: a refused submission or failing status poll is a failed send
  (`trySubmitAndWait`).
- `run7-1` (10:27-10:34): `submit-503` -> SubmitFailed x3 -> alert `halt` "HALTED: 3 failed sends in a
  row" (10:28:10); halted ticks log `rebalance: halted after 3 failed transactions until ...`. Proxy
  `submit-reject` while halted: the first send after the halt ended was Rejected (10:30:45) and halted
  again at once, but its alert was SUPPRESSED by the rate limit. Proxy `pass`: the next send
  CommittedSuccess (10:33:21).
- Fixed in cbbf2b9 (the success that ends a halt clears the `halt` key; a failed or skipped rebalance
  counts as behind). `run7-1b` (10:35-10:41): halt (10:36:08, alerted) -> pass -> `halt-recovered`
  txid_tdx_2_157pxf6x... CommittedSuccess (10:37:54) -> `submit-503` again -> second halt ALERTED
  (10:39:20) -> pass -> recovered with txid_tdx_2_1f8e2zm7... (10:41:05).

**2. Gateway outage, full and partial (logs run7-2). PASS.**
- Stokenet Gateway `down-503`, `down-reset`, `down-hang` for one tick each (10:42-10:45): tick `error`
  events with back-off 40 -> 80 -> 160 s ("HTTP 503", "fetch failed", "aborted due to timeout"), no
  send, alert `tick-errors` after 3. Proxy `pass`: normal ticks resume (10:48:36), no send needed.
- MAINNET Gateway `down-503` (venue quotes fail; 10:49:19): first tick `gate none` (the confirmed venue
  failed once, not dropped), second tick the venue is dropped: `no reference (only 0 live venue(s))`,
  no rebalance, no fee change, alert `venue-hold` (10:50:01). Mainnet back: two good ticks, then
  `HOLD: venue-set hold (back ociswap-precision)` for the (TEST) 120 s, trading resumes 10:53:12. The
  restart of the hold by the venue coming back was NOT alerted: fixed in aa1d0da (see case 6).

**3. Owner restates the anchor mid-run (logs run7-3a.log, run7-3.log = re-run). PASS after a fix.**
Real venues, `--scale auto`, `--no-fee`, TEST `--anchor-recheck 60`, `--interval 30`.
- Owner `set_anchor 1250:1.03` (previewed, then sent: txid_tdx_2_1l2wkx95... at 10:58:03): the drill
  reads `operator_status` after it: **allowance 0** on ledger (was 0.00596 at the bot's last tick).
- The bot's 10:58:30 tick still had the old anchor (target 0.000800; recheck not due): **no rebalance**
  (ledger allowance 0.00042 = one epoch's refill, inside the 0.1 x budget reserve, spendable 0). At
  10:59:01 (the next recheck, 58 s after commit) `ownerAnchorChanged {from 1250:1, to 1250:1.03}`,
  alert `anchor-restated`; `--scale auto` re-calibrates to the new anchor, target 0.000824, gap 262 bps,
  nothing spendable: behind, alert `behind` after 10 ticks (11:01:40).
- Back to 1250:1 (txid_tdx_2_1fwr99z3... 11:01:12): allowance 0 again, picked up at 11:02:11, but the
  bot's `anchor-restated` alert was **suppressed** (same key within the hour). Fixed in 137bb51: every
  restatement alerts (forced). Re-run (11:04-11:10): 1250:1.03 txid_tdx_2_1uulhu4s... (allowance 0 after
  it), picked up 11:06:09; 1250:1 txid_tdx_2_1047400r... (allowance 0.000417 after it: an epoch's
  refill had already landed), picked up 11:09:16; **both alerted** (11:06:09, 11:09:16).
- Watcher: `anchor-restated` finding (severity info: logged, not alerted, as designed) for all four
  restatements, 20-30 s after each commit.

**4. "Behind" alert (log run7-4). PASS.** Reference `fixed:0.000805` x2, `--scale 1`, TEST `--base-fee
30`, default `--alert-behind-ticks 10`. The allowance was already spent (zeroed by the case 3
restatements: 0.00042 on ledger), so the bot was behind from tick 1 (gap 25.6 bps) and widened the fee
**30 -> 40** at once (`operator_set_fee(40)` txid_tdx_2_1gmz6pc34..., 11:11:14; watcher `fee-change` warn
alerted). Alice then sold 300 XRD (txid_tdx_2_17uff8r9v..., 11:11:49): pool 0.0007787, **gap 337.8 bps**,
spendable 0 (allowance 0.00083 < the 0.003 reserve). Tick 10 (11:15:53): alert `behind` "Bot BEHIND for
10 ticks: pool 0.000778698 vs target 0.000805 (gap 337.8 bps; allowance spent (or inside the reserve):
waiting for refill)"; later ticks suppressed by the rate limit (logged). Caveat: the behind count began
before the trade, because the allowance was empty; the trade only widened the gap.

**5. Operator limits changed by the owner and back (log run7-5). PASS.** Reference `fixed:0.000805` x2,
default base fee 100, TEST `--narrow-interval 60`. Tick 1: fee 40 -> **100** (the range's max).
Owner `set_operator_limits` moveBudgetBps 300 -> 150, maxFeeBps 100 -> 60 (txid_tdx_2_1jw8uf9lr...,
11:18:17; allowance 0.00083 -> 0.00125, NOT zeroed by a limits change). Next tick (11:18:51): log
`budget 0.015` (was 0.03), fee target clamped **100 -> 60** and sent (`operator_set_fee(60)`). Watcher
**`limits-change` alerted** 11:19:27 "move_budget_bps 300 -> 150, max_fee_bps 100 -> 60". Back to
300 / 100 (txid_tdx_2_1m8uew5n..., 11:21:56): next tick `budget 0.03`, fee 60 -> 100; watcher
`limits-change` **alerted again** (11:22:30) because of b370d44 (before it, the reversal would have
been suppressed by the per-rule limit; found by reading the code before this case ran, so the
unfixed behaviour was not seen on ledger). Notes: the contract does NOT clamp the current fee when
the owner lowers maxFeeBps: the pool charged 100 bps, above the new max of 60, until the bot's next tick (about half a minute later)
moved it. A smaller budget could not visibly shrink a move here: the allowance was inside the reserve
under both budgets, so no rebalance was possible either way; the budget change is seen in the log and
in the reserve (0.1 x budget) only.

**6. Venue-set hold restart alert (aa1d0da).** A hold restarted by another change (a venue dropped or
came back during a running hold) now alerts `venue-hold-restart`, its own key so the start's
`venue-hold` alert minutes earlier cannot suppress it; rate-limited like other keys, both keys cleared
when the hold ends. Unit-tested (`venueHoldAlert`); not re-run on ledger.

**Cost** (cases 3-5, 10:56-11:25): operator 178.6949 -> 176.1580 XRD (2 rebalances, 4 fee changes),
owner 8694.6303 -> 8691.6685 (4 anchor statements, 2 limits changes, 1 fee restore), alice
7201.0765 -> 7197.6096 (300 XRD sold and 0.236 TEUR sold back: 2.41 XRD lost to the curve and fees,
~1.06 XRD network fees). About 6.5 XRD of network fees in all.

**Pool left at** (state version 35079507): reserves 19,378.479 XRD / 15.557712 TEUR, price 0.00080284,
inventory 1,672.003 XRD / 1.238127 TEUR, **fee 30 bps, both pauses off**, operator badge 2 appointed,
anchor 1250:1, limits 300 bps / 72 epochs, caps 22000 / 17.6, floors 10000 / 8, fee range 10-100,
allowance 0.00167 (refilling).

## Soak 9 on Stokenet (23 Nov 2026, 12:45-13:35 UTC, code afd52e2): the review fixes and the CoinGecko brake

Real bot (`--send`) and watcher on the test pool, mainnet only read; alerts to a local listener on
127.0.0.1:18941 (`/bot`, `/watch`, `/hb`, `/guard`). A FRESH state file (`data/soak/s9-state.json`: the
identity check refuses every older one). Drivers `data/soak/run9.sh` and `run9b.sh`, logs
`data/soak/run9-A.log`, `run9-B2.log`, `run9-C2.log`, `watch9.log`, phases `phases9.txt`, alerts
`alerts9.jsonl`, heartbeat check `hb9.log`, balances `balances9.txt`. TEST flags: `--brake-sample 60` (the
brake's normal fills in 12 minutes, not an hour); phase B forces the brake. Bot ticks 60 s, watcher 30 s.

- **A (12:45-13:13, defaults):** start alert delivered (required with `--send`). Ticks 1-2: no target,
  "warming up: 1 (2) of 3 healthy reference readings" (median of 3, H-2). Tick 3: gap 35 bps, rebalance
  `removeB` 0.032344 TEUR (clipped to the single-venue spendable 0.00208; cost on ledger 0.0020833)
  `txid_tdx_2_1ypqpdnjtcl026fe5rvwt5q9x4y2st07peqv7rd7es7a75edeaqusryd8eh`, and fee 30 -> 100
  `txid_tdx_2_1jhgnljw4d9wwz8vdyndcp35jl0x7k4ck80v66fj4dlyv0g5u7k7sptugte`, both committed inside their
  2-epoch / 120 s validity. The watcher saw both: the fee as `fee-change` (warn, as designed), the
  rebalance with no finding: no `move-away` (it moved toward the reference), no `fee-outside-rule` (100 in
  its bounds 90-100), no `not-bot`. A second bot on the same pool with ANOTHER state file was refused by the
  lock (12:49:41, alerted `start-refused`). The heartbeat check found both processes alive. Alice sold 300
  XRD (`txid_tdx_2_1fkwt3l3...`): gap 295 bps, and the bot could not move: "no move fits", because an
  operator move's cost is measured from the ledger anchor (its own last price, 0.0008012) and the
  spendable part of the allowance (about 0.002) is less than that distance (3%). That is the contract's
  budget at work, as in the failure-path test 4: `behind` alerted after 10 ticks. The brake's normal filled
  at tick 13 (`mode: normal`, ratio 0.9771 to 0.9772, deviation under 0.01%: no brake).
- **The first driver's mistake:** it stopped the bot by signalling the `npx` wrapper, which does not pass
  SIGTERM on; the phase A bot ran on to 13:13, and the B and C bots were refused by its lock (13:03:54,
  13:13:30, alerted): the lock doing its job. A second driver signals the bot's own process. Alice's
  second sale (13:06, `txid_tdx_2_1te2hdzye...`) happened under the phase A bot (behind); the watcher
  alerted `pool-drift` 6.1% and its clearing later.
- **B2 (13:15-13:24, brake forced: TEST `--brake-min-readings 100 --brake-warmup-deviation 0.01`):** warm-up
  mode with parity as the normal, the ratio 0.9776 is 2.29% from it, over the 1% test threshold: every
  tick `BRAKE: ... no rebalance`, the fee step ran with narrowing blocked (fee stayed 100), ONE
  `coingecko-brake` alert for the episode (13:15:43), no pause. Alice bought back with 0.4 TEUR
  (`txid_tdx_2_1lhd0ffze...`): gap 610 -> 71 bps, still braked, no rebalance.
- **C2 (13:24-13:33, defaults again):** brake `normal` from the 37 ratios gathered since A, deviation under
  0.01%: released. Gap 71 bps over the 50 bps dead band but again "no move fits" (the ledger-anchor cost,
  as above): `behind`, no send.
- **After:** the heartbeat check with `--max-age 60`, 71 s after the bot stopped: `NO HEARTBEAT:
  owner-pool-bot (stokenet) last beat 71 s ago`, alerted; the watcher's alive. A copy of the state file cut
  short loaded from its `.bak` (`state-recovered`); with the `.bak` broken too the bot refused and alerted
  (`data/soak/corrupt9.log`). The watcher ran 94 ticks with no error; every bot transaction was in its
  sent log. No tick error, no race, no unresolved send, the mainnet Gateway 2-21 s behind (never over 120).
- **Pool left at** (state version 35113315): reserves 19,466.729 XRD / 15.463664 TEUR (price 0.00079437),
  inventory 1,672.003 XRD / 1.270471 TEUR, **fee 30 bps** (owner `set_fee 30`,
  `txid_tdx_2_1jqmxnkwferd56jver0u33gwx46mezx7lq6enstmszrqqzhnxkkqqeqzlm3`), **both pauses off**, operator
  badge 2. Cost: operator 175.5503 -> 174.6511 XRD (2 transactions), owner 0.38 XRD (the fee restore),
  alice 7197.61 -> 7107.77 XRD (600 XRD sold, 0.4 TEUR sold back, fees).

Not seen on ledger in this soak (unit-tested): a "Reserves moved" race, an unresolved send, a lagging
Gateway, the `move-away` and `fee-outside-rule` alerts, the brake in `normal` mode (the market did not
move 2% against CoinGecko), a rebalance after a trade (the ledger-anchor cost blocked it both times).

## Soak 10 on Stokenet (23 Nov 2026, 14:11-14:29 UTC, code 47dc8fe): partial moves after a trade

**Why Soak 9 logged "no move fits":** not a refused feasible move, and the allowance was not near zero
(0.0067 at tick 6, 0.0096 in C2). Every move toward the target cost more than the spendable part,
because the cost counts the distance from the ledger anchor (the price the operator's last move left):
at tick 6 (pool 0.000777, anchor 0.000801, target 0.0008) the cheapest possible move cost 0.0154 against
0.00054 spendable (single-venue caution, window room); in C2 (pool 0.000794) the cheapest cost 0.00428
against 0.0024. Reading the old search, though, showed a real gap: it bisected down from the full move
and gave up when the half-way move did not fit, so with spendable between 0.00428 and 0.0050 (the C2
half-way cost) it would also have said "no move fits" while a move to about 60% fitted. Fixed in 47dc8fe
(see "After a trade bigger than the budget"); unit tests cover both Soak 9 states.

Real bot (`--send`) and watcher, alerts to a local listener on 127.0.0.1:18941 only, fresh state
`data/soak/s10-state.json`. Driver `data/soak/run10.sh`, `bot10.sh`; logs `run10.log`, `run10-P1.log`,
`run10-P2.log`, `watch10.log`, `phases10.txt`, `alerts10.jsonl`, `balances10.txt`. TEST settings throughout:
`--interval 30 --no-fee` (fee stays 30 bps, dead band 15 bps); P1 also `--spend-fraction 0.69
--max-window-spend 1 --spend-window 120`; P2 `--spend-fraction 1 --reserve-fraction 0
--single-venue-size-factor 1 --max-window-spend 1 --spend-window 120` (all of the allowance spendable, so
the contract's budget is the only limit). Ledger cost = planned cost on every move.

| time | what | gap (bps) | allowance before -> after | cost | tx |
|---|---|---|---|---|---|
| 14:12-14:13 | defaults (spend fraction 0.3): cheapest move 0.00427 > spendable 0.0020 | 70.95 | 0.0133 | none | - |
| 14:13:56 | P1, the case the old search missed: spendable 0.00474 (cheapest 0.00427, half-way 0.0050) | 70.95 -> 23.40 | 0.01375 -> 0.00901 | 0.0047438 | `txid_tdx_2_1a60pzqktmn...` |
| 14:14:32 | window room 0.00213 binds: partial again (anchor now on the curve: cost = move) | 23.40 -> 2.09 | 0.00901 -> 0.00688 | 0.0021313 | `txid_tdx_2_1jtem5hg8pc...` |
| 14:16 | alice sells 100 XRD (`txid_tdx_2_19j2dz47yg...`): full correction ~0.0106 > allowance | 105.67 | | | |
| 14:16:27 | P2: largest partial that fits, all of the allowance | 105.67 -> 36.66 | 0.006875 -> 0 | 0.006875 | `txid_tdx_2_1x9007psge0...` |
| 14:18:38 | one epoch's refill (0.03/72) | 36.66 -> 32.48 | 0.000417 -> 0 | 0.000417 | `txid_tdx_2_1gyy6rkfr6q...` |
| 14:23:56 | the next epoch | 32.48 -> 28.31 | 0.000417 -> 0 | 0.000417 | `txid_tdx_2_137kl6fy42t...` |
| 14:28:42 | the next | 28.31 -> 24.13 | 0.000417 -> 0 | 0.000417 | `txid_tdx_2_1pvpwrdpwsc...` |

So after a trade bigger than the budget the bot moves as far as the budget allows at once, then about
4 bps per epoch (about 50 bps an hour at 300 bps per 72 epochs) as it refills: the 24 bps left would have
taken another ~30 minutes. The watcher alerted `large-spend` and `window-spend` (100% of the allowance in
one move: expected with these test settings), the bot `behind` after 10 ticks; no tick error. After the
bot stopped, alice bought back with 0.0186 TEUR (`txid_tdx_2_17tz6qe5es...`).

Final (Gateway, state version 35127483): reserves 19253.606531576128012879 XRD / 15.40293 TEUR (0.00080000,
about 1250:1), fee 30 bps, owner and operator pauses off, inventory 1961.9175 XRD / 1.270471 TEUR, ledger
anchor 19276.814489252643513903:15.38433. XRD: operator 174.651 -> 171.549 (3.10 XRD of fees for six
rebalances), alice 7107.773 -> 7029.923 (100 sold, about 22.7 bought back, fees).

## Not done, not tested, open

- **The on-ledger venues barely move, so the reference barely moves.** Between trades a pool's
  midpoint does not change at all: over the 92 minutes of Soak 4 the Ociswap basic and precision
  midpoints took 5 values each (a few trades, all downward, -0.5%), CaviarNine's one (until its hUSDC
  side was emptied by a trade at about 21:09 and it could no longer quote), and only DefiPlaza's (dropped)
  quotes drifted continuously. An executable quote is a real price, but on this pair it is often a price
  nobody is trading at: the bot will follow the pools, not the wider market. In the first soak CoinGecko
  moved 0.000786 -> 0.000810 while the pools stood still. Since 23 Nov the CoinGecko brake stops
  rebalancing when the reference moves more than 2% against CoinGecko relative to their usual ratio, but
  nothing makes a frozen venue follow the market: a venue that stands still while CoinGecko moves 2%
  brakes the bot (no rebalance) rather than steering it.
- **Thin venues come and go.** CaviarNine held under 1 hUSDC on its bid side all evening and from 21:09
  could not quote even 100 XRD; when it dropped out, the reference jumped from 0.000815 to 0.000799
  (-2.0%) because the remaining weight was mostly Ociswap basic. Now handled by the 1% fee rule (Ociswap
  basic is out, so the remaining venues agree to ~0.1%) and the 15-minute venue-set hold. Since 23 Nov
  a venue that blinks for ONE tick costs one no-rebalance tick, not a hold (two-tick confirmation); a
  venue failing two ticks in a row still costs 15 minutes. How often each happens on mainnet is not
  yet measured beyond the runs below.
- **4% headroom.** Before the fee rule the live venues sat 3.1% apart (Ociswap basic vs the other two).
  With Ociswap basic excluded the two low-fee venues were 0.115% apart when both were live (Soak 4);
  but from 21:09 CaviarNine could not quote at all and Ociswap precision has been the ONLY live venue
  (all of Soak 5): the reference then has nothing to be checked against, and if precision fails too
  there is no reference (no trade; pause after 10 minutes). On mainnet XRD/hUSDC that is one thin
  concentrated pool carrying the whole reference.
- **Depth weighting is from one pair of sizes.** A concentrated pool (CaviarNine) shows almost no
  impact up to the edge of its liquidity and then fails; the 10 bps impact floor stops it taking all
  the weight but is a judgement, not a measurement. Not tried: depth measured at several sizes, or from
  the pools' reserves near the price.
- **Gateway load:** each tick previews 16 swaps on the public mainnet Gateway (4 venues x 2 sizes x 2
  sides), plus the watcher's 16. No rate limiting was seen in Soak 4; a mainnet deployment should use its
  own Gateway or fewer venues.
- **Alerts** were only sent to a local listener on 127.0.0.1; no ntfy topic or other real URL has been
  tried.
- **Watcher**: the `not-bot` comparison reads the bot's sent log, so it only works where the watcher can
  read that file; run elsewhere, it needs the log shipped to it (not done; on mainnet the watcher refuses
  to start without it unless `--no-sent-log`). A log on the bot's host can be forged by a thief there.
  Fee and operator-pause changes are attributed by proof of the owner badge (a call through another
  component is the operator's); an owner acting through a subintent or an access controller whose
  manifest does not `create_proof_of_*` the badge would be reported as the operator (a false alarm, not a
  miss). The behavioural rules use the watcher's reference at the tick that sees the move (up to one
  interval later), not the one at the move. Drift checks need the venues to agree. `limits-change` was seen on ledger on 23 Nov (case 5 of
  the failure-path tests).
- The bot's own sends are recorded before submission; a send whose submission then fails leaves a
  txid in the log that never reaches the ledger (harmless).
- Not tested on ledger: a swap racing a rebalance ("Reserves moved", now outside the halt), a send left
  unresolved past its validity (the `pending` path), a Gateway lag beyond 120 s, and the `move-away` and
  `fee-outside-rule` alerts (no thief was simulated); the `venue-hold-restart` alert. All unit-tested.
  A Gateway outage, the 3-failure halt, an anchor restatement, the `behind` alert and a limits change
  were run on ledger on 23 Nov (see "Failure-path tests on the ledger").
- Only a price from the full confirmed set enters the volatility history: `trade` ticks and `hold`
  ticks (in a hold the confirmed set is the new, stable one), never `uncertain`, `disagree` or `none`
  ticks, nor a hold tick on which another confirmed venue failed. (In Soak 6, before this rule, a
  one-tick 0.24% jump on an uncertain tick raised the fee target by 6 bps and cost one fee transaction.)
- No cautious (halved) rebalance AFTER a drop to one venue has been seen on ledger: the drop starts
  the 15-minute hold, and Soak 6 stopped inside it. The halved caps are unit-tested and were seen on
  the first tick of Soak 6 (spendable a quarter of the allowance, window 30%), where the move fitted.
- Volatility is measured from the bot's own samples, so after a restart with an old or empty history
  it starts from zero for the window.
- Mainnet: `--send` refused in code (the allow-list and the package list are empty). No mainnet pool
  exists; the bot has never seen one. The review's other suggestions not taken: a minimum depth per venue
  below which it cannot be the only venue, and `minVenues` above 1 (H-2 points 4-5; only one venue
  qualifies today, so either would stop the bot); spends in the rolling window are taken from the bot's
  own committed (and late-committed) sends, not re-read from the pool's events.
- Profit sweeping (free proportional decreases) is not done.
