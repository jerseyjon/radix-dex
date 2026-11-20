//! Tests for the order registry and the pool, including attempts to drain the pool by rounding.

use scrypto_test::prelude::*;

struct World {
    ledger: DefaultLedgerSimulator,
    key: Secp256k1PublicKey,
    account: ComponentAddress,
    package: PackageAddress,
}

impl World {
    fn new() -> Self {
        let mut ledger = LedgerSimulatorBuilder::new().build();
        let (key, _, account) = ledger.new_allocated_account();
        let package = ledger.compile_and_publish(this_package!());
        Self { ledger, key, account, package }
    }

    fn run(&mut self, manifest: TransactionManifestV1) -> TransactionReceipt {
        self.ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(self.key)])
    }

    fn balance(&mut self, resource: ResourceAddress) -> Decimal {
        self.ledger.get_component_balance(self.account, resource)
    }

    fn token(&mut self, supply: Decimal, divisibility: u8) -> ResourceAddress {
        self.ledger.create_fungible_resource(supply, divisibility, self.account)
    }

    /// Instantiate a pool of `a` and `b` and return (pool, pool unit resource).
    fn pool(&mut self, a: ResourceAddress, b: ResourceAddress, lp_fee_bps: u16, protocol_fee_bps: u16, owner_badge: ResourceAddress) -> (ComponentAddress, ResourceAddress) {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .call_function(self.package, "Pool", "instantiate", manifest_args!(a, b, lp_fee_bps, protocol_fee_bps, owner_badge))
            .build();
        let receipt = self.run(manifest);
        let commit = receipt.expect_commit_success();
        (commit.new_component_addresses()[0], commit.new_resource_addresses()[0])
    }

    fn add(&mut self, pool: ComponentAddress, a: ResourceAddress, amount_a: Decimal, b: ResourceAddress, amount_b: Decimal) -> TransactionReceipt {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(self.account, a, amount_a)
            .withdraw_from_account(self.account, b, amount_b)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_method_with_name_lookup(pool, "add_liquidity", |lookup| (lookup.bucket("a"), lookup.bucket("b")))
            .deposit_entire_worktop(self.account)
            .build();
        self.run(manifest)
    }

    fn remove(&mut self, pool: ComponentAddress, units: ResourceAddress, amount: Decimal) -> TransactionReceipt {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(self.account, units, amount)
            .take_all_from_worktop(units, "u")
            .call_method_with_name_lookup(pool, "remove_liquidity", |lookup| (lookup.bucket("u"),))
            .deposit_entire_worktop(self.account)
            .build();
        self.run(manifest)
    }

    fn swap(&mut self, pool: ComponentAddress, input: ResourceAddress, amount: Decimal) -> TransactionReceipt {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(self.account, input, amount)
            .take_all_from_worktop(input, "in")
            .call_method_with_name_lookup(pool, "swap", |lookup| (lookup.bucket("in"),))
            .deposit_entire_worktop(self.account)
            .build();
        self.run(manifest)
    }

    fn reserves(&mut self, pool: ComponentAddress) -> (Decimal, Decimal) {
        let manifest = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "reserves", manifest_args!()).build();
        self.run(manifest).expect_commit_success().output(1)
    }
}

// ---------------------------------------------------------------- Order registry

fn registry(world: &mut World) -> ComponentAddress {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(world.package, "OrderRegistry", "instantiate", manifest_args!())
        .build();
    world.run(manifest).expect_commit_success().new_component_addresses()[0]
}

fn registry_call(world: &mut World, registry: ComponentAddress, method: &str, bytes: Vec<u8>) -> TransactionReceipt {
    let manifest = ManifestBuilder::new().lock_fee_from_faucet().call_method(registry, method, manifest_args!(bytes)).build();
    world.run(manifest)
}

#[test]
fn registry_cancel_makes_the_order_key_dead_for_ever() {
    let mut world = World::new();
    let registry = registry(&mut world);
    let secret = vec![7u8; 32];
    let key = hash(&secret).to_vec();
    let other_key = hash(vec![8u8; 32]).to_vec();

    registry_call(&mut world, registry, "assert_live", key.clone()).expect_commit_success();
    registry_call(&mut world, registry, "cancel", secret.clone()).expect_commit_success();
    registry_call(&mut world, registry, "assert_live", key.clone()).expect_commit_failure_containing_error("Order has been cancelled");
    // Cancelling one order leaves every other order alone, and cancelling twice is harmless.
    registry_call(&mut world, registry, "assert_live", other_key).expect_commit_success();
    registry_call(&mut world, registry, "cancel", secret).expect_commit_success();
    registry_call(&mut world, registry, "assert_live", key).expect_commit_failure();
}

