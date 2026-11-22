// The split OwnerPool (cold owner badge, hot operator badge, inventory vaults): reading its state
// vault by vault, the pauses, the operator's budget arithmetic, the owner and operator manifests, and
// the Quoter never offering a paused pool. Fixtures recorded from the split pool on Stokenet
// (scripts/stokenet-owner-pool.ts, 22 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  Gateway, NETWORKS, OwnerPoolQuoteError, Quoter, buildTransaction, keyFromHex, ownerPoolAllowanceNow, ownerPoolAnchorDistance,
  ownerPoolDepositInventoryManifest, ownerPoolDepositManifest, ownerPoolDepthGrowthAttos, ownerPoolOperatorSetFeeManifest, ownerPoolOwnerRebalanceManifest,
  ownerPoolPlanRebalance, ownerPoolPriceDistanceAttos, ownerPoolQuote, ownerPoolRebalanceManifest, ownerPoolSetAnchorManifest, ownerPoolSetFeeManifest,
  ownerPoolSetOperatorLimitsManifest, ownerPoolSetOperatorManifest, ownerPoolSetOperatorPausedManifest, ownerPoolSetPausedManifest, ownerPoolSuggestedLimits,
  ownerPoolWithdrawInventoryManifest, ownerPoolWithdrawManifest, parseOwnerPoolDetails, toAttos, type OwnerPoolState, type Pool,
} from '../src/index.ts';

const net = NETWORKS.stokenet;
const XRD = net.xrd;
const TEUR = 'resource_tdx_2_1tknxk37t6tvqce4ce0jqv7ymydjfgjej4mw0wkdzep4wjfz8trvpj3';
const POOL = 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk';
const PACKAGE = 'package_tdx_2_1pklhl0ma6mepuxakg0pk2tgf4ej05uwgwu8gm0ajv5xa9acsjd4fll';
const OWNER_BADGE = 'resource_tdx_2_1tkzuvmezcle34heuuzleuuhu3p4g90ncst257llxuh5qrv2nfp9wc6';
const OP_BADGE = 'resource_tdx_2_1tkaa0etdc2q42skhlrm223a9yrk34ff3876gzndrgnjhcj2yr7wvff';
const OWNER = 'account_tdx_2_129q4ucv5v9j7ukhg5f3nxyle979ek0eyj6j45fxlpargmrcg2qhuaf';
const OPERATOR = 'account_tdx_2_128x3s0xqj8nj55st5s38mjfsfcc2ddyejcq2vjwuctwugy3ukwcj22';
const OTHER = 'component_tdx_2_1cpnd6hau0uqju4pjzgdusy8jnk0hlglc9zsclgzsd2ayqywgae3rvp';
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const V = {
  a: 'internal_vault_tdx_2_1tz5cf03n9tas976z36q9dglete6x8ymr3fnug45h00pzg5dlwgefmm',
  b: 'internal_vault_tdx_2_1tr273v88sxnwl3xvq0s7tr44a0j8g3cxgxpfw82uup92zlesg9jwf5',
  ia: 'internal_vault_tdx_2_1tqkpyngpeq7j8qgs0kanc4keyp05l5e890wqnekm3glcj9npeu44zf',
  ib: 'internal_vault_tdx_2_1tqhju6gnwzhqmvhma5vh7e76qyt57mu9k3kl8w9wrun7mvgvng09zr',
};

