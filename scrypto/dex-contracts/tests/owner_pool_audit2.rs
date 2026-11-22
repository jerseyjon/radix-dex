//! Independent audit of `OwnerPool` (second review, 22 Nov 2026). See
//! docs/review-2026-11-21/owner-pool-audit.md. Every test here PASSES against 054bd6f: tests that
//! demonstrate a finding assert the weakness (e.g. "the attacker ends with more"), so a future fix
//! turns them red on purpose and they must then be inverted.

use scrypto_test::prelude::*;

#[derive(Clone, Copy)]
struct Actor {
    key: Secp256k1PublicKey,
    account: ComponentAddress,
}

#[derive(ScryptoSbor, Debug, PartialEq, Clone)]
struct SwapEv {
    input_resource: ResourceAddress,
    input_amount: Decimal,
    output_resource: ResourceAddress,
    output_amount: Decimal,
    fee: Decimal,
    reserve_a: Decimal,
    reserve_b: Decimal,
}

#[derive(ScryptoSbor, Debug, PartialEq, Clone)]
struct LiqEv {
    amount_a: Decimal,
    amount_b: Decimal,
    reserve_a: Decimal,
    reserve_b: Decimal,
}

struct W {
    ledger: DefaultLedgerSimulator,
    package: PackageAddress,
    owner: Actor,
    other: Actor,
    badge: ResourceAddress,
}

/// Largest supply one fungible creation may mint (2^152 attos, about 5.7e27 tokens).
fn big() -> Decimal {
    dec!("5000000000000000000000000000")
}

impl W {
    fn new() -> Self {
        let mut ledger = LedgerSimulatorBuilder::new().build();
        let (key, _, account) = ledger.new_allocated_account();
        let (okey, _, oaccount) = ledger.new_allocated_account();
        let package = ledger.compile_and_publish(this_package!());
        // Owner badge: one indivisible token.
        let badge = ledger.create_fungible_resource(dec!(1), 0, account);
        Self { ledger, package, owner: Actor { key, account }, other: Actor { key: okey, account: oaccount }, badge }
    }

    fn run(&mut self, who: Actor, m: TransactionManifestV1) -> TransactionReceipt {
        self.ledger.execute_manifest(m, vec![NonFungibleGlobalId::from_public_key(&who.key)])
    }

    fn bal(&mut self, who: Actor, r: ResourceAddress) -> Decimal {
        self.ledger.get_component_balance(who.account, r)
    }

    fn token_with(&mut self, to: Actor, supply: Decimal, div: u8, roles: FungibleResourceRoles) -> ResourceAddress {
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_fungible_resource(OwnerRole::None, true, div, roles, metadata!(), Some(supply))
            .try_deposit_entire_worktop_or_abort(to.account, None)
            .build();
        self.ledger.execute_manifest(m, vec![]).expect_commit(true).new_resource_addresses()[0]
    }

    fn token(&mut self, supply: Decimal, div: u8) -> ResourceAddress {
        let o = self.owner;
        self.token_with(o, supply, div, FungibleResourceRoles::default())
    }

    fn give(&mut self, from: Actor, to: Actor, r: ResourceAddress, amount: Decimal) {
        let m = ManifestBuilder::new().lock_fee_from_faucet().withdraw_from_account(from.account, r, amount)
            .try_deposit_entire_worktop_or_abort(to.account, None).build();
        self.run(from, m).expect_commit_success();
    }

    fn pool_with_badge(&mut self, who: Actor, a: ResourceAddress, ra: Decimal, b: ResourceAddress, rb: Decimal, fee: u16, badge: ResourceAddress) -> ComponentAddress {
        let package = self.package;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(who.account, a, ra)
            .withdraw_from_account(who.account, b, rb)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_function_with_name_lookup(package, "OwnerPool", "instantiate_with_liquidity", |l| (l.bucket("a"), l.bucket("b"), fee, badge))
            .build();
        self.run(who, m).expect_commit_success().new_component_addresses()[0]
    }

    fn pool(&mut self, a: ResourceAddress, ra: Decimal, b: ResourceAddress, rb: Decimal, fee: u16) -> ComponentAddress {
        let (o, badge) = (self.owner, self.badge);
        self.pool_with_badge(o, a, ra, b, rb, fee, badge)
    }

    /// Owner-gated call, presenting the real badge from the owner's account.
    fn as_owner(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let (o, badge) = (self.owner, self.badge);
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(o.account, badge, dec!(1))
            .call_method(pool, method, args).deposit_entire_worktop(o.account).build();
        self.run(o, m)
    }

