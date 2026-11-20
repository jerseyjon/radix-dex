import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal, findCrosses, payout, planCross, planPoolFill, type OpenOrder } from '../src/index.ts';

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

test('pool fill takes fee plus gas and refuses when the user would miss their minimum', () => {
  assert.deepEqual(planPoolFill({ quotedOut: '100', minBuyAmount: '90', feeBps: 10, gasInBuyToken: '0.5', divisibility: 18 }), { solverTake: '0.6', userReceives: '99.4' });
  assert.equal(planPoolFill({ quotedOut: '100', minBuyAmount: '99.5', feeBps: 10, gasInBuyToken: '0.5', divisibility: 18 }), undefined);
  // Buffer: exactly at the minimum is not enough.
  assert.equal(planPoolFill({ quotedOut: '100', minBuyAmount: '99.4', feeBps: 10, gasInBuyToken: '0.5', divisibility: 18 }), undefined);
  assert.ok(planPoolFill({ quotedOut: '100', minBuyAmount: '99.4', feeBps: 10, gasInBuyToken: '0.5', divisibility: 18, bufferBps: 0 }));
});
