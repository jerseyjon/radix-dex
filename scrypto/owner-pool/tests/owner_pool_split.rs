//! Tests for the cold/hot split of `OwnerPool` (docs/review-2026-11-21/owner-pool-split-design.md).
//! OWNER = cold badge (owner's wallet). OPERATOR = hot badge (the market-making bot's account).
//! The operator may only move funds between inventory and reserves inside the component, within
//! owner-set limits; these tests check that it cannot get funds out by any method, cannot exceed its
//! limits within or across windows, can be revoked and replaced, that the owner keeps every power
//! with the operator key lost, and how much a stolen operator key can extract within the limits.

use scrypto_test::prelude::*;

const NO_GUARD: Option<(Decimal, Decimal)> = None;

#[derive(Clone, Copy)]
struct Actor {
    key: Secp256k1PublicKey,
    account: ComponentAddress,
}

#[derive(ScryptoSbor, Clone, Copy, Debug, PartialEq, Eq)]
struct Limits {
    move_budget_bps: u16,
    window_epochs: u64,
    max_reserve_a: Decimal,
    max_reserve_b: Decimal,
    min_fee_bps: u16,
    max_fee_bps: u16,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct RebalanceEv {
    amount_a: Decimal,
    amount_b: Decimal,
    reserve_a: Decimal,
    reserve_b: Decimal,
    inventory_a: Decimal,
    inventory_b: Decimal,
    cost: Decimal,
    allowance: Decimal,
    by_owner: bool,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct InventoryEv {
    amount_a: Decimal,
    amount_b: Decimal,
    inventory_a: Decimal,
    inventory_b: Decimal,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct OperatorEv {
    operator: Option<ResourceAddress>,
    limits: Limits,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct ConfigEv {
    fee_bps: u16,
    paused: bool,
    operator_paused: bool,
}

type Status = (Option<ResourceAddress>, Limits, Decimal, bool, (Decimal, Decimal));

struct W {
    ledger: DefaultLedgerSimulator,
    package: PackageAddress,
    owner: Actor,
    /// The market-making bot. Holds the operator badge. In the attack tests, the thief who stole
    /// its key: he signs as the bot and trades from the bot's account with his own funds.
    bot: Actor,
    other: Actor,
    badge: ResourceAddress,
    op: ResourceAddress,
    a: ResourceAddress,
    b: ResourceAddress,
}

impl W {
    fn new() -> Self {
        let mut ledger = LedgerSimulatorBuilder::new().build();
        let (key, _, account) = ledger.new_allocated_account();
        let (bkey, _, baccount) = ledger.new_allocated_account();
        let (okey, _, oaccount) = ledger.new_allocated_account();
        let package = ledger.compile_and_publish(this_package!());
        let badge = ledger.create_fungible_resource(dec!(1), 0, account);
        let op = ledger.create_fungible_resource(dec!(1), 0, baccount);
        let owner = Actor { key, account };
        let mut w = Self {
            ledger,
            package,
            owner,
            bot: Actor { key: bkey, account: baccount },
            other: Actor { key: okey, account: oaccount },
            badge,
            op,
            a: XRD,
            b: XRD,
        };
        w.a = w.token(dec!(1_000_000_000), 18);
        w.b = w.token(dec!(1_000_000_000), 18);
        let (bot, other, a, b) = (w.bot, w.other, w.a, w.b);
        for who in [bot, other] {
            w.give(who, a, dec!(1_000_000));
            w.give(who, b, dec!(1_000_000));
        }
        w
    }

    fn run(&mut self, signers: &[Actor], m: TransactionManifestV1) -> TransactionReceipt {
        let proofs = signers.iter().map(|s| NonFungibleGlobalId::from_public_key(&s.key)).collect::<Vec<_>>();
        self.ledger.execute_manifest(m, proofs)
    }

    fn token(&mut self, supply: Decimal, div: u8) -> ResourceAddress {
        let o = self.owner;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_fungible_resource(OwnerRole::None, true, div, FungibleResourceRoles::default(), metadata!(), Some(supply))
            .try_deposit_entire_worktop_or_abort(o.account, None)
            .build();
        self.ledger.execute_manifest(m, vec![]).expect_commit(true).new_resource_addresses()[0]
    }

    fn give(&mut self, to: Actor, r: ResourceAddress, amount: Decimal) {
        let o = self.owner;
        let m = ManifestBuilder::new().lock_fee_from_faucet().withdraw_from_account(o.account, r, amount)
            .try_deposit_entire_worktop_or_abort(to.account, None).build();
        self.run(&[o], m).expect_commit_success();
    }

    fn bal(&mut self, who: Actor, r: ResourceAddress) -> Decimal {
        self.ledger.get_component_balance(who.account, r)
    }

    /// Pool funded with reserves (ra, rb), fee `fee`, no operator yet.
    fn pool(&mut self, ra: Decimal, rb: Decimal, fee: u16) -> ComponentAddress {
        let (o, badge, package, a, b) = (self.owner, self.badge, self.package, self.a, self.b);
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, badge, dec!(1))
            .withdraw_from_account(o.account, a, ra)
            .withdraw_from_account(o.account, b, rb)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_function_with_name_lookup(package, "OwnerPool", "instantiate_with_liquidity", |l| (l.bucket("a"), l.bucket("b"), fee, badge))
            .build();
        self.run(&[o], m).expect_commit_success().new_component_addresses()[0]
    }

    /// Owner call with the owner badge, output deposited to the owner.
    fn as_owner(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let (o, badge) = (self.owner, self.badge);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, badge, dec!(1))
            .call_method(pool, method, args).deposit_entire_worktop(o.account).build();
        self.run(&[o], m)
    }

    /// Call presenting a proof of `badge` from the bot's account, output deposited to the bot.
    fn as_bot_with(&mut self, badge: ResourceAddress, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let bot = self.bot;
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(bot.account, badge, dec!(1))
            .call_method(pool, method, args).deposit_entire_worktop(bot.account).build();
        self.run(&[bot], m)
    }

    fn as_operator(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let op = self.op;
        self.as_bot_with(op, pool, method, args)
    }

    fn as_stranger(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let other = self.other;
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, method, args).deposit_entire_worktop(other.account).build();
        self.run(&[other], m)
    }

    /// Owner appoints `badge` (held by `holder`) as operator: both sign, both badges proved.
    fn appoint(&mut self, pool: ComponentAddress, holder: Actor, badge: ResourceAddress) -> TransactionReceipt {
        let (o, ob) = (self.owner, self.badge);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, ob, dec!(1))
            .create_proof_from_account_of_amount(holder.account, badge, dec!(1))
            .call_method(pool, "set_operator", manifest_args!(Some(badge)))
            .build();
        self.run(&[o, holder], m)
    }

