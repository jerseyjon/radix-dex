// The OwnerPool market-making bot's decision logic (packages/core/src/ownerpool-bot.ts): reference
// price health, dead band, allowance clipping, caps and floors, the owner-anchor stop, the fee rule
// with hysteresis, the pause control and the transaction-rate cap. Pool figures are the Stokenet
// XRD/TEUR split pool's (docs/review-2026-11-21/owner-pool-split-stokenet.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Decimal, NETWORKS, OWNER_POOL_BOT_DEFAULTS as D, aggregateReference, anchorCheck, calibrateScale, decideRebalance, feeDecision, feeTarget, median,
  ownerPoolPlanRebalance, pauseDecision, poolTargetPrice, priceDistance, spendableAllowance, txAllowance, volatilityBps, type OwnerPoolState, type PauseState,
  type RebalanceConfig,
} from '../src/index.ts';

const XRD = NETWORKS.stokenet.xrd;
const TEUR = 'resource_tdx_2_1tknxk37t6tvqce4ce0jqv7ymydjfgjej4mw0wkdzep4wjfz8trvpj3';
const EPOCH = 25_000;

/** The split pool at 20,000 XRD / 16 TEUR (0.0008 TEUR per XRD), limits as on Stokenet, full allowance unless told. */
function pool(o: { ra?: string; rb?: string; ia?: string; ib?: string; allowance?: string; allowanceEpoch?: number; feeBps?: number; ownerPaused?: boolean; operator?: string | null } = {}): OwnerPoolState {
  return {
    address: 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk', packageAddress: 'package_tdx_2_1x', resourceA: XRD, resourceB: TEUR,
    divisibilityA: 18, divisibilityB: 6, reserveA: o.ra ?? '20000', reserveB: o.rb ?? '16', feeBps: o.feeBps ?? 30, paused: !!o.ownerPaused,
    split: {
      ownerPaused: !!o.ownerPaused, operatorPaused: false, inventoryA: o.ia ?? '1000', inventoryB: o.ib ?? '0.8', ownerBadge: 'resource_owner',
      operator: o.operator === undefined ? 'resource_op' : o.operator,
      limits: { moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '22000', maxReserveB: '17.6', minReserveA: '10000', minReserveB: '8', minFeeBps: 10, maxFeeBps: 100 },
      allowance: o.allowance ?? '0.03', allowanceEpoch: o.allowanceEpoch ?? EPOCH, anchor: ['1250', '1'],
    },
  };
}
const cfg = (o: Partial<RebalanceConfig> = {}): RebalanceConfig => ({ deadBandBps: D.deadBandBps, spendFraction: D.spendFraction, reserveFraction: D.reserveFraction, minMoveBps: D.minMoveBps, side: 'remove', ...o });
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// ------------------------------------------------------------------ reference

test('reference: median of fresh sources; stale, failed and future samples do not count', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const now = 1_000_000;
  const o = { minSources: 2, maxAgeMs: 300_000, maxDisagreement: 0.02 };
  const r = aggregateReference([
    { source: 'a', price: 1.00, at: now - 10_000 },
    { source: 'b', price: 1.01, at: now - 299_000 },
    { source: 'c', price: 1.005, at: now },
    { source: 'stale', price: 5, at: now - 301_000 },
    { source: 'failed', price: NaN, at: now, error: 'HTTP 500' },
    { source: 'future', price: 5, at: now + 120_000 },
    { source: 'zero', price: 0, at: now },
  ], now, o);
  assert.ok(r.ok);
  assert.equal(r.ok && r.price, 1.005);
  assert.deepEqual(r.fresh.map((s) => s.source), ['a', 'b', 'c']);
});

test('reference: too few fresh sources is refused', () => {
  const now = 1_000_000;
  const o = { minSources: 2, maxAgeMs: 300_000, maxDisagreement: 0.02 };
  const r = aggregateReference([{ source: 'a', price: 1, at: now }, { source: 'b', price: 1, at: now - 400_000 }], now, o);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /only 1 fresh source\(s\), need 2/);
  assert.equal(aggregateReference([], now, o).ok, false);
});

