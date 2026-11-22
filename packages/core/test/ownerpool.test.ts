// OwnerPool as a venue: the quote arithmetic (checked against the ledger's own `quote` on Stokenet,
// 22 Nov 2026), reading a pool's state, the swap manifests (always with a minimum), and the Quoter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Decimal, Gateway, NETWORKS, OWNER_POOL_SWAP_FEE_XRD, OwnerPoolQuoteError, Quoter, fromAttos, marketOrderManifest, netOfGas,
  ownerPoolAfterSwap, ownerPoolCompute, ownerPoolQuote, parseOwnerPoolDetails, routeInstructions, routeMinimums, takeFillManifest, toAttos,
  type OwnerPoolState, type Pool, type Quote,
} from '../src/index.ts';

const net = NETWORKS.stokenet;
const XRD = net.xrd;
const TEUR = 'resource_tdx_2_1t5m4z5cv7ytwu8uh8d39ltf6rx852rhftlxqcghajh84e882sxknmw';
const BADGE = 'resource_tdx_2_1tk0nn5wxwynmrejetw3ef6jcmjaat7fyzs9vdqa590tfmfxku40enn';
const POOL = 'component_tdx_2_1czcpugh5ga9x6xzz8mtvhatlduhkm7qfnnqkuy5w96vzrv0rk6fj9v';
const PACKAGE = 'package_tdx_2_1p4tzj0gfzh8uzr9ca4y26jrwrevgu8uur7aukzmj3050vmp4y4vrzw';
const OTHER = 'component_tdx_2_1cpnd6hau0uqju4pjzgdusy8jnk0hlglc9zsclgzsd2ayqywgae3rvp';
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const SOLVER = { account: 'account_tdx_2_12yq4pxcsrlqc5dk6c297697nq5qvlw3wcycza87kl6s7vg3axh9hm9', badge: BADGE };

const state = (reserveA: string, reserveB: string, over: Partial<OwnerPoolState> = {}): OwnerPoolState => ({
  address: POOL, packageAddress: PACKAGE, resourceA: XRD, resourceB: TEUR, divisibilityA: 18, divisibilityB: 6, reserveA, reserveB, feeBps: 30, paused: false, ...over,
});
const ownerPool: Pool = { venue: 'ownerpool', address: POOL, kind: 'owner', tokens: [XRD, TEUR], feeRate: 0.003, tvlUsd: 0, volume24hUsd: 0, reserves: [20000, 16] };
const otherPool = (address: string, a: string, b: string, tvlUsd = 100): Pool => ({ venue: 'radixdex', address, kind: 'pool', tokens: [a, b], feeRate: 0.004, tvlUsd, volume24hUsd: 0, reserves: [1000, 1] });

// The ledger's own `quote`, previewed on Stokenet against the pool at state version 34726933
// (20024.982128134596923979 XRD / 16.010219 TEUR, 30 bps): `scripts/stokenet-owner-pool.ts quotes`.
const LEDGER = state('20024.982128134596923979', '16.010219');
const LEDGER_QUOTES: [string, string, string][] = [
  [XRD, '1', '0.000797'],
  [XRD, '7.123456789012345678', '0.005676'],
  [XRD, '50', '0.039756'],
  [XRD, '333.33', '0.261364'],
  [XRD, '1000', '0.759309'],
  [XRD, '2500.5', '1.772514'],
  [XRD, '6000', '3.682592'],
  [XRD, '19000', '7.78284'],
  [TEUR, '0.000123', '0.152591866696182225'],
  [TEUR, '0.01', '12.462341849868433595'],
  [TEUR, '0.05', '62.156978222665771651'],
  [TEUR, '0.123456', '152.775583057348132929'],
  [TEUR, '1', '1173.907808310705773425'],
  [TEUR, '3.3', '3413.632370520696437172'],
  [TEUR, '8', '6658.79259478125940006'],
  [TEUR, '15', '9671.289834128184173285'],
];
// And the ledger's refusals at the same state, by message.
const LEDGER_REFUSALS: [string, string, string][] = [
  [XRD, '0.000000000000000001', 'Trade too small'],
  [XRD, '0.001', 'Trade too small'],
  [TEUR, '0.000001', 'Trade too small'],
  [TEUR, '0.0000001', 'Amount has more decimal places than the token allows'],
  [TEUR, '1.0000005', 'Amount has more decimal places than the token allows'],
  [XRD, '0', 'Nothing to swap'],
  [BADGE, '1', 'Token is not in this pool'],
];

