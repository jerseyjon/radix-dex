# Pool audit (22 Nov 2026)

Scope: the `Pool` blueprint in `scrypto/dex-contracts/src/pool.rs`, as published on mainnet in
`package_rdx1p45xupj26f6y0kh4lva44cyapvmp4e5kxzuklmync88wy6250c8dgl` (code hash
`2112760b…a8e70e`), and how the exchange would use it. The earlier
[security audit](security-audit.md) covered the order book and the solver; this does not repeat it.
Branch `pool-audit` (from `overnight-all`). Tests: `scrypto/dex-contracts/tests/pool_audit.rs`
(findings and properties of the published Pool) and `tests/owner_pool_proposal.rs` (the proposal).

## Verdict

**Safe with these operating rules.** The pool's maths are sound: every rounding goes against the
trader or depositor, the price curve never loses value to a trade, the classic "first depositor
inflates the share price" attack fails, and the owner badge cannot touch the reserves, change fees
or pause anything. Nobody can steal from a pool through the contract itself. The real dangers are in
how liquidity is put in and which tokens are paired: (1) the first deposit, and any deposit into a
pool that has been fully emptied, must be made with a manifest that asserts the minimum number of
pool units received, or anyone can make it at a false price and take about half of it; (2) only pair
tokens whose issuer cannot recall or freeze them (XRD, hUSDC and hUSDT qualify; checked on ledger),
because one recalled unit locks both sides of the pool for ever. With those two rules the published
package can be used and no new package is needed. For the owner's stated plan (sole provider, a
market-making bot later) a purpose-built owner-only pool would be simpler and safer; a proposal is
on this branch, separately, and would need a new package (about 145 XRD).

## Summary

| # | Severity | Title | Needs new package | Demonstrated |
|---|---|---|---|---|
| F1 | Medium | A token issuer's recall of one unit locks both tokens in the pool for ever; a freeze halts both while it lasts | No (rule: only non-recallable, non-freezable tokens) | Yes |
| F2 | High (with an unprotected deposit) | Anyone can seed an empty pool first at a false price; an owner deposit without a minimum-units assertion is then robbed (13,611 of 25,000 XRD in the test) | No (rule: assert minimum units) | Yes |
| F3 | Medium | A fully emptied pool keeps a dust price that can be far from the last one; the next deposit is made at it (49,649 XRD-equivalent lost in the test) | No (rule: never empty a pool, or re-seed only with an assertion) | Yes |
| F4 | Low | With very large-supply tokens, withdrawals overflow and the provider can take out only slivers | No (rule: avoid tokens with supplies above ~1e24) | Yes |
| I1 | Info | The server cannot route through a radixdex pool on mainnet yet; when it does, allow-list by component address, not package | No | No (TypeScript; reasoning) |
| I2 | Info | Anyone can instantiate an identical-looking Pool (same names) from the package | No | Yes (implicitly: tests instantiate freely) |
| I3 | Info | `claim_protocol_fees` emits no event; pool units have no symbol or icon | No | Partly (events test) |
| I4 | Info | Gateway's per-component balances include the protocol-fee vaults, so reserves read that way are slightly high | No | No |
| I5 | Info | `quote`/`reserves` give a spot price that can be moved inside one transaction; nothing should use it as an oracle (nothing in this repo does) | No | No |

Properties that hold (each has a passing test): swaps never pay more than the exact unrounded
amount and k never falls, for divisibility pairs 18/18, 6/18, 8/18, 0/18, 6/6 and 0/6 and sizes from
1e-18 to 30% of a reserve; add-then-remove never gains either token for 0, 6, 8 and 18 places; the
share-inflation attack costs the victim 1e-18 on a 50,000 + 50,000 deposit; the owner can rename the
pool but cannot change its token addresses, add a royalty, mint units or edit the units' metadata;
swaps and liquidity changes emit events.

## Findings

### F1. Recall or freeze by a token issuer locks both sides (Medium)

`pool.rs:310-312` (`assert_books_match_vaults`), called at `:199`, `:249` and `:268`. The pool keeps
its own book of reserves and asserts after every swap, deposit and withdrawal that the vaults hold
exactly that. A token whose resource has a recaller role lets its issuer take tokens out of the
pool's vault. After that the books never match again, and there is no method that could put the
difference back (vaults cannot be paid into from outside). Every later swap, deposit and withdrawal
panics, so the other token is locked too. A freeze on the vault has the same effect while it lasts
(withdrawals take from both vaults, so neither token comes out).

