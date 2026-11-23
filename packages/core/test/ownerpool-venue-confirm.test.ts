// The owner's rules of 23 Nov 2026 (packages/core/src/ownerpool-bot.ts, docs/owner-pool-bot.md):
// (1) single-venue caution: with only ONE venue confirmed live the bot trades with fee + 50 bps (still
// clamped) and half the sizes (per-tick cap and rolling-window share), alerting once per episode;
// (2) two-tick confirmation: a venue counts as dropped only after failing 2 ticks in a row (the first
// failed tick prices from the others but does not rebalance), and as back only after 2 good ticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertLimiter, Decimal, NETWORKS, OWNER_POOL_BOT_DEFAULTS as D, aggregateVenues, decideRebalance, feeDecision, feeTargetDetail, singleVenueCaution,
  spendableAllowance, venueConfirm, venueGate, venueSetHold, windowSpendRoom,
  type OwnerPoolState, type SingleVenueState, type VenueConfirmState, type VenueHoldState, type VenueQuote,
} from '../src/index.ts';

const NOW = Date.parse('2026-11-23T09:00:00Z');
const MIN = 60_000;
const HOLD = D.venueHoldSec * 1000;
const N = D.confirmTicks;

// ------------------------------------------------------------------ defaults

test('defaults: confirm 2 ticks, single venue +50 bps and half the sizes', () => {
  assert.equal(D.confirmTicks, 2);
  assert.equal(D.singleVenueFeeAddBps, 50);
  assert.equal(D.singleVenueSizeFactor, 0.5);
});

// ------------------------------------------------------------------ single-venue caution: fee

test('caution fee: +50 bps on top of the rule, then clamped to the operator range', () => {
  const cfg = { baseFeeBps: 100, volMultiplier: 2, behindFeeBps: 10, disagreeFeeFactor: 0.5 };
  // Mainnet-like range 50-200: 100 + 2 x 5 = 110 -> 160 with the caution.
  assert.equal(feeTargetDetail({ volBps: 5, behind: false, minFeeBps: 50, maxFeeBps: 200, cfg }).feeBps, 110);
  const c = feeTargetDetail({ volBps: 5, behind: false, singleVenueAddBps: 50, minFeeBps: 50, maxFeeBps: 200, cfg });
  assert.deepEqual(c, { feeBps: 160, rawBps: 160, clamped: null });
  // Added to behind too: 100 + 10 + 10 + 50.
  assert.equal(feeTargetDetail({ volBps: 5, behind: true, singleVenueAddBps: 50, minFeeBps: 50, maxFeeBps: 200, cfg }).feeBps, 170);
  // Clamped at the top: Stokenet's 10-100 range leaves 100 (the rule says 160).
  assert.deepEqual(feeTargetDetail({ volBps: 5, behind: false, singleVenueAddBps: 50, minFeeBps: 10, maxFeeBps: 100, cfg }), { feeBps: 100, rawBps: 160, clamped: 'max' });
  // Base 30 on Stokenet: 30 -> 80, inside the range.
  assert.equal(feeTargetDetail({ volBps: 0, behind: false, singleVenueAddBps: 50, minFeeBps: 10, maxFeeBps: 100, cfg: { ...cfg, baseFeeBps: 30 } }).feeBps, 80);
  // Configurable: 0 adds nothing.
  assert.equal(feeTargetDetail({ volBps: 5, behind: false, singleVenueAddBps: 0, minFeeBps: 50, maxFeeBps: 200, cfg }).feeBps, 110);
});

// ------------------------------------------------------------------ single-venue caution: sizes

const XRD = NETWORKS.stokenet.xrd;
const TEUR = 'resource_tdx_2_1tknxk37t6tvqce4ce0jqv7ymydjfgjej4mw0wkdzep4wjfz8trvpj3';
const EPOCH = 25_000;
function pool(allowance = '0.03'): OwnerPoolState {
  return {
    address: 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk', packageAddress: 'package_tdx_2_1x', resourceA: XRD, resourceB: TEUR,
    divisibilityA: 18, divisibilityB: 6, reserveA: '20000', reserveB: '16', feeBps: 30, paused: false,
    split: {
      ownerPaused: false, operatorPaused: false, inventoryA: '1000', inventoryB: '0.8', ownerBadge: 'resource_owner', operator: 'resource_op',
      limits: { moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '22000', maxReserveB: '17.6', minReserveA: '10000', minReserveB: '8', minFeeBps: 10, maxFeeBps: 100 },
      allowance, allowanceEpoch: EPOCH, anchor: ['1250', '1'],
    },
  };
}
const rcfg = { deadBandBps: null, spendFraction: D.spendFraction, reserveFraction: D.reserveFraction, minMoveBps: D.minMoveBps, side: 'remove' as const };

