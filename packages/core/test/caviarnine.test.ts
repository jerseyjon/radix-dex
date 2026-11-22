import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAVIARNINE_POOLS, Decimal, chargedSwapFeeXrd, type Market, type Pool, Quoter, caviarNinePool, filterAllowedPools, isBestEffort, listCaviarNine, poolsToProbe, swapsInTransaction,
} from '../src/index.ts';
import {
  C9_HUSDC, C9_LSULP, HUSDC, LSULP, OCI_BASIC_PACKAGE, XRD, addCaviarNinePools, constantProduct, fakeAddress, fakeLedger, quantaSwapDetails,
} from './fake-ledger.ts';

const ociPool = (c: string, tvlUsd: number, tokens: [string, string] = [XRD, HUSDC]): Pool => ({
  venue: 'ociswap', address: fakeAddress('component', c), kind: 'basic', tokens, feeRate: 0.003, tvlUsd, volume24hUsd: 0, reserves: [1_000_000, 900],
});

test('the CaviarNine listing reads both pools from the ledger: tokens, what each side can take in, and value', async () => {
  const ledger = fakeLedger();
  addCaviarNinePools(ledger);
  const { pools } = await listCaviarNine(ledger.gateway, { pricesUsd: { [XRD]: 0.0008 } });
  assert.deepEqual(pools.map((p) => p.address), [...CAVIARNINE_POOLS]);
  const [husdc, lsulp] = pools as [Pool, Pool];
  assert.deepEqual(husdc.tokens, [XRD, HUSDC]);
  assert.equal(husdc.venue, 'caviarnine');
  // Selling XRD in can take only what 5 hUSDC buys (~5,900 XRD); selling hUSDC in can take ~9,350 hUSDC (11M XRD).
  assert.ok(Math.abs(husdc.reserves[0] - 5 / 0.00085) < 10, String(husdc.reserves[0]));
  assert.ok(Math.abs(husdc.reserves[1] - 11_000_000 * 0.00085) < 10, String(husdc.reserves[1]));
  // Value: 11M XRD plus 5 hUSDC in XRD, at $0.0008.
  assert.ok(Math.abs(husdc.tvlUsd - (11_000_000 + 5 / 0.00085) * 0.0008) < 1, String(husdc.tvlUsd));
  assert.deepEqual(lsulp.tokens, [LSULP, XRD]);
  assert.ok(Math.abs(lsulp.reserves[0] - 1_200_000 / 1.22) < 100, 'LSULP side takes in ~983k LSULP');
  assert.ok(Math.abs(lsulp.reserves[1] - 53 * 1.22) < 0.1, 'XRD side takes in ~65 XRD');
  // No XRD price: still listed, valued at 0.
  assert.equal((await listCaviarNine(ledger.gateway)).pools[0]!.tvlUsd, 0);
});

test('a CaviarNine pool that cannot be read is left out, the other kept', async () => {
  const ledger = fakeLedger();
  addCaviarNinePools(ledger);
  const broken = quantaSwapDetails(C9_HUSDC, { resource: XRD, amount: '1' }, { resource: HUSDC, amount: '1' }, 0.00085);
  broken.details.state.fields = broken.details.state.fields.filter((f: any) => f.field_name !== 'tokens_y');
  ledger.details.set(C9_HUSDC, broken);
  assert.deepEqual((await listCaviarNine(ledger.gateway)).pools.map((p) => p.address), [C9_LSULP]);
  // Something that is not a QuantaSwap, or has a nonsense price, is no pool.
  assert.equal(caviarNinePool({ ...broken, details: { ...broken.details, blueprint_name: 'Other' } }, XRD, {}), undefined);
  const zero = quantaSwapDetails(C9_HUSDC, { resource: XRD, amount: '1' }, { resource: HUSDC, amount: '1' }, 0);
  assert.equal(caviarNinePool(zero, XRD, {}), undefined);
  // The Gateway itself failing is the caller's to catch (the market data does).
  ledger.down.add('/state/entity/details#vault');
  await assert.rejects(listCaviarNine(ledger.gateway));
});

test('the allow-list keeps CaviarNine pools only at its package and blueprint, and only as caviarnine', async () => {
  const ledger = fakeLedger();
  addCaviarNinePools(ledger);
  const { pools } = await listCaviarNine(ledger.gateway);
  // Plain entity details (no vault aggregation) as filterAllowedPools reads them: the same package and blueprint.
  const impostor = fakeAddress('component', 'i');
  ledger.details.set(impostor, quantaSwapDetails(impostor, { resource: XRD, amount: '1' }, { resource: HUSDC, amount: '1' }, 0.00085, OCI_BASIC_PACKAGE));
  const fake = { ...pools[0]!, address: impostor };
  const mislabelled = { ...pools[1]!, venue: 'ociswap' as const };
  const kept = await filterAllowedPools(ledger.gateway, [...pools, fake, mislabelled]);
  assert.deepEqual(kept.map((p) => `${p.venue}:${p.address}`), pools.map((p) => `caviarnine:${p.address}`));
  // Its funds are in its own vaults: no native pools to read trades from.
  assert.deepEqual(kept.map((p) => p.holders), [[], []]);
});

