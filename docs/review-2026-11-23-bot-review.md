# OwnerPool bot: independent review (23 Nov 2026)

Scope: the off-chain code that operates a split `OwnerPool` with the operator (hot) key:
`packages/core/src/ownerpool-bot.ts`, `ownerpool-ops.ts`, `ownerpool-events.ts`, `ownerpool-watch.ts`,
`alerts.ts`, `tx.ts`, `gateway.ts` (preview path), `scripts/owner-pool-bot.ts`, `owner-pool-sources.ts`,
`owner-pool-watch.ts`, `owner-pool-venues.ts`, the `ownerpool-*` tests, checked against
`docs/owner-pool-bot.md`. The contract (`scrypto/owner-pool/src/lib.rs`) was read for what the operator
badge can and cannot do and was not re-audited. Branch `pool-split-stokenet` at `8bcac81`.

Method: I read the code, ran `npm test` (249 pass) and `npm run typecheck` (clean), wrote throwaway tests
outside the repo for the main scenarios below (all reproduced), and read the live mainnet venues once,
read-only (`scripts/owner-pool-venues.ts --sizes 1000,5000`, 12:07 UTC). No transaction was sent and
no tracked file was changed.

## Verdict

**Not safe to run on mainnet with real funds as it stands.** The transaction path itself is sound: amounts,
signs, rounding, the exact copy of the contract's checks, preview-then-send of the same bytes, and the
`expected`-reserves guard all hold up. The risk is in what the bot follows and in what is configured by
default:

1. `--scale auto` is the default, and on mainnet it builds a lasting price error into every target. Neither
   the anchor stop nor the watcher can see that error (C-1).
2. Nothing checks that the pool's pair is the venues' pair, in the venues' orientation (H-1).
3. On mainnet today the reference is ONE thin venue, about $134 of liquidity a side. Moving it costs cents
   (H-2).
4. The state file is not tied to a network or pool, and its default path is shared with Stokenet (H-3).
5. The watcher's strongest signal of a stolen key (`not-bot`) is either switched off or can be forged in
   the deployment the docs recommend (H-4).

It becomes reasonable to run on mainnet with a **small, owner-limited pool** after these fixes: C-1, H-1,
H-3 and the mainnet-guard changes below (all mechanical); H-2 (an off-ledger veto, and an anchor stop that
needs two ticks); H-4 (a behavioural theft rule plus a sent log that is required); and M-2, M-5 and M-6.
The contract's budget still bounds the worst case: about one `move_budget_bps` of price path per
window. So the residual risk is economic and roughly proportional to the size of the pool, but only once
the bot is no longer pushing toward a wrong target.

## Findings

### C-1 Critical: `--scale auto` (the default) builds a persistent price error into every mainnet target
`scripts/owner-pool-bot.ts:135` (default `auto`), `:452-459` (calibration); watcher `scripts/owner-pool-watch.ts:62, 174-186`.

With `auto`, the first healthy reference after each owner anchor statement is mapped onto the owner's
anchor: `scale = anchor / reference`. From then on, `target = reference * scale`. On a real pair the
correct scale is exactly 1, and anything else is a fixed error that lasts until the next restatement.

**Scenario A (stale anchor).** The owner stated 0.00075 hUSDC/XRD and the market has since moved 4%. On a
fresh state file (or after a restatement), the bot calibrates so that the current market maps onto the
old anchor. It then keeps the pool pinned at the anchor, 4% off the market.

**Scenario B (manipulated reference).** An attacker watches for the owner's `set_anchor`. The bot reads it
up to 300 s later (`--anchor-recheck`). In that window the attacker moves the single live venue by 4.9%
(H-2: cents of cost), and the bot calibrates on it. Throwaway test result: with the attacker gone, the
target sits 4.9% from the market. `anchorCheck` passes, because it measures the same biased target
against the anchor. The first rebalance spends 0.015 of a 0.03 budget moving the pool 1.5% **away** from
the market.

