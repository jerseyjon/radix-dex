//! From the pool audit (22 Nov 2026); the owner approved it with a 5% fee cap. Not yet published:
//! it lives in its own crate (`scrypto/owner-pool`) so it becomes its own package, and so the
//! published `dex-contracts` package still rebuilds to the same wasm.
//!
//! `OwnerPool`: a constant-product pool whose liquidity belongs to one owner. Built for the owner's
//! stated use: he is the only liquidity provider and a market-making bot will manage the pool.
//!
//! Differences from the published `Pool`, each answering a finding in docs/review-2026-11-21/pool-audit.md:
//! * Only the owner badge can deposit or withdraw. There are no pool units, so there is no first
//!   deposit to front-run, no share price to inflate, and no rounding on shares (F2, F3).
//! * Liquidity can be seeded in the instantiating transaction (`instantiate_with_liquidity`).
//! * Reserves ARE the vault balances. A recall cannot brick the pool; the owner can always withdraw
//!   what is left (F1). A freeze still halts what it freezes; that is the token issuer's power.
//! * Products are taken after dividing, so huge-supply tokens do not overflow (F4).
//! * The owner can change the fee within a fixed cap, pause swaps (never withdrawals), and move the
//!   price by depositing or withdrawing either side alone. Every change emits an event.
//! * `swap_with_minimum` lets a caller who does not use manifest assertions protect himself.
//! * `deposit`, `withdraw`, `rebalance` and `owner_rebalance` take an optional `expected` pair of
//!   reserves and fail if the pool no longer holds exactly that, so a bot's price move cannot be
//!   sandwiched (audit M-1).
//! * `quote` fails wherever `swap` would: while paused, when the output would be zero, and for an
//!   amount the input token's divisibility cannot hold (audit L-2).
//!
//! Cold/hot split (docs/review-2026-11-21/owner-pool-split-design.md):
//! * OWNER (cold badge, kept in the owner's wallet): everything, including every way funds leave the
//!   component, the fee, the pause, and choosing, replacing or revoking the operator and its limits.
//! * OPERATOR (hot badge, held by the market-making bot; optional): may only move funds between the
//!   component's INVENTORY vaults and its trading RESERVES (`rebalance`), pause/unpause its own pause
//!   flag, and set the fee inside an owner-set range. No operator method takes a bucket out of the
//!   component or returns one.
//! * Inventory is not part of the trading curve. Swaps and `quote` see only the reserves; swap fees
//!   stay in the reserves, as before.
//! * A stolen operator key can still misprice the curve and trade against it. That is bounded on
//!   ledger by owner-set limits: a price-move budget per window of epochs (refilled continuously, so
//!   splitting a move into many small calls does not help), and caps on the reserves the operator
//!   may raise either side to. The design document quantifies the worst case.
//!
//! Operating rules (not enforced on ledger; check on the Gateway before instantiating):
//! * The owner badge is total and permanent control (`OwnerRole::Fixed`): it can never be rotated.
//!   It must be a fresh non-fungible, or a fungible with divisibility 0 and supply 1, with no
//!   minter (or minter `DenyAll`), not recallable, not freezable, and every role updater locked.
//!   `require(badge)` accepts a proof of ANY amount of the badge, so with a divisible badge a dust
//!   fraction is full ownership (audit I-2). Instantiation requires a proof of the badge and refuses
//!   XRD and either pool token as the badge (audit L-1), but cannot check the rest.
//!   The same rules apply to the operator badge; `set_operator` likewise needs a proof of it and
//!   refuses the owner badge, XRD and the pool tokens.
//! * Pooled tokens must have their recaller, freezer, minter and withdraw/deposit roles `DenyAll`
//!   (or `AllowAll` for withdraw/deposit) AND locked. A token whose issuer can recall or mint can
//!   drain the other side of the pool; one that can freeze can halt it (audit I-1).
//! * Anyone can instantiate an `OwnerPool`; list pools by component address only (audit I-5).
use scrypto::prelude::*;

