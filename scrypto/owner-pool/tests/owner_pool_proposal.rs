//! Tests for the `OwnerPool` blueprint (proposed in the pool audit, 22 Nov 2026; approved by the
//! owner with a 5% fee cap). Not published. Updated for the audit fixes (owner-pool-audit.md):
//! instantiation presents the badge (L-1), deposit/withdraw take a reserves guard (M-1, passed as
//! `None` here), and quote fails where swap would (L-2).

use scrypto_test::prelude::*;

/// `deposit`/`withdraw` reserves guard left off (audit M-1 fix; tested in owner_pool_audit2.rs).
const NO_GUARD: Option<(Decimal, Decimal)> = None;

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
            .create_proof_from_account_of_amount(owner.account, badge, dec!(1))
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
            .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("a")), None::<ManifestBucket>, NO_GUARD))
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
        .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("a")), None::<ManifestBucket>, NO_GUARD)).build();
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

    // The cap is 5% (500 bps).
    w.owner_call(owner, pool, "set_fee", manifest_args!(501u16)).expect_commit_failure_containing_error("Fee too high");
    w.owner_call(owner, pool, "set_fee", manifest_args!(500u16)).expect_commit_success();
    w.owner_call(owner, pool, "set_fee", manifest_args!(10u16)).expect_commit_success();

    // 100 XRD at 0.1% fee: out = 2500 * 99.9 / 25099.9 = 9.950238 (rounded down to 6 places).
    w.swap(other, pool, xrd, dec!(100), Some(dec!("9.950239"))).expect_commit_failure_containing_error("Less than the minimum");
    let before = w.balance(other, usd);
    w.swap(other, pool, xrd, dec!(100), Some(dec!("9.950238"))).expect_commit_success();
    assert_eq!(w.balance(other, usd) - before, dec!("9.950238"));

    w.owner_call(owner, pool, "set_paused", manifest_args!(true)).expect_commit_success();
    w.swap(other, pool, xrd, dec!(1), None).expect_commit_failure_containing_error("Swaps are paused");
    // Withdrawals still work while paused.
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(1), dec!(1), NO_GUARD)).expect_commit_success();
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

// ============================================================================ full coverage
// Added when the owner approved OwnerPool with a 5% fee cap.

const MAX_FEE_BPS: u16 = 500;

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct SwapEv {
    input_resource: ResourceAddress,
    input_amount: Decimal,
    output_resource: ResourceAddress,
    output_amount: Decimal,
    fee: Decimal,
    reserve_a: Decimal,
    reserve_b: Decimal,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct LiquidityEv {
    amount_a: Decimal,
    amount_b: Decimal,
    reserve_a: Decimal,
    reserve_b: Decimal,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct ConfigEv {
    fee_bps: u16,
    paused: bool,
}

impl World {
    fn events<T: ScryptoDecode>(&self, r: &TransactionReceipt, name: &str) -> Vec<T> {
        r.expect_commit_success()
            .application_events
            .iter()
            .filter(|(id, _)| self.ledger.event_name(id) == name)
            .map(|(_, data)| scrypto_decode::<T>(data).expect("event decodes"))
            .collect()
    }

    /// Call a read-only public method and decode its result.
    fn read<T: ScryptoDecode>(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> T {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, method, args).build();
        self.ledger.execute_manifest(m, vec![]).expect_commit_success().output(1)
    }

    fn try_read(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, method, args).build();
        self.ledger.execute_manifest(m, vec![])
    }

    /// `OwnerPool::instantiate` (empty pool).
    fn empty_pool(&mut self, a: ResourceAddress, b: ResourceAddress, fee_bps: u16) -> TransactionReceipt {
        let (owner, badge, package) = (self.owner, self.badge, self.package);
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_amount(owner.account, badge, dec!(1))
            .call_function(package, "OwnerPool", "instantiate", manifest_args!(a, b, fee_bps, badge))
            .build();
        self.run_as(owner, m)
    }

    fn try_pool(&mut self, a: ResourceAddress, amount_a: Decimal, b: ResourceAddress, amount_b: Decimal, fee_bps: u16) -> TransactionReceipt {
        let (owner, badge, package) = (self.owner, self.badge, self.package);
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_amount(owner.account, badge, dec!(1))
            .withdraw_from_account(owner.account, a, amount_a)
            .withdraw_from_account(owner.account, b, amount_b)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_function_with_name_lookup(package, "OwnerPool", "instantiate_with_liquidity", |l| (l.bucket("a"), l.bucket("b"), fee_bps, badge))
            .try_deposit_entire_worktop_or_abort(owner.account, None)
            .build();
        self.run_as(owner, m)
    }

    /// Deposit both tokens as `who`, presenting the owner badge only if `who` is the owner.
    fn deposit_both(&mut self, who: Actor, pool: ComponentAddress, a: ResourceAddress, amount_a: Decimal, b: ResourceAddress, amount_b: Decimal) -> TransactionReceipt {
        let badge = self.badge;
        let mut m = ManifestBuilder::new().lock_fee_from_faucet();
        if who.account == self.owner.account {
            m = m.create_proof_from_account_of_amount(who.account, badge, dec!(1));
        }
        let m = m
            .withdraw_from_account(who.account, a, amount_a)
            .withdraw_from_account(who.account, b, amount_b)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("a")), Some(l.bucket("b")), NO_GUARD))
            .try_deposit_entire_worktop_or_abort(who.account, None)
            .build();
        self.run_as(who, m)
    }

    fn set_fee(&mut self, pool: ComponentAddress, fee_bps: u16) -> TransactionReceipt {
        let owner = self.owner;
        self.owner_call(owner, pool, "set_fee", manifest_args!(fee_bps))
    }
}

