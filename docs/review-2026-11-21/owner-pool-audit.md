# OwnerPool: independent audit

Subject: `scrypto/dex-contracts/src/owner_pool.rs`, blueprint `OwnerPool`, at commit `054bd6f`
(branch `pool-audit`). Tests added: `scrypto/dex-contracts/tests/owner_pool_audit2.rs`.
Engine: `scrypto` / `scrypto-test` / `radix-engine` **1.4.0** (Cargo.lock). Every engine file this
review relies on (PreciseDecimal and Decimal maths, fungible vault take/put, worktop drop, fungible
proofs, authorization, `check_fungible_amount`, the fungible resource manager) is byte-identical
between the 1.4.0 crates in the build's cargo registry and the `develop` checkout under `.repos`, so
there is no version gap on any point below.

The authors' report (`pool-audit.md`, section 3) was read only after the findings below were formed.

## Verdict

**Fit to publish after the listed fixes.** No path was found by which a non-owner can take reserves,
get more than the constant-product formula allows, or stop the owner withdrawing. The rounding is
correct in the pool's favour on every path, and auth is sound. What remains is about protecting the
owner from his own operations: one Medium (deposits and withdrawals have no price guard, so a bot's
one-sided price move can be sandwiched) and one Low (a mistyped badge at instantiation hands the pool
away for ever). Both are cheap to fix and cannot be fixed after publishing.

## Findings

| Id | Severity | Title |
|----|----------|-------|
| M-1 | Medium | `deposit`/`withdraw` have no guard on the pool state they were computed against; a one-sided price move by the bot can be sandwiched |
| L-1 | Low | Instantiation accepts any resource as the owner badge, without proof the caller holds it |
| L-2 | Low | `quote` ignores `paused`, returns 0 where `swap` panics, and accepts amounts no bucket can hold |
| L-3 | Low | The blueprint lives in the crate that produced the published package; building it changes that package's reproducible wasm |
| I-1 | Info | A token whose issuer can recall (or mint) lets the issuer drain the other side |
| I-2 | Info | `require(badge)` accepts any amount of the badge; a divisible badge's dust is full ownership |
| I-3 | Info | 36-digit truncation of `share` under-pays takers at extreme ratios (never over-pays) |
| I-4 | Info | Fee product overflows above ~1.16e38 input at 500 bps (unreachable) |
| I-5 | Info | Anyone can instantiate an `OwnerPool` naming the owner's badge; solvers must pin addresses |
| I-6 | Info | Deposit-frozen side: the owner must pass `None`, not an empty bucket; `withdraw_all` fails on any frozen vault |
| I-7 | Info | Events and metadata: correct; small additions suggested |

No Critical or High finding.

### M-1 (Medium): owner liquidity moves have no state guard

Lines 198-211 (`deposit`), 216-223 (`withdraw`). The blueprint's own design note (lines 14-15,
196-197) is that a market-making bot moves the price by depositing or withdrawing one side. The
amounts are computed off-ledger from reserves the bot read earlier, but neither method lets the
caller say "only if the reserves are still (Ra, Rb)". A manifest cannot assert on a returned
`Decimal`, so the bot has no clean way to make its transaction fail if the pool moved first.

Scenario (test `audit_m1_one_sided_deposit_can_be_sandwiched`, 30 bps fee): pool 10,000 A /
10,000 B. The bot wants A at 0.5 B and deposits 10,000 A alone. A taker sells 2,000 A just before
the deposit lands and sells the B he got just after. He ends with about **+1,648 A** (an 82% gain on
the position); the owner's pool holds ~18,352 A instead of 20,000 A, the same B. Around a
proportional deposit the same taker loses his fees. Withdrawing one side has the mirror-image
exposure. Even without a deliberate attacker, any ordinary swap that lands between the bot's read and
its deposit makes the deposit overshoot the intended price, and the overshoot is free money for the
next arbitrageur.

