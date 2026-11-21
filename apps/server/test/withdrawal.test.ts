import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '@radix-dex/core';
import { planWithdrawal } from '../src/withdrawal.ts';

const XRD = 'xrd', BADGE = 'badge';

test('the withdrawal never moves more than is held, at full 18-decimal precision', () => {
  const moves = planWithdrawal({ [XRD]: '1234.123456789012345678', [BADGE]: '1', tok: '0.000000000000000001', none: '0' }, { xrd: XRD, badge: BADGE, keep: '250' });
  assert.deepEqual(moves.map(([r, a]) => [r, a.toFixed()]), [[XRD, '983.123456789012345678'], ['tok', '0.000000000000000001']]);
  for (const [, a] of moves) assert.ok(a.lte(new Decimal('1234.123456789012345678')));
});

test('nothing to move when XRD is at or under what is kept', () => {
  assert.deepEqual(planWithdrawal({ [XRD]: '251' }, { xrd: XRD, badge: BADGE, keep: '250' }), []);
});