test('reference: sources that disagree by more than the bound are refused', () => {
  const now = 1_000_000;
  const o = { minSources: 2, maxAgeMs: 300_000, maxDisagreement: 0.02 };
  // 1.99% apart: allowed; 2.1%: refused, whatever the median says.
  assert.ok(aggregateReference([{ source: 'a', price: 1, at: now }, { source: 'b', price: 1.0199, at: now }], now, o).ok);
  const r = aggregateReference([{ source: 'a', price: 1, at: now }, { source: 'b', price: 1.021, at: now }, { source: 'c', price: 1.0, at: now }], now, o);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /disagree by 2\.10%/);
  // As seen on mainnet on 22 Nov 2026: CoinGecko 0.00080, Ociswap 0.000831, CaviarNine 0.000848 (6% apart).
  assert.equal(aggregateReference([{ source: 'cg', price: 0.0008, at: now }, { source: 'oci', price: 0.000831, at: now }, { source: 'c9', price: 0.000848, at: now }], now, o).ok, false);
});

test('mapping: the calibrated scale maps the reference at calibration onto the owner anchor', () => {
  const scale = calibrateScale(0.00079979, ['1250', '1']);
  near(poolTargetPrice(0.00079979, scale), 0.0008, 1e-15);
  // The pool then follows the reference's relative moves.
  near(poolTargetPrice(0.00079979 * 1.01, scale), 0.000808, 1e-12);
  assert.equal(poolTargetPrice(0.5, 1), 0.5);
  assert.throws(() => calibrateScale(0, ['1250', '1']));
});

// ------------------------------------------------------------------ rebalance

test('dead band: no move inside half the pool fee; a move outside it', () => {
  const p = pool(); // price 0.0008
  // 30 bps fee -> 15 bps band.
  const inside = decideRebalance(p, EPOCH, 0.0008 * 1.0014, cfg());
  assert.equal(inside.action, 'none');
  assert.equal(inside.deadBandBps, 15);
  assert.match(inside.action === 'none' ? inside.reason : '', /dead band/);
  const outside = decideRebalance(p, EPOCH, 0.0008 * 1.002, cfg());
  assert.equal(outside.action, 'rebalance');
  // A wider fee widens the band; an explicit band overrides it.
  assert.equal(decideRebalance(pool({ feeBps: 60 }), EPOCH, 0.0008 * 1.002, cfg()).action, 'none');
  assert.equal(decideRebalance(p, EPOCH, 0.0008 * 1.0014, cfg({ deadBandBps: 10 })).action, 'rebalance');
});

test('rebalance: price up removes token A; price down removes token B; the plan lands on the target and matches the contract copy', () => {
  const p = pool();
  const up = decideRebalance(p, EPOCH, 0.0008 * 1.002, cfg());
  assert.ok(up.action === 'rebalance');
  assert.equal(up.kind, 'removeA');
  assert.equal(up.toReserveB, '0');
  assert.ok(new Decimal(up.toReserveA).lt(0));
  near(up.priceAfter, 0.0008 * 1.002, 1e-12);
  assert.ok(!up.clipped && !up.behind);
  // The exact plan the bot will send is the contract's own arithmetic.
  assert.deepEqual(ownerPoolPlanRebalance(p, up.toReserveA, up.toReserveB, EPOCH), up.plan);
  const down = decideRebalance(p, EPOCH, 0.0008 / 1.002, cfg());
  assert.ok(down.action === 'rebalance');
  assert.equal(down.kind, 'removeB');
  assert.ok(new Decimal(down.toReserveB).lt(0));
  // TEUR has 6 places: the amount is rounded toward zero (a slightly smaller move).
  assert.ok(new Decimal(down.toReserveB).toDecimalPlaces(6).eq(down.toReserveB));
  // side 'add' adds the scarce token instead.
  const add = decideRebalance(p, EPOCH, 0.0008 * 1.002, cfg({ side: 'add' }));
  assert.ok(add.action === 'rebalance' && add.kind === 'addB' && new Decimal(add.toReserveB).gt(0));
});

test('balanced side: remove while deeper than the target depth, add while shallower', () => {
  const p = pool(); // depth sqrt(20000 * 16) ~ 565.7
  const deep = decideRebalance(p, EPOCH, 0.0008 * 1.002, cfg({ side: 'balanced', targetDepth: 500 }));
  const shallow = decideRebalance(p, EPOCH, 0.0008 * 1.002, cfg({ side: 'balanced', targetDepth: 600 }));
  assert.ok(deep.action === 'rebalance' && deep.kind === 'removeA');
  assert.ok(shallow.action === 'rebalance' && shallow.kind === 'addB');
});

