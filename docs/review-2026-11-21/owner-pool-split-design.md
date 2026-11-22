# OwnerPool: cold/hot split (owner badge vs operator badge)

Branch `pool-split` (from `pool-audit` at c8c2be0). Blueprint `scrypto/owner-pool/src/lib.rs`,
tests `scrypto/owner-pool/tests/owner_pool_split.rs` (new) plus the two existing files (adapted).
Engine: Scrypto / scrypto-test / radix-engine 1.4.0. Simulator only; nothing published, nothing pushed.

The owner's decision: before any mainnet publish, a market-making bot's key (HOT) must be able to
reprice the pool but must not be able to take funds out; taking funds out needs a second badge
(COLD) kept in the owner's wallet.

## Summary

- **Two badges.** OWNER (cold, `OwnerRole::Fixed`, as before) can do everything. OPERATOR (hot,
  optional) is a separate role that can only (1) move funds between the component's INVENTORY and its
  trading RESERVES, (2) set its own pause flag, (3) set the fee inside an owner-set range. No operator
  method returns a bucket or takes a destination; nothing an operator call does moves a token out of
  the component.
- **Inventory** is a second vault per token, not part of the curve. Swaps and `quote` see only the
  reserves. Swap fees stay in the reserves, as before.
- **A stolen operator key can still lose money**: it can misprice the curve and trade against it from
  the thief's own account. This is bounded on ledger by owner-set limits: reserve caps and a budget
  per window of epochs that every operator move spends from. The bound is real but it is not small
  over long periods: it grows roughly with the square of the budget spent, so it protects against a
  theft that is noticed and revoked within hours to a day, not one left running for a week. See
  "Loss bound".
- **The first cut was wrong**, and the reason matters for any future change: charging only the
  operator's own price change (from the current price) let a thief shrink the curve, move its price
  with a small swap of his own, regrow it at that price for free, and trade it back: **4,500 B per
  cycle with zero budget** on an 18k/18k curve (test `shrink_swap_regrow_bypass_is_refused`, run
  against commit bd574a4). The final rule also charges depth growth and the distance from an
  anchor price that only the operator or owner can move.

## Roles

| Method | Owner (cold) | Operator (hot) | Anyone | Notes |
|---|---|---|---|---|
| `swap`, `swap_with_minimum`, `quote` | yes | yes | yes | unchanged; blocked while either pause is on |
| `reserves`, `inventory`, `fee_bps`, `is_paused`, `operator_status` | yes | yes | yes | reads |
| `deposit(a, b, expected)` | yes | no | no | into the reserves; sets the anchor |
| `withdraw(amount_a, amount_b, expected)` | yes | no | no | from the reserves; sets the anchor |
| `withdraw_all()` | yes | no | no | reserves AND inventory, no guard |
| `deposit_inventory(a, b)` / `withdraw_inventory(amount_a, amount_b)` | yes | no | no | |
| `owner_rebalance(to_reserve_a, to_reserve_b, expected)` | yes | no | no | inventory <-> reserves, no limits; sets the anchor |
| `set_fee(bps)` | yes | no | no | cap 500 bps, fixed in code |
| `set_paused(bool)` | yes | no | no | the owner's pause; the operator cannot clear it |
| `set_operator(Option<badge>)` | yes | no | no | appoint, replace, revoke; needs a proof of the new badge |
| `set_operator_limits(budget_bps, window_epochs, cap_a, cap_b, min_fee, max_fee)` | yes | no | no | |
| `rebalance(to_reserve_a, to_reserve_b, expected)` | **no** | yes | no | inventory <-> reserves, within limits |
| `operator_set_fee(bps)` | **no** | yes | no | within [min_fee, max_fee] |
| `set_operator_paused(bool)` | yes | yes | no | the operator's pause flag only |
| native: `set_role("operator")`, owner role, royalties | no | no | no | `operator` is `updatable_by: [SELF]`; only `set_operator` (owner) changes it |
| native: metadata `name` | yes | no | no | unchanged from the audit |