/** `/state/entity/details` with aggregation_level "Vault", as Stokenet returned it at state version 34759385 (epoch 24806). */
function item(o: { ra?: string; rb?: string; ia?: string; ib?: string; paused?: boolean; operatorPaused?: boolean; operator?: string | null; anchor?: [string, string]; allowance?: string; allowanceEpoch?: string } = {}) {
  const operator = o.operator === undefined ? OP_BADGE : o.operator;
  return {
    address: POOL,
    fungible_resources: { total_count: 2, items: [
      { aggregation_level: 'Vault', resource_address: TEUR, vaults: { total_count: 2, items: [
        { vault_address: V.ib, amount: o.ib ?? '0.8', last_updated_at_state_version: 34758946 },
        { vault_address: V.b, amount: o.rb ?? '15.988986', last_updated_at_state_version: 34759321 },
      ] } },
      { aggregation_level: 'Vault', resource_address: XRD, vaults: { total_count: 2, items: [
        { vault_address: V.ia, amount: o.ia ?? '1000', last_updated_at_state_version: 34758946 },
        { vault_address: V.a, amount: o.ra ?? '20013.969149307464428818', last_updated_at_state_version: 34759321 },
      ] } },
    ] },
    details: { type: 'Component', package_address: PACKAGE, blueprint_name: 'OwnerPool', state: { kind: 'Tuple', type_name: 'OwnerPool', fields: [
      { kind: 'Reference', type_name: 'ResourceAddress', field_name: 'resource_a', value: XRD },
      { kind: 'Reference', type_name: 'ResourceAddress', field_name: 'resource_b', value: TEUR },
      { kind: 'U8', field_name: 'divisibility_a', value: '18' },
      { kind: 'U8', field_name: 'divisibility_b', value: '6' },
      { kind: 'Own', type_name: 'FungibleVault', field_name: 'vault_a', value: V.a },
      { kind: 'Own', type_name: 'FungibleVault', field_name: 'vault_b', value: V.b },
      { kind: 'U16', field_name: 'fee_bps', value: '30' },
      { kind: 'Bool', field_name: 'paused', value: o.paused ?? false },
      { kind: 'Bool', field_name: 'operator_paused', value: o.operatorPaused ?? false },
      { kind: 'Own', type_name: 'FungibleVault', field_name: 'inventory_a', value: V.ia },
      { kind: 'Own', type_name: 'FungibleVault', field_name: 'inventory_b', value: V.ib },
      { kind: 'Reference', type_name: 'ResourceAddress', field_name: 'owner_badge', value: OWNER_BADGE },
      operator
        ? { kind: 'Enum', type_name: 'Option', field_name: 'operator', variant_id: '1', variant_name: 'Some', fields: [{ kind: 'Reference', type_name: 'ResourceAddress', value: operator }] }
        : { kind: 'Enum', type_name: 'Option', field_name: 'operator', variant_id: '0', variant_name: 'None', fields: [] },
      { kind: 'Tuple', type_name: 'OperatorLimits', field_name: 'limits', fields: [
        { kind: 'U16', field_name: 'move_budget_bps', value: '300' },
        { kind: 'U64', field_name: 'window_epochs', value: '72' },
        { kind: 'Decimal', field_name: 'max_reserve_a', value: '22000' },
        { kind: 'Decimal', field_name: 'max_reserve_b', value: '17.6' },
        { kind: 'Decimal', field_name: 'min_reserve_a', value: '10000' },
        { kind: 'Decimal', field_name: 'min_reserve_b', value: '8' },
        { kind: 'U16', field_name: 'min_fee_bps', value: '10' },
        { kind: 'U16', field_name: 'max_fee_bps', value: '100' },
      ] },
      { kind: 'Decimal', field_name: 'allowance', value: o.allowance ?? '0' },
      { kind: 'U64', field_name: 'allowance_epoch', value: o.allowanceEpoch ?? '24806' },
      { kind: 'Tuple', field_name: 'anchor', fields: [{ kind: 'Decimal', value: (o.anchor ?? ['1250', '1'])[0] }, { kind: 'Decimal', value: (o.anchor ?? ['1250', '1'])[1] }] },
    ] } },
  };
}
const parsed = (o: Parameters<typeof item>[0] = {}) => parseOwnerPoolDetails(item(o), [PACKAGE], 34759385);

test('a split pool is read vault by vault: the inventory is never part of the reserves', () => {
  const s = parsed();
  assert.equal(s.reserveA, '20013.969149307464428818');
  assert.equal(s.reserveB, '15.988986');
  assert.equal(s.paused, false);
  assert.deepEqual(s.split, {
    ownerPaused: false, operatorPaused: false, inventoryA: '1000', inventoryB: '0.8', ownerBadge: OWNER_BADGE, operator: OP_BADGE,
    limits: { moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '22000', maxReserveB: '17.6', minReserveA: '10000', minReserveB: '8', minFeeBps: 10, maxFeeBps: 100 },
    allowance: '0', allowanceEpoch: 24806, anchor: ['1250', '1'],
  });
  assert.equal(parsed({ operator: null }).split?.operator, null);
  // A per-token total would add the inventory to the curve: refused for a split pool.
  const global = item();
  global.fungible_resources.items = [
    { aggregation_level: 'Global', resource_address: TEUR, amount: '16.788986' },
    { aggregation_level: 'Global', resource_address: XRD, amount: '21013.969149307464428818' },
  ] as any;
  assert.throws(() => parseOwnerPoolDetails(global, [PACKAGE]), /aggregation_level "Vault"/);
  // An empty inventory vault the Gateway leaves out reads as zero.
  const noInv = item();
  for (const r of noInv.fungible_resources.items) r.vaults.items = r.vaults.items.filter((v) => v.vault_address !== V.ia && v.vault_address !== V.ib);
  assert.equal(parseOwnerPoolDetails(noInv, [PACKAGE]).split?.inventoryA, '0');
  // Malformed state is refused.
  const bad = item();
  (bad.details.state.fields[12] as any).variant_name = 'Maybe'; (bad.details.state.fields[12] as any).variant_id = '7';
  assert.throws(() => parseOwnerPoolDetails(bad, [PACKAGE]), /Option<ResourceAddress>/);
});

