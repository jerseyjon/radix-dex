# OwnerPool market-making bot (first version, Stokenet only)

`scripts/owner-pool-bot.ts` keeps a split OwnerPool's price near a reference price using only the
OPERATOR (hot) key. Its decisions are pure functions in `packages/core/src/ownerpool-bot.ts`, tested in
`packages/core/test/ownerpool-bot.test.ts`. The design it works inside is
`docs/review-2026-11-21/owner-pool-split-design.md`; the Stokenet pool is described in
`docs/review-2026-11-21/owner-pool-split-stokenet.md`.

It treats the contract's limits (budget per window, caps, floors, fee range) as a backstop it should
never reach: it plans every move with the exact TypeScript copy of the contract's checks and spends
only part of what the contract would allow.

## What it does, each tick (default every 60 s)

1. **Reads the reference price** from several independent sources, and takes the median of the fresh
   ones (see "Reference price" below).
2. **Reads the pool** from the ledger, vault by vault (reserves, inventory, fee, both pauses, limits,
   stored allowance, the anchor on ledger), and the contract's own `operator_status` by preview. The
   allowance is computed locally too, and the two are compared on every tick.
3. **Maps the reference onto the pool** (`target = reference * scale`).
4. **Checks the owner's anchor.** If the target is more than 5% from the anchor the OWNER stated, the
   bot stops following, sets the operator pause, and logs that the owner must restate the anchor.
5. **Pause control.** If the reference stays unusable for 10 minutes, it sets the operator pause; it
   clears a pause only if it set it itself, after 15 minutes of a healthy reference.
6. **Rebalance.** If the pool price is further from the target than the dead band, it moves the curve
   toward the target by a one-sided move between inventory and reserves, as large as fits in half of
   the allowance (keeping a reserve), never past a cap or floor.
7. **Fee.** It sets the fee from a simple rule (base fee, widened by volatility and when it is behind),
   with hysteresis.

Every transaction is built by code, previewed in the same tick (the exact notarised transaction, real
signature, no free credit) and sent only if the preview succeeded. One JSON line is logged per tick.

## How to run it

```
# dry run (default): reads, decides, previews, logs; sends nothing
npx tsx scripts/owner-pool-bot.ts --once
npx tsx scripts/owner-pool-bot.ts                 # keeps running; Ctrl-C or SIGTERM stops it after the current tick

# really send, on Stokenet only
npx tsx scripts/owner-pool-bot.ts --send

# a fixed reference already in pool units (tests and drills)
npx tsx scripts/owner-pool-bot.ts --once --scale 1 --sources fixed:0.0008,fixed:0.0008
# a reference kept in a file: {"price": 0.0008, "at": "2026-11-22T17:00:00Z"} or a bare number (the file's mtime is its time)
npx tsx scripts/owner-pool-bot.ts --scale 1 --sources file:data/ref.json,file:data/ref2.json
```

It needs the operator key in `data/stokenet-owner-pool-operator.key` (`--key`), the operator badge
in that account (`--badge`), and the pool (`--pool`); the defaults are the Stokenet test pool's.
The key is read at start and never printed. The bot has no owner key.

`--send` on any network other than Stokenet is refused in code, whatever the other flags say. Running
it for a mainnet pool needs the owner's explicit go-ahead and a code change.

State lives in `data/owner-pool-bot-state.json` (`--state`; `data/` is gitignored): the reference
history (6 h, for volatility), the scale calibration, the target depth, the time of the last fee
change, the send times of the last hour, the pause bookkeeping, and the failure counter. A lock file
next to it stops a second bot from running on the same state.

## Reference price

Sources (`--sources`, comma separated):

| Name | What | Where | Notes |
|---|---|---|---|
| `ociswap` | Ociswap XRD/hUSDC BasicPool `component_rdx1cpqg9y55…pfh5fr`: hUSDC reserve / XRD reserve | mainnet ledger (Gateway, read only) | constant product, so this is the curve's mid; time = the ledger state read |
| `caviarnine` | CaviarNine XRD/hUSDC QuantaSwap `component_rdx1cqelumvm…tyj5`: geometric mean of a 100 XRD sell and a 0.08 hUSDC sell, previewed through the project's `Quoter` | mainnet ledger (free previews, nothing signed) | the venue fee cancels; its active bin is ~5% wide, so the bin bounds alone are too coarse |
| `coingecko` | CoinGecko simple price, XRD in USD | off ledger, keyless | time = CoinGecko's own `last_updated_at` |
| `fixed:<price>` | a constant, always fresh | | tests and drills |
| `file:<path>` | a price in a file | | tests, or a price fed by another process |

