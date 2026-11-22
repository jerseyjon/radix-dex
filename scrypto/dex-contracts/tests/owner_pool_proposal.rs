//! Tests for the PROPOSED `OwnerPool` blueprint (pool audit, 22 Nov 2026). Not published.

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
    other: Actor,
    badge: ResourceAddress,
}

impl World {
    fn new() -> Self {
        let mut ledger = LedgerSimulatorBuilder::new().build();
        let (key, _, account) = ledger.new_allocated_account();
        let (okey, _, oaccount) = ledger.new_allocated_account();
        let package = ledger.compile_and_publish(this_package!());
        let badge = ledger.create_fungible_resource(dec!(1), 0, account);
        Self { ledger, package, owner: Actor { key, account }, other: Actor { key: okey, account: oaccount }, badge }
    }

    fn run_as(&mut self, who: Actor, manifest: TransactionManifestV1) -> TransactionReceipt {
        self.ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&who.key)])
    }

    fn balance(&mut self, who: Actor, resource: ResourceAddress) -> Decimal {
        self.ledger.get_component_balance(who.account, resource)
    }

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
        let m = ManifestBuilder::new().lock_fee_from_faucet().withdraw_from_account(owner.account, resource, amount)
            .try_deposit_entire_worktop_or_abort(to.account, None).build();
        self.run_as(owner, m).expect_commit_success();
    }

    /// Instantiate funded in one transaction.
    fn pool(&mut self, a: ResourceAddress, amount_a: Decimal, b: ResourceAddress, amount_b: Decimal, fee_bps: u16) -> ComponentAddress {
        let (owner, badge, package) = (self.owner, self.badge, self.package);
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(owner.account, a, amount_a)
            .withdraw_from_account(owner.account, b, amount_b)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_function_with_name_lookup(package, "OwnerPool", "instantiate_with_liquidity", |l| (l.bucket("a"), l.bucket("b"), fee_bps, badge))
            .build();
        self.run_as(owner, m).expect_commit_success().new_component_addresses()[0]
    }

    fn owner_call(&mut self, who: Actor, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let badge = self.badge;
        let mut m = ManifestBuilder::new().lock_fee_from_faucet();
        if who.account == self.owner.account {
            m = m.create_proof_from_account_of_amount(who.account, badge, dec!(1));
        }
        let m = m.call_method(pool, method, args).deposit_entire_worktop(who.account).build();
        self.run_as(who, m)
    }

    fn deposit(&mut self, who: Actor, pool: ComponentAddress, a: ResourceAddress, amount_a: Decimal) -> TransactionReceipt {
        let badge = self.badge;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_amount(self.owner.account, badge, dec!(1))
            .withdraw_from_account(who.account, a, amount_a)
            .take_all_from_worktop(a, "a")
            .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("a")), None::<ManifestBucket>))
            .build();
        self.run_as(who, m)
    }

    fn swap(&mut self, who: Actor, pool: ComponentAddress, input: ResourceAddress, amount: Decimal, minimum: Option<Decimal>) -> TransactionReceipt {
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(who.account, input, amount)
            .take_all_from_worktop(input, "in");
        let m = match minimum {
            None => m.call_method_with_name_lookup(pool, "swap", |l| (l.bucket("in"),)),
            Some(min) => m.call_method_with_name_lookup(pool, "swap_with_minimum", |l| (l.bucket("in"), min)),
        };
        let m = m.deposit_entire_worktop(who.account).build();
        self.run_as(who, m)
    }

    fn reserves(&mut self, pool: ComponentAddress) -> (Decimal, Decimal) {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "reserves", manifest_args!()).build();
        self.ledger.execute_manifest(m, vec![]).expect_commit_success().output(1)
    }
}

#[test]
fn proposal_only_the_owner_moves_liquidity() {
    let mut w = World::new();
    let (owner, other) = (w.owner, w.other);
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    w.give(other, xrd, dec!(1000));
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), 30);
    assert_eq!(w.reserves(pool), (dec!(25_000), dec!(2_500)));
    // An outsider can neither deposit nor withdraw.
    let m = ManifestBuilder::new().lock_fee_from_faucet().withdraw_from_account(other.account, xrd, dec!(10)).take_all_from_worktop(xrd, "a")
        .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("a")), None::<ManifestBucket>)).build();
    w.run_as(other, m).expect_commit_failure();
    w.owner_call(other, pool, "withdraw_all", manifest_args!()).expect_commit_failure();
    w.owner_call(other, pool, "set_fee", manifest_args!(0u16)).expect_commit_failure();
    w.owner_call(other, pool, "set_paused", manifest_args!(true)).expect_commit_failure();
    // The owner can withdraw everything at any time.
    let before = w.balance(owner, xrd);
    w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_success();
    assert_eq!(w.balance(owner, xrd) - before, dec!(25_000));
    assert_eq!(w.reserves(pool), (Decimal::ZERO, Decimal::ZERO));
    w.swap(other, pool, xrd, dec!(1), None).expect_commit_failure_containing_error("Pool is empty");
}

