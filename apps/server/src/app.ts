import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BookOrder, type Depth, type DepthLevel, type Market, Decimal, Gateway, OrderRejected, isAccount, isResource,
  orderKeyFromSecret, validateLimitOrder,
} from '@radix-dex/core';
import { BookWatcher } from './book.ts';
import type { Config } from './config.ts';
import { Api, HttpError } from './http.ts';
import { MarketData } from './marketdata.ts';
import { GAS_XRD, Solver, fillGasXrd, loadSolverKey } from './solver.ts';
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

/** `venue` is "here" for a trade made through this exchange, otherwise the pool's venue. */
export interface MarketTrade { txid: string; time: number; side: 'buy' | 'sell'; price: number; size: number; venue: string }

/**
 * Trades made on this exchange in one market, newest first: filled signed orders and purchases
 * from the on-ledger book. `side` is what the base token's seller or buyer did; one row per transaction.
 */
export function marketTrades(market: Market, filled: StoredOrder[], bookOrders: BookOrder[], bookFills: { id: number; txid: string; time: number; sold: string; paid: string }[], elsewhere: MarketTrade[] = [], limit = 60): MarketTrade[] {
  const base = market.base.address, quote = market.quote.address;
  const row = (txid: string, time: number, sell: string, sold: number, got: number): MarketTrade | undefined => {
    if (!(sold > 0) || !(got > 0)) return undefined;
    return sell === base ? { txid, time, side: 'sell', price: got / sold, size: sold, venue: 'here' } : { txid, time, side: 'buy', price: sold / got, size: got, venue: 'here' };
  };
  const byTx = new Map<string, MarketTrade>();
  // The order that took liquidity names the trade: a market order before the resting order it met.
  for (const o of [...filled].sort((a, b) => Number(b.kind === 'market') - Number(a.kind === 'market'))) {
    if (!o.fillTx || byTx.has(o.fillTx)) continue;
    const t = row(o.fillTx, o.createdAt, o.sell, Number(o.sellAmount), Number(o.received));
    if (t) byTx.set(o.fillTx, t);
  }
  const orders = new Map(bookOrders.map((o) => [o.id, o]));
  for (const f of bookFills) {
    const o = orders.get(f.id);
    if (!o || byTx.has(f.txid) || !((o.sell === base && o.buy === quote) || (o.sell === quote && o.buy === base))) continue;
    // The buyer took the resting order, so the trade is on the opposite side to the order.
    const t = row(f.txid, f.time, o.sell, Number(f.sold), Number(f.paid));
    if (t) byTx.set(f.txid, { ...t, side: t.side === 'sell' ? 'buy' : 'sell' });
  }
  // A fill of ours that went through a pool is also a swap in that pool: show it once, as ours.
  return [...byTx.values(), ...elsewhere.filter((t) => !byTx.has(t.txid))].sort((a, b) => b.time - a.time).slice(0, limit);
}

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

/** Orders in the on-ledger book as levels for one market: what is still for sale, at the order's own price. */
export function bookLevels(market: Market, live: BookOrder[]): { bids: DepthLevel[]; asks: DepthLevel[] } {
  const bids: DepthLevel[] = [], asks: DepthLevel[] = [];
  for (const o of live) {
    const price = Number(o.price), remaining = Number(o.remaining);
    if (!(price > 0) || !(remaining > 0)) continue;
    if (o.sell === market.base.address && o.buy === market.quote.address) asks.push({ price, size: remaining, source: 'orders' });
    else if (o.sell === market.quote.address && o.buy === market.base.address) bids.push({ price: 1 / price, size: remaining * price, source: 'orders' });
  }
  return { bids, asks };
}