/// Hard cap on the swap fee, in basis points (5%). Fixed in code; `instantiate`,
/// `instantiate_with_liquidity`, `set_fee` and `set_operator_limits` all refuse anything above it.
pub const OWNER_POOL_MAX_FEE_BPS: u16 = 500;

/// Largest price-move budget the owner may give the operator per window: 10,000 bps of cost,
/// i.e. a cumulative log-price path of at most 1.0 (a factor e = 2.718) per window.
pub const OWNER_POOL_MAX_MOVE_BUDGET_BPS: u16 = 10_000;

/// What the operator may do. Set by the owner (`set_operator_limits`); all zero at instantiation,
/// so a new operator can do nothing that moves the price or raises a reserve until the owner says so.
#[derive(ScryptoSbor, Clone, Copy, Debug, PartialEq, Eq)]
pub struct OperatorLimits {
    /// Price-move budget per window, in basis points of "cost". One `rebalance` that changes the
    /// curve's price (B per A) from P to P' costs max(P'/P, P/P') - 1, rounded up; this is never
    /// less than |ln(P'/P)|, so the budget bounds the operator's cumulative log-price path.
    pub move_budget_bps: u16,
    /// The budget refills linearly over this many epochs (and never above one full budget).
    pub window_epochs: u64,
    /// When an operator call raises either reserve, both reserves afterwards must be at most these.
    pub max_reserve_a: Decimal,
    pub max_reserve_b: Decimal,
    /// The operator may set the fee anywhere in [min_fee_bps, max_fee_bps].
    pub min_fee_bps: u16,
    pub max_fee_bps: u16,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolSwapEvent {
    pub input_resource: ResourceAddress,
    pub input_amount: Decimal,
    pub output_resource: ResourceAddress,
    pub output_amount: Decimal,
    pub fee: Decimal,
    pub reserve_a: Decimal,
    pub reserve_b: Decimal,
}

/// Owner deposits into / withdrawals from the trading reserves.
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolLiquidityEvent {
    /// Positive when deposited, negative when withdrawn.
    pub amount_a: Decimal,
    pub amount_b: Decimal,
    pub reserve_a: Decimal,
    pub reserve_b: Decimal,
}

/// Owner deposits into / withdrawals from the inventory.
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolInventoryEvent {
    /// Positive when deposited, negative when withdrawn.
    pub amount_a: Decimal,
    pub amount_b: Decimal,
    pub inventory_a: Decimal,
    pub inventory_b: Decimal,
}

/// A move between inventory and reserves, by the operator or the owner.
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolRebalanceEvent {
    /// Positive: inventory to reserves. Negative: reserves to inventory.
    pub amount_a: Decimal,
    pub amount_b: Decimal,
    pub reserve_a: Decimal,
    pub reserve_b: Decimal,
    pub inventory_a: Decimal,
    pub inventory_b: Decimal,
    /// Budget this move cost (zero for the owner, who has no budget).
    pub price_move: Decimal,
    /// Operator budget left after the move.
    pub allowance: Decimal,
    pub by_owner: bool,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolConfigEvent {
    pub fee_bps: u16,
    /// The owner's pause. Only the owner can set or clear it.
    pub paused: bool,
    /// The operator's pause. The operator or the owner can set or clear it.
    pub operator_paused: bool,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolOperatorEvent {
    pub operator: Option<ResourceAddress>,
    pub limits: OperatorLimits,
}

fn floor_to(value: PreciseDecimal, divisibility: u8) -> Decimal {
    value
        .checked_round(divisibility, RoundingMode::ToNegativeInfinity)
        .and_then(|v| Decimal::try_from(v).ok())
        .expect("Amount out of range")
}

fn ceil_to(value: PreciseDecimal, divisibility: u8) -> Decimal {
    value
        .checked_round(divisibility, RoundingMode::ToPositiveInfinity)
        .and_then(|v| Decimal::try_from(v).ok())
        .expect("Amount out of range")
}

fn fungible_divisibility(resource: ResourceAddress) -> u8 {
    match ResourceManager::from(resource).resource_type() {
        ResourceType::Fungible { divisibility } => divisibility,
        ResourceType::NonFungible { .. } => panic!("Pool tokens must be fungible"),
    }
}

/// Cost of moving the curve from (ra, rb) to (na, nb), all > 0, in attos of a Decimal, rounded UP:
/// max(r, 1/r) - 1 where r = (nb / na) / (rb / ra). Exact integer arithmetic (I512 on attos).
fn move_cost_attos(ra: Decimal, rb: Decimal, na: Decimal, nb: Decimal) -> I512 {
    let num = I512::from(nb.attos()) * I512::from(ra.attos());
    let den = I512::from(rb.attos()) * I512::from(na.attos());
    let (hi, lo) = if num >= den { (num, den) } else { (den, num) };
    let one = I512::from(1_000_000_000_000_000_000u64);
    ((hi - lo) * one + lo - I512::from(1)) / lo
}

/// A Decimal from an attos amount known to fit (callers pass at most one budget, <= 1.0).
fn attos_to_decimal(attos: I512) -> Decimal {
    Decimal::from_attos(I192::from(i128::try_from(attos).expect("Amount out of range")))
}

#[blueprint]
#[events(
    OwnerPoolSwapEvent,
    OwnerPoolLiquidityEvent,
    OwnerPoolInventoryEvent,
    OwnerPoolRebalanceEvent,
    OwnerPoolConfigEvent,
    OwnerPoolOperatorEvent
)]
mod owner_pool {
    enable_method_auth! {
        roles {
            // Only the component itself can change this role, and only from `set_operator`, which
            // the owner calls and which checks the badge. The owner cannot set it natively.
            operator => updatable_by: [SELF];
        },
        methods {
            swap => PUBLIC;
            swap_with_minimum => PUBLIC;
            quote => PUBLIC;
            reserves => PUBLIC;
            inventory => PUBLIC;
            fee_bps => PUBLIC;
            is_paused => PUBLIC;
            operator_status => PUBLIC;
            deposit => restrict_to: [OWNER];
            withdraw => restrict_to: [OWNER];
            withdraw_all => restrict_to: [OWNER];
            deposit_inventory => restrict_to: [OWNER];
            withdraw_inventory => restrict_to: [OWNER];
            owner_rebalance => restrict_to: [OWNER];
            set_fee => restrict_to: [OWNER];
            set_paused => restrict_to: [OWNER];
            set_operator => restrict_to: [OWNER];
            set_operator_limits => restrict_to: [OWNER];
            rebalance => restrict_to: [operator];
            operator_set_fee => restrict_to: [operator];
            set_operator_paused => restrict_to: [OWNER, operator];
        }
    }

