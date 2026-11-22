//! Second independent audit of the cold/hot split (branch `pool-split`, 6e8891a). Attack tests that
//! MEASURE a stolen operator key's gain at the design document's suggested defaults (budget 300 bps
//! per 72-epoch window, caps = reserves + 10%, floors 50%, operator fee range 10-100 bps, curve
//! 18k/18k at P* = 1) and compare it with the document's table, plus edge cases of the fixes.
//! Each test prints its measurements (`cargo test -- --nocapture`).

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
        Self::with_divisibility(18, 18)
    }

    fn with_divisibility(div_a: u8, div_b: u8) -> Self {
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
        w.a = w.token(dec!(1_000_000_000), div_a);
        w.b = w.token(dec!(1_000_000_000), div_b);
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

    fn appoint(&mut self, pool: ComponentAddress, anchor: (Decimal, Decimal)) -> TransactionReceipt {
        let (o, ob, bot, op) = (self.owner, self.badge, self.bot, self.op);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, ob, dec!(1))
            .create_proof_from_account_of_amount(bot.account, op, dec!(1))
            .call_method(pool, "set_operator", manifest_args!(Some(op), Some(anchor)))
            .build();
        self.run(&[o, bot], m)
    }

    #[allow(clippy::too_many_arguments)]
    fn set_limits(&mut self, pool: ComponentAddress, budget_bps: u16, window: u64, cap_a: Decimal, cap_b: Decimal, floor_a: Decimal, floor_b: Decimal, min_fee: u16, max_fee: u16) -> TransactionReceipt {
        self.as_owner(pool, "set_operator_limits", manifest_args!(budget_bps, window, cap_a, cap_b, floor_a, floor_b, min_fee, max_fee))
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

/// The design document's bound S * C * psi(D + 2C).
fn design_bound(s: f64, c: f64, d0: f64) -> f64 {
    let psi = |d: f64| 2.0 * ((d / 2.0).cosh() - 1.0) + (d / 2.0).sinh();
    s * c * psi(d0 + 2.0 * c)
}

/// S at the defaults: caps 19.8k each, P* = 1.
const S_DEFAULTS: f64 = 19_800.0;

fn value(w: &mut W, who: Actor, p_star: f64) -> f64 {
    let (a, b) = (w.a, w.b);
    f(w.bal(who, a)) * p_star + f(w.bal(who, b))
}

fn pool_value(w: &mut W, pool: ComponentAddress, p_star: f64) -> f64 {
    let (ta, tb) = w.total(pool);
    f(ta) * p_star + f(tb)
}

/// Swap so that the curve's price (B per A) ends at `target`, from `who`'s account. The size is the
/// fee-free amount (the fee makes it stop marginally short); returns false if already there.
fn swap_to(w: &mut W, who: Actor, pool: ComponentAddress, target: f64) -> bool {
    let (ra, rb) = w.reserves(pool);
    let (fa, fb) = (f(ra), f(rb));
    let k = fa * fb;
    let (a, b) = (w.a, w.b);
    if fb / fa > target * (1.0 + 1e-9) {
        let x = dec_floor((k / target).sqrt() - fa, 6);
        if x > Decimal::ZERO { w.swap(who, pool, a, x).expect_commit_success(); return true; }
    } else if fb / fa < target * (1.0 - 1e-9) {
        let y = dec_floor((k * target).sqrt() - fb, 6);
        if y > Decimal::ZERO { w.swap(who, pool, b, y).expect_commit_success(); return true; }
    }
    false
}

/// Operator move that lowers the curve's price (B per A) by spending `use_frac` of the allowance now,
/// by removing B only (one-sided removal: no depth charge, price term only).
fn push_down_remove_b(w: &mut W, pool: ComponentAddress, use_frac: f64) -> f64 {
    let (_, _, allow, _, (aa, ab)) = w.status(pool);
    let (ra, rb) = w.reserves(pool);
    let p = f(rb) / f(ra);
    let anchor = f(ab) / f(aa);
    let reference = p.max(anchor);
    let target = reference / (1.0 + use_frac * f(allow));
    let nb = target * f(ra);
    let remove = dec_floor(f(rb) - nb, 6);
    let r = w.rebalance(pool, dec!(0), -remove);
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    f(ev[0].cost)
}

/// Same price target, but k-neutral: add A from inventory and remove B so depth stays the same (keeps
/// L, so the mispricing sits on a bigger curve). Raises A, so both reserves must be within the caps.
fn push_down_k_neutral(w: &mut W, pool: ComponentAddress, use_frac: f64) -> f64 {
    let (_, _, allow, _, (aa, ab)) = w.status(pool);
    let (ra, rb) = w.reserves(pool);
    let p = f(rb) / f(ra);
    let anchor = f(ab) / f(aa);
    let reference = p.max(anchor);
    // price ratio P'/P = 1/s^2 with na = ra*s, nb = rb/s; aim d(reference, P') = use_frac * allow
    let target = reference / (1.0 + use_frac * f(allow));
    let s = (p / target).sqrt();
    let add_a = dec_floor(f(ra) * (s - 1.0), 6);
    // remove a bit MORE B than k-neutral would (so k' <= k: no depth charge)
    let remove_b = dec_floor(f(rb) * (1.0 - 1.0 / s), 6) + dec!("0.000001");
    let r = w.rebalance(pool, add_a, -remove_b);
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    f(ev[0].cost)
}

/// The document's suggested defaults: 18k/18k at 1 B per A, owner fee 30 bps, inventory 2k/2k,
/// budget 300 bps / 72 epochs, caps 19.8k, floors 9k, operator fee range [10, 100]; the operator is
/// appointed with the true market price as the anchor and has a full allowance when the key is stolen.
fn defaults(w: &mut W) -> ComponentAddress {
    let pool = w.pool(dec!(18_000), dec!(18_000), 30);
    w.fund_inventory(pool, dec!(2_000), dec!(2_000)).expect_commit_success();
    w.appoint(pool, (dec!(1), dec!(1))).expect_commit_success();
    w.set_limits(pool, 300, 72, dec!(19_800), dec!(19_800), dec!(9_000), dec!(9_000), 10, 100).expect_commit_success();
    w.advance(72);
    assert_eq!(w.status(pool).2, dec!("0.03"));
    pool
}

// ============================================================================ one window, D = 0

/// One burst with a full allowance, anchor = market (D = 0). The thief sets the fee to the bottom of
/// his range, spends the whole allowance pushing the price down, and buys A back to market.
/// Two push shapes: one-sided removal, and k-neutral (keeps the curve deep). Doc table: 18.4 (D = 0,
/// one burst, fee 0).
#[test]
fn a2_one_window_burst_at_defaults() {
    for k_neutral in [false, true] {
        let mut w = W::new();
        let pool = defaults(&mut w);
        let bot = w.bot;
        let t0 = value(&mut w, bot, 1.0);
        let o0 = pool_value(&mut w, pool, 1.0);
        w.as_operator(pool, "operator_set_fee", manifest_args!(10u16)).expect_commit_success();
        let cost = if k_neutral { push_down_k_neutral(&mut w, pool, 0.995) } else { push_down_remove_b(&mut w, pool, 0.995) };
        swap_to(&mut w, bot, pool, 1.0);
        let gain = value(&mut w, bot, 1.0) - t0;
        let loss = o0 - pool_value(&mut w, pool, 1.0);
        let bound = design_bound(S_DEFAULTS, cost, 0.0);
        println!("A2 burst (k_neutral={k_neutral}): cost {cost:.5}, thief gain {gain:.4}, owner loss {loss:.4}, doc bound {bound:.2}");
        assert!(gain > 0.0, "the attack gains something");
        assert!(gain <= bound, "within the document's bound");
    }
}

// ============================================================================ 24 hours, D = 0

/// 24 h (288 epochs = 4 windows after a full allowance: C = 0.15) WITHOUT the operator pause, so
/// arbitrageurs could trade between the thief's steps. Each window: own capital takes the curve to
/// the anchor the operator's previous move left, the operator pushes one window's budget further,
/// and the thief buys back to market. The gains telescope to ~ L * 4 sinh^2(C / 4).
/// Doc table: 514.1 (D = 0, 288 epochs).
#[test]
fn a2_staircase_24h_without_pause() {
    let mut w = W::new();
    let pool = defaults(&mut w);
    let bot = w.bot;
    let t0 = value(&mut w, bot, 1.0);
    let o0 = pool_value(&mut w, pool, 1.0);
    w.as_operator(pool, "operator_set_fee", manifest_args!(10u16)).expect_commit_success();
    let mut spent = 0.0;
    for step in 0..5 {
        if step > 0 { w.advance(72); }
        let (_, _, _, _, (aa, ab)) = w.status(pool);
        swap_to(&mut w, bot, pool, f(ab) / f(aa));
        spent += push_down_k_neutral(&mut w, pool, 0.995);
        swap_to(&mut w, bot, pool, 1.0);
        let (_, _, _, _, (aa, ab)) = w.status(pool);
        println!("A2 staircase: step {step}, spent {spent:.4}, anchor now {:.5}, thief gain so far {:.4}", f(ab) / f(aa), value(&mut w, bot, 1.0) - t0);
    }
    let gain = value(&mut w, bot, 1.0) - t0;
    let loss = o0 - pool_value(&mut w, pool, 1.0);
    let bound = design_bound(S_DEFAULTS, spent, 0.0);
    println!("A2 staircase 24h: spent {spent:.4}, thief gain {gain:.4}, owner loss {loss:.4}, doc bound {bound:.2} (table 514.1)");
    assert!(gain <= bound);
    assert!(gain <= 514.1);
}

/// Same 24 h with the operator pause on (nobody can trade the mispricing back between steps); the
/// thief unpauses and buys back once at the end.
#[test]
fn a2_paused_push_24h() {
    let mut w = W::new();
    let pool = defaults(&mut w);
    let bot = w.bot;
    let t0 = value(&mut w, bot, 1.0);
    let o0 = pool_value(&mut w, pool, 1.0);
    w.as_operator(pool, "operator_set_fee", manifest_args!(10u16)).expect_commit_success();
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    let mut spent = 0.0;
    for step in 0..5 {
        if step > 0 { w.advance(72); }
        spent += push_down_k_neutral(&mut w, pool, 0.995);
    }
    let (ra, rb) = w.reserves(pool);
    println!("A2 paused: curve price after 5 pushes {:.5}, reserves {ra} / {rb}", f(rb) / f(ra));
    w.as_operator(pool, "set_operator_paused", manifest_args!(false)).expect_commit_success();
    swap_to(&mut w, bot, pool, 1.0);
    let gain = value(&mut w, bot, 1.0) - t0;
    let loss = o0 - pool_value(&mut w, pool, 1.0);
    let bound = design_bound(S_DEFAULTS, spent, 0.0);
    println!("A2 paused 24h: spent {spent:.4}, thief gain {gain:.4}, owner loss {loss:.4}, doc bound {bound:.2} (table 514.1)");
    assert!(gain <= bound);
}

// ============================================================================ stale anchor (D > 0)

/// The market moved while the bot was stopped: arbitrageurs (another account) take the curve to the
/// new market price P* = e^D, the anchor stays at 1. One window: own capital takes the curve back to
/// the anchor, the operator pushes one budget further, the thief buys back to market. Gain ~
/// L * (g(D + c) - g(D)), g(x) = 4 sinh^2(x / 4). Doc table one burst: D = 0.05: 34.5; D = 0.1: 51.4.
/// Also 24 h (staircase) with D = 0.1: doc table 717.2.
#[test]
fn a2_stale_anchor_one_window_and_24h() {
    for (d, table_burst, table_24h) in [(0.05f64, 34.5, 613.6), (0.1f64, 51.4, 717.2)] {
        let mut w = W::new();
        let pool = defaults(&mut w);
        let (bot, other) = (w.bot, w.other);
        let p_star = d.exp();
        swap_to(&mut w, other, pool, p_star);
        let t0 = value(&mut w, bot, p_star);
        let o0 = pool_value(&mut w, pool, p_star);
        w.as_operator(pool, "operator_set_fee", manifest_args!(10u16)).expect_commit_success();
        let mut spent = 0.0;
        let mut burst_gain = 0.0;
        for step in 0..5 {
            if step > 0 { w.advance(72); }
            let (_, _, _, _, (aa, ab)) = w.status(pool);
            swap_to(&mut w, bot, pool, f(ab) / f(aa));
            spent += push_down_k_neutral(&mut w, pool, 0.995);
            swap_to(&mut w, bot, pool, p_star);
            if step == 0 {
                burst_gain = value(&mut w, bot, p_star) - t0;
                let bound = design_bound(S_DEFAULTS * p_star.sqrt(), spent, d);
                println!("A2 stale anchor D={d}: one window, spent {spent:.4}, thief gain {burst_gain:.4}, doc bound {bound:.2} (table {table_burst})");
            }
        }
        let gain = value(&mut w, bot, p_star) - t0;
        let loss = o0 - pool_value(&mut w, pool, p_star);
        let bound = design_bound(S_DEFAULTS * p_star.sqrt(), spent, d);
        println!("A2 stale anchor D={d}: 24h, spent {spent:.4}, thief gain {gain:.4}, owner loss {loss:.4}, doc bound {bound:.2} (table {table_24h})");
        assert!(burst_gain <= table_burst * p_star.sqrt());
        assert!(gain <= bound);
    }
}

// ============================================================================ anchor drift vs cost

/// The anchor moves only by budgeted operator moves, by at most what they cost. Many tiny moves in
/// both directions (down to 1 atto), moves while the allowance refills, and one-sided and two-sided
/// moves: the cumulative |ln| change of the anchor never exceeds the cumulative cost, and every
/// non-free move costs at least 1 atto.
#[test]
fn a2_anchor_drift_never_exceeds_spend() {
    let mut w = W::new();
    let pool = defaults(&mut w);
    let atto = Decimal::from_attos(I192::from(1));
    let mut spent = 0.0f64;
    let mut drift = 0.0f64;
    let mut prev = { let (_, _, _, _, (aa, ab)) = w.status(pool); f(ab) / f(aa) };
    let moves: Vec<(Decimal, Decimal)> = vec![
        (dec!(0), atto), (dec!(0), -atto), (atto, dec!(0)), (-atto, dec!(0)), (atto, -atto),
        (dec!(0), dec!("0.5")), (dec!(0), dec!("-0.5")), (dec!("0.3"), dec!("-0.3")), (dec!("-0.3"), dec!("0.3")),
        (dec!(5), dec!(0)), (dec!(-5), dec!(0)), (dec!(0), dec!(5)), (dec!(0), dec!(-5)),
    ];
    let mut i = 0;
    for round in 0..4 {
        for (da, db) in moves.iter() {
            let r = w.rebalance(pool, *da, *db);
            let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
            assert!(ev[0].cost >= atto, "every priced move costs at least 1 atto");
            spent += f(ev[0].cost);
            let (_, _, _, _, (aa, ab)) = w.status(pool);
            let now = f(ab) / f(aa);
            drift += (now / prev).ln().abs();
            prev = now;
            i += 1;
        }
        if round < 3 { w.advance(7); }
    }
    let (_, _, _, _, (aa, ab)) = w.status(pool);
    println!("A2 drift: {i} moves, spent {spent:.8}, cumulative anchor |ln| drift {drift:.8}, anchor {:.8}", f(ab) / f(aa));
    assert!(drift <= spent + 1e-12);
}

// ============================================================================ events

/// FIXED (was `a2_rebalance_event_allowance_is_stale`): the rebalance event's `allowance` used to be
/// the stored value, so on a free proportional decrease and on every owner move it reported 0 while
/// the operator had the full 0.03. It now reports the allowance available now, equal to what
/// `operator_status` returns after the move, on free, owner and priced moves alike; and reporting it
/// does not change the budget accounting (a free move still leaves the full refill available).
#[test]
fn a2_rebalance_event_allowance_is_current() {
    let mut w = W::new();
    let pool = defaults(&mut w);
    let now = w.status(pool).2;
    assert_eq!(now, dec!("0.03"));
    // free proportional decrease
    let r = w.rebalance(pool, dec!(-100), dec!(-100));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    let after = w.status(pool).2;
    println!("A2 event: operator_status allowance {after}, event allowance {} (cost {})", ev[0].allowance, ev[0].cost);
    assert_eq!(ev[0].cost, dec!(0));
    assert_eq!(ev[0].allowance, after);
    assert_eq!(after, dec!("0.03"), "a free move spends nothing");
    // owner move
    let r = w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(1), dec!(1), NO_GUARD));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].allowance, w.status(pool).2);
    assert_eq!(ev[0].allowance, dec!("0.03"));
    // priced operator move, part-way through a refill
    let r = w.rebalance(pool, dec!(0), dec!(-50));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert!(ev[0].cost > dec!(0));
    assert_eq!(ev[0].allowance, w.status(pool).2);
    assert_eq!(ev[0].allowance, dec!("0.03") - ev[0].cost);
    let left = ev[0].allowance;
    w.advance(1);
    let r = w.as_owner(pool, "owner_rebalance", manifest_args!(dec!(1), dec!(0), NO_GUARD));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    let status = w.status(pool).2;
    assert_eq!(ev[0].allowance, status);
    assert!(status > left, "the event includes the refill since the last priced move");
}

