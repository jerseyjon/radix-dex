/// <reference types="node" />
// The order form's figures against the solver's own fill check (core's planPoolFill): an order the
// form signs must fill when the market reaches its price, and the user must never get less than signed.
// The quote figures mirror /api/quote: gasAllowanceInBuyToken = gasInBuyToken × 1.25, rounded up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Decimal, GAS_SHORTFALL_TOLERANCE, planPoolFill } from '@radix-dex/core';
import { limitTerms, minAfterFees, solverFees, withSlippage } from '../src/money.ts';

const FEE_BPS = 10, MARGIN = 1.25;
const allowance = (gas: string) => new Decimal(gas).mul(MARGIN).toDecimalPlaces(18, Decimal.ROUND_UP).toFixed();

/** What the solver decides at a given market outcome and its own estimate of the network fee then. */
const solver = (o: { out: string; min: string; trigger: string; gasNow: string; divisibility: number }) =>
  planPoolFill({ quotedOut: o.out, minBuyAmount: o.min, limitBuyAmount: o.trigger, feeBps: FEE_BPS, gasInBuyToken: o.gasNow, divisibility: o.divisibility, gasShortfall: GAS_SHORTFALL_TOLERANCE });

test('whole-only limit sell of XRD for a 6-place token fills at its price, within the gas tolerance', () => {
  // Sell 1000 XRD at 0.0005 hUSDC; the quote prices the fill's network fee at 0.000564 hUSDC.
  const t = limitTerms('sell', '0.0005', '1000', 18)!;
  assert.deepEqual(t, { sellAmount: '1000', gross: '0.5' });
  const gas = '0.000564';
  const fees = solverFees({ gross: t.gross, feeBps: FEE_BPS, gasInBuyToken: allowance(gas), gasXrd: '1.5', margin: MARGIN, buyIsXrd: false, sellIsXrd: true, sellAmount: t.sellAmount });
  const min = minAfterFees(t.gross, fees)!;
  assert.equal(min, '0.498795'); // 0.5 − 0.000705 − 0.0005
  // The market reaches the price exactly: fills with the quoted estimate, and with an estimate up to ~1.6× it.
  for (const gasNow of [gas, '0.0009', '0.00127']) {
    const plan = solver({ out: t.gross, min, trigger: t.gross, gasNow, divisibility: 6 });
    assert.ok(plan, `fills with the solver's estimate at ${gasNow}`);
    assert.ok(new Decimal(plan.userReceives).gte(min), 'never below the signed minimum');
  }
  // Beyond the tolerance, or below the price, it waits.
  assert.equal(solver({ out: t.gross, min, trigger: t.gross, gasNow: '0.0013', divisibility: 6 }), undefined);
  assert.equal(solver({ out: '0.4999', min, trigger: t.gross, gasNow: gas, divisibility: 6 }), undefined);
});

test('whole-only limit buy of XRD with a 6-place token: amounts rounded to the token, fills at its price', () => {
  // Buy 1000.5 XRD at 0.00047123 hUSDC: spends 0.471465 hUSDC (rounded down to 6 places).
  const t = limitTerms('buy', '0.00047123', '1000.5', 6)!;
  assert.deepEqual(t, { sellAmount: '0.471465', gross: '1000.5' });
  const gas = '1.2'; // XRD bought, so the estimate is in XRD
  const fees = solverFees({ gross: t.gross, feeBps: FEE_BPS, gasInBuyToken: allowance(gas), gasXrd: '1.5', margin: MARGIN, buyIsXrd: true, sellIsXrd: false, sellAmount: t.sellAmount });
  const min = minAfterFees(t.gross, fees)!;
  assert.equal(min, '997.9995'); // 1000.5 − 1.5 − 1.0005
  for (const gasNow of [gas, '2.5']) assert.ok(solver({ out: t.gross, min, trigger: t.gross, gasNow, divisibility: 18 }), `fills at ${gasNow} XRD`);
  assert.equal(solver({ out: t.gross, min, trigger: t.gross, gasNow: '2.7', divisibility: 18 }), undefined);
});

test('whole-only limit with no route figure uses gasXrd × margin, which the solver accepts at mainnet costs', () => {
  const t = limitTerms('buy', '0.0005', '1000', 6)!;
  const fees = solverFees({ gross: t.gross, feeBps: FEE_BPS, gasInBuyToken: null, gasXrd: '1.5', margin: MARGIN, buyIsXrd: true, sellIsXrd: false, sellAmount: t.sellAmount });
  assert.equal(fees.network.toFixed(), '1.875');
  const min = minAfterFees(t.gross, fees)!;
  // Mainnet fills cost 1.0 to 1.4 XRD.
  for (const gasNow of ['1.0', '1.4', '2.5']) assert.ok(solver({ out: t.gross, min, trigger: t.gross, gasNow, divisibility: 18 }), `fills at ${gasNow} XRD`);
});

test('market order: signed minimum is the quote less estimated fees less slippage; fills anywhere inside it', () => {
  // Sell 100 XRD; the quote pays 0.047 hUSDC, network fee 0.000564 hUSDC.
  const quoted = '0.047', gas = '0.000564';
  const fees = solverFees({ gross: quoted, feeBps: FEE_BPS, gasInBuyToken: gas, gasXrd: '1.5', margin: 1, buyIsXrd: false, sellIsXrd: true, sellAmount: '100' });
  const net = minAfterFees(quoted, fees)!;
  assert.equal(net, '0.046389');
  const min = withSlippage(net, 1)!;
  assert.equal(min, '0.04592511');
  // The form signs the minimum as the trigger too (limitBuyAmount = minBuyAmount).
  for (const out of ['0.047', '0.0468', '0.04654']) {
    const plan = solver({ out, min, trigger: min, gasNow: gas, divisibility: 6 });
    assert.ok(plan, `fills at ${out}`);
    assert.ok(new Decimal(plan.userReceives).gte(min));
  }
  assert.equal(solver({ out: '0.0459', min, trigger: min, gasNow: gas, divisibility: 6 }), undefined, 'past the slippage limit');
});
