# OwnerPool market-making bot (Stokenet only)

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
   than 15% from the reference. If the SET of live venues changed since the last tick, it starts a
   15-minute hold (no rebalance; see "Venue-set hold").
2. **Reads the pool** from the ledger, vault by vault (reserves, inventory, fee, both pauses, limits,
   stored allowance, the anchor on ledger), and the contract's own `operator_status` by preview. The
   allowance is computed locally too, and the two are compared on every tick.
3. **Maps the reference onto the pool** (`target = reference * scale`).
4. **Checks the owner's anchor.** The anchor the OWNER last stated is read from the ledger (see "The
   owner's anchor" below). If the target is more than 5% from it, the bot stops following, sets the
   operator pause, logs and alerts that the owner must restate the anchor. If the owner's anchor cannot
   be determined, the bot does not rebalance (or change the fee).
5. **Pause control.** If the reference stays unusable (no live venue, or the venues more than 4% apart)
   for 10 minutes, it sets the operator pause; it clears a pause only if it set it itself, after 15
   minutes of a healthy reference.
6. **Hold and widen.** While the live venues disagree by more than 4% it does NOT rebalance (it holds
   its position) and widens the fee by half the disagreement, inside the owner's operator fee range.
   While a venue-set hold runs it does not rebalance either; the fee may widen, not narrow.
7. **Rebalance.** If the pool price is further from the target than the dead band, it moves the curve
   toward the target by a one-sided move between inventory and reserves, as large as fits in half of
   the allowance (keeping a reserve) AND inside the rolling cap (at most 60% of the allowance in any 10
   minutes), never past a cap or floor.
8. **Fee.** It sets the fee from a simple rule (base fee 100 bps, widened by volatility and when it is
   behind), clamped to the owner's operator range, with hysteresis.

Every transaction is built by code, previewed in the same tick (the exact notarised transaction, real
signature, no free credit) and sent only if the preview succeeded. Its intent hash is appended to the
sent log (`data/owner-pool-bot-sent.jsonl`, `--sent-log`) BEFORE it is submitted, so the watcher can
tell the bot's operator actions from anyone else's. One JSON line is logged per tick.

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

# really send, on Stokenet only
npx tsx scripts/owner-pool-bot.ts --send

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

`--send` on any network other than Stokenet is refused in code, whatever the other flags say. Running
it for a mainnet pool needs the owner's explicit go-ahead and a code change.

State lives in `data/owner-pool-bot-state.json` (`--state`; `data/` is gitignored): the reference
history (6 h, for volatility), the scale calibration, the target depth, the time of the last fee
change, the send times of the last hour, the pause bookkeeping, the failure counter, the owner's
anchor statement read from the ledger, the "behind" counter, the alert rate limiter, and the live
venue set with any running venue-set hold. A lock file
next to it stops a second bot from running on the same state.

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

### Venue-set hold

