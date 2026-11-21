import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { NETWORKS, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent, swapsInTransaction } from '@radix-dex/core';
import { createApp, marketTrades, orderLevels } from '../src/app.ts';
import { rateKey } from '../src/http.ts';
import { normaliseCandle } from '../src/marketdata.ts';
import { loadConfig } from '../src/config.ts';
import { fillGasXrd } from '../src/solver.ts';

const net = NETWORKS.stokenet;
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const BADGE = 'resource_tdx_2_1tktzk58223qax8lmv6zvtdfy3zvejhzx8pd4ylftqq75c2jjfcecmv';
let server: Server, base: string, app: Awaited<ReturnType<typeof createApp>>;

before(async () => {
  app = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: BADGE, DEX_MAX_OPEN_ORDERS: '2' }));
  // Offline: one listed market, and token divisibility without asking the ledger.
  app.data.markets = [{ id: `${net.xrd}/${TUSD}`, base: { address: net.xrd, symbol: 'XRD', name: '' }, quote: { address: TUSD, symbol: 'TUSD', name: '' }, pools: [], tvlUsd: 0, volume24hUsd: 0 }];
  app.data.quoter.divisibility = async (r: string) => (r === TUSD ? 6 : 18);
  server = app.api.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};

async function order(secret = randomBytes(32).toString('hex'), key = keyFromHex(randomBytes(32).toString('hex')), over: { sell?: string; sellAmount?: string; buy?: string } = {}) {
  const account = await accountOf(key, net.networkId);
  const p = { account, sell: over.sell ?? net.xrd, sellAmount: over.sellAmount ?? '100', buy: over.buy ?? TUSD, minBuyAmount: '9' };
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

test('market trades: one row per transaction, priced in the quote token, on the side of whoever took it', () => {
  const market = { id: 'm', base: { address: net.xrd, symbol: 'XRD', name: '' }, quote: { address: TUSD, symbol: 'TUSD', name: '' }, pools: [], tvlUsd: 0, volume24hUsd: 0 } as any;
  const o = (kind: string, sell: string, sellAmount: string, received: string, fillTx: string, createdAt: number) => ({ kind, sell, buy: sell === net.xrd ? TUSD : net.xrd, sellAmount, received, fillTx, createdAt }) as any;
  const trades = marketTrades(market,
    [o('limit', TUSD, '10', '100', 'tx1', 5), o('market', net.xrd, '100', '10', 'tx1', 6), o('market', TUSD, '5', '40', 'tx2', 9)],
    [{ id: 1, sell: TUSD, buy: net.xrd } as any],
    [{ id: 1, txid: 'tx3', time: 7, sold: '2', paid: '25' }, { id: 1, txid: 'tx2', time: 9, sold: '1', paid: '10' }],
    // Swaps read from the pools: one is our own fill again, one was made elsewhere.
    [{ txid: 'tx2', time: 9, side: 'buy', price: 0.124, size: 40.3, venue: 'ociswap' }, { txid: 'tx9', time: 8, side: 'buy', price: 0.11, size: 7, venue: 'ociswap' }]);
  assert.deepEqual(trades, [
    { txid: 'tx2', time: 9, side: 'buy', price: 0.125, size: 40, venue: 'here' },
    { txid: 'tx9', time: 8, side: 'buy', price: 0.11, size: 7, venue: 'ociswap' },
    { txid: 'tx3', time: 7, side: 'sell', price: 0.08, size: 25, venue: 'here' },
    { txid: 'tx1', time: 6, side: 'sell', price: 0.1, size: 100, venue: 'here' },
  ]);
});

test('swaps are read from a transaction: opposite moves in a pool are a trade, liquidity changes are not', () => {
  const ch = (entity_address: string, resource_address: string, balance_change: string) => ({ entity_address, resource_address, balance_change });
  const tx = { transaction_status: 'CommittedSuccess', intent_hash: 'tx', confirmed_at: '2026-11-21T22:00:00.000Z', balance_changes: { fungible_balance_changes: [
    ch('account_a', net.xrd, '-100'), ch('account_a', TUSD, '9.5'),
    ch('pool_1', net.xrd, '100'), ch('pool_1', TUSD, '-9.6'), ch('component_fee', TUSD, '0.1'),
    ch('pool_2', net.xrd, '50'), ch('pool_2', TUSD, '5'),
  ] } };
  assert.deepEqual(swapsInTransaction(tx, net.xrd, TUSD), [{ txid: 'tx', time: 1795298400, side: 'sell', price: 0.096, size: 100, entity: 'pool_1' }]);
  assert.deepEqual(swapsInTransaction({ ...tx, transaction_status: 'CommittedFailure' }, net.xrd, TUSD), []);
});

test('orders outside the listed markets, with too many decimals, or with a used key are refused', async () => {
  const OTHER = 'resource_tdx_2_1t5jcmwqx39ym7fw0hrlpnxwechr0mzlgulcfcye59qm9y9fa5uvdrd';
  assert.equal((await call('POST', '/api/orders', (await order(undefined, undefined, { buy: OTHER })).body)).status, 400, 'unlisted pair');
  // TUSD has 6 decimal places here: 7 cannot be withdrawn.
  assert.equal((await call('POST', '/api/orders', (await order(undefined, undefined, { sell: TUSD, buy: net.xrd, sellAmount: '1.1234567' })).body)).status, 400, 'too many decimals');
  assert.equal((await call('POST', '/api/orders', (await order(undefined, undefined, { sell: TUSD, buy: net.xrd, sellAmount: '1.123456' })).body)).status, 200, 'six are fine');
  const secret = randomBytes(32).toString('hex');
  const first = await call('POST', '/api/orders', (await order(secret)).body);
  assert.equal(first.status, 200);
  assert.equal((await call('POST', '/api/orders', (await order(secret)).body)).status, 409, 'a second order with the same key is refused');
});

test('an account whose orders keep failing may not post more for a day', async () => {
  const key = keyFromHex(randomBytes(32).toString('hex'));
  const o = await order(undefined, key);
  for (let i = 0; i < app.config.accountFailureLimit; i++) app.store.noteAccountFailure(o.account, 'x', 'boom');
  assert.equal((await call('POST', '/api/orders', o.body)).status, 429);
});

test('malformed requests get a 4xx, not a 500', async () => {
  assert.equal((await call('GET', '/api/quote?sell=' + net.xrd + '&buy=' + TUSD + '&amount=0x10')).status, 400);
  assert.equal((await call('GET', '/api/quote?sell=' + net.xrd + '&buy=' + TUSD + '&amount=1e-19')).status, 400);
  const market = encodeURIComponent(app.data.markets[0]!.id);
  assert.equal((await call('GET', `/api/candles?market=${market}&resolution=7x`)).status, 400);
  assert.equal((await call('GET', `/api/candles?market=${market}&resolution=__proto__`)).status, 400);
  assert.equal((await call('POST', '/api/orders/abc/cancel', null)).status, 400);
  assert.equal((await fetch(base + '/api/orders/%ZZ/cancel', { method: 'POST', body: '{}' })).status, 400);
});

test('responses carry headers that refuse framing and sniffing', async () => {
  const res = await fetch(base + '/api/config');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('health answers without the ledger and says what is wrong', async () => {
  const r = await call('GET', '/api/health');
  // Markets were set by hand, never refreshed: the monitor is told.
  assert.equal(r.status, 503);
  assert.deepEqual(r.json.problems, ['markets not loaded']);
  assert.equal(r.json.solver, null);
});

test('IPv6 clients are rate-limited per /64', () => {
  assert.equal(rateKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(rateKey('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(rateKey('10.0.0.1'), '10.0.0.1');
});

test('candles are made self-consistent', () => {
  assert.deepEqual(normaliseCandle({ time: 1, open: 0.25, high: 0.26, low: 0.26, close: 0.26, volume: 1 }), { time: 1, open: 0.25, high: 0.26, low: 0.25, close: 0.26, volume: 1 });
});

test('only a market pool\'s own holdings count as a trade, not a component passing tokens through', () => {
  const ch = (entity_address: string, resource_address: string, balance_change: string) => ({ entity_address, resource_address, balance_change });
  const tx = { transaction_status: 'CommittedSuccess', intent_hash: 'tx', confirmed_at: '2026-11-21T22:00:00.000Z', balance_changes: { fungible_balance_changes: [
    ch('pool_native', net.xrd, '100'), ch('pool_native', TUSD, '-9.6'),
    ch('component_arb', net.xrd, '-200'), ch('component_arb', TUSD, '9.6'),
  ] } };
  assert.deepEqual(swapsInTransaction(tx, net.xrd, TUSD, new Set(['component_pool', 'pool_native'])).map((s) => s.entity), ['pool_native']);
});

test('an order whose key is already cancelled in the registry is refused at submission', async () => {
  const registry = await accountOf(keyFromHex(randomBytes(32).toString('hex')), net.networkId);
  const app2 = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: BADGE, DEX_REGISTRY: registry }));
  app2.data.markets = app.data.markets;
  app2.data.quoter.divisibility = async () => 18;
  const dead = new Set<string>();
  app2.readGateway.status = async () => ({ epoch: 1, stateVersion: 1, timestamp: '' });
  app2.readGateway.preview = async (manifest: string) => (dead.has(/Bytes\("([0-9a-f]{64})"\)/.exec(manifest)?.[1] ?? '')
    ? { ok: false, error: 'Order has been cancelled', feeXrd: '0', changes: [], raw: {} } : { ok: true, feeXrd: '0', changes: [], raw: {} });
  const s2 = app2.api.listen(0, '127.0.0.1');
  await new Promise((r) => s2.once('listening', r));
  try {
    const post = async (cancelled: boolean) => {
      const key = keyFromHex(randomBytes(32).toString('hex'));
      const account = await accountOf(key, net.networkId);
      const orderKeyHex = orderKeyFromSecret(randomBytes(32).toString('hex'));
      if (cancelled) dead.add(orderKeyHex);
      const p = { account, sell: net.xrd, sellAmount: '100', buy: TUSD, minBuyAmount: '9' };
      const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: BADGE, registry: { component: registry, orderKeyHex } }), { networkId: net.networkId, startEpoch: 1, endEpoch: 100, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, key);
      const res = await fetch(`http://127.0.0.1:${(s2.address() as any).port}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, orderKeyHex, signedPartialTransactionHex: signed.signedPartialTransactionHex }) });
      return { status: res.status, account };
    };
    assert.equal((await post(true)).status, 400);
    const ok = await post(false);
    assert.equal(ok.status, 200);
    // The order view says the order checks this registry, so the site can offer the on-ledger cancel.
    const listed = await (await fetch(`http://127.0.0.1:${(s2.address() as any).port}/api/orders?account=${ok.account}`)).json() as any[];
    assert.equal(listed[0].registry, true);
  } finally { s2.close(); app2.store.close(); }
});

test('open orders say whether they check a registry; a server without one says no', async () => {
  const o = await order();
  const placed = await call('POST', '/api/orders', o.body);
  assert.equal(placed.status, 200);
  const listed = await call('GET', `/api/orders?account=${o.account}`);
  assert.equal(listed.json[0].registry, false);
  app.store.markCancelled(placed.json.id);
  const after = await call('GET', `/api/orders?account=${o.account}`);
  assert.equal(after.json[0].registry, undefined, 'only open orders carry the flag');
});

test('markets list each token\'s divisibility once read, and the market\'s pools', async () => {
  const saved = app.data.markets;
  const pool = { venue: 'ociswap' as const, address: 'component_tdx_2_1cpool', kind: 'basic', tokens: [net.xrd, TUSD] as [string, string], feeRate: 0.003, tvlUsd: 1, volume24hUsd: 0, reserves: [1, 1] as [number, number] };
  app.data.markets = [{ ...saved[0]!, pools: [pool] }];
  try {
    await app.data.loadDivisibilities();
    const r = await call('GET', '/api/markets');
    assert.equal(r.status, 200);
    assert.equal(r.json[0].base.divisibility, 18);
    assert.equal(r.json[0].quote.divisibility, 6);
    assert.deepEqual(r.json[0].pools, ['component_tdx_2_1cpool']);
  } finally { app.data.markets = saved; }
});