*Scenario.* Pool of 10,000 REC and 5,000 USD. The REC issuer recalls 1 REC. The provider can now
withdraw neither the 9,999 REC nor the 5,000 USD, ever.
*Tests.* `finding_recall_of_one_unit_locks_both_tokens_for_ever`,
`finding_freeze_of_one_vault_halts_withdrawal_of_both_tokens`.
*Operating rule.* Only pair tokens whose recaller and freezer are `DenyAll` with their updaters
locked. Checked on mainnet on 22 Nov: XRD, hUSDC (`resource_rdx1thxj9m…4gv`) and hUSDT
(`resource_rdx1th4v03…vhe`) all have recaller and freezer DenyAll, locked; deposit and withdraw
rules AllowAll, locked. hUSDC/hUSDT can be minted and burned by the bridge, which is normal for a
bridged token. *Fix in a new package:* treat the vault balances as the reserves (the proposal does),
so a recall only loses what was recalled.

### F2. Pre-seeded empty pool; deposits have no minimum (High with the naive procedure)

`pool.rs:213-252` (`add_liquidity`, public at `:61`); first-deposit branch `:219-226`.
Instantiating a pool and funding it are two transactions (a manifest cannot call a component
created earlier in the same manifest). Between them anyone can call `add_liquidity` with dust at any
ratio, and that ratio becomes the pool's price. Later deposits are taken "at the pool's ratio" with
the rest returned as change, and nothing in the method checks the price or a minimum number of units.

*Scenario (test numbers).* Fair price 10 XRD per USD. Attacker seeds 1 XRD + 0.000001 USD (1,000,000
XRD per USD). Owner then deposits 25,000 XRD + 2,500 USD with the manifest shape used in
`scripts/stokenet-setup.ts:76-84` (no assertion): the pool takes 25,000 XRD and 0.025 USD. Attacker
swaps 0.03 USD in and receives 13,612 XRD. The owner withdraws and is down 13,611 XRD-equivalent of
the 25,000. The same manifest with `ASSERT_WORKTOP_CONTAINS <units> <99% of sqrt(25,000 x 2,500)>`
fails instead, costing only the network fee.
*Test.* `finding_pre_seeded_pool_robs_an_unprotected_first_deposit` (both halves).
The same mechanism lets a validator or anyone who can order transactions sandwich any later
deposit made without a minimum (move the price, let the deposit land, move it back). On Radix this
is harder than on Ethereum (no public priority auction), but the assertion closes it completely.
*Operating rule.* Every `add_liquidity` manifest asserts a minimum of pool units: for the first
deposit `0.99 x sqrt(a x b)`; later, `0.99 x (amount / reserve) x supply` computed from freshly read
reserves at the market price. Before seeding, read `reserves()`: if it is not `(0, 0)`, someone got
there first; do not deposit, instantiate a new pool instead (it costs a few XRD).
*Fix in a new package:* fund the pool in the instantiating call, and/or restrict deposits to the owner.

### F3. An emptied pool keeps a false dust price (Medium)

`pool.rs:255-271` and `:5`. A sliver of units (0.000001) is locked for ever, so after every provider
withdraws, dust reserves remain and the first-deposit path (`:219`) is never taken again. Withdrawals
round down per token, so the dust left on a low-divisibility side is a whole smallest unit while the
other side's dust is tiny, and the dust ratio can be far from the last price. The next deposit is
taken at that ratio.

*Scenario 1 (0-place token).* 1,000 tickets + 50,000 XRD (50 XRD per ticket). Owner withdraws all;
dust left: 1 ticket : 0.0000071 XRD. Owner re-adds 1,000 tickets + 50,000 XRD: the pool takes 1,000
tickets and 0.007 XRD. Attacker pays 1 XRD for 993 tickets; owner is down 49,649 XRD-equivalent.
*Scenario 2 (hUSDC-like, 6 places).* 25,000 XRD + 2,500 USD (10 XRD per USD), all withdrawn: dust
0.00000316 XRD : 0.000001 USD, a price of 3.16 XRD per USD, 68% off.
*Tests.* `finding_emptied_pool_keeps_a_dust_price_that_robs_the_next_deposit`,
`finding_emptied_xrd_usd6_pool_dust_price_is_wrong`.
*Operating rule.* Do not withdraw 100% from a pool you intend to use again; leave a little (say 1%)
so the price is held. If a pool has been emptied, either retire it and instantiate a new one, or
first swap a small amount to bring the price back to market and then deposit with the minimum-units
assertion from F2.