test('best-effort pools are probed in addition to the deepest ordinary pools, never in their place', () => {
  const q = new Quoter(fakeLedger().gateway);
  const c9: Pool = { ...ociPool('c', 9_000), venue: 'caviarnine', kind: 'shape' };
  const ord = ['a', 'b', 'd', 'e'].map((c, i) => ociPool(c, 2_000 - i * 100));
  assert.deepEqual(poolsToProbe([c9, ...ord], 3).map((p) => p.address), [...ord.slice(0, 3), c9].map((p) => p.address));
  // Direct routes: the three deepest ordinary pools, then CaviarNine, although its value locked is highest.
  const direct = q.candidateRoutes([c9, ...ord], HUSDC, XRD, XRD);
  assert.deepEqual(direct.map((r) => r[0]!.address), [...ord.slice(0, 3), c9].map((p) => p.address));
  // Through XRD: the ordinary route first (the solver uses the first), CaviarNine legs as extra routes.
  const foo = 'resource_rdx1' + 'o'.repeat(54);
  const fooPool = ociPool('g', 500, [foo, XRD]);
  const lsulp: Pool = { ...ociPool('l', 100, [LSULP, XRD]), venue: 'caviarnine' };
  const hop = q.candidateRoutes([c9, ...ord, fooPool], HUSDC, foo, XRD);
  assert.deepEqual(hop.map((r) => r.map((p) => p.address)), [[ord[0]!.address, fooPool.address], [c9.address, fooPool.address]]);
  // A token only CaviarNine trades still has a route through XRD.
  assert.deepEqual(q.candidateRoutes([lsulp, fooPool], LSULP, foo, XRD).map((r) => r.map((p) => p.venue)), [['caviarnine', 'ociswap']]);
  assert.ok(isBestEffort(c9) && !isBestEffort(ord[0]!));
});

test('quotes: CaviarNine is chosen only when it gives more, and a failure of it leaves the other venues untouched', async () => {
  const ledger = fakeLedger();
  addCaviarNinePools(ledger);
  const { pools: c9 } = await listCaviarNine(ledger.gateway);
  const oci = ociPool('a', 1_200);
  // Constant product at about 1,140 XRD per hUSDC, ~780k XRD deep; CaviarNine sells XRD at 1/0.00085 = 1,176 per hUSDC.
  ledger.swaps.set(oci.address, constantProduct(XRD, 780_000, HUSDC, 684));
  const q = new Quoter(ledger.gateway);
  const pools = [oci, ...c9];

  const big = await q.best(pools, HUSDC, XRD, '100', XRD);
  assert.equal(big?.route[0]!.venue, 'caviarnine', 'at 100 hUSDC the constant-product pool slips below CaviarNine');
  const alone = await q.best([oci], HUSDC, XRD, '100', XRD);
  assert.ok(new Decimal(big!.buyAmount).gt(alone!.buyAmount));
  // The quote carries the fee as measured (fake swap 1.0 + 0.5 base); a fill is charged it plus the CaviarNine margin.
  assert.equal(big!.networkFeeXrd, '1.500000');
  assert.equal(chargedSwapFeeXrd(big!), '1.8');

  // Selling XRD: CaviarNine holds 5 hUSDC, so 10,000 XRD panics there and goes to Ociswap without fuss.
  const errorsBefore = q.errors;
  const sellXrd = await q.best(pools, XRD, HUSDC, '10000', XRD);
  assert.equal(sellXrd?.route[0]!.venue, 'ociswap');
  assert.equal(q.errors, errorsBefore, 'a failed preview is no error');

  // Swaps disabled by its admin (every preview fails), or its previews erroring: Ociswap still quotes, the same as without CaviarNine.
  ledger.swaps.set(C9_HUSDC, () => ({ panic: 'swaps disabled' }));
  assert.equal((await q.best(pools, HUSDC, XRD, '100', XRD))?.buyAmount, alone!.buyAmount);
  ledger.previewDown.add(C9_HUSDC);
  assert.equal((await q.best(pools, HUSDC, XRD, '100', XRD))?.buyAmount, alone!.buyAmount);
});