How realistic: Radix has no public priority-gas auction, but transactions are gossiped before
commit, and a bot that re-prices often gives many chances. The loss is bounded by the size of each
price move, and is paid from the owner's funds.

Workaround with today's code: start the bot's manifest with two dust swaps (one each way) followed by
`ASSERT_WORKTOP_CONTAINS` at the expected rate. That bounds the price on both sides, but costs fees
and is coarse for low-divisibility tokens.

Minimal fix (keeps the current methods): add an optional guard to both methods, e.g.

```rust
pub fn deposit(&mut self, a: Option<FungibleBucket>, b: Option<FungibleBucket>,
               expected: Option<(Decimal, Decimal)>) {
    if let Some((ea, eb)) = expected {
        assert!(self.vault_a.amount() == ea && self.vault_b.amount() == eb, "Reserves moved");
    }
    ...
```

(and the same parameter on `withdraw`). Exact equality is right here: the owner is the only one who
needs it and he can re-read and retry; a tolerance band (`min/max` on Ra/Rb) is a fine alternative.

### L-1 (Low): any resource accepted as the owner badge, no proof required

Lines 102-110, 132. `owner_badge` is a bare `ResourceAddress`. Nothing checks that the caller holds
it or that it is a badge-like resource. Naming a widely held resource by mistake (XRD, one of the
pool's own tokens, a copy-pasted wrong address) makes every holder the owner; with
`instantiate_with_liquidity` the seed is lost in the same transaction, and `OwnerRole::Fixed` means
it can never be corrected. Test `audit_l1_wrong_badge_at_instantiation_is_irreversible` creates a
pool whose "badge" is token B; a stranger holding 1 B calls `withdraw_all` and takes everything.

Fix (two lines in `build`):

```rust
Runtime::assert_access_rule(rule!(require(owner_badge)));          // caller must present it
assert!(owner_badge != resource_a && owner_badge != resource_b && owner_badge != XRD, "Bad owner badge");
```

The first line means the instantiating manifest must put a proof of the badge in the auth zone, which
also catches typos (a resource he does not hold cannot be proved). Optionally also require
`ResourceManager::from(owner_badge).total_supply() == Some(dec!(1))`.

### L-2 (Low): `quote` disagrees with `swap` in three edge cases

Lines 155-157 vs 164-170, 259. For a funded, unpaused pool and a bucket-representable amount, `quote`
equals what `swap` pays exactly (checked on 1,561 executed swaps, below). But:

1. while paused, `quote` returns a positive amount and `swap` panics "Swaps are paused";
2. for dust, `quote` returns 0 and `swap` panics "Trade too small";
3. `quote` accepts amounts with more decimals than the input token allows (e.g. 20.5 of a 0-dp
   token) and returns a number no real swap can produce.

None loses money; a solver that trusts `quote` alone builds failing transactions. Test
`audit_l2_quote_vs_swap_when_paused_or_dust`. Fix: in `quote`, `assert!(!self.paused, ...)` (or
return 0 and document it) and reject amounts not representable at `div_in`
(`input_amount.checked_round(div_in, ToZero) == Some(input_amount)`). Alternatively document all
three in the doc comment; solvers should also read `is_paused()`.

### L-3 (Low): published package's reproducibility

`src/lib.rs` line 18 adds `pub mod owner_pool` to the crate whose wasm is the published package
`package_rdx1p45x…` (the authors verified a byte-identical rebuild; `pool-audit.md` lines 195-200).
With the module present, a fresh build of this crate no longer reproduces that wasm, so the
verification breaks, and publishing this crate as-is would publish second copies of `Pool`,
`OrderBook` and `OrderRegistry` at new addresses. Fix: move `OwnerPool` to its own crate (see
opinion (a)) and remove the module from `dex-contracts`.

### I-1 (Info): issuer powers on a pooled token

Test `audit_recallable_token_lets_issuer_drain_other_side`: pool 1,000 R / 1,000 B where R is
recallable; the issuer recalls 990 R from the pool vault and sells it straight back in, taking ~990
B for nothing. Reserves-are-vault-balances (line 143-145) prevents bricking but cannot prevent this;
neither can any AMM. The same holds for a token whose minter can mint and dump, and for a
withdraw rule later set to deny (funds then stuck for good). Operating rule: only pair tokens whose
recaller, freezer, minter and withdraw/deposit roles are `DenyAll`/`AllowAll` **and locked**; check
on the Gateway before instantiation. An on-ledger check at instantiation is possible but the roles
API surface is large; operational checking is adequate.

### I-2 (Info): badge amount is not checked

Line 132. `require(resource)` matches any proof of that resource, of any non-zero amount (engine
`authorization.rs` lines 37-40). With an 18-dp badge, 1e-18 of it is full ownership (test
`audit_auth_divisible_badge_fraction_is_full_owner`). Empty proofs are refused by the engine
(`EmptyProofNotAllowed`), and look-alike resources fail (test
`audit_auth_lookalike_empty_and_no_proof`). Use a non-fungible badge, or a 0-dp fungible with supply 1
and no minter. See opinion (c).

### I-3 (Info): precision at extreme ratios

Lines 269-272. `share = eff / (r_in + eff)` is truncated to 36 decimals, then multiplied by `r_out`.
When `share` is around 1e-33 only about 3 significant digits survive. Example (test
`audit_extreme_ratio_precision_underpays_taker_only`): reserves 4e27 / 4e27, input 4.567891234567e-6:
the taker is paid ~0.07% less than the exact formula. The error always favours the pool, and the
bound `exact - paid <= r_out * 1e-36 + 1 unit` held on every swap in the matrix. A fix
(`r_out * eff / (r_in + eff)` in I512 attos, or multiply first when it fits) is optional.

### I-4 (Info): fee product overflow

Lines 172 and 262: `PreciseDecimal::from(input_amount) * PreciseDecimal::from(fee_bps)` overflows
`PreciseDecimal::MAX` (~5.79e40) when input x bps > 5.79e40, i.e. inputs above ~1.158e38 at 500 bps
(above ~3.1e39/bps generally; never at fee <= 18 bps). The swap panics: no loss. Unreachable in
practice: one mint is capped at 2^152 attos (~5.7e27 tokens). Test
`audit_fee_product_overflow_threshold`. If touched anyway: `input * (fee_bps / 10000)`.
Everything else is safe up to `Decimal::MAX` on both reserves: `r_in + eff` < 6.3e39, the division
and multiplication use I384 intermediates, and the output is below `r_out`.

### I-5 (Info): look-alike components

`instantiate` and `instantiate_with_liquidity` are public functions (as they must be). Anyone can
create an `OwnerPool` with the owner's badge as owner and arbitrary tokens, named "radix-dex owner
pool" (test `audit_l1_...`, second half: harmless to the owner, who can withdraw whatever a stranger
put in). Solvers and the exchange must list pools by component address only.