#[test]
fn registry_rejects_malformed_input() {
    let mut world = World::new();
    let registry = registry(&mut world);
    registry_call(&mut world, registry, "assert_live", vec![1u8; 31]).expect_commit_failure_containing_error("Order key must be 32 bytes");
    registry_call(&mut world, registry, "cancel", vec![1u8; 33]).expect_commit_failure_containing_error("Secret must be 32 bytes");
    // The key itself is not a secret: presenting the key to `cancel` cancels a different key.
    let secret = vec![9u8; 32];
    let key = hash(&secret).to_vec();
    registry_call(&mut world, registry, "cancel", key.clone()).expect_commit_success();
    registry_call(&mut world, registry, "assert_live", key).expect_commit_success();
}

// ---------------------------------------------------------------- Pool: ordinary behaviour

#[test]
fn pool_basic_lifecycle() {
    let mut world = World::new();
    let badge = world.token(dec!(1), 0);
    let usd = world.token(dec!(1_000_000), 18);
    let (pool, units) = world.pool(XRD, usd, 30, 10, badge);

    // First deposit sets the price: 1000 XRD : 100 USD.
    world.add(pool, XRD, dec!(1000), usd, dec!(100)).expect_commit_success();
    assert_eq!(world.reserves(pool), (dec!(1000), dec!(100)));
    let my_units = world.balance(units);
    // sqrt(1000 * 100) = 316.227766..., less the locked sliver.
    assert!(my_units > dec!("316.2277") && my_units < dec!("316.2278"));

    // Swap 10 XRD: fee 0.4% -> 9.96 effective; out = 100 * 9.96 / 1009.96 = 0.98617...
    let usd_before = world.balance(usd);
    world.swap(pool, XRD, dec!(10)).expect_commit_success();
    let got = world.balance(usd) - usd_before;
    assert!(got > dec!("0.98617") && got < dec!("0.98618"), "got {got}");
    // The protocol's 0.1% (0.01 XRD) left the reserves; the LP's 0.3% stayed in.
    let (ra, rb) = world.reserves(pool);
    assert_eq!(ra, dec!("1009.99"));
    assert_eq!(rb, dec!(100) - got);

    // A second deposit at a skewed ratio only takes what matches; the rest comes back.
    let xrd_before = world.balance(XRD);
    world.add(pool, XRD, dec!(500), usd, dec!(1)).expect_commit_success();
    let xrd_spent = xrd_before - world.balance(XRD);
    assert!(xrd_spent < dec!(11) && xrd_spent > dec!(10), "only ~10.2 XRD matches 1 USD, spent {xrd_spent}");

    // Removing everything we hold returns nearly all of both reserves (the locked sliver stays).
    let all = world.balance(units);
    world.remove(pool, units, all).expect_commit_success();
    let (ra, rb) = world.reserves(pool);
    assert!(ra > Decimal::ZERO && ra < dec!("0.0001"), "left {ra}");
    assert!(rb > Decimal::ZERO && rb < dec!("0.0001"), "left {rb}");
}

#[test]
fn pool_refuses_bad_setups_and_bad_calls() {
    let mut world = World::new();
    let badge = world.token(dec!(1), 0);
    let usd = world.token(dec!(1_000_000), 18);
    let other = world.token(dec!(1_000_000), 18);

    let instantiate = |world: &mut World, a: ResourceAddress, b: ResourceAddress, lp: u16, protocol: u16| {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .call_function(world.package, "Pool", "instantiate", manifest_args!(a, b, lp, protocol, badge))
            .build();
        world.run(manifest)
    };
    instantiate(&mut world, usd, usd, 30, 0).expect_commit_failure_containing_error("The two tokens must differ");
    instantiate(&mut world, XRD, usd, 101, 0).expect_commit_failure_containing_error("Fee too high");
    instantiate(&mut world, XRD, usd, 0, 101).expect_commit_failure_containing_error("Fee too high");

    let (pool, _) = world.pool(XRD, usd, 30, 0, badge);
    world.swap(pool, XRD, dec!(1)).expect_commit_failure_containing_error("Pool is empty");
    world.add(pool, XRD, dec!("0.0000001"), usd, dec!("0.0000001")).expect_commit_failure_containing_error("First deposit too small");
    world.add(pool, XRD, dec!(1000), usd, dec!(100)).expect_commit_success();
    world.swap(pool, other, dec!(1)).expect_commit_failure_containing_error("Token is not in this pool");
    // Tokens in the wrong order.
    world.add(pool, usd, dec!(1), XRD, dec!(1)).expect_commit_failure_containing_error("Wrong tokens");
    // Units of some other token cannot be redeemed.
    world.remove(pool, other, dec!(1)).expect_commit_failure_containing_error("Not this pool's units");
}

