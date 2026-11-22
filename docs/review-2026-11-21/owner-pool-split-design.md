# OwnerPool: cold/hot split (owner badge vs operator badge)

Branch `pool-split` (from `pool-audit` at c8c2be0). Blueprint `scrypto/owner-pool/src/lib.rs`,
tests `scrypto/owner-pool/tests/owner_pool_split.rs`, `owner_pool_split_audit.rs` (the independent
audit's tests, inverted after the fixes), `owner_pool_split_audit2.rs` (the second audit's attack
measurements; its two Low findings fixed and their tests inverted) plus the two earlier files (adapted).
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
  the thief's own account. This is bounded on ledger by owner-set limits: reserve caps and floors, and
  a budget per window of epochs that every operator move spends from. The bound is real but not small
  over long periods: it grows roughly with the square of the budget spent, so it protects against a
  theft noticed and revoked within hours to a day, not one left running for a week. See "Loss bound".
- **The ANCHOR is a price the owner states.** Each operator move is charged its distance from the
  anchor. Only two things move it: the owner stating it (`set_operator` when appointing, `set_anchor`)
  and a budgeted operator move (by at most what that move paid). Swaps and the owner's `deposit`,
  `withdraw` and `owner_rebalance` never move it. Stating an anchor sets the operator's allowance to
  zero; it then refills normally.
- **Two earlier versions were wrong**, and the reasons matter for any future change:
  1. The first cut (bd574a4) charged only the operator's own price change from the current price.
     A thief could shrink the curve, move its price with a small swap of his own, regrow it at that
     price for free, and trade it back: **4,500 B per cycle with zero budget** on an 18k/18k curve
     (test `shrink_swap_regrow_bypass_is_refused`).
  2. The second version (668f660) added the anchor and the depth charge, but **re-anchored on every
     owner call that touched the reserves**, at the curve's current price. That price is whatever the
     last swap left, so the thief could set it with his own capital. One routine profit-taking
     withdrawal then let the operator regrow at the thief's price paying only the depth term:
     **978.7 gained in one window** on an 18k/18k curve against a claimed bound of ~218, repeatable
     every window (independent audit M-1; tests `m1_attack_*`, now inverted and refused). The design
     document's claim that "the anchor moves only by budgeted calls" was false for that version.

## Roles

| Method | Owner (cold) | Operator (hot) | Anyone | Notes |
|---|---|---|---|---|
| `swap`, `swap_with_minimum`, `quote` | yes | yes | yes | unchanged; blocked while either pause is on |
| `reserves`, `inventory`, `fee_bps`, `is_paused`, `operator_status` | yes | yes | yes | reads; `operator_status` returns (badge, limits, allowance now, operator pause, anchor) |
| `deposit(a, b, expected)` | yes | no | no | into the reserves; **does not move the anchor** |
| `withdraw(amount_a, amount_b, expected)` | yes | no | no | from the reserves; does not move the anchor |
| `withdraw_all()` | yes | no | no | reserves AND inventory, no guard; fails if a NON-EMPTY vault is withdraw-frozen (see Decisions) |
| `deposit_inventory(a, b)` / `withdraw_inventory(amount_a, amount_b)` | yes | no | no | |
| `owner_rebalance(to_reserve_a, to_reserve_b, expected)` | yes | no | no | inventory <-> reserves, no limits, works while paused; does not move the anchor |
| `set_fee(bps)` | yes | no | no | cap 500 bps, fixed in code |
| `set_paused(bool)` | yes | no | no | the owner's pause: stops swaps, `rebalance` and `operator_set_fee`; the operator cannot clear it |
| `set_operator(Option<badge>, Option<(anchor_a, anchor_b)>)` | yes | no | no | appoint, replace, revoke; needs a proof of the new badge; **anchor required when appointing**; clears the operator pause; allowance to zero; **a revoke turns the owner's pause on**, as does any call made while the operator pause was on |
| `set_anchor(anchor_a, anchor_b, expected)` | yes | no | no | **new**: states the anchor price; allowance to zero |
| `set_operator_limits(budget_bps, window_epochs, cap_a, cap_b, floor_a, floor_b, min_fee, max_fee)` | yes | no | no | **two new arguments** (floors) |
| `rebalance(to_reserve_a, to_reserve_b, expected)` | **no** | yes | no | inventory <-> reserves, within limits; refused while owner-paused |
| `operator_set_fee(bps)` | **no** | yes | no | within [min_fee, max_fee] when min < max; refused while owner-paused |
| `set_operator_paused(bool)` | yes | yes | no | the operator's pause flag only; allowed while owner-paused (harmless) |
| native: `set_role("operator")`, owner role, royalties | no | no | no | `operator` is `updatable_by: [SELF]`; only `set_operator` (owner) changes it |
| native: metadata `name` | yes | no | no | unchanged from the audit |

