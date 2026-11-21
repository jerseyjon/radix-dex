import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal, findCrosses, grossNeeded, payout, pickMakers, planCross, planPoolFill, takeFillManifest, type OpenOrder } from '../src/index.ts';

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