test('allowance clipping: spend at most half of what is available and keep the reserve', () => {
  // spendable = min(allowance * 0.5, allowance - 0.1 * 0.03)
  assert.equal(spendableAllowance('0.03', 300, D).toFixed(), '0.015');
  assert.equal(spendableAllowance('0.004', 300, D).toFixed(), '0.001');
  assert.equal(spendableAllowance('0.003', 300, D).toFixed(), '0');
  assert.equal(spendableAllowance('0.002', 300, D).toFixed(), '0');
  // A 2% gap with only 0.004 available: the bot spends 0.001 (not 0.004), moves about 0.1%, and is behind.
  const p = pool({ allowance: '0.004' });
  const d = decideRebalance(p, EPOCH, 0.0008 * 1.02, cfg());
  assert.ok(d.action === 'rebalance');
  assert.ok(d.clipped && d.behind);
  assert.ok(new Decimal(d.plan.cost).lte('0.001'));
  assert.ok(new Decimal(d.plan.cost).gt('0.00095'), `cost ${d.plan.cost} should use nearly all of the 0.001 spendable`);
  near(priceDistance(d.priceBefore, d.priceAfter), 0.001, 0.00005);
  // Nothing spendable: no move, and behind.
  const spent = decideRebalance(pool({ allowance: '0.002' }), EPOCH, 0.0008 * 1.02, cfg());
  assert.equal(spent.action, 'none');
  assert.ok(spent.action === 'none' && spent.behind && /allowance spent/.test(spent.reason));
  // The allowance refills with epochs (stored 0.002 + 36 epochs of 0.03/72 = 0.017).
  assert.equal(decideRebalance(pool({ allowance: '0.002' }), EPOCH + 36, 0.0008 * 1.02, cfg()).action, 'rebalance');
});

test('caps and floors: a move that would breach them is clipped to them, never proposed beyond', () => {
  // XRD reserve 10,050 with a 10,000 floor: raising the price 2% by removing XRD would need ~200 XRD.
  const nearFloor = pool({ ra: '10050', rb: '8.04' });
  const r = decideRebalance(nearFloor, EPOCH, 0.0008 * 1.02, cfg({ side: 'remove' }));
  assert.ok(r.action === 'rebalance');
  if (r.kind === 'removeA') assert.ok(new Decimal(r.plan.reserveA).gte('10000'), 'floor kept');
  // The add side (TEUR from inventory) closes more of the gap here and wins.
  assert.equal(r.kind, 'addB');
  assert.ok(new Decimal(r.plan.reserveB).lte('17.6'));
  // No inventory and at the floor: nothing fits.
  const stuck = decideRebalance(pool({ ra: '10000', rb: '8', ib: '0' }), EPOCH, 0.0008 * 1.02, cfg());
  assert.equal(stuck.action, 'none');
  assert.match(stuck.action === 'none' ? stuck.reason : '', /no move fits/);
  // At the TEUR cap, an add of TEUR is refused; the XRD removal still works.
  const atCap = decideRebalance(pool({ rb: '17.6', ra: '22000' }), EPOCH, 0.0008 * 1.002, cfg({ side: 'add' }));
  assert.ok(atCap.action === 'rebalance' && atCap.kind === 'removeA');
  // Every proposal re-checks against the contract copy: never a cap/floor breach.
  for (const target of [0.0007, 0.00079, 0.00081, 0.0009]) {
    for (const side of ['remove', 'add', 'balanced'] as const) {
      const d = decideRebalance(pool({ ra: '10100', rb: '8.1', ib: '0.3', ia: '300' }), EPOCH, target, cfg({ side, targetDepth: 300 }));
      if (d.action !== 'rebalance') continue;
      assert.ok(new Decimal(d.plan.reserveA).gte('10000') && new Decimal(d.plan.reserveB).gte('8'));
      assert.ok(new Decimal(d.plan.reserveA).lte('22000') && new Decimal(d.plan.reserveB).lte('17.6'));
    }
  }
});