    fn call_as(&mut self, who: Actor, pool: ComponentAddress, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, method, args).deposit_entire_worktop(who.account).build();
        self.run(who, m)
    }

    fn deposit(&mut self, pool: ComponentAddress, a: Option<(ResourceAddress, Decimal)>, b: Option<(ResourceAddress, Decimal)>) -> TransactionReceipt {
        let (o, badge) = (self.owner, self.badge);
        let mut m = ManifestBuilder::new().lock_fee_from_faucet().create_proof_from_account_of_amount(o.account, badge, dec!(1));
        if let Some((r, x)) = a {
            m = m.withdraw_from_account(o.account, r, x).take_from_worktop(r, x, "a");
        }
        if let Some((r, x)) = b {
            m = m.withdraw_from_account(o.account, r, x).take_from_worktop(r, x, "b");
        }
        let m = m.call_method_with_name_lookup(pool, "deposit", |l| {
            (a.map(|_| l.bucket("a")), b.map(|_| l.bucket("b")))
        }).build();
        self.run(o, m)
    }

    fn swap(&mut self, who: Actor, pool: ComponentAddress, input: ResourceAddress, amount: Decimal) -> TransactionReceipt {
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .withdraw_from_account(who.account, input, amount)
            .take_all_from_worktop(input, "in")
            .call_method_with_name_lookup(pool, "swap", |l| (l.bucket("in"),))
            .deposit_entire_worktop(who.account).build();
        self.run(who, m)
    }

    fn read<T: ScryptoDecode>(&mut self, pool: ComponentAddress, method: &str, args: ManifestArgs) -> T {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, method, args).build();
        self.ledger.execute_manifest(m, vec![]).expect_commit_success().output(1)
    }

    fn try_quote(&mut self, pool: ComponentAddress, r: ResourceAddress, x: Decimal) -> Option<Decimal> {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "quote", manifest_args!(r, x)).build();
        let rc = self.ledger.execute_manifest(m, vec![]);
        if rc.is_commit_success() { Some(rc.expect_commit_success().output(1)) } else { None }
    }

    fn reserves(&mut self, pool: ComponentAddress) -> (Decimal, Decimal) {
        self.read(pool, "reserves", manifest_args!())
    }

    fn events<T: ScryptoDecode>(&self, r: &TransactionReceipt, name: &str) -> Vec<T> {
        r.expect_commit_success().application_events.iter()
            .filter(|(id, _)| self.ledger.event_name(id) == name)
            .map(|(_, d)| scrypto_decode::<T>(d).unwrap())
            .collect()
    }

    fn vault(&mut self, pool: ComponentAddress, r: ResourceAddress) -> InternalAddress {
        InternalAddress::new_or_panic(self.ledger.get_component_vaults(pool, r)[0].0)
    }
}

fn unit(div: u8) -> Decimal {
    Decimal::from_attos(I192::from(10u64.pow(18 - div as u32)))
}

fn i(d: Decimal) -> I512 {
    I512::from(d.attos())
}

fn p10(n: u32) -> I512 {
    let mut x = I512::from(1);
    for _ in 0..n { x = x * I512::from(10); }
    x
}

/// Exact (infinite-precision) fee and output, in attos, using the blueprint's documented rule:
/// fee = ceil(input * bps / 10000) to the input's divisibility; out = floor(r_out * eff / (r_in + eff))
/// to the output's divisibility.
fn exact(r_in: Decimal, r_out: Decimal, input: Decimal, bps: u16, div_in: u8, div_out: u8) -> (I512, I512) {
    let m_in = p10(18 - div_in as u32);
    let m_out = p10(18 - div_out as u32);
    let q = i(input) * I512::from(bps);
    let den = I512::from(10_000u32) * m_in;
    let fee = ((q + den - I512::from(1)) / den) * m_in;
    let eff = i(input) - fee;
    if eff <= I512::from(0) {
        return (fee, I512::from(0));
    }
    let raw = i(r_out) * eff / (i(r_in) + eff);
    (fee, raw - raw % m_out)
}

// ---------------------------------------------------------------------------------------------
// Rounding, quote == swap, k never falls: divisibility 0..18 on either side, tiny/huge/extreme.
// ---------------------------------------------------------------------------------------------

