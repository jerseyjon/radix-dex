import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Depth, type DepthLevel, type Market, Decimal, Gateway, OrderRejected, isAccount, isResource,
  orderKeyFromSecret, validateLimitOrder,
} from '@radix-dex/core';
import type { Config } from './config.ts';
import { Api, HttpError } from './http.ts';
import { MarketData } from './marketdata.ts';
import { GAS_XRD, Solver, loadSolverKey } from './solver.ts';
import { OrderStore, type StoredOrder } from './store.ts';

/** How long the site asks the wallet to keep a market order valid. */
const MARKET_ORDER_LIFETIME_SEC = 180;

const need = (v: string | null, name: string): string => {
  if (!v) throw new HttpError(400, `Missing "${name}"`);
  return v;
};

/** What the public may see of an order: never the signed bytes or the cancel key. */
const publicOrder = (o: StoredOrder) => ({
  id: o.id, account: o.account, sell: o.sell, sellAmount: o.sellAmount, buy: o.buy, minBuyAmount: o.minBuyAmount,
  limitBuyAmount: o.limitBuyAmount, kind: o.kind, expiresAt: o.expiresAt, createdAt: o.createdAt, status: o.status, fillTx: o.fillTx, received: o.received,
});

/** Resting orders as book levels for one market. */
export function orderLevels(market: Market, open: StoredOrder[]): { bids: DepthLevel[]; asks: DepthLevel[] } {
  const bids: DepthLevel[] = [], asks: DepthLevel[] = [];
  for (const o of open) {
    // Shown at the price the order fills at. Market orders are gone in seconds and are not book depth.
    const sell = Number(o.sellAmount), min = Number(o.limitBuyAmount);
    if (o.kind === 'market' || !(sell > 0) || !(min > 0)) continue;
    if (o.sell === market.base.address && o.buy === market.quote.address) asks.push({ price: min / sell, size: sell, source: 'orders' });
    else if (o.sell === market.quote.address && o.buy === market.base.address) bids.push({ price: sell / min, size: min, source: 'orders' });
  }
  return { bids, asks };
}