test('either pause closes the pool: quotes fail "Swaps are paused" like the ledger', () => {
  for (const [paused, operatorPaused] of [[true, false], [false, true], [true, true]] as const) {
    const s = parsed({ paused, operatorPaused });
    assert.equal(s.paused, true);
    assert.throws(() => ownerPoolQuote(s, XRD, '10'), (e: unknown) => e instanceof OwnerPoolQuoteError && e.message === 'Swaps are paused');
  }
  // Revoked operator: the owner's pause is on (lib.rs set_operator), so the pool is closed.
  assert.equal(parsed({ operator: null, paused: true }).paused, true);
  assert.ok(Number(ownerPoolQuote(parsed(), XRD, '10')) > 0);
});

test('the operator allowance refills like lib.rs allowance_now (Decimal division truncates)', () => {
  const s = parsed();
  assert.equal(ownerPoolAllowanceNow(s, 24806), '0');
  assert.equal(ownerPoolAllowanceNow(s, 24807), '0.000416666666666666'); // 0.03 / 72, truncated
  assert.equal(ownerPoolAllowanceNow(s, 24806 + 36), '0.015');
  assert.equal(ownerPoolAllowanceNow(s, 24806 + 72), '0.03');
  assert.equal(ownerPoolAllowanceNow(s, 24806 + 1000), '0.03');
  // Stored allowance plus accrual, capped at one budget.
  assert.equal(ownerPoolAllowanceNow(parsed({ allowance: '0.029' }), 24806 + 10), '0.03');
  assert.equal(ownerPoolAllowanceNow(parsed({ allowance: '0.01' }), 24806 + 1), '0.010416666666666666');
  // An epoch before the stored one (a stale clock) accrues nothing.
  assert.equal(ownerPoolAllowanceNow(parsed({ allowance: '0.01' }), 24000), '0.01');
});

test('cost terms on attos, rounded up, as lib.rs', () => {
  const a = (v: string) => toAttos(v);
  // d(P, P') for 20000/16 -> 19980/16: 20000/19980 - 1 = 0.001001001001001001001..., rounded up.
  assert.equal(ownerPoolPriceDistanceAttos(a('20000'), a('16'), a('19980'), a('16')), 1_001_001_001_001_002n);
  assert.equal(ownerPoolPriceDistanceAttos(a('20000'), a('16'), a('40000'), a('32')), 0n);
  // Depth: k'/k - 1 over 2; none for a shrink.
  assert.equal(ownerPoolDepthGrowthAttos(a('100'), a('100'), a('110'), a('110')), 105_000_000_000_000_000n);
  assert.equal(ownerPoolDepthGrowthAttos(a('100'), a('100'), a('90'), a('100')), 0n);
});