fn matrix(divs_a: &[u8], divs_b: &[u8]) -> (usize, usize) {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let mut swaps = 0usize;
    let mut refused = 0usize;
    let mut worst_shortfall = I512::from(0);
    for &da in divs_a {
        for &db in divs_b {
            let ta = w.token(big(), da);
            let tb = w.token(big(), db);
            w.give(owner, other, ta, dec!("4000000000000000000000000000"));
            w.give(owner, other, tb, dec!("4000000000000000000000000000"));
            let huge = dec!("100000000000000000000000000"); // 1e26
            let configs = [
                (unit(da) * dec!(3), unit(db) * dec!(5)), // tiny
                (dec!(1000), dec!(37)),                  // normal
                (huge, huge),                              // huge
                (unit(da), huge),                          // extreme: A nearly worthless
                (huge, unit(db)),                          // extreme: B nearly worthless
            ];
            for &fee in &[0u16, 30, 500] {
                for &(ra, rb) in &configs {
                    let pool = w.pool(ta, ra, tb, rb, fee);
                    for a_in in [true, false] {
                        let (rin_res, rout_res, div_in, div_out) = if a_in { (ta, tb, da, db) } else { (tb, ta, db, da) };
                        let (r0a, r0b) = w.reserves(pool);
                        let r_in = if a_in { r0a } else { r0b };
                        let u = unit(div_in);
                        let mut amounts = vec![u, u * dec!(7), r_in, r_in * dec!(3)];
                        let thousandth = (r_in / dec!(1000)).checked_round(div_in, RoundingMode::ToZero).unwrap();
                        if thousandth > Decimal::ZERO { amounts.push(thousandth); }
                        for x in amounts {
                            let (ra_, rb_) = w.reserves(pool);
                            let (r_in, r_out) = if a_in { (ra_, rb_) } else { (rb_, ra_) };
                            let q = w.try_quote(pool, rin_res, x).expect("quote must not panic on a funded pool");
                            let (efee, eout) = exact(r_in, r_out, x, fee, div_in, div_out);
                            // quote never exceeds the exact amount.
                            assert!(i(q) <= eout, "quote above exact: da={da} db={db} fee={fee} x={x} q={q}");
                            let short = eout - i(q);
                            // precision loss is bounded by r_out * 1e-36 (+1 output unit).
                            assert!(short <= i(r_out) / p10(36) + I512::from(1) + p10(18 - div_out as u32), "shortfall too big: {short}");
                            if short > worst_shortfall { worst_shortfall = short; }
                            let before = w.bal(other, rout_res);
                            let rc = w.swap(other, pool, rin_res, x);
                            if q == Decimal::ZERO {
                                rc.expect_commit_failure_containing_error("Trade too small");
                                refused += 1;
                                continue;
                            }
                            let ev: Vec<SwapEv> = w.events(&rc, "OwnerPoolSwapEvent");
                            let got = w.bal(other, rout_res) - before;
                            assert_eq!(got, q, "swap paid differently from quote: da={da} db={db} fee={fee} x={x}");
                            let (na, nb) = w.reserves(pool);
                            let (n_in, n_out) = if a_in { (na, nb) } else { (nb, na) };
                            assert_eq!(n_in, r_in + x);
                            assert_eq!(n_out, r_out - got);
                            assert!(n_out > Decimal::ZERO, "a swap emptied the output side");
                            // k never falls (exact integer arithmetic on attos).
                            assert!(i(n_in) * i(n_out) >= i(r_in) * i(r_out), "k fell");
                            assert_eq!(ev.len(), 1);
                            assert_eq!(ev[0].input_amount, x);
                            assert_eq!(ev[0].output_amount, got);
                            assert_eq!(i(ev[0].fee), efee);
                            assert_eq!((ev[0].reserve_a, ev[0].reserve_b), (na, nb));
                            assert_eq!(ev[0].output_resource, rout_res);
                            swaps += 1;
                        }
                    }
                }
            }
        }
    }
    println!("matrix: {swaps} swaps, {refused} refused as too small, worst shortfall vs exact {worst_shortfall} attos");
    (swaps, refused)
}

#[test]
fn audit_matrix_low_divisibility() {
    let (s, _) = matrix(&[0, 1, 2], &[0, 1, 18]);
    assert!(s > 100);
}

#[test]
fn audit_matrix_high_divisibility() {
    let (s, _) = matrix(&[6, 17, 18], &[0, 6, 17, 18]);
    assert!(s > 100);
}

/// Precision loss at extreme ratios: `share` is truncated to 36 decimals before multiplying, so
/// when share is ~1e-33 only 3 significant digits survive. Errors favour the pool (takers are
/// under-paid), never the taker. Info finding I-3.
#[test]
fn audit_extreme_ratio_precision_underpays_taker_only() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(big(), 18);
    let b = w.token(big(), 18);
    w.give(owner, other, a, dec!(1));
    let r = dec!("4000000000000000000000000000");
    let pool = w.pool(a, r, b, r, 0);
    let x = dec!("0.000004567891234567");
    let q: Decimal = w.read(pool, "quote", manifest_args!(a, x));
    let (_, ex) = exact(r, r, x, 0, 18, 18);
    assert!(i(q) < ex);
    // under-paid by more than 0.01% of the trade, all of it kept by the pool
    assert!((ex - i(q)) * I512::from(10_000) > ex, "q={q} exact={ex}");
    let before = w.bal(other, b);
    w.swap(other, pool, a, x).expect_commit_success();
    assert_eq!(w.bal(other, b) - before, q);
}