    #[allow(clippy::too_many_arguments)]
    fn set_limits(&mut self, pool: ComponentAddress, budget_bps: u16, window: u64, cap_a: Decimal, cap_b: Decimal, min_fee: u16, max_fee: u16) -> TransactionReceipt {
        self.as_owner(pool, "set_operator_limits", manifest_args!(budget_bps, window, cap_a, cap_b, min_fee, max_fee))
    }

    /// Owner puts (xa, xb) into the inventory.
    fn fund_inventory(&mut self, pool: ComponentAddress, xa: Decimal, xb: Decimal) -> TransactionReceipt {
        let (o, badge, a, b) = (self.owner, self.badge, self.a, self.b);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, badge, dec!(1))
            .withdraw_from_account(o.account, a, xa)
            .withdraw_from_account(o.account, b, xb)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_method_with_name_lookup(pool, "deposit_inventory", |l| (Some(l.bucket("a")), Some(l.bucket("b"))))
            .build();
        self.run(&[o], m)
    }

    fn rebalance(&mut self, pool: ComponentAddress, da: Decimal, db: Decimal) -> TransactionReceipt {
        self.as_operator(pool, "rebalance", manifest_args!(da, db, NO_GUARD))
    }

    fn swap(&mut self, who: Actor, pool: ComponentAddress, input: ResourceAddress, amount: Decimal) -> TransactionReceipt {
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .withdraw_from_account(who.account, input, amount)
            .take_all_from_worktop(input, "in")
            .call_method_with_name_lookup(pool, "swap", |l| (l.bucket("in"),))
            .deposit_entire_worktop(who.account).build();
        self.run(&[who], m)
    }

    fn read<T: ScryptoDecode>(&mut self, pool: ComponentAddress, method: &str) -> T {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, method, manifest_args!()).build();
        self.ledger.execute_manifest(m, vec![]).expect_commit_success().output(1)
    }

    fn reserves(&mut self, pool: ComponentAddress) -> (Decimal, Decimal) {
        self.read(pool, "reserves")
    }

    fn inventory(&mut self, pool: ComponentAddress) -> (Decimal, Decimal) {
        self.read(pool, "inventory")
    }

    fn status(&mut self, pool: ComponentAddress) -> Status {
        self.read(pool, "operator_status")
    }

    /// Everything the pool holds: reserves + inventory, per token.
    fn total(&mut self, pool: ComponentAddress) -> (Decimal, Decimal) {
        let (ra, rb) = self.reserves(pool);
        let (ia, ib) = self.inventory(pool);
        (ra + ia, rb + ib)
    }

    fn epoch(&mut self) -> u64 {
        self.ledger.get_current_epoch().number()
    }

    fn advance(&mut self, epochs: u64) {
        let e = self.epoch();
        self.ledger.set_current_epoch(Epoch::of(e + epochs));
    }

    fn events<T: ScryptoDecode>(&self, r: &TransactionReceipt, name: &str) -> Vec<T> {
        r.expect_commit_success().application_events.iter()
            .filter(|(id, _)| self.ledger.event_name(id) == name)
            .map(|(_, d)| scrypto_decode::<T>(d).expect("event decodes"))
            .collect()
    }

    /// A standard managed pool: reserves (10k, 10k), inventory (10k, 10k), operator = bot.
    fn managed_pool(&mut self, fee: u16) -> ComponentAddress {
        let pool = self.pool(dec!(10_000), dec!(10_000), fee);
        self.fund_inventory(pool, dec!(10_000), dec!(10_000)).expect_commit_success();
        let (bot, op) = (self.bot, self.op);
        self.appoint(pool, bot, op).expect_commit_success();
        pool
    }
}

fn f(d: Decimal) -> f64 {
    d.to_string().parse().unwrap()
}

fn dec_floor(x: f64, places: usize) -> Decimal {
    let s = format!("{:.*}", places + 2, x);
    Decimal::from_str(&s).unwrap().checked_round(places as u8, RoundingMode::ToZero).unwrap()
}

// =================================================================================== role table