// ============================================================================ revoke ordering

#[derive(ScryptoSbor, Debug, Clone, PartialEq)]
struct ConfigEv {
    fee_bps: u16,
    paused: bool,
    operator_paused: bool,
}

/// The thief's set-up for the revoke tests: fee to the bottom of his range, operator pause on (nobody,
/// the thief included, can trade the mispricing), then pushes over 2 windows. Returns the reserves
/// before the attack.
fn paused_two_window_push(w: &mut W, pool: ComponentAddress) -> (Decimal, Decimal) {
    let r0 = w.reserves(pool);
    w.as_operator(pool, "operator_set_fee", manifest_args!(10u16)).expect_commit_success();
    w.as_operator(pool, "set_operator_paused", manifest_args!(true)).expect_commit_success();
    push_down_k_neutral(w, pool, 0.995);
    w.advance(72);
    push_down_k_neutral(w, pool, 0.995);
    r0
}

/// FIXED (was `a2_revoke_alone_reopens_swaps_on_the_mispriced_curve`, measured thief gain 15.05).
/// The thief pauses swaps and pushes over 2 windows. Two ways the owner can react:
///   (a) revoke alone, `set_operator(None, None)`: the revoke clears the operator pause AND turns the
///       owner's pause on, so swaps stay closed ("Swaps are paused", owner flag set, operator flag
///       clear, config event says so) and the thief gains nothing while the curve is mispriced;
///   (b) one owner transaction: `set_paused(true)`, revoke, `owner_rebalance` reversing the thief's
///       moves, `set_paused(false)`: still works, nothing is lost.
#[test]
fn a2_revoke_alone_keeps_swaps_closed() {
    for careful in [false, true] {
        let mut w = W::new();
        let pool = defaults(&mut w);
        let bot = w.bot;
        let t0 = value(&mut w, bot, 1.0);
        let o0 = pool_value(&mut w, pool, 1.0);
        let r0 = paused_two_window_push(&mut w, pool);
        if careful {
            let (ra, rb) = w.reserves(pool);
            let (o, badge) = (w.owner, w.badge);
            let m = ManifestBuilder::new().lock_fee_from_faucet()
                .create_proof_from_account_of_amount(o.account, badge, dec!(1))
                .call_method(pool, "set_paused", manifest_args!(true))
                .call_method(pool, "set_operator", manifest_args!(None::<ResourceAddress>, None::<(Decimal, Decimal)>))
                .call_method(pool, "owner_rebalance", manifest_args!(r0.0 - ra, r0.1 - rb, Some((ra, rb))))
                .call_method(pool, "set_paused", manifest_args!(false))
                .build();
            w.run(&[o], m).expect_commit_success();
            assert!(!w.read::<bool>(pool, "is_paused"));
            swap_to(&mut w, bot, pool, 1.0);
        } else {
            let r = w.as_owner(pool, "set_operator", manifest_args!(None::<ResourceAddress>, None::<(Decimal, Decimal)>));
            let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
            assert_eq!(ev, vec![ConfigEv { fee_bps: 10, paused: true, operator_paused: false }]);
            assert!(w.read::<bool>(pool, "is_paused"));
            assert!(!w.status(pool).3, "the thief's pause flag is cleared; the pause is the owner's");
            // the thief (or anyone) tries to take the mispricing: refused
            let (ra, rb) = w.reserves(pool);
            let (a, b) = (w.a, w.b);
            assert!(f(rb) / f(ra) < 0.97, "the curve is mispriced");
            w.swap(bot, pool, b, dec!(100)).expect_commit_failure_containing_error("Swaps are paused");
            w.swap(bot, pool, a, dec!(1)).expect_commit_failure_containing_error("Swaps are paused");
            // and the bot's badge no longer works for anything
            w.as_operator(pool, "set_operator_paused", manifest_args!(false)).expect_commit_failure();
            assert!(w.read::<bool>(pool, "is_paused"));
        }
        let gain = value(&mut w, bot, 1.0) - t0;
        let loss = o0 - pool_value(&mut w, pool, 1.0);
        println!("A2 revoke (careful={careful}): thief gain {gain:.4}, owner loss {loss:.4}");
        assert!(gain <= 0.0);
        // the owner can always take everything out afterwards, paused or not
        w.as_owner(pool, "withdraw_all", manifest_args!()).expect_commit_success();
        assert_eq!(w.total(pool), (dec!(0), dec!(0)));
    }
}

