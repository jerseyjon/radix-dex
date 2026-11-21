import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal, findCrosses, grossNeeded, payout, pickLiquidity, pickMakers, planBookCross, planCross, planPoolFill, takeFillManifest, type BookOrder, type OpenOrder } from '../src/index.ts';

const X = 'resource_x', Y = 'resource_y';
const div18 = () => 18;
const o = (id: string, sell: string, sellAmount: string, buy: string, minBuyAmount: string): OpenOrder => ({ id, sell, sellAmount, buy, minBuyAmount });

test('payout never goes below the minimum and never above the gross', () => {
  assert.equal(payout(new Decimal(100), new Decimal(90), 10, 18)!.toFixed(), '99.9');
  assert.equal(payout(new Decimal(100), new Decimal(99.95), 10, 18)!.toFixed(), '99.95');
  assert.equal(payout(new Decimal(100), new Decimal(100), 10, 18)!.toFixed(), '100');
  assert.equal(payout(new Decimal(100), new Decimal(100.01), 10, 18), undefined);
});

test('payout respects low divisibility (an 8-decimal token cannot be paid in dust)', () => {
  // Minimum has more decimals than the token: round the floor up, the fee'd amount down.
  assert.equal(payout(new Decimal('0.00000012'), new Decimal('0.000000101'), 10, 8)!.toFixed(), '0.00000011');
  assert.equal(payout(new Decimal('0.0000001'), new Decimal('0.000000101'), 10, 8), undefined);
  assert.equal(payout(new Decimal('5'), new Decimal('1'), 10, 0)!.toFixed(), '4');
});

test('crossing orders both fill and conserve funds', () => {
  const a = o('a', X, '50', Y, '4'), b = o('b', Y, '5', X, '45');
  const plan = planCross(a, b, 10, div18)!;
  assert.equal(plan.payA, '4.995');
  assert.equal(plan.payB, '49.95');
  assert.ok(new Decimal(plan.payA).lte(b.sellAmount) && new Decimal(plan.payA).gte(a.minBuyAmount));
  assert.ok(new Decimal(plan.payB).lte(a.sellAmount) && new Decimal(plan.payB).gte(b.minBuyAmount));
});

test('orders that do not cross are left alone', () => {
  assert.equal(planCross(o('a', X, '50', Y, '6'), o('b', Y, '5', X, '45'), 10, div18), undefined);
  assert.equal(planCross(o('a', X, '50', Y, '4'), o('b', Y, '5', X, '51'), 10, div18), undefined);
  assert.equal(planCross(o('a', X, '50', Y, '4'), o('b', X, '5', Y, '45'), 10, div18), undefined);
  assert.equal(planCross(o('a', X, '50', Y, '4'), o('a', Y, '5', X, '45'), 10, div18), undefined);
});

test('each order is used in at most one cross', () => {
  const plans = findCrosses([o('a', X, '50', Y, '4'), o('b', Y, '5', X, '45'), o('c', Y, '5', X, '45')], 10, div18);
  assert.equal(plans.length, 1);
  assert.deepEqual([plans[0]!.a.id, plans[0]!.b.id], ['a', 'b']);
});

test('pool fill: gas always comes out, the fee only from the surplus, never below the minimum', () => {
  const f = (minBuyAmount: string, bufferBps?: number) => planPoolFill({ quotedOut: '100', minBuyAmount, feeBps: 10, gasInBuyToken: '0.5', divisibility: 18, bufferBps });
  // Plenty of room: full fee (0.1) plus gas (0.5).
  assert.deepEqual(f('90'), { solverTake: '0.6', userReceives: '99.4' });
  // Tight: the order still fills, the fee shrinks to what is left above the minimum.
  assert.deepEqual(f('99.45', 0), { solverTake: '0.55', userReceives: '99.45' });
  assert.deepEqual(f('99.5', 0), { solverTake: '0.5', userReceives: '99.5' });
  // Not even the network fee is covered: no fill.
  assert.equal(f('99.51', 0), undefined);
  // The default buffer keeps a small margin above the minimum.
  assert.equal(f('99.5'), undefined);
  assert.ok(Number(f('99.4')!.userReceives) >= 99.4 * 1.0005);
});