test('caution size: the per-tick spend cap is halved (a big gap moves half as far)', () => {
  // Allowance 0.004: normal cap min(0.002, 0.004 - 0.003) = 0.001; caution 0.0005.
  assert.equal(spendableAllowance('0.004', 300, D).toFixed(), '0.001');
  const normal = decideRebalance(pool('0.004'), EPOCH, 0.0008 * 1.02, rcfg);
  const half = decideRebalance(pool('0.004'), EPOCH, 0.0008 * 1.02, { ...rcfg, sizeFactor: 0.5 });
  assert.ok(normal.action === 'rebalance' && half.action === 'rebalance');
  assert.equal(normal.spendable, '0.001');
  assert.equal(half.spendable, '0.0005');
  assert.ok(new Decimal(half.plan.cost).lte('0.0005'));
  assert.ok(new Decimal(half.plan.cost).gt('0.00047'), `cost ${half.plan.cost} uses nearly all of the halved cap`);
  // Removal costs its price move: about 0.1% normally, about 0.05% under caution.
  const moved = (d: typeof normal) => (d.action === 'rebalance' ? d.priceAfter / d.priceBefore - 1 : 0);
  assert.ok(Math.abs(moved(half) / moved(normal) - 0.5) < 0.03, `moved ${moved(half)} vs ${moved(normal)}`);
  // Full allowance 0.03: cap 0.015 -> 0.0075.
  assert.equal(decideRebalance(pool(), EPOCH, 0.0008 * 1.2, { ...rcfg, sizeFactor: 0.5 }).spendable, '0.0075');
  // A small gap that fits the halved cap still closes fully (the CAP is halved, not the move).
  const small = decideRebalance(pool(), EPOCH, 0.0008 * 1.002, { ...rcfg, sizeFactor: 0.5 });
  assert.ok(small.action === 'rebalance' && !small.clipped && !small.behind);
  assert.throws(() => decideRebalance(pool(), EPOCH, 0.0008 * 1.02, { ...rcfg, sizeFactor: 0 }), /sizeFactor/);
});

test('caution size: the rolling-window share is halved (60% -> 30% of the allowance at the window start)', () => {
  const w = { windowMs: 600_000, maxShare: D.maxWindowSpendShare };
  // Nothing spent, allowance 0.01: room 0.006 normally, 0.003 under caution.
  assert.ok(Math.abs(windowSpendRoom([], 0.01, NOW, w).room - 0.006) < 1e-12);
  assert.ok(Math.abs(windowSpendRoom([], 0.01, NOW, { ...w, maxShare: w.maxShare * 0.5 }).room - 0.003) < 1e-12);
  // Spent 0.002 in the window, 0.008 left (0.01 at its start): 0.6*0.01-0.002 = 0.004 normally; 0.3*0.01-0.002 = 0.001.
  const spends = [{ at: NOW - MIN, cost: 0.002 }];
  assert.ok(Math.abs(windowSpendRoom(spends, 0.008, NOW, w).room - 0.004) < 1e-12);
  assert.ok(Math.abs(windowSpendRoom(spends, 0.008, NOW, { ...w, maxShare: 0.3 }).room - 0.001) < 1e-12);
  // The window cap then binds the move: spendCap below the halved per-tick cap wins.
  const d = decideRebalance(pool(), EPOCH, 0.0008 * 1.2, { ...rcfg, sizeFactor: 0.5, spendCap: 0.001 });
  assert.equal(d.action === 'rebalance' && d.spendable, '0.001');
});

// ------------------------------------------------------------------ single-venue caution: episode and alert