test('a route that would hand part of the input back loses to one that takes it all, whatever it pays', async () => {
  const ledger = fakeLedger();
  const a = ociPool('a', 1_000, [XRD, LSULP]), b = ociPool('b', 900, [XRD, LSULP]);
  // a takes only 60 XRD (the rest handed back) but pays more for it than b pays for the whole 100.
  ledger.swaps.set(a.address, (sell, amount) => ({ out: Decimal.min(amount, 60).mul(2), used: Decimal.min(amount, 60), resource: LSULP }));
  ledger.swaps.set(b.address, (sell, amount) => ({ out: amount.mul(0.8), resource: LSULP }));
  const q = new Quoter(ledger.gateway);
  const best = await q.best([a, b], XRD, LSULP, '100', XRD);
  assert.equal(best?.route[0]!.address, b.address);
  // With nothing else, the partial one is still offered (the order form says how much the pools can take).
  assert.equal((await q.best([a], XRD, LSULP, '100', XRD))?.sellAmount, '60');
});

test('depth of a one-sided pool: each side probed within what it can take in, so no probe panics, and the thin side shows thin', async () => {
  const ledger = fakeLedger();
  addCaviarNinePools(ledger);
  const { pools } = await listCaviarNine(ledger.gateway);
  const pool = pools[0]!;
  const market: Market = { id: `${XRD}/${HUSDC}`, base: { address: XRD, symbol: 'XRD', name: '' }, quote: { address: HUSDC, symbol: 'hUSDC', name: '' }, pools: [pool], tvlUsd: 0, volume24hUsd: 0 };
  const d = await new Quoter(ledger.gateway).poolDepth(market, pool);
  assert.equal(d.bids.length, 6, 'every XRD probe succeeded');
  assert.equal(d.asks.length, 6, 'every hUSDC probe succeeded');
  const bidSize = d.bids.reduce((a, l) => a + l.size, 0), askSize = d.asks.reduce((a, l) => a + l.size, 0);
  // Bids: selling XRD into 5 hUSDC: at most a fifth of the ~5,900 XRD it could take. Asks: buying XRD with hUSDC: over a million XRD.
  assert.ok(bidSize <= 0.2 * 5 / 0.00085 + 1e-6 && bidSize > 1_000, String(bidSize));
  assert.ok(askSize > 1_000_000, String(askSize));
  assert.ok(d.bids.every((l) => Math.abs(l.price - 0.00085 * 0.997) < 1e-9) && d.asks.every((l) => Math.abs(l.price - 0.00085 / 0.997) < 1e-9));
  // Sized from raw balances instead (11M XRD), even the smallest XRD probe would have panicked.
  assert.ok(new Decimal(11_000_000 * 0.002).mul(0.00085).gt(5));
  const probes = ledger.probes.get(`${C9_HUSDC}|${XRD}`)!;
  assert.ok(probes.every((a) => a.mul(0.00085).lte(5)));
});

test('trades tape at a CaviarNine pool: its swaps read, its liquidity changes and its protocol fee vault not', () => {
  const ch = (entity_address: string, resource_address: string, balance_change: string) => ({ entity_address, resource_address, balance_change });
  const ev = (name: string, entity_address: string) => ({ name, emitter: { type: 'Method', entity: { entity_address }, object_module_id: 'Main' } });
  const feeVaults = fakeAddress('component', 'v');
  // As read on mainnet 22 Nov 2026: 179.39 XRD sold, 0.14 XRD of it to the fee-vaults component, 0.156675 hUSDC out.
  const tx = { transaction_status: 'CommittedSuccess', intent_hash: 'tx', confirmed_at: '2026-11-22T11:53:00.000Z',
    balance_changes: { fungible_balance_changes: [
      ch('account_a', XRD, '-179.388183041656'), ch('account_a', HUSDC, '0.156675'),
      ch(C9_HUSDC, XRD, '179.244744214637'), ch(C9_HUSDC, HUSDC, '-0.156675'),
      ch(feeVaults, XRD, '0.143438827019'), ch(feeVaults, HUSDC, '0.000014'),
    ] },
    receipt: { events: [ev('SwapVaultDepositEvent', feeVaults), ev('ProtocolFeeEvent', C9_HUSDC), ev('LiquidityFeeEvent', C9_HUSDC), ev('SwapEvent', C9_HUSDC), ev('ValuationEvent', C9_HUSDC)] } };
  const holders = new Set([C9_HUSDC]);
  const swaps = swapsInTransaction(tx, XRD, HUSDC, holders);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0]!.side, 'sell');
  assert.equal(swaps[0]!.entity, C9_HUSDC);
  // Size is what the pool kept, a little under what the trader paid: the protocol fee went to the fee vaults.
  assert.ok(Math.abs(swaps[0]!.size - 179.2447) < 1e-3);
  for (const name of ['AddLiquidityEvent', 'RemoveLiquidityEvent']) {
    assert.deepEqual(swapsInTransaction({ ...tx, receipt: { events: [ev(name, C9_HUSDC), ev('MintLiquidityReceiptEvent', C9_HUSDC)] } }, XRD, HUSDC, holders), [], name);
  }
});