fn pd(d: Decimal) -> PreciseDecimal {
    PreciseDecimal::from(d)
}

fn unit(divisibility: u8) -> Decimal {
    Decimal::ONE / Decimal::from(10u64.pow(divisibility as u32))
}

/// Both instantiation functions: bounds on the fee (cap 5%), distinct tokens, fungible tokens,
/// initial state and metadata.
#[test]
fn instantiate_checks_and_initial_state() {
    let mut w = World::new();
    let owner = w.owner;
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    let nft = w.ledger.create_non_fungible_resource(owner.account);

    // Empty pool: fee 0 and fee 500 accepted, 501 and u16::MAX refused.
    for fee in [0u16, 1, 30, MAX_FEE_BPS] {
        let r = w.empty_pool(xrd, usd, fee);
        let pool = r.expect_commit_success().new_component_addresses()[0];
        assert_eq!(w.read::<u16>(pool, "fee_bps", manifest_args!()), fee);
        assert!(!w.read::<bool>(pool, "is_paused", manifest_args!()));
        assert_eq!(w.reserves(pool), (Decimal::ZERO, Decimal::ZERO));
    }
    for fee in [MAX_FEE_BPS + 1, 1_000, u16::MAX] {
        w.empty_pool(xrd, usd, fee).expect_commit_failure_containing_error("Fee too high");
    }
    w.empty_pool(xrd, xrd, 30).expect_commit_failure_containing_error("The two tokens must differ");
    w.empty_pool(xrd, nft, 30).expect_commit_failure();

    // Funded pool: same fee bounds; tokens come back to the owner on failure (transaction aborts).
    let xrd_before = w.balance(owner, xrd);
    w.try_pool(xrd, dec!(100), usd, dec!(10), MAX_FEE_BPS + 1).expect_commit_failure_containing_error("Fee too high");
    assert_eq!(w.balance(owner, xrd), xrd_before);
    let pool = w.pool(xrd, dec!(100), usd, dec!(10), MAX_FEE_BPS);
    assert_eq!(w.read::<u16>(pool, "fee_bps", manifest_args!()), MAX_FEE_BPS);
    assert_eq!(w.reserves(pool), (dec!(100), dec!(10)));
    assert_eq!(w.balance(owner, xrd), xrd_before - dec!(100));

    // Locked metadata names the two tokens.
    let ra: Option<GlobalAddress> = w.ledger.get_metadata(pool.into(), "resource_a").map(|v| match v {
        MetadataValue::GlobalAddress(a) => a,
        other => panic!("unexpected {other:?}"),
    });
    assert_eq!(ra, Some(GlobalAddress::from(xrd)));
    let rb: Option<GlobalAddress> = w.ledger.get_metadata(pool.into(), "resource_b").map(|v| match v {
        MetadataValue::GlobalAddress(a) => a,
        other => panic!("unexpected {other:?}"),
    });
    assert_eq!(rb, Some(GlobalAddress::from(usd)));

    // An empty pool funded later by the owner's deposit.
    let pool = w.empty_pool(xrd, usd, 30).expect_commit_success().new_component_addresses()[0];
    w.swap(owner, pool, xrd, dec!(1), None).expect_commit_failure_containing_error("Pool is empty");
    let r = w.deposit_both(owner, pool, xrd, dec!(1_000), usd, dec!(100));
    let ev: Vec<LiquidityEv> = w.events(&r, "OwnerPoolLiquidityEvent");
    assert_eq!(ev, vec![LiquidityEv { amount_a: dec!(1_000), amount_b: dec!(100), reserve_a: dec!(1_000), reserve_b: dec!(100) }]);
    assert_eq!(w.reserves(pool), (dec!(1_000), dec!(100)));
}