### F4. Overflow with very large-supply tokens (Low)

`pool.rs:260` (and `:232`, `:236`, `:299-301`). Withdrawal computes `units x reserve / supply`;
the product is formed first in `PreciseDecimal`, whose maximum is about 5.8e40. With a 5e27-supply
token against 100,000 XRD, the provider holds 2.2e16 units and cannot withdraw all of them, or even
1%: only slices of under about 1.1e13 units (0.00005% of the holding) per transaction. Swaps
continue to work. Later deposits overflow the same way.
*Test.* `finding_huge_supply_token_overflows_withdrawal`.
*Operating rule.* Do not pair tokens whose reserve could exceed about 1e24 (with XRD on the other
side). No such token is expected in the owner's pools. *Fix:* divide before multiplying (the
proposal does).

### I1. Routing and allow-listing

On mainnet, `apps/server/src/marketdata.ts:81-99` lists pools only from the Ociswap and DefiPlaza
APIs and keeps those whose package is in `ALLOWED_PACKAGES` (`packages/core/src/venues.ts:10-18`),
which does not include this package; the markets file with `venue: 'radixdex'` is used off mainnet
only (`marketdata.ts:65-79`). So a mainnet Pool will not be routed until code is added. When it is,
allow-list **by component address**, never by package: anyone can instantiate a Pool from the
package with any tokens (a worthless token, or a recallable one they then brick), and listing it
would reopen audit finding H3 (fees priced by an attacker's pool) and let them make the solver's
transactions fail at a fee each time. Such a pool cannot steal a user's principal (the taker's signed
minimum still holds, and the Pool makes no outside calls), but it can misprice and grief.

The pool leg itself is safe: quotes come from previewing the real manifest
(`packages/core/src/quote.ts:85-123`), so they are exactly what the contract pays at that moment;
the Pool always swaps the whole bucket and returns nothing unswapped, so audit finding L1 does not
arise with it; and slippage is covered by the taker's signed minimum and the
`ASSERT_WORKTOP_CONTAINS` lines in `orders.ts`. The Pool's `swap` has no minimum argument, so any
other caller must use a manifest assertion.

### I2. Look-alike pools

The component name ("radix-dex pool") is updatable by its owner and the unit's name is fixed, so a
copy made by anyone looks identical. Publish the real pool addresses on the site and in the dApp
definition's `claimed_entities`.

### I3. Observability

`SwapEvent` (input, output, amounts, protocol fee) and `LiquidityEvent` (signed amounts and units)
are emitted (`pool.rs:201-207`, `:250`, `:269`), which is enough for the trades list and for an
operator (`property_events_are_emitted`). Gaps: `claim_protocol_fees` (`:274-276`) emits nothing;
events do not carry the reserves after the change, so a monitor has to call `reserves()`; the pool
unit has no symbol, icon or description, so wallets show an anonymous token.

### I4. Reserves read from the Gateway

The component also owns the two protocol-fee vaults, so Gateway's per-component fungible balances
(as `scripts/stokenet-setup.ts:153` reads them) are reserves plus unclaimed protocol fees. Use the
`reserves()` method, or set the protocol fee to 0. Not demonstrated.

### I5. Spot price

`quote` and `reserves` reflect the current state and can be pushed within one transaction for the
price of the fees. Nothing in this repo uses them as an oracle; nothing should.

## Authority and immutability (checked)

- Anyone can instantiate (`instantiate` is a public function). The fees are fixed at instantiation
  (each capped at 1%) and can never change. There is no pause.
- The owner badge (`OwnerRole::Fixed`, cannot be changed) can only claim the protocol-fee vaults and
  edit unlocked metadata (rename, add keys). It cannot touch reserves, fees, the token addresses
  (locked metadata) or units. No royalty module is attached, so no royalty can be added
  (`property_owner_powers_are_limited`; verified against scrypto source, `component.rs:292-314`).
- Pool units: owner role None; mint and burn only by the pool component, both updaters `deny_all`;
  no recall or freeze roles; name and pool address locked. Nobody can mint units except through a
  deposit.
