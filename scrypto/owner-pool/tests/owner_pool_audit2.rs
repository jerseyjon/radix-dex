//! Independent audit of `OwnerPool` (second review, 22 Nov 2026). See
//! docs/review-2026-11-21/owner-pool-audit.md. Against 054bd6f the finding tests asserted the
//! weakness. After the fixes (section "Fixes applied" of the report) the M-1, L-1 and L-2 tests
//! are inverted to prove each fix; the I-1, I-2 and I-3 tests still document accepted behaviour.
//! Cold/hot split: only the vault helper changed (it picks the funded reserve vault, since the
//! component now also holds an inventory vault per token).

use scrypto_test::prelude::*;

/// `deposit`/`withdraw` reserves guard left off.
const NO_GUARD: Option<(Decimal, Decimal)> = None;

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
        self.try_pool_with_badge(who, a, ra, b, rb, fee, badge, true).expect_commit_success().new_component_addresses()[0]
    }

    /// `instantiate_with_liquidity` as `who`, presenting a proof of `badge` from his account if `prove`.
    fn try_pool_with_badge(&mut self, who: Actor, a: ResourceAddress, ra: Decimal, b: ResourceAddress, rb: Decimal, fee: u16, badge: ResourceAddress, prove: bool) -> TransactionReceipt {
        let package = self.package;
        let mut m = ManifestBuilder::new().lock_fee_from_faucet();
        if prove {
            m = m.create_proof_from_account_of_amount(who.account, badge, dec!(1));
        }
        let m = m
            .withdraw_from_account(who.account, a, ra)
            .withdraw_from_account(who.account, b, rb)
            .take_all_from_worktop(a, "a")
            .take_all_from_worktop(b, "b")
            .call_function_with_name_lookup(package, "OwnerPool", "instantiate_with_liquidity", |l| (l.bucket("a"), l.bucket("b"), fee, badge))
            .try_deposit_entire_worktop_or_abort(who.account, None)
            .build();
        self.run(who, m)
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
        self.deposit_guarded(pool, a, b, NO_GUARD)
    }

    /// Owner deposit with the reserves guard (audit M-1 fix).
    fn deposit_guarded(&mut self, pool: ComponentAddress, a: Option<(ResourceAddress, Decimal)>, b: Option<(ResourceAddress, Decimal)>, expected: Option<(Decimal, Decimal)>) -> TransactionReceipt {
        let (o, badge) = (self.owner, self.badge);
        let mut m = ManifestBuilder::new().lock_fee_from_faucet().create_proof_from_account_of_amount(o.account, badge, dec!(1));
        if let Some((r, x)) = a {
            m = m.withdraw_from_account(o.account, r, x).take_from_worktop(r, x, "a");
        }
        if let Some((r, x)) = b {
            m = m.withdraw_from_account(o.account, r, x).take_from_worktop(r, x, "b");
        }
        let m = m.call_method_with_name_lookup(pool, "deposit", |l| {
            (a.map(|_| l.bucket("a")), b.map(|_| l.bucket("b")), expected)
        }).deposit_entire_worktop(o.account).build();
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

    fn quote_rc(&mut self, pool: ComponentAddress, r: ResourceAddress, x: Decimal) -> TransactionReceipt {
        let m = ManifestBuilder::new().lock_fee_from_faucet().call_method(pool, "quote", manifest_args!(r, x)).build();
        self.ledger.execute_manifest(m, vec![])
    }

    /// `None` when quote refuses (since the L-2 fix it refuses where swap would, e.g. "Trade too small").
    fn try_quote(&mut self, pool: ComponentAddress, r: ResourceAddress, x: Decimal) -> Option<Decimal> {
        let rc = self.quote_rc(pool, r, x);
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

    /// The trading-reserve vault for `r`. Since the cold/hot split the component also holds an
    /// inventory vault per token; these tests leave inventory empty, so it is the funded one.
    fn vault(&mut self, pool: ComponentAddress, r: ResourceAddress) -> InternalAddress {
        let vaults = self.ledger.get_component_vaults(pool, r);
        let v = vaults.into_iter().find(|v| self.ledger.inspect_vault_balance(*v).unwrap_or_default() > Decimal::ZERO).expect("funded vault");
        InternalAddress::new_or_panic(v.0)
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
                            let (efee, eout) = exact(r_in, r_out, x, fee, div_in, div_out);
                            let qrc = w.quote_rc(pool, rin_res, x);
                            if !qrc.is_commit_success() {
                                // Since the L-2 fix quote refuses a zero output, as swap does.
                                qrc.expect_commit_failure_containing_error("Trade too small");
                                // refused only where the exact output is within the truncation bound of zero
                                assert!(eout <= i(r_out) / p10(36) + I512::from(1) + p10(18 - div_out as u32), "quote refused a trade worth {eout} attos");
                                w.swap(other, pool, rin_res, x).expect_commit_failure_containing_error("Trade too small");
                                refused += 1;
                                continue;
                            }
                            let q: Decimal = qrc.expect_commit_success().output(1);
                            // quote never exceeds the exact amount.
                            assert!(i(q) <= eout, "quote above exact: da={da} db={db} fee={fee} x={x} q={q}");
                            let short = eout - i(q);
                            // precision loss is bounded by r_out * 1e-36 (+1 output unit).
                            assert!(short <= i(r_out) / p10(36) + I512::from(1) + p10(18 - div_out as u32), "shortfall too big: {short}");
                            if short > worst_shortfall { worst_shortfall = short; }
                            let before = w.bal(other, rout_res);
                            assert!(q > Decimal::ZERO);
                            let rc = w.swap(other, pool, rin_res, x);
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
                while w.try_quote(pool, ta, x).is_none() && tries < 40 {
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
                if w.try_quote(pool, tb, unit(db)).is_some() && unit(db) <= have {
                    w.swap(other, pool, tb, unit(db)).expect_commit_success();
                }
            }
            let have = w.bal(other, tb);
            if have > Decimal::ZERO && w.try_quote(pool, tb, have).is_some() {
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

/// M-1, inverted after the fix. Without a guard (`None`) a taker who trades just before and just
/// after a one-sided owner deposit still profits, paid by the owner (kept as the baseline that
/// shows why the bot must pass the guard). With the guard the owner's deposit fails "Reserves
/// moved" once the front-run lands, so the taker is left holding his own trade and pays fees both
/// ways; the owner's reserves never move.
#[test]
fn audit_m1_guarded_one_sided_deposit_cannot_be_sandwiched() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 18);
    w.give(owner, other, a, dec!(2_000));

    // Baseline, no guard: the sandwich still works, so the guard is what protects the bot.
    let p = w.pool(a, dec!(10_000), b, dec!(10_000), 30);
    let a_start = w.bal(other, a);
    w.swap(other, p, a, dec!(2_000)).expect_commit_success();
    w.deposit(p, Some((a, dec!(10_000))), None).expect_commit_success();
    let got_b = w.bal(other, b);
    w.swap(other, p, b, got_b).expect_commit_success();
    let profit = w.bal(other, a) - a_start;
    println!("unguarded sandwich profit: {profit} A on a 2,000 A position");
    assert!(profit > dec!(1_500), "attacker profit {profit}");

    // Guarded: the bot computed its deposit from (10,000, 10,000) and says so.
    let g = w.pool(a, dec!(10_000), b, dec!(10_000), 30);
    let a_start = w.bal(other, a);
    let b_start = w.bal(other, b);
    w.swap(other, g, a, dec!(2_000)).expect_commit_success();
    let after_front_run = w.reserves(g);
    let owner_a = w.bal(owner, a);
    w.deposit_guarded(g, Some((a, dec!(10_000))), None, Some((dec!(10_000), dec!(10_000))))
        .expect_commit_failure_containing_error("Reserves moved");
    assert_eq!(w.bal(owner, a), owner_a, "a failed deposit moves nothing");
    assert_eq!(w.reserves(g), after_front_run);
    // The taker unwinds: he gets back less A than he put in.
    let got_b = w.bal(other, b) - b_start;
    w.swap(other, g, b, got_b).expect_commit_success();
    assert!(w.bal(other, a) < a_start, "taker must not gain when the bot's deposit is guarded");
    // The bot re-reads and retries at the right reserves: succeeds.
    let (ra, rb) = w.reserves(g);
    w.deposit_guarded(g, Some((a, dec!(10_000))), None, Some((ra, rb))).expect_commit_success();
    assert_eq!(w.reserves(g), (ra + dec!(10_000), rb));
}

/// The M-1 guard on `deposit` and `withdraw`: matching reserves pass, any mismatch (either side,
/// up or down by one smallest unit) fails and moves nothing, `None` skips the check.
/// `withdraw_all` has no guard and is unchanged.
#[test]
fn audit_m1_reserves_guard_on_deposit_and_withdraw() {
    let mut w = W::new();
    let owner = w.owner;
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let pool = w.pool(a, dec!(1000), b, dec!(500), 30);
    let tiny_a = dec!("0.000000000000000001");
    let tiny_b = dec!("0.000001");

    // deposit: matching reserves pass
    w.deposit_guarded(pool, Some((a, dec!(10))), Some((b, dec!(5))), Some((dec!(1000), dec!(500)))).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(1010), dec!(505)));
    // deposit: mismatches fail and move nothing
    let (oa, ob) = (w.bal(owner, a), w.bal(owner, b));
    for bad in [(dec!(1000), dec!(500)), (dec!(1010) + tiny_a, dec!(505)), (dec!(1010) - tiny_a, dec!(505)),
                (dec!(1010), dec!(505) + tiny_b), (dec!(1010), dec!(505) - tiny_b), (dec!(0), dec!(0))] {
        w.deposit_guarded(pool, Some((a, dec!(10))), None, Some(bad)).expect_commit_failure_containing_error("Reserves moved");
        w.deposit_guarded(pool, None, None, Some(bad)).expect_commit_failure_containing_error("Reserves moved");
    }
    assert_eq!((w.bal(owner, a), w.bal(owner, b)), (oa, ob));
    assert_eq!(w.reserves(pool), (dec!(1010), dec!(505)));
    // deposit: None passes
    w.deposit_guarded(pool, None, Some((b, dec!(5))), None).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(1010), dec!(510)));

    // withdraw: matching reserves pass
    let g = |x: Decimal, y: Decimal| -> Option<(Decimal, Decimal)> { Some((x, y)) };
    w.as_owner(pool, "withdraw", manifest_args!(dec!(10), dec!(0), g(dec!(1010), dec!(510)))).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(1000), dec!(510)));
    // withdraw: mismatches fail and move nothing
    for bad in [(dec!(1010), dec!(510)), (dec!(1000) - tiny_a, dec!(510)), (dec!(1000), dec!(510) + tiny_b)] {
        w.as_owner(pool, "withdraw", manifest_args!(dec!(1), dec!(1), Some(bad))).expect_commit_failure_containing_error("Reserves moved");
    }
    assert_eq!(w.reserves(pool), (dec!(1000), dec!(510)));
    // withdraw: None passes
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(10), NO_GUARD)).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(1000), dec!(500)));
    // The guard is checked only after auth: a stranger with matching reserves is still refused.
    let other = w.other;
    w.call_as(other, pool, "withdraw", manifest_args!(dec!(1), dec!(1), g(dec!(1000), dec!(500)))).expect_commit_failure();
    // withdraw_all takes no guard and still empties the pool.
    w.as_owner(pool, "withdraw_all", manifest_args!()).expect_commit_success();
    assert_eq!(w.reserves(pool), (dec!(0), dec!(0)));
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
        .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("x")), None::<ManifestBucket>, NO_GUARD))
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

