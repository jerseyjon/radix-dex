import {
  type Depth, type Gateway, type LedgerSwap, type Market, type Pool, type Quote, type Token,
  Quoter, buildMarkets, filterAllowedPools, listCaviarNine, listDefiPlaza, listOciswap, mergeDepth, poolsToProbe, tokensFromLedger, defaultJsonFetch, Decimal } from '@radix-dex/core';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

const RESOLUTIONS: Record<string, string> = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': '1D', '1w': 'W' };
const RES_SECONDS: Record<string, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };

/** Is this one of the candle resolutions served? Own keys only: `__proto__` and `toString` are not resolutions. */
export const isResolution = (r: string): boolean => Object.hasOwn(RESOLUTIONS, r);

/**
 * Make a candle self-consistent: the high is at least the open and the close, the low at most.
 * Ociswap's feed opens each bar at the previous bar's close but takes the high and low from the
 * bar's own trades only, so a bar with one trade can have its open outside its high-low range.
 */
export function normaliseCandle(c: Candle): Candle {
  return { ...c, high: Math.max(c.open, c.high, c.close), low: Math.min(c.open, c.low, c.close) };
}

class TtlCache<V> {
  private readonly map = new Map<string, { at: number; value: Promise<V> }>();
  private readonly ttlMs: number;
  constructor(ttlMs: number) { this.ttlMs = ttlMs; }
  get(key: string, make: () => Promise<V>): Promise<V> {
    const hit = this.map.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = make();
    this.map.set(key, { at: Date.now(), value });
    value.catch(() => this.map.delete(key));
    if (this.map.size > 500) for (const [k, v] of this.map) if (Date.now() - v.at > this.ttlMs) this.map.delete(k);
    return value;
  }
}

/** Holds the market list and answers quote, depth and candle requests, with short caches. */
export class MarketData {
  markets: Market[] = [];
  pools: Pool[] = [];
  tokens = new Map<string, Token>();
  refreshedAt = 0;
  lastError: string | undefined;

  private readonly config: Config;
  private readonly gateway: Gateway;
  readonly quoter: Quoter;
  private readonly quoteCache = new TtlCache<Quote | undefined>(8_000);
  private readonly depthCache = new TtlCache<Depth>(20_000);
  private readonly tradesCache = new TtlCache<(LedgerSwap & { venue: string })[]>(15_000);
  private readonly candleCache = new TtlCache<Candle[]>(60_000);
  /** Mid-price samples per market, for networks with no chart feed. Kept in memory only. */
  private readonly samples = new Map<string, { time: number; price: number }[]>();

  constructor(config: Config, gateway: Gateway) {
    this.config = config;
    this.gateway = gateway;
    this.quoter = new Quoter(gateway);
  }