/** A book order in the same shape as a signed order, for the site's order tables. */
function bookOrderView(o: BookOrder, nowSec: number, placedAt = 0) {
  const sold = new Decimal(o.sellAmount).minus(o.remaining).minus(o.returned);
  const gross = new Decimal(o.sellAmount).mul(o.price).toDecimalPlaces(18).toFixed();
  const status = o.open ? (o.expiresAt !== 0 && o.expiresAt <= nowSec ? 'expired' : 'open') : sold.gte(o.sellAmount) ? 'filled' : 'cancelled';
  return {
    id: `book:${o.id}`, bookId: o.id, kind: 'book' as const, account: o.maker, sell: o.sell, sellAmount: o.sellAmount, buy: o.buy,
    minBuyAmount: gross, limitBuyAmount: gross, expiresAt: o.expiresAt, createdAt: placedAt, status, fillTx: null,
    sold: sold.toFixed(), remaining: o.remaining, unclaimed: o.unclaimed,
    received: sold.mul(o.price).mul(10_000 - o.makerFeeBps).div(10_000).toDecimalPlaces(18).toFixed(), outlook: null,
  };
}

export async function createApp(config: Config) {
  const gateway = new Gateway(config.network, { url: config.gatewayUrl });
  const data = new MarketData(config, gateway);
  const store = new OrderStore(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, `orders-${config.network.name}.sqlite`));
  const book = config.orderBook ? new BookWatcher(gateway, config.orderBook) : undefined;
  const solver = config.solverBadge && config.solverKeyFile
    ? new Solver({ config, gateway, store, data, key: loadSolverKey(config.solverKeyFile), badge: config.solverBadge, book })
    : undefined;
  const api = new Api({
    staticDir: config.webDir, clientIpHeader: config.clientIpHeader, ratePerMinute: config.ratePerMinute,
    // The Radix Wallet fetches this from the site to confirm the dApp definition really claims it.
    documents: config.dAppDefinition ? { '/.well-known/radix.json': { dApps: [{ dAppDefinitionAddress: config.dAppDefinition }] } } : {},
  });

  const marketOr404 = (id: string) => {
    const m = data.market(id);
    if (!m) throw new HttpError(404, 'Unknown market');
    return m;
  };

  const readBookSoon = () => book?.refresh(3_000).catch((e) => console.warn('[book] not read:', String((e as Error).message ?? e).slice(0, 200)));

  api.on('GET', '/api/config', async () => { await readBookSoon(); return {
    network: config.network.name, networkId: config.network.networkId, xrd: config.network.xrd,
    feeBps: config.feeBps, makerFeeBps: config.makerFeeBps, refreshedAt: data.refreshedAt, warning: data.lastError ?? null,
    dAppDefinition: config.dAppDefinition ?? null,
    limitOrders: config.solverBadge
      ? { enabled: true, solverBadge: config.solverBadge, registry: config.registry ?? null, maxLifetimeSec: config.maxOrderLifetimeSec, filling: Boolean(solver), gasXrd: GAS_XRD, marketOrderLifetimeSec: MARKET_ORDER_LIFETIME_SEC }
      : { enabled: false },
    // Resting orders with partial fills, held in the on-ledger order book. The fee is read from the ledger.
    orderBook: book?.info ? { component: book.info.component, receipts: book.info.receipts, makerFeeBps: book.info.makerFeeBps } : null,
  }; });

  api.on('GET', '/api/markets', () => data.markets.map((m) => ({
    id: m.id, base: m.base, quote: m.quote, tvlUsd: m.tvlUsd, volume24hUsd: m.volume24hUsd,
    venues: [...new Set(m.pools.map((p) => p.venue))],
  })));

  api.on('GET', '/api/depth', async ({ url }): Promise<Depth> => {
    const market = marketOr404(need(url.searchParams.get('market'), 'market'));
    const pools = market.pools.length ? await data.depth(market) : { marketId: market.id, mid: null, bids: [], asks: [] };
    await readBookSoon();
    const resting = orderLevels(market, store.open()), onLedger = bookLevels(market, book?.live() ?? []);
    const bids = [...pools.bids, ...resting.bids, ...onLedger.bids].sort((a, b) => b.price - a.price);
    const asks = [...pools.asks, ...resting.asks, ...onLedger.asks].sort((a, b) => a.price - b.price);
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
    if (!d.isFinite() || !d.gt(0) || d.gt('1e30')) throw new HttpError(400, 'Bad amount');
    const q = await data.quote(sell, buy, d.toDecimalPlaces(18).toFixed());
    if (!q) throw new HttpError(404, 'No route with enough liquidity');
    // The network fee of a fill through this route, in the token being bought, so the site can show it before an order is signed.
    return { ...q, gasInBuyToken: (await data.xrdValueIn(buy, fillGasXrd(0, q.networkFeeXrd)).catch(() => undefined)) ?? null };
  });

  api.on('GET', '/api/balances', async ({ url }) => {
    const account = need(url.searchParams.get('account'), 'account');
    if (!isAccount(account)) throw new HttpError(400, 'Bad account address');
    return gateway.fungibleBalances(account);
  });

  api.on('GET', '/api/trades', async ({ url }) => {
    const market = marketOr404(need(url.searchParams.get('market'), 'market'));
    await readBookSoon();
    const elsewhere = await data.venueTrades(market).catch(() => []);
    return marketTrades(market, store.recentFills(market.base.address, market.quote.address), book ? [...book.orders.values()] : [], book?.fills ?? [],
      elsewhere.map(({ txid, time, side, price, size, venue }) => ({ txid, time, side, price, size, venue })));
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
    // Sales from this account's orders in the on-ledger book. The tokens left the account when
    // the order was placed, so the ledger shows only the payment arriving: take each from the book's own events.
    await readBookSoon();
    const mine = (book?.fills ?? []).flatMap((f) => {
      const o = book!.orders.get(f.id);
      return o && o.maker === account ? [{ f, o, got: new Decimal(f.paid).minus(f.fee) }] : [];
    });
    const trades = [];
    for (const { f, o, got } of mine) trades.push({ txid: f.txid, time: f.time, sell: o.sell, sellAmount: f.sold, buy: o.buy, buyAmount: got.toFixed(), feeXrd: '0', book: f.id });
    for (const t of await gateway.accountActivity(account)) {
      // Leave those payments out of the account's own movement, or a trade in the same transaction would be misread.
      // (An account that bought from its own order nets to nothing in that token, and the ledger then lists no change at all.)
      for (const { f, o, got } of mine) if (f.txid === t.txid) t.changes[o.buy] = new Decimal(t.changes[o.buy] ?? 0).minus(got).toFixed();
      const moved = Object.entries(t.changes).filter(([r, v]) => listed.has(r) && Number(v) !== 0);
      const out = moved.filter(([, v]) => Number(v) < 0), inn = moved.filter(([, v]) => Number(v) > 0);
      if (out.length !== 1 || inn.length !== 1) continue;
      trades.push({ txid: t.txid, time: t.time, sell: out[0]![0], sellAmount: out[0]![1].replace('-', ''), buy: inn[0]![0], buyAmount: inn[0]![1], feeXrd: t.feeXrd });
    }
    trades.sort((a, b) => b.time - a.time);
    if (historyCache.size > 500) historyCache.clear();
    historyCache.set(account, { at: Date.now(), value: trades });
    return trades;
  });

  api.on('GET', '/api/orders', async ({ url }) => {
    const account = need(url.searchParams.get('account'), 'account');
    if (!isAccount(account)) throw new HttpError(400, 'Bad account address');
    await readBookSoon();
    const now = Math.floor(Date.now() / 1000);
    return [
      ...(book?.byMaker(account) ?? []).map((o) => bookOrderView(o, now, book?.placedAt.get(o.id))),
      ...store.byAccount(account).map((o) => ({ ...publicOrder(o), outlook: o.status === 'open' ? solver?.outlook.get(o.id) ?? null : null })),
    ];
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

  return { api, data, store, solver, gateway, config, book };
}
