import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromAttos, ownerPoolCompute, toAttos } from '@radix-dex/core';
import { EPOCH_MINUTES, allowanceGauge, band, buyA, distance, fmtDuration, fmtPct, limitRow, miniGap, pctTicks, priceScale, sellA, splitParts, venueSellCost } from '../src/poolgraphics.ts';

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

// The mainnet pool on 23 Nov 2026: 100,000 XRD / 76.3 hUSDC, 110 bps.
const RA = 100_000, RB = 76.3, FEE = 110;

test('selling XRD: matches the contract\'s compute_swap, and the cost includes the fee', () => {
  for (const x of [100, 1_000, 10_000, 50_000]) {
    const s = sellA(RA, RB, FEE, x)!;
    const exact = Number(fromAttos(ownerPoolCompute({ rIn: toAttos(String(RA)), rOut: toAttos(String(RB)), divIn: 18, divOut: 6, input: toAttos(String(x)), feeBps: FEE })));
    near(s.amountB, exact, 2e-6); // the contract floors to 6 places
    assert.ok(s.cost > FEE / 10_000, 'the cost is at least the fee');
    assert.ok(s.move < 0, 'selling XRD lowers the price');
  }
  const s1k = sellA(RA, RB, FEE, 1_000)!;
  // 1 - (1 - f) ra / (ra + x (1 - f))
  near(s1k.cost, 1 - (0.989 * RA) / (RA + 989));
  near(s1k.priceAfter, (RB - s1k.amountB) / (RA + 1_000));
  assert.equal(sellA(0, RB, FEE, 1), undefined);
  assert.equal(sellA(RA, RB, FEE, 0), undefined);
});

test('buying XRD: the input that takes exactly x out, and impossible at the whole reserve', () => {
  const b = buyA(RA, RB, FEE, 10_000)!;
  // Selling that input back through the formula gives exactly 10,000 XRD out.
  const eff = b.amountB * (1 - FEE / 10_000);
  near((RA * eff) / (RB + eff), 10_000);
  assert.ok(b.move > 0 && b.cost > FEE / 10_000);
  near(b.priceAfter, (RB + b.amountB) / (RA - 10_000));
  assert.equal(buyA(RA, RB, FEE, RA), undefined);
  assert.equal(buyA(RA, RB, 10_000, 1), undefined);
  // With no fee, a tiny trade costs nothing.
  assert.ok(buyA(RA, RB, 0, 1e-6)!.cost < 1e-9);
});

test("a venue's sell cost is the pool formula on its measured depth and own fee", () => {
  near(venueSellCost(RA, FEE / 10_000, 1_000)!, sellA(RA, RB, FEE, 1_000)!.cost);
  near(venueSellCost(1e12, 0.0005, 1)!, 0.0005, 1e-6);
  assert.equal(venueSellCost(0, 0.001, 1), undefined);
  assert.equal(venueSellCost(100, 1, 1), undefined);
});

test('distance and bands are symmetric by ratio', () => {
  near(distance(1.05, 1), 0.05);
  near(distance(1, 1.05), 0.05);
  assert.equal(distance(0, 1), Infinity);
  const [lo, hi] = band(0.00079187319, 0.05);
  near(distance(lo, 0.00079187319), 0.05);
  near(distance(hi, 0.00079187319), 0.05);
});

test('a price scale holds every value with padding, clamps outside, ignores missing ones', () => {
  const s = priceScale([0.000763, 0.000796, null, undefined, NaN, 0.000792], 0.1)!;
  assert.ok(s.min < 0.000763 && s.max > 0.000796);
  assert.ok(s.pos(0.000763) > 0 && s.pos(0.000796) < 100);
  near(s.pos((s.min + s.max) / 2), 50);
  assert.equal(s.pos(1), 100);
  assert.equal(s.pos(0), 0);
  assert.equal(priceScale([null, -1]), undefined);
  const one = priceScale([2])!;
  assert.ok(one.min < 2 && one.max > 2);
});