test('rebalance refuses: owner pause, no operator, tiny moves', () => {
  assert.match((decideRebalance(pool({ ownerPaused: true }), EPOCH, 0.0009, cfg()) as any).reason, /paused by the owner/);
  assert.match((decideRebalance(pool({ operator: null }), EPOCH, 0.0009, cfg()) as any).reason, /no operator/);
  const tiny = decideRebalance(pool(), EPOCH, 0.0008 * 1.002, cfg({ minMoveBps: 50 }));
  assert.match(tiny.action === 'none' ? tiny.reason : '', /minimum 50/);
});

// ------------------------------------------------------------------ anchor distance and pause

test('anchor distance: stop beyond 5% of the owner anchor, resume only within 4%', () => {
  const a: ['1250', '1'] = ['1250', '1'];
  assert.equal(anchorCheck(0.0008 * 1.049, a, { maxDistance: 0.05, resumeFactor: 0.8, stopped: false }).ok, true);
  assert.equal(anchorCheck(0.0008 * 1.051, a, { maxDistance: 0.05, resumeFactor: 0.8, stopped: false }).ok, false);
  assert.equal(anchorCheck(0.0008 / 1.051, a, { maxDistance: 0.05, resumeFactor: 0.8, stopped: false }).ok, false);
  assert.equal(anchorCheck(0.0008 * 1.045, a, { maxDistance: 0.05, resumeFactor: 0.8, stopped: true }).ok, false);
  assert.equal(anchorCheck(0.0008 * 1.039, a, { maxDistance: 0.05, resumeFactor: 0.8, stopped: true }).ok, true);
});

test('pause control: unhealthy reference pauses after the delay, an anchor problem at once; only the bot\'s own pause is cleared', () => {
  const base = { pauseAfterMs: 600_000, resumeAfterMs: 900_000, ownerPaused: false };
  let st: PauseState = { pausedByBot: false };
  let r = pauseDecision({ ...base, now: 0, healthy: false, anchorOk: true, operatorPaused: false, state: st });
  assert.equal(r.action, 'none');
  st = r.state;
  r = pauseDecision({ ...base, now: 599_000, healthy: false, anchorOk: true, operatorPaused: false, state: st });
  assert.equal(r.action, 'none');
  r = pauseDecision({ ...base, now: 600_000, healthy: false, anchorOk: true, operatorPaused: false, state: r.state });
  assert.equal(r.action, 'pause');
  assert.equal(r.state.pausedByBot, true);
  // A healthy blink restarts the clock; resume needs 15 min of health.
  r = pauseDecision({ ...base, now: 700_000, healthy: true, anchorOk: true, operatorPaused: true, state: r.state });
  assert.equal(r.action, 'none');
  r = pauseDecision({ ...base, now: 800_000, healthy: false, anchorOk: true, operatorPaused: true, state: r.state });
  assert.equal(r.action, 'none');
  r = pauseDecision({ ...base, now: 900_000, healthy: true, anchorOk: true, operatorPaused: true, state: r.state });
  r = pauseDecision({ ...base, now: 1_799_000, healthy: true, anchorOk: true, operatorPaused: true, state: r.state });
  assert.equal(r.action, 'none');
  r = pauseDecision({ ...base, now: 1_800_000, healthy: true, anchorOk: true, operatorPaused: true, state: r.state });
  assert.equal(r.action, 'unpause');
  assert.equal(r.state.pausedByBot, false);
  // Anchor problem: pause at once, with the owner named in the reason.
  const a = pauseDecision({ ...base, now: 0, healthy: true, anchorOk: false, operatorPaused: false, state: { pausedByBot: false } });
  assert.equal(a.action, 'pause');
  assert.match(a.reason, /OWNER must restate the anchor/);
  // Someone else's operator pause is never cleared.
  assert.equal(pauseDecision({ ...base, resumeAfterMs: 0, now: 0, healthy: true, anchorOk: true, operatorPaused: true, state: { pausedByBot: false } }).action, 'none');
  // Under the owner's pause the bot sends nothing.
  assert.equal(pauseDecision({ ...base, pauseAfterMs: 0, ownerPaused: true, now: 0, healthy: false, anchorOk: true, operatorPaused: false, state: { pausedByBot: false } }).action, 'none');
});

// ------------------------------------------------------------------ fee

