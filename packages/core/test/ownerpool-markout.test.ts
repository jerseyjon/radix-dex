// Markout maths (packages/core/src/ownerpool-markout.ts): signs for both directions, the fee in A
// (XRD) terms, break-even fee, the records surviving a restart, and the summary splits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  breakEvenFeeBps, dueMarks, feeInA, markRecord, markout, parseMarkoutLines, parseOwnerPoolEvent, summarizeMarkouts, tradeFromSwap, tradePnl, tradeRecord, volumeInA,
  type MarkoutRecord,
} from '../src/index.ts';

const A = 'resource_tdx_2_1xrd', B = 'resource_tdx_2_1teur';
const near = (a: number, b: number, tol: number, m = '') => assert.ok(Math.abs(a - b) <= tol, `${m} ${a} not within ${tol} of ${b}`);
const T0 = Date.parse('2026-11-22T23:00:00Z');
const tx = (n: number) => ({ txid: `txid_${n}`, at: T0 + n * 1000, stateVersion: 100 + n });
const f = (name: string, value: string) => ({ field_name: name, kind: name.endsWith('resource') ? 'Reference' : 'Decimal', value });
/** A swap event as the Gateway shows it: 100 XRD in at 30 bps (fee 0.3 XRD), 0.0797... TEUR out. */
const swapEv = (inR: string, inAmt: string, outR: string, outAmt: string, fee: string) => parseOwnerPoolEvent('OwnerPoolSwapEvent', [
  f('input_resource', inR), f('input_amount', inAmt), f('output_resource', outR), f('output_amount', outAmt), f('fee', fee), f('reserve_a', '20100'), f('reserve_b', '15.92'),
]) as any;

test('swap event -> trade: side, trade price, fee level read off the trade', () => {
  const s = tradeFromSwap(tx(1), swapEv(A, '100', B, '0.0797', '0.3'), A, B)!;
  assert.equal(s.side, 'sellA');
  near(s.tradePrice, 0.000797, 1e-12);
  assert.equal(s.feeBps, 30);
  near(s.poolMidAfter, 15.92 / 20100, 1e-15);
  const b = tradeFromSwap(tx(2), swapEv(B, '0.08', A, '99.5', '0.00024'), A, B)!;
  assert.equal(b.side, 'buyA');
  near(b.tradePrice, 0.08 / 99.5, 1e-15);
  assert.equal(b.feeBps, 30);
  assert.equal(tradeFromSwap(tx(3), swapEv('resource_other', '1', A, '1', '0'), A, B), undefined, 'not this pair');
  assert.equal(tradeFromSwap(tx(4), parseOwnerPoolEvent('OwnerPoolSwapEvent', [f('reserve_a', '1'), f('reserve_b', '1')]) as any, A, B), undefined, 'old event shape');
});

test('markout signs: negative when the trader was right, in both directions; profit = fee + markout', () => {
  // Trader SELLS 100 XRD at 0.0008 with a 30 bps fee: gets 99.7 * 0.0008 = 0.07976 TEUR (no impact, for the arithmetic).
  const sell = { side: 'sellA' as const, inputAmount: 100, outputAmount: 0.07976, fee: 0.3 };
  // At the same price: the pool made exactly the fee, markout 0.
  let m = markout(sell, 0.0008, 0.0008);
  near(m.feeA, 0.3, 1e-12); near(m.markout, 0, 1e-9); near(m.pnl, 0.3, 1e-9);
  // XRD then FALLS 1% (the seller was right): the 100 XRD the pool took are worth less: markout negative.
  m = markout(sell, 0.0008, 0.0008 * 0.99);
  assert.ok(m.markout < 0);
  near(m.markout, 99.7 - 99.7 / 0.99, 1e-9);
  near(m.pnl, m.feeA + m.markout, 1e-12, 'profit = fee + markout');
  // XRD RISES 1% (the seller was wrong): positive.
  assert.ok(markout(sell, 0.0008, 0.0008 * 1.01).markout > 0);

  // Trader BUYS XRD with 0.08 TEUR, 30 bps fee (0.00024 TEUR) at 0.0008: gets 0.07976 / 0.0008 = 99.7 XRD.
  const buy = { side: 'buyA' as const, inputAmount: 0.08, outputAmount: 99.7, fee: 0.00024 };
  m = markout(buy, 0.0008, 0.0008);
  near(m.feeA, 0.3, 1e-9, 'fee in XRD terms at the trade-time reference'); near(m.markout, 0, 1e-9);
  // XRD then RISES (the buyer was right): negative.
  m = markout(buy, 0.0008, 0.0008 * 1.01);
  assert.ok(m.markout < 0);
  // (the fee is valued at the trade-time reference: 0.3 XRD, whatever XRD does after)
  near(m.markout, 0.08 / (0.0008 * 1.01) - 99.7 - 0.3, 1e-9);
  assert.ok(markout(buy, 0.0008, 0.0008 * 0.99).markout > 0, 'XRD falls: the buyer was wrong');
  // Fee in A, volume in A.
  near(feeInA(buy, 0.0008), 0.3, 1e-12);
  near(feeInA(sell, 0.0008), 0.3, 1e-12);
  near(volumeInA(buy, 0.0008), 100, 1e-9);
  near(volumeInA(sell, 0.0008), 100, 1e-12);
  near(tradePnl(sell, 0.0008), 0.3, 1e-9);
});

