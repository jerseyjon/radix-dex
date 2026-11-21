import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { NETWORKS, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent } from '@radix-dex/core';
import { createApp, orderLevels } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { fillGasXrd } from '../src/solver.ts';

const net = NETWORKS.stokenet;
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const BADGE = 'resource_tdx_2_1tktzk58223qax8lmv6zvtdfy3zvejhzx8pd4ylftqq75c2jjfcecmv';
let server: Server, base: string, app: Awaited<ReturnType<typeof createApp>>;

before(async () => {
  app = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: BADGE, DEX_MAX_OPEN_ORDERS: '2' }));
  server = app.api.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};

async function order(secret = randomBytes(32).toString('hex'), key = keyFromHex(randomBytes(32).toString('hex'))) {
  const account = await accountOf(key, net.networkId);
  const p = { account, sell: net.xrd, sellAmount: '100', buy: TUSD, minBuyAmount: '9' };
  const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: BADGE }), { networkId: net.networkId, startEpoch: 1, endEpoch: 100, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, key);
  return { secret, key, account, body: { ...p, orderKeyHex: orderKeyFromSecret(secret), signedPartialTransactionHex: signed.signedPartialTransactionHex } };
}

test('config endpoint answers and describes limit orders', async () => {
  const r = await call('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.limitOrders.enabled, true);
  assert.equal(typeof r.json.limitOrders.marketOrderLifetimeSec, 'number');
});

test('an order keeps its trigger and kind; a trigger below the signed minimum is refused', async () => {
  const o = await order();
  const placed = await call('POST', '/api/orders', { ...o.body, limitBuyAmount: String(Number(o.body.minBuyAmount) * 1.02) });
  assert.equal(placed.status, 200);
  const stored = app.store.get(placed.json.id)!;
  assert.equal(stored.kind, 'limit');
  assert.equal(Number(stored.limitBuyAmount), Number(o.body.minBuyAmount) * 1.02);
  app.store.markCancelled(placed.json.id);
  const low = await order();
  assert.equal((await call('POST', '/api/orders', { ...low.body, limitBuyAmount: String(Number(low.body.minBuyAmount) * 0.5) })).status, 400);
  // A market order may not rest: an hour's lifetime is refused.
  const m = await order();
  assert.equal((await call('POST', '/api/orders', { ...m.body, kind: 'market' })).status, 400);
});

test('place, list, and cancel an order', async () => {
  const o = await order();
  const placed = await call('POST', '/api/orders', o.body);
  assert.equal(placed.status, 200);
  assert.match(placed.json.id, /^subtxid_/);

  assert.equal((await call('POST', '/api/orders', o.body)).status, 409, 'duplicate refused');

  const listed = await call('GET', `/api/orders?account=${o.account}`);
  assert.equal(listed.json.length, 1);
  assert.equal(listed.json[0].status, 'open');
  assert.equal(listed.json[0].signedPartialTransactionHex, undefined, 'signed bytes are never served');
  assert.equal(listed.json[0].orderKeyHex, undefined, 'cancel key is never served');

  assert.equal((await call('POST', `/api/orders/${placed.json.id}/cancel`, { secret: '00'.repeat(32) })).status, 403);
  assert.equal((await call('POST', `/api/orders/${placed.json.id}/cancel`, { secret: 'nope' })).status, 400);
  assert.equal((await call('POST', `/api/orders/${placed.json.id}/cancel`, { secret: o.secret })).status, 200);
  assert.equal((await call('POST', `/api/orders/${placed.json.id}/cancel`, { secret: o.secret })).status, 409);
  assert.equal(app.store.open().length, 0);
});

test('bad submissions get a 400, not a crash', async () => {
  const o = await order();
  assert.equal((await call('POST', '/api/orders', { ...o.body, minBuyAmount: '1' })).status, 400);
  assert.equal((await call('POST', '/api/orders', { ...o.body, signedPartialTransactionHex: 'zz' })).status, 400);
  assert.equal((await call('POST', '/api/orders', {})).status, 400);
  assert.equal((await call('POST', '/api/orders', 'x'.repeat(70_000))).status, 413);
  assert.equal((await call('GET', '/api/orders?account=nonsense')).status, 400);
  assert.equal((await call('GET', '/api/depth?market=nope')).status, 404);
  assert.equal((await call('GET', '/api/quote?sell=a&buy=b&amount=1')).status, 400);
});

test('open orders per account are capped', async () => {
  const key = keyFromHex(randomBytes(32).toString('hex'));
  assert.equal((await call('POST', '/api/orders', (await order(undefined, key)).body)).status, 200);
  assert.equal((await call('POST', '/api/orders', (await order(undefined, key)).body)).status, 200);
  assert.equal((await call('POST', '/api/orders', (await order(undefined, key)).body)).status, 429);
});

test('a filled order cannot be cancelled or re-filled', async () => {
  const o = await order();
  const { json } = await call('POST', '/api/orders', o.body);
  assert.equal(app.store.markFilled(json.id, 'txid_x', '10'), true);
  assert.equal(app.store.markFilled(json.id, 'txid_y', '99'), false);
  assert.equal((await call('POST', `/api/orders/${json.id}/cancel`, { secret: o.secret })).status, 409);
  assert.equal(app.store.get(json.id)!.fillTx, 'txid_x');
});

test('resting orders appear in the book on the right side at the right price', () => {
  const market = { id: 'm', base: { address: net.xrd, symbol: 'XRD', name: '' }, quote: { address: TUSD, symbol: 'TUSD', name: '' }, pools: [], tvlUsd: 0, volume24hUsd: 0 };
  // The book shows the price an order fills at (its limit), not the lower signed minimum. Market orders are not depth.
  const o = (sell: string, sellAmount: string, buy: string, limitBuyAmount: string, kind = 'limit') => ({ sell, sellAmount, buy, minBuyAmount: String(Number(limitBuyAmount) * 0.98), limitBuyAmount, kind }) as any;
  const { bids, asks } = orderLevels(market, [o(net.xrd, '100', TUSD, '10'), o(TUSD, '9', net.xrd, '100'), o(net.xrd, '50', TUSD, '4', 'market')]);
  assert.deepEqual(asks, [{ price: 0.1, size: 100, source: 'orders' }]);
  assert.deepEqual(bids, [{ price: 0.09, size: 100, source: 'orders' }]);
});

test('an order that keeps failing to fill is dropped, with growing delays in between', async () => {
  const o = await order();
  const { json } = await call('POST', '/api/orders', o.body);
  assert.equal(app.store.noteFailure(json.id, 'boom', 100), 1);
  assert.equal(app.store.get(json.id)!.retryAt, 100);
  assert.equal(app.store.noteFailure(json.id, 'boom', 200), 2);
  assert.equal(app.store.noteFailure(json.id, 'boom', 300), 3);
  assert.equal(app.store.markCancelled(json.id, 'Dropped after 3 failed fills'), true);
  assert.equal(app.store.get(json.id)!.status, 'cancelled');
  assert.equal(app.store.noteFailure(json.id, 'late', 400), 3, 'a closed order no longer counts failures');
});

test('the network fee charged follows what the route costs to swap through', () => {
  assert.equal(fillGasXrd(0).toFixed(), '0.7', 'no pool leg');
  assert.equal(fillGasXrd(1).toFixed(), '1.08');
  assert.equal(fillGasXrd(0, '0.51').toFixed(), '1.01', 'a cheap pool');
  assert.equal(fillGasXrd(0, '0.92').toFixed(), '1.42', 'a costly pool is charged more');
  assert.equal(fillGasXrd(1, '0.5').toFixed(), '1.38');
  assert.equal(fillGasXrd(0, 'x').toFixed(), '1', 'an unreadable measurement falls back');
});
