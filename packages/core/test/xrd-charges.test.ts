// The solver's charges are always XRD (owner's rule, 22 Nov 2026): where they are taken, how much,
// and the manifests and order-book sums that make sure nothing but XRD is ever left to the solver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Decimal, bookFillOutcome, chargeAt, pickLiquidity, planBookCrossExact, planXrdLegFill, reducedXrdCharges, retryXrdTake, takeFillManifest,
  xrdCharges, xrdLegNeeded, type BookOrder, type OpenOrder, type Pool,
} from '../src/index.ts';

const X = 'resource_x', Y = 'resource_y';
const o = (id: string, sell: string, sellAmount: string, buy: string, minBuyAmount: string): OpenOrder => ({ id, sell, sellAmount, buy, minBuyAmount });
const R = (n: string) => 'resource_tdx_2_1t' + n.repeat(53);
const SOLVER = { account: 'account_tdx_2_1' + 'a'.repeat(54), badge: R('b') };
const pool = (address: string, a: string, b: string): Pool => ({ venue: 'ociswap', address, kind: 'basic', tokens: [a, b], feeRate: 0, tvlUsd: 1, volume24hUsd: 0, reserves: [1, 1] } as Pool);

test('charges are taken where the XRD is: from the proceeds, from the sale, or between two swaps', () => {
  assert.equal(chargeAt(Y, X, X), 'proceeds');
  assert.equal(chargeAt(X, Y, X), 'input');
  assert.equal(chargeAt(Y, 'resource_z', X), 'hop');
});

test('XRD charges: network fee plus the service fee on the XRD moved, rounded down to 18 places', () => {
  assert.equal(xrdCharges('100', '1.2', 10).toFixed(), '1.3');
  // Never rounded up: what falls past the 18th place is dropped.
  assert.equal(xrdCharges('0.000000000000000001', '1', 3333).toFixed(), '1');
  assert.equal(reducedXrdCharges('1.2').toFixed(), '0.9');
});

test('a fill charged on the XRD side before the swap: the user gets the whole swap, at least the minimum and the price on what is swapped', () => {
  // Buy a token with 100 XRD at 2 tokens per XRD: trigger 200; signed allowance 1.5 + 0.1 XRD, so minimum 2 × 98.4 = 196.8.
  const ord = { xrdBase: '100', minBuyAmount: '196.8', limitBuyAmount: '200' };
  // Solver's charges now 1.3 XRD: 98.7 XRD swapped. The price on that (197.4) beats the minimum plus 5 bps (196.8984).
  assert.equal(xrdLegNeeded({ ...ord, take: '1.3' })!.toFixed(), '197.4');
  assert.deepEqual(planXrdLegFill({ ...ord, take: '1.3', out: '197.4' }), { solverTake: '1.3', userReceives: '197.4' });
  assert.equal(planXrdLegFill({ ...ord, take: '1.3', out: '197.39' }), undefined);
  // A take that eats everything is no plan.
  assert.equal(xrdLegNeeded({ ...ord, take: '100' }), undefined);
  // Without a pool leg there is no buffer: the minimum itself.
  assert.equal(xrdLegNeeded({ xrdBase: '100', take: '1', minBuyAmount: '50', bufferBps: 0 })!.toFixed(), '50');
});

test('whatever the bought token\'s divisibility, the user receives the swap output untouched', () => {
  // The take is XRD (18 places); the bought token is never rounded by the solver, so 0, 6, 8 or 18 places make no difference.
  for (const out of ['197', '197.4', '197.40000001', '197.400000000000000001']) {
    const plan = planXrdLegFill({ xrdBase: '100', take: '1.3', out, minBuyAmount: '196.8', limitBuyAmount: '200' });
    if (new Decimal(out).gte('197.4')) assert.equal(plan!.userReceives, new Decimal(out).toFixed());
    else assert.equal(plan, undefined);
  }
  // A whole-number token with a whole-number minimum.
  assert.ok(planXrdLegFill({ xrdBase: '100', take: '1.3', out: '98', minBuyAmount: '97', limitBuyAmount: '98' }));
});

test('a smaller take is tried when the allowance falls short, never below the network fee less the tolerance', () => {
  // 98.7 XRD swapped gave 197.0; 197.4 needed. Short 0.4, at that rate about 0.2 XRD, plus 10%.
  const t = retryXrdTake({ xrdBase: '100', takeFull: '1.3', takeMin: '0.9', out: '197', need: '197.4' })!;
  assert.ok(t.gte('0.9') && t.lt('1.3') && t.lt(new Decimal('1.3').minus(new Decimal('0.4').div(new Decimal(197).div('98.7')))));
  assert.equal(retryXrdTake({ xrdBase: '100', takeFull: '1.3', takeMin: '0.9', out: '190', need: '197.4' })!.toFixed(), '0.9');
  assert.equal(retryXrdTake({ xrdBase: '100', takeFull: '1.3', takeMin: '0.9', out: '198', need: '197.4' })!.toFixed(), '1.3');
});

