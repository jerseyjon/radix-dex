import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  NETWORKS, OrderRejected, accountOf, addr, buildMarkets, dec, keyFromHex, limitOrderManifest, marketOrderManifest, mergeDepth,
  orderKeyFromSecret, routePath, signSubintent, validateLimitOrder, type OrderRules, type OrderSubmission, type Pool,
} from '../src/index.ts';

const net = NETWORKS.stokenet;
const XRD = net.xrd;
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const BADGE = 'resource_tdx_2_1tktzk58223qax8lmv6zvtdfy3zvejhzx8pd4ylftqq75c2jjfcecmv';
const now = Math.floor(Date.now() / 1000);
const rules: OrderRules = { networkId: net.networkId, solverBadge: BADGE, nowSec: now, maxLifetimeSec: 30 * 86400, minLifetimeSec: 30 };
const window = (expiresAt = now + 3600) => ({ networkId: net.networkId, startEpoch: 100, endEpoch: 200, expiresAt });

async function makeOrder(over: Partial<OrderSubmission> = {}, manifestOver: Partial<Parameters<typeof limitOrderManifest>[0]> = {}, expiresAt?: number) {
  const key = keyFromHex(randomBytes(32).toString('hex'));
  const account = await accountOf(key, net.networkId);
  const base = { account, sell: XRD, sellAmount: '100', buy: TUSD, minBuyAmount: '9' };
  const signed = await signSubintent(limitOrderManifest({ ...base, solverBadge: BADGE, ...manifestOver }), window(expiresAt), key);
  const submission: OrderSubmission = { ...base, orderKeyHex: orderKeyFromSecret('11'.repeat(32)), signedPartialTransactionHex: signed.signedPartialTransactionHex, ...over };
  return { key, account, submission };
}

test('a well-formed order is accepted', async () => {
  const { submission } = await makeOrder();
  const v = await validateLimitOrder(submission, rules);
  assert.equal(v.expiresAt, now + 3600);
  assert.match(v.hashId, /^subtxid_tdx_2_1/);
});

test('stated parameters must match what was signed', async () => {
  const { submission } = await makeOrder();
  await assert.rejects(validateLimitOrder({ ...submission, minBuyAmount: '8' }, rules), OrderRejected);
  await assert.rejects(validateLimitOrder({ ...submission, sellAmount: '101' }, rules), OrderRejected);
  await assert.rejects(validateLimitOrder({ ...submission, buy: BADGE }, rules), OrderRejected);
});

test('an order pinned to a different solver badge is rejected', async () => {
  const { submission } = await makeOrder({}, { solverBadge: TUSD });
  await assert.rejects(validateLimitOrder(submission, rules), /template/);
});

test('an order for somebody else\'s account is rejected', async () => {
  const victim = await accountOf(keyFromHex(randomBytes(32).toString('hex')), net.networkId);
  // Attacker signs a manifest that withdraws from the victim's account.
  const { submission } = await makeOrder({ account: victim }, { account: victim });
  await assert.rejects(validateLimitOrder(submission, rules), /not signed by the key/);
});

test('a manifest with an extra instruction is rejected', async () => {
  const key = keyFromHex(randomBytes(32).toString('hex'));
  const account = await accountOf(key, net.networkId);
  const base = { account, sell: XRD, sellAmount: '100', buy: TUSD, minBuyAmount: '9' };
  const evil = limitOrderManifest({ ...base, solverBadge: BADGE }).replace('YIELD_TO_PARENT;', `CALL_METHOD ${addr(account)} "withdraw" ${addr(XRD)} ${dec('5')};\nYIELD_TO_PARENT;`);
  const signed = await signSubintent(evil, window(), key);
  await assert.rejects(validateLimitOrder({ ...base, orderKeyHex: '00'.repeat(32), signedPartialTransactionHex: signed.signedPartialTransactionHex }, rules), /template/);
});

test('expiry must be present and inside the allowed window', async () => {
  await assert.rejects(validateLimitOrder((await makeOrder({}, {}, now + 5)).submission, rules), /too soon/);
  await assert.rejects(validateLimitOrder((await makeOrder({}, {}, now + 40 * 86400)).submission, rules), /too far/);
});