    struct OwnerPool {
        resource_a: ResourceAddress,
        resource_b: ResourceAddress,
        divisibility_a: u8,
        divisibility_b: u8,
        /// Trading reserves: the curve.
        vault_a: FungibleVault,
        vault_b: FungibleVault,
        fee_bps: u16,
        paused: bool,
        operator_paused: bool,
        /// Not part of the curve. Only the owner takes funds out; the operator can only move them
        /// to and from the reserves.
        inventory_a: FungibleVault,
        inventory_b: FungibleVault,
        owner_badge: ResourceAddress,
        operator: Option<ResourceAddress>,
        limits: OperatorLimits,
        /// Operator price-move budget left, as of `allowance_epoch`.
        allowance: Decimal,
        allowance_epoch: u64,
    }

    impl OwnerPool {
        /// An empty pool with no operator. Only `owner_badge` can fund it.
        pub fn instantiate(resource_a: ResourceAddress, resource_b: ResourceAddress, fee_bps: u16, owner_badge: ResourceAddress) -> Global<OwnerPool> {
            Self::build(resource_a, resource_b, fee_bps, owner_badge, None)
        }

        /// A pool funded in the same transaction, so nobody can touch it before the owner's price is
        /// set. No operator; the owner adds one with `set_operator` and `set_operator_limits`.
        pub fn instantiate_with_liquidity(a: FungibleBucket, b: FungibleBucket, fee_bps: u16, owner_badge: ResourceAddress) -> Global<OwnerPool> {
            let (ra, rb) = (a.resource_address(), b.resource_address());
            Self::build(ra, rb, fee_bps, owner_badge, Some((a, b)))
        }