test('a hop fill takes the XRD between the swaps and leaves only XRD to the solver', () => {
  const A = R('a'), B = R('c'), XRD = R('x');
  const p1 = pool('component_tdx_2_1c' + 'p'.repeat(53), A, XRD), p2 = pool('component_tdx_2_1c' + 'r'.repeat(53), XRD, B);
  const text = takeFillManifest({ solver: SOLVER, feeLockXrd: '10', sell: A, buy: B, makerPays: [], poolIn: '5', route: [p1, p2], solverTake: '1.3', xrd: XRD, chargeAt: 'hop' });
  const lines = text.split('\n');
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at(p1.address) < at('Decimal("1.3")') && at('Decimal("1.3")') < at(p2.address), 'charges between the two swaps');
  assert.ok(lines[at('Decimal("1.3")')]!.includes(XRD), 'in XRD');
  assert.equal(at('ASSERT_WORKTOP_RESOURCES_ONLY'), lines.length - 2);
  assert.ok(lines[lines.length - 2]!.includes(XRD) && lines.at(-1)!.includes('deposit_batch'));
  // Misuse is refused rather than built.
  assert.throws(() => takeFillManifest({ solver: SOLVER, feeLockXrd: '10', sell: A, buy: B, makerPays: [], poolIn: '5', route: [p1], solverTake: '1', xrd: XRD, chargeAt: 'hop' }));
  assert.throws(() => takeFillManifest({ solver: SOLVER, feeLockXrd: '10', sell: A, buy: B, makerPays: [], poolIn: '5', route: [], solverTake: '1', xrd: XRD }), /proceeds/);
  assert.throws(() => takeFillManifest({ solver: SOLVER, feeLockXrd: '10', sell: A, buy: XRD, makerPays: [], poolIn: '5', route: [], solverTake: '1', xrd: XRD, chargeAt: 'input' }), /input/);
});

test('an input fill sets the XRD charges aside before paying makers, and the pool takes all that is left', () => {
  const T = R('t'), XRD = R('x');
  const text = takeFillManifest({
    solver: SOLVER, feeLockXrd: '10', sell: XRD, buy: T, makerPays: ['40'], poolIn: '58.7', route: [pool('component_tdx_2_1c' + 'p'.repeat(53), XRD, T)],
    solverTake: '1.3', xrd: XRD, chargeAt: 'input',
  });
  const lines = text.split('\n');
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at('Decimal("1.3")') < at('Decimal("40")'), 'charges first');
  assert.match(lines[at('Bucket("in0")')]!, /TAKE_ALL_FROM_WORKTOP/);
  assert.ok(!text.includes('Decimal("58.7")'), 'the pool takes everything left, including any change');
  assert.ok(at('ASSERT_WORKTOP_RESOURCES_ONLY') > at('NamedIntent("taker") Bucket("out")'));
});

test('the order book\'s own sums: sold rounds down, cost rounds up, the rest of the payment is change', () => {
  const ord = { price: '0.3', remaining: '1000' };
  const v = (r: ReturnType<typeof bookFillOutcome>) => [r!.sold, r!.cost, r!.change].map((d) => d.toFixed());
  assert.deepEqual(v(bookFillOutcome(ord, '1', 0, 18)), ['3', '0.9', '0.1']);
  assert.deepEqual(v(bookFillOutcome(ord, '0.9', 0, 18)), ['3', '0.9', '0']);
  assert.equal(bookFillOutcome(ord, '0.2', 0, 18), undefined); // too small to buy one whole token
  // Capped at what remains: the rest comes back.
  assert.deepEqual(v(bookFillOutcome({ price: '2', remaining: '1' }, '5', 6, 6)), ['1', '2', '3']);
});

test('book orders taken by a taker report what the contract will really do', () => {
  const bk: BookOrder = { id: 1, maker: 'account_m', sell: X, buy: Y, price: '0.3', sellAmount: '1000', remaining: '1000', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true };
  const [item] = pickLiquidity(o('t', Y, '1', X, '1'), [], [bk], 0, (r) => (r === X ? 0 : 2), 1);
  assert.ok(item && item.kind === 'book');
  assert.deepEqual([item.cost, item.gives, item.change], ['0.9', '3', '0']);
});

test('the solver crosses two book orders with XRD only when no other token is left over', () => {
  const T = 'resource_t';
  const bk = (id: number, sell: string, buy: string, remaining: string, price: string): BookOrder => ({
    id, maker: 'account_m', sell, buy, price, sellAmount: remaining, remaining, returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true,
  });
  for (const [tDiv, askPrice, bidPrice] of [[0, '9', '0.1'], [6, '9.123457', '0.10101'], [8, '0.00313371', '300'], [18, '9.1234567891', '0.1']] as const) {
    const div = (r: string) => (r === T ? tDiv : 18);
    const ask = bk(1, T, X, '100000', askPrice);     // sells T for XRD
    const bid = bk(2, X, T, '100000', bidPrice);      // sells XRD for T
    const plan = planBookCrossExact(ask, bid, X, '100000', '0.5', div);
    assert.ok(plan, `crosses with ${tDiv} places`);
    // Replay with the contract's sums: exactly `middle` comes out of the first and all of it goes into the second.
    const a = bookFillOutcome(ask, plan.pay, tDiv, 18)!, b = bookFillOutcome(bid, plan.middle, 18, tDiv)!;
    assert.equal(a.sold.toFixed(), plan.middle);
    assert.ok(b.change.isZero(), 'no change in T');
    assert.equal(b.sold.toFixed(), plan.back);
    assert.ok(new Decimal(plan.back).minus(plan.pay).gt('0.5'), 'pays its network fee');
  }
  // The solver only fronts XRD: the other way round is not done.
  assert.equal(planBookCrossExact(bk(2, X, T, '1000', '0.1'), bk(1, T, X, '100', '9'), X, '1000', '1', () => 18), undefined);
  // Not worth the network fee.
  assert.equal(planBookCrossExact(bk(1, T, X, '1', '9'), bk(2, X, T, '1000', '0.1'), X, '1000', '5', () => 18), undefined);
});