// ---------------------------------------------------------------------------------------------
// Dust and round trips: no sequence of public swaps ends with the taker ahead.
// ---------------------------------------------------------------------------------------------

#[test]
fn audit_dust_round_trips_never_profit() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    for (da, db) in [(18u8, 0u8), (0, 18), (18, 6), (2, 2), (0, 0), (18, 18)] {
        for &(ra, rb) in &[(dec!(1000), dec!(1000)), (dec!(3), dec!(1_000_000)), (dec!(1_000_000), dec!(3))] {
            let ta = w.token(dec!(10_000_000), da);
            let tb = w.token(dec!(10_000_000), db);
            w.give(owner, other, ta, dec!(1_000_000));
            let pool = w.pool(ta, ra, tb, rb, 0); // fee 0: the case most favourable to the taker
            let (a0, b0) = (w.bal(other, ta), w.bal(other, tb));
            let (k0a, k0b) = w.reserves(pool);
            // 40 dust swaps A->B, each the smallest input that yields any output, then sell all B back.
            for _ in 0..40 {
                let mut x = unit(da);
                let mut tries = 0;
                while w.try_quote(pool, ta, x).unwrap() == Decimal::ZERO && tries < 40 {
                    x = x * dec!(2);
                    tries += 1;
                }
                if tries == 40 || x > w.bal(other, ta) { break; }
                w.swap(other, pool, ta, x).expect_commit_success();
            }
            // also dust swaps B->A in between
            for _ in 0..10 {
                let have = w.bal(other, tb);
                if have == Decimal::ZERO { break; }
                if w.try_quote(pool, tb, unit(db)).unwrap() > Decimal::ZERO && unit(db) <= have {
                    w.swap(other, pool, tb, unit(db)).expect_commit_success();
                }
            }
            let have = w.bal(other, tb);
            if have > Decimal::ZERO && w.try_quote(pool, tb, have).unwrap() > Decimal::ZERO {
                w.swap(other, pool, tb, have).expect_commit_success();
            }
            let (a1, b1) = (w.bal(other, ta), w.bal(other, tb));
            let (k1a, k1b) = w.reserves(pool);
            assert!(i(k1a) * i(k1b) >= i(k0a) * i(k0b));
            // If the taker holds at least as much B as at the start, he must hold no more A.
            if b1 >= b0 {
                assert!(a1 <= a0, "taker gained: da={da} db={db} a0={a0} a1={a1}");
            }
            assert!(!(a1 >= a0 && b1 >= b0 && (a1 > a0 || b1 > b0)), "taker strictly ahead");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// M-1: owner deposits/withdrawals carry no guard on the pool state they were computed against.
// ---------------------------------------------------------------------------------------------

/// A taker who trades just before and just after a one-sided owner deposit ends with more than he
/// started with, paid by the owner. A proportional deposit gives him nothing. The fix (an optional
/// expected-reserves guard on deposit/withdraw) would make the owner's transaction fail instead.
#[test]
fn audit_m1_one_sided_deposit_can_be_sandwiched() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 18);
    w.give(owner, other, a, dec!(2_000));

    // Baseline: the bot lowers A's price from 1 to 0.5 B by adding 10,000 A alone.
    let p0 = w.pool(a, dec!(10_000), b, dec!(10_000), 30);
    w.deposit(p0, Some((a, dec!(10_000))), None).expect_commit_success();
    assert_eq!(w.reserves(p0), (dec!(20_000), dec!(10_000)));

    // Attack: sell A before the deposit lands, buy A back after.
    let p = w.pool(a, dec!(10_000), b, dec!(10_000), 30);
    let a_start = w.bal(other, a);
    w.swap(other, p, a, dec!(2_000)).expect_commit_success();
    w.deposit(p, Some((a, dec!(10_000))), None).expect_commit_success();
    let got_b = w.bal(other, b);
    w.swap(other, p, b, got_b).expect_commit_success();
    let a_end = w.bal(other, a);
    let profit = a_end - a_start;
    println!("sandwich profit: {profit} A on a 2,000 A position");
    assert!(profit > dec!(1_500), "attacker profit {profit}");
    let (ra, rb) = w.reserves(p);
    assert_eq!(rb, dec!(10_000));
    assert!(ra < dec!(20_000) - dec!(1_500), "owner ends with {ra} A instead of 20,000");

    // Same attack around a proportional deposit: the taker loses (fees).
    let p2 = w.pool(a, dec!(10_000), b, dec!(10_000), 30);
    let a_start = w.bal(other, a);
    w.swap(other, p2, a, dec!(2_000)).expect_commit_success();
    w.deposit(p2, Some((a, dec!(10_000))), Some((b, dec!(10_000)))).expect_commit_success();
    let got_b = w.bal(other, b);
    w.swap(other, p2, b, got_b).expect_commit_success();
    assert!(w.bal(other, a) < a_start);
}

