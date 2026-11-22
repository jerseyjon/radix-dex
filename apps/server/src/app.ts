import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BookOrder, type Depth, type DepthLevel, type Market, Decimal, chargeAt, Gateway, GatewayError, OrderRejected, decodeSignedPartialTransaction, isAccount, isResource,
  chargedSwapFeeXrd, orderKeyCancelled, orderKeyFromSecret, validateLimitOrder,
} from '@radix-dex/core';
import { BookWatcher } from './book.ts';
import type { Config } from './config.ts';
import { Api, HttpError, JsonReply } from './http.ts';
import { MarketData, isResolution } from './marketdata.ts';
import { GAS_ALLOWANCE_MARGIN, GAS_XRD, Solver, fillGasXrd, loadSolverKey } from './solver.ts';
import { OrderStore, type StoredOrder } from './store.ts';

/** How long the site asks the wallet to keep a market order valid. */
const MARKET_ORDER_LIFETIME_SEC = 180;

const need = (v: string | null, name: string): string => {
  if (!v) throw new HttpError(400, `Missing "${name}"`);
  return v;
};

/** Plain decimal amounts only: no exponents, no 0x or 0b prefixes, at most 18 places. */
const PLAIN_AMOUNT = /^\d{1,30}(\.\d{1,18})?$/;

/** At most this many refused submissions are kept on disk for diagnosis (off mainnet). */
const MAX_REJECTED_FILES = 200;

/** A Gateway 4xx (for example an address with a bad checksum) is the visitor's mistake, not ours. */
async function gatewayInput<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    if (e instanceof GatewayError && e.status >= 400 && e.status < 500 && e.status !== 429) throw new HttpError(400, 'The ledger gateway refused this request (check the address)');
    throw e;
  }
}