test('quote equals the ledger quote to the last unit, both directions, 16 sizes', () => {
  for (const [sell, amount, ledger] of LEDGER_QUOTES) assert.equal(ownerPoolQuote(LEDGER, sell, amount), ledger, `${amount} of ${sell === XRD ? 'XRD' : 'TEUR'}`);
});

test('quote fails where the ledger quote fails, with the same message', () => {
  for (const [sell, amount, message] of LEDGER_REFUSALS) {
    assert.throws(() => ownerPoolQuote(LEDGER, sell, amount), (e: unknown) => e instanceof OwnerPoolQuoteError && e.message === message, `${amount}`);
  }
  assert.throws(() => ownerPoolQuote({ ...LEDGER, paused: true }, XRD, '10'), /Swaps are paused/);
  // Paused is checked first, as on ledger (the paused preview on Stokenet failed "Swaps are paused" for a valid amount).
  assert.throws(() => ownerPoolQuote({ ...LEDGER, paused: true }, BADGE, '10'), /Swaps are paused/);
  assert.throws(() => ownerPoolQuote(state('0', '16'), XRD, '10'), /Pool is empty/);
  assert.throws(() => ownerPoolQuote(state('100', '0'), XRD, '10'), /Pool is empty/);
});

test('quotes and committed swaps on Stokenet: the amounts paid on ledger equal the quotes', () => {
  // Quoted by the ledger at 20,000 XRD / 16 TEUR (dry run), then committed swaps at the states they ran in.
  assert.equal(ownerPoolQuote(state('20000', '16'), XRD, '50'), '0.03978');
  assert.equal(ownerPoolQuote(state('20000', '16'), TEUR, '0.02'), '24.893975882556364131');
  // txid_tdx_2_103gvyrq70p7qzp64sm2pml5k4uknc86u09hmnaajqrcc4jyd2qhshn8cd4 paid 0.039781 TEUR for 50 XRD at 20100 / 16.08.
  const s1 = state('20100', '16.08');
  assert.equal(ownerPoolQuote(s1, XRD, '50'), '0.039781');
  // txid_tdx_2_1h54sp2pnarwa7cuqrcw7z5zw0axq6lehpd2x6utktqh3lu0m7f3qmn8mrd paid 25.017871865403076021 XRD for 0.02 TEUR next.
  const s2 = ownerPoolAfterSwap(s1, XRD, '50', '0.039781');
  assert.deepEqual([s2.reserveA, s2.reserveB], ['20150', '16.040219']);
  assert.equal(ownerPoolQuote(s2, TEUR, '0.02'), '25.017871865403076021');
});