test('caution episode: active with one confirmed venue, alerts once, cleared when two or more are live', () => {
  const lim = new AlertLimiter(3_600_000);
  let st: SingleVenueState = {};
  const step = (count: number, at: number) => {
    const r = singleVenueCaution(st, count, at);
    st = r.state;
    const sent = r.started ? lim.allow('single-venue', at) : false;
    if (r.ended) lim.clear('single-venue');
    return { ...r, sent };
  };
  assert.deepEqual(step(2, NOW), { state: {}, active: false, started: false, ended: false, sent: false });
  const s1 = step(1, NOW + MIN);
  assert.ok(s1.active && s1.started && s1.sent, 'first single-venue tick: alert');
  assert.equal(st.since, NOW + MIN);
  const s2 = step(1, NOW + 2 * MIN);
  assert.ok(s2.active && !s2.started && !s2.sent, 'still single: no repeat');
  // Zero venues does not end the episode (no new alert when the one venue comes back).
  const z = step(0, NOW + 3 * MIN);
  assert.ok(!z.active && !z.ended);
  assert.equal(st.since, NOW + MIN);
  assert.ok(!step(1, NOW + 4 * MIN).started);
  // Two live: ended, key cleared; a later single-venue episode alerts at once.
  const e = step(2, NOW + 5 * MIN);
  assert.ok(e.ended && !e.active);
  assert.deepEqual(st, {});
  const again = step(1, NOW + 6 * MIN);
  assert.ok(again.started && again.sent, 'a new episode alerts again (the key was cleared)');
  // Survives a reload.
  const reloaded: SingleVenueState = JSON.parse(JSON.stringify(st));
  assert.equal(singleVenueCaution(reloaded, 1, NOW + 7 * MIN).started, false);
});

// ------------------------------------------------------------------ two-tick confirmation

test('confirmation: the first tick confirms what quotes; ticks=1 is the old behaviour', () => {
  const first = venueConfirm({}, ['b', 'a'], N);
  assert.deepEqual(first.confirmed, ['a', 'b']);
  assert.equal(first.uncertain, false);
  const one = venueConfirm(first.state, ['a'], 1);
  assert.deepEqual(one.confirmed, ['a']);
  assert.deepEqual(one.dropped, ['b']);
  assert.equal(one.uncertain, false);
  assert.deepEqual(venueConfirm(one.state, ['a', 'b'], 1).added, ['b']);
});

/** One bot tick's venue rules, as scripts/owner-pool-bot.ts runs them. */
function tick(st: { vc: VenueConfirmState; vh: VenueHoldState; sv: SingleVenueState }, quoting: string[], at: number) {
  const vc = venueConfirm(st.vc, quoting, N);
  const vh = venueSetHold(st.vh, vc.confirmed, at, HOLD);
  const sv = singleVenueCaution(st.sv, vc.confirmed.length, at);
  const status = quoting.filter((v) => vc.confirmed.includes(v)).length ? 'ok' as const : 'none' as const;
  const gate = venueGate({ status, holding: vh.holding, uncertain: vc.uncertain });
  return { st: { vc: vc.state, vh: vh.state, sv: sv.state }, vc, vh, sv, gate };
}

test('confirmation: one failed tick = no rebalance, no hold, not single-venue; two in a row = dropped, hold, caution', () => {
  let st = tick({ vc: {}, vh: {}, sv: {} }, ['caviarnine', 'ociswap-precision'], NOW).st;
  let t = tick(st, ['caviarnine', 'ociswap-precision'], NOW + MIN);
  assert.equal(t.gate, 'trade');
  st = t.st;
  // CaviarNine fails ONCE.
  t = tick(st, ['ociswap-precision'], NOW + 2 * MIN);
  assert.equal(t.vc.uncertain, true);
  assert.deepEqual(t.vc.failing, [{ venue: 'caviarnine', ticks: 1 }]);
  assert.deepEqual(t.vc.confirmed, ['caviarnine', 'ociswap-precision'], 'still confirmed');
  assert.equal(t.vh.changed, false);
  assert.equal(t.vh.holding, false, 'no hold');
  assert.equal(t.sv.active, false, 'one of two failing once is NOT single-venue');
  assert.equal(t.gate, 'uncertain', 'no rebalance on this tick');
  // ...and comes back: back to normal at once, nothing started.
  const back = tick(t.st, ['caviarnine', 'ociswap-precision'], NOW + 3 * MIN);
  assert.equal(back.gate, 'trade');
  assert.deepEqual(back.st.vc.fails, {});
  // Fails twice in a row: dropped, the hold starts, the caution starts.
  t = tick(back.st, ['ociswap-precision'], NOW + 4 * MIN);
  assert.equal(t.gate, 'uncertain');
  t = tick(t.st, ['ociswap-precision'], NOW + 5 * MIN);
  assert.deepEqual(t.vc.dropped, ['caviarnine']);
  assert.equal(t.vc.uncertain, false);
  assert.ok(t.vh.started && t.vh.holding);
  assert.equal(t.vh.state.holdUntil, NOW + 5 * MIN + HOLD, 'the hold starts at the SECOND failed tick');
  assert.ok(t.sv.started && t.sv.active);
  assert.equal(t.gate, 'hold');
});