// ---------------------------------------------------------------------------------------------
// Auth.
// ---------------------------------------------------------------------------------------------

#[test]
fn audit_auth_lookalike_empty_and_no_proof() {
    let mut w = W::new();
    let other = w.other;
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let pool = w.pool(a, dec!(1000), b, dec!(1000), 30);
    // A look-alike badge: same supply, same divisibility, held by the attacker.
    let fake = w.token_with(other, dec!(1), 0, FungibleResourceRoles::default());
    let args_for = |m: &str| -> ManifestArgs {
        match m {
            "withdraw_all" => manifest_args!(),
            "withdraw" => manifest_args!(dec!(1), dec!(1)),
            "set_fee" => manifest_args!(0u16),
            _ => manifest_args!(true),
        }
    };
    for method in ["withdraw_all", "withdraw", "set_fee", "set_paused"] {
        // no proof
        w.call_as(other, pool, method, args_for(method)).expect_commit_failure();
        // look-alike proof
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .create_proof_from_account_of_amount(other.account, fake, dec!(1))
            .call_method(pool, method, args_for(method)).deposit_entire_worktop(other.account).build();
        w.run(other, m).expect_commit_failure();
        // an empty bucket of the REAL badge, turned into a proof
        let badge = w.badge;
        let m = ManifestBuilder::new().lock_fee_from_faucet()
            .take_from_worktop(badge, dec!(0), "e")
            .create_proof_from_bucket_of_all("e", "p")
            .push_to_auth_zone("p")
            .call_method(pool, method, args_for(method))
            .return_to_worktop("e")
            .deposit_entire_worktop(other.account).build();
        w.run(other, m).expect_commit_failure_containing_error("EmptyProofNotAllowed");
    }
    // deposit with a look-alike proof
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(other.account, fake, dec!(1))
        .take_from_worktop(a, dec!(0), "x")
        .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("x")), None::<ManifestBucket>))
        .deposit_entire_worktop(other.account).build();
    w.run(other, m).expect_commit_failure();
    assert_eq!(w.reserves(pool), (dec!(1000), dec!(1000)));
    // Private helpers are not callable.
    w.call_as(other, pool, "compute_swap", manifest_args!(a, dec!(1))).expect_commit_failure();
    w.call_as(other, pool, "liquidity_event", manifest_args!(dec!(1), dec!(1))).expect_commit_failure();
    let package = w.package;
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .call_function(package, "OwnerPool", "build", manifest_args!(a, b, 0u16, w.badge, None::<(ManifestBucket, ManifestBucket)>)).build();
    w.run(other, m).expect_commit_failure();
}

/// `require(badge)` matches any proof of the resource, whatever its amount: with a DIVISIBLE
/// badge, a dust fraction is full ownership. (C-1 custody note.)
#[test]
fn audit_auth_divisible_badge_fraction_is_full_owner() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let soft_badge = w.token(dec!(1), 18);
    let pool = w.pool_with_badge(owner, a, dec!(1000), b, dec!(1000), 30, soft_badge);
    w.give(owner, other, soft_badge, dec!("0.000000000000000001"));
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(other.account, soft_badge, dec!("0.000000000000000001"))
        .call_method(pool, "withdraw_all", manifest_args!()).deposit_entire_worktop(other.account).build();
    w.run(other, m).expect_commit_success();
    assert_eq!(w.bal(other, a), dec!(1000));
}

/// L-1: instantiation accepts any resource as the owner badge and does not check that the caller
/// holds it. Naming a widely held resource (here, the pool's own token B) by mistake hands the
/// pool to every holder, irreversibly.
#[test]
fn audit_l1_wrong_badge_at_instantiation_is_irreversible() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    w.give(owner, other, b, dec!(1));
    let pool = w.pool_with_badge(owner, a, dec!(1000), b, dec!(1000), 30, b);
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(other.account, b, dec!(1))
        .call_method(pool, "withdraw_all", manifest_args!()).deposit_entire_worktop(other.account).build();
    w.run(other, m).expect_commit_success();
    assert_eq!(w.bal(other, a), dec!(1000));
    // And a stranger can create an "owner pool" naming the real owner's badge: harmless to the
    // owner (he can withdraw what the stranger put in), but such components are not his to vouch for.
    let c = w.token_with(other, dec!(100), 18, FungibleResourceRoles::default());
    let d = w.token_with(other, dec!(100), 18, FungibleResourceRoles::default());
    let badge = w.badge;
    let p2 = w.pool_with_badge(other, c, dec!(10), d, dec!(10), 0, badge);
    w.call_as(other, p2, "withdraw_all", manifest_args!()).expect_commit_failure();
    w.as_owner(p2, "withdraw_all", manifest_args!()).expect_commit_success();
}