/// After a bare revoke the owner restores the curve in his own time, in separate transactions:
/// `owner_rebalance` back to the market (guarded by the reserves he saw), then `set_paused(false)`.
/// The thief, trading as soon as swaps reopen, gains nothing and the owner loses nothing. Also: the
/// owner's whole toolkit works while the revoke's pause is on (`deposit`, `withdraw`, `set_anchor`,
/// `set_operator`), and re-appointing does not reopen swaps by itself.
#[test]
fn a2_revoke_then_restore_then_reopen_leaves_thief_nothing() {
    let mut w = W::new();
    let pool = defaults(&mut w);
    let (bot, a, b) = (w.bot, w.a, w.b);
    let t0 = value(&mut w, bot, 1.0);
    let o0 = pool_value(&mut w, pool, 1.0);
    let r0 = paused_two_window_push(&mut w, pool);
    w.as_owner(pool, "set_operator", manifest_args!(None::<ResourceAddress>, None::<(Decimal, Decimal)>)).expect_commit_success();
    assert!(w.read::<bool>(pool, "is_paused"));
    // the owner's calls while paused
    let (o, badge) = (w.owner, w.badge);
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(o.account, badge, dec!(1))
        .withdraw_from_account(o.account, a, dec!(1)).take_all_from_worktop(a, "a")
        .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("a")), None::<ManifestBucket>, NO_GUARD))
        .build();
    w.run(&[o], m).expect_commit_success();
    w.as_owner(pool, "withdraw", manifest_args!(dec!(1), dec!(0), NO_GUARD)).expect_commit_success();
    w.as_owner(pool, "set_anchor", manifest_args!(dec!(1), dec!(1), NO_GUARD)).expect_commit_success();
    let (ra, rb) = w.reserves(pool);
    w.as_owner(pool, "owner_rebalance", manifest_args!(r0.0 - ra, r0.1 - rb, Some((ra, rb)))).expect_commit_success();
    assert_eq!(w.reserves(pool), r0);
    // re-appointing (here the same badge, anchor stated) leaves the owner's pause on
    w.appoint(pool, (dec!(1), dec!(1))).expect_commit_success();
    assert!(w.read::<bool>(pool, "is_paused"));
    w.swap(bot, pool, a, dec!(1)).expect_commit_failure_containing_error("Swaps are paused");
    let r = w.as_owner(pool, "set_paused", manifest_args!(false));
    let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
    assert_eq!(ev, vec![ConfigEv { fee_bps: 10, paused: false, operator_paused: false }]);
    assert!(!swap_to(&mut w, bot, pool, 1.0), "the curve is back at the market: nothing to take");
    let loss = o0 - pool_value(&mut w, pool, 1.0);
    assert!(loss <= 0.0);
    // a trade at the restored price only costs the thief
    w.swap(bot, pool, b, dec!(100)).expect_commit_success();
    let gain = value(&mut w, bot, 1.0) - t0;
    let loss = o0 - pool_value(&mut w, pool, 1.0);
    println!("A2 revoke, restore, reopen: thief gain {gain:.4}, owner loss {loss:.4}");
    assert!(gain <= 0.0);
    assert!(loss <= 0.0);
}