- No callbacks, no flash loans, no outside calls.

## Test coverage

Before this audit (`tests/lib.rs`): lifecycle, refusal of bad calls, protocol-fee claim by badge
only, add/remove round trips on 8-place and 0-place tokens, dust swap round trips, 0-place
rounding, and a non-adversarial first-depositor case. Not covered: recallable or freezable tokens,
pre-seeding, re-seeding an emptied pool, overflow, events, owner powers beyond the claim, 6-place
tokens, and an upper bound on what a swap pays. All of these are now in `tests/pool_audit.rs`.

Results on this branch (`cargo test --release`): `lib.rs` 17 passed; `pool_audit.rs` 11 passed;
`owner_pool_proposal.rs` 4 passed. The `finding_*` tests pass when the weakness is present.

## Build provenance

Reproduced. In the live checkout, `data/contracts/dex_contracts.wasm` has blake2b-256
`2112760b1c88f9dd64557bbb65865cb0416e1675782ae1d4569955e487a8e70e` (equal to the package's code
hash) and sha256 `b3954135…f4082a`; the `.rpd` has sha256 `08853663…1f396d9b`. A fresh build of the
source at `5d8ad90` (unchanged up to `overnight-all`), in a new empty Docker target volume with the
local image `radix-dex-scrypto:1.92` (`sha256:a9b8324e…`) and the repo's `Cargo.lock`, produced the
identical wasm (same blake2b-256 and sha256) and identical `.rpd`. The artefacts come from
scrypto-test's compiler (`compile_and_publish`, which writes
`/target/wasm32-unknown-unknown/release/dex_contracts.{wasm,rpd}`); there is no `scrypto` CLI in the
image. Caveats: the image is pinned by local tag, not by a digest of `rust:1.92-bookworm`, and the
cargo registry volume is shared (crates are checked against `Cargo.lock` checksums). Recording this
in a tracked file, as quality-review item 20 asks, is still to do. (`data/contracts/v1/` holds an
earlier build, blake2b-256 `3aee1ca2…`, from the first Stokenet package.)

## The owner's plan: sole provider, market-making bot later

### 1. Can deposits be restricted in the published Pool?

No. `add_liquidity` is `PUBLIC` (`pool.rs:61`) and `instantiate` takes no option to restrict it.
Anyone can deposit and receive units; anyone holding units can withdraw.

What outside deposits can and cannot do to a sole provider:
- **Dilution of fee income only.** An outsider who deposits earns a pro-rata share of later LP fees
  and bears the same price risk; that is not a loss of the owner's principal.
- **No share-price manipulation.** Depositors pay for exactly the units minted, rounded up, and get
  the change back; the inflation attack fails (`property_first_depositor_inflation_by_swaps_fails`).
  There is no donation path: tokens cannot be paid into the vaults except through the three methods.
- **No blocking.** An outsider cannot stop the owner withdrawing his units at any time. The owner
  cannot, though, take the outsider's share, close the pool or exclude them.
- **What does matter:** pre-seeding before his first deposit (F2) and holding the dust price after
  he empties it (F3). Both are closed by the minimum-units assertion. An outsider's deposit or
  withdrawal also changes the depth his bot sees; the bot must read `reserves()` rather than assume
  the pool is all his.
So yes, with the F2/F3 rules he can ignore outside deposits.

### 2. Which findings change with a single trusted provider

- Share-inflation / first-depositor attack: already fails; irrelevant.
- F2 (pre-seed): **remains**; it is aimed at exactly his first deposit. Rule: assert minimum units.
- F3 (emptied pool): **remains and is more likely**, since a sole provider is the one who empties
  and re-fills. Rule: never empty fully, or re-seed with the assertion after fixing the price.
- F1 (recall/freeze): unchanged; avoided by token choice (XRD/hUSDC/hUSDT are fine).
- F4 (overflow): unchanged; avoided by token choice.
- Protocol fee vs LP fee: both are his. Set the protocol fee to 0 and put the whole fee in the LP
  fee: it stays in the reserves (deepening the pool) and needs no claim; I4 then disappears.
- Moving the price for a bot: in the published Pool the only lever is swapping against it. For a
  sole provider that is nearly free (the fee goes back into his own pool, less the locked sliver's
  0.000001 units), but it changes his inventory and costs network fees.

### 3. Proposal: `OwnerPool` (separate commit; needs a new package)