test('rounding: fee up at the input places, output down at the output places, never more than the exact formula', () => {
  // 0-place input token, 30 bps: 10 units pay a fee of ceil(0.03) = 1, so 9 go in.
  const s = state('1000', '1000', { divisibilityA: 0, divisibilityB: 2 });
  assert.equal(ownerPoolQuote(s, XRD, '10'), '8.91'); // 1000 * 9 / 1009 = 8.919..., down to 2 places
  // A pseudo-random sweep: never above the exact constant-product amount, and k never falls.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 400; i++) {
    const divIn = [0, 2, 6, 18][i % 4]!, divOut = [18, 6, 0, 2][(i >> 2) % 4]!, fee = [0, 30, 500][i % 3]!;
    const rIn = new Decimal(rnd() * 1e6 + 1).toDecimalPlaces(divIn, Decimal.ROUND_DOWN), rOut = new Decimal(rnd() * 1e6 + 1).toDecimalPlaces(divOut, Decimal.ROUND_DOWN);
    const input = new Decimal(rnd() * rIn.toNumber() * 2 + 1).toDecimalPlaces(divIn, Decimal.ROUND_DOWN);
    if (!rIn.gt(0) || !rOut.gt(0) || !input.gt(0)) continue;
    const out = ownerPoolCompute({ rIn: toAttos(rIn.toFixed()), rOut: toAttos(rOut.toFixed()), divIn, divOut, input: toAttos(input.toFixed()), feeBps: fee });
    const feeAmt = input.mul(fee).div(10_000).toDecimalPlaces(divIn, Decimal.ROUND_UP);
    const eff = input.minus(feeAmt);
    const exact = rOut.mul(eff).div(rIn.plus(eff));
    const paid = new Decimal(fromAttos(out));
    assert.ok(paid.lte(exact), `paid ${paid} > exact ${exact}`);
    assert.ok(exact.minus(paid).lt(new Decimal(10).pow(-divOut).plus('1e-17')), `paid ${paid} too far under ${exact}`);
    assert.ok(rIn.plus(input).mul(rOut.minus(paid)).gte(rIn.mul(rOut)), 'k fell');
  }
});

test('arithmetic edges: attos conversions, overflow like the engine, fee eating the input', () => {
  assert.equal(toAttos('1.5'), 1_500_000_000_000_000_000n);
  assert.equal(fromAttos(toAttos('0.000000000000000001')), '0.000000000000000001');
  assert.equal(fromAttos(toAttos('20024.982128134596923979')), '20024.982128134596923979');
  assert.throws(() => toAttos('0.0000000000000000001'), /more than 18/);
  assert.throws(() => toAttos('1e5'), /Not a decimal/);
  // Input × bps beyond PreciseDecimal's range panics on ledger (audit I-4): here too.
  assert.throws(() => ownerPoolCompute({ rIn: toAttos('1'), rOut: toAttos('1'), divIn: 18, divOut: 18, input: toAttos('3000000000000000000000000000000000000000'), feeBps: 500 }), /Overflow/);
  // A 1-unit input of a 0-place token at any fee: the fee rounds up to the whole input.
  assert.equal(ownerPoolCompute({ rIn: toAttos('100'), rOut: toAttos('100'), divIn: 0, divOut: 18, input: toAttos('1'), feeBps: 30 }), 0n);
});

test('reads a pool from the Gateway response (recorded from Stokenet) and refuses look-alikes', () => {
  const item = {
    address: POOL,
    fungible_resources: { total_count: 2, items: [
      { aggregation_level: 'Global', resource_address: TEUR, amount: '16.010219' },
      { aggregation_level: 'Global', resource_address: XRD, amount: '20024.982128134596923979' },
    ] },
    details: { type: 'Component', package_address: PACKAGE, blueprint_name: 'OwnerPool', blueprint_version: '1.0.0', state: { kind: 'Tuple', type_name: 'OwnerPool', fields: [
      { kind: 'Reference', type_name: 'ResourceAddress', field_name: 'resource_a', value: XRD },
      { kind: 'Reference', type_name: 'ResourceAddress', field_name: 'resource_b', value: TEUR },
      { kind: 'U8', field_name: 'divisibility_a', value: '18' },
      { kind: 'U8', field_name: 'divisibility_b', value: '6' },
      { kind: 'Own', type_name: 'FungibleVault', field_name: 'vault_a', value: 'internal_vault_tdx_2_1tzzhd3rmnrh8k7hhrg2ezrtjgp4j2ca0aak8ws2dk57f53h6ftftxl' },
      { kind: 'Own', type_name: 'FungibleVault', field_name: 'vault_b', value: 'internal_vault_tdx_2_1tpya2lnzcx5uqpdhuls96krcg8ekl0586wmxfsz8jxv9yjw95tdasv' },
      { kind: 'U16', field_name: 'fee_bps', value: '30' },
      { kind: 'Bool', field_name: 'paused', value: false },
    ] } },
  };
  const s = parseOwnerPoolDetails(item, [PACKAGE], 34727874);
  assert.deepEqual(s, { ...LEDGER, stateVersion: 34727874 });
  assert.throws(() => parseOwnerPoolDetails(item, []), /not allow-listed/);
  assert.throws(() => parseOwnerPoolDetails({ ...item, details: { ...item.details, blueprint_name: 'Pool' } }, [PACKAGE]), /not an OwnerPool/);
  const badFee = JSON.parse(JSON.stringify(item));
  badFee.details.state.fields[6].value = '501';
  assert.throws(() => parseOwnerPoolDetails(badFee, [PACKAGE]), /fee_bps out of range/);
});