        /// Both instantiations require a proof of `owner_badge` in the caller's auth zone, so a
        /// mistyped or unheld badge address fails here instead of handing the pool away for ever.
        fn build(resource_a: ResourceAddress, resource_b: ResourceAddress, fee_bps: u16, owner_badge: ResourceAddress, seed: Option<(FungibleBucket, FungibleBucket)>) -> Global<OwnerPool> {
            assert!(resource_a != resource_b, "The two tokens must differ");
            assert!(fee_bps <= OWNER_POOL_MAX_FEE_BPS, "Fee too high");
            assert!(owner_badge != resource_a && owner_badge != resource_b && owner_badge != XRD, "Bad owner badge");
            Runtime::assert_access_rule(rule!(require(owner_badge)));
            let mut vault_a = FungibleVault::new(resource_a);
            let mut vault_b = FungibleVault::new(resource_b);
            if let Some((a, b)) = seed {
                vault_a.put(a);
                vault_b.put(b);
            }
            Self {
                resource_a,
                resource_b,
                divisibility_a: fungible_divisibility(resource_a),
                divisibility_b: fungible_divisibility(resource_b),
                vault_a,
                vault_b,
                fee_bps,
                paused: false,
                operator_paused: false,
                inventory_a: FungibleVault::new(resource_a),
                inventory_b: FungibleVault::new(resource_b),
                owner_badge,
                operator: None,
                limits: OperatorLimits {
                    move_budget_bps: 0,
                    window_epochs: 1,
                    max_reserve_a: Decimal::ZERO,
                    max_reserve_b: Decimal::ZERO,
                    min_fee_bps: fee_bps,
                    max_fee_bps: fee_bps,
                },
                allowance: Decimal::ZERO,
                allowance_epoch: Runtime::current_epoch().number(),
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(owner_badge))))
            .roles(roles! {
                operator => rule!(deny_all);
            })
            .metadata(metadata! {
                init {
                    "name" => "radix-dex owner pool", updatable;
                    "resource_a" => GlobalAddress::from(resource_a), locked;
                    "resource_b" => GlobalAddress::from(resource_b), locked;
                }
            })
            .globalize()
        }

        // ------------------------------------------------------------------ public reads

        /// Trading reserves (the curve).
        pub fn reserves(&self) -> (Decimal, Decimal) {
            (self.vault_a.amount(), self.vault_b.amount())
        }

        /// Inventory: owned by the pool's owner, not traded.
        pub fn inventory(&self) -> (Decimal, Decimal) {
            (self.inventory_a.amount(), self.inventory_b.amount())
        }

        pub fn fee_bps(&self) -> u16 {
            self.fee_bps
        }

        /// True while either the owner's or the operator's pause is on.
        pub fn is_paused(&self) -> bool {
            self.paused || self.operator_paused
        }

        /// (operator badge, its limits, budget available now, operator pause flag).
        pub fn operator_status(&self) -> (Option<ResourceAddress>, OperatorLimits, Decimal, bool) {
            (self.operator, self.limits, self.allowance_now(), self.operator_paused)
        }

        // ------------------------------------------------------------------ public trading

