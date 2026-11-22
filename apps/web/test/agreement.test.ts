/// <reference types="node" />
// The order form's figures against the solver's own fill checks (core's planPoolFill and
// planXrdLegFill): an order the form signs must fill when the market reaches its price, and the
// user must never get less than signed. Since 22 Nov 2026 the solver's charges are always XRD:
// out of the XRD an order buys, out of the XRD it sells before the swap, or between two swaps
// through XRD. The quote figures mirror /api/quote: gasAllowanceXrd = gasXrd × 1.25.
//
// The market is modelled as a linear pool (a fixed rate, no price impact), which is the hardest
// case for the form: real pools pay a better rate on the smaller amount actually swapped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Decimal, GAS_SHORTFALL_TOLERANCE, planPoolFill, planXrdLegFill, reducedXrdCharges, retryXrdTake, xrdCharges as solverCharges } from '@radix-dex/core';
import { type ChargeAt, limitTerms, minAfterXrdCharges, positivePlain, withSlippage, xrdCharges } from '../src/money.ts';

const FEE_BPS = 10, MARGIN = 1.25;
const allowance = (gas: string) => new Decimal(gas).mul(MARGIN).toFixed();

/**
 * What the solver does at a market that pays `rate` of the bought token per unit sold (per XRD
 * for the second swap of a hop), with its own network fee estimate `gasNow` in XRD. Returns what
 * the user receives and what the solver keeps (XRD), or undefined if it would not fill.
 */
function solver(o: { at: ChargeAt; sellAmount: string; rate: string | [string, string]; xrdPerSell?: string; min: string; trigger: string; gasNow: string; buyPlaces: number }) {
  const S = new Decimal(o.sellAmount);
  // A rate may be given as a fraction, so a pool at exactly the order's price is exact.
  const swap = (x: Decimal) => (typeof o.rate === 'string' ? x.mul(o.rate) : x.mul(o.rate[0]).div(o.rate[1])).toDecimalPlaces(o.buyPlaces, Decimal.ROUND_DOWN);
  if (o.at === 'proceeds') {
    const plan = planPoolFill({ quotedOut: swap(S).toFixed(), minBuyAmount: o.min, limitBuyAmount: o.trigger, feeBps: FEE_BPS, gasInBuyToken: o.gasNow, divisibility: 18, gasShortfall: GAS_SHORTFALL_TOLERANCE });
    return plan && { received: plan.userReceives, keptXrd: plan.solverTake };
  }
  const base = o.at === 'input' ? S : S.mul(o.xrdPerSell!);
  const full = solverCharges(base, o.gasNow, FEE_BPS);
  const terms = { xrdBase: base.toFixed(), minBuyAmount: o.min, limitBuyAmount: o.trigger, buyDivisibility: o.buyPlaces };
  const first = planXrdLegFill({ ...terms, take: full.toFixed(), out: swap(base.minus(full)).toFixed() });
  if (first) return { received: first.userReceives, keptXrd: first.solverTake };
  // The allowance falls short of the estimate: a smaller take, as the server tries it.
  const need = new Decimal(o.min).mul('1.0005').gt(new Decimal(o.trigger).mul(base.minus(full)).div(base)) ? new Decimal(o.min).mul('1.0005') : new Decimal(o.trigger).mul(base.minus(full)).div(base);
  const t = retryXrdTake({ xrdBase: base.toFixed(), takeFull: full.toFixed(), takeMin: reducedXrdCharges(o.gasNow).toFixed(), out: swap(base.minus(full)).toFixed(), need: need.toFixed() });
  if (!t) return undefined;
  const second = planXrdLegFill({ ...terms, take: t.toFixed(), out: swap(base.minus(t)).toFixed() });
  return second && { received: second.userReceives, keptXrd: second.solverTake };
}

