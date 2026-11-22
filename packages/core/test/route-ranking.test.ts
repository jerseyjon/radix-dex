// Route ranking net of each route's own network fee, for every venue (owner's decision, 22 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal, type Pool, Quoter, chargedSwapFeeXrd, listCaviarNine } from '../src/index.ts';
import { C9_HUSDC, HUSDC, LSULP, XRD, addCaviarNinePools, constantProduct, fakeAddress, fakeLedger, type SwapFn } from './fake-ledger.ts';

const pool = (venue: Pool['venue'], c: string, tokens: [string, string], tvlUsd = 1_000): Pool => ({
  venue, address: fakeAddress('component', c), kind: 'basic', tokens, feeRate: 0.003, tvlUsd, volume24hUsd: 0, reserves: [1_000_000, 1_000_000],
});

/** A flat-price pool: `rate` of the other token per unit sold, `fee` XRD for its swap (the fake preview adds 0.5 for the rest). */
const flat = (a: string, b: string, rate: number, fee: string): SwapFn => (sell, amount) =>
  sell === a ? { out: amount.mul(rate), resource: b, fee } : { out: amount.div(rate), resource: a, fee };

test('net of fee, across two non-OwnerPool venues: the cheaper route wins a small trade, the better price a large one (buying XRD)', async () => {
  const ledger = fakeLedger();
  // Ociswap pays 0.05% more but its swap costs 1.0 XRD; DefiPlaza costs 0.4. The gap in fee is 0.6 XRD.
  const oci = pool('ociswap', 'a', [HUSDC, XRD]), dfp = pool('defiplaza', 'b', [HUSDC, XRD]);
  ledger.swaps.set(oci.address, flat(HUSDC, XRD, 1000.5, '1.0'));
  ledger.swaps.set(dfp.address, flat(HUSDC, XRD, 1000, '0.4'));
  const q = new Quoter(ledger.gateway);
  // 1 hUSDC: 1,000.5 − 1.5 = 999.0 against 1,000 − 0.9 = 999.1.
  const small = await q.best([oci, dfp], HUSDC, XRD, '1', XRD);
  assert.equal(small?.route[0]!.venue, 'defiplaza');
  // 10 hUSDC: 10,005 − 1.5 against 10,000 − 0.9.
  const large = await q.best([oci, dfp], HUSDC, XRD, '10', XRD);
  assert.equal(large?.route[0]!.venue, 'ociswap');
});

test('net of fee when selling XRD: the fee is valued at one rate for all routes, with the same outcome', async () => {
  const ledger = fakeLedger();
  const oci = pool('ociswap', 'a', [XRD, LSULP]), dfp = pool('defiplaza', 'b', [XRD, LSULP]);
  ledger.swaps.set(oci.address, flat(XRD, LSULP, 0.0010005, '1.0'));
  ledger.swaps.set(dfp.address, flat(XRD, LSULP, 0.001, '0.4'));
  const q = new Quoter(ledger.gateway);
  // 100 XRD: 0.10005 − 1.5 × 0.0010005 = 0.09855 against 0.1 − 0.9 × 0.0010005 = 0.09910.
  assert.equal((await q.best([oci, dfp], XRD, LSULP, '100', XRD))?.route[0]!.venue, 'defiplaza');
  // 10,000 XRD: 10.005 − 0.0015 against 10 − 0.0009.
  assert.equal((await q.best([oci, dfp], XRD, LSULP, '10000', XRD))?.route[0]!.venue, 'ociswap');
});

test('net of fee in a pair without XRD: the fee is valued through one cached XRD probe of the bought token', async () => {
  const ledger = fakeLedger();
  // LSULP → hUSDC directly through two venues; hUSDC is worth 1,000 XRD (from an XRD/hUSDC pool used only for the rate).
  const oci = pool('ociswap', 'a', [LSULP, HUSDC]), dfp = pool('defiplaza', 'b', [LSULP, HUSDC]);
  const ref = pool('ociswap', 'r', [XRD, HUSDC]);
  ledger.swaps.set(oci.address, flat(LSULP, HUSDC, 1.0005, '1.0'));
  ledger.swaps.set(dfp.address, flat(LSULP, HUSDC, 1, '0.4'));
  ledger.swaps.set(ref.address, flat(XRD, HUSDC, 0.001, '0.4'));
  const q = new Quoter(ledger.gateway);
  // 1 LSULP: the 0.0005 hUSDC better price is worth 0.5 XRD, less than the 0.6 XRD saved.
  assert.equal((await q.best([oci, dfp, ref], LSULP, HUSDC, '1', XRD))?.route[0]!.venue, 'defiplaza');
  // 10 LSULP: 0.005 hUSDC (5 XRD) better is more than 0.6 XRD.
  assert.equal((await q.best([oci, dfp, ref], LSULP, HUSDC, '10', XRD))?.route[0]!.venue, 'ociswap');
  // The rate was probed once and reused.
  assert.equal(ledger.probes.get(`${ref.address}|${XRD}`)?.length, 1);
  // Without any XRD pool for the bought token the fee cannot be valued, and amount alone decides, as before.
  assert.equal((await new Quoter(ledger.gateway).best([oci, dfp], LSULP, HUSDC, '1', XRD))?.route[0]!.venue, 'ociswap');
});