        /// What `swap` would pay for `input_amount` now. Fails wherever `swap` would fail: while
        /// paused ("Swaps are paused"), for an output of zero ("Trade too small"), and for an amount
        /// with more decimal places than the input token allows (no bucket can hold it).
        pub fn quote(&self, input_resource: ResourceAddress, input_amount: Decimal) -> Decimal {
            assert!(!self.paused && !self.operator_paused, "Swaps are paused");
            let div_in = if input_resource == self.resource_a {
                self.divisibility_a
            } else if input_resource == self.resource_b {
                self.divisibility_b
            } else {
                panic!("Token is not in this pool")
            };
            assert!(
                input_amount.checked_round(div_in, RoundingMode::ToZero) == Some(input_amount),
                "Amount has more decimal places than the token allows"
            );
            let output = self.compute_swap(input_resource, input_amount);
            assert!(output > Decimal::ZERO, "Trade too small");
            output
        }

        pub fn swap(&mut self, input: FungibleBucket) -> FungibleBucket {
            self.swap_with_minimum(input, Decimal::ZERO)
        }

        /// Swap the whole bucket; fail unless at least `minimum` comes out. The input, fee included,
        /// goes into the trading reserves.
        pub fn swap_with_minimum(&mut self, input: FungibleBucket, minimum: Decimal) -> FungibleBucket {
            assert!(!self.paused && !self.operator_paused, "Swaps are paused");
            let input_resource = input.resource_address();
            let input_amount = input.amount();
            let output_amount = self.compute_swap(input_resource, input_amount);
            assert!(output_amount > Decimal::ZERO, "Trade too small");
            assert!(output_amount >= minimum, "Less than the minimum");
            let fee = ceil_to(
                PreciseDecimal::from(input_amount) * PreciseDecimal::from(self.fee_bps) / PreciseDecimal::from(10_000u32),
                if input_resource == self.resource_a { self.divisibility_a } else { self.divisibility_b },
            );
            let a_in = input_resource == self.resource_a;
            let output = if a_in {
                self.vault_a.put(input);
                self.vault_b.take(output_amount)
            } else {
                self.vault_b.put(input);
                self.vault_a.take(output_amount)
            };
            let (reserve_a, reserve_b) = self.reserves();
            Runtime::emit_event(OwnerPoolSwapEvent {
                input_resource,
                input_amount,
                output_resource: if a_in { self.resource_b } else { self.resource_a },
                output_amount,
                fee,
                reserve_a,
                reserve_b,
            });
            output
        }

        // ------------------------------------------------------------------ owner: funds

        /// Owner: add either or both tokens to the trading reserves, at any ratio. Changing the
        /// ratio moves the price.
        /// `expected`: if `Some((ra, rb))`, fail with "Reserves moved" unless the pool holds exactly
        /// `ra` of A and `rb` of B before the deposit. `None` skips the check.
        pub fn deposit(&mut self, a: Option<FungibleBucket>, b: Option<FungibleBucket>, expected: Option<(Decimal, Decimal)>) {
            self.check_reserves(expected);
            let (mut da, mut db) = (Decimal::ZERO, Decimal::ZERO);
            if let Some(a) = a {
                assert!(a.resource_address() == self.resource_a, "Wrong token A");
                da = a.amount();
                self.vault_a.put(a);
            }
            if let Some(b) = b {
                assert!(b.resource_address() == self.resource_b, "Wrong token B");
                db = b.amount();
                self.vault_b.put(b);
            }
            self.liquidity_event(da, db);
        }

        /// Owner: take any amounts out of the trading reserves. Never paused, never locked.
        /// A zero amount does not touch its vault, so if a token's issuer freezes one vault the
        /// owner can still take the other token out.
        /// `expected`: as for `deposit`, checked before anything is taken.
        pub fn withdraw(&mut self, amount_a: Decimal, amount_b: Decimal, expected: Option<(Decimal, Decimal)>) -> (FungibleBucket, FungibleBucket) {
            self.check_reserves(expected);
            let out = (
                Self::take(&mut self.vault_a, self.resource_a, amount_a),
                Self::take(&mut self.vault_b, self.resource_b, amount_b),
            );
            self.liquidity_event(-amount_a, -amount_b);
            out
        }