/// Appointing or replacing an operator while the operator's pause is OFF does not pause the pool.
/// Replacing a key whose holder had the operator pause ON is the same hole as a bare revoke (one
/// call would clear the thief's pause and reopen swaps on the curve he mispriced behind it), so it
/// turns the owner's pause on too.
#[test]
fn a2_appoint_and_replace_pause_rules() {
    let mut w = W::new();
    // ordinary appoint on a fresh pool: not paused, swaps work
    let pool = w.pool(dec!(18_000), dec!(18_000), 30);
    let r = w.appoint(pool, (dec!(1), dec!(1)));
    let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
    assert_eq!(ev, vec![ConfigEv { fee_bps: 30, paused: false, operator_paused: false }]);
    assert!(!w.read::<bool>(pool, "is_paused"));
    let (other, a, b) = (w.other, w.a, w.b);
    w.swap(other, pool, a, dec!(1)).expect_commit_success();

    // replacement (new badge, proved by the owner) while the operator's pause is off: not paused
    let (o, badge) = (w.owner, w.badge);
    let replace = |w: &mut W, pool: ComponentAddress, new: ResourceAddress| {
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, badge, dec!(1))
            .create_proof_from_account_of_amount(o.account, new, dec!(1))
            .call_method(pool, "set_operator", manifest_args!(Some(new), Some((dec!(1), dec!(1)))))
            .build();
        w.run(&[o], m)
    };
    let op2 = w.ledger.create_fungible_resource(dec!(1), 0, o.account);
    replace(&mut w, pool, op2).expect_commit_success();
    assert!(!w.read::<bool>(pool, "is_paused"));
    w.swap(other, pool, b, dec!(1)).expect_commit_success();

    // the thief's case: the bot's key, pause on, pushes, then the owner replaces it in one call
    let pool = defaults(&mut w);
    let bot = w.bot;
    let t0 = value(&mut w, bot, 1.0);
    paused_two_window_push(&mut w, pool);
    let op3 = w.ledger.create_fungible_resource(dec!(1), 0, o.account);
    let r = replace(&mut w, pool, op3);
    let ev: Vec<ConfigEv> = w.events(&r, "OwnerPoolConfigEvent");
    assert_eq!(ev, vec![ConfigEv { fee_bps: 10, paused: true, operator_paused: false }]);
    assert_eq!(w.status(pool).0, Some(op3));
    w.swap(bot, pool, a, dec!(100)).expect_commit_failure_containing_error("Swaps are paused");
    assert!(value(&mut w, bot, 1.0) - t0 <= 0.0);
}

