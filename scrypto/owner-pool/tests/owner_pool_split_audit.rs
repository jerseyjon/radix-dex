//! Independent audit of the cold/hot split (branch `pool-split`, bd574a4 + 668f660), INVERTED after
//! the fixes: each `*_attack_*` / `l1_*` / `informational_*` test now passes only when the attack is
//! refused, or gains no more than the design document's bound. Findings: M-1 owner reserve calls
//! re-anchored at the thief's price (fixed: owner calls never move the anchor; the owner states it);
//! L-1 free dust shrink (fixed: owner-set reserve floors); informational items (fixed); budget refill
//! edge cases. New: owner-stated off-market anchor (the residual D term) and `set_anchor`.

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
    min_reserve_a: Decimal,
    min_reserve_b: Decimal,
    min_fee_bps: u16,
    max_fee_bps: u16,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct AnchorEv {
    anchor_a: Decimal,
    anchor_b: Decimal,
}

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct ConfigEv {
    fee_bps: u16,
    paused: bool,
    operator_paused: bool,
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

type Status = (Option<ResourceAddress>, Limits, Decimal, bool, (Decimal, Decimal));

struct W {
    ledger: DefaultLedgerSimulator,
    package: PackageAddress,
    owner: Actor,
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
        let mut w = Self {
            ledger,
            package,
            owner: Actor { key, account },
            bot: Actor { key: bkey, account: baccount },
            other: Actor { key: okey, account: oaccount },
            badge,
            op,
            a: XRD,
            b: XRD,
        };
        w.a = w.token(dec!(1_000_000_000));
        w.b = w.token(dec!(1_000_000_000));
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

    fn token(&mut self, supply: Decimal) -> ResourceAddress {
        let o = self.owner;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_fungible_resource(OwnerRole::None, true, 18, FungibleResourceRoles::default(), metadata!(), Some(supply))
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

    fn as_owner(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let (o, badge) = (self.owner, self.badge);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, badge, dec!(1))
            .call_method(pool, method, args).deposit_entire_worktop(o.account).build();
        self.run(&[o], m)
    }

    fn as_operator(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let (bot, op) = (self.bot, self.op);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(bot.account, op, dec!(1))
            .call_method(pool, method, args).deposit_entire_worktop(bot.account).build();
        self.run(&[bot], m)
    }

    /// Owner appoints `badge` (held by `holder`), stating the market price 1 B per A as the anchor.
    fn appoint(&mut self, pool: ComponentAddress, holder: Actor, badge: ResourceAddress) -> TransactionReceipt {
        self.appoint_at(pool, holder, badge, (dec!(1), dec!(1)))
    }

    fn appoint_at(&mut self, pool: ComponentAddress, holder: Actor, badge: ResourceAddress, anchor: (Decimal, Decimal)) -> TransactionReceipt {
        let (o, ob) = (self.owner, self.badge);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, ob, dec!(1))
            .create_proof_from_account_of_amount(holder.account, badge, dec!(1))
            .call_method(pool, "set_operator", manifest_args!(Some(badge), Some(anchor)))
            .build();
        self.run(&[o, holder], m)
    }

    /// Limits with reserve floors 0 (the thief may shrink to anything above empty: worst case).
    #[allow(clippy::too_many_arguments)]
    fn set_limits(&mut self, pool: ComponentAddress, budget_bps: u16, window: u64, cap_a: Decimal, cap_b: Decimal, min_fee: u16, max_fee: u16) -> TransactionReceipt {
        self.set_limits_floor(pool, budget_bps, window, cap_a, cap_b, dec!(0), dec!(0), min_fee, max_fee)
    }

    #[allow(clippy::too_many_arguments)]
    fn set_limits_floor(&mut self, pool: ComponentAddress, budget_bps: u16, window: u64, cap_a: Decimal, cap_b: Decimal, floor_a: Decimal, floor_b: Decimal, min_fee: u16, max_fee: u16) -> TransactionReceipt {
        self.as_owner(pool, "set_operator_limits", manifest_args!(budget_bps, window, cap_a, cap_b, floor_a, floor_b, min_fee, max_fee))
    }

    fn set_anchor(&mut self, pool: ComponentAddress, a: Decimal, b: Decimal, guard: Option<(Decimal, Decimal)>) -> TransactionReceipt {
        self.as_owner(pool, "set_anchor", manifest_args!(a, b, guard))
    }

    /// Owner deposits into the reserves (either side optional), with an optional guard.
    fn owner_deposit(&mut self, pool: ComponentAddress, xa: Decimal, xb: Decimal, guard: Option<(Decimal, Decimal)>) -> TransactionReceipt {
        let (o, badge, a, b) = (self.owner, self.badge, self.a, self.b);
        let mut m = ManifestBuilder::new().lock_fee_from_faucet().create_proof_from_account_of_amount(o.account, badge, dec!(1));
        if xa > Decimal::ZERO { m = m.withdraw_from_account(o.account, a, xa).take_all_from_worktop(a, "a"); }
        if xb > Decimal::ZERO { m = m.withdraw_from_account(o.account, b, xb).take_all_from_worktop(b, "b"); }
        let m = m.call_method_with_name_lookup(pool, "deposit", |l| (
            if xa > Decimal::ZERO { Some(l.bucket("a")) } else { None },
            if xb > Decimal::ZERO { Some(l.bucket("b")) } else { None },
            guard,
        )).build();
        self.run(&[o], m)
    }

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
}