/// Only the owner badge deposits and withdraws; amounts are exact; refused calls move nothing.
#[test]
fn owner_only_deposit_and_withdraw() {
    let mut w = World::new();
    let (owner, other) = (w.owner, w.other);
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    w.give(other, xrd, dec!(1_000));
    w.give(other, usd, dec!(1_000));
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), 30);

    // Outsider: deposit of both, deposit of one, withdraw, withdraw_all are all refused.
    let (ox, ou) = (w.balance(other, xrd), w.balance(other, usd));
    w.deposit_both(other, pool, xrd, dec!(10), usd, dec!(1)).expect_commit_failure();
    w.deposit(other, pool, xrd, dec!(10)).expect_commit_failure(); // presents the OWNER's proof from the wrong signer
    w.owner_call(other, pool, "withdraw", manifest_args!(dec!(1), dec!(1), NO_GUARD)).expect_commit_failure();
    w.owner_call(other, pool, "withdraw_all", manifest_args!()).expect_commit_failure();
    assert_eq!((w.balance(other, xrd), w.balance(other, usd)), (ox, ou));
    assert_eq!(w.reserves(pool), (dec!(25_000), dec!(2_500)));

    // Owner deposits both sides.
    w.deposit_both(owner, pool, xrd, dec!(1_000), usd, dec!("100.5")).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(26_000), dec!("2600.5")));

    // Owner withdraws exact amounts, including one side only.
    let (bx, bu) = (w.balance(owner, xrd), w.balance(owner, usd));
    let r = w.owner_call(owner, pool, "withdraw", manifest_args!(dec!("123.456"), dec!("0.000001"), NO_GUARD));
    let ev: Vec<LiquidityEv> = w.events(&r, "OwnerPoolLiquidityEvent");
    assert_eq!(ev[0].amount_a, dec!("-123.456"));
    assert_eq!(ev[0].amount_b, dec!("-0.000001"));
    assert_eq!(w.balance(owner, xrd) - bx, dec!("123.456"));
    assert_eq!(w.balance(owner, usd) - bu, dec!("0.000001"));
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(0), dec!(100), NO_GUARD)).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!("25876.544"), dec!("2500.499999")));

    // More than the pool holds, a negative amount, or finer than the token's divisibility: refused.
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(30_000), dec!(0), NO_GUARD)).expect_commit_failure();
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(-1), dec!(0), NO_GUARD)).expect_commit_failure();
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(0), dec!("0.0000001"), NO_GUARD)).expect_commit_failure();
    assert_eq!(w.reserves(pool), (dec!("25876.544"), dec!("2500.499999")));

    // Owner cannot deposit a foreign token, or put token B in the A slot.
    let other_token = w.token(dec!(1_000), 18);
    w.deposit(owner, pool, other_token, dec!(1)).expect_commit_failure_containing_error("Wrong token A");
    w.deposit(owner, pool, usd, dec!(1)).expect_commit_failure_containing_error("Wrong token A");
}