### I-6 (Info): freezes

Lines 216-223 and the 054bd6f change: verified correct. A zero amount does not touch its vault;
`FungibleBucket::new` makes an empty bucket; the worktop drops empty buckets at the end. Extra facts
(test `audit_frozen_both_ways`): with the A vault frozen for withdraw AND deposit, the owner still
gets all of B via `withdraw(0, b)` and can still `deposit(None, Some(b))`; `deposit(Some(empty A),
..)` fails because the engine refuses any put into a deposit-frozen vault, even of zero
(`fungible_vault.rs` line 344); `withdraw_all` fails while any side is withdraw-frozen. The bot
should know to fall back to `withdraw(0, x)` / `None`.

### I-7 (Info): events and metadata

Swap events were checked on every matrix swap: `input_amount`, `output_amount`, `fee` (equal to the
exact ceil fee), `output_resource`, reserves after. Liquidity events carry signed amounts and
reserves after; `withdraw(0, 0)` emits a zero event (harmless). Config events are emitted on every
call, even when nothing changes (harmless). Metadata: `resource_a`/`resource_b` locked (owner cannot
change them, tested), `name` updatable by the owner only. Suggest adding `description` and a
`dapp_definition` later; the owner can, since the metadata setter falls back to the owner role.
The owner role is `Fixed`: `set_owner_role`, `lock_owner_role`, `set_role` for "owner" or any new
role, and `set_component_royalty` all fail (test `audit_roles_metadata_royalty_are_fixed`). No
royalty module is attached and the blueprint has no package royalties.