/// Every method x {owner, operator, stranger}. Expected:
///   owner only: deposit, withdraw, withdraw_all, deposit_inventory, withdraw_inventory,
///               owner_rebalance, set_fee, set_paused, set_operator, set_operator_limits
///   operator only: rebalance, operator_set_fee
///   owner or operator: set_operator_paused
///   public: swap, swap_with_minimum, quote, reserves, inventory, fee_bps, is_paused, operator_status
#[test]
fn split_role_table() {
    let mut w = W::new();
    let (bot, other, a, b) = (w.bot, w.other, w.a, w.b);
    let pool = w.managed_pool(30);
    w.set_limits(pool, 1_000, 10, dec!(20_000), dec!(20_000), 10, 100).expect_commit_success();
    w.advance(10);

    // Order matters only for the owner's own successful run at the end (withdraw_all empties the pool).
    let owner_only = ["withdraw", "withdraw_inventory", "owner_rebalance", "set_fee", "set_paused", "set_operator_limits", "withdraw_all", "set_operator"];
    let operator_only = ["rebalance", "operator_set_fee"];
    let args = |m: &str| -> ManifestArgs {
        match m {
            "withdraw" => manifest_args!(dec!(1), dec!(1), NO_GUARD),
            "withdraw_all" => manifest_args!(),
            "withdraw_inventory" => manifest_args!(dec!(1), dec!(1)),
            "owner_rebalance" => manifest_args!(dec!(1), dec!(0), NO_GUARD),
            "set_fee" => manifest_args!(20u16),
            "set_paused" => manifest_args!(true),
            "set_operator" => manifest_args!(None::<ResourceAddress>),
            "set_operator_limits" => manifest_args!(10_000u16, 1u64, dec!(1_000_000), dec!(1_000_000), 0u16, 500u16),
            "rebalance" => manifest_args!(dec!(1), dec!(1), NO_GUARD),
            "operator_set_fee" => manifest_args!(20u16),
            _ => unreachable!(),
        }
    };
    let total0 = w.total(pool);
    let (ba, bb) = (w.bal(bot, a), w.bal(bot, b));
    let (sa, sb) = (w.bal(other, a), w.bal(other, b));

    // Owner-only methods: refused for the operator and a stranger.
    for method in owner_only {
        w.as_operator(pool, method, args(method)).expect_commit_failure();
        w.as_stranger(pool, method, args(method)).expect_commit_failure();
    }
    // deposit / deposit_inventory with the operator's (or a stranger's) own tokens: refused too.
    for method in ["deposit", "deposit_inventory"] {
        for (who, prove) in [(bot, true), (other, false)] {
            let op = w.op;
            let mut m = ManifestBuilder::new().lock_fee_from_faucet();
            if prove {
                m = m.create_proof_from_account_of_amount(who.account, op, dec!(1));
            }
            let m = m.withdraw_from_account(who.account, a, dec!(5)).take_all_from_worktop(a, "x");
            let m = if method == "deposit" {
                m.call_method_with_name_lookup(pool, method, |l| (Some(l.bucket("x")), None::<ManifestBucket>, NO_GUARD))
            } else {
                m.call_method_with_name_lookup(pool, method, |l| (Some(l.bucket("x")), None::<ManifestBucket>))
            };
            let m = m.deposit_entire_worktop(who.account).build();
            w.run(&[who], m).expect_commit_failure();
        }
    }
    // Operator-only methods: refused for the owner (the owner role does not satisfy `operator`) and
    // a stranger; accepted for the operator.
    for method in operator_only {
        w.as_owner(pool, method, args(method)).expect_commit_failure();
        w.as_stranger(pool, method, args(method)).expect_commit_failure();
        w.as_operator(pool, method, args(method)).expect_commit_success();
    }
    // set_operator_paused: owner or operator, not a stranger.
    w.as_stranger(pool, "set_operator_paused", manifest_args!(true)).expect_commit_failure();
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    w.as_owner(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();
    // Public reads work for anyone.
    for method in ["reserves", "inventory", "fee_bps", "is_paused", "operator_status"] {
        w.as_stranger(pool, method, manifest_args!()).expect_commit_success();
    }
    w.as_stranger(pool, "quote", manifest_args!(a, dec!(1))).expect_commit_success();
    w.swap(other, pool, a, dec!(1)).expect_commit_success();

    // Nothing left the component except the stranger's 1-A swap; nobody but the stranger's swap changed balances.
    assert_eq!(w.bal(bot, a), ba);
    assert_eq!(w.bal(bot, b), bb);
    let (ta, tb) = w.total(pool);
    assert_eq!(ta, total0.0 + dec!(1));
    assert_eq!(w.bal(other, a), sa - dec!(1));
    assert_eq!(tb + w.bal(other, b), total0.1 + sb);

    // Owner-only methods work for the owner (set_operator(None) last: it revokes the bot).
    for method in owner_only {
        w.as_owner(pool, method, args(method)).expect_commit_success();
    }
    assert_eq!(w.total(pool), (dec!(0), dec!(0)));
    assert_eq!(w.status(pool).0, None);
}

/// The operator, holding only its badge, tries every method of the blueprint and the native module
/// methods with arguments that would pay it, and deposits whatever is on its worktop afterwards. Its
/// balances never change and the component's total holdings never fall.
#[test]
fn operator_cannot_extract_funds_by_any_method() {
    let mut w = W::new();
    let (bot, a, b) = (w.bot, w.a, w.b);
    let pool = w.managed_pool(30);
    w.set_limits(pool, 10_000, 1, dec!(1_000_000), dec!(1_000_000), 0, 500).expect_commit_success();
    w.advance(1);
    let big = dec!(1_000_000);
    let attempts: Vec<(&str, ManifestArgs)> = vec![
        ("withdraw", manifest_args!(dec!(10_000), dec!(10_000), NO_GUARD)),
        ("withdraw", manifest_args!(dec!(1), dec!(0), NO_GUARD)),
        ("withdraw_all", manifest_args!()),
        ("withdraw_inventory", manifest_args!(dec!(10_000), dec!(10_000))),
        ("withdraw_inventory", manifest_args!(dec!(0), dec!(1))),
        ("owner_rebalance", manifest_args!(dec!(-9_999), dec!(0), NO_GUARD)),
        ("set_operator", manifest_args!(None::<ResourceAddress>)),
        ("set_operator_limits", manifest_args!(10_000u16, 1u64, big, big, 0u16, 500u16)),
        ("set_fee", manifest_args!(0u16)),
        ("set_paused", manifest_args!(false)),
        // its own methods, with amounts that would empty or overdraw
        ("rebalance", manifest_args!(dec!(-10_000), dec!(0), NO_GUARD)),
        ("rebalance", manifest_args!(dec!(10_001), dec!(10_001), NO_GUARD)),
        ("rebalance", manifest_args!(dec!(-10_001), dec!(-10_001), NO_GUARD)),
        ("operator_set_fee", manifest_args!(501u16)),
        // private helpers are not callable
        ("move_inventory", manifest_args!(dec!(-1), dec!(-1), NO_GUARD, true)),
        ("take", manifest_args!()),
        ("shift", manifest_args!()),
        ("refill", manifest_args!()),
    ];
    let total0 = w.total(pool);
    let (ba, bb) = (w.bal(bot, a), w.bal(bot, b));
    for (method, args) in attempts {
        let r = w.as_operator(pool, method, args);
        assert!(!r.is_commit_success(), "operator call {method} succeeded");
    }
    // Native modules: roles, owner role, metadata, royalties.
    let op = w.op;
    let with_op = |m: ManifestBuilder| m.lock_fee_from_faucet().create_proof_from_account_of_amount(bot.account, op, dec!(1));
    for m in [
        with_op(ManifestBuilder::new()).set_role(pool, ModuleId::Main, RoleKey::new("operator"), rule!(allow_all)).build(),
        with_op(ManifestBuilder::new()).set_role(pool, ModuleId::Main, RoleKey::new("_owner_"), rule!(allow_all)).build(),
        with_op(ManifestBuilder::new()).set_owner_role(pool, rule!(allow_all)).build(),
        with_op(ManifestBuilder::new()).set_metadata(pool, "name", "x").build(),
        with_op(ManifestBuilder::new()).set_component_royalty(pool, "swap", RoyaltyAmount::Xrd(dec!(1))).build(),
    ] {
        w.run(&[bot], m).expect_commit_failure();
    }
    // Everything the operator CAN do, at its widest limits: moves stay inside the component.
    w.rebalance(pool, dec!(5_000), dec!(5_000)).expect_commit_success(); // depth: (2.25 - 1) / 2 = 0.625
    w.rebalance(pool, dec!(-12_000), dec!(-12_000)).expect_commit_success(); // free
    w.rebalance(pool, dec!(300), dec!(0)).expect_commit_success(); // 0.1 + 0.05
    w.as_operator(pool, "operator_set_fee", manifest_args!(0u16)).expect_commit_success();
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    w.as_operator(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();
    assert_eq!((w.bal(bot, a), w.bal(bot, b)), (ba, bb));
    assert_eq!(w.total(pool), total0);
}

// =================================================================================== limits

/// Budget, caps, empty sides, fee range, guard; refill within a window, across windows, and never
/// above one budget; splitting a move into many small calls gives no more than e^budget.
#[test]
fn operator_limits_within_and_across_windows() {
    let mut w = W::new();
    let pool = w.managed_pool(30);
    let (_, limits0, allowance0, _, anchor0) = w.status(pool);
    assert_eq!(anchor0, (dec!(10_000), dec!(10_000)));
    // Defaults: the operator can move nothing that costs budget or raises a reserve.
    assert_eq!(limits0, Limits { move_budget_bps: 0, window_epochs: 1, max_reserve_a: dec!(0), max_reserve_b: dec!(0), min_fee_bps: 30, max_fee_bps: 30 });
    assert_eq!(allowance0, dec!(0));
    w.rebalance(pool, dec!(1), dec!(0)).expect_commit_failure_containing_error("Above the operator's reserve cap");
    w.rebalance(pool, dec!(-1), dec!(0)).expect_commit_failure_containing_error("Operator price-move limit");
    w.rebalance(pool, dec!(-1), dec!(-1)).expect_commit_success(); // proportional decrease: costs nothing
    w.rebalance(pool, dec!(1), dec!(1)).expect_commit_failure_containing_error("Above the operator's reserve cap");
    w.as_operator(pool, "operator_set_fee", manifest_args!(29u16)).expect_commit_failure_containing_error("Fee outside the operator's range");
    w.as_operator(pool, "operator_set_fee", manifest_args!(30u16)).expect_commit_success();
    w.owner_restore(pool);

    // Bad limit settings are refused.
    let big = dec!(1_000_000);
    w.set_limits(pool, 10_001, 10, big, big, 0, 0).expect_commit_failure_containing_error("Budget too high");
    w.set_limits(pool, 1_000, 0, big, big, 0, 0).expect_commit_failure_containing_error("Window must be at least one epoch");
    w.set_limits(pool, 1_000, 10, dec!(-1), big, 0, 0).expect_commit_failure_containing_error("Negative cap");
    w.set_limits(pool, 1_000, 10, big, big, 20, 10).expect_commit_failure_containing_error("Bad fee range");
    w.set_limits(pool, 1_000, 10, big, big, 0, 501).expect_commit_failure_containing_error("Bad fee range");

    // Budget 10% per 10 epochs, caps 15k, fee 10..100 bps.
    let r = w.set_limits(pool, 1_000, 10, dec!(15_000), dec!(15_000), 10, 100);
    let ev: Vec<OperatorEv> = w.events(&r, "OwnerPoolOperatorEvent");
    assert_eq!(ev[0].operator, Some(w.op));
    assert_eq!(w.status(pool).2, dec!(0), "budget starts empty and refills");
    w.rebalance(pool, dec!(0), dec!(1)).expect_commit_failure_containing_error("Operator price-move limit");
    // Fee range.
    for bad in [9u16, 101, 500] {
        w.as_operator(pool, "operator_set_fee", manifest_args!(bad)).expect_commit_failure_containing_error("Fee outside the operator's range");
    }
    for ok in [10u16, 100, 55] {
        w.as_operator(pool, "operator_set_fee", manifest_args!(ok)).expect_commit_success();
    }
    w.as_owner(pool, "set_fee", manifest_args!(500u16)).expect_commit_success(); // the owner is not bound by the range

    // Half a window: half the budget. A full window or more: exactly one budget, never more.
    w.advance(5);
    assert_eq!(w.status(pool).2, dec!("0.05"));
    w.advance(5);
    assert_eq!(w.status(pool).2, dec!("0.1"));
    w.advance(1_000);
    assert_eq!(w.status(pool).2, dec!("0.1"));

    // Guard.
    w.as_operator(pool, "rebalance", manifest_args!(dec!(1), dec!(1), Some((dec!(1), dec!(1))))).expect_commit_failure_containing_error("Reserves moved");
    let (ra, rb) = w.reserves(pool);
    // A proportional raise does not move the price but grows the depth: (10001^2/10000^2 - 1) / 2.
    let r = w.as_operator(pool, "rebalance", manifest_args!(dec!(1), dec!(1), Some((ra, rb))));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    let depth_cost = dec!("0.000100005");
    assert_eq!(ev[0].cost, depth_cost);
    // A proportional decrease is free and leaves the anchor where it was.
    let r = w.rebalance(pool, dec!(-1), dec!(-1));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!(0));
    assert_eq!(w.status(pool).4, (dec!(10_001), dec!(10_001)));

    // The exact cost of a one-sided add: (10000, 10000) -> (10000, 10500): price 1.05 -> 0.05, plus
    // depth (1.05 - 1) / 2 = 0.025.
    let (ra, rb) = w.reserves(pool);
    assert_eq!((ra, rb), (dec!(10_000), dec!(10_000)));
    let r = w.rebalance(pool, dec!(0), dec!(500));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!("0.075"));
    let left = dec!("0.1") - depth_cost - dec!("0.075");
    assert_eq!(ev[0].allowance, left);
    assert!(!ev[0].by_owner);
    assert_eq!(w.status(pool).4, (dec!(10_000), dec!(10_500)));
    // Moving both sides in opposite directions costs the product: (10000,10500) -> (9500, 10600):
    // r = (10600/9500) / (10500/10000) = 1.06265664..., more than is left: refused.
    w.rebalance(pool, dec!(-500), dec!(100)).expect_commit_failure_containing_error("Operator price-move limit");
    // A move back down costs budget too (budget is path length, not distance from a reference).
    // One-sided removal: no depth growth.
    let r = w.rebalance(pool, dec!(0), dec!(-250));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!("0.024390243902439025")); // 10500/10250 - 1, rounded up
    // Not refilled within the same epoch.
    assert_eq!(w.status(pool).2, left - dec!("0.024390243902439025"));

    // Caps: raising a side above its cap is refused; so is raising one side while the OTHER is over
    // its cap; lowering is allowed whatever the caps.
    w.advance(10);
    w.rebalance(pool, dec!(5_001), dec!(4_750)).expect_commit_failure_containing_error("Above the operator's reserve cap");
    w.owner_call_deposit(pool, dec!(0), dec!(6_000)); // owner pushes B to 16,250, over the cap
    w.rebalance(pool, dec!(1), dec!(0)).expect_commit_failure_containing_error("Above the operator's reserve cap");
    w.rebalance(pool, dec!(0), dec!(-2_000)).expect_commit_failure_containing_error("Operator price-move limit"); // over budget
    w.rebalance(pool, dec!(0), dec!(-100)).expect_commit_success(); // lowering while over the cap: allowed
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(6_000), NO_GUARD)).expect_commit_success();

    // Emptying a side, or acting on an empty pool, is refused.
    let (ra, rb) = w.reserves(pool);
    w.rebalance(pool, -ra, dec!(0)).expect_commit_failure_containing_error("Operator cannot empty a side");
    w.rebalance(pool, -ra, -rb).expect_commit_failure_containing_error("Operator cannot empty a side");
    // Inventory can't be overdrawn.
    let (ia, _) = w.inventory(pool);
    w.rebalance(pool, ia + dec!(1), dec!(0)).expect_commit_failure();

    // The anchor: a stranger's swap moves the curve's price; an operator move at that price (even a
    // price-neutral regrow) pays the distance from the anchor, the price the operator last set.
    w.advance(10);
    w.owner_restore(pool);
    assert_eq!(w.status(pool).4, (dec!(10_000), dec!(10_000)));
    let (other, a) = (w.other, w.a);
    w.swap(other, pool, a, dec!(200)).expect_commit_success(); // fee is 5% now: price ~0.9621
    let (ra, rb) = w.reserves(pool);
    let from_anchor = f(ra) / f(rb) - 1.0;
    let r = w.rebalance(pool, (ra / dec!(100)).checked_round(6, RoundingMode::ToZero).unwrap(), (rb / dec!(100)).checked_round(6, RoundingMode::ToZero).unwrap());
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    println!("regrow by 1% at a swapped price {from_anchor:.6} from the anchor cost {}", ev[0].cost);
    assert!(f(ev[0].cost) >= from_anchor && f(ev[0].cost) < from_anchor + 0.011);
    // A move refused for budget leaves everything as it was.
    let r0 = w.reserves(pool);
    w.rebalance(pool, dec!(0), dec!(-2_000)).expect_commit_failure_containing_error("Operator price-move limit");
    assert_eq!(w.reserves(pool), r0);

    // Many small one-sided moves within one full budget: the price can move by at most e^0.1.
    w.advance(10);
    let (ra0, rb0) = w.reserves(pool);
    let p0 = f(rb0) / f(ra0);
    let mut spent = Decimal::ZERO;
    let mut calls = 0;
    loop {
        let (_, rb) = w.reserves(pool);
        let step = (rb / dec!(500)).checked_round(6, RoundingMode::ToZero).unwrap(); // 0.2%
        let r = w.rebalance(pool, dec!(0), -step);
        if !r.is_commit_success() {
            r.expect_commit_failure_containing_error("Operator price-move limit");
            break;
        }
        let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
        spent += ev[0].cost;
        calls += 1;
    }
    let (ra1, rb1) = w.reserves(pool);
    let factor = p0 / (f(rb1) / f(ra1));
    println!("{calls} small moves spent {spent}; price moved by a factor {factor}");
    assert!(spent <= dec!("0.1"));
    assert!(calls >= 40);
    assert!(factor <= (0.1f64).exp() + 1e-12 && factor > 1.09, "factor {factor}");

    // Across windows: over T epochs the operator can spend at most budget * (1 + T / window).
    let t = 30u64;
    let mut spent = Decimal::ZERO;
    let mut up = true;
    for _ in 0..t {
        w.advance(1);
        loop {
            let (_, rb) = w.reserves(pool);
            let step = (rb / dec!(200)).checked_round(6, RoundingMode::ToZero).unwrap(); // 0.5%
            let r = w.rebalance(pool, dec!(0), if up { -step } else { step });
            if !r.is_commit_success() {
                break;
            }
            let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
            spent += ev[0].cost;
            up = !up; // oscillate so neither the caps nor an empty side stop it
        }
    }
    println!("over {t} epochs (window 10) the operator spent {spent} of at most {}", dec!("0.1") * Decimal::from(1 + t / 10));
    assert!(spent <= dec!("0.1") * Decimal::from(1 + t / 10));
    assert!(spent >= dec!("0.25"), "refill works: {spent}");

    // Lowering the budget clips what is left; raising it does not top up at once.
    w.advance(10);
    w.set_limits(pool, 100, 10, dec!(15_000), dec!(15_000), 10, 100).expect_commit_success();
    assert_eq!(w.status(pool).2, dec!("0.01"));
    w.set_limits(pool, 5_000, 10, dec!(15_000), dec!(15_000), 10, 100).expect_commit_success();
    assert_eq!(w.status(pool).2, dec!("0.01"));
}