test('planning a rebalance: what it costs, and every refusal with the ledger\'s message, in its order', () => {
  const at = 24806 + 72; // full budget 0.03
  const s = parsed({ ra: '20000', rb: '16' });
  // One-sided removal of 0.1% of XRD: only the price term (anchor = current price here).
  const r = ownerPoolPlanRebalance(s, '-20', '0', at);
  assert.equal(r.cost, '0.001001001001001002');
  assert.equal(r.allowanceBefore, '0.03');
  assert.equal(r.allowanceAfter, '0.028998998998998998');
  assert.deepEqual(r.anchor, ['19980', '16']);
  // A proportional decrease is free and leaves the anchor where it was.
  const free = ownerPoolPlanRebalance(s, '-2000', '-1.6', at);
  assert.equal(free.cost, '0');
  assert.deepEqual(free.anchor, ['1250', '1']);
  // A one-sided add pays price and depth: 1.5x roughly.
  const add = ownerPoolPlanRebalance(s, '0', '0.016', at);
  assert.equal(add.cost, '0.0015'); // 0.001 price + 0.0005 depth
  const err = (f: () => unknown, msg: string) => assert.throws(f, (e: unknown) => e instanceof OwnerPoolQuoteError && e.message === msg, msg);
  err(() => ownerPoolPlanRebalance(parsed({ paused: true }), '-1', '0', at), 'Paused by the owner');
  // The operator's own pause does not stop rebalance (only swaps).
  assert.ok(ownerPoolPlanRebalance(parsed({ ra: '20000', rb: '16', operatorPaused: true }), '-1', '0', at));
  err(() => ownerPoolPlanRebalance(parsed({ ra: '0', rb: '16' }), '1', '0', at), 'Pool is empty');
  err(() => ownerPoolPlanRebalance(s, '-20000', '0', at), 'Operator cannot empty a side');
  err(() => ownerPoolPlanRebalance(s, '0', '1.61', at), "Above the operator's reserve cap");
  err(() => ownerPoolPlanRebalance(s, '-10001', '0', at), "Below the operator's reserve floor");
  err(() => ownerPoolPlanRebalance(s, '0', '-8.1', at), "Below the operator's reserve floor");
  err(() => ownerPoolPlanRebalance(s, '1001', '0', at), 'Not enough inventory of token A');
  err(() => ownerPoolPlanRebalance(parsed({ ra: '20000', rb: '16', anchor: ['0', '0'] }), '-20', '0', at), 'No anchor price');
  err(() => ownerPoolPlanRebalance(s, '-1000', '0', at), 'Operator price-move limit'); // 5.26% > 3%
  err(() => ownerPoolPlanRebalance(s, '-20', '0', 24806), 'Operator price-move limit'); // nothing accrued yet
  // A pool without the split cannot be planned.
  const { split: _, ...plain } = s;
  assert.throws(() => ownerPoolPlanRebalance(plain as OwnerPoolState, '-1', '0', at), /not a split OwnerPool/);
});

test('suggested limits and the anchor check', () => {
  assert.deepEqual(ownerPoolSuggestedLimits({ reserveA: '20000', reserveB: '16', divisibilityA: 18, divisibilityB: 6 }), {
    moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '22000', maxReserveB: '17.6', minReserveA: '10000', minReserveB: '8', minFeeBps: 10, maxFeeBps: 100,
  });
  // Caps round up and floors down to the token's places.
  const odd = ownerPoolSuggestedLimits({ reserveA: '1', reserveB: '0.000003', divisibilityA: 18, divisibilityB: 6 });
  assert.equal(odd.maxReserveB, '0.000004');
  assert.equal(odd.minReserveB, '0.000001');
  assert.equal(ownerPoolAnchorDistance({ reserveA: '20000', reserveB: '16' }, ['1250', '1']), 0);
  assert.ok(Math.abs(ownerPoolAnchorDistance({ reserveA: '20000', reserveB: '16' }, ['1000', '1']) - 0.25) < 1e-12);
});

