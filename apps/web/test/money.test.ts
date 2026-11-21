/// <reference types="node" />
// Order-form arithmetic, checked against exact decimal results written out by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Decimal } from '@radix-dex/core/browser';
import {
  bookContractPrice, exceeds, limitTerms, minAfterFees, networkFeeKnown, normaliseInput, numberToPlain, parsePlain, placesFor,
  shareOf, solverFees, toPlain, withSlippage,
} from '../src/money.ts';

const XRD = 'resource_xrd';

test('toPlain keeps 18 places, rounds down and never uses an exponent', () => {
  assert.equal(toPlain('0.123456789012345678'), '0.123456789012345678');
  assert.equal(toPlain('0.1234567890123456789'), '0.123456789012345678');
  assert.equal(toPlain('1e-18'), '0.000000000000000001');
  assert.equal(toPlain('1e-19'), '0');
  assert.equal(toPlain('1.2e21'), '1200000000000000000000');
  assert.equal(toPlain('123456789.123456789', 8), '123456789.12345678');
  assert.equal(toPlain('2.999', 0), '2');
  assert.equal(toPlain('-1'), '0');
  assert.equal(toPlain('abc'), '0');
});

test('parsePlain accepts only plain decimals', () => {
  assert.equal(parsePlain('1,234.5')?.toFixed(), '1234.5');
  assert.equal(parsePlain('1.')?.toFixed(), '1');
  for (const bad of ['0x10', '0b1010', '1e-5', '-5', '1.2.3', '', '.', 'NaN', '1.0000000000000000001']) assert.equal(parsePlain(bad), undefined, bad);
});

test('percentage buttons never exceed the balance and respect divisibility', () => {
  // The two cases from the bug report: floats rounded these up.
  assert.equal(shareOf('0.999999999999999999', 1, 18), '0.999999999999999999');
  assert.equal(shareOf('123456789.123456789', 1, 18), '123456789.123456789');
  assert.equal(shareOf('123456789.123456789', 1, 8), '123456789.12345678');
  assert.equal(shareOf('0.999999999999999999', 0.25, 18), '0.249999999999999999');
  assert.equal(shareOf('1.000001', 0.25, 6), '0.25');
  assert.equal(shareOf('7', 0.75, 0), '5');
  assert.equal(shareOf('12.34567891', 0.5, 8), '6.17283945');
  assert.equal(shareOf('0', 1, 18), undefined);
  assert.equal(shareOf('0.000000000000000001', 0.25, 18), undefined);
  for (const [bal, share, places] of [['1234.123456789012345678', 0.75, 18], ['0.3', 0.5, 6], ['99999999999.99999999', 1, 8]] as const) {
    assert.ok(!new Decimal(shareOf(bal, share, places)!).gt(bal));
  }
});

test('placesFor uses known divisibility, then XRD, then the balance as a lower bound', () => {
  assert.equal(placesFor({ address: 'a', divisibility: 6 }, XRD, '1.123456789'), 6);
  assert.equal(placesFor({ address: XRD }, XRD, '1.5'), 18);
  assert.equal(placesFor({ address: 'a' }, XRD, '1.12345678'), 8);
  assert.equal(placesFor({ address: 'a' }, XRD), 18);
});

test('pasted numbers are made plain or refused, never mangled', () => {
  assert.equal(normaliseInput('1e-5'), '0.00001');
  assert.equal(normaliseInput('2.5E3'), '2500');
  assert.equal(normaliseInput('1,234.5'), '1234.5');
  assert.equal(normaliseInput('.5'), '.5');
  assert.equal(normaliseInput('12.'), '12.');
  assert.equal(normaliseInput(''), '');
  for (const bad of ['-5e3abc', '-5', '1.2.3', '0x10', 'abc', '1e999']) assert.equal(normaliseInput(bad), undefined, bad);
});

test('limit terms are exact for 18-decimal amounts and extreme prices', () => {
  assert.deepEqual(limitTerms('sell', '0.1', '0.3'), { sellAmount: '0.3', gross: '0.03' });
  assert.deepEqual(limitTerms('buy', '0.1', '0.3'), { sellAmount: '0.03', gross: '0.3' });
  assert.deepEqual(limitTerms('sell', '1.000000000000000001', '1.000000000000000001'),
    { sellAmount: '1.000000000000000001', gross: '1.000000000000000002' }); // 1.000000000000000002000000000000000001, cut at 18 places
  assert.deepEqual(limitTerms('buy', '200000000', '0.00000001'), { sellAmount: '2', gross: '0.00000001' });
  assert.deepEqual(limitTerms('buy', '0.000000000001', '1000000000000'), { sellAmount: '1', gross: '1000000000000' });
  // A buy never spends more than price × size: rounded down to the quote token's places.
  assert.deepEqual(limitTerms('buy', '0.333333', '3.3333333', 6), { sellAmount: '1.111109', gross: '3.3333333' });
  assert.deepEqual(limitTerms('buy', '1', '0.5', 0), undefined);
  assert.equal(limitTerms('buy', '0', '1'), undefined);
  assert.equal(limitTerms('buy', '1e3', '1'), undefined);
});