All three real sources are in dollars (hUSDC, USD): mixing euro and dollar sources would read as a
permanent ~9% disagreement.

**Health.** A sample counts only if it has no error, is positive, is at most 300 s old and at most a
minute in the future. The reference is refused when fewer than 2 samples count, or when the highest
and lowest differ by more than 2% (`max/min - 1`). A refused reference means no rebalance and no fee
change; if it lasts 10 minutes the bot sets the operator pause.

**Mapping onto the pool (`--scale`).** Prices are always token B per token A (the pool's
`reserveB / reserveA`; TEUR per XRD here, 0.0008 at the 1250:1 anchor). The pool aims at
`reference * scale`. TEUR is a test token with no market, so by default (`--scale auto`) the scale is
calibrated ONCE: the first healthy reference is mapped to the owner's anchor price, and the pool then
follows the reference's relative moves (XRD up 1% in dollars, the pool's TEUR-per-XRD price up 1%).
The calibration is kept in the state file and redone only when `--owner-anchor` changes. On mainnet,
against a real pair whose sources quote the same unit, the scale is 1 (`--scale 1`). Pass a number to
fix it.

## Rules and defaults (each with its reason)

| Setting (flag) | Default | Why |
|---|---|---|
| tick (`--interval`) | 60 s | Stokenet epochs are ~10 min and the allowance refills per epoch; a minute is fast enough to follow and cheap on Gateway calls |
| sources | ociswap, caviarnine, coingecko | two independent on-ledger venues plus one off-ledger aggregator; no single venue can set the price |
| fresh sources needed (`--min-sources`) | 2 | one source alone can be wrong or manipulated; two that agree are a check |
| max sample age (`--max-age`) | 300 s | CoinGecko updates every 1-5 minutes; older than that is not "now" |
| max disagreement (`--max-disagreement`) | 2% | larger than ordinary venue spreads on liquid pairs, smaller than the moves that matter; a split this wide means one source is wrong and the bot cannot tell which |
| pause after (`--pause-after`) | 600 s | sources blink; ten minutes of no reference is no longer a blink |
| resume after (`--resume-after`) | 900 s | reopen only after the reference has been healthy for longer than it took to pause |
| dead band (`--dead-band`) | half the pool's current fee | inside half the fee an arbitrageur cannot profit from the gap, so moving costs budget and gas for nothing; and a wider fee (volatile market) widens the band by itself |
| spend fraction (`--spend-fraction`) | 50% of the allowance available now | the design's alerts key on moves that spend MOST of the allowance (that is what a thief does); spending at most half keeps the bot's moves distinguishable from theft, and leaves room for the next tick |
| reserve (`--reserve-fraction`) | 10% of one full budget never spent | an always-available slice for a sudden move |
| minimum move (`--min-move`) | 3 bps of price | smaller moves are not worth a transaction (~0.5 XRD each) |
| side (`--side`) | balanced | removal (reserves to inventory) costs only its price move, an addition about 1.5x (price plus depth); `balanced` removes while the curve is deeper than its depth at the bot's first start and adds from inventory while it is shallower, so the curve neither shrinks to its floors nor fills to its caps over time. Whichever candidate closes more of the gap wins; the preferred one wins within 1 bps |
| target depth (`--target-depth`) | sqrt(Ra*Rb) at first start (state file) | the curve size the owner set up |
| max anchor distance (`--max-anchor-distance`) | 5% from the OWNER's anchor | the design's loss bound grows with how far the curve may be from a stated anchor (D); 5% is the distance the design's tables treat as a stale anchor. Beyond it the owner, not the bot, decides the price |
| anchor resume (`--anchor-resume-factor`) | 0.8 (within 4%) | hysteresis, so the bot does not pause and resume on every tick near the boundary |
| owner anchor (`--owner-anchor`) | 1250:1 | the anchor stated at appointment; see "What it cannot do" |
| base fee (`--base-fee`) | 30 bps | the pool's fee as set up; a calm-market spread on a thin pair |
| volatility multiplier (`--vol-multiplier`) | 2 | the fee should cover about a two-sigma move of the reference between two ticks (the curve is stale for up to one tick) |
| volatility window (`--vol-window`) | 1 h | recent enough to react, long enough to be a measure |
| behind (`--behind-fee`) | +10 bps | when the bot cannot close the gap (allowance spent, cap reached, a failed preview), the curve is knowingly off: charge more for trading against it |
| min fee change (`--min-fee-change`) | 5 bps | each change is a transaction; smaller changes do not matter |
| widen after (`--widen-interval`) | 120 s since the last change | widening protects the pool: soon |
| narrow after (`--narrow-interval`) | 900 s since the last change | calm must last before the spread comes back in |
| fee range | the owner's [min, max] (10-100 bps on Stokenet) | the contract refuses anything else; with a single-value range the bot never touches the fee |
| tx cap (`--max-tx-per-hour`) | 12 | about three times what a busy hour needs (one rebalance and a fee change every 15 min); a bug cannot burn fees or budget fast |
| failure halt (`--max-failures`, `--halt`) | 3 failed sends in a row: no sends for 1 h | a contract or ledger problem should stop it, not loop it |
| fee lock (`--fee-lock`) | 5 XRD | previews measure 0.37-0.51 XRD per bot transaction |
| `--no-fee` | off | to run the bot without fee control |

