//! Pool audit of 22 Nov 2026 (docs/review-2026-11-21/pool-audit.md).
//!
//! Tests named `finding_*` reproduce a weakness of the published `Pool` and print the loss.
//! They PASS when the weakness is present, so the suite stays green while documenting it.
//! Tests named `property_*` check things that must hold, and fail if they do not.

use scrypto_test::prelude::*;

#[derive(Clone, Copy)]
struct Actor {
    key: Secp256k1PublicKey,
    account: ComponentAddress,
}

struct World {
    ledger: DefaultLedgerSimulator,
    package: PackageAddress,
    owner: Actor,
    attacker: Actor,
}

impl World {
    fn new() -> Self {
        let mut ledger = LedgerSimulatorBuilder::new().build();
        let (key, _, account) = ledger.new_allocated_account();
        let (akey, _, aaccount) = ledger.new_allocated_account();
        let package = ledger.compile_and_publish(this_package!());
        Self { ledger, package, owner: Actor { key, account }, attacker: Actor { key: akey, account: aaccount } }
    }

    fn run_as(&mut self, who: Actor, manifest: TransactionManifestV1) -> TransactionReceipt {
        self.ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&who.key)])
    }

    fn balance(&mut self, who: Actor, resource: ResourceAddress) -> Decimal {
        self.ledger.get_component_balance(who.account, resource)
    }

    /// A fungible token with the given roles, all of it deposited to the owner.
    fn token_with(&mut self, supply: Decimal, divisibility: u8, roles: FungibleResourceRoles) -> ResourceAddress {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_fungible_resource(OwnerRole::None, true, divisibility, roles, metadata!(), Some(supply))
            .try_deposit_entire_worktop_or_abort(self.owner.account, None)
            .build();
        self.ledger.execute_manifest(manifest, vec![]).expect_commit(true).new_resource_addresses()[0]
    }

    fn token(&mut self, supply: Decimal, divisibility: u8) -> ResourceAddress {
        self.token_with(supply, divisibility, FungibleResourceRoles::default())
    }

    fn give(&mut self, to: Actor, resource: ResourceAddress, amount: Decimal) {
        let owner = self.owner;
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(owner.account, resource, amount)
            .try_deposit_entire_worktop_or_abort(to.account, None)
            .build();
        self.run_as(owner, manifest).expect_commit_success();
    }

    fn pool(&mut self, a: ResourceAddress, b: ResourceAddress, lp: u16, protocol: u16, badge: ResourceAddress) -> (ComponentAddress, ResourceAddress) {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .call_function(self.package, "Pool", "instantiate", manifest_args!(a, b, lp, protocol, badge))
            .build();
        let owner = self.owner;
        let receipt = self.run_as(owner, manifest);
        let commit = receipt.expect_commit_success();
        (commit.new_component_addresses()[0], commit.new_resource_addresses()[0])
    }

    /// add_liquidity; if `min_units` is given the manifest asserts the worktop holds at least that many units.
    fn add(&mut self, who: Actor, pool: ComponentAddress, units: ResourceAddress, a: ResourceAddress, amount_a: Decimal, b: ResourceAddress, amount_b: Decimal, min_units: Option<Decimal>) -> TransactionReceipt {
        let mut m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(who.account, a, amount_a)
            .withdraw_from_account(who.account, b, amount_b)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_method_with_name_lookup(pool, "add_liquidity", |lookup| (lookup.bucket("a"), lookup.bucket("b")));
        if let Some(min) = min_units {
            m = m.assert_worktop_contains(units, min);
        }
        let manifest = m.deposit_entire_worktop(who.account).build();
        self.run_as(who, manifest)
    }

    fn remove(&mut self, who: Actor, pool: ComponentAddress, units: ResourceAddress, amount: Decimal) -> TransactionReceipt {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(who.account, units, amount)
            .take_all_from_worktop(units, "u")
            .call_method_with_name_lookup(pool, "remove_liquidity", |lookup| (lookup.bucket("u"),))
            .deposit_entire_worktop(who.account)
            .build();
        self.run_as(who, manifest)
    }

    fn swap(&mut self, who: Actor, pool: ComponentAddress, input: ResourceAddress, amount: Decimal) -> TransactionReceipt {
        let manifest = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(who.account, input, amount)
            .take_all_from_worktop(input, "in")
            .call_method_with_name_lookup(pool, "swap", |lookup| (lookup.bucket("in"),))
            .deposit_entire_worktop(who.account)
            .build();
        self.run_as(who, manifest)
    }

    fn reserves(&mut self, pool: ComponentAddress) -> (Decimal, Decimal) {
        let manifest = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "reserves", manifest_args!()).build();
        self.ledger.execute_manifest(manifest, vec![]).expect_commit_success().output(1)
    }

    /// The pool's vault of `resource` that holds the reserve (the larger of its two vaults of that token).
    fn reserve_vault(&mut self, pool: ComponentAddress, resource: ResourceAddress) -> InternalAddress {
        let vaults = self.ledger.get_component_vaults(pool, resource);
        let mut best = (vaults[0], Decimal::ZERO);
        for v in vaults {
            let b = self.ledger.inspect_vault_balance(v).unwrap_or_default();
            if b > best.1 {
                best = (v, b);
            }
        }
        InternalAddress::new_or_panic(best.0 .0)
    }
}