/** What the public may see of an order: never the signed bytes or the cancel key. */
const publicOrder = (o: StoredOrder) => ({
  id: o.id, account: o.account, sell: o.sell, sellAmount: o.sellAmount, buy: o.buy, minBuyAmount: o.minBuyAmount,
  limitBuyAmount: o.limitBuyAmount, kind: o.kind, expiresAt: o.expiresAt, createdAt: o.createdAt, status: o.status, fillTx: o.fillTx, received: o.received,
  // Added 22 Nov 2026: what the trade produced before fees, when it filled, and whether a transaction for it is still in flight.
  gross: o.gross, filledAt: o.filledAt, pending: o.pendingTx !== null,
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
  // The price is the trade's own (what the sale produced before our fee and the network fee), at the time it filled.
  // Fills recorded before those were stored fall back to what the user received and when the order was placed.
  for (const o of [...filled].sort((a, b) => Number(b.kind === 'market') - Number(a.kind === 'market'))) {
    if (!o.fillTx || byTx.has(o.fillTx)) continue;
    const t = row(o.fillTx, o.filledAt ?? o.createdAt, o.sell, Number(o.sellAmount), Number(o.gross ?? o.received));
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
  // The solver's own client waits longer for an answer than the one behind visitors' requests:
  // a slow Gateway must never hold a page load for a minute.
  const gateway = new Gateway(config.network, { url: config.gatewayUrl });
  const readGateway = new Gateway(config.network, { url: config.gatewayUrl, timeoutMs: 8_000, attempts: 2 });
  const data = new MarketData(config, readGateway);
  const store = new OrderStore(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, `orders-${config.network.name}.sqlite`));
  const book = config.orderBook ? new BookWatcher(readGateway, config.orderBook) : undefined;
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

  // Request handlers never wait for the ledger: they answer from the copy of the book held now and
  // start a fresh read in the background when it is more than a few seconds old.
  const readBookSoon = () => book?.refreshInBackground(3_000);

  api.on('GET', '/api/config', () => { readBookSoon(); return {
    network: config.network.name, networkId: config.network.networkId, xrd: config.network.xrd,
    feeBps: config.feeBps, makerFeeBps: config.makerFeeBps, refreshedAt: data.refreshedAt, warning: data.lastError ?? null,
    dAppDefinition: config.dAppDefinition ?? null,
    limitOrders: config.solverBadge
      ? {
        enabled: true, solverBadge: config.solverBadge, registry: config.registry ?? null, maxLifetimeSec: config.maxOrderLifetimeSec, filling: Boolean(solver),
        // Fallback network allowance in XRD when no route-specific figure is at hand. Prefer /api/quote's gasAllowanceInBuyToken.
        gasXrd: GAS_XRD, gasAllowanceMargin: GAS_ALLOWANCE_MARGIN, marketOrderLifetimeSec: MARKET_ORDER_LIFETIME_SEC,
      }
      : { enabled: false },
    // Added 22 Nov 2026: the solver's charges (network fee and service fee) are always taken in XRD:
    // from the XRD an order sells, from the XRD it buys, or between two swaps through XRD when neither
    // token is XRD. `feeTokens` are the tokens that could be converted to XRD for pairs with no route
    // through XRD (not done yet); the solver never keeps them.
    fees: { token: config.network.xrd, takenIn: 'XRD', feeTokens: config.feeTokens, convertsFeeTokens: false },
    // Resting orders with partial fills, held in the on-ledger order book. The fee is read from the ledger;
    // `minOrderXrd`: the smallest order, valued in XRD, the site lets a user place in the book (the contract has no minimum).
    orderBook: book?.info ? { component: book.info.component, receipts: book.info.receipts, makerFeeBps: book.info.makerFeeBps, minOrderXrd: new Decimal(config.minBookOrderXrd).toFixed() } : null,
  }; });

  // For an uptime monitor. 503 when something needs the operator. Shows no balances, orders or keys.
  api.on('GET', '/api/health', () => {
    const now = Date.now();
    const s = solver?.health();
    const problems: string[] = [];
    if (!data.refreshedAt) problems.push('markets not loaded');
    if (s) {
      if (now - s.lastTickAt > 120_000) problems.push('solver pass overdue');
      if (s.lossLimit.reached) problems.push('loss limit reached: solver not sending');
      if (s.xrd === 'low') problems.push('solver XRD low');
      if (s.otherTokens) problems.push(`solver holds ${s.otherTokens} token(s) other than XRD`);
    }
    const body = {
      ok: problems.length === 0, problems, network: config.network.name, now,
      marketsRefreshedAt: data.refreshedAt || null, markets: data.markets.length,
      orderBook: book ? { readAt: book.refreshedAt || null, lastError: book.lastError ?? null } : null,
      gateway: { failedCalls: gateway.failures + readGateway.failures, lastFailureAt: Math.max(gateway.lastFailure?.at ?? 0, readGateway.lastFailure?.at ?? 0) || null },
      solver: s ?? null,
    };
    return problems.length ? new JsonReply(503, body) : body;
  });

  // Added 22 Nov 2026: each token's divisibility once read from the ledger (absent until then), and
  // the market's pool components, so the site can round amounts and check a quoted route.
  const withDivisibility = (t: Market['base']) => {
    const divisibility = data.divisibility(t.address);
    return divisibility === undefined ? t : { ...t, divisibility };
  };
  api.on('GET', '/api/markets', () => data.markets.map((m) => ({
    id: m.id, base: withDivisibility(m.base), quote: withDivisibility(m.quote), tvlUsd: m.tvlUsd, volume24hUsd: m.volume24hUsd,
    venues: [...new Set(m.pools.map((p) => p.venue))], pools: m.pools.map((p) => p.address),
    // Added 22 Nov 2026: whether the solver fills signed orders here (XRD on one side, or a route through XRD).
    solverFills: data.solverCanFill(m.base.address, m.quote.address),
  })));

  api.on('GET', '/api/depth', async ({ url }): Promise<Depth> => {
    const market = marketOr404(need(url.searchParams.get('market'), 'market'));
    const pools = market.pools.length ? await data.depth(market) : { marketId: market.id, mid: null, bids: [], asks: [] };
    readBookSoon();
    const resting = orderLevels(market, store.open()), onLedger = bookLevels(market, book?.live() ?? []);
    const bids = [...pools.bids, ...resting.bids, ...onLedger.bids].sort((a, b) => b.price - a.price);
    const asks = [...pools.asks, ...resting.asks, ...onLedger.asks].sort((a, b) => a.price - b.price);
    return { marketId: market.id, mid: pools.mid ?? (bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : null), bids, asks };
  });

  api.on('GET', '/api/candles', ({ url }) => {
    const resolution = url.searchParams.get('resolution') ?? '1h';
    if (!isResolution(resolution)) throw new HttpError(400, 'Unknown resolution');
    return data.candles(marketOr404(need(url.searchParams.get('market'), 'market')), resolution);
  });

  api.on('GET', '/api/quote', async ({ url }) => {
    const sell = need(url.searchParams.get('sell'), 'sell');
    const buy = need(url.searchParams.get('buy'), 'buy');
    const amount = need(url.searchParams.get('amount'), 'amount');
    if (!isResource(sell) || !isResource(buy) || sell === buy) throw new HttpError(400, 'Bad token addresses');
    if (!PLAIN_AMOUNT.test(amount) || !new Decimal(amount).gt(0)) throw new HttpError(400, 'Bad amount');
    const xrd = config.network.xrd;
    const at = chargeAt(sell, buy, xrd);
    // A pair without XRD is quoted along the route through XRD the solver uses, if there is one.
    const hop = at === 'hop' ? await data.hopQuote(sell, buy, new Decimal(amount).toFixed()).catch(() => undefined) : undefined;
    const q = hop ?? await data.quote(sell, buy, new Decimal(amount).toFixed());
    if (!q) throw new HttpError(404, 'No route with enough liquidity');
    // Charged with the venue's safety margin, if any; q.networkFeeXrd is the fee as measured.
    const gasXrd = fillGasXrd(0, chargedSwapFeeXrd(q));
    const allowanceXrd = gasXrd.mul(GAS_ALLOWANCE_MARGIN).toDecimalPlaces(18, Decimal.ROUND_UP);
    // The network fee of a fill through this route, in the token being bought, so the site can show it before an order is signed.
    // gasInBuyToken is the solver's estimate; gasAllowanceInBuyToken adds a margin. Kept for older pages: the charge itself is in XRD (below).
    const gas = (await data.xrdValueIn(buy, gasXrd).catch(() => undefined)) ?? null;
    // Added 22 Nov 2026: what is really charged, in XRD, and where.
    // feeAt: 'buy' (out of the XRD bought), 'sell' (out of the XRD sold, before the swap), 'hop' (between the two swaps through XRD),
    // or null when the solver cannot fill this pair. xrdBase is the XRD the service fee is charged on for this quote:
    // the XRD bought, the XRD sold, or what the first swap produces.
    const feeAt = at === 'proceeds' ? 'buy' : at === 'input' ? 'sell' : hop ? 'hop' : null;
    const xrdBase = at === 'proceeds' ? q.buyAmount : at === 'input' ? q.sellAmount : hop?.xrdBase ?? null;
    return {
      ...q, gasInBuyToken: gas, gasAllowanceInBuyToken: gas === null ? null : new Decimal(gas).mul(GAS_ALLOWANCE_MARGIN).toDecimalPlaces(18, Decimal.ROUND_UP).toFixed(),
      feeAt, feeToken: feeAt ? xrd : null, gasXrd: gasXrd.toFixed(), gasAllowanceXrd: allowanceXrd.toFixed(), xrdBase,
    };
  }, 4); // each distinct amount costs up to four Gateway previews, so it counts as four requests

  api.on('GET', '/api/balances', async ({ url }) => {
    const account = need(url.searchParams.get('account'), 'account');
    if (!isAccount(account)) throw new HttpError(400, 'Bad account address');
    return gatewayInput(() => readGateway.fungibleBalances(account));
  });

  api.on('GET', '/api/trades', async ({ url }) => {
    const market = marketOr404(need(url.searchParams.get('market'), 'market'));
    readBookSoon();
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
    readBookSoon();
    const activity = await gatewayInput(() => readGateway.accountActivity(account));
    const mine = (book?.fills ?? []).flatMap((f) => {
      const o = book!.orders.get(f.id);
      return o && o.maker === account ? [{ f, o, got: new Decimal(f.paid).minus(f.fee) }] : [];
    });
    const trades = [];
    for (const { f, o, got } of mine) trades.push({ txid: f.txid, time: f.time, sell: o.sell, sellAmount: f.sold, buy: o.buy, buyAmount: got.toFixed(), feeXrd: '0', book: f.id });
    for (const t of activity) {
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
    readBookSoon();
    const now = Math.floor(Date.now() / 1000);
    const signed = store.byAccount(account);
    const registry = await Promise.all(signed.map((o) => (o.status === 'open' ? checksRegistry(o) : undefined)));
    return [
      ...(book?.byMaker(account) ?? []).map((o) => bookOrderView(o, now, book?.placedAt.get(o.id))),
      ...signed.map((o, i) => ({ ...publicOrder(o), outlook: o.status === 'open' ? solver?.outlook.get(o.id) ?? null : null, ...(registry[i] === undefined ? {} : { registry: registry[i] }) })),
    ];
  });

  // Does this signed order check the registry the server names now (`assert_live`)? Only then can a
  // cancel recorded there stop it. Read from the signed bytes once per order; open orders only.
  const registryOf = new Map<string, boolean>();
  async function checksRegistry(o: StoredOrder): Promise<boolean> {
    if (!config.registry) return false;
    let v = registryOf.get(o.id);
    if (v === undefined) {
      try {
        const m = (await decodeSignedPartialTransaction(o.signedPartialTransactionHex, config.network.networkId)).manifest;
        v = m.includes('"assert_live"') && m.includes(config.registry);
      } catch { v = false; }
      if (registryOf.size > 5_000) registryOf.clear();
      registryOf.set(o.id, v);
    }
    return v;
  }

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
        // At most MAX_REJECTED_FILES are kept: a flood of bad posts must not fill the disk.
        if (config.network.name !== 'mainnet' && config.dataDir !== ':memory:') {
          try {
            const dir = join(config.dataDir, 'rejected');
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            if (readdirSync(dir).length < MAX_REJECTED_FILES) writeFileSync(join(dir, Date.now() + '.json'), JSON.stringify({ reason: e.message, submission }, null, 2).slice(0, 60_000), { mode: 0o600 });
          } catch { /* diagnostics only */ }
        }
        throw new HttpError(400, e.message);
      }
      throw e;
    }
    const p = order.params;
    // Only the tokens of a market the site lists: the solver will not touch anything else.
    if (!data.markets.length) throw new HttpError(503, 'Markets are not loaded yet; try again shortly');
    if (!data.isListedPair(p.sell, p.buy)) throw new HttpError(400, 'These two tokens do not form a market listed here');
    // The solver takes its charges in XRD: a pair without XRD needs a route through XRD.
    if (!data.solverCanFill(p.sell, p.buy)) throw new HttpError(400, 'This pair cannot be filled by the exchange: its fees are taken in XRD, and neither token is XRD nor is there a route through XRD. Use an “In parts” order in the order book instead.');
    // A withdrawal with more decimal places than the token allows fails on ledger.
    let div: number;
    try { div = await data.quoter.divisibility(p.sell); } catch { throw new HttpError(503, 'Could not read the token from the ledger; try again shortly'); }
    if (new Decimal(p.sellAmount).decimalPlaces() > div) throw new HttpError(400, `sellAmount has more decimal places than the token allows (${div})`);
    if (store.openCount(p.account) >= config.maxOpenOrdersPerAccount) throw new HttpError(429, 'Too many open orders for this account');
    if (store.accountFailuresSince(p.account, Math.floor(Date.now() / 1000) - 86400) >= config.accountFailureLimit) {
      throw new HttpError(429, 'Orders from this account failed to fill too often today; try again tomorrow');
    }
    // One order key per order: a key already used (and perhaps already cancelled on ledger) would make an order that cannot fill.
    if (store.orderKeyUsed(submission.orderKeyHex)) throw new HttpError(409, 'This order key has already been used; sign the order with a fresh one');
    if (config.registry) {
      const cancelled = await orderKeyCancelled(readGateway, config.registry, submission.orderKeyHex);
      if (cancelled === true) throw new HttpError(400, 'This order key has been cancelled on ledger');
      if (cancelled === undefined) throw new HttpError(503, 'Could not check the order key on ledger; try again shortly');
    }
    const inserted = store.insert({
      id: order.hashId, account: order.params.account, sell: order.params.sell, sellAmount: order.params.sellAmount,
      buy: order.params.buy, minBuyAmount: order.params.minBuyAmount, limitBuyAmount: order.limitBuyAmount, kind: order.kind, orderKeyHex: submission.orderKeyHex,
      expiresAt: order.expiresAt, createdAt: Math.floor(Date.now() / 1000), signedPartialTransactionHex: order.signedPartialTransactionHex,
    });
    if (!inserted) throw new HttpError(409, 'This order has already been submitted');
    const sym = (r: string) => data.symbol(r);
    console.log(`[orders] accepted ${order.kind} ${order.hashId.slice(-8)} from ${p.account.slice(-8)}: ${p.sellAmount} ${sym(p.sell)} for at least ${p.minBuyAmount} ${sym(p.buy)} (fills at ${order.limitBuyAmount}), expires ${new Date(order.expiresAt * 1000).toISOString()}`);
    // A market order should not wait for the next timer pass, nor behind resting orders.
    if (order.kind === 'market') solver?.kick();
    return { id: order.hashId, expiresAt: order.expiresAt };
  });

  // Soft cancel: whoever holds the secret whose hash was fixed when the order was made.
  api.on('POST', '/api/orders/:id/cancel', async ({ params, body }) => {
    const b = await body();
    if (!b || typeof b !== 'object') throw new HttpError(400, 'Body must be a JSON object');
    const { secret } = b;
    const order = store.get(params.id!);
    if (!order) throw new HttpError(404, 'Unknown order');
    let key: string;
    try { key = orderKeyFromSecret(String(secret)); } catch { throw new HttpError(400, 'Bad cancel secret'); }
    if (key !== order.orderKeyHex) throw new HttpError(403, 'Wrong cancel secret');
    if (!store.markCancelled(order.id)) throw new HttpError(409, `Order is already ${order.status}`);
    console.log(`[orders] cancelled ${order.id.slice(-8)} at its owner's request${order.pendingTx ? ' (a fill is in flight and may still commit)' : ''}`);
    return { id: order.id, status: 'cancelled' };
  });

  return { api, data, store, solver, gateway, readGateway, config, book };
}