/// Swaps in both directions, at 0.3% and at the 5% cap, against numbers computed independently
/// (Python Decimal at 120 digits, emulating the contract's 36-place truncation). Events carry the fee.
#[test]
fn swap_both_directions_with_fee_exact_amounts() {
    let mut w = World::new();
    let other = w.other;
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    w.give(other, xrd, dec!(1_000));
    w.give(other, usd, dec!(1_000));
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), 30);

    assert_eq!(w.read::<Decimal>(pool, "quote", manifest_args!(xrd, dec!(100))), dec!("9.930397"));
    let before = w.balance(other, usd);
    let r = w.swap(other, pool, xrd, dec!(100), None);
    let ev: Vec<SwapEv> = w.events(&r, "OwnerPoolSwapEvent");
    assert_eq!(w.balance(other, usd) - before, dec!("9.930397"));
    assert_eq!(ev, vec![SwapEv {
        input_resource: xrd, input_amount: dec!(100), output_resource: usd, output_amount: dec!("9.930397"),
        fee: dec!("0.3"), reserve_a: dec!(25_100), reserve_b: dec!("2490.069603"),
    }]);

    let before = w.balance(other, xrd);
    let r = w.swap(other, pool, usd, dec!(10), None);
    let ev: Vec<SwapEv> = w.events(&r, "OwnerPoolSwapEvent");
    assert_eq!(w.balance(other, xrd) - before, dec!("100.097214340008197062"));
    assert_eq!(ev[0].fee, dec!("0.03"));
    assert_eq!(w.reserves(pool), (dec!("24999.902785659991802938"), dec!("2500.069603")));

    // At the 5% cap.
    let r = w.set_fee(pool, MAX_FEE_BPS);
    let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
    assert_eq!(ev, vec![ConfigEv { fee_bps: MAX_FEE_BPS, paused: false }]);
    let before = w.balance(other, usd);
    let r = w.swap(other, pool, xrd, dec!(100), None);
    let ev: Vec<SwapEv> = w.events(&r, "OwnerPoolSwapEvent");
    assert_eq!(w.balance(other, usd) - before, dec!("9.464336"));
    assert_eq!(ev[0].fee, dec!(5));
    let before = w.balance(other, xrd);
    let r = w.swap(other, pool, usd, dec!(10), None);
    let ev: Vec<SwapEv> = w.events(&r, "OwnerPoolSwapEvent");
    assert_eq!(w.balance(other, xrd) - before, dec!("95.375614623578136771"));
    assert_eq!(ev[0].fee, dec!("0.5"));
}

/// Fee changes: within the cap accepted (including 0 and exactly 500), above refused and the old
/// fee kept; the new fee applies to the next swap; only the owner may change it.
#[test]
fn fee_change_within_and_above_cap() {
    let mut w = World::new();
    let other = w.other;
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), 30);
    for fee in [0u16, 1, 100, 101, 499, MAX_FEE_BPS] {
        w.set_fee(pool, fee).expect_commit_success();
        assert_eq!(w.read::<u16>(pool, "fee_bps", manifest_args!()), fee);
    }
    for fee in [MAX_FEE_BPS + 1, 10_000, u16::MAX] {
        w.set_fee(pool, fee).expect_commit_failure_containing_error("Fee too high");
        assert_eq!(w.read::<u16>(pool, "fee_bps", manifest_args!()), MAX_FEE_BPS);
    }
    w.owner_call(other, pool, "set_fee", manifest_args!(0u16)).expect_commit_failure();
    assert_eq!(w.read::<u16>(pool, "fee_bps", manifest_args!()), MAX_FEE_BPS);

    // The quote follows the fee: 0% vs 5% on 100 XRD.
    w.set_fee(pool, 0).expect_commit_success();
    let q0 = w.read::<Decimal>(pool, "quote", manifest_args!(xrd, dec!(100)));
    assert_eq!(q0, dec!("9.960159")); // 2500 * 100 / 25100, rounded down
    w.set_fee(pool, MAX_FEE_BPS).expect_commit_success();
    let q5 = w.read::<Decimal>(pool, "quote", manifest_args!(xrd, dec!(100)));
    assert_eq!(q5, dec!("9.464036")); // 2500 * 95 / 25095, rounded down
    // Pausing keeps the fee and is reported in the config event.
    let owner = w.owner;
    let r = w.owner_call(owner, pool, "set_paused", manifest_args!(true));
    let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
    assert_eq!(ev, vec![ConfigEv { fee_bps: MAX_FEE_BPS, paused: true }]);
}