The owner deliberately does not satisfy the `operator` role: the owner's equivalent is
`owner_rebalance`, which has no limits. Every owner-only method was tried with the operator's badge
and refused; every operator method was tried with the owner's badge and by a stranger and refused
(test `split_role_table`, `operator_cannot_extract_funds_by_any_method`).

### Operator appointment, replacement, revocation

- `set_operator(Some(badge))` refuses the owner badge, XRD and both pool tokens ("Bad operator
  badge") and requires a proof of `badge` in the auth zone (the audit's L-1 lesson: a typo cannot
  appoint a stranger). It then calls `Runtime::global_component().set_role("operator",
  rule!(require(badge)))`; the role is declared `operator => updatable_by: [SELF]` (lib.rs:213), and
  the engine resolves `SELF` to `require(global_caller(component))`
  (`radix-engine-1.4.0/src/system/system_modules/auth/authorization.rs:332`), so only the component
  itself can change the role. The owner cannot set it natively (tested: `set_role(pool, Main,
  "operator", allow_all)` with the owner badge fails), so the badge checks cannot be bypassed.
- `set_operator(None)` sets the role to `deny_all`. Replacing with a new badge cuts the old one off in
  the same transaction. Both tested (`revoke_and_replace_operator`).
- Practical set-up with the Radix wallet: create the operator badge into the OWNER's account, call
  `set_operator` proving both badges in one wallet transaction, then send the operator badge to the
  bot's account. Replacing after a theft: create a new badge, same steps.
- The operator is optional. A new pool has none (`instantiate` and `instantiate_with_liquidity` are
  unchanged: same four arguments), so the pool runs owner-only until `set_operator`; and
  `set_operator(None)` returns it to owner-only at any time. With the key lost, the owner keeps
  everything (`owner_path_works_with_operator_key_lost`).
- Operator badge custody rules are those of the owner badge (audit I-2): non-fungible, or 0-dp supply
  1, no minter, not recallable/freezable, updaters locked. A divisible operator badge's dust is full
  operator power.

## Mechanics of `rebalance` (lib.rs:603-650)

Arguments are signed: positive moves inventory to reserves, negative moves reserves to inventory.
Checks, in order:

1. `expected` reserves guard (as for `deposit`, audit M-1).
2. Both reserves > 0 before ("Pool is empty") and after ("Operator cannot empty a side").
3. If either side is raised, **both** reserves after must be at or below the caps
   ("Above the operator's reserve cap"). Lowering is always allowed, even above a cap.
4. Cost, from the budget ("Operator price-move limit"). With current reserves (Ra, Rb), price
   P = Rb/Ra, new reserves (Ra', Rb'), price P', and anchor price A:

       cost = max(d(P, P'), d(A, P')) + max(0, Ra'Rb'/(Ra Rb) - 1) / 2
       d(x, y) = max(x/y, y/x) - 1

   computed exactly on attos in I512 and rounded up (lib.rs:173-195). Each term is at least the
   matching log change (d(x, y) >= |ln(y/x)|, and (k'/k - 1)/2 >= ln sqrt(k'/k)), so the budget
   bounds the operator's cumulative log path in price, measured both from where the curve is and
   from where the operator last left it, and in depth.
   Exception: an exactly proportional decrease (no raise, price unchanged) is free and does not
   move the anchor (lib.rs:617). It only shrinks the curve, which can only reduce what can be lost.
5. The anchor becomes the new price (`set_anchor`, lib.rs:676). Owner moves (`deposit`, `withdraw`,
   `owner_rebalance`) also set it. Swaps never do.

Budget: `allowance` refills linearly at `budget / window_epochs` per epoch, never above one budget
(lib.rs:659). So over any T epochs the operator can spend at most `budget * (1 + T / window)`;
splitting a move into many small calls gains nothing (each piece is charged, and many small pieces
of a log path cost about the same as one). New limits clip the allowance down, never top it up.
Defaults at instantiation: budget 0, caps 0, fee range = [instantiation fee, instantiation fee], so
an operator can do nothing that costs budget or raises a reserve until the owner sets limits.