#[test]
fn only_the_owner_badge_can_claim_protocol_fees_and_reserves_are_untouched() {
    let mut world = World::new();
    let badge = world.token(dec!(1), 0);
    let usd = world.token(dec!(1_000_000), 18);
    let (pool, _) = world.pool(XRD, usd, 30, 10, badge);
    world.add(pool, XRD, dec!(1000), usd, dec!(100)).expect_commit_success();
    world.swap(pool, XRD, dec!(100)).expect_commit_success();
    let reserves = world.reserves(pool);

    let without_badge = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(pool, "claim_protocol_fees", manifest_args!())
        .deposit_entire_worktop(world.account)
        .build();
    world.run(without_badge).expect_commit_failure();

    let xrd_before = world.balance(XRD);
    let with_badge = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_amount(world.account, badge, dec!(1))
        .call_method(pool, "claim_protocol_fees", manifest_args!())
        .deposit_entire_worktop(world.account)
        .build();
    world.run(with_badge).expect_commit_success();
    assert_eq!(world.balance(XRD) - xrd_before, dec!("0.1"), "0.1% of the 100 XRD swapped");
    assert_eq!(world.reserves(pool), reserves);
}

// ---------------------------------------------------------------- Pool: attempts to drain it

/// The flaw used against native pools in November 2026: with a low-divisibility token, add and
/// remove liquidity over and over, gaining a rounding unit each time. Here every round trip must
/// leave the attacker with no more of EITHER token than they started with.
#[test]
fn add_remove_round_trips_never_profit_on_a_low_divisibility_token() {
    let mut world = World::new();
    let badge = world.token(dec!(1), 0);
    let btc = world.token(dec!(21), 8); // 8 decimals, like the wrapped bitcoins
    // A stand-in for XRD with a large supply: the test account's real XRD balance is only 10,000.
    let xrd = world.token(dec!(1_000_000_000), 18);
    let (pool, units) = world.pool(btc, xrd, 30, 0, badge);
    // An awkward ratio so that almost nothing divides evenly.
    world.add(pool, btc, dec!("0.01234567"), xrd, dec!("987654.321")).expect_commit_success();

    let start = (world.balance(btc), world.balance(xrd));
    let reserves_start = world.reserves(pool);
    for i in 0..40u32 {
        // Tiny, odd-sized deposits: the sizes where rounding matters most.
        let sats = Decimal::from(1 + (i * 7) % 23) * dec!("0.00000001");
        let xrd_amount = Decimal::from(1 + (i * 13) % 97) * dec!("0.791");
        let before_units = world.balance(units);
        let receipt = world.add(pool, btc, sats, xrd, xrd_amount);
        if !receipt.is_commit_success() {
            continue; // "Deposit too small" is an acceptable answer
        }
        let minted = world.balance(units) - before_units;
        world.remove(pool, units, minted).expect_commit_success();
        assert!(world.balance(btc) <= start.0, "round {i}: gained BTC");
        assert!(world.balance(xrd) <= start.1, "round {i}: gained XRD");
    }
    let reserves_end = world.reserves(pool);
    assert!(reserves_end.0 >= reserves_start.0 && reserves_end.1 >= reserves_start.1, "the pool never lost a unit of either token");
}