fn recallable_roles() -> FungibleResourceRoles {
    FungibleResourceRoles {
        recall_roles: recall_roles! { recaller => rule!(allow_all); recaller_updater => rule!(deny_all); },
        freeze_roles: freeze_roles! { freezer => rule!(allow_all); freezer_updater => rule!(deny_all); },
        ..Default::default()
    }
}

fn pd(d: Decimal) -> PreciseDecimal {
    PreciseDecimal::from(d)
}

// ======================================================================= findings

/// F1. A token issuer who can recall takes ONE unit from the pool's vault. The books no longer
/// match the vault, so every swap, deposit and withdrawal panics for ever: the other token (here
/// USD) is locked in the pool too.
#[test]
fn finding_recall_of_one_unit_locks_both_tokens_for_ever() {
    let mut w = World::new();
    let owner = w.owner;
    let badge = w.token(dec!(1), 0);
    let usd = w.token(dec!(1_000_000), 6);
    let rec = w.token_with(dec!(1_000_000), 18, recallable_roles());
    let (pool, units) = w.pool(rec, usd, 30, 10, badge);
    w.add(owner, pool, units, rec, dec!(10_000), usd, dec!(5_000), None).expect_commit_success();
    let lp_units = w.balance(owner, units);

    // The issuer (anyone, with this token's allow_all recaller) recalls a single unit.
    let vault = w.reserve_vault(pool, rec);
    let attacker = w.attacker;
    let recall = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .recall(vault, dec!(1))
        .try_deposit_entire_worktop_or_abort(attacker.account, None)
        .build();
    w.run_as(attacker, recall).expect_commit_success();

    w.swap(owner, pool, usd, dec!(10)).expect_commit_failure_containing_error("Books do not match vaults");
    // Withdrawing everything fails at the vault (the books promise more REC than the vault holds) ...
    w.remove(owner, pool, units, lp_units).expect_commit_failure();
    // ... and any smaller withdrawal fails the books check.
    w.remove(owner, pool, units, lp_units / dec!(1000)).expect_commit_failure_containing_error("Books do not match vaults");
    println!("F1: recalling 1 of 10,000 REC locked the LP's 5,000 USD and 9,999 REC permanently");
}

/// F1b. A freeze of the pool's vault of one token halts withdrawals of BOTH tokens until lifted.
#[test]
fn finding_freeze_of_one_vault_halts_withdrawal_of_both_tokens() {
    let mut w = World::new();
    let owner = w.owner;
    let badge = w.token(dec!(1), 0);
    let usd = w.token(dec!(1_000_000), 6);
    let frz = w.token_with(dec!(1_000_000), 18, recallable_roles());
    let (pool, units) = w.pool(frz, usd, 30, 10, badge);
    w.add(owner, pool, units, frz, dec!(10_000), usd, dec!(5_000), None).expect_commit_success();
    let lp_units = w.balance(owner, units);

    let vault = w.reserve_vault(pool, frz);
    let freeze = ManifestBuilder::new().lock_fee_from_faucet().freeze_withdraw(vault).build();
    w.ledger.execute_manifest(freeze, vec![]).expect_commit_success();
    // Withdrawals of either token fail, and so do swaps in both directions.
    assert!(!w.remove(owner, pool, units, lp_units).is_commit_success());
    assert!(!w.swap(owner, pool, usd, dec!(10)).is_commit_success());
    assert!(!w.swap(owner, pool, frz, dec!(10)).is_commit_success());

    let unfreeze = ManifestBuilder::new().lock_fee_from_faucet().unfreeze_withdraw(vault).build();
    w.ledger.execute_manifest(unfreeze, vec![]).expect_commit_success();
    w.remove(owner, pool, units, lp_units).expect_commit_success();
    println!("F1b: while one vault was frozen the LP could withdraw neither token; unfreezing restored it");
}