        /// Owner: take out everything, reserves and inventory. No reserves guard: emptying the pool
        /// sets no price, so a trade landing just before it leaves nothing behind to trade against.
        pub fn withdraw_all(&mut self) -> (FungibleBucket, FungibleBucket) {
            let (a, b) = self.reserves();
            let (mut out_a, mut out_b) = self.withdraw(a, b, None);
            let (ia, ib) = self.inventory();
            if ia > Decimal::ZERO || ib > Decimal::ZERO {
                let (xa, xb) = self.withdraw_inventory(ia, ib);
                out_a.put(xa);
                out_b.put(xb);
            }
            (out_a, out_b)
        }

        /// Owner: add either or both tokens to the inventory (not traded).
        pub fn deposit_inventory(&mut self, a: Option<FungibleBucket>, b: Option<FungibleBucket>) {
            let (mut da, mut db) = (Decimal::ZERO, Decimal::ZERO);
            if let Some(a) = a {
                assert!(a.resource_address() == self.resource_a, "Wrong token A");
                da = a.amount();
                self.inventory_a.put(a);
            }
            if let Some(b) = b {
                assert!(b.resource_address() == self.resource_b, "Wrong token B");
                db = b.amount();
                self.inventory_b.put(b);
            }
            self.inventory_event(da, db);
        }

        /// Owner: take any amounts out of the inventory. Zero amounts do not touch their vault.
        pub fn withdraw_inventory(&mut self, amount_a: Decimal, amount_b: Decimal) -> (FungibleBucket, FungibleBucket) {
            let out = (
                Self::take(&mut self.inventory_a, self.resource_a, amount_a),
                Self::take(&mut self.inventory_b, self.resource_b, amount_b),
            );
            self.inventory_event(-amount_a, -amount_b);
            out
        }

        /// Owner: move between inventory and reserves with no limits (see `rebalance`).
        pub fn owner_rebalance(&mut self, to_reserve_a: Decimal, to_reserve_b: Decimal, expected: Option<(Decimal, Decimal)>) {
            self.move_inventory(to_reserve_a, to_reserve_b, expected, true);
        }

        // ------------------------------------------------------------------ owner: settings

        /// Owner: change the fee, within the cap fixed in code.
        pub fn set_fee(&mut self, fee_bps: u16) {
            assert!(fee_bps <= OWNER_POOL_MAX_FEE_BPS, "Fee too high");
            self.fee_bps = fee_bps;
            self.config_event();
        }

        /// Owner: stop or restart swaps. Withdrawals are never paused. The operator cannot clear
        /// this pause (it has its own flag, which the owner can also clear).
        pub fn set_paused(&mut self, paused: bool) {
            self.paused = paused;
            self.config_event();
        }

        /// Owner: appoint, replace (`Some(new)`) or revoke (`None`) the operator. Takes effect in
        /// this transaction: the old badge loses every operator right at once. A new badge must be
        /// proved in the caller's auth zone (so a typo cannot appoint a stranger), and must not be
        /// the owner badge, XRD or a pool token.
        pub fn set_operator(&mut self, badge: Option<ResourceAddress>) {
            let rule = match badge {
                Some(b) => {
                    assert!(
                        b != self.owner_badge && b != self.resource_a && b != self.resource_b && b != XRD,
                        "Bad operator badge"
                    );
                    Runtime::assert_access_rule(rule!(require(b)));
                    rule!(require(b))
                }
                None => rule!(deny_all),
            };
            Runtime::global_component().set_role("operator", rule);
            self.operator = badge;
            Runtime::emit_event(OwnerPoolOperatorEvent { operator: badge, limits: self.limits });
        }