impl W {
    /// Owner puts the reserves back to (10k, 10k) from inventory or into it.
    fn owner_restore(&mut self, pool: ComponentAddress) {
        let (ra, rb) = self.reserves(pool);
        self.as_owner(pool, "owner_rebalance", manifest_args!(dec!(10_000) - ra, dec!(10_000) - rb, NO_GUARD)).expect_commit_success();
    }

    fn owner_call_deposit(&mut self, pool: ComponentAddress, xa: Decimal, xb: Decimal) {
        let (o, badge, a, b) = (self.owner, self.badge, self.a, self.b);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, badge, dec!(1))
            .withdraw_from_account(o.account, a, xa)
            .withdraw_from_account(o.account, b, xb)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("a")), Some(l.bucket("b")), NO_GUARD))
            .build();
        self.run(&[o], m).expect_commit_success();
    }
}

// =================================================================================== revoke/replace

#[test]
fn revoke_and_replace_operator() {
    let mut w = W::new();
    let (owner, bot, other, a, b) = (w.owner, w.bot, w.other, w.a, w.b);
    let pool = w.pool(dec!(10_000), dec!(10_000), 30);
    let op1 = w.op;
    assert_eq!(w.status(pool).0, None);
    // No operator yet: the bot's badge does nothing.
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_failure();

    // Appointing needs a proof of the new badge (a typo or a badge the owner can't prove fails),
    // and refuses the owner badge, XRD and the pool tokens.
    w.as_owner(pool, "set_operator", manifest_args!(Some(op1))).expect_commit_failure_containing_error("AssertAccessRuleFailed");
    let badge = w.badge;
    for bad in [badge, XRD, a, b] {
        w.as_owner(pool, "set_operator", manifest_args!(Some(bad))).expect_commit_failure_containing_error("Bad operator badge");
    }
    // A stranger, even holding the operator badge's look-alike, can't appoint.
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(bot.account, op1, dec!(1))
        .call_method(pool, "set_operator", manifest_args!(Some(op1))).build();
    w.run(&[bot], m).expect_commit_failure();
    let r = w.appoint(pool, bot, op1);
    let ev: Vec<OperatorEv> = w.events(&r, "OwnerPoolOperatorEvent");
    assert_eq!(ev[0].operator, Some(op1));
    assert_eq!(w.status(pool).0, Some(op1));
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    w.as_operator(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();

    // The owner cannot bypass set_operator's checks through the native role API.
    let with_badge = |m: ManifestBuilder| m.lock_fee_from_faucet().create_proof_from_account_of_amount(owner.account, badge, dec!(1));
    w.run(&[owner], with_badge(ManifestBuilder::new()).set_role(pool, ModuleId::Main, RoleKey::new("operator"), rule!(allow_all)).build())
        .expect_commit_failure();
    w.run(&[owner], with_badge(ManifestBuilder::new()).set_role(pool, ModuleId::Main, RoleKey::new("operator"), rule!(require(XRD))).build())
        .expect_commit_failure();
    w.as_stranger(pool, "set_operator_paused", manifest_args!(true)).expect_commit_failure();

    // Revoke: every operator right goes at once.
    w.set_limits(pool, 1_000, 1, dec!(20_000), dec!(20_000), 0, 100).expect_commit_success();
    w.as_owner(pool, "set_operator", manifest_args!(None::<ResourceAddress>)).expect_commit_success();
    assert_eq!(w.status(pool).0, None);
    w.advance(1);
    w.rebalance(pool, dec!(1), dec!(1)).expect_commit_failure();
    w.as_operator(pool, "operator_set_fee", manifest_args!(0u16)).expect_commit_failure();
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_failure();

    // Replace with a new badge held by a new account: new works, old doesn't.
    let op2 = w.ledger.create_fungible_resource(dec!(1), 0, other.account);
    w.appoint(pool, other, op2).expect_commit_success();
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(other.account, op2, dec!(1))
        .call_method(pool, "operator_set_fee", manifest_args!(50u16)).build();
    w.run(&[other], m).expect_commit_success();
    assert_eq!(w.read::<u16>(pool, "fee_bps"), 50);
    w.as_operator(pool, "operator_set_fee", manifest_args!(0u16)).expect_commit_failure();
    // Replacing directly (old -> new) without a revoke in between also cuts the old one off.
    w.appoint(pool, bot, op1).expect_commit_success();
    w.as_operator(pool, "operator_set_fee", manifest_args!(0u16)).expect_commit_success();
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(other.account, op2, dec!(1))
        .call_method(pool, "operator_set_fee", manifest_args!(50u16)).build();
    w.run(&[other], m).expect_commit_failure();
}

// =================================================================================== owner path

/// With the operator key lost (or stolen and revoked), the owner keeps every power: revoke without
/// the operator's badge, withdraw everything including inventory, move inventory without limits,
/// override the operator's pause; and the operator cannot clear the owner's pause.
#[test]
fn owner_path_works_with_operator_key_lost() {
    let mut w = W::new();
    let (owner, other, a, b) = (w.owner, w.other, w.a, w.b);
    let pool = w.managed_pool(30);
    w.set_limits(pool, 1_000, 10, dec!(20_000), dec!(20_000), 0, 100).expect_commit_success();

    // Pause games. The operator pauses; the owner clears the operator's pause.
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    assert!(w.read::<bool>(pool, "is_paused"));
    w.swap(other, pool, a, dec!(1)).expect_commit_failure_containing_error("Swaps are paused");
    w.as_stranger(pool, "quote", manifest_args!(a, dec!(1))).expect_commit_failure_containing_error("Swaps are paused");
    let r = w.as_owner(pool, "set_operator_paused", manifest_args!(false));
    let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
    assert_eq!(ev, vec![ConfigEv { fee_bps: 30, paused: false, operator_paused: false }]);
    w.swap(other, pool, a, dec!(1)).expect_commit_success();
    // The owner pauses; the operator cannot lift it.
    w.as_owner(pool, "set_paused", manifest_args!(true)).expect_commit_success();
    w.as_operator(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();
    assert!(w.read::<bool>(pool, "is_paused"));
    w.swap(other, pool, a, dec!(1)).expect_commit_failure_containing_error("Swaps are paused");
    w.as_owner(pool, "set_paused", manifest_args!(false)).expect_commit_success();
    w.swap(other, pool, a, dec!(1)).expect_commit_success();

    // Key lost: from here the bot never signs again. The owner revokes without its badge.
    w.as_owner(pool, "set_operator", manifest_args!(None::<ResourceAddress>)).expect_commit_success();
    // Owner moves inventory without limits (budget, caps and empty sides do not apply to him).
    w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(10_000), dec!(-5_000), NO_GUARD)).expect_commit_success();
    let (ra, rb) = w.reserves(pool);
    w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(0), -rb, Some((ra, rb)))).expect_commit_success();
    assert_eq!(w.reserves(pool).1, dec!(0));
    w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(0), dec!(5_000), NO_GUARD)).expect_commit_success();
    // Inventory in and out.
    let r = w.fund_inventory(pool, dec!(3), dec!(4));
    let ev: Vec<InventoryEv> = w.events(&r, "OwnerPoolInventoryEvent");
    assert_eq!((ev[0].amount_a, ev[0].amount_b), (dec!(3), dec!(4)));
    let (oa, ob) = (w.bal(owner, a), w.bal(owner, b));
    let r = w.as_owner(pool, "withdraw_inventory", manifest_args!(dec!(3), dec!(0)));
    let ev: Vec<InventoryEv> = w.events(&r, "OwnerPoolInventoryEvent");
    assert_eq!((ev[0].amount_a, ev[0].amount_b), (dec!(-3), dec!(0)));
    assert_eq!((w.bal(owner, a), w.bal(owner, b)), (oa + dec!(3), ob));
    // Wrong tokens into inventory are refused.
    let badge = w.badge;
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(owner.account, badge, dec!(1))
        .withdraw_from_account(owner.account, b, dec!(1)).take_all_from_worktop(b, "x")
        .call_method_with_name_lookup(pool, "deposit_inventory", |l| (Some(l.bucket("x")), None::<ManifestBucket>)).build();
    w.run(&[owner], m).expect_commit_failure_containing_error("Wrong token A");
    // withdraw_all returns reserves AND inventory, to the last unit, even while paused.
    w.as_owner(pool, "set_paused", manifest_args!(true)).expect_commit_success();
    let (ta, tb) = w.total(pool);
    let (oa, ob) = (w.bal(owner, a), w.bal(owner, b));
    w.as_owner(pool, "withdraw_all", manifest_args!()).expect_commit_success();
    assert_eq!((w.bal(owner, a) - oa, w.bal(owner, b) - ob), (ta, tb));
    assert_eq!(w.total(pool), (dec!(0), dec!(0)));
}