test('whole-only limit sell of XRD for hUSDC (6 places): fees taken from the XRD sold, fills at its price', () => {
  // XRD/hUSDC has a dollar token on the other side, but the rule is the same everywhere: the XRD side.
  // Sell 1000 XRD at 0.0005 hUSDC; the quote gives a network fee of 1.2 XRD.
  const t = limitTerms('sell', '0.0005', '1000', 18)!;
  assert.deepEqual(t, { sellAmount: '1000', gross: '0.5' });
  const c = xrdCharges({ at: 'input', gross: t.gross, sellAmount: t.sellAmount, gasXrd: allowance('1.2'), feeBps: FEE_BPS })!;
  assert.equal(c.totalXrd.toFixed(), '2.5'); // 1.5 allowance + 1 XRD (0.10% of 1000)
  assert.equal(c.swappedXrd!.toFixed(), '997.5');
  const min = minAfterXrdCharges(c, 6)!;
  assert.equal(min, '0.49875'); // 997.5 XRD at the user's price
  // At the price exactly: fills with the estimate, and with an estimate somewhat above it.
  for (const gasNow of ['1.2', '1.4', '1.5']) {
    const r = solver({ at: 'input', sellAmount: t.sellAmount, rate: '0.0005', min, trigger: t.gross, gasNow, buyPlaces: 6 });
    assert.ok(r, `fills with the solver's estimate at ${gasNow} XRD`);
    assert.ok(new Decimal(r.received).gte(min), 'never below the signed minimum');
    assert.ok(new Decimal(r.keptXrd).gte(new Decimal(gasNow).mul(1 - GAS_SHORTFALL_TOLERANCE)), 'the solver keeps at least its network fee less the tolerance');
  }
  // Below the price it waits.
  assert.equal(solver({ at: 'input', sellAmount: t.sellAmount, rate: '0.00049', min, trigger: t.gross, gasNow: '1.2', buyPlaces: 6 }), undefined);
});

test('whole-only limit buy of XRD with hUSDC (6 places): fees taken from the XRD received, fills at its price', () => {
  // Buy 1000.5 XRD at 0.00047123 hUSDC: spends 0.471465 hUSDC (rounded down to 6 places).
  const t = limitTerms('buy', '0.00047123', '1000.5', 6)!;
  assert.deepEqual(t, { sellAmount: '0.471465', gross: '1000.5' });
  const c = xrdCharges({ at: 'proceeds', gross: t.gross, sellAmount: t.sellAmount, gasXrd: allowance('1.2'), feeBps: FEE_BPS })!;
  const min = minAfterXrdCharges(c, 18)!;
  assert.equal(min, '997.9995'); // 1000.5 − 1.5 − 1.0005
  const rate: [string, string] = [t.gross, t.sellAmount];
  for (const gasNow of ['1.2', '2.5']) assert.ok(solver({ at: 'proceeds', sellAmount: t.sellAmount, rate, min, trigger: t.gross, gasNow, buyPlaces: 18 }), `fills at ${gasNow} XRD`);
  assert.equal(solver({ at: 'proceeds', sellAmount: t.sellAmount, rate, min, trigger: t.gross, gasNow: '2.7', buyPlaces: 18 }), undefined);
});

test('market buy of a small token with XRD: the form signs what the swap of XRD less fees brings, less slippage', () => {
  // Spend 100 XRD; the quote pays 2000 TOKEN (20 per XRD), network fee 1.2 XRD.
  const c = xrdCharges({ at: 'input', gross: '2000', sellAmount: '100', gasXrd: '1.2', feeBps: FEE_BPS })!;
  assert.equal(c.totalXrd.toFixed(), '1.3');
  assert.equal(c.swappedXrd!.toFixed(), '98.7');
  const net = minAfterXrdCharges(c, 18)!;
  assert.equal(net, '1974'); // you receive about
  const min = positivePlain(withSlippage(net, 1)!, 18)!;
  assert.equal(min, '1954.26');
  for (const rate of ['20', '19.9', '19.81']) {
    const r = solver({ at: 'input', sellAmount: '100', rate, min, trigger: min, gasNow: '1.2', buyPlaces: 18 });
    assert.ok(r, `fills at ${rate}`);
    assert.ok(new Decimal(r.received).gte(min));
    assert.equal(r.keptXrd, '1.3');
  }
  // Just past the slippage limit with the full charges: the solver takes less (down to its network fee
  // less the 25% tolerance, no service fee) rather than fail the user, as it always has.
  const edge = solver({ at: 'input', sellAmount: '100', rate: '19.79', min, trigger: min, gasNow: '1.2', buyPlaces: 18 })!;
  assert.ok(edge && new Decimal(edge.received).gte(min) && new Decimal(edge.keptXrd).gte('0.9') && new Decimal(edge.keptXrd).lt('1.3'));
  assert.equal(solver({ at: 'input', sellAmount: '100', rate: '19.72', min, trigger: min, gasNow: '1.2', buyPlaces: 18 }), undefined, 'past the slippage limit');
});