/// L-1, inverted after the fix: instantiation refuses XRD or either pool token as the badge, and
/// requires the caller to present a proof of the badge, so a mistyped or unheld badge address
/// fails instead of handing the pool to its holders for ever. Both instantiation functions.
#[test]
fn audit_l1_badge_checked_at_instantiation() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 18);
    let b = w.token(dec!(1_000_000), 6);
    let package = w.package;
    // The pool's own tokens as the badge: refused, even though the owner holds and proves them.
    w.try_pool_with_badge(owner, a, dec!(1000), b, dec!(1000), 30, b, true).expect_commit_failure_containing_error("Bad owner badge");
    w.try_pool_with_badge(owner, a, dec!(1000), b, dec!(1000), 30, a, true).expect_commit_failure_containing_error("Bad owner badge");
    // XRD as the badge: refused.
    w.try_pool_with_badge(owner, a, dec!(1000), b, dec!(1000), 30, XRD, false).expect_commit_failure_containing_error("Bad owner badge");
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .call_function(package, "OwnerPool", "instantiate", manifest_args!(a, b, 30u16, XRD)).build();
    w.run(owner, m).expect_commit_failure_containing_error("Bad owner badge");
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .call_function(package, "OwnerPool", "instantiate", manifest_args!(a, b, 30u16, a)).build();
    w.run(owner, m).expect_commit_failure_containing_error("Bad owner badge");
    // The real badge but no proof presented: refused, for both functions, and the seed stays home.
    let a_before = w.bal(owner, a);
    let badge = w.badge;
    w.try_pool_with_badge(owner, a, dec!(1000), b, dec!(1000), 30, badge, false).expect_commit_failure_containing_error("AssertAccessRuleFailed");
    assert_eq!(w.bal(owner, a), a_before);
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .call_function(package, "OwnerPool", "instantiate", manifest_args!(a, b, 30u16, badge)).build();
    w.run(owner, m).expect_commit_failure_containing_error("AssertAccessRuleFailed");
    // A badge address the caller does not hold (a typo, or someone else's badge): refused.
    let c = w.token_with(other, dec!(100), 18, FungibleResourceRoles::default());
    let d = w.token_with(other, dec!(100), 18, FungibleResourceRoles::default());
    w.try_pool_with_badge(other, c, dec!(10), d, dec!(10), 0, badge, false).expect_commit_failure_containing_error("AssertAccessRuleFailed");
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .call_function(package, "OwnerPool", "instantiate", manifest_args!(c, d, 0u16, badge)).build();
    w.run(other, m).expect_commit_failure_containing_error("AssertAccessRuleFailed");
    // A look-alike badge that the caller does hold does not satisfy the real one.
    let fake = w.token_with(other, dec!(1), 0, FungibleResourceRoles::default());
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(other.account, fake, dec!(1))
        .call_function(package, "OwnerPool", "instantiate", manifest_args!(c, d, 0u16, badge)).build();
    w.run(other, m).expect_commit_failure_containing_error("AssertAccessRuleFailed");
    // A stranger can still make a pool owned by HIS OWN badge (I-5: list pools by address only).
    let p2 = w.try_pool_with_badge(other, c, dec!(10), d, dec!(10), 0, fake, true).expect_commit_success().new_component_addresses()[0];
    w.as_owner(p2, "withdraw_all", manifest_args!()).expect_commit_failure();
    // With the proper badge and a proof both functions work.
    let m = ManifestBuilder::new().lock_fee_from_faucet()
        .create_proof_from_account_of_amount(owner.account, badge, dec!(1))
        .call_function(package, "OwnerPool", "instantiate", manifest_args!(a, b, 30u16, badge)).build();
    w.run(owner, m).expect_commit_success();
    let pool = w.pool(a, dec!(1000), b, dec!(1000), 30);
    w.as_owner(pool, "withdraw_all", manifest_args!()).expect_commit_success();
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
        .call_method_with_name_lookup(pool, "deposit", |l| (Some(l.bucket("n")), None::<ManifestBucket>, NO_GUARD)).deposit_entire_worktop(owner.account).build();
    w.run(owner, m).expect_commit_failure();
    // owner deposits: token B in the A slot, a third token
    w.deposit(pool, Some((b, dec!(1))), None).expect_commit_failure_containing_error("Wrong token A");
    w.deposit(pool, None, Some((c, dec!(1)))).expect_commit_failure_containing_error("Wrong token B");
    // instantiate with a non-fungible resource
    let package = w.package;
    let m = ManifestBuilder::new().lock_fee_from_faucet().create_proof_from_account_of_amount(owner.account, badge, dec!(1))
        .call_function(package, "OwnerPool", "instantiate", manifest_args!(nft, a, 0u16, badge)).build();
    w.run(owner, m).expect_commit_failure();
    let m = ManifestBuilder::new().lock_fee_from_faucet().create_proof_from_account_of_amount(owner.account, badge, dec!(1))
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
    w.as_owner(pool, "withdraw", manifest_args!(dec!(-1), dec!(0), NO_GUARD)).expect_commit_failure();
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!("0.0000001"), NO_GUARD)).expect_commit_failure(); // 7 dp on a 6-dp token
    w.as_owner(pool, "withdraw", manifest_args!(dec!("1000.000000000000000001"), dec!(0), NO_GUARD)).expect_commit_failure();
    // (0, 0): two empty buckets, an event of zeros, nothing moves
    let rc = w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(0), NO_GUARD));
    let ev: Vec<LiqEv> = w.events(&rc, "OwnerPoolLiquidityEvent");
    assert_eq!(ev, vec![LiqEv { amount_a: dec!(0), amount_b: dec!(0), reserve_a: dec!(1000), reserve_b: dec!(1000) }]);
    // Emptying one side: swaps refuse, owner still gets the rest, can refill.
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1000), NO_GUARD)).expect_commit_success();
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
    w.as_owner(pool, "withdraw", manifest_args!(dec!(0), dec!(1010), NO_GUARD)).expect_commit_success();
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