/// Inventory is not part of the curve: the quote is the same with or without it; swap fees stay in
/// the reserves; a new pool has no operator and empty inventory.
#[test]
fn inventory_is_not_traded_and_fees_stay_in_reserves() {
    let mut w = W::new();
    let (other, a) = (w.other, w.a);
    let pool = w.pool(dec!(10_000), dec!(10_000), 30);
    assert_eq!(w.inventory(pool), (dec!(0), dec!(0)));
    let (op, limits, allowance, op_paused, _) = w.status(pool);
    assert_eq!((op, allowance, op_paused), (None, dec!(0), false));
    assert_eq!(limits.move_budget_bps, 0);
    let q0: Decimal = {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "quote", manifest_args!(a, dec!(100))).build();
        w.ledger.execute_manifest(m, vec![]).expect_commit_success().output(1)
    };
    w.fund_inventory(pool, dec!(50_000), dec!(1)).expect_commit_success();
    let q1: Decimal = {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "quote", manifest_args!(a, dec!(100))).build();
        w.ledger.execute_manifest(m, vec![]).expect_commit_success().output(1)
    };
    assert_eq!(q0, q1);
    let before = w.bal(other, w.b);
    let r = w.swap(other, pool, a, dec!(100));
    let cost = r.fee_summary.total_execution_cost_units_consumed;
    println!("swap execution cost units (split blueprint): {cost}");
    assert_eq!(w.bal(other, w.b) - before, q0);
    assert_eq!(w.reserves(pool), (dec!(10_100), dec!(10_000) - q0));
    assert_eq!(w.inventory(pool), (dec!(50_000), dec!(1)));
}