// ============================================================================ access

/// Proofs of the wrong resource: a look-alike 1-supply 0-dp token is not the operator, the owner badge
/// is not the operator, the operator badge is not the owner; a stranger cannot clear the operator pause.
#[test]
fn a2_wrong_proofs_are_refused() {
    let mut w = W::new();
    let pool = defaults(&mut w);
    let (bot, owner) = (w.bot, w.owner);
    let fake = w.ledger.create_fungible_resource(dec!(1), 0, bot.account);
    let call = |w: &mut W, who: Actor, badge: ResourceAddress, method: &str, args: ManifestArgs| {
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(who.account, badge, dec!(1))
            .call_method(pool, method, args).deposit_entire_worktop(who.account).build();
        w.run(&[who], m)
    };
    call(&mut w, bot, fake, "rebalance", manifest_args!(dec!(0), dec!(-1), NO_GUARD)).expect_commit_failure();
    call(&mut w, bot, fake, "set_operator_paused", manifest_args!(true)).expect_commit_failure();
    let ob = w.badge;
    call(&mut w, owner, ob, "rebalance", manifest_args!(dec!(0), dec!(-1), NO_GUARD)).expect_commit_failure();
    call(&mut w, owner, ob, "operator_set_fee", manifest_args!(50u16)).expect_commit_failure();
    let op = w.op;
    for (m, a) in [
        ("withdraw_all", manifest_args!()),
        ("set_anchor", manifest_args!(dec!(1), dec!(2), NO_GUARD)),
        ("set_operator", manifest_args!(None::<ResourceAddress>, None::<(Decimal, Decimal)>)),
        ("set_paused", manifest_args!(false)),
    ] {
        call(&mut w, bot, op, m, a).expect_commit_failure();
    }
}