Gateway errors: the tick fails, is logged, and the next one waits `interval * 2^errors`, at most 15
minutes. A tick that is sending finishes before a stop signal is obeyed.

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

Spendable = min(allowance x 0.5, allowance - 0.1 x budget). The bot is "behind" when the move it can
afford leaves the pool outside the dead band.

Remember (design doc): after an operator move the anchor ON LEDGER becomes the new price, and the
next move costs max(distance from the current price, distance from that anchor). That is why the bot
checks its own distance against the OWNER's stated anchor, not the ledger's.

## What it cannot do (owner only)

- **Restate the anchor** (`set_anchor`), or appoint/replace/revoke the operator (`set_operator`).
  When the market moves more than 5% from the owner's anchor the bot pauses and says so; the owner
  restates the anchor (which zeroes the operator's allowance: it refills over one window, ~12 h on
  Stokenet at 72 epochs of ~10 min) and then updates `--owner-anchor`.
- Deposit or withdraw reserves or inventory, `owner_rebalance`, set the limits, set the fee outside
  the operator range, or clear the OWNER's pause. While the owner's pause is on the bot sends nothing.
- Clear an operator pause it did not set (the owner may set it too).
- Take profit out: swap fees accrue to the reserves; the bot's removals move tokens to the inventory,
  which only the owner can withdraw.

## Failure modes

| What happens | What the bot does |
|---|---|
| a source errors, times out (30 s) or goes stale | it does not count; fewer than 2 left: no action; 10 min of that: operator pause |
| sources disagree by more than 2% | no action; 10 min: operator pause |
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
| SIGINT / SIGTERM | finishes the current tick, saves state, exits |
| a second copy started on the same state file | refused by the lock |

## Proven on Stokenet (22 Nov 2026)

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

## Not done, not tested, open

- **Real sources disagree today.** On 22 Nov 2026 the three mainnet sources read XRD at $0.000831
  (Ociswap pool), $0.000854 (CaviarNine) and $0.000800 (CoinGecko): 6.8% apart. With the 2% bound the
  bot would not act on them and would pause after 10 minutes. The XRD/hUSDC pools are thin (about
  $1,000-1,300 of liquidity each). Which sources to trust on mainnet, and how wide a disagreement to
  accept, is the owner's call. Not tried: DefiPlaza, Ociswap's precision pool, an Ociswap API price,
  a second aggregator.
- The live runs used `fixed` references (`--scale 1`); the real sources and `--scale auto` were run in
  dry-run only. The calibration has not been exercised over a real price move.
- No long soak: the loop ran for about a minute on Stokenet. Not tested: hours of running, Gateway
  outages, a real stale source, the 3-failure halt on ledger (unit logic only), a swap racing a
  rebalance (the guard is the contract's, proven earlier).
- The bot does not read the owner's anchor from the ledger (the last `OwnerPoolAnchorEvent`): it is
  configured (`--owner-anchor`). If the owner restates the anchor and forgets the flag, the bot
  measures distance from the old one.
- Volatility is measured from the bot's own samples, so after a restart with an old or empty history
  it starts from zero for the window.
- No alerting: the log is JSON lines on stdout; nothing pushes a notification (the design's
  monitoring recommendations are not implemented here).
- Mainnet: refused in code. No mainnet pool exists; the bot has never seen one.
- Profit sweeping (free proportional decreases) is not done.
