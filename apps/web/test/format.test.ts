/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanAmount, fmtAmount, fmtAxisPrice, fmtPrice, pricePrecision, shownPrice } from '../src/format.ts';

test('fmtAmount: no exponents, sensible units', () => {
  assert.equal(fmtAmount(9e-7), '0.0000009');
  assert.equal(fmtAmount(0.00012345), '0.0001234');
  assert.equal(fmtAmount(0.5), '0.5');
  assert.equal(fmtAmount(1.2345e20), '123,450,000T');
  assert.equal(fmtAmount(123456789012), '123.46B');
  assert.equal(fmtAmount(999999), '1.00M');
  assert.equal(fmtAmount(999_999_999), '1.00B');
  assert.equal(fmtAmount(12345), '12.3K');
  assert.equal(fmtAmount(9999.99), '9,999.99');
  assert.equal(fmtAmount('0'), '0');
  assert.equal(fmtAmount(''), '—');
  assert.equal(fmtAmount(undefined), '—');
  assert.ok(!/e/i.test(fmtAmount(1e-25)));
});

test('fmtPrice: tiny prices do not read as 0', () => {
  assert.equal(fmtPrice(0.00095123), '0.00095123');
  assert.equal(fmtPrice(1234.5678), '1,234.6');
  assert.notEqual(fmtPrice(1e-20), '0');
  assert.equal(fmtPrice(0), '—');
});

test('axis prices for large values have no decimals and are grouped', () => {
  assert.equal(pricePrecision(119124744), 0);
  assert.equal(fmtAxisPrice(119124744.03, pricePrecision(119124744)), '119,124,744');
  assert.equal(pricePrecision(0.00087), 8);
  assert.equal(pricePrecision(1.2), 4);
});

test('cleanAmount', () => {
  assert.equal(cleanAmount('1.50'), '1.5');
  assert.equal(cleanAmount('1,000'), '1000');
  assert.equal(cleanAmount('0'), undefined);
  assert.equal(cleanAmount('1e5'), undefined);
});

test('shownPrice: the number fmtPrice displays, for picking', () => {
  assert.equal(shownPrice(0.000951234567), 0.00095123);
  assert.equal(shownPrice(1.234567), 1.2346);
  assert.equal(shownPrice(1234.5678), 1234.6);
  assert.equal(shownPrice(0.1 + 0.2), 0.3);
  assert.equal(shownPrice(1.234567e-20), 1.2346e-20);
  assert.equal(shownPrice(null), undefined);
  assert.equal(shownPrice(0), undefined);
  assert.equal(shownPrice(NaN), undefined);
  for (const v of [0.000951234567, 1.234567, 1234.5678, 0.0421337]) assert.equal(fmtPrice(shownPrice(v)), fmtPrice(v));
});