        /// Owner: set what the operator may do (see `OperatorLimits`). Budget already accrued is
        /// kept, but never more than the new budget.
        pub fn set_operator_limits(
            &mut self,
            move_budget_bps: u16,
            window_epochs: u64,
            max_reserve_a: Decimal,
            max_reserve_b: Decimal,
            min_fee_bps: u16,
            max_fee_bps: u16,
        ) {
            assert!(move_budget_bps <= OWNER_POOL_MAX_MOVE_BUDGET_BPS, "Budget too high");
            assert!(window_epochs >= 1, "Window must be at least one epoch");
            assert!(max_reserve_a >= Decimal::ZERO && max_reserve_b >= Decimal::ZERO, "Negative cap");
            assert!(min_fee_bps <= max_fee_bps && max_fee_bps <= OWNER_POOL_MAX_FEE_BPS, "Bad fee range");
            self.refill();
            self.limits = OperatorLimits { move_budget_bps, window_epochs, max_reserve_a, max_reserve_b, min_fee_bps, max_fee_bps };
            self.allowance = self.allowance.min(Self::budget(&self.limits));
            Runtime::emit_event(OwnerPoolOperatorEvent { operator: self.operator, limits: self.limits });
        }

        // ------------------------------------------------------------------ operator

        /// Operator: move funds between inventory and reserves, inside the component. Positive
        /// amounts go from inventory to reserves, negative from reserves to inventory. Nothing is
        /// returned. Limits (owner-set): both reserves must be non-zero before and after; if either
        /// reserve is raised, both must end at or below their caps; the price change costs budget
        /// (see `OperatorLimits::move_budget_bps`) and fails "Operator price-move limit" beyond it.
        /// `expected`: as for `deposit`.
        pub fn rebalance(&mut self, to_reserve_a: Decimal, to_reserve_b: Decimal, expected: Option<(Decimal, Decimal)>) {
            self.move_inventory(to_reserve_a, to_reserve_b, expected, false);
        }

        /// Operator: set the fee within the owner's range.
        pub fn operator_set_fee(&mut self, fee_bps: u16) {
            assert!(fee_bps >= self.limits.min_fee_bps && fee_bps <= self.limits.max_fee_bps, "Fee outside the operator's range");
            self.fee_bps = fee_bps;
            self.config_event();
        }

        /// Operator or owner: the operator's own pause flag. Does not touch the owner's pause.
        pub fn set_operator_paused(&mut self, paused: bool) {
            self.operator_paused = paused;
            self.config_event();
        }

        // ------------------------------------------------------------------ internals

        fn take(vault: &mut FungibleVault, resource: ResourceAddress, amount: Decimal) -> FungibleBucket {
            if amount == Decimal::ZERO { FungibleBucket::new(resource) } else { vault.take(amount) }
        }

        /// Signed move of one token between its inventory vault and its reserve vault.
        fn shift(inventory: &mut FungibleVault, reserve: &mut FungibleVault, amount: Decimal) {
            if amount > Decimal::ZERO {
                reserve.put(inventory.take(amount));
            } else if amount < Decimal::ZERO {
                inventory.put(reserve.take(-amount));
            }
        }

        fn move_inventory(&mut self, da: Decimal, db: Decimal, expected: Option<(Decimal, Decimal)>, by_owner: bool) {
            self.check_reserves(expected);
            let mut price_move = Decimal::ZERO;
            if !by_owner {
                let (ra, rb) = self.reserves();
                assert!(ra > Decimal::ZERO && rb > Decimal::ZERO, "Pool is empty");
                let (na, nb) = (ra.checked_add(da).expect("Overflow"), rb.checked_add(db).expect("Overflow"));
                assert!(na > Decimal::ZERO && nb > Decimal::ZERO, "Operator cannot empty a side");
                if da > Decimal::ZERO || db > Decimal::ZERO {
                    assert!(na <= self.limits.max_reserve_a && nb <= self.limits.max_reserve_b, "Above the operator's reserve cap");
                }
                self.refill();
                let cost = move_cost_attos(ra, rb, na, nb);
                let have = I512::from(self.allowance.attos());
                assert!(cost <= have, "Operator price-move limit");
                price_move = attos_to_decimal(cost);
                self.allowance = attos_to_decimal(have - cost);
            }
            Self::shift(&mut self.inventory_a, &mut self.vault_a, da);
            Self::shift(&mut self.inventory_b, &mut self.vault_b, db);
            let (reserve_a, reserve_b) = self.reserves();
            let (inventory_a, inventory_b) = self.inventory();
            Runtime::emit_event(OwnerPoolRebalanceEvent {
                amount_a: da,
                amount_b: db,
                reserve_a,
                reserve_b,
                inventory_a,
                inventory_b,
                price_move,
                allowance: self.allowance,
                by_owner,
            });
        }