The watcher's `--scale auto` copies the bot's calibration, so `pool-drift` is blind to the error.
Calibration also reruns whenever the anchor source flips between the ledger and `--owner-anchor` (when
the two differ), each time re-mapping the current reference onto an anchor.

**Loss estimate (pool value V, fee f, error b).** Arbitrage pulls the curve back toward the market and the
bot pushes it out again, up to the contract budget, so the pool loses roughly V(b-f)²/4 per window. At
b = 4.9%, f = 1%, V = $10k and a 6-hour window: about $4 per window, about $15/day, about 0.15% of the pool
per day. All one-sided organic flow also gets the better price.

**Fix:** on mainnet, refuse `--scale` other than `1` (remove `auto` from the mainnet path entirely), and do
the same in the watcher. Keep `auto` for the TEUR test pool only.

### H-1 High: no check that the operated pool is XRD/hUSDC in the venues' orientation
`scripts/owner-pool-bot.ts:429-434`; the venues hard-code XRD/hUSDC (`scripts/owner-pool-sources.ts:12-17, 103-108`).

Prices are "B per A" of the pool, while the venues quote hUSDC per XRD. Several things are never checked:
that `pool.resourceA === XRD` and `pool.resourceB === hUSDC`, and that the pool is not paired with a
different stablecoin (for example xUSDC).

- With `--scale 1`, an inverted pool gives an absurd target. The anchor stop then pauses it: a denial of
  service, not a loss.
- With `--scale auto`, calibration hides the inversion. The target then moves opposite to the market (XRD
  up gives target up in XRD-per-hUSDC, which is XRD down), so **every rebalance trades in the wrong
  direction**. Only the 5% anchor stop and the budget bound it.

**Fix:** at start-up and on every tick, refuse unless the pool's `resource_a`/`resource_b` equal the
venues' (A, B). Make the venue pair a property of the venue set rather than a constant.

### H-2 High: the reference can be moved for cents (one thin venue), and one tick of it pauses the pool
`ownerpool-bot.ts:20` (`minVenues: 1`), `:543-553` (`pauseDecision`: an anchor problem pauses at once); docs
"Frozen on-ledger pools are accepted".

**Measured just now (12:07 UTC):** only Ociswap precision is live. The others are excluded: Ociswap basic
by its 3% fee, DefiPlaza by its 2.03% fee estimate, and CaviarNine can't quote because its hUSDC side
holds 0.00025. Ociswap precision's mid is 0.0007578, with 0.57% impact at 1,000 XRD, i.e. a
constant-product-equivalent depth of about 177k XRD (about $134 a side). Selling 5,000 XRD (about $3.80)
moves its bid 3.1% on average, and its marginal price about 5%. The fee is 0.05% each way, so pushing the
price and reverting it costs well under $0.10 (more only if someone arbitrages in between, then still
cents). CoinGecko read 3.9% above this reference at the same moment.

None of the bot's controls stops a price move on a single venue:
- **Two-tick confirmation** governs membership, not price. A confirmed venue's manipulated mid is used on
  the same tick (throwaway test).
- **The 4% disagreement limit** needs two or more live venues.
- **Single-venue caution** only halves the size and adds 50 bps.

Consequences:
- **Denial of service.** Push the venue more than 5% from the anchor for one tick. `pauseDecision` sets the
  operator pause at once (swaps stop), and resuming needs 15 minutes of health within 4%. Repeating this
  costs about $0.02/hour, and every repeat alerts the owner (alert fatigue).
- **Loss.** Inside the anchor band the bot moves the pool toward the manipulated price. Per episode, the
  attacker's arbitrage is about V(d-f)²/8 with d at most about the budget (3%): around $0.50 per $10k of
  pool at f = 1%, against under $0.10 of cost. That is small but positive, and it scales linearly with V.
- **Stale reference.** A frozen venue is followed indefinitely. The only signal is the CoinGecko alert at
  15%, three times the anchor band.

**Fix (mainnet):**
1. Use CoinGecko (or a second off-ledger source) as a **veto, never a price**: no rebalance, and no fee
   narrowing, when the venue reference is more than about 2-3% from it. This keeps the owner's "trade only
   on-ledger prices" rule.