test('owner and operator manifests: shapes, guards, and they all compile', async () => {
  const owner = { account: OWNER, badge: OWNER_BADGE };
  const op = { account: OPERATOR, badge: OP_BADGE };
  const base = { pool: POOL, owner };
  const proofOwner = `CALL_METHOD Address("${OWNER}") "create_proof_of_amount" Address("${OWNER_BADGE}") Decimal("1");`;
  const proofOp = `CALL_METHOD Address("${OPERATOR}") "create_proof_of_amount" Address("${OP_BADGE}") Decimal("1");`;

  assert.equal(ownerPoolSetOperatorManifest({ ...base, operator: op, anchor: ['1250', '1'] }),
    [proofOwner, proofOp, `CALL_METHOD Address("${POOL}") "set_operator" Some(Address("${OP_BADGE}")) Some(Tuple(Decimal("1250"), Decimal("1")));`].join('\n'));
  assert.throws(() => ownerPoolSetOperatorManifest({ ...base, operator: op }), /State the anchor price/);
  assert.throws(() => ownerPoolSetOperatorManifest({ ...base, operator: owner, anchor: ['1', '1'] }), /must not be the owner badge/);
  assert.throws(() => ownerPoolSetOperatorManifest({ ...base, operator: op, anchor: ['0', '1'] }), /Bad anchor/);
  // Revoke: no anchor needed; the owner's pause comes on by itself on ledger.
  assert.equal(ownerPoolSetOperatorManifest({ ...base, operator: null }), [proofOwner, `CALL_METHOD Address("${POOL}") "set_operator" None None;`].join('\n'));
  // Restore in one transaction: appoint and reopen.
  assert.match(ownerPoolSetOperatorManifest({ ...base, operator: op, anchor: ['1250', '1'], reopen: true }), /"set_operator" .*;\nCALL_METHOD Address\("[^"]+"\) "set_paused" false;$/);

  assert.equal(ownerPoolSetOperatorLimitsManifest({ ...base, limits: ownerPoolSuggestedLimits({ reserveA: '20000', reserveB: '16', divisibilityA: 18, divisibilityB: 6 }) }),
    [proofOwner, `CALL_METHOD Address("${POOL}") "set_operator_limits" 300u16 72u64 Decimal("22000") Decimal("17.6") Decimal("10000") Decimal("8") 10u16 100u16;`].join('\n'));
  const lim = { moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '1', maxReserveB: '1', minReserveA: '0', minReserveB: '0', minFeeBps: 10, maxFeeBps: 100 };
  assert.throws(() => ownerPoolSetOperatorLimitsManifest({ ...base, limits: { ...lim, minReserveA: '2' } }), /Floor above cap/);
  assert.throws(() => ownerPoolSetOperatorLimitsManifest({ ...base, limits: { ...lim, maxFeeBps: 501 } }), /Bad fee range/);
  assert.throws(() => ownerPoolSetOperatorLimitsManifest({ ...base, limits: { ...lim, windowEpochs: 0 } }), /Window/);
  assert.throws(() => ownerPoolSetOperatorLimitsManifest({ ...base, limits: { ...lim, moveBudgetBps: 10_001 } }), /Budget too high/);

  // The operator's rebalance: signed amounts, the reserves guard, the operator's own badge.
  assert.equal(ownerPoolRebalanceManifest({ pool: POOL, operator: op, toReserveA: '-20', toReserveB: '0.0016', expected: ['20000', '16'], feeLockXrd: '10' }), [
    `CALL_METHOD Address("${OPERATOR}") "lock_fee" Decimal("10");`, proofOp,
    `CALL_METHOD Address("${POOL}") "rebalance" Decimal("-20") Decimal("0.0016") Some(Tuple(Decimal("20000"), Decimal("16")));`,
  ].join('\n'));
  assert.throws(() => ownerPoolRebalanceManifest({ pool: POOL, operator: op, toReserveA: '0.0000000000000000001', toReserveB: '0' }), /18 decimal places/);
  assert.match(ownerPoolOwnerRebalanceManifest({ ...base, toReserveA: '20', toReserveB: '-0.1' }), /"owner_rebalance" Decimal\("20"\) Decimal\("-0.1"\) None;$/);
  assert.match(ownerPoolSetAnchorManifest({ ...base, anchor: ['1250', '1'], expected: ['20000', '16'] }), /"set_anchor" Decimal\("1250"\) Decimal\("1"\) Some\(Tuple\(Decimal\("20000"\), Decimal\("16"\)\)\);$/);
  assert.match(ownerPoolDepositManifest({ ...base, resourceA: XRD, resourceB: TEUR, amountB: '0.5' }), /TAKE_ALL_FROM_WORKTOP Address\("[^"]+"\) Bucket\("b"\);\nCALL_METHOD Address\("[^"]+"\) "deposit" None Some\(Bucket\("b"\)\) None;$/);
  assert.match(ownerPoolWithdrawManifest({ ...base, amountA: '100', amountB: '0', expected: ['1', '2'] }), /"withdraw" Decimal\("100"\) Decimal\("0"\) Some\(Tuple\(Decimal\("1"\), Decimal\("2"\)\)\);\nCALL_METHOD Address\("account_[^"]+"\) "deposit_batch" Expression\("ENTIRE_WORKTOP"\);$/);
  assert.match(ownerPoolSetFeeManifest({ ...base, feeBps: 50 }), /"set_fee" 50u16;$/);
  assert.throws(() => ownerPoolSetFeeManifest({ ...base, feeBps: 501 }), /out of range/);

  // Every builder's output compiles into a transaction (offline; nothing is previewed or sent here).
  const key = keyFromHex(randomBytes(32).toString('hex'));
  const all = [
    ownerPoolDepositManifest({ ...base, feeLockXrd: '20', resourceA: XRD, resourceB: TEUR, amountA: '100', amountB: '0.08', expected: ['20000', '16'] }),
    ownerPoolWithdrawManifest({ ...base, amountA: '100', amountB: '0.05' }),
    ownerPoolDepositInventoryManifest({ ...base, resourceA: XRD, resourceB: TEUR, amountA: '1000' }),
    ownerPoolWithdrawInventoryManifest({ ...base, amountA: '1', amountB: '0.1' }),
    ownerPoolOwnerRebalanceManifest({ ...base, toReserveA: '-1', toReserveB: '0', expected: ['20000', '16'] }),
    ownerPoolSetAnchorManifest({ ...base, anchor: ['1250', '1'] }),
    ownerPoolSetOperatorManifest({ ...base, operator: op, anchor: ['1250', '1'], reopen: true }),
    ownerPoolSetOperatorManifest({ ...base, operator: null }),
    ownerPoolSetOperatorLimitsManifest({ ...base, limits: lim }),
    ownerPoolSetPausedManifest({ ...base, paused: true }),
    ownerPoolSetFeeManifest({ ...base, feeBps: 30 }),
    ownerPoolRebalanceManifest({ pool: POOL, operator: op, toReserveA: '-20', toReserveB: '0', expected: ['20000', '16'] }),
    ownerPoolOperatorSetFeeManifest({ pool: POOL, operator: op, feeBps: 40 }),
    ownerPoolSetOperatorPausedManifest({ pool: POOL, signer: op, paused: true }),
  ];
  for (const manifest of all) {
    const tx = await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: 1, endEpoch: 10 }, notary: key });
    assert.ok(tx.intentHashId.startsWith('txid_tdx_2_'), manifest);
  }
});