fn f(d: Decimal) -> f64 {
    d.to_string().parse().unwrap()
}

fn dec_floor(x: f64, places: usize) -> Decimal {
    let s = format!("{:.*}", places + 2, x);
    Decimal::from_str(&s).unwrap().checked_round(places as u8, RoundingMode::ToZero).unwrap()
}

fn thief_value(w: &mut W, p_star: f64) -> f64 {
    let (bot, a, b) = (w.bot, w.a, w.b);
    f(w.bal(bot, a)) * p_star + f(w.bal(bot, b))
}

/// The design document's bound, S * C * psi(D + 2C) with S = 20,000 (caps 20k each, P* = 1).
fn design_bound(c: f64, d0: f64) -> f64 {
    let psi = |d: f64| 2.0 * ((d / 2.0).cosh() - 1.0) + (d / 2.0).sinh();
    20_000.0 * c * psi(d0 + 2.0 * c)
}

/// Sell A for B until the pool price (B per A) is `p_star`.
fn arb_to_sell_a(w: &mut W, pool: ComponentAddress, p_star: f64) {
    let (ra, rb) = w.reserves(pool);
    let (fa, fb) = (f(ra), f(rb));
    assert!(fb / fa > p_star);
    let x = dec_floor((fa * fb / p_star).sqrt() - fa, 6);
    let (bot, a) = (w.bot, w.a);
    w.swap(bot, pool, a, x).expect_commit_success();
}

/// Buy A with B until the pool price (B per A) is `p_star`.
fn arb_to_buy_a(w: &mut W, pool: ComponentAddress, p_star: f64) {
    let (ra, rb) = w.reserves(pool);
    let (fa, fb) = (f(ra), f(rb));
    assert!(fb / fa < p_star);
    let y = dec_floor((fa * fb * p_star).sqrt() - fb, 6);
    let (bot, b) = (w.bot, w.b);
    w.swap(bot, pool, b, y).expect_commit_success();
}

/// The setup of the author's `stolen_operator_key_attack_is_bounded`: curve 18k/18k at P* = 1,
/// inventory 10k/10k, caps 20k, budget 10% per 100 epochs, operator fee range 0-100, fee 0.
fn setup(w: &mut W) -> ComponentAddress {
    let pool = w.pool(dec!(18_000), dec!(18_000), 0);
    w.fund_inventory(pool, dec!(10_000), dec!(10_000)).expect_commit_success();
    let (bot, op) = (w.bot, w.op);
    w.appoint(pool, bot, op).expect_commit_success();
    w.set_limits(pool, 1_000, 100, dec!(20_000), dec!(20_000), 0, 100).expect_commit_success();
    w.advance(100);
    pool
}

// ============================================================================ finding M-1