  /** Rebuild the market list from the venues. A venue that fails is skipped; the previous list is kept if all fail. */
  async refresh(): Promise<void> {
    if (this.config.network.name !== 'mainnet') {
      // No venue APIs off mainnet: markets come from a local file of tokens and pools.
      if (this.config.marketsFile) {
        const j = JSON.parse(readFileSync(this.config.marketsFile, 'utf8'));
        this.tokens = new Map((j.tokens as Token[]).map((t) => [t.address, t]));
        this.pools = j.pools as Pool[];
        this.markets = buildMarkets(this.pools, this.tokens, [...(j.quotePriority ?? []), ...this.config.quotePriority]);
        for (const [base, quote] of (j.markets ?? []) as [string, string][]) {
          const id = `${base}/${quote}`;
          const b = this.tokens.get(base), q = this.tokens.get(quote);
          if (b && q && !this.markets.some((m) => m.id === id)) this.markets.push({ id, base: b, quote: q, pools: [], tvlUsd: 0, volume24hUsd: 0 });
        }
      }
      this.refreshedAt = Date.now();
      void this.loadDivisibilities();
      return;
    }
    const min = { minTvlUsd: this.config.minPoolTvlUsd };
    const results = await Promise.allSettled([listOciswap(min), listDefiPlaza(min)]);
    const listed: Pool[] = [];
    const tokens = new Map<string, Token>();
    const pricesUsd: Record<string, number> = {};
    const errors: string[] = [];
    for (const r of results) {
      if (r.status === 'rejected') { errors.push(String(r.reason?.message ?? r.reason)); continue; }
      listed.push(...r.value.pools);
      for (const t of r.value.tokens) tokens.set(t.address, t);
      Object.assign(pricesUsd, r.value.pricesUsd ?? {});
    }
    if (listed.length === 0) { this.lastError = errors.join('; ') || undefined; return; }
    // Best-effort venues, read from the ledger and valued at the prices just listed. Their failure is noted, never fatal.
    try {
      listed.push(...(await listCaviarNine(this.gateway, { pricesUsd })).pools);
    } catch (e) {
      errors.push(`caviarnine: ${String((e as Error)?.message ?? e)}`);
    }
    this.lastError = errors.length ? errors.join('; ') : undefined;
    const pools = await filterAllowedPools(this.gateway, listed);
    const missing = [...new Set(pools.flatMap((p) => p.tokens))].filter((a) => !tokens.has(a));
    if (missing.length) for (const t of await tokensFromLedger(this.gateway, missing)) tokens.set(t.address, t);
    this.pools = pools;
    this.tokens = tokens;
    this.markets = buildMarkets(pools, tokens, this.config.quotePriority);
    this.refreshedAt = Date.now();
    void this.loadDivisibilities();
  }

  market(id: string): Market | undefined {
    return this.markets.find((m) => m.id === id);
  }

  private readonly divisibilities = new Map<string, number>();

  /**
   * Read the divisibility of every listed token not yet known (the quoter caches it for good), a few
   * at a time. A failure is left for the next refresh. `/api/markets` publishes what is known, so the
   * order form can round amounts the way order intake checks them.
   */
  async loadDivisibilities(): Promise<void> {
    const todo = [...new Set(this.markets.flatMap((m) => [m.base.address, m.quote.address]))].filter((r) => !this.divisibilities.has(r));
    for (let i = 0; i < todo.length; i += 5) {
      await Promise.all(todo.slice(i, i + 5).map((r) => this.quoter.divisibility(r).then((d) => { this.divisibilities.set(r, d); }, () => undefined)));
    }
  }

  /** A listed token's divisibility, if it has been read. */
  divisibility(resource: string): number | undefined {
    return this.divisibilities.get(resource);
  }

  /** A token's symbol for log lines, or the start of its address. */
  symbol(resource: string): string {
    const m = this.markets.find((x) => x.base.address === resource || x.quote.address === resource);
    return this.tokens.get(resource)?.symbol ?? (m ? (m.base.address === resource ? m.base.symbol : m.quote.symbol) : resource.slice(0, 16) + '…');
  }

  /** Do these two tokens form a market the site lists? Only such pairs are accepted and filled. */
  isListedPair(a: string, b: string): boolean {
    return this.markets.some((m) => (m.base.address === a && m.quote.address === b) || (m.base.address === b && m.quote.address === a));
  }

  /** A two-pool route from `sell` to `buy` through XRD among the listed pools (deepest pool on each side), if there is one. */
  xrdRoute(sell: string, buy: string): Pool[] | undefined {
    const xrd = this.config.network.xrd;
    if (sell === xrd || buy === xrd) return undefined;
    return this.quoter.candidateRoutes(this.pools, sell, buy, xrd).find((r) => r.length === 2);
  }

  /**
   * Can the solver fill orders between these two tokens? It takes its charges in XRD, so the pair
   * must have XRD on one side, or a route through XRD (a listed pool from each token to XRD).
   */
  solverCanFill(sell: string, buy: string): boolean {
    const xrd = this.config.network.xrd;
    return sell === xrd || buy === xrd || this.xrdRoute(sell, buy) !== undefined;
  }

  private readonly xrdRates = new Map<string, { at: number; perXrd: Decimal | undefined }>();