/** A Gateway serving the split pool (state from `item`) and counting previews. */
function fakeGateway(o: Parameters<typeof item>[0]) {
  const calls = { preview: 0 };
  const gw = new Gateway(net, { fetch: async () => { throw new Error('no network in tests'); } });
  gw.post = async (path: string, body: any) => {
    if (path === '/state/entity/details') {
      if (body.addresses.includes(POOL)) assert.equal(body.aggregation_level, 'Vault');
      return { ledger_state: { state_version: 42 }, items: body.addresses.map((a: string) => a === POOL ? item(o) : { address: a, details: { divisibility: a === TEUR ? 6 : 18 } }) };
    }
    if (path === '/transaction/preview') { calls.preview++; throw new Error('no previews expected'); }
    if (path === '/status/gateway-status') return { ledger_state: { epoch: 1, state_version: 42, network: 'stokenet' } };
    throw new Error('unexpected ' + path);
  };
  return { gw, calls };
}

test('the Quoter never offers a paused split pool, alone or as a leg, and never previews through it', async () => {
  const ownerPool: Pool = { venue: 'ownerpool', address: POOL, kind: 'owner', tokens: [XRD, TEUR], feeRate: 0.003, tvlUsd: 0, volume24hUsd: 0, reserves: [0, 0] };
  const tusdPool: Pool = { venue: 'radixdex', address: OTHER, kind: 'pool', tokens: [XRD, TUSD], feeRate: 0.004, tvlUsd: 100, volume24hUsd: 0, reserves: [1000, 1] };
  // Open: quoted from its reserves (not reserves + inventory).
  const open = fakeGateway({});
  const q = await new Quoter(open.gw).simulate([ownerPool], XRD, '50');
  assert.equal(q?.buyAmount, ownerPoolQuote(parsed(), XRD, '50'));
  for (const o of [{ paused: true }, { operatorPaused: true }, { operator: null, paused: true }]) {
    const { gw, calls } = fakeGateway(o);
    const quoter = new Quoter(gw);
    assert.equal(await quoter.simulate([ownerPool], XRD, '50'), undefined);
    assert.match(quoter.lastFailure ?? '', /Swaps are paused/);
    // As the first leg of a two-hop route: refused before any preview.
    assert.equal(await quoter.simulate([ownerPool, tusdPool], TEUR, '0.01'), undefined);
    assert.match(quoter.lastFailure ?? '', /Swaps are paused/);
    assert.equal(calls.preview, 0);
    assert.equal(await quoter.best([ownerPool], XRD, TEUR, '50', XRD), undefined);
    const market = { id: `${XRD}/${TEUR}`, base: { address: XRD, symbol: 'XRD', name: '' }, quote: { address: TEUR, symbol: 'TEUR', name: '' }, pools: [ownerPool], tvlUsd: 0, volume24hUsd: 0 };
    assert.deepEqual(await quoter.poolDepth(market, ownerPool), { bids: [], asks: [] });
  }
});