/// Exact (free) proportional shrink to L ~ `target_l`: first one tiny swap of the thief's own A makes
/// both reserves multiples of 2^12 attos (searched off ledger, replicating compute_swap at fee 0),
/// then the shrink is by exactly m / 2^12. The auditor's construction.
fn exact_shrink(w: &mut W, pool: ComponentAddress, target_l: f64) {
    let (bot, a) = (w.bot, w.a);
    let (ra, rb) = w.reserves(pool);
    let q = I192::from(4096);
    let base = Decimal::from(f(ra).ceil() as u64 + 1);
    let mut found = None;
    for j in 0..200_000u64 {
        let ra2 = base + Decimal::from_attos(I192::from(j) * q * I192::from(1_000_000_007i64));
        let x = ra2 - ra;
        let eff = PreciseDecimal::from(x);
        let share = eff.checked_div(PreciseDecimal::from(ra) + eff).unwrap();
        let out = Decimal::try_from((PreciseDecimal::from(rb) * share).checked_round(18, RoundingMode::ToNegativeInfinity).unwrap()).unwrap();
        let rb2 = rb - out;
        if rb2.attos() % q == I192::from(0) {
            found = Some((x, ra2, rb2));
            break;
        }
    }
    let (x, ra2, rb2) = found.expect("no aligning swap found");
    w.swap(bot, pool, a, x).expect_commit_success();
    assert_eq!(w.reserves(pool), (ra2, rb2));
    let m = I192::from((4096.0 * target_l / (f(ra2) * f(rb2)).sqrt()) as i64);
    let na = Decimal::from_attos(ra2.attos() / q * m);
    let nb = Decimal::from_attos(rb2.attos() / q * m);
    let r = w.rebalance(pool, na - ra2, nb - rb2);
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!(0), "exactly proportional shrink is free");
}

/// Regrow the curve by the factor 1.094988 (depth cost ~0.0995), amounts rounded down to 6 places.
fn regrow_amounts(w: &mut W, pool: ComponentAddress, m: Decimal) -> (Decimal, Decimal) {
    let (ra, rb) = w.reserves(pool);
    ((ra * (m - dec!(1))).checked_round(6, RoundingMode::ToZero).unwrap(), (rb * (m - dec!(1))).checked_round(6, RoundingMode::ToZero).unwrap())
}

/// M-1 (FIXED). Before the fix ANY owner call that touched the reserves (`deposit`, `withdraw`,
/// `owner_rebalance`) re-anchored at the curve's CURRENT price, which the thief had just set with his
/// own swap; the operator then regrew the curve at that price paying only the depth term (978.7
/// gained in one window on this setup, against a design bound of ~218).
/// Now none of those calls moves the anchor: it stays at the price the owner stated (1 B per A), the
/// regrow at the thief's price (1/16) is measured from it and refused, in this window and later
/// ones, and the thief can only take back his own trade, at a loss.
#[test]
fn m1_attack_owner_call_resets_anchor_to_thief_price_is_refused() {
    let mut w = W::new();
    let pool = setup(&mut w);
    let (bot, a) = (w.bot, w.a);
    let v0 = thief_value(&mut w, 1.0);
    let anchor0 = w.status(pool).4;
    assert_eq!(anchor0, (dec!(1), dec!(1)), "the anchor the owner stated at appointment");
    let m = dec!("1.094988");

    // 1. free shrink; 2. the thief's own swap: A to 1/16 B
    w.rebalance(pool, dec!(-13_436), dec!(-13_436)).expect_commit_success();
    w.swap(bot, pool, a, dec!(13_692)).expect_commit_success();
    let (ra, rb) = w.reserves(pool);
    println!("M-1: curve price after the thief's swap {:.6} B per A", f(rb) / f(ra));
    let (da, db) = regrow_amounts(&mut w, pool, m);
    w.rebalance(pool, da, db).expect_commit_failure_containing_error("Operator price-move limit");

    // 3. every reserve-touching owner call, each guarded by the reserves just read: none moves the
    //    anchor. (Removals and a B deposit only: they cannot help the thief, so the test isolates the
    //    anchor.)
    let (ra, rb) = w.reserves(pool);
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1), Some((ra, rb)))).expect_commit_success();
    assert_eq!(w.status(pool).4, anchor0);
    let (ra, rb) = w.reserves(pool);
    w.owner_deposit(pool, dec!(0), dec!(1), Some((ra, rb))).expect_commit_success();
    assert_eq!(w.status(pool).4, anchor0);
    let (ra, rb) = w.reserves(pool);
    w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(-1), dec!(0), Some((ra, rb)))).expect_commit_success();
    assert_eq!(w.status(pool).4, anchor0);
    w.as_owner(pool, "withdraw", manifest_args!(dec!(1), dec!(0), NO_GUARD)).expect_commit_success();
    assert_eq!(w.status(pool).4, anchor0);

    // 4. regrow at the thief's price: refused now and after any number of refills. Even a 0.01%
    //    regrow costs the distance (~15x) from the anchor.
    for _ in 0..3 {
        let (da, db) = regrow_amounts(&mut w, pool, m);
        w.rebalance(pool, da, db).expect_commit_failure_containing_error("Operator price-move limit");
        let (da, db) = regrow_amounts(&mut w, pool, dec!("1.0001"));
        w.rebalance(pool, da, db).expect_commit_failure_containing_error("Operator price-move limit");
        w.advance(100);
    }

    // 5. the thief takes his own trade back
    arb_to_buy_a(&mut w, pool, 1.0);
    let gain = thief_value(&mut w, 1.0) - v0;
    println!("M-1 fixed: regrow refused; thief ends {gain:.6} (was +978.7 before the fix)");
    assert!(gain < 1e-6, "thief gains nothing: {gain}");
}