/// F2. Instantiation and the first deposit are two transactions. Anyone who seeds the empty pool
/// first, with dust at an absurd price, sets the ratio; an owner who then deposits without a
/// minimum-units assertion deposits at that ratio and is arbitraged.
#[test]
fn finding_pre_seeded_pool_robs_an_unprotected_first_deposit() {
    let mut w = World::new();
    let (owner, attacker) = (w.owner, w.attacker);
    let badge = w.token(dec!(1), 0);
    let xrd = w.token(dec!(1_000_000_000_000), 18); // stand-in for XRD
    let usd = w.token(dec!(1_000_000_000), 6); // like hUSDC
    w.give(attacker, xrd, dec!(10));
    w.give(attacker, usd, dec!(1));
    let (pool, units) = w.pool(xrd, usd, 30, 10, badge);
    // Fair price: 10 XRD per USD.

    // Attacker seeds first: 1 XRD and 0.000001 USD (1,000,000 XRD per USD). sqrt = 0.001 units.
    w.add(attacker, pool, units, xrd, dec!(1), usd, dec!("0.000001"), None).expect_commit_success();

    // The protected deposit (asserting the units a fresh pool would give, less 1%) is refused ...
    let expected = dec!("7905.69"); // sqrt(25,000 x 2,500)
    w.add(owner, pool, units, xrd, dec!(25_000), usd, dec!(2_500), Some(expected * dec!("0.99")))
        .expect_commit_failure();

    // ... the unprotected one (the shape stokenet-setup.ts uses) goes through.
    let (x0, u0) = (w.balance(owner, xrd), w.balance(owner, usd));
    w.add(owner, pool, units, xrd, dec!(25_000), usd, dec!(2_500), None).expect_commit_success();
    let (x_in, u_in) = (x0 - w.balance(owner, xrd), u0 - w.balance(owner, usd));

    // Attacker buys the cheap XRD with a few cents of USD.
    let (ax0, au0) = (w.balance(attacker, xrd), w.balance(attacker, usd));
    w.swap(attacker, pool, usd, dec!("0.03")).expect_commit_success();
    let attacker_gain = (w.balance(attacker, xrd) - ax0) - (au0 - w.balance(attacker, usd)) * dec!(10);

    let my_units = w.balance(owner, units);
    w.remove(owner, pool, units, my_units).expect_commit_success();
    let (x1, u1) = (w.balance(owner, xrd), w.balance(owner, usd));
    let value = |x: Decimal, u: Decimal| x + u * dec!(10);
    let loss = value(x0, u0) - value(x1, u1);
    println!("F2: owner put in {x_in} XRD + {u_in} USD; attacker gained {attacker_gain} XRD-equivalent; owner lost {loss} XRD-equivalent");
    assert!(loss > dec!(13_000), "owner loses over half the XRD deposited");
}