test('an OwnerPool swap always carries a minimum', () => {
  // Last (or only) pool: swap_with_minimum with the route's minimum.
  assert.deepEqual(routeInstructions([ownerPool], XRD, 'in', '0.0397'), [
    `CALL_METHOD Address("${POOL}") "swap_with_minimum" Bucket("in0") Decimal("0.0397");`,
  ]);
  assert.throws(() => routeInstructions([ownerPool], XRD), /needs a minimum/);
  assert.throws(() => routeInstructions([ownerPool], XRD, 'in', '0'), /must be positive/);
  // Quotes by preview only: allowed without one, as a zero minimum.
  assert.match(routeInstructions([ownerPool], XRD, 'in', undefined, { previewOnly: true })[0]!, /"swap_with_minimum" Bucket\("in0"\) Decimal\("0"\)/);
  // An OwnerPool before another pool: a plain swap, then the route's minimum asserted on the final token.
  const tusdPool = otherPool(OTHER, XRD, TUSD);
  assert.deepEqual(routeInstructions([ownerPool, tusdPool], TEUR, 'in', '12.5'), [
    `CALL_METHOD Address("${POOL}") "swap" Bucket("in0");`,
    `TAKE_ALL_FROM_WORKTOP Address("${XRD}") Bucket("in1");`,
    `CALL_METHOD Address("${OTHER}") "swap" Bucket("in1");`,
    `ASSERT_WORKTOP_CONTAINS Address("${TUSD}") Decimal("12.5");`,
  ]);
  // Routes without an OwnerPool are as before, minimum or not.
  assert.deepEqual(routeInstructions([tusdPool], XRD), [`CALL_METHOD Address("${OTHER}") "swap" Bucket("in0");`]);
  assert.deepEqual(routeInstructions([tusdPool], XRD, 'in', '5'), [`CALL_METHOD Address("${OTHER}") "swap" Bucket("in0");`]);
  // The wallet's market order: the pool's own minimum and the final assertion.
  const m = marketOrderManifest({ account: SOLVER.account, sell: XRD, sellAmount: '50', minBuyAmount: '0.0396', route: [ownerPool] });
  assert.match(m, /"swap_with_minimum" Bucket\("in0"\) Decimal\("0.0396"\);\nASSERT_WORKTOP_CONTAINS Address\("resource_tdx_2_1t5m4z5[a-z0-9]+"\) Decimal\("0.0396"\);/);
});