/// M-1 multi-window variant (FIXED). Before, ONE owner call left the anchor at the thief's price and
/// the thief then repeated shrink / push / regrow every window with no further owner action. Now the
/// owner's call does not move the anchor, so the first regrow is refused and the cycle never starts,
/// however many windows pass.
#[test]
fn m1_attack_repeats_every_window_after_one_owner_call_is_refused() {
    let mut w = W::new();
    let pool = setup(&mut w);
    let (bot, a) = (w.bot, w.a);
    w.rebalance(pool, dec!(-13_436), dec!(-13_436)).expect_commit_success();
    w.swap(bot, pool, a, dec!(13_692)).expect_commit_success();
    let (ra, rb) = w.reserves(pool);
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1), Some((ra, rb)))).expect_commit_success();
    for _ in 0..3 {
        let (da, db) = regrow_amounts(&mut w, pool, dec!("1.094988"));
        w.rebalance(pool, da, db).expect_commit_failure_containing_error("Operator price-move limit");
        w.advance(100);
    }
    assert_eq!(w.status(pool).4, (dec!(1), dec!(1)));
}

/// The residual after the fix (design document, term D): the anchor is off the market only because
/// the OWNER stated it so (a stale or mistaken price: here 1.2 B per A while the market is 1). Each
/// window the thief runs the auditor's cycle against it with no owner call: exact free shrink at the
/// market price, push the curve to the anchor with his own capital, regrow to the caps paying the
/// depth term (the regrow is at the anchor, so no price term), sell back to market. It works, but
/// every cycle spends ~ one window's budget and gains only ~ (L' - L) * 4 sinh^2(D / 4), within the
/// bound S * C * psi(D + 2C) with D = ln 1.2.
#[test]
fn m1_owner_stated_off_market_anchor_cycles_are_bounded() {
    let mut w = W::new();
    let pool = setup(&mut w);
    let d = 1.2f64.ln();
    let r = w.set_anchor(pool, dec!(1), dec!("1.2"), Some((dec!(18_000), dec!(18_000))));
    let ev: Vec<AnchorEv> = w.events(&r, "OwnerPoolAnchorEvent");
    assert_eq!(ev, vec![AnchorEv { anchor_a: dec!(1), anchor_b: dec!("1.2") }]);
    assert_eq!(w.status(pool).2, dec!(0), "stating an anchor zeroes the allowance");
    w.advance(100);
    let v0 = thief_value(&mut w, 1.0);
    let owner0 = w.total(pool);
    let mut spent = 0.0;
    let rounds = 3;
    for round in 0..rounds {
        // 1. free shrink at the market price to L ~ 16,680
        if round == 0 {
            let x = dec!(1_320);
            let r = w.rebalance(pool, -x, -x);
            let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
            assert_eq!(ev[0].cost, dec!(0));
        } else {
            exact_shrink(&mut w, pool, 16_680.0);
        }
        // 2. own capital: buy A until the curve sits at the anchor's price
        arb_to_buy_a(&mut w, pool, 1.2);
        // 3. regrow by 1.0935 (B ends just under its 20k cap): depth cost ~0.0979
        let (da, db) = regrow_amounts(&mut w, pool, dec!("1.0935"));
        let r = w.rebalance(pool, da, db);
        let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
        spent += f(ev[0].cost);
        // 4. sell A back to market
        arb_to_sell_a(&mut w, pool, 1.0);
        println!("D-residual: round {round}, cost {}, thief gain so far {:.4}", ev[0].cost, thief_value(&mut w, 1.0) - v0);
        w.advance(100);
    }
    let gain = thief_value(&mut w, 1.0) - v0;
    let (ta, tb) = w.total(pool);
    let owner_loss = f(owner0.0) + f(owner0.1) - f(ta) - f(tb);
    let bound = design_bound(spent, d);
    println!("D-residual: anchor stated 20% off market; {rounds} windows, budget spent {spent:.4}, thief gain {gain:.4} = owner loss {owner_loss:.4}; bound {bound:.4}");
    assert!((gain - owner_loss).abs() < 1e-3, "zero-sum at fee 0");
    assert!(gain > 0.0 && gain <= bound);
    assert!(gain < 60.0, "about 13 per window, against 978.7 in ONE window before the fix");
}

