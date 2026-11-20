use scrypto::prelude::*;

/// Pool units locked for ever when a pool is first funded, so the supply can never return to
/// zero and the first depositor cannot inflate the unit price against the second.
pub const LOCKED_UNITS: Decimal = dec!("0.000001");
/// The first deposit must mint at least this many units.
pub const MIN_INITIAL_UNITS: Decimal = dec!("0.001");
/// Upper bound on each fee, in basis points (1%).
pub const MAX_FEE_BPS: u16 = 100;

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct SwapEvent {
    pub input_resource: ResourceAddress,
    pub input_amount: Decimal,
    pub output_resource: ResourceAddress,
    pub output_amount: Decimal,
    pub protocol_fee: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct LiquidityEvent {
    /// Positive when added, negative when removed.
    pub amount_a: Decimal,
    pub amount_b: Decimal,
    pub units: Decimal,
}

/// Round down to a token's divisibility.
fn floor(value: PreciseDecimal, divisibility: u8) -> Decimal {
    value
        .checked_round(divisibility, RoundingMode::ToNegativeInfinity)
        .and_then(|v| Decimal::try_from(v).ok())
        .expect("Amount out of range")
}

/// Round up to a token's divisibility.
fn ceil(value: PreciseDecimal, divisibility: u8) -> Decimal {
    value
        .checked_round(divisibility, RoundingMode::ToPositiveInfinity)
        .and_then(|v| Decimal::try_from(v).ok())
        .expect("Amount out of range")
}

fn pd(value: Decimal) -> PreciseDecimal {
    PreciseDecimal::from(value)
}

fn divisibility_of(resource: ResourceAddress) -> u8 {
    match ResourceManager::from(resource).resource_type() {
        ResourceType::Fungible { divisibility } => divisibility,
        ResourceType::NonFungible { .. } => panic!("Pool tokens must be fungible"),
    }
}

#[blueprint]
#[events(SwapEvent, LiquidityEvent)]
mod pool {
    enable_method_auth! {
        methods {
            swap => PUBLIC;
            add_liquidity => PUBLIC;
            remove_liquidity => PUBLIC;
            quote => PUBLIC;
            reserves => PUBLIC;
            claim_protocol_fees => restrict_to: [OWNER];
        }
    }

    /// A two-token constant-product pool (x · y = k).
    ///
    /// Safety rules this code is written to, each of which the tests exercise:
    ///
    /// 1. **Every rounding goes against the caller.** Amounts paid out are rounded down to the
    ///    token's divisibility; amounts taken in are rounded up. This is the opposite of the
    ///    native `TwoResourcePool`, which mints units for an exact contribution but takes a
    ///    rounded-down one, and can be milked on low-divisibility tokens.
    /// 2. **Reserves are book-kept, not read from vaults.** Price comes from `reserve_a` and
    ///    `reserve_b`, which change only in the three methods below.
    /// 3. **k never falls in a swap.** Asserted after every swap.
    /// 4. **No flash loans, no hooks, no callbacks.** Nothing calls out to another component.
    /// 5. **No admin switches.** The owner can collect the protocol fee and edit metadata. They
    ///    cannot pause, change fees, or touch reserves.
    /// 6. **Supply cannot return to zero.** A sliver of the first deposit's units is locked.
    struct Pool {
        resource_a: ResourceAddress,
        resource_b: ResourceAddress,
        divisibility_a: u8,
        divisibility_b: u8,
        vault_a: FungibleVault,
        vault_b: FungibleVault,
        reserve_a: Decimal,
        reserve_b: Decimal,
        protocol_fees_a: FungibleVault,
        protocol_fees_b: FungibleVault,
        units: FungibleResourceManager,
        locked_units: FungibleVault,
        /// Fee left in the pool for liquidity providers, in basis points of the input.
        lp_fee_bps: u16,
        /// Fee set aside for the owner, in basis points of the input.
        protocol_fee_bps: u16,
    }

    impl Pool {
        /// Create an empty pool. `owner_badge` may claim protocol fees and edit metadata; nothing else.
        pub fn instantiate(
            resource_a: ResourceAddress,
            resource_b: ResourceAddress,
            lp_fee_bps: u16,
            protocol_fee_bps: u16,
            owner_badge: ResourceAddress,
        ) -> Global<Pool> {
            assert!(resource_a != resource_b, "The two tokens must differ");
            assert!(lp_fee_bps <= MAX_FEE_BPS && protocol_fee_bps <= MAX_FEE_BPS, "Fee too high");
            let divisibility_a = divisibility_of(resource_a);
            let divisibility_b = divisibility_of(resource_b);

            let (reservation, address) = Runtime::allocate_component_address(Pool::blueprint_id());
            let units = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_MAXIMUM)
                .metadata(metadata! {
                    init {
                        "name" => "radix-dex pool unit", locked;
                        "pool" => GlobalAddress::from(address), locked;
                    }
                })
                .mint_roles(mint_roles! {
                    minter => rule!(require(global_caller(address)));
                    minter_updater => rule!(deny_all);
                })
                .burn_roles(burn_roles! {
                    burner => rule!(require(global_caller(address)));
                    burner_updater => rule!(deny_all);
                })
                .create_with_no_initial_supply();

            Self {
                resource_a,
                resource_b,
                divisibility_a,
                divisibility_b,
                vault_a: FungibleVault::new(resource_a),
                vault_b: FungibleVault::new(resource_b),
                reserve_a: Decimal::ZERO,
                reserve_b: Decimal::ZERO,
                protocol_fees_a: FungibleVault::new(resource_a),
                protocol_fees_b: FungibleVault::new(resource_b),
                locked_units: FungibleVault::new(units.address()),
                units,
                lp_fee_bps,
                protocol_fee_bps,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(owner_badge))))
            .with_address(reservation)
            .metadata(metadata! {
                init {
                    "name" => "radix-dex pool", updatable;
                    "resource_a" => GlobalAddress::from(resource_a), locked;
                    "resource_b" => GlobalAddress::from(resource_b), locked;
                }
            })
            .globalize()
        }

        /// Reserves of token A and token B.
        pub fn reserves(&self) -> (Decimal, Decimal) {
            (self.reserve_a, self.reserve_b)
        }

        /// What `swap` would pay for `input_amount` of `input_resource` right now.
        pub fn quote(&self, input_resource: ResourceAddress, input_amount: Decimal) -> Decimal {
            self.compute_swap(input_resource, input_amount).0
        }

        /// Swap the whole bucket for the other token.
        pub fn swap(&mut self, input: FungibleBucket) -> FungibleBucket {
            let input_resource = input.resource_address();
            let input_amount = input.amount();
            let (output_amount, protocol_fee) = self.compute_swap(input_resource, input_amount);
            assert!(output_amount > Decimal::ZERO, "Trade too small");

            let k_before = pd(self.reserve_a).checked_mul(pd(self.reserve_b)).expect("Overflow");
            let a_in = input_resource == self.resource_a;
            let output = if a_in {
                self.vault_a.put(input);
                self.protocol_fees_a.put(self.vault_a.take(protocol_fee));
                self.reserve_a = self.reserve_a + input_amount - protocol_fee;
                self.reserve_b = self.reserve_b - output_amount;
                self.vault_b.take(output_amount)
            } else {
                self.vault_b.put(input);
                self.protocol_fees_b.put(self.vault_b.take(protocol_fee));
                self.reserve_b = self.reserve_b + input_amount - protocol_fee;
                self.reserve_a = self.reserve_a - output_amount;
                self.vault_a.take(output_amount)
            };
            let k_after = pd(self.reserve_a).checked_mul(pd(self.reserve_b)).expect("Overflow");
            assert!(k_after >= k_before, "Invariant violated");
            self.assert_books_match_vaults();

            Runtime::emit_event(SwapEvent {
                input_resource,
                input_amount,
                output_resource: if a_in { self.resource_b } else { self.resource_a },
                output_amount,
                protocol_fee,
            });
            output
        }

        /// Add liquidity in the pool's current ratio. Returns pool units and whatever was not needed.
        /// The first deposit sets the ratio and takes both buckets whole.
        pub fn add_liquidity(&mut self, mut a: FungibleBucket, mut b: FungibleBucket) -> (FungibleBucket, FungibleBucket, FungibleBucket) {
            assert!(a.resource_address() == self.resource_a && b.resource_address() == self.resource_b, "Wrong tokens");
            let (amount_a, amount_b) = (a.amount(), b.amount());
            assert!(amount_a > Decimal::ZERO && amount_b > Decimal::ZERO, "Both tokens are required");
            let supply = self.units.total_supply().expect("Supply is tracked");

            let (take_a, take_b, minted) = if supply.is_zero() {
                let total = floor(
                    pd(amount_a).checked_mul(pd(amount_b)).and_then(|p| p.checked_sqrt()).expect("Overflow"),
                    DIVISIBILITY_MAXIMUM,
                );
                assert!(total >= MIN_INITIAL_UNITS, "First deposit too small");
                self.locked_units.put(self.units.mint(LOCKED_UNITS));
                (amount_a, amount_b, total - LOCKED_UNITS)
            } else {
                // Units for the smaller of the two shares offered, rounded down ...
                let share_a = pd(amount_a).checked_div(pd(self.reserve_a)).expect("Overflow");
                let share_b = pd(amount_b).checked_div(pd(self.reserve_b)).expect("Overflow");
                let share = if share_a < share_b { share_a } else { share_b };
                let minted = floor(share.checked_mul(pd(supply)).expect("Overflow"), DIVISIBILITY_MAXIMUM);
                assert!(minted > Decimal::ZERO, "Deposit too small");
                // ... and the tokens those units cost, rounded UP. The depositor never underpays.
                let cost = |reserve: Decimal, divisibility: u8| {
                    ceil(pd(minted).checked_mul(pd(reserve)).and_then(|v| v.checked_div(pd(supply))).expect("Overflow"), divisibility)
                };
                let take_a = cost(self.reserve_a, self.divisibility_a);
                let take_b = cost(self.reserve_b, self.divisibility_b);
                assert!(take_a > Decimal::ZERO && take_b > Decimal::ZERO, "Deposit too small");
                assert!(take_a <= amount_a && take_b <= amount_b, "Deposit does not cover its units");
                (take_a, take_b, minted)
            };

            self.vault_a.put(a.take(take_a));
            self.vault_b.put(b.take(take_b));
            self.reserve_a = self.reserve_a + take_a;
            self.reserve_b = self.reserve_b + take_b;
            self.assert_books_match_vaults();
            Runtime::emit_event(LiquidityEvent { amount_a: take_a, amount_b: take_b, units: minted });
            (self.units.mint(minted), a, b)
        }

        /// Burn pool units for their share of both reserves, rounded down.
        pub fn remove_liquidity(&mut self, units: FungibleBucket) -> (FungibleBucket, FungibleBucket) {
            assert!(units.resource_address() == self.units.address(), "Not this pool's units");
            let amount = units.amount();
            let supply = self.units.total_supply().expect("Supply is tracked");
            let share = |reserve: Decimal, divisibility: u8| {
                floor(pd(amount).checked_mul(pd(reserve)).and_then(|v| v.checked_div(pd(supply))).expect("Overflow"), divisibility)
            };
            let out_a = share(self.reserve_a, self.divisibility_a);
            let out_b = share(self.reserve_b, self.divisibility_b);
            units.burn();
            self.reserve_a = self.reserve_a - out_a;
            self.reserve_b = self.reserve_b - out_b;
            let result = (self.vault_a.take(out_a), self.vault_b.take(out_b));
            self.assert_books_match_vaults();
            Runtime::emit_event(LiquidityEvent { amount_a: -out_a, amount_b: -out_b, units: -amount });
            result
        }

        /// Owner only: collect the protocol's share of fees. Reserves are untouched.
        pub fn claim_protocol_fees(&mut self) -> (FungibleBucket, FungibleBucket) {
            (self.protocol_fees_a.take_all(), self.protocol_fees_b.take_all())
        }

        /// Returns (output amount, protocol fee). Output is rounded down, fees are rounded up.
        fn compute_swap(&self, input_resource: ResourceAddress, input_amount: Decimal) -> (Decimal, Decimal) {
            let (reserve_in, reserve_out, div_in, div_out) = if input_resource == self.resource_a {
                (self.reserve_a, self.reserve_b, self.divisibility_a, self.divisibility_b)
            } else if input_resource == self.resource_b {
                (self.reserve_b, self.reserve_a, self.divisibility_b, self.divisibility_a)
            } else {
                panic!("Token is not in this pool")
            };
            assert!(input_amount > Decimal::ZERO, "Nothing to swap");
            assert!(reserve_in > Decimal::ZERO && reserve_out > Decimal::ZERO, "Pool is empty");

            let bps = |n: u16| pd(input_amount).checked_mul(PreciseDecimal::from(n)).and_then(|v| v.checked_div(PreciseDecimal::from(10_000u32))).expect("Overflow");
            // A fee that is not zero costs at least one unit of the input token, so a dust trade cannot dodge it.
            let total_fee = ceil(bps(self.lp_fee_bps + self.protocol_fee_bps), div_in);
            let protocol_fee = floor(bps(self.protocol_fee_bps), div_in);
            let effective = input_amount - total_fee;
            if effective <= Decimal::ZERO {
                return (Decimal::ZERO, protocol_fee);
            }
            let output = floor(
                pd(reserve_out)
                    .checked_mul(pd(effective))
                    .and_then(|v| v.checked_div(pd(reserve_in).checked_add(pd(effective)).expect("Overflow")))
                    .expect("Overflow"),
                div_out,
            );
            assert!(output < reserve_out, "Not enough liquidity");
            (output, protocol_fee)
        }

        /// The books and the vaults must agree after every state change.
        fn assert_books_match_vaults(&self) {
            assert!(self.vault_a.amount() == self.reserve_a && self.vault_b.amount() == self.reserve_b, "Books do not match vaults");
        }
    }
}
