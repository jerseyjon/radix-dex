use scrypto::prelude::*;

/// Upper bound on the maker fee, in basis points (1%).
pub const MAX_MAKER_FEE_BPS: u16 = 100;

/// What the receipt NFT says about the order it controls. Informational: the order's live state
/// is in the component.
#[derive(ScryptoSbor, NonFungibleData)]
pub struct OrderReceipt {
    pub sell_resource: ResourceAddress,
    pub sell_amount: Decimal,
    pub buy_resource: ResourceAddress,
    pub price: Decimal,
}

#[derive(ScryptoSbor, Clone)]
pub struct Order {
    /// Account that is paid as the order fills.
    pub maker: Global<Account>,
    pub sell_resource: ResourceAddress,
    pub buy_resource: ResourceAddress,
    /// Buy tokens the maker is owed for each one sell token.
    pub price: Decimal,
    /// Sell tokens the order was placed with.
    pub sell_amount: Decimal,
    /// Sell tokens still for sale.
    pub remaining: Decimal,
    /// Sell tokens handed back when the order was cancelled.
    pub returned: Decimal,
    /// Buy tokens earned that the maker's account would not accept; held here until claimed.
    pub unclaimed: Decimal,
    /// Fee taken from what the maker is paid, fixed when the order was placed.
    pub maker_fee_bps: u16,
    /// Unix seconds after which the order can no longer be filled. Zero means never.
    pub expires_at: i64,
    pub open: bool,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OrderPlacedEvent {
    pub id: u64,
    pub maker: Global<Account>,
    pub sell_resource: ResourceAddress,
    pub sell_amount: Decimal,
    pub buy_resource: ResourceAddress,
    pub price: Decimal,
    pub expires_at: i64,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OrderFilledEvent {
    pub id: u64,
    pub sold: Decimal,
    pub paid: Decimal,
    pub fee: Decimal,
    pub remaining: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OrderClosedEvent {
    pub id: u64,
    pub returned: Decimal,
}

fn pd(value: Decimal) -> PreciseDecimal {
    PreciseDecimal::from(value)
}

fn round(value: PreciseDecimal, divisibility: u8, mode: RoundingMode) -> Decimal {
    value
        .checked_round(divisibility, mode)
        .and_then(|v| Decimal::try_from(v).ok())
        .expect("Amount out of range")
}

fn divisibility_of(resource: ResourceAddress) -> u8 {
    match ResourceManager::from(resource).resource_type() {
        ResourceType::Fungible { divisibility } => divisibility,
        ResourceType::NonFungible { .. } => panic!("Only fungible tokens can be traded"),
    }
}

#[blueprint]
#[events(OrderPlacedEvent, OrderFilledEvent, OrderClosedEvent)]
mod order_book {
    enable_method_auth! {
        methods {
            place => PUBLIC;
            fill => PUBLIC;
            cancel => PUBLIC;
            claim => PUBLIC;
            get_order => PUBLIC;
            set_maker_fee_bps => restrict_to: [OWNER];
            collect_fees => restrict_to: [OWNER];
        }
    }

    /// Resting limit orders that can be filled a part at a time.
    ///
    /// A maker puts in the tokens they are selling and names a price. Anyone may then buy any
    /// part of what is left by paying that price; the payment goes straight to the maker's
    /// account. Whoever holds the order's receipt can take back what has not been sold.
    ///
    /// Safety rules this code is written to, each of which the tests exercise:
    ///
    /// 1. **The price is enforced here, not by any server.** A buyer never receives more sell
    ///    tokens than their payment covers at the order's price.
    /// 2. **Every rounding goes against the buyer.** Tokens sold are rounded down, the cost up.
    /// 3. **One order cannot touch another's funds.** Tokens of the same kind share a vault, but
    ///    each order can only ever pay out its own `remaining` and `unclaimed`, which change
    ///    only in the methods below.
    /// 4. **Only the receipt holder can take funds back.** There is no admin path to them: the
    ///    owner can set the fee for future orders (capped at 1%) and collect fees, nothing else.
    /// 5. **A maker who refuses deposits harms only themselves.** If their account will not take
    ///    the payment it is kept for them, and the fill still goes through.
    struct OrderBook {
        orders: KeyValueStore<u64, Order>,
        next_id: u64,
        vaults: KeyValueStore<ResourceAddress, FungibleVault>,
        fees: KeyValueStore<ResourceAddress, FungibleVault>,
        receipts: NonFungibleResourceManager,
        maker_fee_bps: u16,
    }

    impl OrderBook {
        /// `owner_badge` may set the maker fee for future orders and collect fees; nothing else.
        pub fn instantiate(maker_fee_bps: u16, owner_badge: ResourceAddress) -> Global<OrderBook> {
            assert!(maker_fee_bps <= MAX_MAKER_FEE_BPS, "Fee too high");
            let (reservation, address) = Runtime::allocate_component_address(OrderBook::blueprint_id());
            let receipts = ResourceBuilder::new_integer_non_fungible::<OrderReceipt>(OwnerRole::None)
                .metadata(metadata! {
                    init {
                        "name" => "radix-dex order receipt", locked;
                        "description" => "Controls one resting order: whoever holds it can cancel the order and take back what is unsold.", locked;
                        "order_book" => GlobalAddress::from(address), locked;
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
                orders: KeyValueStore::new(),
                next_id: 1,
                vaults: KeyValueStore::new(),
                fees: KeyValueStore::new(),
                receipts,
                maker_fee_bps,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(owner_badge))))
            .with_address(reservation)
            .metadata(metadata! {
                init {
                    "name" => "radix-dex order book", updatable;
                    "description" => "Resting limit orders with partial fills. Not audited.", updatable;
                }
            })
            .globalize()
        }

        /// Offer the whole of `sell` at `price` buy tokens for each sell token. Payment goes to
        /// `maker`. Returns the receipt that controls the order.
        pub fn place(&mut self, sell: FungibleBucket, buy_resource: ResourceAddress, price: Decimal, maker: Global<Account>, expires_at: i64) -> NonFungibleBucket {
            let sell_resource = sell.resource_address();
            let sell_amount = sell.amount();
            assert!(sell_resource != buy_resource, "The two tokens must differ");
            assert!(sell_amount > Decimal::ZERO, "Nothing to sell");
            assert!(price > Decimal::ZERO, "Price must be positive");
            assert!(expires_at >= 0, "Bad expiry");
            divisibility_of(buy_resource); // must be a fungible token
            // The whole order must be payable: its total cost has to fit in a Decimal.
            round(pd(sell_amount).checked_mul(pd(price)).expect("Order too large"), 18, RoundingMode::ToPositiveInfinity);

            let id = self.next_id;
            self.next_id += 1;
            Self::put(&mut self.vaults, sell);
            self.orders.insert(id, Order {
                maker,
                sell_resource,
                buy_resource,
                price,
                sell_amount,
                remaining: sell_amount,
                returned: Decimal::ZERO,
                unclaimed: Decimal::ZERO,
                maker_fee_bps: self.maker_fee_bps,
                expires_at,
                open: true,
            });
            Runtime::emit_event(OrderPlacedEvent { id, maker, sell_resource, sell_amount, buy_resource, price, expires_at });
            self.receipts.mint_non_fungible(&NonFungibleLocalId::integer(id), OrderReceipt { sell_resource, sell_amount, buy_resource, price })
        }

        /// Buy as much of order `id` as `payment` covers at the order's price, up to what is left.
        /// Returns the tokens bought and whatever part of the payment was not needed.
        pub fn fill(&mut self, id: u64, mut payment: FungibleBucket) -> (FungibleBucket, FungibleBucket) {
            let mut order = self.orders.get_mut(&id).expect("Unknown order");
            assert!(order.open, "Order is closed");
            assert!(payment.resource_address() == order.buy_resource, "Wrong payment token");
            if order.expires_at > 0 {
                assert!(
                    Clock::current_time_is_strictly_before(Instant::new(order.expires_at), TimePrecision::Second),
                    "Order has expired"
                );
            }
            let sell_divisibility = divisibility_of(order.sell_resource);
            let buy_divisibility = divisibility_of(order.buy_resource);

            // Sold rounds down, cost rounds up: the maker never gets less than their price.
            let affordable = round(pd(payment.amount()).checked_div(pd(order.price)).expect("Overflow"), sell_divisibility, RoundingMode::ToNegativeInfinity);
            let sold = if affordable < order.remaining { affordable } else { order.remaining };
            assert!(sold > Decimal::ZERO, "Payment too small");
            let cost = round(pd(sold).checked_mul(pd(order.price)).expect("Overflow"), buy_divisibility, RoundingMode::ToPositiveInfinity);
            assert!(cost > Decimal::ZERO && cost <= payment.amount(), "Payment too small");

            let mut paid = payment.take(cost);
            let fee = round(pd(cost).checked_mul(pd(Decimal::from(order.maker_fee_bps))).expect("Overflow") / pd(dec!(10000)), buy_divisibility, RoundingMode::ToNegativeInfinity);
            if fee > Decimal::ZERO {
                Self::put(&mut self.fees, paid.take(fee));
            }
            // Pay the maker now. If their account refuses, keep it for them to claim.
            let mut maker = order.maker;
            if let Some(refused) = maker.try_deposit_or_refund(paid.into(), None) {
                order.unclaimed += refused.amount();
                Self::put(&mut self.vaults, refused.as_fungible());
            }

            order.remaining -= sold;
            if order.remaining == Decimal::ZERO {
                order.open = false;
            }
            let remaining = order.remaining;
            let sell_resource = order.sell_resource;
            drop(order);

            let bought = self.vaults.get_mut(&sell_resource).expect("No vault").take(sold);
            Runtime::emit_event(OrderFilledEvent { id, sold, paid: cost, fee, remaining });
            (bought, payment)
        }

        /// Close the order and take back what is unsold, plus any payment that could not be
        /// delivered. The receipt is burnt.
        pub fn cancel(&mut self, receipt: NonFungibleBucket) -> (FungibleBucket, FungibleBucket) {
            assert!(receipt.resource_address() == self.receipts.address(), "Not an order receipt");
            assert!(receipt.amount() == Decimal::ONE, "One receipt at a time");
            let id = match receipt.non_fungible_local_id() {
                NonFungibleLocalId::Integer(i) => i.value(),
                _ => panic!("Bad receipt"),
            };
            receipt.burn();

            let mut order = self.orders.get_mut(&id).expect("Unknown order");
            let (returned, unclaimed) = (order.remaining, order.unclaimed);
            order.remaining = Decimal::ZERO;
            order.returned += returned;
            order.unclaimed = Decimal::ZERO;
            order.open = false;
            let (sell_resource, buy_resource) = (order.sell_resource, order.buy_resource);
            drop(order);

            Runtime::emit_event(OrderClosedEvent { id, returned });
            (Self::take(&mut self.vaults, sell_resource, returned), Self::take(&mut self.vaults, buy_resource, unclaimed))
        }

        /// Take payment that could not be delivered to the maker's account, leaving the order as it is.
        pub fn claim(&mut self, receipt: NonFungibleProof) -> FungibleBucket {
            let checked = receipt.check(self.receipts.address());
            let id = match checked.non_fungible_local_id() {
                NonFungibleLocalId::Integer(i) => i.value(),
                _ => panic!("Bad receipt"),
            };
            let mut order = self.orders.get_mut(&id).expect("Unknown order");
            let unclaimed = order.unclaimed;
            order.unclaimed = Decimal::ZERO;
            let buy_resource = order.buy_resource;
            drop(order);
            Self::take(&mut self.vaults, buy_resource, unclaimed)
        }

        pub fn get_order(&self, id: u64) -> Order {
            self.orders.get(&id).expect("Unknown order").clone()
        }

        /// Applies to orders placed from now on. Existing orders keep the fee they were placed with.
        pub fn set_maker_fee_bps(&mut self, maker_fee_bps: u16) {
            assert!(maker_fee_bps <= MAX_MAKER_FEE_BPS, "Fee too high");
            self.maker_fee_bps = maker_fee_bps;
        }

        pub fn collect_fees(&mut self, resource: ResourceAddress) -> FungibleBucket {
            match self.fees.get_mut(&resource) {
                Some(mut vault) => vault.take_all(),
                None => FungibleBucket::new(resource),
            }
        }

        fn put(vaults: &mut KeyValueStore<ResourceAddress, FungibleVault>, bucket: FungibleBucket) {
            let resource = bucket.resource_address();
            if vaults.get(&resource).is_none() {
                vaults.insert(resource, FungibleVault::with_bucket(bucket));
            } else {
                vaults.get_mut(&resource).unwrap().put(bucket);
            }
        }

        fn take(vaults: &mut KeyValueStore<ResourceAddress, FungibleVault>, resource: ResourceAddress, amount: Decimal) -> FungibleBucket {
            if amount == Decimal::ZERO {
                return FungibleBucket::new(resource);
            }
            vaults.get_mut(&resource).expect("No vault").take(amount)
        }
    }
}