// ============================================================================ L-1: dust shrink

/// L-1 (FIXED). A stolen key could shrink the curve to 1 atto per side for free and brick it until the
/// owner acted. Now the owner sets reserve floors, and before any limits are set the operator cannot
/// lower a reserve at all. Swaps keep working, and the operator may still RAISE a side a swap left
/// below its floor.
#[test]
fn l1_dust_shrink_is_refused_by_the_floor() {
    let mut w = W::new();
    let pool = w.pool(dec!(10_000), dec!(10_000), 30);
    w.fund_inventory(pool, dec!(1_000), dec!(1_000)).expect_commit_success();
    let (bot, other, op, a) = (w.bot, w.other, w.op, w.a);
    w.appoint(pool, bot, op).expect_commit_success();
    let atto = Decimal::from_attos(I192::from(1));
    let shrink = dec!(10_000) - atto;
    // Default limits: no lowering at all.
    w.rebalance(pool, -shrink, -shrink).expect_commit_failure_containing_error("Below the operator's reserve floor");
    w.rebalance(pool, dec!(-1), dec!(-1)).expect_commit_failure_containing_error("Below the operator's reserve floor");
    // Floors at half the curve.
    w.set_limits_floor(pool, 300, 72, dec!(11_000), dec!(11_000), dec!(5_000), dec!(5_000), 10, 100).expect_commit_success();
    w.advance(72);
    w.rebalance(pool, -shrink, -shrink).expect_commit_failure_containing_error("Below the operator's reserve floor");
    w.rebalance(pool, dec!(-5_001), dec!(-5_001)).expect_commit_failure_containing_error("Below the operator's reserve floor");
    w.rebalance(pool, dec!(0), dec!(-5_001)).expect_commit_failure_containing_error("Below the operator's reserve floor");
    let r = w.rebalance(pool, dec!(-5_000), dec!(-5_000));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!(0));
    assert_eq!(w.reserves(pool), (dec!(5_000), dec!(5_000)));
    w.rebalance(pool, dec!(-1), dec!(0)).expect_commit_failure_containing_error("Below the operator's reserve floor");
    w.swap(other, pool, a, dec!(1)).expect_commit_success();
    let (_, rb) = w.reserves(pool);
    assert!(rb < dec!(5_000));
    w.rebalance(pool, dec!(0), dec!(1)).expect_commit_success();
}

// ============================================================================ informational