test('a tampered signature is rejected', async () => {
  const { submission } = await makeOrder();
  const hex = submission.signedPartialTransactionHex;
  // Flip one nibble near the end, inside the signature bytes.
  const i = hex.length - 20;
  const tampered = hex.slice(0, i) + (hex[i] === 'a' ? 'b' : 'a') + hex.slice(i + 1);
  await assert.rejects(validateLimitOrder({ ...submission, signedPartialTransactionHex: tampered }, rules), OrderRejected);
});

test('registry orders must carry the stated order key', async () => {
  const registry = 'component_tdx_2_1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxyulkzl';
  const k = orderKeyFromSecret('22'.repeat(32));
  const { submission } = await makeOrder({ orderKeyHex: k }, { registry: { component: registry, orderKeyHex: k } });
  await validateLimitOrder(submission, { ...rules, registry });
  await assert.rejects(validateLimitOrder({ ...submission, orderKeyHex: orderKeyFromSecret('33'.repeat(32)) }, { ...rules, registry }), /template/);
  await assert.rejects(validateLimitOrder(submission, rules), /template/);
});

test('manifest helpers refuse injection', () => {
  assert.throws(() => addr('resource_rdx1abc") ; CALL_METHOD'), /Not a Radix address/);
  assert.throws(() => dec('-1'), /Not a valid amount/);
  assert.throws(() => dec('1e400'), /Not a valid amount|Invalid/);
  assert.equal(dec('1.0000000000000000019'), 'Decimal("1.000000000000000001")');
});

const pool = (venue: Pool['venue'], a: string, b: string, tvl: number): Pool => ({
  venue, address: 'component_tdx_2_1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxyulkzl', kind: 'basic', tokens: [a, b], feeRate: 0.003, tvlUsd: tvl, volume24hUsd: 0, reserves: [1, 1],
});

test('routes and market orders', () => {
  const p1 = pool('ociswap', TUSD, XRD, 10), p2 = pool('defiplaza', XRD, BADGE, 5);
  assert.deepEqual(routePath([p1, p2], TUSD), [TUSD, XRD, BADGE]);
  assert.throws(() => routePath([p2], TUSD), /does not trade/);
  const m = marketOrderManifest({ account: 'account_tdx_2_12yq4pxcsrlqc5dk6c297697nq5qvlw3wcycza87kl6s7vg3axh9hm9', sell: TUSD, sellAmount: '5', minBuyAmount: '1', route: [p1, p2] });
  assert.match(m, new RegExp(`ASSERT_WORKTOP_CONTAINS Address\\("${BADGE}"\\) Decimal\\("1"\\);`));
  assert.equal((m.match(/"swap"/g) ?? []).length, 2);
});

test('markets pick the quote currency by priority and depth merges sorted', () => {
  const tokens = new Map([[XRD, { address: XRD, symbol: 'XRD', name: '' }], [TUSD, { address: TUSD, symbol: 'TUSD', name: '' }], [BADGE, { address: BADGE, symbol: 'B', name: '' }]]);
  const ms = buildMarkets([pool('ociswap', XRD, TUSD, 10), pool('defiplaza', TUSD, XRD, 7), pool('ociswap', BADGE, XRD, 3)], tokens, [TUSD, XRD]);
  assert.equal(ms[0]!.id, `${XRD}/${TUSD}`);
  assert.equal(ms[0]!.pools.length, 2);
  assert.equal(ms[1]!.id, `${BADGE}/${XRD}`);
  const d = mergeDepth('m', [{ bids: [{ price: 1, size: 1, source: 'a' }], asks: [{ price: 3, size: 1, source: 'a' }] }, { bids: [{ price: 2, size: 1, source: 'b' }], asks: [{ price: 2.5, size: 1, source: 'b' }] }]);
  assert.deepEqual(d.bids.map((l) => l.price), [2, 1]);
  assert.deepEqual(d.asks.map((l) => l.price), [2.5, 3]);
  assert.equal(d.mid, 2.25);
});