The anchor is written as a pair (A, B): "B of token B for A of token A", e.g. `(1, 0.05)` for
0.05 B per A, or `(2000, 1)` for 1/2000 B per A. A pair is exact at any price (the cost is computed on
attos in I512), and it is the same form `operator_status` reports.

The owner deliberately does not satisfy the `operator` role: the owner's equivalent is
`owner_rebalance`, which has no limits. Every owner-only method was tried with the operator's badge
and refused; every operator method was tried with the owner's badge and by a stranger and refused
(tests `split_role_table`, `operator_cannot_extract_funds_by_any_method`; both include `set_anchor`).

### Operator appointment, replacement, revocation

- `set_operator(Some(badge), Some(anchor))` refuses the owner badge, XRD and both pool tokens ("Bad
  operator badge"), requires a proof of `badge` in the auth zone (the audit's L-1 lesson: a typo
  cannot appoint a stranger), and requires the owner to state the anchor ("State the anchor price";
  both parts > 0, "Bad anchor"). It then calls `Runtime::global_component().set_role("operator",
  rule!(require(badge)))`; the role is declared `operator => updatable_by: [SELF]`, and the engine
  resolves `SELF` to `require(global_caller(component))`
  (`radix-engine-1.4.0/src/system/system_modules/auth/authorization.rs:332`), so only the component
  itself can change the role. The owner cannot set it natively (tested), so the badge checks cannot
  be bypassed.
- Every `set_operator` call (appoint, replace, revoke) **clears the operator's pause flag** and sets
  the **allowance to zero**. A replacement does not inherit the old key's spent allowance or its
  anchor: the owner states a fresh anchor and the new operator's budget refills from zero over a
  window. Zero, not full, because whatever is granted up front is spendable at once by whoever holds
  the new key (or by a bot bug, or against a mistyped anchor); refilling from zero keeps "at most
  budget * T / window over T epochs" true from the moment of appointment. The cost is that the bot
  waits: at 300 bps per 72 epochs it has 0.42% of budget after 10 epochs, enough for small repricings.
- `set_operator(None, anchor)` sets the role to `deny_all`; the anchor is optional there.
- **A revoke turns the OWNER's pause on** (second split audit, Low-1). A thief holding the operator
  key can switch the operator pause on (so nobody trades the mispricing back), push the price over
  several windows, and wait: before this fix, revoking cleared the operator pause and so reopened
  swaps on the mispriced curve, and the thief took the mispricing in the next transaction (measured:
  15.05 after a two-window push at the defaults). Now `set_operator(None, …)` sets the owner's pause
  (and still clears the operator's flag, so a thief's pause never lingers); swaps stay closed until
  the owner has checked the curve and calls `set_paused(false)`. The config event
  (`OwnerPoolConfigEvent`, the same one `set_paused` emits) shows `paused: true`. Everything the owner
  needs works while paused: `owner_rebalance`, `deposit`, `withdraw`, `withdraw_all`, `set_anchor`,
  `set_operator`.
- **Replacing a key while the operator pause is on is the same hole**, so it gets the same rule: if
  the operator pause was on when `set_operator(Some(new), anchor)` is called, the owner's pause is
  turned on too (one call would otherwise clear the thief's pause and reopen swaps on the curve he
  mispriced behind it; stating a fresh anchor does not reprice the curve). Appointing or replacing
  while the operator pause is off leaves the owner's pause as it was: no surprise pause on a routine
  key rotation, and with swaps open the mispricing was already exposed to arbitrage. Tests
  `a2_revoke_alone_keeps_swaps_closed`, `a2_revoke_then_restore_then_reopen_leaves_thief_nothing`,
  `a2_appoint_and_replace_pause_rules`.
- Practical set-up with the Radix wallet: create the operator badge into the OWNER's account, call
  `set_operator` proving both badges in one wallet transaction, then send the operator badge to the
  bot's account. Replacing after a theft: revoke first, then create a new badge, same steps, then
  `set_paused(false)` (see the emergency procedure under Q7).