/// The owner role is fixed: no one, not even the owner, can change it, add roles, or attach royalties.
/// Locked metadata cannot be changed; `name` can, only by the owner.
#[test]
fn audit_roles_metadata_royalty_are_fixed() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let pool = w.pool(a, dec!(1000), b, dec!(1000), 30);
    let badge = w.badge;
    let with_badge = |m: ManifestBuilder| m.lock_fee_from_faucet().create_proof_from_account_of_amount(owner.account, badge, dec!(1));
    w.run(owner, with_badge(ManifestBuilder::new()).set_owner_role(pool, rule!(allow_all)).build()).expect_commit_failure();
    w.run(owner, with_badge(ManifestBuilder::new()).lock_owner_role(pool).build()).expect_commit_failure();
    w.run(owner, with_badge(ManifestBuilder::new()).set_role(pool, ModuleId::Main, RoleKey::new("owner"), rule!(allow_all)).build()).expect_commit_failure();
    w.run(owner, with_badge(ManifestBuilder::new()).set_role(pool, ModuleId::Main, RoleKey::new("anything"), rule!(allow_all)).build()).expect_commit_failure();
    w.run(owner, with_badge(ManifestBuilder::new()).set_component_royalty(pool, "swap", RoyaltyAmount::Xrd(dec!(1))).build()).expect_commit_failure();
    w.run(owner, with_badge(ManifestBuilder::new()).set_metadata(pool, "resource_a", GlobalAddress::from(b)).build()).expect_commit_failure();
    w.run(other, ManifestBuilder::new().lock_fee_from_faucet().set_metadata(pool, "name", "scam pool").build()).expect_commit_failure();
    w.run(owner, with_badge(ManifestBuilder::new()).set_metadata(pool, "name", "renamed").build()).expect_commit_success();
    // swapping still works and still pays no royalty
    w.give(owner, other, a, dec!(10));
    w.swap(other, pool, a, dec!(10)).expect_commit_success();
}

// ---------------------------------------------------------------------------------------------
// Bucket handling.
// ---------------------------------------------------------------------------------------------

#[test]
fn audit_wrong_empty_and_non_fungible_buckets() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let c = w.token(dec!(1_000_000), 18);
    let nft = w.ledger.create_non_fungible_resource(owner.account);
    w.give(owner, other, c, dec!(10));
    let pool = w.pool(a, dec!(1000), b, dec!(1000), 30);
    // wrong fungible
    w.swap(other, pool, c, dec!(1)).expect_commit_failure_containing_error("Token is not in this pool");
    // empty bucket of a pool token
    let m = ManifestBuilder::new().lock_fee_from_faucet().take_from_worktop(a, dec!(0), "e")
        .call_method_with_name_lookup(pool, "swap", |l| (l.bucket("e"),)).deposit_entire_worktop(other.account).build();
    w.run(other, m).expect_commit_failure_containing_error("Nothing to swap");
    // non-fungible bucket into a FungibleBucket parameter: rejected by the engine's schema check
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(owner.account, nft, [NonFungibleLocalId::integer(1)])
        .take_all_from_worktop(nft, "n")
        .call_method_with_name_lookup(pool, "swap", |l| (l.bucket("n"),)).deposit_entire_worktop(owner.account).build();
    w.run(owner, m).expect_commit_failure();
    let badge = w.badge;
    let m = ManifestBuilder::new().lock_fee_from_faucet().create_proof_from_account_of_amount(owner.account, badge, dec!(1))
        .withdraw_non_fungibles_from_account(owner.account, nft, [NonFungibleLocalId::integer(1)])
        .take_all_from_worktop(nft, "n")
        .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("n")), None::<ManifestBucket>)).deposit_entire_worktop(owner.account).build();
    w.run(owner, m).expect_commit_failure();
    // owner deposits: token B in the A slot, a third token
    w.deposit(pool, Some((b, dec!(1))), None).expect_commit_failure_containing_error("Wrong token A");
    w.deposit(pool, None, Some((c, dec!(1)))).expect_commit_failure_containing_error("Wrong token B");
    // instantiate with a non-fungible resource
    let package = w.package;
    let m = ManifestBuilder::new().lock_fee_from_faucet().call_function(package, "OwnerPool", "instantiate", manifest_args!(nft, a, 0u16, badge)).build();
    w.run(owner, m).expect_commit_failure();
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(owner.account, nft, [NonFungibleLocalId::integer(2)])
        .withdraw_from_account(owner.account, a, dec!(1))
        .take_all_from_worktop(nft, "n").take_all_from_worktop(a, "a")
        .call_function_with_name_lookup(package, "OwnerPool", "instantiate_with_liquidity", |l| (l.bucket("n"), l.bucket("a"), 0u16, badge)).build();
    w.run(owner, m).expect_commit_failure();
    // same token twice
    let m = ManifestBuilder::new().lock_fee_from_faucet().call_function(package, "OwnerPool", "instantiate", manifest_args!(a, a, 0u16, badge)).build();
    w.run(owner, m).expect_commit_failure_containing_error("The two tokens must differ");
    assert_eq!(w.reserves(pool), (dec!(1000), dec!(1000)));
}