test('a sell rounded to the token\'s places is priced on what is really sold', () => {
  assert.deepEqual(limitTerms('sell', '2', '1.2345678', 6), { sellAmount: '1.234567', gross: '2.469134' });
  assert.equal(limitTerms('sell', '2', '0.0000001', 6), undefined);
});

test('the fallback network allowance carries the margin; unpriced pairs are flagged', () => {
  // No route figure, buying XRD: gasXrd 1.5 × 1.25 = 1.875.
  const f = solverFees({ gross: '100', feeBps: 10, gasXrd: '1.5', margin: 1.25, buyIsXrd: true, sellIsXrd: false, sellAmount: '5' });
  assert.equal(f.network.toFixed(), '1.875');
  assert.equal(minAfterFees('100', f), '98.025');
  // Selling XRD: converted at the order's own rate (2 per XRD).
  assert.equal(solverFees({ gross: '100', feeBps: 0, gasXrd: '1.5', margin: 1.25, buyIsXrd: false, sellIsXrd: true, sellAmount: '50' }).network.toFixed(), '3.75');
  assert.equal(networkFeeKnown({ gasInBuyToken: null, buyIsXrd: false, sellIsXrd: false }), false);
  assert.equal(networkFeeKnown({ gasInBuyToken: '0.1', buyIsXrd: false, sellIsXrd: false }), true);
  assert.equal(networkFeeKnown({ buyIsXrd: true, sellIsXrd: false }), true);
});

test('signed minimum is gross less fees, exactly', () => {
  const gross = '1234.567890123456789012';
  const fees = solverFees({ gross, feeBps: 10, gasInBuyToken: '0.587649000000000001', gasXrd: '1', buyIsXrd: true, sellIsXrd: false, sellAmount: '5' });
  const expected = new Decimal(gross).minus('0.587649000000000001').minus(new Decimal(gross).times(10).div(10000));
  assert.equal(minAfterFees(gross, fees), expected.toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed());
  assert.equal(minAfterFees('100', solverFees({ gross: '100', feeBps: 10, gasXrd: '1', buyIsXrd: true, sellIsXrd: false, sellAmount: '5' })), '98.9');
  // Selling XRD with no quote: the fee is converted at the order's own rate (100 bought for 50 XRD sold: 1 XRD = 2).
  assert.equal(minAfterFees('100', solverFees({ gross: '100', feeBps: 0, gasXrd: '1', buyIsXrd: false, sellIsXrd: true, sellAmount: '50' })), '98');
  assert.equal(minAfterFees('1', solverFees({ gross: '1', feeBps: 10, gasXrd: '1', buyIsXrd: true, sellIsXrd: false, sellAmount: '5' })), undefined);
  // 0.1 + 0.2 style sums stay exact.
  assert.equal(minAfterFees('0.3', { network: new Decimal('0.1'), service: new Decimal('0.1') }), '0.1');
});

test('slippage floor is exact and rounded down', () => {
  assert.equal(withSlippage('100', 1), '99');
  assert.equal(withSlippage('0.000000000000000003', 50), '0.000000000000000001');
  assert.equal(withSlippage('0.000000000000000001', 1), undefined);
  assert.equal(withSlippage('123456789012.123456789012345678', 0.5), '122839505067.062839505067283949');
});

test('book buy price is inverted at 18 places in the maker\'s favour', () => {
  assert.deepEqual(bookContractPrice('sell', '0.0955739'), { ok: true, price: '0.0955739' });
  assert.deepEqual(bookContractPrice('buy', '4'), { ok: true, price: '0.25' });
  assert.deepEqual(bookContractPrice('buy', '3'), { ok: true, price: '0.333333333333333334' });
  // Wrapped bitcoin priced in XRD: the float version kept four significant figures.
  const r = bookContractPrice('buy', '200000000');
  assert.deepEqual(r, { ok: true, price: '0.000000005' });
  const r2 = bookContractPrice('buy', '119124744.3');
  assert.ok(r2.ok);
  if (r2.ok) {
    const inv = new Decimal(r2.price);
    assert.ok(inv.times('119124744.3').gte(1), 'rounded up: the maker gets at least the typed price');
    assert.ok(new Decimal(1).div(inv).minus('119124744.3').abs().div('119124744.3').lt('0.000001'));
  }
  assert.equal(bookContractPrice('buy', '20000000000000').ok, true); // 5e-14 is exact
  assert.equal(bookContractPrice('buy', '30000000000000').ok, false); // 3.33e-14 at 18 places is 20 ppm out
  assert.equal(bookContractPrice('buy', '0').ok, false);
  assert.deepEqual(bookContractPrice('buy', '0.000000000000000001'), { ok: true, price: '1000000000000000000' });
});

test('picked prices become plain strings', () => {
  assert.equal(numberToPlain(1e-7), '0.0000001');
  assert.equal(numberToPlain(1234.56), '1234.56');
  assert.equal(numberToPlain(0.0955739), '0.0955739');
  assert.equal(numberToPlain(NaN), '');
});

test('exceeds compares exactly', () => {
  assert.equal(exceeds('123456789.12345681', '123456789.123456789'), true);
  assert.equal(exceeds('0.999999999999999999', '0.999999999999999999'), false);
  assert.equal(exceeds('1', undefined), true);
});