test('the split values each holding in B at the price; shares sum to one', () => {
  const p = splitParts({ reserveA: RA, reserveB: RB, inventoryA: 0, inventoryB: 10 }, 0.0007958);
  assert.deepEqual(p.map((x) => x.key), ['reserveA', 'inventoryA', 'reserveB', 'inventoryB']);
  near(p[0]!.valueB, 79.58);
  near(p.reduce((s, x) => s + x.share, 0), 1);
  assert.equal(p[1]!.share, 0);
  assert.ok(splitParts({ reserveA: 0, reserveB: 0, inventoryA: 0, inventoryB: 0 }, 1).every((x) => x.share === 0));
});

test('a reserve against its floor and cap: room both ways, near and past', () => {
  const a = limitRow(100_000, 50_000, 110_000);
  assert.equal(a.toCap, 10_000);
  assert.equal(a.aboveFloor, 50_000);
  near(a.within, 50_000 / 60_000);
  assert.equal(a.state, 'ok');
  assert.equal(limitRow(76.3, 38.15, 83.93).state, 'ok'); // 83% of the way from floor to cap
  assert.equal(limitRow(80, 38.15, 83.93).state, 'near');
  assert.equal(limitRow(90, 38.15, 83.93).state, 'past');
  assert.equal(limitRow(30, 38.15, 83.93).state, 'past');
  assert.equal(limitRow(5, 5, 5).within, 1);
});

test('the allowance: share, the part the bot keeps back, what it can spend, refill time', () => {
  const rules = { reserveFraction: 0.1, spendFraction: 0.5 };
  const g = allowanceGauge({ now: 0.0025, budget: 0.03, windowEpochs: 144 }, rules)!;
  near(g.share, 0.0025 / 0.03);
  near(g.held, 0.003);
  assert.equal(g.spendable, 0); // below the 10% it keeps back
  assert.equal(g.epochsToFull, 132);
  assert.equal(g.minutesToFull, 132 * EPOCH_MINUTES);
  const full = allowanceGauge({ now: 0.03, budget: 0.03, windowEpochs: 144 }, rules)!;
  assert.equal(full.epochsToFull, 0);
  near(full.spendable, 0.015);
  near(allowanceGauge({ now: 0.01, budget: 0.03, windowEpochs: 144 }, rules)!.spendable, 0.005);
  assert.equal(allowanceGauge({ now: 1, budget: 0, windowEpochs: 1 }, rules), undefined);
  assert.equal(allowanceGauge({ now: 0.05, budget: 0.03, windowEpochs: 144 }, rules)!.share, 1);
});

test('durations and percentages for people', () => {
  assert.equal(fmtDuration(0), 'now');
  assert.equal(fmtDuration(35), '35 min');
  assert.equal(fmtDuration(660), '11 h');
  assert.equal(fmtDuration(250), '4 h 10 min');
  assert.equal(fmtDuration(27 * 60), '1 d 3 h');
  assert.equal(fmtPct(0.01234), '1.23%');
  assert.equal(fmtPct(-0.0412, 1, true), '-4.1%');
  assert.equal(fmtPct(0.05, 0, true), '+5%');
  assert.equal(fmtPct(NaN), '—');
});

test('percentage ticks around the market: the finest step that fits', () => {
  const t = pctTicks({ min: 0.95, max: 1.05 }, 1);
  assert.deepEqual(t.map((x) => x.pct), [-0.04, -0.02, 0, 0.02, 0.04]);
  near(t[0]!.price, 0.96);
  assert.deepEqual(pctTicks({ min: 0.99, max: 1.01 }, 1).map((x) => x.pct), [-0.01, -0.005, 0, 0.005, 0.01]);
  assert.deepEqual(pctTicks({ min: 1, max: 1 }, 1), []);
  assert.deepEqual(pctTicks({ min: 1, max: 2 }, 0), []);
});

test("the table's mini gauge: market in the middle, the fee band around it, the pool's dot clamped", () => {
  const m = miniGap(-412.5, 110)!;
  near(m.dot, 50 - (412.5 / (1.25 * 412.5)) * 50);
  near(m.bandLo, 50 - (110 / (1.25 * 412.5)) * 50);
  assert.equal(m.clipped, false);
  const small = miniGap(10, 110)!;
  near(small.bandLo, 25);
  near(small.bandHi, 75);
  assert.equal(miniGap(null, 110), undefined);
  assert.equal(miniGap(0, 0)!.dot, 50);
});