2. Require the anchor-stop condition on 2 consecutive ticks, or on the median of the last 3 references,
   before pausing.
3. Target the median of the last 3-5 tick references, so that a manipulation must be held for minutes.
4. Add a minimum depth per venue, below which it cannot be the only venue.
5. Reconsider `minVenues: 1` for real money.

### H-3 High: the state file is not bound to a network, pool or badge, and its default path is shared with Stokenet
`scripts/owner-pool-bot.ts:142-147` (defaults), `:193-197` (`loadState` merges whatever is there); watcher `:68-72, 97-99`.

A mainnet run that forgets `--state` loads the Stokenet state. That brings in:
- **`targetDepth` ≈ 565** (Stokenet sqrt(Ra·Rb)). Under `side: balanced`, every mainnet move then prefers
  REMOVAL, so the curve shrinks toward the owner's floors.
- **Calibration** (scale 0.98...).
- **`ownerAnchor`**, including a Stokenet statement and `scannedTo`, a Stokenet state version used to
  page the mainnet stream.
- **`venueConfirm`/`venueHold`, `spends`, `haltedUntil` and `alertLast`.**

The defaults for `--pool`, `--badge` and `--key` are also Stokenet values.

**Fix:**
- Write `{network, pool, badge, operatorAccount}` into the state and refuse a mismatch.
- Use network-specific default paths, and no defaults for pool, badge or key on mainnet.
- Do the same for the watcher's state.

### H-4 High: the watcher's stolen-key rule (`not-bot`) is off or can be forged; nothing catches a thief who stays under the share limits
`scripts/owner-pool-watch.ts:107-121, 155-163`; `ownerpool-watch.ts:161-168`.

`not-bot` compares operator actions with the bot's sent log, read from a **local file**. The docs say to
run the watcher "where the operator key is not", but then the file is absent: `botLog()` returns
undefined and the rule is silently off, with only `botLog: "none"` in the tick log. If the watcher runs
on the bot's host instead, whoever stole the key from that host can append his own txids before
submitting. The rest of the theft rules are thresholds a careful thief stays under:
- each move at most 60% of the allowance;
- at most 60% in any 10 minutes;
- at most 1 budget in 24 hours.

`pool-drift` (3%) fires once per hour at most, and it is computed against the same manipulable reference
as the bot's.

**Fix:**
1. Add a **behavioural rule**: any operator rebalance that leaves the pool FURTHER from the watcher's own
   reference than before (gap after > gap before + a few bps) is never the bot's, so alert immediately.
   Do the same for any operator move while the watcher's reference is unhealthy or disagreeing, and
   check against CoinGecko as well. A thief must misprice the curve to profit, so this rule does not need
   the sent log.
2. In live mode, refuse to start (or alert) when the sent log is missing. If the log is shipped to the
   watcher's host, make it append-only from the bot's side.

### M-1 Medium: the watcher attributes callers from manifest text, so a fee change made through an intermediary component is only `info`
`ownerpool-watch.ts:92-103, 143-144`.