test('market sell of a small token for XRD: fees from the XRD received', () => {
  // Sell 5000 TOKEN; the quote pays 250 XRD, network fee 1.2 XRD.
  const c = xrdCharges({ at: 'proceeds', gross: '250', sellAmount: '5000', gasXrd: '1.2', feeBps: FEE_BPS })!;
  const net = minAfterXrdCharges(c, 18)!;
  assert.equal(net, '248.55'); // 250 − 1.2 − 0.25
  const min = withSlippage(net, 1)!;
  for (const rate of ['0.05', '0.0498']) assert.ok(solver({ at: 'proceeds', sellAmount: '5000', rate, min, trigger: min, gasNow: '1.2', buyPlaces: 18 }));
  assert.equal(solver({ at: 'proceeds', sellAmount: '5000', rate: '0.0491', min, trigger: min, gasNow: '1.2', buyPlaces: 18 }), undefined);
});

test('whole-only limit buys of tokens with 0, 6, 8 and 18 places with XRD fill at their price, never below the minimum', () => {
  for (const places of [0, 6, 8, 18]) {
    // Buy 1000 TOKEN at 0.05 XRD each: spend 50 XRD.
    const t = limitTerms('buy', '0.05', '1000', 18)!;
    const c = xrdCharges({ at: 'input', gross: t.gross, sellAmount: t.sellAmount, gasXrd: allowance('1.2'), feeBps: FEE_BPS })!;
    const min = minAfterXrdCharges(c, places)!;
    assert.equal(min, '969'); // (50 − 1.55) × 20, whatever the places
    const r = solver({ at: 'input', sellAmount: t.sellAmount, rate: '20', min, trigger: t.gross, gasNow: '1.2', buyPlaces: places });
    assert.ok(r, `fills with ${places} places`);
    assert.ok(new Decimal(r.received).gte(min));
    assert.equal(new Decimal(r.received).decimalPlaces() <= places, true);
  }
});

test('whole-only limit sell of a token for XRD in a DFP2-priced market goes through XRD: fees between the swaps', () => {
  // Sell 100 TOKEN at 1.5 DFP2 each (gross 150 DFP2). The quote: 100 TOKEN fetch 120 XRD, then 1.25 DFP2 per XRD; network fee 1.5 XRD (two swaps).
  const t = limitTerms('sell', '1.5', '100', 18)!;
  const c = xrdCharges({ at: 'hop', gross: t.gross, sellAmount: t.sellAmount, xrdBase: '120', gasXrd: allowance('1.5'), feeBps: FEE_BPS })!;
  assert.equal(c.totalXrd.toFixed(), '1.995'); // 1.875 allowance + 0.12
  const min = minAfterXrdCharges(c, 18)!;
  assert.equal(min, '147.50625'); // 150 × (120 − 1.995) / 120
  // At the user's price: 120 XRD → 150 DFP2 means 1.25 DFP2 per XRD.
  const r = solver({ at: 'hop', sellAmount: '100', xrdPerSell: '1.2', rate: '1.25', min, trigger: t.gross, gasNow: '1.5', buyPlaces: 18 })!;
  assert.ok(r && new Decimal(r.received).gte(min));
  assert.equal(r.keptXrd, '1.62');
  assert.equal(solver({ at: 'hop', sellAmount: '100', xrdPerSell: '1.2', rate: '1.2', min, trigger: t.gross, gasNow: '1.5', buyPlaces: 18 }), undefined, 'below its price');
});

test('an order signed by the old form (fees from what it buys) is still filled at its price by the new solver', () => {
  // Old form: sell 1000 XRD for hUSDC at 0.0005, allowance 0.000705 hUSDC (1.41 XRD) + 0.10% of the 0.5: minimum 0.498795.
  const r = solver({ at: 'input', sellAmount: '1000', rate: '0.0005', min: '0.498795', trigger: '0.5', gasNow: '1.2', buyPlaces: 6 });
  assert.ok(r, 'fills at its price');
  assert.ok(new Decimal(r.received).gte('0.498795'));
  assert.ok(new Decimal(r.keptXrd).gte('1.2'), 'the solver still covers its network fee, in XRD');
});