test('fill manifests through an OwnerPool: the minimum the taker\'s own minimum implies, per swap', () => {
  // Taker sells TEUR for XRD (charges from the proceeds): pool must bring minimum + solver's take.
  assert.deepEqual(routeMinimums({ at: 'proceeds', minBuyAmount: '24.5', solverTake: '1.2', buyDivisibility: 18 }), ['25.7']);
  // With 5 XRD from resting orders, the pool needs 5 less.
  assert.deepEqual(routeMinimums({ at: 'proceeds', minBuyAmount: '24.5', solverTake: '1.2', fromOthers: '5', buyDivisibility: 18 }), ['20.7']);
  // Taker sells XRD for TEUR (charges set aside first): rounded up to TEUR's 6 places, at least one unit.
  assert.deepEqual(routeMinimums({ at: 'input', minBuyAmount: '0.03950001', solverTake: '1.3', buyDivisibility: 6 }), ['0.039501']);
  assert.deepEqual(routeMinimums({ at: 'input', minBuyAmount: '1', solverTake: '1', fromOthers: '3', buyDivisibility: 6 }), ['0.000001']);
  // Through XRD: the first swap at least the take, the second at least the taker's minimum.
  assert.deepEqual(routeMinimums({ at: 'hop', minBuyAmount: '10.5', solverTake: '1.4', buyDivisibility: 6 }), ['1.4', '10.5']);

  const m = takeFillManifest({
    solver: SOLVER, feeLockXrd: '10', sell: TEUR, buy: XRD, makerPays: [], poolIn: '0.02', route: [ownerPool], solverTake: '1.2', xrd: XRD, chargeAt: 'proceeds',
    routeMins: routeMinimums({ at: 'proceeds', minBuyAmount: '23.5', solverTake: '1.2', buyDivisibility: 18 }),
  });
  assert.match(m, /CALL_METHOD Address\("component_tdx_2_1czcpugh[a-z0-9]+"\) "swap_with_minimum" Bucket\("in0"\) Decimal\("24.7"\);/);
  // Without minimums a fill through an OwnerPool cannot be built at all.
  assert.throws(() => takeFillManifest({ solver: SOLVER, feeLockXrd: '10', sell: TEUR, buy: XRD, makerPays: [], poolIn: '0.02', route: [ownerPool], solverTake: '1.2', xrd: XRD }), /needs a minimum/);
  const hop = takeFillManifest({
    solver: SOLVER, feeLockXrd: '10', sell: TEUR, buy: TUSD, makerPays: [], poolIn: '0.02', route: [ownerPool, otherPool(OTHER, XRD, TUSD)], solverTake: '1.4', xrd: XRD, chargeAt: 'hop',
    routeMins: ['1.4', '10.5'],
  });
  assert.match(hop, /"swap_with_minimum" Bucket\("in0"\) Decimal\("1.4"\);\nTAKE_FROM_WORKTOP Address\("resource_tdx_2_1tknx/);
  assert.match(hop, /CALL_METHOD Address\("component_tdx_2_1cpnd6[a-z0-9]+"\) "swap" Bucket\("hop0"\);\nTAKE_ALL_FROM_WORKTOP/);
});

test('routes are ranked by what is left after their network fee', () => {
  const q = (buyAmount: string, fee: string, sell = TEUR, buy = XRD): Quote => ({ sell, buy, sellAmount: '1', buyAmount, price: buyAmount, route: [], networkFeeXrd: fee });
  // Selling into XRD: 100 at 0.46 beats 100.05 at 0.53.
  assert.ok(netOfGas(q('100', '0.46'), XRD).gt(netOfGas(q('100.05', '0.53'), XRD)));
  // Selling 100 XRD: the fee is valued at the quote's own rate.
  assert.equal(netOfGas({ ...q('80', '0.5', XRD, TEUR), sellAmount: '100' }, XRD).toFixed(), '79.6');
  // No XRD in the pair: the amount alone.
  assert.equal(netOfGas(q('5', '1', TEUR, TUSD), XRD).toFixed(), '5');
});

/** A Gateway that serves one OwnerPool state and counts previews (there must be none for an OwnerPool quote). */
function fakeGateway(s: OwnerPoolState) {
  const calls = { details: 0, preview: 0 };
  const gw = new Gateway(net, { fetch: async () => { throw new Error('no network in tests'); } });
  gw.post = async (path: string, body: any) => {
    if (path === '/state/entity/details') {
      calls.details++;
      return { ledger_state: { state_version: 42 }, items: body.addresses.map((a: string) => a === POOL ? {
        address: POOL,
        fungible_resources: { items: [{ resource_address: s.resourceA, amount: s.reserveA }, { resource_address: s.resourceB, amount: s.reserveB }] },
        details: { type: 'Component', package_address: PACKAGE, blueprint_name: 'OwnerPool', state: { fields: [
          { field_name: 'resource_a', value: s.resourceA }, { field_name: 'resource_b', value: s.resourceB },
          { field_name: 'divisibility_a', value: String(s.divisibilityA) }, { field_name: 'divisibility_b', value: String(s.divisibilityB) },
          { field_name: 'fee_bps', value: String(s.feeBps) }, { field_name: 'paused', value: s.paused },
        ] } },
      } : { address: a, details: { divisibility: a === TEUR ? 6 : 18 } }) };
    }
    if (path === '/transaction/preview') { calls.preview++; throw new Error('no previews expected'); }
    if (path === '/status/gateway-status') return { ledger_state: { epoch: 1, state_version: 42, network: 'stokenet' } };
    throw new Error('unexpected ' + path);
  };
  return { gw, calls };
}

test('the Quoter quotes an OwnerPool from its state, with the measured network fee and no preview', async () => {
  const { gw, calls } = fakeGateway(LEDGER);
  const quoter = new Quoter(gw);
  const q = await quoter.simulate([ownerPool], XRD, '50');
  assert.equal(q?.buyAmount, '0.039756');
  assert.equal(q?.sellAmount, '50');
  assert.equal(q?.networkFeeXrd, OWNER_POOL_SWAP_FEE_XRD);
  assert.equal(q?.stateVersion, 42);
  // Amounts are cut to the sold token's places first, as for any venue (TEUR has 6).
  assert.equal((await quoter.simulate([ownerPool], TEUR, '0.0500009'))?.buyAmount, '62.156978222665771651');
  // Refused like the ledger refuses: no quote.
  assert.equal(await quoter.simulate([ownerPool], XRD, '0.001'), undefined);
  assert.match(quoter.lastFailure ?? '', /Trade too small/);
  assert.equal(calls.preview, 0);
  // State is read once and reused briefly.
  assert.ok(calls.details <= 3, `entity reads: ${calls.details}`);

  // Paused: nothing.
  const paused = fakeGateway({ ...LEDGER, paused: true });
  assert.equal(await new Quoter(paused.gw).simulate([ownerPool], XRD, '50'), undefined);
});

test('the Quoter always tries listed OwnerPools, and depth comes from their live reserves', async () => {
  const { gw } = fakeGateway(LEDGER);
  const quoter = new Quoter(gw);
  const deep = [1, 2, 3, 4].map((i) => otherPool(`component_tdx_2_1c${String(i).repeat(58)}`, XRD, TEUR, 1000 * i));
  const routes = quoter.candidateRoutes([...deep, ownerPool], XRD, TEUR, XRD);
  assert.equal(routes.length, 4);
  assert.ok(routes.some((r) => r[0] === ownerPool), 'the OwnerPool is a candidate although its TVL is lowest');
  // Every other pool fails to quote (no previews here): the OwnerPool wins.
  const best = await quoter.best([...deep, ownerPool], XRD, TEUR, '50', XRD);
  assert.equal(best?.route[0], ownerPool);
  assert.equal(best?.buyAmount, '0.039756');

  const market = { id: `${XRD}/${TEUR}`, base: { address: XRD, symbol: 'XRD', name: '' }, quote: { address: TEUR, symbol: 'TEUR', name: '' }, pools: [ownerPool], tvlUsd: 0, volume24hUsd: 0 };
  const depth = await quoter.poolDepth(market, { ...ownerPool, reserves: [1, 1] });
  assert.equal(depth.bids.length, 6);
  assert.equal(depth.asks.length, 6);
  // First bid: selling 0.2% of the live XRD reserve (40.049964... XRD).
  // (The ladder sizes from the reserve as a JavaScript number, then cuts to the token's places.)
  const sold = new Decimal(Number('20024.982128134596923979')).mul(0.002).toDecimalPlaces(18, Decimal.ROUND_DOWN);
  assert.equal(depth.bids[0]!.size, sold.toNumber());
  assert.equal(depth.bids[0]!.price, new Decimal(ownerPoolQuote(LEDGER, XRD, sold.toFixed())).div(sold).toNumber());
  // Bids fall and asks rise as size grows.
  for (let i = 1; i < 6; i++) { assert.ok(depth.bids[i]!.price < depth.bids[i - 1]!.price); assert.ok(depth.asks[i]!.price > depth.asks[i - 1]!.price); }
  assert.ok(depth.bids[0]!.price < depth.asks[0]!.price, 'the fee puts a spread between bid and ask');
});