test('confirmation: a failure then a different venue failing does not add up (streaks are per venue)', () => {
  let st = tick({ vc: {}, vh: {}, sv: {} }, ['a', 'b', 'c'], NOW).st;
  let t = tick(st, ['b', 'c'], NOW + MIN); // a fails once
  st = t.st;
  t = tick(st, ['a', 'c'], NOW + 2 * MIN); // a back, b fails once
  assert.deepEqual(t.vc.confirmed, ['a', 'b', 'c']);
  assert.deepEqual(t.vc.failing, [{ venue: 'b', ticks: 1 }]);
  assert.equal(t.vh.holding, false);
  assert.equal(t.gate, 'uncertain');
});

test('confirmation: a venue coming back counts only after two good ticks; it is not priced before', () => {
  let st = tick({ vc: {}, vh: {}, sv: {} }, ['ociswap-precision'], NOW).st;
  let t = tick(st, ['ociswap-precision', 'caviarnine'], NOW + MIN);
  assert.deepEqual(t.vc.returning, [{ venue: 'caviarnine', ticks: 1 }]);
  assert.deepEqual(t.vc.confirmed, ['ociswap-precision']);
  assert.equal(t.vh.changed, false);
  assert.equal(t.sv.active, true, 'still single-venue');
  assert.equal(t.gate, 'trade');
  // A blink in between resets the streak.
  t = tick(t.st, ['ociswap-precision'], NOW + 2 * MIN);
  assert.deepEqual(t.st.vc.goods, {});
  t = tick(t.st, ['ociswap-precision', 'caviarnine'], NOW + 3 * MIN);
  assert.deepEqual(t.vc.returning, [{ venue: 'caviarnine', ticks: 1 }]);
  t = tick(t.st, ['ociswap-precision', 'caviarnine'], NOW + 4 * MIN);
  assert.deepEqual(t.vc.added, ['caviarnine']);
  assert.ok(t.vh.started && t.vh.holding, 'the hold starts when it is confirmed back');
  assert.ok(t.sv.ended && !t.sv.active, 'two venues: caution over');
  assert.equal(t.gate, 'hold');

  // The price: an unconfirmed venue is read and logged, not used.
  const q = (venue: string, p: number): VenueQuote => ({ venue, at: NOW, sizeA: 1000, smallA: 100, bid: p * 0.9995, ask: p / 0.9995, bidSmall: p * 0.9996, askSmall: p / 0.9996 });
  const o = { minVenues: 1, maxAgeMs: 300_000, maxDisagreement: 0.04, maxRoundTrip: 0.1, minImpactBps: 10 };
  const r = aggregateVenues([q('ociswap-precision', 0.00082), q('caviarnine', 0.00084)], NOW, { ...o, unconfirmed: { caviarnine: 'coming back: 1/2 good ticks in a row, not counted yet' } });
  assert.equal(r.live, 1);
  assert.ok(Math.abs(r.price! - 0.00082) < 1e-12);
  assert.match(r.venues[1]!.dropped!, /coming back: 1\/2/);
  assert.ok(r.venues[1]!.mid! > 0, 'still read and logged');
});