  /**
   * What `xrdAmount` of XRD is worth in `resource`, at what pools pay for XRD now. Used to charge
   * the network fee, which the solver pays in XRD, in whatever token an order buys.
   * Undefined when no pool route prices the token: such an order cannot be charged, so it is not filled.
   */
  async xrdValueIn(resource: string, xrdAmount: string | number | Decimal): Promise<string | undefined> {
    const xrd = this.config.network.xrd;
    if (resource === xrd) return new Decimal(xrdAmount).toFixed();
    let rate = this.xrdRates.get(resource);
    if (!rate || Date.now() - rate.at > 120_000) {
      const probe = '10';
      const q = await this.quoter.best(this.pools, xrd, resource, probe, xrd).catch(() => undefined);
      rate = { at: Date.now(), perXrd: q ? new Decimal(q.buyAmount).div(probe) : undefined };
      // A failed probe is not remembered: one Gateway blip must not stop every fill in this token for two minutes.
      if (rate.perXrd) this.xrdRates.set(resource, rate);
    }
    return rate.perXrd?.mul(xrdAmount).toFixed(18);
  }

  quote(sell: string, buy: string, amount: string): Promise<Quote | undefined> {
    return this.quoteCache.get(`${sell}|${buy}|${amount}`, () => this.quoter.best(this.pools, sell, buy, amount, this.config.network.xrd));
  }

  /**
   * For a pair without XRD: the quote along the route through XRD the solver uses, and how much XRD
   * the first swap produces (the amount its service fee is charged on). Undefined if there is no such route.
   */
  hopQuote(sell: string, buy: string, amount: string): Promise<(Quote & { xrdBase: string }) | undefined> {
    return this.hopCache.get(`${sell}|${buy}|${amount}`, async () => {
      const route = this.xrdRoute(sell, buy);
      if (!route) return undefined;
      const [whole, leg1] = await Promise.all([this.quoter.simulate(route, sell, amount), this.quoter.simulate([route[0]!], sell, amount)]);
      if (!whole || !leg1) return undefined;
      return { ...whole, xrdBase: leg1.buyAmount };
    });
  }
  private readonly hopCache = new TtlCache<(Quote & { xrdBase: string }) | undefined>(8_000);

  depth(market: Market): Promise<Depth> {
    return this.depthCache.get(market.id, async () => {
      // Probe the three deepest pools. Two was too few: a slightly smaller low-fee pool is where small
      // orders really trade, and without it the book showed a spread nobody pays. More would multiply Gateway load.
      // Best-effort pools are probed as well, not in place of these; one that fails adds no levels.
      const pools = poolsToProbe(market.pools, 3);
      const parts = await Promise.all(pools.map((p) => this.quoter.poolDepth(market, p).catch(() => ({ bids: [], asks: [] }))));
      return mergeDepth(market.id, parts);
    });
  }

  /**
   * Recent swaps in a market's three deepest pools (and its best-effort pools), read from the ledger, each labelled with its venue.
   * A pool that cannot be read is left out rather than failing the list.
   */
  venueTrades(market: Market): Promise<(LedgerSwap & { venue: string })[]> {
    return this.tradesCache.get(market.id, async () => {
      const pools = poolsToProbe(market.pools, 3);
      // Only the pool's own holdings count as its side of a trade: its component, or the native pool that holds its funds.
      const lists = await Promise.all(pools.map((p) => this.gateway.swapsAt(p.address, market.base.address, market.quote.address, 30, [p.address, ...(p.holders ?? [])]).catch(() => [] as LedgerSwap[])));
      const seen = new Set<string>(), out: (LedgerSwap & { venue: string })[] = [];
      // A transaction through two of these pools turns up in both lists: keep each swap once.
      lists.forEach((list, i) => { for (const s of list) { const k = s.txid + s.entity; if (!seen.has(k)) { seen.add(k); out.push({ ...s, venue: pools[i]!.venue }); } } });
      return out.sort((a, b) => b.time - a.time);
    });
  }