## What was checked and found sound

- **Constant product and rounding.** Fee rounded up at the input's divisibility (lines 171-174,
  261-264), output rounded down at the output's (line 272), `share` truncated down (PreciseDecimal
  division is integer division on I384, i.e. towards zero, `precise_decimal.rs` 1.4.0 lines 438-451).
  Hence `paid <= r_out * eff / (r_in + eff)` and `(r_in + input)(r_out - paid) >= r_in * r_out`
  exactly. Checked in I512 on attos for every swap in a matrix of input divisibility {0,1,2,6,17,18}
  x output divisibility {0,1,6,17,18}, fees {0, 30, 500} bps, reserves tiny (3 and 5 units), normal,
  huge (1e26 each), and both extreme ratios (1 unit vs 1e26), inputs of 1 unit, 7 units, 0.1% of the
  reserve, 100% and 300% of the reserve, both directions: 1,561 executed swaps, plus 1,310 inputs
  for which `quote` returned 0 and `swap` was confirmed to fail "Trade too small" (mostly 1-unit and
  7-unit inputs at 5% fee or into the 1-unit side). No swap paid more than exact, none emptied a
  side, k never fell, quote always equalled the payment, and the largest shortfall against exact
  was one output unit (0.01 of a 2-dp token; 5.001e-10 for 17/18-dp tokens).
- **Dust and round trips.** 40 minimal-input swaps plus reverse dust swaps and a full sell-back, at
  fee 0, for divisibility pairs (18,0), (0,18), (18,6), (2,2), (0,0), (18,18) and balanced and
  extreme reserves: the taker never ended ahead in both tokens, and never ahead in A while holding at
  least his starting B.
- **Auth.** All five owner methods refuse no proof, a look-alike resource's proof, and a proof built
  from an empty bucket of the real badge. Private functions (`build`, `compute_swap`,
  `liquidity_event`) are not exported. Owner role, roles and royalties cannot be changed. Internal
  vaults are reachable only by the component, apart from the resource's own recall/freeze roles
  (I-1).
- **Buckets.** Wrong token: "Token is not in this pool". Empty: "Nothing to swap". Non-fungible
  bucket into `swap`, `deposit` or `instantiate_with_liquidity`: refused by the engine's schema check
  (`FungibleBucket` is the well-known `OWN_FUNGIBLE_BUCKET` type). Owner depositing B into the A slot
  or a third token: refused. Same token twice, non-fungible pool token: refused.
- **Withdraw edges.** Negative, over-precise and over-balance amounts are refused by the engine;
  `withdraw(0, 0)` works; emptying one side makes swaps and `quote` fail "Pool is empty" while the
  owner can still withdraw and re-fund.
- **Division by zero / zero inputs.** `r_in + eff > 0` always (both > 0 after line 260); zero and
  negative inputs stop at line 259; `effective <= 0` returns 0, so swap panics "Trade too small".
  Fee rounding to zero is impossible when `fee_bps > 0` (ceil gives at least one unit).
- **Reentrancy.** Radix resources have no transfer hooks; the component calls no other component;
  the engine locks `&mut self` state for the call. Nothing to re-enter.