export async function createApp(config: Config) {
  const gateway = new Gateway(config.network, { url: config.gatewayUrl });
  const data = new MarketData(config, gateway);
  const store = new OrderStore(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, `orders-${config.network.name}.sqlite`));
  const solver = config.solverBadge && config.solverKeyFile
    ? new Solver({ config, gateway, store, data, key: loadSolverKey(config.solverKeyFile), badge: config.solverBadge })
    : undefined;
  const api = new Api({ staticDir: config.webDir });

  const marketOr404 = (id: string) => {
    const m = data.market(id);
    if (!m) throw new HttpError(404, 'Unknown market');
    return m;
  };

  api.on('GET', '/api/config', () => ({
    network: config.network.name, networkId: config.network.networkId, xrd: config.network.xrd,
    feeBps: config.feeBps, refreshedAt: data.refreshedAt, warning: data.lastError ?? null,
    dAppDefinition: config.dAppDefinition ?? null,
    limitOrders: config.solverBadge
      ? { enabled: true, solverBadge: config.solverBadge, registry: config.registry ?? null, maxLifetimeSec: config.maxOrderLifetimeSec, filling: Boolean(solver), gasXrd: GAS_XRD, marketOrderLifetimeSec: MARKET_ORDER_LIFETIME_SEC }
      : { enabled: false },
  }));

  api.on('GET', '/api/markets', () => data.markets.map((m) => ({
    id: m.id, base: m.base, quote: m.quote, tvlUsd: m.tvlUsd, volume24hUsd: m.volume24hUsd,
    venues: [...new Set(m.pools.map((p) => p.venue))],
  })));

  api.on('GET', '/api/depth', async ({ url }): Promise<Depth> => {
    const market = marketOr404(need(url.searchParams.get('market'), 'market'));
    const pools = market.pools.length ? await data.depth(market) : { marketId: market.id, mid: null, bids: [], asks: [] };
    const resting = orderLevels(market, store.open());
    const bids = [...pools.bids, ...resting.bids].sort((a, b) => b.price - a.price);
    const asks = [...pools.asks, ...resting.asks].sort((a, b) => a.price - b.price);
    return { marketId: market.id, mid: pools.mid ?? (bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : null), bids, asks };
  });

  api.on('GET', '/api/candles', ({ url }) =>
    data.candles(marketOr404(need(url.searchParams.get('market'), 'market')), url.searchParams.get('resolution') ?? '1h'));

  api.on('GET', '/api/quote', async ({ url }) => {
    const sell = need(url.searchParams.get('sell'), 'sell');
    const buy = need(url.searchParams.get('buy'), 'buy');
    const amount = need(url.searchParams.get('amount'), 'amount');
    if (!isResource(sell) || !isResource(buy) || sell === buy) throw new HttpError(400, 'Bad token addresses');
    let d: Decimal;
    try { d = new Decimal(amount); } catch { throw new HttpError(400, 'Bad amount'); }
    if (!d.isFinite() || !d.isPositive() || d.gt('1e30')) throw new HttpError(400, 'Bad amount');
    const q = await data.quote(sell, buy, d.toDecimalPlaces(18).toFixed());
    if (!q) throw new HttpError(404, 'No route with enough liquidity');
    return q;
  });

  api.on('GET', '/api/balances', async ({ url }) => {
    const account = need(url.searchParams.get('account'), 'account');
    if (!isAccount(account)) throw new HttpError(400, 'Bad account address');
    const [d] = await gateway.entityDetails([account]);
    const out: Record<string, string> = {};
    for (const i of d?.fungible_resources?.items ?? []) if (typeof i.amount === 'string') out[i.resource_address] = i.amount;
    return out;
  });

  api.on('GET', '/api/trades', ({ url }) => {
    const market = marketOr404(need(url.searchParams.get('market'), 'market'));
    return store.recentFills(market.base.address, market.quote.address).map(publicOrder);
  });

  // The account's own trades, read from the ledger: market orders and limit-order fills alike.
  // A trade is a transaction where the account's balance of one listed token fell and another rose.
  const historyCache = new Map<string, { at: number; value: unknown }>();
  api.on('GET', '/api/history', async ({ url }) => {
    const account = need(url.searchParams.get('account'), 'account');
    if (!isAccount(account)) throw new HttpError(400, 'Bad account address');
    const hit = historyCache.get(account);
    if (hit && Date.now() - hit.at < 5_000) return hit.value;
    const listed = new Set(data.markets.flatMap((m) => [m.base.address, m.quote.address]));
    const trades = [];
    for (const t of await gateway.accountActivity(account)) {
      const moved = Object.entries(t.changes).filter(([r, v]) => listed.has(r) && Number(v) !== 0);
      const out = moved.filter(([, v]) => Number(v) < 0), inn = moved.filter(([, v]) => Number(v) > 0);
      if (out.length !== 1 || inn.length !== 1) continue;
      trades.push({ txid: t.txid, time: t.time, sell: out[0]![0], sellAmount: out[0]![1].replace('-', ''), buy: inn[0]![0], buyAmount: inn[0]![1], feeXrd: t.feeXrd });
    }
    if (historyCache.size > 500) historyCache.clear();
    historyCache.set(account, { at: Date.now(), value: trades });
    return trades;
  });

  api.on('GET', '/api/orders', ({ url }) => {
    const account = need(url.searchParams.get('account'), 'account');
    if (!isAccount(account)) throw new HttpError(400, 'Bad account address');
    return store.byAccount(account).map((o) => ({ ...publicOrder(o), outlook: o.status === 'open' ? solver?.outlook.get(o.id) ?? null : null }));
  });

  api.on('POST', '/api/orders', async ({ body }) => {
    if (!config.solverBadge) throw new HttpError(503, 'Limit orders are not enabled on this server');
    const submission = await body();
    let order;
    try {
      order = await validateLimitOrder(submission, {
        networkId: config.network.networkId, solverBadge: config.solverBadge, registry: config.registry,
        nowSec: Math.floor(Date.now() / 1000), maxLifetimeSec: config.maxOrderLifetimeSec, minLifetimeSec: 60,
      });
    } catch (e) {
      if (e instanceof OrderRejected) {
        console.error('[orders] rejected: ' + e.message);
        // Off mainnet, keep the refused submission so the cause can be worked out.
        if (config.network.name !== 'mainnet' && config.dataDir !== ':memory:') {
          try { mkdirSync(join(config.dataDir, 'rejected'), { recursive: true }); writeFileSync(join(config.dataDir, 'rejected', Date.now() + '.json'), JSON.stringify({ reason: e.message, submission }, null, 2).slice(0, 60_000), { mode: 0o600 }); } catch { /* diagnostics only */ }
        }
        throw new HttpError(400, e.message);
      }
      throw e;
    }
    if (store.openCount(order.params.account) >= config.maxOpenOrdersPerAccount) throw new HttpError(429, 'Too many open orders for this account');
    const inserted = store.insert({
      id: order.hashId, account: order.params.account, sell: order.params.sell, sellAmount: order.params.sellAmount,
      buy: order.params.buy, minBuyAmount: order.params.minBuyAmount, limitBuyAmount: order.limitBuyAmount, kind: order.kind, orderKeyHex: submission.orderKeyHex,
      expiresAt: order.expiresAt, createdAt: Math.floor(Date.now() / 1000), signedPartialTransactionHex: order.signedPartialTransactionHex,
    });
    if (!inserted) throw new HttpError(409, 'This order has already been submitted');
    // A market order should not wait for the next timer pass.
    if (order.kind === 'market') void solver?.tick().catch((e) => console.error('[solver] tick failed:', e));
    return { id: order.hashId, expiresAt: order.expiresAt };
  });

  // Soft cancel: whoever holds the secret whose hash was fixed when the order was made.
  api.on('POST', '/api/orders/:id/cancel', async ({ params, body }) => {
    const { secret } = await body();
    const order = store.get(params.id!);
    if (!order) throw new HttpError(404, 'Unknown order');
    let key: string;
    try { key = orderKeyFromSecret(String(secret)); } catch { throw new HttpError(400, 'Bad cancel secret'); }
    if (key !== order.orderKeyHex) throw new HttpError(403, 'Wrong cancel secret');
    if (!store.markCancelled(order.id)) throw new HttpError(409, `Order is already ${order.status}`);
    return { id: order.id, status: 'cancelled' };
  });

  return { api, data, store, solver, gateway, config };
}