/// F3. After every provider withdraws, the locked sliver keeps dust reserves whose ratio, after
/// rounding on a low-divisibility token, is far from the last price. The next deposit is made at
/// that ratio (the first-deposit path is never taken again).
#[test]
fn finding_emptied_pool_keeps_a_dust_price_that_robs_the_next_deposit() {
    let mut w = World::new();
    let (owner, attacker) = (w.owner, w.attacker);
    let badge = w.token(dec!(1), 0);
    let tickets = w.token(dec!(1_000_000), 0);
    let xrd = w.token(dec!(1_000_000_000_000), 18);
    w.give(attacker, xrd, dec!(10));
    let (pool, units) = w.pool(tickets, xrd, 30, 10, badge);
    // Fair price 50 XRD per ticket.
    w.add(owner, pool, units, tickets, dec!(1000), xrd, dec!(50_000), None).expect_commit_success();
    let all = w.balance(owner, units);
    w.remove(owner, pool, units, all).expect_commit_success();
    let (rt, rx) = w.reserves(pool);
    println!("F3: after full withdrawal the reserves are {rt} tickets : {rx} XRD (price {} XRD/ticket)", rx / rt);

    // Owner comes back and re-adds at the fair price, without an assertion.
    let value = |w: &mut World| { let t = w.balance(owner, tickets); let x = w.balance(owner, xrd); x + t * dec!(50) };
    let before = value(&mut w);
    w.add(owner, pool, units, tickets, dec!(1000), xrd, dec!(50_000), None).expect_commit_success();
    // Attacker buys almost all the tickets for 1 XRD.
    let t0 = w.balance(attacker, tickets);
    w.swap(attacker, pool, xrd, dec!(1)).expect_commit_success();
    let bought = w.balance(attacker, tickets) - t0;
    let mine = w.balance(owner, units);
    w.remove(owner, pool, units, mine).expect_commit_success();
    let loss = before - value(&mut w);
    println!("F3: attacker paid 1 XRD for {bought} tickets; owner lost {loss} XRD-equivalent");
    assert!(bought > dec!(900));
}