`operator_set_fee` is detected as an operator action only when the root manifest calls the pool directly.
A thief can pass the operator badge proof to his own component, which pushes the proof to its auth zone
and calls the pool. The fee change is then reported as "unknown caller", with severity **info**: never
alerted, and no `not-bot` finding (throwaway test). Naming the owner badge address anywhere in the
manifest (for example as an argument to the thief's own function) likewise stops `set_operator_paused`
being attributed to the operator. The fee is bounded by the operator range, so the impact is limited.

**Fix:** treat every fee or operator-pause change as the operator's unless the manifest PROVES the owner
badge (`create_proof_of_*` on the owner badge). Make a fee change by an unknown caller `warn`.

### M-2 Medium: the halt and the transaction cap also block the protective pause; normal swap races count toward the halt
`scripts/owner-pool-bot.ts:283-288`; `ownerpool-bot.ts:470-475`.

`execute` returns "skipped" for every transaction while halted (3 failed sends, then 1 hour) or at 12
transactions/hour, including `set_operator_paused(true)` and a fee widen. On a traded mainnet pool, a
swap that lands between the read and the commit fails the rebalance with "Reserves moved" (by design),
and three of those in a row halt the bot. During that hour an anchor stop or an unhealthy reference
cannot pause the pool.

**Fix:**
- Exempt `set_operator_paused(true)`, and probably fee widening, from the halt and the cap.
- Don't count a `Reserves moved` commit failure toward the halt; count it separately, with its own
  higher limit.

### M-3 Medium: long transaction validity; a timed-out send can commit 25 minutes later
`scripts/owner-pool-bot.ts:290` (`endEpoch: epoch + 5`, no `expiresAt`), `:299` (180 s wait).

At about 5-minute mainnet epochs the intent stays valid for up to about 25 minutes. A `Timeout` is
counted as a failure, the spend is not recorded in the rolling window, and the transaction can still
commit later on a stale target.
- For rebalances, the `expected` guard limits this (any swap or later move makes it fail).
- `operator_set_fee` and `set_operator_paused` have no guard and can land out of order, for example a
  late `pause(true)` after a newer `pause(false)`.

**Fix:**
- Use `endEpoch = epoch + 2` and `expiresAt = now + 120 s`.
- After a timeout, check its status again on the next tick before acting.
- Take the window's spends from the pool's `OwnerPoolRebalanceEvent`s, as the watcher does, not only
  from immediate successes.

### M-4 Medium: a lagging Gateway's quotes count as fresh
`scripts/owner-pool-sources.ts:152` (`at = Date.now()`).

The freshness check compares local times. If the mainnet Gateway's node is behind, its previews price an
old ledger state that still passes `maxAgeMs`.

**Fix:** each tick, read `mainnetGw.status()` and drop all venues when `proposer_round_timestamp` is more
than about 120 s old. Run your own Gateway or node on mainnet.

### M-5 Medium: no liveness alert for the bot or the watcher
The `stop` alert is sent only through the `finally` path. A SIGKILL, an OOM kill, a host loss, or a crash
before the loop (a corrupt state JSON at `:193-198`, an unreadable key at `:274`) sends nothing, and a
dead watcher is silent too. A dead bot leaves the curve stale, so loss is bounded by the fee, and a dead
watcher removes theft detection.

**Fix:** an external dead-man's switch, such as a heartbeat ping each tick to a monitor that alerts when
pings stop, for both processes.

### M-6 Medium: `--send` runs with no alert URL at all
`scripts/owner-pool-bot.ts:138`; `alerts.ts:63`.

With no URL the bot trades and every alert is recorded as `noUrl`.

**Fix:** on mainnet, refuse `--send` without an alert URL, and send a start alert that must succeed. An
ntfy topic is readable and writable by anyone who knows its name, so use a long random topic or a server
with authentication.

### L-1 Low: the lock file is not atomic, is keyed on the state path, and is left behind by early errors
`scripts/owner-pool-bot.ts:221-229`.

- **Not atomic.** The check and the write are separate (`existsSync` then `writeFileSync`), so two bots
  started together can both run.
- **Keyed on the state path.** Two bots with different `--state` values can run on the same pool, each
  with its own spend window, so they can spend up to twice as much. The contract budget still bounds it.
- **Left behind.** An exception between `:228` and the `try` (key read, `accountOf`) leaves the lock;
  if the PID is later reused, the bot refuses to start.

**Fix:** open the lock with `wx` (O_EXCL), keyed on pool and badge in a fixed directory, and release it
on every exit.

### L-2 Low: numeric flags are not range-checked
`scripts/owner-pool-bot.ts:91-147`.

`--max-anchor-distance 5` (meant as 5%) is 500% and disables the anchor stop. The same applies to
`--max-disagreement`, `--max-venue-fee`, `--max-round-trip`, `--min-venues`, `--max-tx-per-hour`,
`--halt` and `--venue-hold`. `opt()` also takes the next token even when it is another flag (`--scale
--send`).

**Fix:** validate ranges, and on mainnet clamp them to safe bounds.

### L-3 Low: test and drill inputs are accepted with `--send` on any network
`fixed:`/`file:` venues (`owner-pool-sources.ts:164-180`) trade on a typed or file price. Anyone who can
write the `--exclude-venues-file` can drop venues. An `--owner-anchor` left in a unit file is used
whenever the ledger search is incomplete.

**Fix:** refuse all three on mainnet.

### L-4 Low: `targetDepth` is fixed at the first start
`scripts/owner-pool-bot.ts:441-442`.

After the owner deposits more reserves, `balanced` keeps preferring removals toward the old depth, and
the curve drifts down to the floors.

**Fix:** reset it on an owner `OwnerPoolLiquidityEvent` or `owner_rebalance`, or make it explicit config.

### L-5 Low: the watcher's `spend-24h` limit gives false alarms on mainnet
`ownerpool-watch.ts:136-138`; docs "up to 2 can refill in 24 h".

That figure is for 10-minute Stokenet epochs. At about 5-minute mainnet epochs a 72-epoch window is
about 6 hours, so the bot may legitimately spend up to 4 budgets a day. False alarms teach the owner to
ignore alerts.

**Fix:** derive the limit from `window_epochs` and the epoch length.

### L-6 Low: the state is saved without fsync
`scripts/owner-pool-bot.ts:214-218`.

After a power loss, a truncated file stops the next start, and no alert is sent (M-5).

**Fix:** fsync the temporary file, keep a `.bak`, and fall back to it.

### Info
- `OWNER_POOL_PACKAGES.mainnet` is `[]` (`packages/core/src/ownerpool.ts:20`), so every mainnet pool is
  refused until it is filled in. That is fail-safe, and the entry must be the audited code hash.
- The public Gateway is trusted for previews, the reference and the pool state. Use your own on mainnet.
- `scripts/owner-pool-bot.ts` (the I/O) has no tests. Untested: the network guard, the lock, loading and
  binding the state, the calibration branch, the halt/cap/pause interplay, and the ordering inside
  `execute`.
- Checked and found correct:
  - rebalance direction and signs (removeA/addB to raise B per A, removeB/addA to lower it);
  - rounding toward zero to each token's places;
  - the TypeScript budget, caps and floors match `lib.rs` `move_inventory`;
  - Decimal precision is 60;
  - the previewed intent is byte-identical to the one sent;
  - no operator manifest returns a bucket;
  - the `expected` guard is on every rebalance;
  - the owner anchor is taken only from the pool's own Main-module `OwnerPoolAnchorEvent`;
  - dry run is the default.

## The mainnet `--send` guard
`scripts/owner-pool-bot.ts:86-89` refuses `--send` unless `--network stokenet`. Removing that line alone is
**not safe**: every Stokenet-shaped default would then apply to real money. Replace it with a mainnet path
that refuses to start unless all of the following hold:

1. `--scale 1` is given explicitly; `auto` is refused, in the bot and in the watcher (C-1).
2. The pool's `resource_a`/`resource_b` equal the venues' XRD/hUSDC (H-1).
3. `--pool`, `--badge`, `--key`, `--state` and `--sent-log` are given explicitly, with no Stokenet
   defaults, and the state is bound to network, pool and badge (H-3).
4. No `fixed:`/`file:` venues, no `--exclude-venues(-file)` and no `--owner-anchor` (L-3).
5. An alert URL is set and a start alert is delivered (M-6).
6. `OWNER_POOL_PACKAGES.mainnet` holds the audited package (Info).
7. An explicit, separate acknowledgement flag is given (for example `--mainnet-live`), so that a copied
   Stokenet command line cannot reach mainnet by changing `--network` alone.

With those checks, plus conservative owner limits (a small budget per window, caps and floors close to
the reserves, a fee range of about 50-200 bps), enabling mainnet is a safe change. The pool should start
small: every loss path above scales with pool size, and the contract bounds it per window, not overall.