  /** Candles for a market, as the ratio of the two tokens' USD series from Ociswap's chart feed. */
  candles(market: Market, resolution: string, count = 300): Promise<Candle[]> {
    if (this.config.network.name !== 'mainnet') return Promise.resolve(this.sampledCandles(market, resolution, count));
    if (!isResolution(resolution)) return Promise.reject(new Error(`Unsupported resolution "${resolution}"`));
    const res = RESOLUTIONS[resolution]!;
    return this.candleCache.get(`${market.id}|${resolution}`, async () => {
      const to = Math.floor(Date.now() / 1000);
      const from = to - RES_SECONDS[resolution]! * count;
      const xrd = this.config.network.xrd;
      const series = async (token: string, currency: 'XRD' | 'USD') => {
        const j = await defaultJsonFetch(`https://api.ociswap.com/udf/history?symbol=${token}&resolution=${res}&from=${from}&to=${to}&currencyCode=${currency}`);
        const out = new Map<number, Candle>();
        if (j?.s !== 'ok' || !Array.isArray(j.t)) return out;
        j.t.forEach((t: number, i: number) => out.set(t, {
          time: t, open: Number(j.o[i]), high: Number(j.h[i]), low: Number(j.l[i]), close: Number(j.c[i]), volume: Number(j.v?.[i] ?? 0),
        }));
        return out;
      };
      let candles: Candle[];
      if (market.quote.address === xrd) {
        // Priced in XRD: the feed's own candles, wicks and all.
        candles = [...(await series(market.base.address, 'XRD')).values()];
      } else if (market.base.address === xrd && this.config.quotePriority.indexOf(market.quote.address) < this.config.quotePriority.indexOf(xrd)) {
        // XRD against a dollar stablecoin: XRD's dollar candles are a fair stand-in.
        candles = [...(await series(xrd, 'USD')).values()];
      } else {
        // Any other pair: ratio of the two XRD-priced series. Highs and lows of a ratio cannot be
        // recovered from two separate series, so these candles show open and close only.
        const [base, quote] = await Promise.all([series(market.base.address, 'XRD'), series(market.quote.address, 'XRD')]);
        candles = [];
        let lastQuote: Candle | undefined;
        for (const t of [...base.keys()].sort((x, y) => x - y)) {
          const b = base.get(t)!;
          const q = quote.get(t) ?? lastQuote;
          if (!q || !(q.close > 0) || !(q.open > 0)) continue;
          lastQuote = q;
          const open = b.open / q.open, close = b.close / q.close;
          candles.push({ time: t, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: b.volume });
        }
      }
      candles.sort((x, y) => x.time - y.time);
      return candles.filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0)).map(normaliseCandle);
    });
  }

  /** Record the current mid price of every market that has pools. Call on a timer where there is no chart feed. */
  async samplePrices(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const market of this.markets) {
      if (!market.pools.length) continue;
      const mid = (await this.depth(market).catch(() => undefined))?.mid;
      if (!mid || !(mid > 0)) continue;
      const list = this.samples.get(market.id) ?? [];
      list.push({ time: now, price: mid });
      if (list.length > 50_000) list.splice(0, list.length - 50_000);
      this.samples.set(market.id, list);
    }
  }

  /** Candles built from the sampled mid prices. No volume: these are quotes, not trades. */
  private sampledCandles(market: Market, resolution: string, count: number): Candle[] {
    if (!isResolution(resolution)) throw new Error(`Unsupported resolution "${resolution}"`);
    const step = RES_SECONDS[resolution]!;
    const out = new Map<number, Candle>();
    for (const s of this.samples.get(market.id) ?? []) {
      const time = Math.floor(s.time / step) * step;
      const c = out.get(time);
      if (!c) out.set(time, { time, open: s.price, high: s.price, low: s.price, close: s.price, volume: 0 });
      else { c.high = Math.max(c.high, s.price); c.low = Math.min(c.low, s.price); c.close = s.price; }
    }
    return [...out.values()].slice(-count);
  }
}