- **Pause.** Pauses only `swap`/`swap_with_minimum`; deposits and withdrawals keep working
  (authors' test and `audit_frozen_both_ways`).

## Opinions on the open questions

**(a) Own crate/package, or alongside Pool, OrderBook and OrderRegistry?** Own crate and own
package. Reasons: (1) the published package is immutable, so "alongside" means re-publishing the
other three blueprints at new addresses, which the exchange and indexers would then have to tell
apart from the real ones for no gain; (2) keeping `owner_pool` in `dex-contracts` breaks the
reproducible-build check of the published package (L-3); (3) a single-blueprint wasm is smaller,
cheaper to publish, and its code hash maps to exactly one reviewed file, which makes the
"what did I publish" check trivial; (4) the components share no state anyway, so co-location buys
nothing. Publish the package with `OwnerRole::None` (no package royalties exist to claim).

**(b) Instant fee and pause changes, given takers assert a minimum output?** Acceptable. A fee rise
or a pause can only make a taker's transaction fail, never pay less than his asserted minimum
(`audit_instant_fee_change_vs_minimum` shows both `swap_with_minimum` and a manifest
`ASSERT_WORKTOP_CONTAINS` failing cleanly after a 0 -> 500 bps change). A timelock would add little:
the owner can already move the price far more than 5% at any moment by withdrawing one side, so
takers must trust either their assertion or the owner, not a delay. Takers who call bare `swap`
without an assertion pay whatever fee is current (up to 5%); the exchange's manifests and the docs
should always include an assertion. The fee being capped in code is the important property and it
holds (cap checked at both instantiations and in `set_fee`; `u16` input so no wrap).

**(c) Owner badge custody.** The badge is total, permanent control: `OwnerRole::Fixed` means it can
never be rotated, so loss of the badge locks the funds for ever and theft of it loses them.
Recommendations:
1. The badge must be a fresh non-fungible, or a 0-dp fungible with supply 1, with no minter (or a
   minter set to `DenyAll` and locked), not recallable, not freezable, all role updaters locked.
   Check it on the Gateway before instantiating. Not the solver's existing badge.
2. The market-making bot needs the badge to deposit and withdraw, so the bot's key is the pool's key.
   Keep only working inventory in the pool, sweep surplus to a cold account regularly, and treat
   the bot host as holding the full pool value.
3. If a cold/hot split is wanted, it must be designed in before publishing because it cannot be
   added after: e.g. instantiate with an `AccessRule` instead of a resource (so a multi-signature or
   `require_any_of([hot, cold])` owner is possible), or give `withdraw` a second role restricted to a
   cold badge while the bot's badge may only deposit, set the fee and pause. Note the bot then needs
   another way to move price down for a token (it could only add the other side), which is still
   workable since adding either side moves the price either way.
4. Back up the badge's account (seed phrase / Ledger) as carefully as the funds themselves.

## Tests

`tests/owner_pool_audit2.rs`: **16 passed, 0 failed** (490 s). The authors' `tests/owner_pool_proposal.rs`, rerun in the same build: **15 passed, 0 failed**.

All tests pass against 054bd6f. Tests that demonstrate a finding assert the weakness (M-1, L-1,
L-2, I-1, I-2, I-3), so a fix will turn them red on purpose; invert them then.

Run with the same image and command as `scrypto/run.sh`, on the separate target volume:
`docker run --rm -v "$PWD/dex-contracts:/app" -v radix-dex-cargo:/usr/local/cargo/registry -v radix-dex-target-pool-audit:/target -e CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback radix-dex-scrypto:1.92 cargo test --test owner_pool_audit2`

## Not verified

- Everything ran in the scrypto-test ledger simulator (engine 1.4.0, the simulator's default
  protocol version), not on Stokenet or mainnet. That mainnet runs the same engine semantics for
  these code paths is assumed, not checked.
- The sandwich (M-1) is shown in the simulator with chosen ordering; whether a third party can
  reliably order transactions around the bot's on Radix mainnet was not tested.
- No fuzzing beyond the fixed matrix; amounts and reserves were chosen, not random.
- The bot and the exchange's TypeScript integration were not reviewed.