/// `swap_with_minimum` at the exact boundary at the 5% fee, and that a failed minimum moves nothing.
#[test]
fn minimum_out_assertion() {
    let mut w = World::new();
    let other = w.other;
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    w.give(other, usd, dec!(1_000));
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), MAX_FEE_BPS);
    // 10 USD at 5%: 25000 * 9.5 / 2509.5 = 94.640366606893803546 (rounded down).
    let expect = dec!("94.640366606893803546");
    assert_eq!(w.read::<Decimal>(pool, "quote", manifest_args!(usd, dec!(10))), expect);
    let (bx, bu) = (w.balance(other, xrd), w.balance(other, usd));
    w.swap(other, pool, usd, dec!(10), Some(expect + unit(18))).expect_commit_failure_containing_error("Less than the minimum");
    assert_eq!((w.balance(other, xrd), w.balance(other, usd)), (bx, bu));
    assert_eq!(w.reserves(pool), (dec!(25_000), dec!(2_500)));
    w.swap(other, pool, usd, dec!(10), Some(expect)).expect_commit_success();
    assert_eq!(w.balance(other, xrd) - bx, expect);
}

/// Zero and dust amounts: nothing is paid for nothing, a dust trade never dodges the fee, and
/// zero-amount liquidity calls are harmless.
#[test]
fn zero_and_dust_amounts() {
    let mut w = World::new();
    let (owner, other) = (w.owner, w.other);
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    let tkt = w.token(dec!(1_000_000), 0);
    w.give(other, xrd, dec!(1_000));
    w.give(other, tkt, dec!(1_000));
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), 30);

    w.swap(other, pool, xrd, dec!(0), None).expect_commit_failure_containing_error("Nothing to swap");
    w.try_read(pool, "quote", manifest_args!(xrd, dec!(0))).expect_commit_failure_containing_error("Nothing to swap");
    w.try_read(pool, "quote", manifest_args!(tkt, dec!(1))).expect_commit_failure_containing_error("Token is not in this pool");
    // 1e-18 XRD is worth far less than 0.000001 USD: refused, not paid zero (and quote agrees).
    w.try_read(pool, "quote", manifest_args!(xrd, unit(18))).expect_commit_failure_containing_error("Trade too small");
    w.swap(other, pool, xrd, unit(18), None).expect_commit_failure_containing_error("Trade too small");
    // 0.00001 XRD is worth 0.000000997 USD after the fee: under one unit, refused.
    w.swap(other, pool, xrd, dec!("0.00001"), None).expect_commit_failure_containing_error("Trade too small");

    // A 0-place token: the fee on 1 ticket rounds UP to the whole ticket, so a 1-ticket trade pays nothing and is refused.
    let tpool = w.pool(tkt, dec!(1_000), xrd, dec!(50_000), 30);
    w.try_read(tpool, "quote", manifest_args!(tkt, dec!(1))).expect_commit_failure_containing_error("Trade too small");
    w.swap(other, tpool, tkt, dec!(1), None).expect_commit_failure_containing_error("Trade too small");
    // 2 tickets: fee 1 ticket (rounded up), 1 effective: 50000 * 1 / 1001.
    let before = w.balance(other, xrd);
    w.swap(other, tpool, tkt, dec!(2), None).expect_commit_success();
    let got = w.balance(other, xrd) - before;
    assert!(pd(got) <= pdec!(50000) / pdec!(1001) && pd(got) > pdec!(50000) / pdec!(1001) - pdec!("0.000000000000000001"));
    // XRD in for tickets: anything worth under one whole ticket is refused.
    w.swap(other, tpool, xrd, dec!(40), None).expect_commit_failure_containing_error("Trade too small");
    // With no fee, 1 ticket buys a positive amount.
    w.set_fee(tpool, 0).expect_commit_success();
    w.swap(other, tpool, tkt, dec!(1), None).expect_commit_success();

    // Zero-amount liquidity calls change nothing and do not fail.
    let r0 = w.reserves(pool);
    let badge = w.badge;
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_amount(owner.account, badge, dec!(1))
        .call_method(pool, "deposit", manifest_args!(None::<ManifestBucket>, None::<ManifestBucket>, NO_GUARD))
        .build();
    w.run_as(owner, m).expect_commit_success();
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(0), dec!(0), NO_GUARD)).expect_commit_success();
    assert_eq!(w.reserves(pool), r0);
}