// ---------------------------------------------------------------------------------------------
// Owner funds: withdraw edge cases, freezes, recall.
// ---------------------------------------------------------------------------------------------

#[test]
fn audit_withdraw_edge_cases() {
    let mut w = W::new();
    let other = w.other;
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let pool = w.pool(a, dec!(1000), b, dec!(1000), 30);
    w.as_owner(pool, "withdraw", manifest_args!(dec!(-1), dec!(0))).expect_commit_failure();
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!("0.0000001"))).expect_commit_failure(); // 7 dp on a 6-dp token
    w.as_owner(pool, "withdraw", manifest_args!(dec!("1000.000000000000000001"), dec!(0))).expect_commit_failure();
    // (0, 0): two empty buckets, an event of zeros, nothing moves
    let rc = w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(0)));
    let ev: Vec<LiqEv> = w.events(&rc, "OwnerPoolLiquidityEvent");
    assert_eq!(ev, vec![LiqEv { amount_a: dec!(0), amount_b: dec!(0), reserve_a: dec!(1000), reserve_b: dec!(1000) }]);
    // Emptying one side: swaps refuse, owner still gets the rest, can refill.
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1000))).expect_commit_success();
    w.give(w.owner, other, a, dec!(1));
    w.swap(other, pool, a, dec!(1)).expect_commit_failure_containing_error("Pool is empty");
    let q = {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "quote", manifest_args!(a, dec!(1))).build();
        w.ledger.execute_manifest(m, vec![])
    };
    q.expect_commit_failure_containing_error("Pool is empty");
    w.as_owner(pool, "withdraw_all", manifest_args!()).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(0), dec!(0)));
    w.deposit(pool, Some((a, dec!(5))), Some((b, dec!(5)))).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(5), dec!(5)));
}

/// A token frozen for BOTH deposit and withdraw in the pool's vault. The owner keeps the other
/// token; a deposit must pass `None` for the frozen side, not an empty bucket (the engine refuses
/// any put into a deposit-frozen vault, even of zero).
#[test]
fn audit_frozen_both_ways() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let roles = FungibleResourceRoles {
        freeze_roles: freeze_roles! { freezer => rule!(allow_all); freezer_updater => rule!(deny_all); },
        ..Default::default()
    };
    let f = w.token_with(owner, dec!(1_000_000), 18, roles);
    let b = w.token(dec!(1_000_000), 6);
    w.give(owner, other, b, dec!(10));
    let pool = w.pool(f, dec!(1000), b, dec!(1000), 30);
    let v = w.vault(pool, f);
    w.ledger.execute_manifest(ManifestBuilder::new().lock_fee_from_faucet().freeze_withdraw(v).freeze_deposit(v).build(), vec![]).expect_commit_success();
    w.swap(other, pool, b, dec!(1)).expect_commit_failure();
    w.deposit(pool, None, Some((b, dec!(10)))).expect_commit_success();
    w.deposit(pool, Some((f, dec!(0))), None).expect_commit_failure();
    w.as_owner(pool, "withdraw_all", manifest_args!()).expect_commit_failure();
    let before = w.bal(owner, b);
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1010))).expect_commit_success();
    assert_eq!(w.bal(owner, b) - before, dec!(1010));
}

/// I-1: a token whose issuer can recall from the pool's vault lets the issuer take the OTHER
/// token too: recall most of A, then sell it straight back in. Pause does not engage by itself.
#[test]
fn audit_recallable_token_lets_issuer_drain_other_side() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let roles = FungibleResourceRoles {
        recall_roles: recall_roles! { recaller => rule!(allow_all); recaller_updater => rule!(deny_all); },
        ..Default::default()
    };
    let rec = w.token_with(owner, dec!(1_000_000), 18, roles);
    let b = w.token(dec!(1_000_000), 6);
    let pool = w.pool(rec, dec!(1000), b, dec!(1000), 30);
    let v = w.vault(pool, rec);
    let m = ManifestBuilder::new().lock_fee_from_faucet().recall(v, dec!(990))
        .take_all_from_worktop(rec, "r")
        .call_method_with_name_lookup(pool, "swap", |l| (l.bucket("r"),))
        .deposit_entire_worktop(other.account).build();
    w.run(other, m).expect_commit_success();
    let got = w.bal(other, b);
    assert!(got > dec!(980), "issuer took {got} B for free");
    assert_eq!(w.reserves(pool).0, dec!(1000));
}