#[test]
fn proposal_fee_cap_pause_minimum_and_one_sided_price_moves() {
    let mut w = World::new();
    let (owner, other) = (w.owner, w.other);
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    w.give(other, xrd, dec!(1000));
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), 30);

    w.owner_call(owner, pool, "set_fee", manifest_args!(101u16)).expect_commit_failure_containing_error("Fee too high");
    w.owner_call(owner, pool, "set_fee", manifest_args!(10u16)).expect_commit_success();

    // 100 XRD at 0.1% fee: out = 2500 * 99.9 / 25099.9 = 9.950238 (rounded down to 6 places).
    w.swap(other, pool, xrd, dec!(100), Some(dec!("9.950239"))).expect_commit_failure_containing_error("Less than the minimum");
    let before = w.balance(other, usd);
    w.swap(other, pool, xrd, dec!(100), Some(dec!("9.950238"))).expect_commit_success();
    assert_eq!(w.balance(other, usd) - before, dec!("9.950238"));

    w.owner_call(owner, pool, "set_paused", manifest_args!(true)).expect_commit_success();
    w.swap(other, pool, xrd, dec!(1), None).expect_commit_failure_containing_error("Swaps are paused");
    // Withdrawals still work while paused.
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(1), dec!(1))).expect_commit_success();
    w.owner_call(owner, pool, "set_paused", manifest_args!(false)).expect_commit_success();

    // A one-sided deposit moves the price: the bot's lever.
    let (rx, ru) = w.reserves(pool);
    w.deposit(owner, pool, xrd, rx).expect_commit_success();
    let (rx2, ru2) = w.reserves(pool);
    assert_eq!((rx2, ru2), (rx * dec!(2), ru));
}

#[test]
fn proposal_recall_does_not_brick_and_huge_supplies_do_not_overflow() {
    let mut w = World::new();
    let owner = w.owner;
    let roles = FungibleResourceRoles {
        recall_roles: recall_roles! { recaller => rule!(allow_all); recaller_updater => rule!(deny_all); },
        ..Default::default()
    };
    let rec = w.token_with(dec!(1_000_000), 18, roles);
    let usd = w.token(dec!(1_000_000), 6);
    let pool = w.pool(rec, dec!(10_000), usd, dec!(5_000), 30);
    let vault = w.ledger.get_component_vaults(pool, rec)[0];
    let m = ManifestBuilder::new().lock_fee_from_faucet().recall(InternalAddress::new_or_panic(vault.0), dec!(1))
        .try_deposit_entire_worktop_or_abort(owner.account, None).build();
    w.ledger.execute_manifest(m, vec![]).expect_commit_success();
    w.swap(owner, pool, usd, dec!(10), None).expect_commit_success();
    w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_success();

    let big = w.token(dec!("5000000000000000000000000000"), 18);
    let xrd = w.token(dec!(1_000_000_000), 18);
    let pool = w.pool(big, dec!("4000000000000000000000000000"), xrd, dec!(100_000), 30);
    w.swap(owner, pool, xrd, dec!(10), None).expect_commit_success();
    w.swap(owner, pool, big, dec!("1000000000000000000000000"), None).expect_commit_success();
    w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_success();
}

/// Same rounding property as the published pool: never pay more than the exact amount, k never falls.
#[test]
fn proposal_swaps_round_for_the_pool_and_k_never_falls() {
    for (da, db) in [(18u8, 18u8), (6, 18), (0, 18), (6, 6)] {
        let mut w = World::new();
        let owner = w.owner;
        let a = w.token(dec!(1_000_000_000), da);
        let b = w.token(dec!(1_000_000_000), db);
        let pool = w.pool(a, dec!(100_000), b, dec!(37_123), 40);
        let pd = PreciseDecimal::from;
        let mut k_last = { let r = w.reserves(pool); pd(r.0) * pd(r.1) };
        for s in [dec!("0.000001"), dec!("0.37"), dec!(13), dec!(777), dec!(30_000)] {
            for a_in in [true, false] {
                let (input, output, d_in) = if a_in { (a, b, da) } else { (b, a, db) };
                let amount = s.checked_round(d_in, RoundingMode::ToZero).unwrap();
                if amount.is_zero() { continue; }
                let (ra, rb) = w.reserves(pool);
                let (r_in, r_out) = if a_in { (ra, rb) } else { (rb, ra) };
                let before = w.balance(owner, output);
                if !w.swap(owner, pool, input, amount, None).is_commit_success() { continue; }
                let got = w.balance(owner, output) - before;
                let eff = pd(amount) * (PreciseDecimal::ONE - pdec!("0.004"));
                assert!(pd(got) <= pd(r_out) * eff / (pd(r_in) + eff) + pdec!("0.000000000000000000000000000001"));
                let r = w.reserves(pool);
                let k = pd(r.0) * pd(r.1);
                assert!(k >= k_last);
                k_last = k;
            }
        }
    }
}