Owner's decision, 22 Nov 2026, after CaviarNine ran out of hUSDC at 21:09, dropped out, and the
reference jumped 2% with no market move. **When the set of live venues changes** (a venue drops out or
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
- **Alert** `venue-hold` once when a hold starts (rate-limited like the other keys); a restart of a
  running hold is not a new start, and the key is cleared when the hold ends, so the next hold alerts.
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
| target depth (`--target-depth`) | sqrt(Ra*Rb) at first start (state file) | the curve size the owner set up |
| max anchor distance (`--max-anchor-distance`) | 5% from the OWNER's anchor | the design's loss bound grows with how far the curve may be from a stated anchor (D); 5% is the distance the design's tables treat as a stale anchor. Beyond it the owner, not the bot, decides the price |
| anchor resume (`--anchor-resume-factor`) | 0.8 (within 4%) | hysteresis, so the bot does not pause and resume on every tick near the boundary |
| owner anchor | the ledger's last `OwnerPoolAnchorEvent` | the owner's own statement, not a copy that can go stale; `--owner-anchor A:B` only as a fallback (see above) |
| anchor re-check (`--anchor-recheck`) | 300 s | a restatement is noticed within five minutes; incremental, so cheap |
| alert URL (`--alert-url`, env `OWNER_POOL_BOT_ALERT_URL`) | none: nothing sent | see "Alerts" |
| alert interval (`--alert-interval`) | 3600 s per condition | one message per problem per hour is noticed without flooding a phone |
| behind alert (`--alert-behind-ticks`) | 10 ticks in a row | ten minutes of not catching up is no longer noise |
| tick-error alert (`--alert-error-ticks`) | 3 in a row | the back-off has started |
| sent log (`--sent-log`) | `data/owner-pool-bot-sent.jsonl` | the watcher compares operator actions on ledger with it |
| base fee (`--base-fee`) | 100 bps | the owner's decision: the on-ledger venues quote 0.2-6.5% round trips at 1,000 XRD, so 30 bps left the pool far the cheapest place to trade against a possibly stale price. On mainnet the owner sets an operator fee range of about 50-200 bps at pool set-up. The Stokenet test pool's range is 10-100 bps, so there the fee sits at 100 (clamped; see below) |
| volatility multiplier (`--vol-multiplier`) | 2 | the fee should cover about a two-sigma move of the reference between two ticks (the curve is stale for up to one tick) |
| volatility window (`--vol-window`) | 1 h | recent enough to react, long enough to be a measure |
| behind (`--behind-fee`) | +10 bps | when the bot cannot close the gap (allowance spent, cap reached, a failed preview), the curve is knowingly off: charge more for trading against it |
| min fee change (`--min-fee-change`) | 5 bps | each change is a transaction; smaller changes do not matter |
| widen after (`--widen-interval`) | 120 s since the last change | widening protects the pool: soon |
| narrow after (`--narrow-interval`) | 900 s since the last change | calm must last before the spread comes back in |
| fee range | the owner's [min, max] (10-100 bps on Stokenet) | the contract refuses anything else; with a single-value range the bot never touches the fee. The rule's target is clamped into the range and the log line says `clamped: max of the operator range ...`; once the fee IS the clamped target nothing is attempted (no tick after tick of refused changes), and a change that failed (preview refused or send failed) is not retried for the same fee within `--narrow-interval` |
| tx cap (`--max-tx-per-hour`) | 12 | about three times what a busy hour needs (one rebalance and a fee change every 15 min); a bug cannot burn fees or budget fast |
| failure halt (`--max-failures`, `--halt`) | 3 failed sends in a row: no sends for 1 h | a contract or ledger problem should stop it, not loop it |
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
of it that fits is found by bisection. Amounts are rounded toward zero to the token's places. A
returned move has therefore already passed every check the contract will make; the preview then
confirms it on ledger state, and the `expected` reserves guard makes it fail rather than act if a
swap lands between the read and the commit.

Spendable = min(allowance x 0.5, allowance - 0.1 x budget, rolling-window room). The bot is "behind"
when the move it can afford leaves the pool outside the dead band. Its own spends (the cost in the
ledger's `OwnerPoolRebalanceEvent`, else the planned cost) are kept in the state file for the window.

Remember (design doc): after an operator move the anchor ON LEDGER becomes the new price, and the
next move costs max(distance from the current price, distance from that anchor). That is why the bot
checks its own distance against the OWNER's stated anchor, not the ledger's.

## Alerts

Optional: `--alert-url <url>` or env `OWNER_POOL_BOT_ALERT_URL`. Each alert is a plain HTTP POST of a
short text body (at most 1,000 characters, `content-type: text/plain`), so an ntfy topic URL
(`https://ntfy.sh/<topic>`) works as is. Nothing is sent when neither is set. The URL is never logged
(the start line shows `alertUrl: "(set)"`); each tick's log line lists the alerts raised and whether
each was sent, suppressed by the rate limit, or failed. Sending never blocks or breaks a tick (10 s
timeout); an alert that could not be delivered is retried on the next occurrence.

| Key | When |
|---|---|
| `start`, `stop` | the loop starts / stops (not with `--once`). NEVER rate-limited: every restart, a crash loop included, is reported |
| `pool-pause`, `pool-unpause` | the bot set or cleared the operator pause (with the txid, or "previewed only" in a dry run) |
| `anchor-stop` | the reference is beyond `--max-anchor-distance` from the owner's anchor: the owner must restate it |
| `anchor-restated` | the ledger shows a new owner anchor statement |
| `anchor-unknown` | the owner's anchor cannot be read from the ledger (and whether the flag is used instead) |
| `halt` | `--max-failures` sends failed in a row: sending stops for `--halt` seconds |
| `reference-unhealthy` | the on-ledger reference has been unusable (no live venue, or the venues more than 4% apart) for longer than `--pause-after` |
| `venue-hold` | the set of live venues changed: holding position for `--venue-hold` (which venues dropped / came back) |
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
key, signs nothing, and does not depend on the bot: run it where the operator key is not. Rules in
`packages/core/src/ownerpool-watch.ts`, tested in `packages/core/test/ownerpool-watch.test.ts`.

```
npx tsx scripts/owner-pool-watch.ts                       # live, from now; one tick a minute
npx tsx scripts/owner-pool-watch.ts --once --replay       # the pool's whole history; prints findings, sends no alerts
```

| Rule | Severity | Fires when | Default |
|---|---|---|---|
| `large-spend` | alert | one operator `rebalance` spends more than this share of the allowance available before it (cost / (cost + allowance after), both from the event) | 60% (`--max-spend-share`); the bot never spends more than 50% |
| `window-spend` | alert | operator moves within any 10 minutes (event times), two or more, spent more than this share of the allowance available when the first was made (sum of costs / (sum + allowance after the last)) | 60% (`--max-window-spend`, `--spend-window`), the bot's own cap. Catches a thief copying the bot's "half, then half": on the Stokenet history it flags the first soak's 18:58-18:59 pair (74.3%) |
| `spend-24h` | alert | operator budget spent in the last 24 h (event times) above this many full budgets | 1 budget (`--max-spend-24h`); up to 2 can refill in 24 h at 72 epochs |
| `operator-change` | alert | `OwnerPoolOperatorEvent` names a different operator (appointed, replaced, revoked) | |
| `limits-change` | alert | `OwnerPoolOperatorEvent` carries operator limits that differ from the last known (`set_operator_limits`, or a re-appointment with new limits): lists each changed field | baseline from the pool's state at a live start |
| `not-bot` | alert | an operator action (operator `rebalance`, `operator_set_fee`, `set_operator_paused` proved with the operator badge) whose intent hash is not in the bot's sent log; `info` for actions older than the log | `--bot-sent-log` |
| `fee-change` | warn (operator) / info (owner) | the fee in `OwnerPoolConfigEvent` changed | |
| `pause-change` | warn | the owner's or the operator's pause flag changed | |
| `anchor-restated` | info | `OwnerPoolAnchorEvent` | |
| `anchor-drift` | warn | the owner's anchor is this far from the reference (mapped onto the pool) | 5% (`--max-anchor-drift`) |
| `pool-drift` | warn | the pool's price is this far from the reference | 3% (`--max-pool-drift`) |

Who called a method is read from the transaction's manifest (the methods it calls on the pool and the
badges it names); the operator badge in force is the last one the pool announced. The reference is
the bot's (on-ledger venues, `--venues`, `--quote-size`; drift is checked only while they agree); with `--scale auto` the watcher takes the bot's calibration from
`--bot-state` when it matches the owner's anchor, else calibrates itself to the anchor. Its checkpoint
(next state version, last config, the operator limits, the 24 h spends, the owner's anchor) is `data/owner-pool-watch-state.json`.
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

## Not done, not tested, open

- **The on-ledger venues barely move, so the reference barely moves.** Between trades a pool's
  midpoint does not change at all: over the 92 minutes of Soak 4 the Ociswap basic and precision
  midpoints took 5 values each (a few trades, all downward, -0.5%), CaviarNine's one (until its hUSDC
  side was emptied by a trade at about 21:09 and it could no longer quote), and only DefiPlaza's (dropped)
  quotes drifted continuously. An executable quote is a real price, but on this pair it is often a price
  nobody is trading at: the bot will follow the pools, not the wider market. In the first soak CoinGecko
  moved 0.000786 -> 0.000810 while the pools stood still. The CoinGecko watch alert (15%) is the only
  signal that the venues have gone stale relative to the market. Whether that is acceptable for mainnet
  is the owner's call.
- **Thin venues come and go.** CaviarNine held under 1 hUSDC on its bid side all evening and from 21:09
  could not quote even 100 XRD; when it dropped out, the reference jumped from 0.000815 to 0.000799
  (-2.0%) because the remaining weight was mostly Ociswap basic. Now handled by the 1% fee rule (Ociswap
  basic is out, so the remaining venues agree to ~0.1%) and the 15-minute venue-set hold. A venue that
  blinks (one failed quote) costs a 15-minute hold each time; how often that happens on mainnet is not
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
- **Watcher**: the `not-bot` comparison reads the bot's sent log from the same disk, so it only works
  where the watcher can read that file; run elsewhere, it needs the log shipped to it (not done). It
  classifies callers from the root manifest (methods called on the pool, badges named): a call made
  through another component, or from a subintent, is seen by its events (rebalance, config) but not
  attributed. Drift checks need the venues to agree. `limits-change` is unit-tested and checked against
  the real event format, but no limits change happened on ledger during the run.
- The bot's own sends are recorded before submission; a send whose submission then fails leaves a
  txid in the log that never reaches the ledger (harmless).
- Not tested on ledger: a Gateway outage, the 3-failure halt, an owner anchor restatement while the bot
  runs, the `behind` alert, a swap racing a rebalance. The first four are unit-tested as the pure
  pieces the bot script uses (`tickOutcome`, `recordSendOutcome`/`sendHalted`, `resolveOwnerAnchor` +
  allowance zero, `behindUpdate`), not as a full tick with a fake Gateway.
- Volatility is measured from the bot's own samples, so after a restart with an old or empty history
  it starts from zero for the window.
- Mainnet: refused in code. No mainnet pool exists; the bot has never seen one.
- Profit sweeping (free proportional decreases) is not done.