// ---------------------------------------------------------------------------------------------
// Arithmetic thresholds.
// ---------------------------------------------------------------------------------------------

/// The fee is computed as input * fee_bps / 10000 in PreciseDecimal (max ~5.79e40). At 500 bps,
/// inputs above ~1.158e38 overflow and the swap panics; quote panics too. Unreachable in practice
/// (one mint is capped at 2^152 attos, ~5.7e27 tokens), so Info only.
#[test]
fn audit_fee_product_overflow_threshold() {
    let pd = |s: &str| PreciseDecimal::from(Decimal::from_str(s).unwrap());
    let fee = PreciseDecimal::from(500u16);
    assert!(pd("115000000000000000000000000000000000000").checked_mul(fee).is_some());
    assert!(pd("116000000000000000000000000000000000000").checked_mul(fee).is_none());
    // the rest of compute_swap is safe up to Decimal::MAX on both reserves
    let max = PreciseDecimal::from(Decimal::MAX);
    let eff = max;
    let share = eff.checked_div(max.checked_add(eff).unwrap()).unwrap();
    assert!(max.checked_mul(share).is_some());
    // and the mint cap really is far below the threshold
    let mut cap = I192::from(1);
    for _ in 0..152 { cap = cap * I192::from(2); }
    assert!(Decimal::from_attos(cap) < dec!("10000000000000000000000000000"));
}

// ---------------------------------------------------------------------------------------------
// What a solver sees: quote vs swap.
// ---------------------------------------------------------------------------------------------

/// L-2: `quote` ignores `paused` and returns 0 where `swap` panics; a solver that trusts quote
/// alone builds transactions that fail. Never a loss, only failed transactions.
#[test]
fn audit_l2_quote_vs_swap_when_paused_or_dust() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 0);
    let b = w.token(dec!(1_000_000), 0);
    w.give(owner, other, a, dec!(100));
    let pool = w.pool(a, dec!(1000), b, dec!(1000), 500);
    w.as_owner(pool, "set_paused", manifest_args!(true)).expect_commit_success();
    let q: Decimal = w.read(pool, "quote", manifest_args!(a, dec!(100)));
    assert!(q > Decimal::ZERO);
    w.swap(other, pool, a, dec!(100)).expect_commit_failure_containing_error("Swaps are paused");
    w.as_owner(pool, "set_paused", manifest_args!(false)).expect_commit_success();
    let q: Decimal = w.read(pool, "quote", manifest_args!(a, dec!(1)));
    assert_eq!(q, Decimal::ZERO);
    w.swap(other, pool, a, dec!(1)).expect_commit_failure_containing_error("Trade too small");
    // quote accepts amounts a bucket could never hold (here 20.5 of a 0-dp token)
    let q: Decimal = w.read(pool, "quote", manifest_args!(a, dec!("20.5")));
    assert!(q > Decimal::ZERO);
    // negative input: quote panics
    let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "quote", manifest_args!(a, dec!(-5))).build();
    w.ledger.execute_manifest(m, vec![]).expect_commit_failure_containing_error("Nothing to swap");
}

/// Fee changes are instant. A taker who states a minimum is protected; one who calls bare `swap`
/// pays whatever fee is current when his transaction lands.
#[test]
fn audit_instant_fee_change_vs_minimum() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 18);
    w.give(owner, other, a, dec!(100));
    let pool = w.pool(a, dec!(10_000), b, dec!(10_000), 0);
    let q: Decimal = w.read(pool, "quote", manifest_args!(a, dec!(100)));
    w.as_owner(pool, "set_fee", manifest_args!(500u16)).expect_commit_success();
    let m = ManifestBuilder::new().lock_fee_from_faucet().withdraw_from_account(other.account, a, dec!(100))
        .take_all_from_worktop(a, "in")
        .call_method_with_name_lookup(pool, "swap_with_minimum", |l| (l.bucket("in"), q))
        .deposit_entire_worktop(other.account).build();
    w.run(other, m).expect_commit_failure_containing_error("Less than the minimum");
    let m = ManifestBuilder::new().lock_fee_from_faucet().withdraw_from_account(other.account, a, dec!(100))
        .take_all_from_worktop(a, "in")
        .call_method_with_name_lookup(pool, "swap", |l| (l.bucket("in"),))
        .assert_worktop_contains(b, q)
        .deposit_entire_worktop(other.account).build();
    w.run(other, m).expect_commit_failure();
    w.swap(other, pool, a, dec!(100)).expect_commit_success();
    assert!(w.bal(other, b) < q * dec!("0.96"));
}