// =================================================================================== attack

/// Thief pushes A's price (B per A) up with operator moves only: adds B from inventory while B is
/// under its cap, otherwise takes A into inventory. Steps start at `step` of the reserve and halve
/// when refused, so nearly the whole budget is used. Stops after `max_spend` (or the budget) is spent.
/// Returns the budget spent (sum of `cost`).
fn push_up(w: &mut W, pool: ComponentAddress, cap_b: Decimal, max_spend: Decimal) -> Decimal {
    let mut spent = Decimal::ZERO;
    let mut frac = dec!("0.005");
    while spent < max_spend && frac >= dec!("0.00001") {
        let (ra, rb) = w.reserves(pool);
        let add_b = (rb * frac).min(cap_b - rb).checked_round(6, RoundingMode::ToZero).unwrap();
        let (da, db) = if add_b > Decimal::ZERO {
            (Decimal::ZERO, add_b)
        } else {
            (-(ra * frac).checked_round(6, RoundingMode::ToZero).unwrap(), Decimal::ZERO)
        };
        let r = w.rebalance(pool, da, db);
        if r.is_commit_success() {
            let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
            spent += ev[0].cost;
        } else {
            r.expect_commit_failure_containing_error("Operator price-move limit");
            frac = frac / dec!(2);
        }
    }
    spent
}

