//! From the pool audit (22 Nov 2026); the owner approved it with a 5% fee cap. Not yet published:
//! using it needs a new package.
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
use scrypto::prelude::*;

/// Hard cap on the swap fee, in basis points (5%). Fixed in code; `instantiate`,
/// `instantiate_with_liquidity` and `set_fee` all refuse anything above it.
pub const OWNER_POOL_MAX_FEE_BPS: u16 = 500;

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

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolLiquidityEvent {
    /// Positive when deposited, negative when withdrawn.
    pub amount_a: Decimal,
    pub amount_b: Decimal,
    pub reserve_a: Decimal,
    pub reserve_b: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OwnerPoolConfigEvent {
    pub fee_bps: u16,
    pub paused: bool,
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

#[blueprint]
#[events(OwnerPoolSwapEvent, OwnerPoolLiquidityEvent, OwnerPoolConfigEvent)]
mod owner_pool {
    enable_method_auth! {
        methods {
            swap => PUBLIC;
            swap_with_minimum => PUBLIC;
            quote => PUBLIC;
            reserves => PUBLIC;
            fee_bps => PUBLIC;
            is_paused => PUBLIC;
            deposit => restrict_to: [OWNER];
            withdraw => restrict_to: [OWNER];
            withdraw_all => restrict_to: [OWNER];
            set_fee => restrict_to: [OWNER];
            set_paused => restrict_to: [OWNER];
        }
    }

    struct OwnerPool {
        resource_a: ResourceAddress,
        resource_b: ResourceAddress,
        divisibility_a: u8,
        divisibility_b: u8,
        vault_a: FungibleVault,
        vault_b: FungibleVault,
        fee_bps: u16,
        paused: bool,
    }

    impl OwnerPool {
        /// An empty pool. Only `owner_badge` can fund it.
        pub fn instantiate(resource_a: ResourceAddress, resource_b: ResourceAddress, fee_bps: u16, owner_badge: ResourceAddress) -> Global<OwnerPool> {
            Self::build(resource_a, resource_b, fee_bps, owner_badge, None)
        }

        /// A pool funded in the same transaction, so nobody can touch it before the owner's price is set.
        pub fn instantiate_with_liquidity(a: FungibleBucket, b: FungibleBucket, fee_bps: u16, owner_badge: ResourceAddress) -> Global<OwnerPool> {
            let (ra, rb) = (a.resource_address(), b.resource_address());
            Self::build(ra, rb, fee_bps, owner_badge, Some((a, b)))
        }

        fn build(resource_a: ResourceAddress, resource_b: ResourceAddress, fee_bps: u16, owner_badge: ResourceAddress, seed: Option<(FungibleBucket, FungibleBucket)>) -> Global<OwnerPool> {
            assert!(resource_a != resource_b, "The two tokens must differ");
            assert!(fee_bps <= OWNER_POOL_MAX_FEE_BPS, "Fee too high");
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
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(owner_badge))))
            .metadata(metadata! {
                init {
                    "name" => "radix-dex owner pool", updatable;
                    "resource_a" => GlobalAddress::from(resource_a), locked;
                    "resource_b" => GlobalAddress::from(resource_b), locked;
                }
            })
            .globalize()
        }

        pub fn reserves(&self) -> (Decimal, Decimal) {
            (self.vault_a.amount(), self.vault_b.amount())
        }

        pub fn fee_bps(&self) -> u16 {
            self.fee_bps
        }

        pub fn is_paused(&self) -> bool {
            self.paused
        }

        pub fn quote(&self, input_resource: ResourceAddress, input_amount: Decimal) -> Decimal {
            self.compute_swap(input_resource, input_amount)
        }

        pub fn swap(&mut self, input: FungibleBucket) -> FungibleBucket {
            self.swap_with_minimum(input, Decimal::ZERO)
        }

        /// Swap the whole bucket; fail unless at least `minimum` comes out.
        pub fn swap_with_minimum(&mut self, input: FungibleBucket, minimum: Decimal) -> FungibleBucket {
            assert!(!self.paused, "Swaps are paused");
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

        /// Owner: add either or both tokens, at any ratio. Changing the ratio moves the price;
        /// that is how a market-making bot keeps the pool at the market.
        pub fn deposit(&mut self, a: Option<FungibleBucket>, b: Option<FungibleBucket>) {
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

        /// Owner: take out any amounts. Never paused, never locked.
        /// A zero amount does not touch its vault, so if a token's issuer freezes one vault the
        /// owner can still take the other token out.
        pub fn withdraw(&mut self, amount_a: Decimal, amount_b: Decimal) -> (FungibleBucket, FungibleBucket) {
            let take = |vault: &mut FungibleVault, resource: ResourceAddress, amount: Decimal| {
                if amount == Decimal::ZERO { FungibleBucket::new(resource) } else { vault.take(amount) }
            };
            let out = (take(&mut self.vault_a, self.resource_a, amount_a), take(&mut self.vault_b, self.resource_b, amount_b));
            self.liquidity_event(-amount_a, -amount_b);
            out
        }

        /// Owner: take out everything.
        pub fn withdraw_all(&mut self) -> (FungibleBucket, FungibleBucket) {
            let (a, b) = self.reserves();
            self.withdraw(a, b)
        }

        /// Owner: change the fee, within the cap fixed in code.
        pub fn set_fee(&mut self, fee_bps: u16) {
            assert!(fee_bps <= OWNER_POOL_MAX_FEE_BPS, "Fee too high");
            self.fee_bps = fee_bps;
            Runtime::emit_event(OwnerPoolConfigEvent { fee_bps, paused: self.paused });
        }

        /// Owner: stop or restart swaps. Withdrawals are never paused.
        pub fn set_paused(&mut self, paused: bool) {
            self.paused = paused;
            Runtime::emit_event(OwnerPoolConfigEvent { fee_bps: self.fee_bps, paused });
        }

        fn liquidity_event(&self, amount_a: Decimal, amount_b: Decimal) {
            let (reserve_a, reserve_b) = self.reserves();
            Runtime::emit_event(OwnerPoolLiquidityEvent { amount_a, amount_b, reserve_a, reserve_b });
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