/// Emptying the pool (both sides, then one side) and refilling at a new price. With no pool units
/// there is no leftover dust price: the refill sets the price exactly.
#[test]
fn emptying_and_refilling() {
    let mut w = World::new();
    let (owner, other) = (w.owner, w.other);
    let xrd = w.token(dec!(1_000_000_000), 18);
    let usd = w.token(dec!(1_000_000_000), 6);
    w.give(other, xrd, dec!(1_000));
    w.give(other, usd, dec!(1_000));
    let pool = w.pool(xrd, dec!(25_000), usd, dec!(2_500), 30);
    w.swap(other, pool, xrd, dec!(100), None).expect_commit_success();
    w.swap(other, pool, usd, dec!(3), None).expect_commit_success();

    // Owner gets back exactly what the pool held, to the last unit.
    let (rx, ru) = w.reserves(pool);
    let (bx, bu) = (w.balance(owner, xrd), w.balance(owner, usd));
    w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_success();
    assert_eq!((w.balance(owner, xrd) - bx, w.balance(owner, usd) - bu), (rx, ru));
    assert_eq!(w.reserves(pool), (Decimal::ZERO, Decimal::ZERO));
    w.swap(other, pool, xrd, dec!(1), None).expect_commit_failure_containing_error("Pool is empty");
    w.swap(other, pool, usd, dec!(1), None).expect_commit_failure_containing_error("Pool is empty");
    w.try_read(pool, "quote", manifest_args!(xrd, dec!(1))).expect_commit_failure_containing_error("Pool is empty");
    w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_success(); // empty again: harmless

    // Refill at a new price (20 XRD per USD); the very next quote reflects it exactly.
    w.deposit_both(owner, pool, xrd, dec!(20_000), usd, dec!(1_000)).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(20_000), dec!(1_000)));
    // 1 USD at 0.3%: 20000 * 0.997 / 1000.997, rounded down.
    assert_eq!(w.read::<Decimal>(pool, "quote", manifest_args!(usd, dec!(1))), dec!("19.920139620798064329"));
    w.swap(other, pool, usd, dec!(1), None).expect_commit_success();

    // One side emptied: swaps both ways refuse ("Pool is empty"), never pay out of the other side.
    let (rx, _) = w.reserves(pool);
    w.owner_call(owner, pool, "withdraw", manifest_args!(rx, dec!(0), NO_GUARD)).expect_commit_success();
    w.swap(other, pool, usd, dec!(1), None).expect_commit_failure_containing_error("Pool is empty");
    w.swap(other, pool, xrd, dec!(1), None).expect_commit_failure_containing_error("Pool is empty");
    // A one-sided refill restores trading.
    w.deposit(owner, pool, xrd, dec!(20_000)).expect_commit_success();
    w.swap(other, pool, usd, dec!(1), None).expect_commit_success();
}

/// Tokens with divisibility below 18: outputs are rounded down to the output token's places, the
/// fee is rounded up to the input token's places, and balances never hold an invalid amount.
#[test]
fn low_divisibility_tokens() {
    for (da, db) in [(6u8, 18u8), (18, 6), (8, 6), (0, 18), (18, 0), (0, 6), (2, 2)] {
        let mut w = World::new();
        let other = w.other;
        let a = w.token(dec!(1_000_000_000), da);
        let b = w.token(dec!(1_000_000_000), db);
        w.give(other, a, dec!(100_000));
        w.give(other, b, dec!(100_000));
        let pool = w.pool(a, dec!(50_000), b, dec!(12_345), 30);
        for (input, output, din, dout) in [(a, b, da, db), (b, a, db, da)] {
            let amount = dec!("777.123456789123456789").checked_round(din, RoundingMode::ToZero).unwrap();
            let (r_in, r_out) = { let r = w.reserves(pool); if input == a { (r.0, r.1) } else { (r.1, r.0) } };
            let before = w.balance(other, output);
            let r = w.swap(other, pool, input, amount, None);
            let ev: Vec<SwapEv> = w.events(&r, "OwnerPoolSwapEvent");
            let got = w.balance(other, output) - before;
            assert_eq!(got, ev[0].output_amount);
            // Output is a whole number of the output token's smallest units.
            assert_eq!(got, got.checked_round(dout, RoundingMode::ToZero).unwrap(), "{da}/{db}: output {got} not at {dout} places");
            // Fee is the exact 0.3% rounded UP to the input token's places.
            let exact_fee = pd(amount) * pdec!("0.003");
            assert!(pd(ev[0].fee) >= exact_fee && pd(ev[0].fee) < exact_fee + pd(unit(din)));
            assert_eq!(ev[0].fee, ev[0].fee.checked_round(din, RoundingMode::ToZero).unwrap());
            // Output is the exact amount for that fee, rounded down by less than one unit.
            let eff = pd(amount - ev[0].fee);
            let exact = pd(r_out) * eff / (pd(r_in) + eff);
            assert!(pd(got) <= exact && pd(got) + pd(unit(dout)) > exact, "{da}/{db}: got {got}, exact {exact}");
        }
        // Withdrawal finer than the token allows is refused; at its places it works.
        let owner = w.owner;
        if da < 18 {
            let bad = unit(da + 1);
            w.owner_call(owner, pool, "withdraw", manifest_args!(bad, dec!(0), NO_GUARD)).expect_commit_failure();
        }
        w.owner_call(owner, pool, "withdraw", manifest_args!(unit(da), unit(db), NO_GUARD)).expect_commit_success();
        w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_success();
        assert_eq!(w.reserves(pool), (Decimal::ZERO, Decimal::ZERO));
    }
}