test('confirmation: zero live = no reference (no trade); the only venue failing once does not start a hold', () => {
  let st = tick({ vc: {}, vh: {}, sv: {} }, ['ociswap-precision'], NOW).st;
  const t = tick(st, [], NOW + MIN);
  assert.equal(t.gate, 'none');
  assert.equal(t.vh.holding, false);
  assert.deepEqual(t.vc.confirmed, ['ociswap-precision']);
  st = t.st;
  const back = tick(st, ['ociswap-precision'], NOW + 2 * MIN);
  assert.equal(back.gate, 'trade', 'one failed tick and back: no hold');
  assert.equal(back.sv.started, false, 'same caution episode');
  // Two in a row: dropped, nothing confirmed, hold; the venue needs two good ticks to come back.
  let d = tick(back.st, [], NOW + 3 * MIN);
  d = tick(d.st, [], NOW + 4 * MIN);
  assert.deepEqual(d.vc.confirmed, []);
  assert.ok(d.vh.started);
  assert.equal(d.gate, 'none');
  d = tick(d.st, ['ociswap-precision'], NOW + 5 * MIN);
  assert.equal(d.gate, 'none', 'returning, not confirmed: still no reference');
  d = tick(d.st, ['ociswap-precision'], NOW + 6 * MIN);
  assert.deepEqual(d.vc.added, ['ociswap-precision']);
  assert.equal(d.gate, 'hold', 'confirmed back: a set change, held');
});

test('confirmation: counters survive a state reload (JSON round trip)', () => {
  const st = tick({ vc: {}, vh: {}, sv: {} }, ['a', 'b'], NOW).st;
  const once = tick(st, ['a'], NOW + MIN).st; // b failed once
  const reloaded = JSON.parse(JSON.stringify(once));
  assert.deepEqual(reloaded.vc.fails, { b: 1 });
  const t = tick(reloaded, ['a'], NOW + 2 * MIN);
  assert.deepEqual(t.vc.dropped, ['b'], 'the second failure after a restart still drops it');
  assert.ok(t.vh.started);
  // Goods too.
  const g = JSON.parse(JSON.stringify(tick(t.st, ['a', 'b'], NOW + 3 * MIN).st));
  assert.deepEqual(g.vc.goods, { b: 1 });
  assert.deepEqual(tick(g, ['a', 'b'], NOW + 4 * MIN).vc.added, ['b']);
});

test('confirmation and the hold: a single failure during a hold neither restarts nor ends it; a drop restarts it', () => {
  let st = tick({ vc: {}, vh: {}, sv: {} }, ['a', 'b', 'c'], NOW).st;
  // c drops (two ticks): hold from NOW + 2 min.
  st = tick(st, ['a', 'b'], NOW + MIN).st;
  let t = tick(st, ['a', 'b'], NOW + 2 * MIN);
  assert.ok(t.vh.started);
  const until = t.vh.state.holdUntil!;
  // During the hold, b fails once: still the same hold (hold wins over uncertain).
  t = tick(t.st, ['a'], NOW + 3 * MIN);
  assert.equal(t.vc.uncertain, true);
  assert.equal(t.vh.changed, false);
  assert.equal(t.vh.state.holdUntil, until);
  assert.equal(t.gate, 'hold');
  // b fails again: dropped, the hold restarts (no new start alert), single-venue starts.
  t = tick(t.st, ['a'], NOW + 4 * MIN);
  assert.ok(t.vh.changed && !t.vh.started);
  assert.equal(t.vh.state.holdUntil, NOW + 4 * MIN + HOLD);
  assert.ok(t.sv.started);
  // After the hold: single-venue trading, cautiously.
  t = tick(t.st, ['a'], NOW + 4 * MIN + HOLD);
  assert.ok(t.vh.expired);
  assert.equal(t.gate, 'trade');
  assert.equal(t.sv.active, true);
  // Disagreement is reported first, whatever else.
  assert.equal(venueGate({ status: 'disagree', holding: true, uncertain: true }), 'disagree');
  // A failed tick blocks narrowing the fee like a hold (the bot passes its message as noNarrow).
  const fd = feeDecision({ currentFeeBps: 150, targetFeeBps: 100, now: NOW, minFeeBps: 10, maxFeeBps: 200, cfg: { minFeeChangeBps: 5, widenIntervalMs: 120_000, narrowIntervalMs: 900_000 }, noNarrow: 'venue(s) failed this tick, not dropped yet: b 1/2' });
  assert.match(fd.reason, /narrow to 100 bps held: venue\(s\) failed this tick/);
});