/// L-2, inverted after the fix: `quote` fails wherever `swap` would. Paused: both "Swaps are
/// paused". Dust: both "Trade too small". An amount the token's divisibility cannot hold (20.5 of a
/// 0-dp token): quote refuses it, as no bucket could hold it. Otherwise quote equals what swap pays.
#[test]
fn audit_l2_quote_agrees_with_swap() {
    let mut w = W::new();
    let (owner, other) = (w.owner, w.other);
    let a = w.token(dec!(1_000_000), 0);
    let b = w.token(dec!(1_000_000), 0);
    w.give(owner, other, a, dec!(200));
    let pool = w.pool(a, dec!(1000), b, dec!(1000), 500);
    w.as_owner(pool, "set_paused", manifest_args!(true)).expect_commit_success();
    w.quote_rc(pool, a, dec!(100)).expect_commit_failure_containing_error("Swaps are paused");
    w.swap(other, pool, a, dec!(100)).expect_commit_failure_containing_error("Swaps are paused");
    w.as_owner(pool, "set_paused", manifest_args!(false)).expect_commit_success();
    w.quote_rc(pool, a, dec!(1)).expect_commit_failure_containing_error("Trade too small");
    w.swap(other, pool, a, dec!(1)).expect_commit_failure_containing_error("Trade too small");
    // more decimal places than the token allows
    w.quote_rc(pool, a, dec!("20.5")).expect_commit_failure_containing_error("Amount has more decimal places than the token allows");
    w.quote_rc(pool, a, dec!("0.000000000000000001")).expect_commit_failure_containing_error("Amount has more decimal places than the token allows");
    // negative and zero input: quote panics, as before
    w.quote_rc(pool, a, dec!(-5)).expect_commit_failure_containing_error("Nothing to swap");
    w.quote_rc(pool, a, dec!(0)).expect_commit_failure_containing_error("Nothing to swap");
    // a foreign token
    w.quote_rc(pool, XRD, dec!(1)).expect_commit_failure_containing_error("Token is not in this pool");
    // A representable, non-dust amount: quote equals the payment.
    let q: Decimal = w.read(pool, "quote", manifest_args!(a, dec!(100)));
    assert!(q > Decimal::ZERO);
    let before = w.bal(other, b);
    w.swap(other, pool, a, dec!(100)).expect_commit_success();
    assert_eq!(w.bal(other, b) - before, q);
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