/// All FIXED:
/// I-a: revoking the operator clears its pause flag. Since split audit 2 (Low-1) the revoke also
///      turns the OWNER's pause on, so swaps stay closed until the owner reopens them.
/// I-b: the default operator fee range gives no fee power, so an operator on default limits cannot
///      undo the owner's `set_fee`.
/// I-c: the owner's pause is a full stop for the hot key: `rebalance` and `operator_set_fee` refused.
/// I-d: a replacement operator does not inherit the old key's allowance (it starts at zero and
///      refills) nor its anchor (the owner states one when appointing).
#[test]
fn informational_revoke_pause_fee_range_inheritance() {
    let mut w = W::new();
    let pool = w.pool(dec!(10_000), dec!(10_000), 30);
    w.fund_inventory(pool, dec!(1_000), dec!(1_000)).expect_commit_success();
    let (bot, other, op, a) = (w.bot, w.other, w.op, w.a);
    // I-b
    w.as_owner(pool, "set_fee", manifest_args!(100u16)).expect_commit_success();
    w.appoint(pool, bot, op).expect_commit_success();
    for fee in [30u16, 100] {
        w.as_operator(pool, "operator_set_fee", manifest_args!(fee)).expect_commit_failure_containing_error("The operator may not change the fee");
    }
    assert_eq!(w.read::<u16>(pool, "fee_bps"), 100);
    // I-c
    w.set_limits(pool, 300, 72, dec!(11_000), dec!(11_000), 10, 100).expect_commit_success();
    w.advance(72);
    w.as_owner(pool, "set_paused", manifest_args!(true)).expect_commit_success();
    w.rebalance(pool, dec!(100), dec!(0)).expect_commit_failure_containing_error("Paused by the owner");
    w.rebalance(pool, dec!(-1), dec!(-1)).expect_commit_failure_containing_error("Paused by the owner");
    w.as_operator(pool, "operator_set_fee", manifest_args!(50u16)).expect_commit_failure_containing_error("Paused by the owner");
    // its own pause flag is harmless while the owner's pause is on
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    w.as_operator(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();
    // the owner still moves funds while paused
    w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(1), dec!(1), NO_GUARD)).expect_commit_success();
    w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(-1), dec!(-1), NO_GUARD)).expect_commit_success();
    w.as_owner(pool, "set_paused", manifest_args!(false)).expect_commit_success();
    w.rebalance(pool, dec!(100), dec!(0)).expect_commit_success();
    let left = w.status(pool).2;
    println!("I-d: allowance left after the old key's move {left}");
    // I-a
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    let r = w.as_owner(pool, "set_operator", manifest_args!(None::<ResourceAddress>, None::<(Decimal, Decimal)>));
    let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
    assert_eq!(ev, vec![ConfigEv { fee_bps: 100, paused: true, operator_paused: false }]);
    assert!(w.read::<bool>(pool, "is_paused"));
    w.swap(other, pool, a, dec!(1)).expect_commit_failure_containing_error("Swaps are paused");
    w.as_owner(pool, "set_paused", manifest_args!(false)).expect_commit_success();
    w.swap(other, pool, a, dec!(1)).expect_commit_success();
    // I-d: new operator: allowance zero, anchor as stated now; refills normally.
    let op2 = w.ledger.create_fungible_resource(dec!(1), 0, other.account);
    w.appoint_at(pool, other, op2, (dec!(1), dec!("1.01"))).expect_commit_success();
    let (_, _, allowance, op_paused, anchor) = w.status(pool);
    assert_eq!((allowance, op_paused, anchor), (dec!(0), false, (dec!(1), dec!("1.01"))));
    w.set_limits(pool, 300, 72, dec!(11_000), dec!(11_000), 10, 100).expect_commit_success();
    assert_eq!(w.status(pool).2, dec!(0), "re-setting limits does not top up");
    w.advance(36);
    assert_eq!(w.status(pool).2, dec!("0.015"));
}