/// The constant product never falls across a long sequence of swaps of every size in both
/// directions, for many divisibility pairs and fees 0, 0.3% and the 5% cap; every swap pays at most
/// the exact unrounded amount for its fee, and at most one smallest unit less; the reserves move by
/// exactly the input and the output; and a swap refused as too small really was worth under one unit.
#[test]
fn constant_product_never_decreases() {
    let mut seed: u64 = _seed();
    for (da, db) in [(18u8, 18u8), (18, 6), (6, 18), (0, 18), (18, 0), (8, 6), (0, 6), (2, 0)] {
        let mut w = World::new();
        let other = w.other;
        let a = w.token(dec!(1_000_000_000_000), da);
        let b = w.token(dec!(1_000_000_000_000), db);
        w.give(other, a, dec!(10_000_000_000));
        w.give(other, b, dec!(10_000_000_000));
        for fee in [0u16, 30, MAX_FEE_BPS] {
            let pool = w.pool(a, dec!(1_000_000), b, dec!(371_234), fee);
            let mut k_last = { let r = w.reserves(pool); pd(r.0) * pd(r.1) };
            let (mut ok, mut small) = (0, 0);
            for i in 0..16 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let a_in = i % 2 == 0 || seed % 3 == 0;
                let (input, output, din, dout) = if a_in { (a, b, da, db) } else { (b, a, db, da) };
                let (ra, rb) = w.reserves(pool);
                let (r_in, r_out) = if a_in { (ra, rb) } else { (rb, ra) };
                // Size: 0.1% to 60% of the input reserve, scaled down by up to 10^9; or one smallest unit.
                let exp = (seed >> 8) % 20;
                let frac = pd(Decimal::from((seed >> 16) % 600 + 1)) / pdec!(1000) / PreciseDecimal::from(10u64.pow(exp as u32 / 2));
                let raw = Decimal::try_from(pd(r_in) * frac).unwrap_or(Decimal::ZERO);
                let amount = if exp >= 18 { unit(din) } else { raw.checked_round(din, RoundingMode::ToZero).unwrap() };
                if amount.is_zero() { continue; }
                let before = w.balance(other, output);
                let r = w.swap(other, pool, input, amount, None);
                let fee_paid = ceil_pd(pd(amount) * pd(Decimal::from(fee)) / pdec!(10000), din);
                let eff = pd(amount) - fee_paid;
                let exact = if eff > PreciseDecimal::ZERO { pd(r_out) * eff / (pd(r_in) + eff) } else { PreciseDecimal::ZERO };
                if !r.is_commit_success() {
                    assert!(format!("{r:?}").contains("Trade too small"), "{da}/{db} fee {fee}: unexpected failure {r:?}");
                    assert!(exact < pd(unit(dout)), "{da}/{db} fee {fee}: refused a trade worth {exact}");
                    small += 1;
                    continue;
                }
                ok += 1;
                let got = w.balance(other, output) - before;
                assert!(pd(got) <= exact, "{da}/{db} fee {fee}: paid {got} > exact {exact}");
                assert!(pd(got) + pd(unit(dout)) > exact, "{da}/{db} fee {fee}: paid {got}, a unit or more under exact {exact}");
                let (na, nb) = w.reserves(pool);
                if a_in { assert_eq!((na, nb), (ra + amount, rb - got)); } else { assert_eq!((na, nb), (ra - got, rb + amount)); }
                let k = pd(na) * pd(nb);
                assert!(k >= k_last, "{da}/{db} fee {fee}: k fell from {k_last} to {k}");
                k_last = k;
            }
            assert!(ok >= 4, "{da}/{db} fee {fee}: only {ok} swaps succeeded ({small} too small)");
        }
    }
}