test('an order with a trigger fills when the market reaches its price, fees then come out of the proceeds', () => {
  // Sell 50 at 0.0955: trigger 4.775; signed minimum is that less 0.1 network fee and 0.10%.
  const terms = { minBuyAmount: '4.670225', limitBuyAmount: '4.775', feeBps: 10, gasInBuyToken: '0.1', divisibility: 18 };
  assert.equal(planPoolFill({ ...terms, quotedOut: '4.774' }), undefined);
  const at = planPoolFill({ ...terms, quotedOut: '4.775' })!;
  assert.ok(Number(at.userReceives) >= 4.670225 * 1.0005 && Number(at.solverTake) > 0.1);
  assert.deepEqual(planPoolFill({ ...terms, quotedOut: '4.8' }), { solverTake: '0.1048', userReceives: '4.6952' });
  assert.equal(grossNeeded(terms).toFixed(), '4.775');
  // An older order has no trigger: it needs its minimum, the margin and the network fee.
  assert.equal(grossNeeded({ minBuyAmount: '100', gasInBuyToken: '0.5', bufferBps: 0 }).toFixed(), '100.5');
});

test('a taker picks resting orders best price first, whole orders only, within what it sells', () => {
  const m = (id: string, sellAmount: string, limitBuyAmount: string): OpenOrder => ({ id, sell: X, sellAmount, buy: Y, minBuyAmount: new Decimal(limitBuyAmount).mul('0.97').toFixed(), limitBuyAmount });
  const taker = o('t', Y, '10', X, '1');
  const picked = pickMakers(taker, [m('dear', '50', '6'), m('cheap', '50', '4.775'), m('big', '500', '45'), o('same-side', Y, '5', X, '1'), taker], 10, div18);
  // "big" is the cheapest per unit but does not fit; "cheap" then "dear" would cost 10.775, so only "cheap".
  assert.deepEqual(picked.map((p) => p.order.id), ['cheap']);
  assert.equal(picked[0]!.cost, '4.775');
  assert.equal(picked[0]!.pay, '4.770225'); // limit less 0.10%, still above the maker's minimum
  assert.deepEqual(pickMakers(o('t', Y, '11', X, '1'), [m('dear', '50', '6'), m('cheap', '50', '4.775')], 10, div18).map((p) => p.order.id), ['cheap', 'dear']);
});

test('the combined fill pays makers first, swaps the rest, and gives the taker everything bought less the take', () => {
  const R = (n: string) => 'resource_tdx_2_1t' + n.repeat(53);
  const text = takeFillManifest({ solver: { account: 'account_tdx_2_1' + 'a'.repeat(54), badge: R('b') }, feeLockXrd: '10', sell: R('y'), buy: R('x'), makerPays: ['4.77'], poolIn: '0', route: [], solverTake: '1.05' });
  const lines = text.split('\n');
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at('YIELD_TO_CHILD NamedIntent("taker");') < at('YIELD_TO_CHILD NamedIntent("maker_0");'));
  assert.ok(at('Decimal("4.77")') < at('NamedIntent("maker_0") Bucket("pay_0")'));
  assert.ok(at('Decimal("1.05")') < at('NamedIntent("taker") Bucket("out")'));
  assert.ok(lines.at(-1)!.includes('deposit_batch'));
});