/// F3b. The same with a 6-place stablecoin like hUSDC: the dust left behind prices XRD wrongly.
#[test]
fn finding_emptied_xrd_usd6_pool_dust_price_is_wrong() {
    let mut w = World::new();
    let owner = w.owner;
    let badge = w.token(dec!(1), 0);
    let xrd = w.token(dec!(1_000_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    let (pool, units) = w.pool(xrd, usd, 30, 10, badge);
    w.add(owner, pool, units, xrd, dec!(25_000), usd, dec!(2_500), None).expect_commit_success(); // 10 XRD per USD
    let all = w.balance(owner, units);
    w.remove(owner, pool, units, all).expect_commit_success();
    let (rx, ru) = w.reserves(pool);
    println!("F3b: after full withdrawal {rx} XRD : {ru} USD, i.e. {} XRD per USD (was 10)", rx / ru);
    assert!(rx / ru < dec!(5));
}

/// F4. remove_liquidity multiplies units by reserve before dividing. With a token of very large
/// supply the product passes PreciseDecimal's ~5.8e40 and every withdrawal of a useful size panics.
#[test]
fn finding_huge_supply_token_overflows_withdrawal() {
    let mut w = World::new();
    let owner = w.owner;
    let badge = w.token(dec!(1), 0);
    // 5e27 is close to the most one mint may create (2^152 attos); larger supplies need several mints.
    let big = w.token(dec!("5000000000000000000000000000"), 18);
    let xrd = w.token(dec!(1_000_000_000_000), 18);
    let (pool, units) = w.pool(big, xrd, 30, 10, badge);
    w.add(owner, pool, units, big, dec!("5000000000000000000000000000"), xrd, dec!(100_000), None).expect_commit_success();
    let mine = w.balance(owner, units);
    println!("F4: units held {mine}");
    // Swaps still work ...
    w.swap(owner, pool, xrd, dec!(10)).expect_commit_success();
    // ... but the provider cannot withdraw all, or even 1%.
    w.remove(owner, pool, units, mine).expect_commit_failure_containing_error("Overflow");
    w.remove(owner, pool, units, mine / dec!(100)).expect_commit_failure_containing_error("Overflow");
    // Only slivers of under ~1.1e13 units (5e-4 % of the holding) can be withdrawn per call.
    w.remove(owner, pool, units, dec!(10_000_000_000_000)).expect_commit_success();
}

// ======================================================================= properties

/// Every swap pays at most the exact (unrounded) constant-product amount after fee, and k never falls.
/// Covers divisibility pairs 18/18, 6/18, 8/18, 0/18, 6/6, 0/6 and trades from dust to 30% of a reserve.
#[test]
fn property_swaps_round_for_the_pool_and_k_never_falls() {
    for (da, db) in [(18u8, 18u8), (6, 18), (8, 18), (0, 18), (6, 6), (0, 6)] {
        let mut w = World::new();
        let owner = w.owner;
        let badge = w.token(dec!(1), 0);
        let a = w.token(dec!(1_000_000_000), da);
        let b = w.token(dec!(1_000_000_000), db);
        let (pool, units) = w.pool(a, b, 30, 10, badge);
        w.add(owner, pool, units, a, dec!(100_000), b, dec!(37_123), None).expect_commit_success();
        let unit = |d: u8| Decimal::ONE / Decimal::from(10i64.pow(d.min(18) as u32));
        let mut k_last = { let r = w.reserves(pool); pd(r.0) * pd(r.1) };
        let sizes = [dec!("0.000000000000000001"), dec!("0.000001"), dec!("0.37"), dec!(1), dec!(13), dec!(777), dec!(5_000), dec!(30_000)];
        for (i, s) in sizes.iter().enumerate() {
            for a_in in [true, false] {
                let (input, output, d_in) = if a_in { (a, b, da) } else { (b, a, db) };
                let amount = (*s / unit(d_in)).checked_floor().unwrap() * unit(d_in);
                if amount.is_zero() { continue; }
                let (ra, rb) = w.reserves(pool);
                let (r_in, r_out) = if a_in { (ra, rb) } else { (rb, ra) };
                let before = w.balance(owner, output);
                let receipt = w.swap(owner, pool, input, amount);
                if !receipt.is_commit_success() { continue; } // "Trade too small" is fine
                let got = w.balance(owner, output) - before;
                let eff = pd(amount) * (PreciseDecimal::ONE - pdec!("0.004"));
                let ideal = pd(r_out) * eff / (pd(r_in) + eff);
                assert!(pd(got) <= ideal + pdec!("0.000000000000000000000000000001"), "{da}/{db} size {i}: paid {got} > ideal {ideal}");
                let r = w.reserves(pool);
                let k = pd(r.0) * pd(r.1);
                assert!(k >= k_last, "{da}/{db} size {i}: k fell");
                k_last = k;
            }
        }
    }
}

/// Add-then-remove never returns more of either token than was put in, for 6- and 18-place tokens
/// (the existing suite covers 8 and 0).
#[test]
fn property_add_remove_round_trip_never_profits_on_6_and_18_places() {
    for (da, db) in [(6u8, 18u8), (6, 6), (18, 18)] {
        let mut w = World::new();
        let owner = w.owner;
        let badge = w.token(dec!(1), 0);
        let a = w.token(dec!(1_000_000_000), da);
        let b = w.token(dec!(1_000_000_000), db);
        let (pool, units) = w.pool(a, b, 30, 10, badge);
        w.add(owner, pool, units, a, dec!("1234.567891"), b, dec!("98765.432109"), None).expect_commit_success();
        let start = (w.balance(owner, a), w.balance(owner, b));
        let r0 = w.reserves(pool);
        for i in 0..25u32 {
            let xa = Decimal::from(1 + (i * 7) % 23) * dec!("0.000001");
            let xb = Decimal::from(1 + (i * 13) % 97) * dec!("0.000791");
            let u0 = w.balance(owner, units);
            if !w.add(owner, pool, units, a, xa, b, xb, None).is_commit_success() { continue; }
            let minted = w.balance(owner, units) - u0;
            w.remove(owner, pool, units, minted).expect_commit_success();
            assert!(w.balance(owner, a) <= start.0 && w.balance(owner, b) <= start.1, "{da}/{db} round {i}: gained");
        }
        let r1 = w.reserves(pool);
        assert!(r1.0 >= r0.0 && r1.1 >= r0.1);
    }
}

/// The classic share-inflation attack: the first depositor makes the pool tiny, then pumps the
/// unit price with fee-paying round-trip swaps. The second depositor still loses only dust,
/// because they are charged for exactly the units minted (rounded up) and get the change back.
#[test]
fn property_first_depositor_inflation_by_swaps_fails() {
    let mut w = World::new();
    let (victim, attacker) = (w.owner, w.attacker);
    let badge = w.token(dec!(1), 0);
    let a = w.token(dec!(1_000_000_000), 18);
    let b = w.token(dec!(1_000_000_000), 18);
    w.give(attacker, a, dec!(100_000));
    w.give(attacker, b, dec!(100_000));
    let (pool, units) = w.pool(a, b, 100, 0, badge); // 1% LP fee: the most fee per swap
    let attacker_start = w.balance(attacker, a) + w.balance(attacker, b);
    w.add(attacker, pool, units, a, dec!("0.001"), b, dec!("0.001"), None).expect_commit_success();
    for _ in 0..20 {
        let before = w.balance(attacker, b);
        w.swap(attacker, pool, a, dec!(1000)).expect_commit_success();
        let got = w.balance(attacker, b) - before;
        w.swap(attacker, pool, b, got).expect_commit_success();
    }
    let (ra, rb) = w.reserves(pool);
    println!("inflation: reserves after pumping {ra} : {rb} against 0.001 units of supply");

    let (va, vb) = (w.balance(victim, a), w.balance(victim, b));
    w.add(victim, pool, units, a, dec!(50_000), b, dec!(50_000), None).expect_commit_success();
    let minted = w.balance(victim, units);
    w.remove(victim, pool, units, minted).expect_commit_success();
    let (la, lb) = (va - w.balance(victim, a), vb - w.balance(victim, b));
    println!("inflation: victim lost {la} A and {lb} B on a 50,000 + 50,000 deposit");
    assert!(la < dec!("0.000001") && lb < dec!("0.000001"));
    let units_left = w.balance(attacker, units);
    w.remove(attacker, pool, units, units_left).expect_commit_success();
    let attacker_cost = attacker_start - (w.balance(attacker, a) + w.balance(attacker, b));
    println!("inflation: attacker spent {attacker_cost} on the attempt");
}

/// Swaps and deposits emit events; protocol-fee claims do not.
#[test]
fn property_events_are_emitted() {
    let mut w = World::new();
    let owner = w.owner;
    let badge = w.token(dec!(1), 0);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let (pool, units) = w.pool(a, b, 30, 10, badge);
    let names = |w: &World, r: &TransactionReceipt| -> Vec<String> {
        r.expect_commit_success().application_events.iter().map(|(id, _)| w.ledger.event_name(id)).collect()
    };
    let r = w.add(owner, pool, units, a, dec!(100), b, dec!(100), None);
    assert!(names(&w, &r).contains(&"LiquidityEvent".to_string()));
    let r = w.swap(owner, pool, a, dec!(1));
    assert!(names(&w, &r).contains(&"SwapEvent".to_string()));
    let mine = w.balance(owner, units);
    let r = w.remove(owner, pool, units, mine);
    assert!(names(&w, &r).contains(&"LiquidityEvent".to_string()));
    let claim = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_amount(owner.account, badge, dec!(1))
        .call_method(pool, "claim_protocol_fees", manifest_args!())
        .deposit_entire_worktop(owner.account)
        .build();
    let r = w.run_as(owner, claim);
    let n = names(&w, &r);
    assert!(!n.iter().any(|x| x == "SwapEvent" || x == "LiquidityEvent"), "claim emits no pool event: {n:?}");
}

/// What the owner badge can and cannot do after instantiation.
#[test]
fn property_owner_powers_are_limited() {
    let mut w = World::new();
    let (owner, attacker) = (w.owner, w.attacker);
    let badge = w.token(dec!(1), 0);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 18);
    let (pool, units) = w.pool(a, b, 30, 10, badge);
    let with_badge = |m: ManifestBuilder| m.lock_fee_from_faucet().create_proof_from_account_of_amount(owner.account, badge, dec!(1));

    // Owner may rename the pool and add metadata keys ...
    w.run_as(owner, with_badge(ManifestBuilder::new()).set_metadata(pool, "name", "renamed").build()).expect_commit_success();
    w.run_as(owner, with_badge(ManifestBuilder::new()).set_metadata(pool, "description", "anything").build()).expect_commit_success();
    // ... but not change the locked token addresses, nor add a royalty, nor mint units or edit their metadata.
    w.run_as(owner, with_badge(ManifestBuilder::new()).set_metadata(pool, "resource_a", GlobalAddress::from(b)).build()).expect_commit_failure();
    w.run_as(owner, with_badge(ManifestBuilder::new()).set_component_royalty(pool, "swap", RoyaltyAmount::Xrd(dec!(1))).build()).expect_commit_failure();
    w.run_as(owner, with_badge(ManifestBuilder::new()).mint_fungible(units, dec!(1)).deposit_entire_worktop(owner.account).build()).expect_commit_failure();
    w.run_as(owner, with_badge(ManifestBuilder::new()).set_metadata(units, "name", "x").build()).expect_commit_failure();
    // Without the badge nothing, not even the name.
    w.run_as(attacker, ManifestBuilder::new().lock_fee_from_faucet().set_metadata(pool, "name", "x").build()).expect_commit_failure();
}