- The operator is optional. A new pool has none and no anchor (`instantiate` and
  `instantiate_with_liquidity` are unchanged: same four arguments), so the pool runs owner-only until
  `set_operator`; `set_operator(None, None)` returns it to owner-only at any time (paused, until the
  owner calls `set_paused(false)`). With the key lost,
  the owner keeps everything (`owner_path_works_with_operator_key_lost`).
- Operator badge custody rules are those of the owner badge (audit I-2): non-fungible, or 0-dp supply
  1, no minter, not recallable/freezable, updaters locked. A divisible operator badge's dust is full
  operator power.

## Mechanics of `rebalance` (lib.rs `move_inventory`)

Arguments are signed: positive moves inventory to reserves, negative moves reserves to inventory.
Checks, in order:

0. The owner's pause is off ("Paused by the owner").
1. `expected` reserves guard (as for `deposit`, audit M-1).
2. Both reserves > 0 before ("Pool is empty") and after ("Operator cannot empty a side").
3. If either side is raised, **both** reserves after must be at or below the caps
   ("Above the operator's reserve cap"). Lowering is allowed even above a cap.
4. A side that is lowered must end at or above its floor ("Below the operator's reserve floor").
   Raising is allowed even below a floor (a swap may have taken a side under it).
5. Cost, from the budget ("Operator price-move limit"). With current reserves (Ra, Rb), price
   P = Rb/Ra, new reserves (Ra', Rb'), price P', and anchor price A:

       cost = max(d(P, P'), d(A, P')) + max(0, Ra'Rb'/(Ra Rb) - 1) / 2
       d(x, y) = max(x/y, y/x) - 1

   computed exactly on attos in I512 and rounded up. Each term is at least the matching log change
   (d(x, y) >= |ln(y/x)|, and (k'/k - 1)/2 >= ln sqrt(k'/k)), so the budget bounds the operator's
   cumulative log path in price, measured both from where the curve is and from the anchor, and in
   depth. Exception: an exactly proportional decrease (no raise, price unchanged) is free and does not
   move the anchor; it only shrinks the curve, and only down to the floors.
6. After a costed move the anchor becomes the new reserves' price. It moved by at most d(A, P') <=
   cost. Owner calls never set it implicitly.

Budget: `allowance` refills linearly at `budget / window_epochs` per epoch, never above one budget.
So over any T epochs the operator can spend at most `budget * (1 + T / window)` (or
`budget * T / window` counting from an appointment or a `set_anchor`); splitting a move into many
small calls gains nothing. New limits clip the allowance down, never top it up.

Defaults at instantiation: no operator, anchor (0, 0) (none), budget 0, caps 0, **floors
Decimal::MAX, fee range [0, 0]**: an operator appointed before `set_operator_limits` can do nothing
that costs budget, raises or lowers a reserve, or changes the fee. A fee range of one value
(min == max) gives the operator no fee power at all ("The operator may not change the fee"); before,
the default range was [instantiation fee, instantiation fee], so after an owner `set_fee` the
operator could set the fee back (audit I-b).

What a legitimate bot pays: following the market costs the market's path between its re-pricings
(d from the anchor, not from where arbitrage already took the curve). A one-sided ADD costs about
1.5x its price move (price plus depth); a one-sided REMOVAL costs only the price move; sweeping
profit out of the curve proportionally is free (down to the floors). A bot should reprice with a
dead-band (e.g. only when off by >= 0.5%) and prefer removals.

If the OWNER reprices the curve (a one-sided `deposit`, `withdraw` or `owner_rebalance`), the anchor
stays where it was, and the bot pays the distance from it on its next move. The owner should add
`set_anchor` with the new market price to the same transaction (which zeroes the allowance).

## Bypasses considered