/// A round trip (A to B, then all of that B back to A) never returns more A than was put in, at any fee.
#[test]
fn round_trip_never_gains() {
    for (da, db) in [(18u8, 6u8), (0, 18), (6, 6)] {
        for fee in [0u16, 30, MAX_FEE_BPS] {
            let mut w = World::new();
            let other = w.other;
            let a = w.token(dec!(1_000_000_000), da);
            let b = w.token(dec!(1_000_000_000), db);
            w.give(other, a, dec!(1_000_000));
            let pool = w.pool(a, dec!(100_000), b, dec!(37_123), fee);
            for s in [dec!(1), dec!(13), dec!(5_000), dec!(60_000)] {
                let (a0, b0) = (w.balance(other, a), w.balance(other, b));
                // A swap refused as too small moves nothing, which also never gains.
                let first = w.swap(other, pool, a, s, None);
                if !first.is_commit_success() {
                    assert!(format!("{first:?}").contains("Trade too small"));
                    assert_eq!(w.balance(other, a), a0);
                    continue;
                }
                let got_b = w.balance(other, b) - b0;
                let back = w.swap(other, pool, b, got_b, None);
                if !back.is_commit_success() {
                    assert!(format!("{back:?}").contains("Trade too small"));
                }
                assert!(w.balance(other, a) <= a0, "{da}/{db} fee {fee} size {s}: round trip gained");
            }
        }
    }
}

/// A freeze of one vault by its token's issuer: does the owner keep access to the OTHER token?
#[test]
fn freeze_of_one_vault_leaves_the_other_token_withdrawable() {
    let mut w = World::new();
    let owner = w.owner;
    let roles = FungibleResourceRoles {
        freeze_roles: freeze_roles! { freezer => rule!(allow_all); freezer_updater => rule!(deny_all); },
        ..Default::default()
    };
    let frz = w.token_with(dec!(1_000_000), 18, roles);
    let usd = w.token(dec!(1_000_000), 6);
    let pool = w.pool(frz, dec!(10_000), usd, dec!(5_000), 30);
    let vault = w.ledger.get_component_vaults(pool, frz)[0];
    let vault = InternalAddress::new_or_panic(vault.0);
    w.ledger.execute_manifest(ManifestBuilder::new().lock_fee_from_faucet().freeze_withdraw(vault).build(), vec![]).expect_commit_success();
    let before = w.balance(owner, usd);
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(0), dec!(5_000), NO_GUARD)).expect_commit_success();
    assert_eq!(w.balance(owner, usd) - before, dec!(5_000));
    // The frozen token itself stays put until the issuer unfreezes it; so does `withdraw_all`.
    w.owner_call(owner, pool, "withdraw", manifest_args!(dec!(1), dec!(0), NO_GUARD)).expect_commit_failure();
    w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_failure();
    w.ledger.execute_manifest(ManifestBuilder::new().lock_fee_from_faucet().unfreeze_withdraw(vault).build(), vec![]).expect_commit_success();
    w.owner_call(owner, pool, "withdraw_all", manifest_args!()).expect_commit_success();
}

fn ceil_pd(v: PreciseDecimal, divisibility: u8) -> PreciseDecimal {
    PreciseDecimal::from(Decimal::try_from(v.checked_round(divisibility, RoundingMode::ToPositiveInfinity).unwrap()).unwrap())
}

const fn _seed() -> u64 { 0x0E1F_2026_1122_0001 }