`scrypto/dex-contracts/src/owner_pool.rs`, tests in `tests/owner_pool_proposal.rs` (4 pass). Not
in the published package and not used by anything. It is a proposal for the owner to decide on.

- **Owner-only liquidity.** `deposit` and `withdraw`/`withdraw_all` require the owner badge. There
  are no pool units at all, so F2, F3 and the share-rounding questions disappear; withdrawal is by
  badge and is never locked or paused.
- **Seeded at birth.** `instantiate_with_liquidity(a, b, fee, badge)` funds the pool in the creating
  transaction.
- **Adjustable fee within a cap.** `set_fee` (owner), hard-capped at 1% in code.
- **Pause for swaps only.** `set_paused` (owner); withdrawals always work.
- **Price moves for the bot.** `deposit` accepts either token alone at any ratio, so the bot can
  shift the price by adding or removing one side, instead of trading against itself.
- **Robust accounting.** Reserves are the vault balances, so a recall loses only what is recalled
  (F1); products are formed after dividing (F4).
- **`swap_with_minimum`** for callers who cannot add manifest assertions; `swap(bucket)` keeps the
  shape the exchange's manifests already use.
- **Events:** swaps (with reserves after), deposits/withdrawals (with reserves after), fee and pause
  changes.

Before publishing it needs: its own review, a Stokenet run, and an exchange change to list it (by
component address). Cost: a package publish (about 145 XRD) plus one instantiation per pair.

**Concentrated or shifted pricing.** A constant-product pool spreads liquidity over every price, so
most of it is idle; a bot keeps it near the market by moving reserves (above). Truly tight quoting
around the market is better done with **order-book orders**: the published `OrderBook` already
holds resting orders at exact prices with partial fills, the bot can cancel and re-place as the
market moves, and there is no curve to get wrong. Putting concentrated ranges or virtual reserves in
the pool would add a drain-to-one-side boundary and much more maths to audit. Recommendation: owner
pool for always-on depth, order-book orders for the tight spread.

## Operating advice if the owner seeds pools from the published package

1. **Tokens.** XRD, hUSDC, hUSDT (checked). For anything else, check on the Gateway that recaller
   and freezer are `DenyAll` and locked, withdraw/deposit rules `AllowAll` and locked, divisibility
   known, and supply well under 1e24. Never non-fungibles (the pool refuses them anyway).
2. **Fees.** Fixed for ever at instantiation. Suggest LP fee 30 bps, protocol fee 0 (as sole
   provider the LP fee is his and compounds in the pool).
3. **Owner badge.** A dedicated badge held in a cold account, not the solver's hot badge (the
   Stokenet script reuses the solver badge). It only controls metadata and protocol fees, but there
   is no reason to keep it hot.
4. **First deposit.** Instantiate. Read `reserves()`; it must be `(0, 0)`, otherwise abandon that
   pool. Deposit at the current market ratio with
   `ASSERT_WORKTOP_CONTAINS <pool unit> Decimal("<0.99 x sqrt(a x b)>")` after `add_liquidity`,
   and preview the manifest first.
5. **Later deposits** use the same assertion with `0.99 x min(a/Ra, b/Rb) x supply`, reserves read
   just before.
6. **Never withdraw 100%** of a pool you will use again; leave about 1%. To retire a pool, withdraw
   all and do not reuse it.
7. **Size.** Start small; the loss to arbitrage (impermanent loss) grows with XRD's moves against
   the dollar.
8. **Monitoring.** Watch the component's `SwapEvent` and `LiquidityEvent`; alert on any
   `LiquidityEvent` that is not his own (outsider deposits), on the pool price straying from
   Ociswap/DefiPlaza by more than a few per cent, and on any failed swap with "Books do not match
   vaults" (would mean a recall). Claim protocol fees if any were set.
9. **Exchange integration.** List the pool by component address (I1) and publish the address on the site.

## Not verified

- Behaviour against a real mainnet Gateway or wallet: everything here ran in the scrypto-test
  ledger simulator (radix-engine 1.4.0), not on Stokenet or mainnet.
- The TypeScript observations (I1, I4) are from reading code, without tests.
- Whether the Docker base image could be rebuilt byte-for-byte today (it is pinned by local tag);
  the reproduction used the existing local image.
- Sandwiching on Radix's mempool is described, not attempted.