/// Thief (trading from the bot's account) sells A into the pool until its price is back at `p_star`
/// B per A (fee 0). Returns nothing; profit is read from balances.
fn arb_to(w: &mut W, pool: ComponentAddress, p_star: f64) {
    let (ra, rb) = w.reserves(pool);
    let (fa, fb) = (f(ra), f(rb));
    let k = fa * fb;
    let bot = w.bot;
    if fb / fa > p_star {
        let x = dec_floor((k / p_star).sqrt() - fa, 6);
        if x > Decimal::ZERO { let a = w.a; w.swap(bot, pool, a, x).expect_commit_success(); }
    } else {
        let y = dec_floor((k * p_star).sqrt() - fb, 6);
        if y > Decimal::ZERO { let b = w.b; w.swap(bot, pool, b, y).expect_commit_success(); }
    }
}

/// Value of the thief's holdings at market price p_star (B per A).
fn thief_value(w: &mut W, p_star: f64) -> f64 {
    let (bot, a, b) = (w.bot, w.a, w.b);
    f(w.bal(bot, a)) * p_star + f(w.bal(bot, b))
}

/// psi(D) = phi(D) + sinh(D / 2), phi(D) = 2 (cosh(D / 2) - 1) = 4 sinh^2(D / 4).
fn psi(d: f64) -> f64 {
    2.0 * ((d / 2.0).cosh() - 1.0) + (d / 2.0).sinh()
}

/// The design document's bound on what a thief gains from operator moves costing `c` in total,
/// starting with the anchor `d0` (log) away from the market: L_max * sqrt(P*) * C * psi(d0 + 2C),
/// with L_max = sqrt(cap_a * cap_b) = 20,000 here.
fn bound(c: Decimal, d0: f64, p_star: f64) -> f64 {
    let c = f(c);
    20_000.0 * p_star.sqrt() * c * psi(d0 + 2.0 * c)
}