test('fee rule: base, widened by volatility and when behind, inside the owner range', () => {
  const c = { baseFeeBps: 30, volMultiplier: 2, behindFeeBps: 10 };
  assert.equal(feeTarget({ volBps: 0, behind: false, minFeeBps: 10, maxFeeBps: 100, cfg: c }), 30);
  assert.equal(feeTarget({ volBps: 12.4, behind: false, minFeeBps: 10, maxFeeBps: 100, cfg: c }), 55);
  assert.equal(feeTarget({ volBps: 12.4, behind: true, minFeeBps: 10, maxFeeBps: 100, cfg: c }), 65);
  assert.equal(feeTarget({ volBps: 500, behind: true, minFeeBps: 10, maxFeeBps: 100, cfg: c }), 100);
  assert.equal(feeTarget({ volBps: 0, behind: false, minFeeBps: 40, maxFeeBps: 100, cfg: c }), 40);
});

test('volatility: zero for a flat reference, per-tick standard deviation otherwise', () => {
  const flat = Array.from({ length: 10 }, (_, i) => ({ at: i * 60_000, price: 1 }));
  assert.equal(volatilityBps(flat, 9 * 60_000, 3_600_000, 60_000), 0);
  // Alternating +-10 bps per minute: deviation of the log returns ~ 20 bps... (returns +0.001, -0.000999)
  const zig = Array.from({ length: 11 }, (_, i) => ({ at: i * 60_000, price: i % 2 ? 1.001 : 1 }));
  near(volatilityBps(zig, 10 * 60_000, 3_600_000, 60_000), 10.5, 0.2);
  // Samples outside the window are ignored; two-minute gaps are scaled to one tick.
  assert.equal(volatilityBps([{ at: 0, price: 2 }, ...flat.map((h) => ({ ...h, at: h.at + 7_200_000 }))], 7_200_000 + 9 * 60_000, 3_600_000, 60_000), 0);
  const zig2 = zig.map((h) => ({ ...h, at: h.at * 2 }));
  near(volatilityBps(zig2, 20 * 60_000, 3_600_000, 60_000), 10.5 / Math.SQRT2, 0.2);
  assert.equal(volatilityBps(flat.slice(0, 2), 60_000, 3_600_000, 60_000), 0);
});

test('fee hysteresis: min change, widen soon, narrow slowly, no range no power', () => {
  const c = { minFeeChangeBps: 5, widenIntervalMs: 120_000, narrowIntervalMs: 900_000 };
  const r = { minFeeBps: 10, maxFeeBps: 100 };
  assert.equal(feeDecision({ ...r, currentFeeBps: 30, targetFeeBps: 34, now: 1e9, cfg: c }).action, 'none');
  assert.deepEqual(feeDecision({ ...r, currentFeeBps: 30, targetFeeBps: 35, now: 1e9, cfg: c }), { action: 'set', feeBps: 35, reason: 'widen 30 -> 35 bps' });
  assert.equal(feeDecision({ ...r, currentFeeBps: 30, targetFeeBps: 50, lastChangeAt: 1e9 - 60_000, now: 1e9, cfg: c }).action, 'none');
  assert.equal(feeDecision({ ...r, currentFeeBps: 30, targetFeeBps: 50, lastChangeAt: 1e9 - 120_000, now: 1e9, cfg: c }).action, 'set');
  assert.equal(feeDecision({ ...r, currentFeeBps: 50, targetFeeBps: 30, lastChangeAt: 1e9 - 600_000, now: 1e9, cfg: c }).action, 'none');
  assert.equal(feeDecision({ ...r, currentFeeBps: 50, targetFeeBps: 30, lastChangeAt: 1e9 - 900_000, now: 1e9, cfg: c }).action, 'set');
  assert.match((feeDecision({ minFeeBps: 30, maxFeeBps: 30, currentFeeBps: 30, targetFeeBps: 50, now: 1e9, cfg: c }) as any).reason, /no fee range/);
});

// ------------------------------------------------------------------ rate cap

test('transaction-rate cap: counts sends in the last hour only', () => {
  const now = 10_000_000;
  assert.equal(txAllowance([], now, 12), 12);
  assert.equal(txAllowance([now - 10, now - 3_599_999, now - 3_600_000, now - 9_000_000], now, 12), 10);
  assert.equal(txAllowance(Array.from({ length: 15 }, (_, i) => now - i * 1000), now, 12), 0);
});
