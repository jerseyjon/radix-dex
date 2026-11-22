// The API side of the XRD-only fee rule (22 Nov 2026): what /api/config, /api/quote and /api/markets
// publish, and the refusal of orders the solver could not charge in XRD.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { NETWORKS, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent } from '@radix-dex/core';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const net = NETWORKS.stokenet;
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const OTHER = 'resource_tdx_2_1t5jcmwqx39ym7fw0hrlpnxwechr0mzlgulcfcye59qm9y9fa5uvdrd';
const LONE = 'resource_tdx_2_1nfxxxxxxxxxxglcllrxxxxxxxxx002350006550xxxxxxxxxqtcnwk';
const BADGE = 'resource_tdx_2_1tktzk58223qax8lmv6zvtdfy3zvejhzx8pd4ylftqq75c2jjfcecmv';
let server: Server, base: string, app: Awaited<ReturnType<typeof createApp>>;

// Linear pools: XRD/TUSD at 0.08 TUSD per XRD, XRD/OTHER at 2 OTHER per XRD; LONE trades against TUSD only.
const rate = (sell: string, buy: string): number => ({
  [`${net.xrd}>${TUSD}`]: 0.08, [`${TUSD}>${net.xrd}`]: 12.5, [`${net.xrd}>${OTHER}`]: 2, [`${OTHER}>${net.xrd}`]: 0.5, [`${TUSD}>${LONE}`]: 1, [`${LONE}>${TUSD}`]: 1,
} as Record<string, number>)[`${sell}>${buy}`] ?? 0;
const pool = (a: string, b: string, address: string) => ({ venue: 'ociswap', address, kind: 'basic', tokens: [a, b], feeRate: 0, tvlUsd: 1, volume24hUsd: 0, reserves: [1, 1] }) as any;
const tok = (address: string, symbol: string) => ({ address, symbol, name: '' });

before(async () => {
  app = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: BADGE }));
  app.data.markets = [
    { id: `${net.xrd}/${TUSD}`, base: tok(net.xrd, 'XRD'), quote: tok(TUSD, 'TUSD'), pools: [], tvlUsd: 0, volume24hUsd: 0 },
    { id: `${OTHER}/${TUSD}`, base: tok(OTHER, 'OTH'), quote: tok(TUSD, 'TUSD'), pools: [], tvlUsd: 0, volume24hUsd: 0 },
    { id: `${LONE}/${TUSD}`, base: tok(LONE, 'LONE'), quote: tok(TUSD, 'TUSD'), pools: [], tvlUsd: 0, volume24hUsd: 0 },
  ];
  app.data.pools = [
    pool(net.xrd, TUSD, 'component_tdx_2_1cqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'),
    pool(net.xrd, OTHER, 'component_tdx_2_1crrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr'),
    pool(TUSD, LONE, 'component_tdx_2_1cpppppppppppppppppppppppppppppppppppppppppppppppppppp'),
  ];
  app.data.quoter.divisibility = async (r: string) => (r === TUSD ? 6 : 18);
  app.data.quoter.simulate = (async (route: any[], sell: string, amount: any) => {
    let t = sell, v = Number(amount);
    for (const p of route) { const nx = p.tokens[0] === t ? p.tokens[1] : p.tokens[0]; v *= rate(t, nx); t = nx; }
    return { sell, buy: t, sellAmount: String(amount), buyAmount: String(v), price: '0', route, networkFeeXrd: String(0.5 * route.length) };
  }) as any;
  app.data.quoter.best = (async (pools: any[], sell: string, buy: string, amount: string) => {
    const r = app.data.quoter.candidateRoutes(pools, sell, buy, net.xrd)[0];
    return r ? app.data.quoter.simulate(r, sell, amount) : undefined;
  }) as any;
  server = app.api.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};

async function order(sell: string, buy: string, sellAmount: string) {
  const key = keyFromHex(randomBytes(32).toString('hex'));
  const account = await accountOf(key, net.networkId);
  const p = { account, sell, sellAmount, buy, minBuyAmount: '1' };
  const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: BADGE }), { networkId: net.networkId, startEpoch: 1, endEpoch: 100, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, key);
  return { ...p, orderKeyHex: orderKeyFromSecret(randomBytes(32).toString('hex')), signedPartialTransactionHex: signed.signedPartialTransactionHex };
}

test('config publishes that fees are taken in XRD, and the fee-conversion token list', async () => {
  const r = await call('GET', '/api/config');
  assert.equal(r.json.fees.token, net.xrd);
  assert.equal(r.json.fees.takenIn, 'XRD');
  assert.deepEqual(r.json.fees.feeTokens, [TUSD]);
  assert.equal(r.json.fees.convertsFeeTokens, false);
  assert.deepEqual(loadConfig({ DEX_NETWORK: 'stokenet', DEX_FEE_TOKENS: ` ${TUSD} ,${TUSD}` }).feeTokens, [TUSD]);
  assert.deepEqual(loadConfig({ DEX_NETWORK: 'stokenet', DEX_FEE_TOKENS: '' }).feeTokens, []);
  assert.throws(() => loadConfig({ DEX_NETWORK: 'stokenet', DEX_FEE_TOKENS: 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv' }), /DEX_FEE_TOKENS/);
  assert.equal(loadConfig({}).feeTokens.length, 2);
});

test('quote says where the XRD charges are taken, and gives them in XRD', async () => {
  const sell = await call('GET', `/api/quote?sell=${net.xrd}&buy=${TUSD}&amount=100`);
  assert.equal(sell.status, 200);
  assert.deepEqual([sell.json.feeAt, sell.json.feeToken, sell.json.gasXrd, sell.json.gasAllowanceXrd, sell.json.xrdBase], ['sell', net.xrd, '1', '1.25', '100']);
  const buy = await call('GET', `/api/quote?sell=${TUSD}&buy=${net.xrd}&amount=10`);
  assert.deepEqual([buy.json.feeAt, buy.json.xrdBase, buy.json.gasInBuyToken, buy.json.gasAllowanceInBuyToken], ['buy', '125', '1', '1.25']);
  // Neither token XRD: quoted along the route through XRD, the base being what the first swap produces.
  const hop = await call('GET', `/api/quote?sell=${TUSD}&buy=${OTHER}&amount=10`);
  assert.deepEqual([hop.json.feeAt, hop.json.xrdBase, hop.json.route.length, hop.json.gasXrd, hop.json.buyAmount], ['hop', '125', 2, '1.5', '250']);
  // No route through XRD: quoted (the pool exists) but the solver cannot fill it.
  const lone = await call('GET', `/api/quote?sell=${TUSD}&buy=${LONE}&amount=10`);
  assert.deepEqual([lone.json.feeAt, lone.json.feeToken, lone.json.xrdBase], [null, null, null]);
});

test('an order between two tokens with no route through XRD is refused with the reason; one with a route is accepted', async () => {
  const r = await call('POST', '/api/orders', await order(TUSD, LONE, '1'));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /fees are taken in XRD/);
  assert.match(r.json.error, /In parts/);
  assert.equal((await call('POST', '/api/orders', await order(TUSD, OTHER, '1'))).status, 200);
  const markets = await call('GET', '/api/markets');
  assert.deepEqual(markets.json.map((m: any) => m.solverFills), [true, true, false]);
});