/// Swap back and forth in the smallest possible sizes. Each round trip must lose (or be refused),
/// and the pool's k must never fall.
#[test]
fn dust_swaps_never_profit_and_k_never_falls() {
    let mut world = World::new();
    let badge = world.token(dec!(1), 0);
    let btc = world.token(dec!(21), 8);
    // A stand-in for XRD with a large supply: the test account's real XRD balance is only 10,000.
    let xrd = world.token(dec!(1_000_000_000), 18);
    let (pool, _) = world.pool(btc, xrd, 30, 10, badge);
    world.add(pool, btc, dec!("0.5"), xrd, dec!("40000000")).expect_commit_success();

    let k = |r: (Decimal, Decimal)| PreciseDecimal::from(r.0) * PreciseDecimal::from(r.1);
    let mut last_k = k(world.reserves(pool));
    let start_btc = world.balance(btc);
    let start_xrd = world.balance(xrd);
    let mut refused = 0;
    for i in 0..30u32 {
        let sats = Decimal::from(1 + i % 5) * dec!("0.00000001");
        let xrd_before = world.balance(xrd);
        let receipt = world.swap(pool, btc, sats);
        if receipt.is_commit_success() {
            let xrd_got = world.balance(xrd) - xrd_before;
            // Swap the XRD straight back.
            let _ = world.swap(pool, xrd, xrd_got);
        } else {
            refused += 1; // "Trade too small": the fee alone is a whole satoshi
        }
        let now_k = k(world.reserves(pool));
        assert!(now_k >= last_k, "round {i}: k fell");
        last_k = now_k;
        assert!(world.balance(btc) <= start_btc, "round {i}: gained BTC");
    }
    assert!(world.balance(btc) < start_btc || refused == 30, "round trips cost the attacker BTC");
    // The attacker may end up holding XRD they bought with BTC when the swap back was refused as
    // too small. That is a purchase, not a profit: valued at the pool's opening price
    // (40,000,000 XRD for 0.5 BTC), their holdings must not have grown.
    let price = dec!(80_000_000);
    let value = |btc_amount: Decimal, xrd_amount: Decimal| btc_amount * price + xrd_amount;
    let end = value(world.balance(btc), world.balance(xrd));
    assert!(end <= value(start_btc, start_xrd), "holdings grew in value: {} -> {}", value(start_btc, start_xrd), end);
}

/// A token with no decimal places at all is the extreme case of the rounding problem.
#[test]
fn zero_divisibility_token_pool_rounds_against_the_caller() {
    let mut world = World::new();
    let badge = world.token(dec!(1), 0);
    let tickets = world.token(dec!(100_000), 0);
    // A stand-in for XRD with a large supply: the test account's real XRD balance is only 10,000.
    let xrd = world.token(dec!(1_000_000_000), 18);
    let (pool, units) = world.pool(tickets, xrd, 30, 0, badge);
    world.add(pool, tickets, dec!(1000), xrd, dec!(50_000)).expect_commit_success();

    // 1 ticket in: the fee rounds up to the whole ticket, so nothing comes out and the trade is refused.
    world.swap(pool, tickets, dec!(1)).expect_commit_failure_containing_error("Trade too small");

    // Buying tickets with XRD: 60 XRD would buy 1.19 tickets at the margin; you get 1, never 2.
    let before = world.balance(tickets);
    world.swap(pool, xrd, dec!(60)).expect_commit_success();
    assert_eq!(world.balance(tickets) - before, dec!(1));

    // Deposit sized for 0.5 of a ticket: units are minted for what was asked, but a whole ticket is charged.
    let (tickets_before, xrd_before, units_before) = (world.balance(tickets), world.balance(xrd), world.balance(units));
    let receipt = world.add(pool, tickets, dec!(5), xrd, dec!(25));
    if receipt.is_commit_success() {
        let minted = world.balance(units) - units_before;
        world.remove(pool, units, minted).expect_commit_success();
        assert!(world.balance(tickets) <= tickets_before && world.balance(xrd) <= xrd_before, "no gain from a fractional-ticket deposit");
        assert!(world.balance(tickets) < tickets_before || world.balance(xrd) < xrd_before, "and it cost something");
    }
}

/// The second depositor must get a fair share even if the first depositor made the pool tiny
/// and then traded to skew it (the classic first-depositor inflation attack).
#[test]
fn first_depositor_cannot_dilute_the_second() {
    let mut world = World::new();
    let badge = world.token(dec!(1), 0);
    let usd = world.token(dec!(10_000_000), 18);
    let (pool, units) = world.pool(XRD, usd, 30, 0, badge);
    // Smallest first deposit the pool accepts.
    world.add(pool, XRD, dec!("0.001"), usd, dec!("0.001")).expect_commit_success();
    let attacker_units = world.balance(units);
    // Attacker tries to leave as little supply as possible, then a victim deposits a large amount.
    world.remove(pool, units, attacker_units).expect_commit_success();
    let (xrd_before, usd_before) = (world.balance(XRD), world.balance(usd));
    world.add(pool, XRD, dec!(5000), usd, dec!(5000)).expect_commit_success();
    let victim_units = world.balance(units);
    assert!(victim_units > Decimal::ZERO);
    world.remove(pool, units, victim_units).expect_commit_success();
    // The victim gets back all but dust of whatever the pool actually took.
    assert!(xrd_before - world.balance(XRD) < dec!("0.000001"), "lost {} XRD", xrd_before - world.balance(XRD));
    assert!(usd_before - world.balance(usd) < dec!("0.000001"), "lost {} USD", usd_before - world.balance(usd));
}