/// `set_anchor` (new): owner only (also in the role tables of owner_pool_split.rs); states the price
/// as a pair, refuses a non-positive part, honours the reserves guard, zeroes the allowance (which
/// then refills normally), and the operator's next move is measured from it. `set_operator` with an
/// anchor does the same.
#[test]
fn set_anchor_states_price_and_zeroes_allowance() {
    let mut w = W::new();
    let pool = w.pool(dec!(10_000), dec!(10_000), 30);
    w.fund_inventory(pool, dec!(1_000), dec!(1_000)).expect_commit_success();
    let (bot, op) = (w.bot, w.op);
    w.appoint(pool, bot, op).expect_commit_success();
    w.set_limits(pool, 300, 72, dec!(11_000), dec!(11_000), 10, 100).expect_commit_success();
    w.advance(72);
    assert_eq!(w.status(pool).2, dec!("0.03"));
    w.set_anchor(pool, dec!(1), dec!("1.01"), Some((dec!(1), dec!(1)))).expect_commit_failure_containing_error("Reserves moved");
    w.set_anchor(pool, dec!(0), dec!(1), NO_GUARD).expect_commit_failure_containing_error("Bad anchor");
    w.set_anchor(pool, dec!(1), dec!(-1), NO_GUARD).expect_commit_failure_containing_error("Bad anchor");
    w.as_operator(pool, "set_anchor", manifest_args!(dec!(1), dec!("1.01"), NO_GUARD)).expect_commit_failure();
    assert_eq!(w.status(pool).2, dec!("0.03"), "refused calls change nothing");
    let r = w.set_anchor(pool, dec!(1), dec!("1.01"), Some((dec!(10_000), dec!(10_000))));
    let ev: Vec<AnchorEv> = w.events(&r, "OwnerPoolAnchorEvent");
    assert_eq!(ev, vec![AnchorEv { anchor_a: dec!(1), anchor_b: dec!("1.01") }]);
    let (_, _, allowance, _, anchor) = w.status(pool);
    assert_eq!((allowance, anchor), (dec!(0), (dec!(1), dec!("1.01"))));
    w.rebalance(pool, dec!(0), dec!(100)).expect_commit_failure_containing_error("Operator price-move limit");
    w.advance(72);
    // A one-sided add that brings the curve to the stated anchor: max(d(P, P') = 0.01, d(A, P') = 0)
    // + depth (1.01 - 1) / 2 = 0.015. The anchor then follows the operator's move.
    let r = w.rebalance(pool, dec!(0), dec!(100));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!("0.015"));
    assert_eq!(w.status(pool).4, (dec!(10_000), dec!(10_100)));
    // Revoking may state an anchor too; it also zeroes the allowance.
    w.advance(72);
    w.as_owner(pool, "set_operator", manifest_args!(None::<ResourceAddress>, Some((dec!(2), dec!(3))))).expect_commit_success();
    let (o, _, allowance, _, anchor) = w.status(pool);
    assert_eq!((o, allowance, anchor), (None, dec!(0), (dec!(2), dec!(3))));
}

// ============================================================================ budget edge cases

/// Refill arithmetic at the extremes: window = u64::MAX with a huge epoch gap, window 1, a budget
/// raised from 0 (no retroactive grant), and a cut budget clipping the allowance.
#[test]
fn budget_refill_edges() {
    let mut w = W::new();
    let pool = w.pool(dec!(10_000), dec!(10_000), 0);
    w.fund_inventory(pool, dec!(10_000), dec!(10_000)).expect_commit_success();
    let (bot, op) = (w.bot, w.op);
    w.appoint(pool, bot, op).expect_commit_success();
    // Budget 0 for a long time, then raised: nothing accrued for the past.
    w.advance(1_000_000);
    w.set_limits(pool, 10_000, u64::MAX, dec!(1_000_000), dec!(1_000_000), 0, 0).expect_commit_success();
    assert_eq!(w.status(pool).2, dec!(0));
    // A huge gap (2^40 epochs) under a u64::MAX window: accrues 2^40 / 2^64 of the budget, no overflow.
    w.advance(1u64 << 40);
    let have = w.status(pool).2;
    println!("budget edges: allowance after 2^40 epochs of a u64::MAX window: {have}");
    assert!(have > dec!(0) && have < dec!("0.0001"));
    // Window 1: full after one epoch, never above one budget.
    w.set_limits(pool, 10_000, 1, dec!(1_000_000), dec!(1_000_000), 0, 0).expect_commit_success();
    w.advance(5);
    assert_eq!(w.status(pool).2, dec!(1));
    // Cut to 100 bps: clipped.
    w.set_limits(pool, 100, 1, dec!(1_000_000), dec!(1_000_000), 0, 0).expect_commit_success();
    assert_eq!(w.status(pool).2, dec!("0.01"));
    // An add of 1% costs 0.01 + 0.005 (depth): refused. A 1%-ish removal costs only the price move.
    w.rebalance(pool, dec!(0), dec!(100)).expect_commit_failure_containing_error("Operator price-move limit");
    w.rebalance(pool, dec!(0), dec!(-99)).expect_commit_success();
    assert!(w.status(pool).2 < dec!("0.0001"));
}