test('break-even fee: the fee that covers the markout; 0 when the markout is not negative', () => {
  // 1,000 XRD of volume lost 2 XRD to markout: 20 bps would have broken even.
  near(breakEvenFeeBps(-2, 1000), 20, 1e-9);
  assert.equal(breakEvenFeeBps(1, 1000), 0);
  assert.equal(breakEvenFeeBps(0, 1000), 0);
  assert.equal(breakEvenFeeBps(-1, 0), 0);
  // Consistent with the trade maths: a 1% adverse move on a 30 bps trade needs ~1% to break even.
  const sell = { side: 'sellA' as const, inputAmount: 100, outputAmount: 0.07976, fee: 0.3 };
  const m = markout(sell, 0.0008, 0.0008 * 0.99);
  near(breakEvenFeeBps(m.markout, volumeInA(sell, 0.0008)), 100.7, 0.1);
});

test('records: trade and marks, due marks survive a restart (read back from the file), summary splits', () => {
  const ref = (p: number, at: number) => ({ price: p, raw: p, scale: 1, at });
  const s1 = tradeFromSwap(tx(1), swapEv(A, '100', B, '0.07976', '0.3'), A, B)!;
  const s2 = tradeFromSwap(tx(2), swapEv(B, '0.8', A, '997', '0.0024'), A, B)!;
  const recs: MarkoutRecord[] = [tradeRecord(s1, ref(0.0008, s1.at)), tradeRecord(s2, ref(0.0008, s2.at))];
  near((recs[0] as any).at0.markout, 0, 1e-9);
  // Before +5 min: nothing due. At +5: two due; at +30: four.
  assert.equal(dueMarks(recs, T0 + 60_000, [5, 30]).length, 0);
  assert.equal(dueMarks(recs, T0 + 5 * 60_000 + 2000, [5, 30]).length, 2);
  for (const d of dueMarks(recs, T0 + 5 * 60_000 + 2000, [5, 30])) recs.push(markRecord(d.trade, d.horizonMin, T0 + 5 * 60_000 + 2000, ref(0.0008 * 1.01, 0), 0.000801));
  // Written to a file and read back (a restart): the +5 marks are done, the +30 ones still pending.
  const back = parseMarkoutLines(recs.map((r) => JSON.stringify(r)).join('\n') + '\n{"kind":"tr');
  assert.equal(back.length, 4);
  assert.equal(dueMarks(back, T0 + 5 * 60_000 + 3000, [5, 30]).length, 0);
  const due30 = dueMarks(back, T0 + 31 * 60_000, [5, 30]);
  assert.deepEqual(due30.map((d) => d.horizonMin), [30, 30]);
  assert.equal(markRecord(due30[0]!.trade, 30, T0 + 31 * 60_000, null, null).atRef, null, 'no reference: no mark value');
  for (const d of due30) back.push(markRecord(d.trade, 30, T0 + 31 * 60_000, ref(0.0008, 0), 0.0008));
  const sum = summarizeMarkouts(back, { horizonsMin: [5, 30] });
  assert.equal(sum.all.trades, 2);
  assert.equal(sum.pending, 0);
  near(sum.all.volumeA, 1100, 1e-6);
  near(sum.all.feesA, 3.3, 1e-6);
  // +5: XRD up 1%: the seller (s1) was wrong (+), the buyer (s2) right (-), the buyer is 10x larger: net negative.
  const h5 = sum.all.horizons['5']!;
  assert.ok(h5.markoutA < 0);
  near(h5.profitA, h5.feesA + h5.markoutA, 1e-9);
  near(h5.breakEvenFeeBps, (-h5.markoutA / 1100) * 10_000, 1e-9);
  near(sum.all.horizons['30']!.markoutA, 0, 1e-6, 'back at the trade price: no markout');
  assert.deepEqual(Object.keys(sum.bySize).sort(), ['100-1000', '>=1000'].sort());
  assert.deepEqual(Object.keys(sum.byFeeBps), ['30']);
  assert.equal(sum.all.horizons['5']!.poolMid.marked, 2);
});