// ============================================================================ divisibility

/// Mixed divisibility (A: 2 places, B: 18): appointment, a priced move, a free proportional shrink,
/// swaps, and the owner's full withdrawal all work; an amount A cannot hold fails cleanly.
#[test]
fn a2_mixed_divisibility() {
    let mut w = W::with_divisibility(2, 18);
    let pool = w.pool(dec!(18_000), dec!(18_000), 30);
    w.fund_inventory(pool, dec!(2_000), dec!(2_000)).expect_commit_success();
    w.appoint(pool, (dec!(1), dec!(1))).expect_commit_success();
    w.set_limits(pool, 300, 72, dec!(19_800), dec!(19_800), dec!(9_000), dec!(9_000), 10, 100).expect_commit_success();
    w.advance(72);
    w.rebalance(pool, dec!("0.001"), dec!(0)).expect_commit_failure();
    let r = w.rebalance(pool, dec!("10.02"), dec!(0));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    println!("A2 divisibility: 10.02 A costs {}", ev[0].cost);
    let (ra, rb) = w.reserves(pool);
    // exact proportional shrink by 1/2: ra is 18010.02, rb 18000
    let r = w.rebalance(pool, -(ra / dec!(2)), -(rb / dec!(2)));
    let ev: Vec<RebalanceEv> = w.events(&r, "OwnerPoolRebalanceEvent");
    assert_eq!(ev[0].cost, dec!(0));
    let (other, a, b) = (w.other, w.a, w.b);
    w.swap(other, pool, a, dec!("1.01")).expect_commit_success();
    w.swap(other, pool, b, dec!("1.5")).expect_commit_success();
    w.as_owner(pool, "withdraw_all", manifest_args!()).expect_commit_success();
    assert_eq!(w.total(pool), (dec!(0), dec!(0)));
}