What a legitimate bot pays: following the market costs the market's path between its re-pricings
(d from the anchor, not from where arbitrage already took the curve). A one-sided ADD costs about
1.5x its price move (price plus depth); a one-sided REMOVAL costs only the price move; sweeping
profit out of the curve proportionally is free. A bot should reprice with a dead-band (e.g. only
when off by >= 0.5%) and prefer removals.

## Bypasses considered

| Bypass | Outcome | Why / test |
|---|---|---|
| Call a withdraw path with the operator badge | refused | role table; `operator_cannot_extract_funds_by_any_method` (18 calls + 5 native module calls; operator balances unchanged, component total unchanged) |
| Many small moves | no gain | refill is continuous; 49 moves of 0.2% spent 0.0982 and moved the price by 1.1031 <= e^0.1 |
| Move both sides at once | charged | cost uses the ratio of the two prices; opposite-direction moves cost the product |
| Spend across windows | bounded | over 30 epochs with window 10, spent 0.3006 of at most 0.4 |
| Reset loop (misprice, trade back, misprice again) | charged every time | d(P, P') counts the move back from the market price; test B: 7 cycles gained 2.94 vs 20.57 for one extraction |
| Pause games (operator pauses so nobody else trades the mispricing back, keeps pushing over several windows) | bounded, included in the bound | test C; owner's pause cannot be cleared by the operator, owner can clear the operator's |
| Fee games (set fee 0 for own trades, or 5% to keep arbitrageurs out) | bounded by owner's fee range | the bound assumes fee 0 (worst case); a high fee cannot raise the thief's gain beyond the bound |
| Empty one side into inventory | refused | "Operator cannot empty a side" |
| Shrink / own swap / regrow at the swapped price | refused | **broke the first cut** (4,500 per cycle, zero budget); now the regrow pays d(A, P') + depth growth (`shrink_swap_regrow_bypass_is_refused`) |
| Move the price with own capital, then have the operator add at that price | refused | d(A, P') ~ 0.78 > budget (test E) |
| Regrow depth at a price the market has left (bot stopped, no arbitrageurs) | **residual**, bounded | depth growth is charged, and the anchor's distance from the market enters the bound (test D) |
| Owner sets roles natively to bypass `set_operator` checks | refused | `updatable_by: [SELF]` |
| Raise above caps | refused | both sides after any raise must be within the caps |

## Loss bound

Notation: P* market price (B per A); S = sqrt(cap_a * cap_b * P*) (half the market value of a
balanced curve at the caps; if the owner himself funded the curve above the caps, use that curve's
sqrt(Ra Rb P*) instead); C = total budget the thief spends; D = how far (log) the anchor is from the
market when the theft starts, plus how far the market moves while it lasts. Fee 0 (worst case).

**Proven bound.** The thief's total gain from operator powers is at most

    G <= S * C * psi(D + 2C),   psi(x) = 2 (cosh(x/2) - 1) + sinh(x/2),   C <= budget * (1 + T / window)

Sketch: let Phi be what an arbitrageur could take from the curve right now,
Phi = (sqrt(Ra P*) - sqrt(Rb))^2 = L sqrt(P*) * 4 sinh^2(X/4) with L = sqrt(Ra Rb) and X the log
distance of the curve's price from P*. A swap at fee 0 moves exactly its gain out of Phi (the
thief's own swaps cost him what they add), so the thief's net gain is at most the sum of the
increases of Phi caused by operator calls. For one call, split into a depth change at P then a price
change at L': the depth part is at most L * (L'/L - 1) * sqrt(P*) * phi(X) <= S * c_depth * phi(X),
the price part at most L' * sqrt(P*) * sinh(X_max/2) * |ln(P'/P)| <= S * c_price * sinh(X_max/2),
using L, L' <= sqrt(cap_a cap_b) (the caps after any raise; swaps keep L; decreases lower it). Both
the curve's price before and after the call lie within 2c (resp. c) of the anchor, because cost
includes d(P, P') and d(A, P'); and the anchor moves only by budgeted calls, so its distance from
the market is at most D + C. Summing gives the bound. Without the anchor term the price before a
call is unconstrained (the thief sets it with his own swaps) and without the depth term L' is
unconstrained at zero cost; each omission gives an unbounded attack (bypass table).

Proven bound as a % of S:

| C (budget spent) | D = 0 | D = 0.1 | D = 0.2 |
|---|---|---|---|
| 0.02 | 0.04% | 0.15% | 0.27% |
| 0.05 | 0.26% | 0.55% | 0.87% |
| 0.10 | 1.10% | 1.73% | 2.41% |
| 0.20 | 4.83% | 6.31% | 7.90% |
| 0.30 | 11.86% | 14.43% | 17.19% |
| 0.50 | 38.82% | 44.42% | 50.38% |

**Measured** (best strategies tried, `stolen_operator_key_attack_is_bounded`; curve 18k/18k at
P* = 1, inventory 10k/10k, caps 20k, so S = 20,000; budget 10% per 100 epochs; fee 0):

| Strategy | Budget spent | Thief gain = owner loss | Proven bound |
|---|---|---|---|
| A: push with the full budget, trade back once | 0.0999 | 20.57 (0.10% of S) | 220.3 |
| B: ~1% push / trade back, repeated | 0.0999 | 2.94 | 220.3 |
| C: operator-pause on, push over 5 windows, trade back once | 0.4999 | 799.3 (4.0% of S) | 7,762 |
| D: market +20% while the bot is stopped; thief pushes further | 0.0999 | 151.9 extra over the 164.0 any arbitrageur would take | 501.6 |
| E: own-capital mispricing, then operator move | refused | 0 | - |
| first cut, shrink / swap / regrow (bd574a4) | 0 | 4,500 per cycle, repeatable | none |

The measured attacks track the simpler single-extraction estimate S * 4 sinh^2(C/4) (0.25% of S at
C = 0.1, 6.3% at C = 0.5) better than the proven bound, which is about 4-10x looser. I could not find
an attack near the proven bound; that does not mean none exists.

**Honest statement.** The split guarantees that the operator key alone cannot move a token out of
the component, and that whatever a thief extracts through trading against a mispriced curve over T
epochs is at most S * C * psi(D + 2C) with C <= budget * (1 + T / window). That bound is small for a
theft revoked within the first window (e.g. ~1% of S at C = 0.1) and becomes large, then vacuous,
if it runs for many windows (C = 0.5: ~40% of S proven, ~4% measured). It also scales with S, i.e.
with the caps, and with D: if the bot has stopped and the market has moved, the curve was already
exposed to that move (any arbitrageur takes it), and the thief's extra take grows with it.

What the split does **not** protect:
- the reserves against ordinary arbitrage when the price is stale (unchanged from today);
- against a thief who keeps the key for many windows unnoticed: detection and revocation are part
  of the design (see Q6);
- against loss or theft of the OWNER badge (still total, permanent control; audit I-2/opinion c);
- against token-issuer powers on the pooled tokens (audit I-1);
- third parties trading at the curve's price (takers who skip a minimum-output assertion).

## Decisions taken (with reasons)

- **Swap fees accrue to the trading reserves**, as now. No change to the swap path, and the bot can
  sweep profit to inventory with a free proportional decrease. A thief cannot take fees out either.
- **The operator can be absent** (`None`, the state at instantiation and after revoke): the pool
  then runs owner-only, exactly as before, with `owner_rebalance` added.
- **`withdraw_all` empties inventory too**; zero amounts do not touch their vault, so a frozen,
  empty inventory vault does not block it (audit I-6 behaviour kept).
- **Instantiation is unchanged** (four arguments, owner badge proof, XRD/pool-token badges refused);
  the operator is added afterwards with `set_operator`.
- **Kept from the audit, re-run:** rounding direction and k never falls, quote == swap, owner role
  fixed, no royalties, reserves guard. All 32 existing tests pass unchanged in substance.

## Costs

- **Swap gas:** steady-state swap on a 10k/10k pool, same manifest: 8,067,789 execution cost units
  on c8c2be0 vs 8,681,560 on the split (+613,771, +7.6%). The swap code is the same apart from one
  more pause flag; the increase is the larger component state and wasm read on every call.
- One-sided adds cost the bot 1.5x budget (see above).

## Open questions for the owner (recommended defaults)

1. **Budget and window.** Recommended: budget 300 bps per 72-epoch window (about 6 h if epochs are
   about 5 minutes on mainnet; not verified here). That is a 12%-per-day rate with a 3% burst:
   proven worst case about 0.13% of S in the first hour, 0.38% in 6 h, 2.6% in 24 h. Measure
   the bot's real spend on Stokenet first and set the budget to about twice that.
2. **Caps.** Set them to the curve size you actually want on the curve (e.g. the current reserves
   plus 10%); the loss bound scales with sqrt(cap_a * cap_b). Keep the rest in inventory, or better,
   in the cold account.
3. **Operator fee range.** Recommended [10, 100] bps, or [fee, fee] (the default) if the bot does not
   need it. A floor above 0 keeps every taker, the thief included, paying something.
4. **Operator pause.** Kept (the bot can stop trading in a crash; the owner can always clear it).
   Remove it if you prefer the bot to stop by shrinking the curve instead (free, same effect).
5. **Proof of the operator badge in `set_operator`.** Implemented (typo protection). It means the
   owner must hold the new badge at appointment time (workflow above).
6. **Monitoring (off ledger, strongly recommended).** Alert on every `OwnerPoolRebalanceEvent`
   whose `cost` is unusual, on `allowance` near zero, and on the curve's price leaving the market by
   more than the bot's dead-band; revoke with `set_operator(None)` from the wallet. The bound is
   small only if revocation is quick.
7. **Oracle.** A real price band needs a trusted on-ledger price; none is used. Not recommended now.
8. **Owner role.** Still one fixed badge. A multi-signature owner (`OwnerRole::Fixed(any access
   rule)`) is possible but not done.
9. **Gas** +7.6% per swap: acceptable?

## Tests

`scrypto/owner-pool/tests/owner_pool_split.rs` (new): `split_role_table`,
`operator_cannot_extract_funds_by_any_method`, `operator_limits_within_and_across_windows`,
`revoke_and_replace_operator`, `owner_path_works_with_operator_key_lost`,
`inventory_is_not_traded_and_fees_stay_in_reserves`, `stolen_operator_key_attack_is_bounded`,
`shrink_swap_regrow_bypass_is_refused`.
Existing: `owner_pool_proposal.rs` (15) and `owner_pool_audit2.rs` (17), adapted only for the config
event's new `operator_paused` field and for picking the funded (reserve) vault in the recall/freeze
tests now that the component holds four vaults.

Run: `CRATE=owner-pool TARGET_VOLUME=radix-dex-target-pool-split scrypto/run.sh test --test owner_pool_proposal --test owner_pool_audit2 --test owner_pool_split`.
Result (one run, 13 min 26 s wall): `owner_pool_audit2` **17 passed, 0 failed** (592 s);
`owner_pool_proposal` **15 passed, 0 failed** (127 s); `owner_pool_split` **8 passed, 0 failed** (80 s).
Total 40 passed, 0 failed. `shrink_swap_regrow_bypass_is_refused` was also run against the first
cut (bd574a4), where it failed after printing the 4,500 gain.

## Not verified

- Simulator only (scrypto-test 1.4.0); not run on Stokenet or mainnet.
- The proven bound is a hand derivation (sketched above), not machine-checked; the tests check the
  measured attacks against it but cannot show no better attack exists.
- Epoch length on mainnet (taken as about 5 minutes for the recommendations).
- The bot and the exchange's TypeScript were not changed or reviewed; the bot needs new manifests
  (`rebalance` with the operator badge, `expected` guard).