        fn budget(limits: &OperatorLimits) -> Decimal {
            Decimal::from(limits.move_budget_bps) / Decimal::from(10_000u32)
        }

        /// Budget available now: what was left, plus budget * elapsed / window, at most one budget.
        fn allowance_now(&self) -> Decimal {
            let budget = Self::budget(&self.limits);
            let elapsed = Runtime::current_epoch().number().saturating_sub(self.allowance_epoch);
            if elapsed >= self.limits.window_epochs {
                return budget;
            }
            let accrued = budget * Decimal::from(elapsed) / Decimal::from(self.limits.window_epochs);
            self.allowance.checked_add(accrued).expect("Overflow").min(budget)
        }

        fn refill(&mut self) {
            self.allowance = self.allowance_now();
            self.allowance_epoch = Runtime::current_epoch().number();
        }

        fn check_reserves(&self, expected: Option<(Decimal, Decimal)>) {
            if let Some((ea, eb)) = expected {
                assert!(self.vault_a.amount() == ea && self.vault_b.amount() == eb, "Reserves moved");
            }
        }

        fn liquidity_event(&self, amount_a: Decimal, amount_b: Decimal) {
            let (reserve_a, reserve_b) = self.reserves();
            Runtime::emit_event(OwnerPoolLiquidityEvent { amount_a, amount_b, reserve_a, reserve_b });
        }

        fn inventory_event(&self, amount_a: Decimal, amount_b: Decimal) {
            let (inventory_a, inventory_b) = self.inventory();
            Runtime::emit_event(OwnerPoolInventoryEvent { amount_a, amount_b, inventory_a, inventory_b });
        }

        fn config_event(&self) {
            Runtime::emit_event(OwnerPoolConfigEvent { fee_bps: self.fee_bps, paused: self.paused, operator_paused: self.operator_paused });
        }

        /// Output for an input, rounded down; the fee (rounded up) stays in the pool.
        /// Divides before multiplying so that no intermediate exceeds the reserves themselves.
        fn compute_swap(&self, input_resource: ResourceAddress, input_amount: Decimal) -> Decimal {
            let (r_in, r_out, div_in, div_out) = if input_resource == self.resource_a {
                (self.vault_a.amount(), self.vault_b.amount(), self.divisibility_a, self.divisibility_b)
            } else if input_resource == self.resource_b {
                (self.vault_b.amount(), self.vault_a.amount(), self.divisibility_b, self.divisibility_a)
            } else {
                panic!("Token is not in this pool")
            };
            assert!(input_amount > Decimal::ZERO, "Nothing to swap");
            assert!(r_in > Decimal::ZERO && r_out > Decimal::ZERO, "Pool is empty");
            let fee = ceil_to(
                PreciseDecimal::from(input_amount) * PreciseDecimal::from(self.fee_bps) / PreciseDecimal::from(10_000u32),
                div_in,
            );
            let effective = input_amount - fee;
            if effective <= Decimal::ZERO {
                return Decimal::ZERO;
            }
            let eff = PreciseDecimal::from(effective);
            // share of the output reserve paid out: eff / (r_in + eff) < 1, truncated down.
            let share = eff.checked_div(PreciseDecimal::from(r_in).checked_add(eff).expect("Overflow")).expect("Overflow");
            let output = floor_to(PreciseDecimal::from(r_out).checked_mul(share).expect("Overflow"), div_out);
            assert!(output < r_out, "Not enough liquidity");
            output
        }
    }
}