/// What a stolen operator key can extract within its limits. Market price 1 B per A (until D), fee
/// 0 (the worst case: the operator's fee range includes 0), the owner's curve 18k/18k, inventory
/// 10k/10k, caps 20k each, budget 10% per 100-epoch window. Every strategy's gain is checked
/// against the design document's bound; the thief's gain equals the owner's loss (fee 0).
#[test]
fn stolen_operator_key_attack_is_bounded() {
    let cap = dec!(20_000);
    let setup = |w: &mut W| -> ComponentAddress {
        let pool = w.pool(dec!(18_000), dec!(18_000), 0);
        w.fund_inventory(pool, dec!(10_000), dec!(10_000)).expect_commit_success();
        let (bot, op) = (w.bot, w.op);
        w.appoint(pool, bot, op).expect_commit_success();
        w.set_limits(pool, 1_000, 100, cap, cap, 0, 100).expect_commit_success();
        w.advance(100); // full budget
        pool
    };

    // A. One window, one extraction: push the price with the whole budget, sell A back to market.
    let mut w = W::new();
    let pool = setup(&mut w);
    let owner_total0 = w.total(pool);
    let v0 = thief_value(&mut w, 1.0);
    let x_a = push_up(&mut w, pool, cap, dec!(1));
    arb_to(&mut w, pool, 1.0);
    let gain_a = thief_value(&mut w, 1.0) - v0;
    let (ta, tb) = w.total(pool);
    let owner_loss = f(owner_total0.0) + f(owner_total0.1) - f(ta) - f(tb);
    println!("A: budget spent {x_a}, thief gain {gain_a:.6}, owner loss {owner_loss:.6}, bound {:.6}", bound(x_a, 0.0, 1.0));
    assert!((gain_a - owner_loss).abs() < 1e-4, "zero-sum at fee 0");
    assert!(gain_a > 0.0 && gain_a <= bound(x_a, 0.0, 1.0));
    assert!(x_a <= dec!("0.1"));

    // B. Many cycles within one window (push ~1%, sell back to market, push again from the market
    // price): every push back is charged, so no better than A.
    let mut w = W::new();
    let pool = setup(&mut w);
    let v0 = thief_value(&mut w, 1.0);
    let mut x_b = Decimal::ZERO;
    let mut cycles = 0;
    loop {
        let s = push_up(&mut w, pool, cap, dec!("0.01"));
        x_b += s;
        if s < dec!("0.001") { break; }
        arb_to(&mut w, pool, 1.0);
        cycles += 1;
    }
    let gain_b = thief_value(&mut w, 1.0) - v0;
    println!("B: {cycles} cycles, budget spent {x_b}, thief gain {gain_b:.6}, bound {:.6}", bound(x_b, 0.0, 1.0));
    assert!(cycles >= 5);
    assert!(gain_b <= bound(x_b, 0.0, 1.0));
    assert!(gain_b < gain_a, "cycles are worse for the thief than one extraction");

    // C. Several windows with the operator's pause on (so nobody else can trade the mispricing
    // back): push with each window's budget, then unpause and sell back once. C <= 0.1 * (1 + K).
    let k = 4u64;
    let mut w = W::new();
    let pool = setup(&mut w);
    let v0 = thief_value(&mut w, 1.0);
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    let mut x_c = Decimal::ZERO;
    for i in 0..=k {
        x_c += push_up(&mut w, pool, cap, dec!(1));
        if i < k { w.advance(100); }
    }
    w.as_operator(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();
    arb_to(&mut w, pool, 1.0);
    let gain_c = thief_value(&mut w, 1.0) - v0;
    let x_max = 0.1 * (1 + k) as f64;
    println!("C: {} windows, budget spent {x_c} (max {x_max}), thief gain {gain_c:.6}, bound {:.6}", k + 1, bound(x_c, 0.0, 1.0));
    assert!(f(x_c) <= x_max + 1e-12);
    assert!(gain_c <= bound(x_c, 0.0, 1.0));
    assert!(gain_c > gain_a);

    // D. The market moves (A from 1 to 1.2 B) while the curve sits at the old price and anchor
    // (bot stopped, nobody arbitraging). An ordinary arbitrageur would take the drift anyway; the
    // thief's EXTRA gain from operator moves (push further with the budget) is what the key adds.
    let p_star = 1.2;
    let mut w = W::new();
    let pool = setup(&mut w);
    let v0 = thief_value(&mut w, p_star);
    arb_to_buy_a(&mut w, pool, p_star);
    let gain_plain = thief_value(&mut w, p_star) - v0;
    let mut w = W::new();
    let pool = setup(&mut w);
    let v0 = thief_value(&mut w, p_star);
    let x_d = push_down(&mut w, pool, dec!(1));
    arb_to_buy_a(&mut w, pool, p_star);
    let gain_d = thief_value(&mut w, p_star) - v0;
    let extra = gain_d - gain_plain;
    let bound_d = bound(x_d, p_star.ln(), p_star);
    println!("D: market +20%: ordinary arb gains {gain_plain:.6}; thief with budget {x_d} gains {gain_d:.6}, extra {extra:.6} (bound {bound_d:.6})");
    assert!(extra > 0.0 && extra <= bound_d);

    // E. Own capital: the operator shrinks the curve (free), the thief sells A to move its price
    // ~44% away, then the operator tries to add A, regrow, or lower B at that price (moves that paid
    // off on the first cut). Measured from the anchor, each costs more than the whole budget and is
    // refused; selling back, the thief cannot gain.
    let mut w = W::new();
    let pool = setup(&mut w);
    let v0 = thief_value(&mut w, 1.0);
    let (bot, a) = (w.bot, w.a);
    w.rebalance(pool, dec!(-9_000), dec!(-9_000)).expect_commit_success();
    w.swap(bot, pool, a, dec!(3_000)).expect_commit_success();
    let (ra, rb) = w.reserves(pool);
    println!("E: curve price after the thief's own swap {:.4}", f(rb) / f(ra));
    w.rebalance(pool, dec!(10), dec!(0)).expect_commit_failure_containing_error("Operator price-move limit");
    w.rebalance(pool, (ra / dec!(1000)).checked_round(6, RoundingMode::ToZero).unwrap(), (rb / dec!(1000)).checked_round(6, RoundingMode::ToZero).unwrap())
        .expect_commit_failure_containing_error("Operator price-move limit");
    w.rebalance(pool, dec!(0), -(rb / dec!(1000)).checked_round(6, RoundingMode::ToZero).unwrap())
        .expect_commit_failure_containing_error("Operator price-move limit");
    arb_to_buy_a(&mut w, pool, 1.0);
    let gain_e = thief_value(&mut w, 1.0) - v0;
    println!("E: thief ends {gain_e:.6}");
    assert!(gain_e <= 0.0);
}

/// Thief pushes A's price DOWN with operator moves: adds A while under its cap, else takes B out.
fn push_down(w: &mut W, pool: ComponentAddress, max_spend: Decimal) -> Decimal {
    let cap_a = dec!(20_000);
    let mut spent = Decimal::ZERO;
    let mut frac = dec!("0.005");
    while spent < max_spend && frac >= dec!("0.00001") {
        let (ra, rb) = w.reserves(pool);
        let add_a = (ra * frac).min(cap_a - ra).checked_round(6, RoundingMode::ToZero).unwrap();
        let (da, db) = if add_a > Decimal::ZERO {
            (add_a, Decimal::ZERO)
        } else {
            (Decimal::ZERO, -(rb * frac).checked_round(6, RoundingMode::ToZero).unwrap())
        };
        let r = w.rebalance(pool, da, db);
        if r.is_commit_success() {
            let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
            spent += ev[0].cost;
        } else {
            r.expect_commit_failure_containing_error("Operator price-move limit");
            frac = frac / dec!(2);
        }
    }
    spent
}

/// Buy A with B until the pool price is `p_star` (pool price below market).
fn arb_to_buy_a(w: &mut W, pool: ComponentAddress, p_star: f64) {
    let (ra, rb) = w.reserves(pool);
    let (fa, fb) = (f(ra), f(rb));
    assert!(fb / fa < p_star);
    let y = dec_floor((fa * fb * p_star).sqrt() - fb, 6);
    let (bot, b) = (w.bot, w.b);
    w.swap(bot, pool, b, y).expect_commit_success();
}

// =================================================================================== bypasses

/// The shrink / swap / regrow bypass found while analysing the first cut (bd574a4), where only the
/// operator's own price change was charged: the operator shrinks the curve proportionally (free),
/// the thief moves the price far with a small swap of his own (cheap on a small curve), the operator
/// regrows the curve proportionally at that price (free: "price unchanged"), and the thief trades
/// it back to market. Repeatable with no budget at all. On the first cut this test prints the gain
/// and fails; with the anchor + depth charge the regrow is refused.
#[test]
fn shrink_swap_regrow_bypass_is_refused() {
    let mut w = W::new();
    let pool = w.pool(dec!(18_000), dec!(18_000), 0);
    w.fund_inventory(pool, dec!(10_000), dec!(10_000)).expect_commit_success();
    let (bot, op, a, b) = (w.bot, w.op, w.a, w.b);
    w.appoint(pool, bot, op).expect_commit_success();
    w.set_limits(pool, 1_000, 100, dec!(20_000), dec!(20_000), 0, 100).expect_commit_success();
    w.advance(100);
    let v0 = thief_value(&mut w, 1.0);
    // 1. shrink to 1,000 / 1,000 (proportional decrease: free in both versions)
    w.rebalance(pool, dec!(-17_000), dec!(-17_000)).expect_commit_success();
    // 2. thief sells 1,000 A: curve (2,000, 500), A now at 0.25 B
    w.swap(bot, pool, a, dec!(1_000)).expect_commit_success();
    let (ra, rb) = w.reserves(pool);
    // 3. regrow proportionally so A reaches its cap: (20,000, 5,000)
    let m = dec!(20_000) / ra;
    let regrow = w.rebalance(pool, dec!(20_000) - ra, (rb * m).checked_round(18, RoundingMode::ToZero).unwrap() - rb);
    if regrow.is_commit_success() {
        arb_to_buy_a(&mut w, pool, 1.0);
        let gain = thief_value(&mut w, 1.0) - v0;
        println!("BYPASS: regrow accepted; one cycle gains the thief {gain:.6} with budget left {}", w.status(pool).2);
    }
    regrow.expect_commit_failure_containing_error("Operator price-move limit");
    // The thief's best is to take back his own trade: he is left with less than he started with.
    let _ = b;
    arb_to(&mut w, pool, 1.0);
    let gain = thief_value(&mut w, 1.0) - v0;
    println!("shrink/swap/regrow: regrow refused; thief ends {gain:.6}");
    assert!(gain <= 0.0);
}