test('a taker takes book orders in part and signed orders whole, cheapest first', () => {
  const now = 1_000_000;
  const bk = (id: number, remaining: string, price: string, over: Partial<BookOrder> = {}): BookOrder => ({
    id, maker: 'account_m', sell: X, buy: Y, price, sellAmount: remaining, remaining, returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true, ...over,
  });
  const signed: OpenOrder = { id: 's', sell: X, sellAmount: '50', buy: Y, minBuyAmount: '4.6', limitBuyAmount: '4.7' }; // 0.094 each
  // The taker spends 10 Y. Cheapest is book order 1 (20 X at 0.09 = 1.8 Y), then the signed order
  // whole (4.7 Y), then as much of book order 2 (0.1 each) as the last 3.5 Y buys: 35 X.
  const items = pickLiquidity(o('t', Y, '10', X, '1'), [signed], [bk(2, '1000', '0.1'), bk(1, '20', '0.09')], 0, div18, now);
  assert.deepEqual(items.map((i) => [i.kind, i.cost, i.gives]), [['book', '1.8', '20'], ['order', '4.7', '50'], ['book', '3.5', '35']]);
  assert.equal(items[1]!.kind === 'order' && items[1]!.pay, '4.7'); // maker fee 0: the full price

  // Closed, expired, emptied or wrong-way orders are never taken; one about to expire is left alone too.
  const none = pickLiquidity(o('t', Y, '10', X, '1'), [], [
    bk(3, '100', '0.05', { open: false }), bk(4, '100', '0.05', { expiresAt: now - 1 }), bk(5, '100', '0.05', { expiresAt: now + 10 }),
    bk(6, '0', '0.05'), bk(7, '100', '0.05', { sell: Y, buy: X }),
  ], 0, div18, now);
  assert.deepEqual(none, []);

  // Rounding follows the contract: tokens bought round down, the cost up, so the fill is never underpaid.
  const dust = pickLiquidity(o('t', Y, '1', X, '1'), [], [bk(8, '1000', '0.3')], 0, (r) => (r === X ? 0 : 2), now);
  assert.deepEqual(dust.map((i) => [i.cost, i.gives]), [['0.9', '3']]);
});

test('the combined fill buys from the book before the pool leg and checks what was delivered', () => {
  const R = (n: string) => 'resource_tdx_2_1t' + n.repeat(53), C = 'component_tdx_2_1c' + 'q'.repeat(53);
  const text = takeFillManifest({
    solver: { account: 'account_tdx_2_1' + 'a'.repeat(54), badge: R('b') }, feeLockXrd: '10', sell: R('y'), buy: R('x'), makerPays: [], poolIn: '0', route: [], solverTake: '1',
    bookFills: [{ book: C, id: 7, pay: '1.8' }], assertBought: '20',
  });
  const lines = text.split('\n');
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at('"fill" 7u64 Bucket("book_0")') > at('Decimal("1.8")'));
  assert.ok(at('ASSERT_WORKTOP_CONTAINS') > at('"fill" 7u64') && at('ASSERT_WORKTOP_CONTAINS') < at('NamedIntent("taker") Bucket("out")'));
});

test('two book orders cross only when the bid reaches the ask, and only for what both can do', () => {
  const bk = (id: number, sell: string, buy: string, remaining: string, price: string): BookOrder => ({
    id, maker: 'account_m', sell, buy, price, sellAmount: remaining, remaining, returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true,
  });
  const ask = bk(1, X, Y, '100', '0.09');          // sells 100 X at 0.09 Y each
  const bid = bk(2, Y, X, '5', '10');              // sells 5 Y, wants 10 X per Y: bids 0.1 Y per X
  // The bid can take 50 X (5 Y at 10 X each). The solver pays 4.5 Y to the ask and gets 5 Y from the bid.
  assert.deepEqual(planBookCross(ask, bid, '1000', '0.1', div18), { pay: '4.5', middle: '50', back: '5' });
  // Limited by the solver's own funds: 0.9 Y buys 10 X, which the bid pays 1 Y for.
  assert.deepEqual(planBookCross(ask, bid, '0.9', '0.01', div18), { pay: '0.9', middle: '10', back: '1' });
  // Not worth the network fee, not crossing, same side, or the same order: nothing.
  assert.equal(planBookCross(ask, bid, '1000', '0.6', div18), undefined);
  assert.equal(planBookCross(ask, bk(3, Y, X, '5', '12'), '1000', '0', div18), undefined); // bids 0.0833 Y per X
  assert.equal(planBookCross(ask, bk(4, X, Y, '5', '0.08'), '1000', '0', div18), undefined);
  assert.equal(planBookCross(ask, ask, '1000', '0', div18), undefined);
  // The other way round works too: front X to the bid first.
  assert.deepEqual(planBookCross(bid, ask, '1000', '1', div18), { pay: '50', middle: '5', back: '55.555555555555555555' });
});