| Bypass | Outcome | Why / test |
|---|---|---|
| Call a withdraw path with the operator badge | refused | role table; `operator_cannot_extract_funds_by_any_method` (19 calls + 5 native module calls; operator balances unchanged, component total unchanged) |
| Many small moves | no gain | refill is continuous; 49 moves of 0.2% spent 0.0982 and moved the price by 1.1031 <= e^0.1 |
| Move both sides at once | charged | cost uses the ratio of the two prices; opposite-direction moves cost the product |
| Spend across windows | bounded | over 30 epochs with window 10, spent 0.3006 of at most 0.4 |
| Reset loop (misprice, trade back, misprice again) | charged every time | d(P, P') counts the move back from the market price; test B: 7 cycles gained 2.94 vs 20.57 for one extraction |
| Pause games (operator pauses so nobody else trades the mispricing back, keeps pushing over several windows) | bounded, included in the bound | test C; the owner's pause now stops `rebalance` too |
| Fee games (set fee 0 for own trades, or 5% to keep arbitrageurs out) | bounded by owner's fee range | the bound assumes fee 0 (worst case); default range gives no fee power |
| Empty one side into inventory | refused | "Operator cannot empty a side" |
| Shrink to dust (griefing: the curve unusable until the owner acts) | refused below the floors | audit L-1; `l1_dust_shrink_is_refused_by_the_floor` |
| Shrink / own swap / regrow at the swapped price | refused | broke the first cut (4,500 per cycle, zero budget); the regrow pays d(A, P') + depth growth (`shrink_swap_regrow_bypass_is_refused`) |
| Shrink / own swap / wait for any owner reserve call / regrow at the swapped price | **refused** | broke the second version (978.7 in one window, repeatable); owner calls no longer move the anchor (`m1_attack_owner_call_resets_anchor_to_thief_price_is_refused`, `m1_attack_repeats_every_window_after_one_owner_call_is_refused`) |
| Move the price with own capital, then have the operator add at that price | refused | d(A, P') ~ 0.78 > budget (test E) |
| Anchor off the market (owner stated a stale or wrong price, or the market moved while the bot was stopped): shrink, own-capital push to the anchor, regrow at the anchor, sell back, every window | **residual, bounded by D** | the regrow pays only depth, so the take per unit of budget is ~ S * 4 sinh^2(D/4); with the anchor 20% off: 38.9 over 3 windows, bound 3,196 (`m1_owner_stated_off_market_anchor_cycles_are_bounded`); test D for market drift |
| Owner sets roles natively to bypass `set_operator` checks | refused | `updatable_by: [SELF]` |
| Raise above caps | refused | both sides after any raise must be within the caps |

## Loss bound

Notation: P* market price (B per A); S = sqrt(cap_a * cap_b * P*) (half the market value of a
balanced curve at the caps; if the owner himself funded the curve above the caps, use that curve's
sqrt(Ra Rb P*) instead); C = total budget the thief spends; fee 0 (worst case);

**D = the largest log distance, during the theft, between the market price and the anchor the theft
started from.** That anchor is the price the owner last stated (`set_operator`, `set_anchor`) or
where the legitimate bot last moved the curve with a budgeted `rebalance`. D therefore consists of
(i) how wrong or stale that price was when the theft started and (ii) how far the market moves while
the theft lasts. D is no longer settable by a thief: swaps and owner reserve calls do not move the
anchor, and the operator's own moves move it by at most what they cost, which is counted in C (that
is the 2C in the bound below).

**Bound.** The thief's total gain from operator powers is at most

    G <= S * C * psi(D + 2C),   psi(x) = 2 (cosh(x/2) - 1) + sinh(x/2),   C <= budget * (1 + T / window)

Sketch: let Phi be what an arbitrageur could take from the curve right now,
Phi = (sqrt(Ra P*) - sqrt(Rb))^2 = L sqrt(P*) * 4 sinh^2(X/4) with L = sqrt(Ra Rb) and X the log
distance of the curve's price from P*. A swap at fee 0 moves exactly its gain out of Phi (the
thief's own swaps cost him what they add), so the thief's net gain is at most the sum of the
increases of Phi caused by operator calls. (Owner calls are the owner's own actions; withdrawals and
owner moves that reduce mispricing only lower Phi. An owner DEPOSIT at a price someone has moved is
exposed to that person, operator or not: check the curve's price against the market before adding
depth.) For one operator call, split into a depth change at P then a price change at L': the depth
part is at most L * (L'/L - 1) * sqrt(P*) * phi(X) <= S * c_depth * phi(X), the price part at most
L' * sqrt(P*) * sinh(X_max/2) * |ln(P'/P)| <= S * c_price * sinh(X_max/2), using L, L' <=
sqrt(cap_a cap_b) (the caps after any raise; swaps keep L; decreases lower it). Both the curve's
price before and after the call lie within 2c (resp. c) of the anchor, because cost includes
d(P, P') and d(A, P'); and the anchor moves only by budgeted operator calls (by at most their cost)
or by the owner stating it, so during a theft its distance from the market is at most D + C. Summing
gives the bound. Without the anchor term the price before a call is unconstrained (the thief sets it
with his own swaps); with an anchor that follows owner calls it is unconstrained again as soon as the
owner touches the reserves (M-1); without the depth term L' is unconstrained at zero cost.

Shrinking does not escape the bound: regrowing from L_s to L' costs at least ln(L'/L_s) >=
(L' - L_s)/L', so the depth gain (L' - L_s) * phi(X) is at most L' * phi(X) per unit of budget. The
floors only make the shrink shallower.

Bound as a % of S:

| C (budget spent) | D = 0 | D = 0.01 | D = 0.05 | D = 0.1 | D = 0.2 |
|---|---|---|---|---|---|
| 0.02 | 0.04% | 0.05% | 0.09% | 0.15% | 0.27% |
| 0.05 | 0.26% | 0.29% | 0.40% | 0.55% | 0.87% |
| 0.10 | 1.10% | 1.16% | 1.41% | 1.73% | 2.41% |
| 0.20 | 4.83% | 4.97% | 5.55% | 6.31% | 7.90% |
| 0.30 | 11.86% | 12.10% | 13.12% | 14.43% | 17.19% |
| 0.50 | 38.82% | 39.36% | 41.57% | 44.42% | 50.38% |

**Worked numbers at the recommended defaults** (budget 300 bps per 72-epoch window; caps = reserves
+10%; example curve 18k/18k at P* = 1, so caps 19.8k and S = 19,800; theft starts with a full
allowance):

| Theft lasts | C at most | D = 0 | D = 0.05 | D = 0.1 |
|---|---|---|---|---|
| one burst (0 epochs) | 0.030 | 0.093% = 18.4 | 0.174% = 34.5 | 0.259% = 51.4 |
| 12 epochs (~1 h) | 0.035 | 0.127% = 25.1 | 0.223% = 44.1 | 0.323% = 64.0 |
| 72 epochs (~6 h) | 0.060 | 0.382% = 75.6 | 0.554% = 109.7 | 0.734% = 145.3 |
| 288 epochs (~24 h) | 0.150 | 2.60% = 514.1 | 3.10% = 613.6 | 3.62% = 717.2 |

(Epoch length on mainnet taken as about 5 minutes: not verified here.) D = 0.05 means the anchor is
5% off the market: e.g. the bot stopped and the market moved 5%, or the owner stated a 5%-stale price.

**Measured** (best strategies tried; curve 18k/18k at P* = 1, inventory 10k/10k, caps 20k, so
S = 20,000; budget 10% per 100 epochs; fee 0; floors 0, the thief's best case):

| Strategy | Budget spent | Thief gain = owner loss | Bound |
|---|---|---|---|
| A: push with the full budget, trade back once | 0.0999 | 20.57 (0.10% of S) | 220.3 |
| B: ~1% push / trade back, repeated | 0.0999 | 2.94 | 220.3 |
| C: operator-pause on, push over 5 windows, trade back once | 0.4999 | 799.3 (4.0% of S) | 7,762 |
| D: market +20% while the bot is stopped; thief pushes further | 0.0999 | 151.9 extra over the 164.0 any arbitrageur would take | 501.6 |
| E: own-capital mispricing, then operator move | refused | 0 | - |
| first cut, shrink / swap / regrow (bd574a4) | 0 | 4,500 per cycle, repeatable | none |
| second version, M-1: shrink / swap / owner withdraw / regrow (668f660) | ~0.0995 | 978.7 in one window, repeatable | (claimed 218) |
| M-1 after the fix | refused | thief ends -1.5 | - |
| anchor stated 20% off market, shrink / push / regrow / sell, 3 windows | 0.2936 | 38.9 (13.0 per window) | 3,196 |

The measured attacks track the simpler single-extraction estimate S * 4 sinh^2(C/4) plus, with an
off-market anchor, S * C * 4 sinh^2(D/4) (48.8 for the last row) better than the proven bound,
which is 4-80x looser. No attack near the proven bound was found; that does not mean none exists.

**Honest statement.** The split guarantees that the operator key alone cannot move a token out of
the component, and that whatever a thief extracts through trading against a mispriced curve over T
epochs is at most S * C * psi(D + 2C) with C <= budget * (1 + T / window). That bound is small for a
theft revoked within the first window (at the defaults: under 0.4% of S in 6 hours with an accurate
anchor) and becomes large, then vacuous, if it runs for many windows. It scales with S (the caps)
and with D. D is now only what the owner and the market make it: an anchor the owner states
carelessly (taken from the curve rather than the market, or a typo) or one left stale while the
market moves is exposure, at about S * 4 sinh^2(D/4) per unit of budget per window. Keep the anchor
fresh: the bot's own budgeted moves keep it on the market; after a large market move with the bot
stopped, the owner should `set_anchor` (or revoke).

What the split does **not** protect:
- the reserves against ordinary arbitrage when the price is stale (unchanged from today);
- against a thief who keeps the key for many windows unnoticed: detection and revocation are part
  of the design (see Q6);
- against an owner-stated anchor far from the market (that is D, above);
- against the owner adding depth at a price someone else has moved (check before depositing);
- against loss or theft of the OWNER badge (still total, permanent control; audit I-2/opinion c);
- against token-issuer powers on the pooled tokens (audit I-1);
- third parties trading at the curve's price (takers who skip a minimum-output assertion).

## Decisions taken (with reasons)

- **The anchor is stated, never inherited from the curve.** At instantiation there is none; it is
  stated by the owner when appointing an operator (required), and with `set_anchor` at any time.
  Owner reserve calls keep their signatures and do not touch it (the owner composes `deposit` +
  `set_anchor` in one manifest when he reprices). Anchor statements zero the allowance (audit M-1 c).
- **Reserve floors** (audit L-1): absolute per side, next to the caps, `floor <= cap` enforced
  ("Floor above cap", so swapped arguments are caught). Default Decimal::MAX: no lowering at all until
  the owner sets limits.
- **The owner's pause is a full stop for the hot key**: swaps, `rebalance` and `operator_set_fee` are
  refused while it is on. `set_operator_paused` stays allowed (it changes nothing that trades while
  the owner's pause is on). The owner's own calls, `owner_rebalance` included, work while paused.
- **Every `set_operator` clears the operator's pause** (audit I-a), **and none reopens swaps**: a
  revoke, or any call made while the operator pause was on, turns the owner's pause on (second split
  audit, Low-1). The owner reopens with `set_paused(false)` once the curve is right.
- **Fee range of one value = no operator fee power** (audit I-b); default [0, 0]. With a real range
  [min, max] the operator can still set any fee inside it, including undoing an owner `set_fee`
  inside the range: that is what the range grants.
- **Replacement starts at zero allowance and a fresh, stated anchor** (audit I-d); reasons above.
- **`withdraw_all` fails if a non-empty vault is withdraw-frozen** (owner pool audit I-6, kept): a
  failed vault take aborts the whole transaction and cannot be caught in Scrypto, so a "take what you
  can" variant is not possible; zero amounts skip their vault, so a frozen EMPTY vault does not block
  it. Fallback, per vault: `withdraw(0, x, None)`, `withdraw(x, 0, None)`, `withdraw_inventory(0, x)`,
  `withdraw_inventory(x, 0)`. Documented in the code comment.
- **Swap fees accrue to the trading reserves**, as now. The bot can sweep profit to inventory with a
  free proportional decrease (down to the floors). A thief cannot take fees out either.
- **Instantiation is unchanged** (four arguments, owner badge proof, XRD/pool-token badges refused).
- **Kept from the audit, re-run:** rounding direction and k never falls, quote == swap, owner role
  fixed, no royalties, reserves guard.

## API changes the bot and the TypeScript must follow

- `set_operator(badge: Option<ResourceAddress>, anchor: Option<(Decimal, Decimal)>)`: second
  argument new; `Some((a, b))` required when appointing.
- `set_anchor(anchor_a: Decimal, anchor_b: Decimal, expected: Option<(Decimal, Decimal)>)`: new,
  owner only. Take the price from the MARKET (an exchange or aggregator), never from `reserves()`.
  Tooling should warn when the stated anchor is far from the curve's price, but must not compute it
  from the curve.
- `set_operator_limits(budget_bps, window_epochs, cap_a, cap_b, floor_a, floor_b, min_fee, max_fee)`:
  two new arguments (floors) after the caps.
- `OperatorLimits` (in `OwnerPoolOperatorEvent` and `operator_status`) has `min_reserve_a`,
  `min_reserve_b` after `max_reserve_b`.
- New event `OwnerPoolAnchorEvent { anchor_a, anchor_b }`.
- New failure messages: "Paused by the owner", "Below the operator's reserve floor", "The operator
  may not change the fee", "State the anchor price", "Bad anchor", "Negative floor", "Floor above cap".
- The bot: after an owner `set_anchor` or a replacement its allowance is zero; its `rebalance` fails
  "Operator price-move limit" until it refills. Read `operator_status` before moving.
- **Revoke pauses (second split audit, Low-1).** After `set_operator(None, …)`, and after a
  replacement made while the operator pause was on, `is_paused()` is true, the owner's flag is set
  (`OwnerPoolConfigEvent { paused: true, operator_paused: false }`), swaps and `quote` fail "Swaps are
  paused", and a new operator's `rebalance` / `operator_set_fee` fail "Paused by the owner" until the
  owner calls `set_paused(false)`. Owner tooling must offer that step after a revoke; the
  exchange's UI should show the pool as paused. No signature changed.
- **`OwnerPoolRebalanceEvent.allowance`** (second split audit, Low-2) is now the allowance available
  right after the move, refill included, i.e. what `operator_status` returns at that point. It used
  to be the stored value, which on a free proportional decrease or an owner move read too low (0
  while the operator held the full budget). Event shape unchanged; only the value's meaning.

## Costs

- **Swap gas:** steady-state swap on a 10k/10k pool, same manifest: 8,067,789 execution cost units
  on c8c2be0; 8,681,560 on the split before these fixes; **8,725,205** now (+43,645, +0.5%; +8.1% vs
  c8c2be0); **8,724,242** after the second audit's fixes (release run; the swap path is untouched,
  `set_operator` and the rebalance event changed). The swap code is unchanged apart from the extra state read (two more Decimals in the
  limits); the increase is the larger component state and wasm read on every call.
- One-sided adds cost the bot 1.5x budget (see above).

## Open questions for the owner (recommended defaults)

1. **Budget and window.** Recommended: budget 300 bps per 72-epoch window (about 6 h if epochs are
   about 5 minutes on mainnet; not verified here). Worst case at D = 0: about 0.13% of S in the first
   hour, 0.38% in 6 h, 2.6% in 24 h (table above). Measure the bot's real spend on Stokenet first and
   set the budget to about twice that.
2. **Caps.** Set them to the curve size you actually want on the curve (e.g. the current reserves
   plus 10%); the loss bound scales with sqrt(cap_a * cap_b). Keep the rest in inventory, or better,
   in the cold account.
3. **Floors.** Recommended about half of the curve you want (e.g. 50% of the current reserves). The
   bot's sweeps and one-sided removals stay well inside that; a thief can then halve the curve, not
   brick it.
4. **Anchor.** State it from the market when appointing; re-state it with `set_anchor` whenever you
   reprice the curve yourself or the market moved while the bot was stopped. Each statement zeroes
   the bot's allowance for up to one window: acceptable?
5. **Operator fee range.** Recommended [10, 100] bps, or [0, 0] (the default: no fee power) if the
   bot does not need it. A floor above 0 keeps every taker, the thief included, paying something.
6. **Operator pause.** Kept (the bot can stop trading in a crash; the owner can always clear it).
7. **Monitoring (off ledger, strongly recommended).** Alert on every `OwnerPoolRebalanceEvent`
   whose `cost` is unusual, on `allowance` near zero (the event's `allowance` is now the allowance
   available after the move, refill included), on any `OwnerPoolAnchorEvent` you did not send,
   and on the curve's price or the anchor leaving the market by more than the bot's dead-band. The
   bound is small only if revocation is quick.

   **The worst attack does not look like an attack** (second split audit). The largest multi-window
   gains need no pause: each window the thief takes the curve to the anchor with his own capital,
   spends the window's budget pushing it further, and buys back to the market. On ledger that is an
   operator `rebalance` followed by what looks like ordinary arbitrage. So the alerts must key on
   operator `OwnerPoolRebalanceEvent`s that spend MOST of the allowance (a legitimate bot with a
   dead-band spends small slices), and on the ANCHOR drifting away from the market window after
   window (`operator_status` / the reserves after each operator move); a pause, or a big swap, is not
   a reliable signal. The audit's measured gains were 20-50% of the proven bound: one window 3.6, and
   24 h about 91-96 (with and without the pause) on an 18k/18k pool at the suggested defaults.

   **Emergency procedure (key stolen or bot misbehaving):**
   1. **Revoke first**: `set_operator(None, None)` from the wallet. The pool is then closed (the
      revoke turns the owner's pause on); the old key can do nothing.
   2. Check the curve against the MARKET price. If it is off, restore it with `owner_rebalance`
      (guarded with `expected` = the reserves you saw), or `deposit` / `withdraw`.
   3. If re-appointing (a NEW badge), state the anchor from the market:
      `set_operator(Some(new_badge), Some(anchor))`.
   4. Reopen: `set_paused(false)`. Steps 2-4 may share one transaction.
8. **Oracle.** A real price band needs a trusted on-ledger price; none is used. Not recommended now.
9. **Owner role.** Still one fixed badge. A multi-signature owner (`OwnerRole::Fixed(any access
   rule)`) is possible but not done.
10. **Gas** +0.5% over the split, +8.1% per swap over c8c2be0: acceptable?

## Tests

`scrypto/owner-pool/tests/owner_pool_split.rs` (8): `split_role_table`,
`operator_cannot_extract_funds_by_any_method`, `operator_limits_within_and_across_windows`,
`revoke_and_replace_operator`, `owner_path_works_with_operator_key_lost`,
`inventory_is_not_traded_and_fees_stay_in_reserves`, `stolen_operator_key_attack_is_bounded`,
`shrink_swap_regrow_bypass_is_refused`; adapted to the new arguments, with added checks for the
default limits, the floors, `set_anchor` in the role tables, owner deposits not moving the anchor,
and appointment without an anchor.

`scrypto/owner-pool/tests/owner_pool_split_audit2.rs`, the second audit's file: attack measurements at
the suggested defaults, plus its two Low findings inverted after the fixes
(`a2_revoke_alone_keeps_swaps_closed`, `a2_rebalance_event_allowance_is_current`) and two new tests
(`a2_revoke_then_restore_then_reopen_leaves_thief_nothing`, `a2_appoint_and_replace_pause_rules`).
`revoke_and_replace_operator`, `owner_path_works_with_operator_key_lost` and
`informational_revoke_pause_fee_range_inheritance` now expect the owner's pause after a revoke.

`scrypto/owner-pool/tests/owner_pool_split_audit.rs` (7), the independent audit's file, inverted:
`m1_attack_owner_call_resets_anchor_to_thief_price_is_refused`,
`m1_attack_repeats_every_window_after_one_owner_call_is_refused`,
`m1_owner_stated_off_market_anchor_cycles_are_bounded` (new),
`l1_dust_shrink_is_refused_by_the_floor`, `informational_revoke_pause_fee_range_inheritance`,
`set_anchor_states_price_and_zeroes_allowance` (new), `budget_refill_edges`.

Earlier suites: `owner_pool_proposal.rs` (15) and `owner_pool_audit2.rs` (17), unchanged by these
fixes.

After the second audit's fixes (release run:
`CRATE=owner-pool TARGET_VOLUME=radix-dex-target-audit3 scrypto/run.sh test --release -- --nocapture`):
`owner_pool_audit2` **17 passed**, `owner_pool_proposal` **15 passed**, `owner_pool_split` **8 passed**,
`owner_pool_split_audit` **7 passed**, `owner_pool_split_audit2` **11 passed**. Total 58 passed, 0 failed.

Earlier run (before the second audit): `CRATE=owner-pool TARGET_VOLUME=radix-dex-target-pool-split scrypto/run.sh test`.
Result (one full run, about 15 min wall): `owner_pool_audit2` **17 passed** (688 s), `owner_pool_proposal`
**15 passed** (163 s), `owner_pool_split` **8 passed** (72 s), `owner_pool_split_audit` **7 passed**
(10 s). Total 47 passed, 0 failed.

## Not verified

- Simulator only (scrypto-test 1.4.0); not run on Stokenet or mainnet.
- The bound is a hand derivation (sketched above), not machine-checked; the tests check the measured
  attacks against it but cannot show no better attack exists.
- Epoch length on mainnet (taken as about 5 minutes for the recommendations).
- The bot and the exchange's TypeScript were not changed or reviewed; they need the new manifests
  (`set_operator` with an anchor, `set_anchor`, `set_operator_limits` with floors, `rebalance` with
  the operator badge and `expected` guard).