test('the CaviarNine margin does not count against it in ranking, but is still charged', async () => {
  const ledger = fakeLedger();
  addCaviarNinePools(ledger);
  const { pools: c9 } = await listCaviarNine(ledger.gateway);
  const husdc = c9.find((p) => p.address === C9_HUSDC)!;
  const oci = pool('ociswap', 'a', [XRD, HUSDC]);
  // Same measured swap fee (0.4) on both. CaviarNine pays 0.2 XRD more on 1 hUSDC: it wins on measured fees,
  // and would lose by 0.1 XRD if its 0.3 XRD margin were counted.
  ledger.swaps.set(oci.address, flat(HUSDC, XRD, 1000, '0.4'));
  ledger.swaps.set(husdc.address, flat(HUSDC, XRD, 1000.2, '0.4'));
  const q = new Quoter(ledger.gateway);
  const best = await q.best([oci, husdc], HUSDC, XRD, '1', XRD);
  assert.equal(best?.route[0]!.venue, 'caviarnine');
  assert.equal(new Decimal(best!.networkFeeXrd).toFixed(), '0.9', 'the quote carries the fee as measured');
  assert.equal(chargedSwapFeeXrd(best!), '1.2', 'a fill is charged it plus the 0.3 XRD margin');
  // Other venues are charged exactly what was measured.
  const ociOnly = await q.best([oci], HUSDC, XRD, '1', XRD);
  assert.equal(chargedSwapFeeXrd(ociOnly!), ociOnly!.networkFeeXrd);
  // An unreadable measurement is passed through for the caller's own fallback.
  assert.equal(chargedSwapFeeXrd({ networkFeeXrd: '', route: [husdc] }), '');
});

test('a whole fill beats a partial one regardless of fee', async () => {
  const ledger = fakeLedger();
  // a takes only 60 of 100 hUSDC but pays far more per unit and costs almost nothing; b takes all 100, pays less, and costs 5 XRD.
  const a = pool('ociswap', 'a', [HUSDC, XRD]), b = pool('defiplaza', 'b', [HUSDC, XRD]);
  ledger.swaps.set(a.address, (sell, amount) => ({ out: Decimal.min(amount, 60).mul(2000), used: Decimal.min(amount, 60), resource: XRD, fee: '0.01' }));
  ledger.swaps.set(b.address, (sell, amount) => ({ out: amount.mul(900), resource: XRD, fee: '5' }));
  const q = new Quoter(ledger.gateway);
  const best = await q.best([a, b], HUSDC, XRD, '100', XRD);
  assert.equal(best?.route[0]!.address, b.address);
  assert.equal(best?.sellAmount, '100');
  // Two partial fills are compared net of fee like any others.
  ledger.swaps.set(b.address, (sell, amount) => ({ out: Decimal.min(amount, 60).mul(2000.01), used: Decimal.min(amount, 60), resource: XRD, fee: '5' }));
  assert.equal((await q.best([a, b], HUSDC, XRD, '100', XRD))?.route[0]!.address, a.address);
});

test('a constant-product sanity check: ranking still picks the deeper of two equal-fee pools', async () => {
  const ledger = fakeLedger();
  const deep = pool('ociswap', 'a', [HUSDC, XRD], 2_000), thin = pool('ociswap', 'b', [HUSDC, XRD], 1_000);
  ledger.swaps.set(deep.address, constantProduct(HUSDC, 1_000, XRD, 1_000_000));
  ledger.swaps.set(thin.address, constantProduct(HUSDC, 100, XRD, 100_000));
  const best = await new Quoter(ledger.gateway).best([deep, thin], HUSDC, XRD, '10', XRD);
  assert.equal(best?.route[0]!.address, deep.address);
});
