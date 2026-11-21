import {
  type Depth, type Gateway, type Market, type Pool, type Quote, type Token,
  Quoter, buildMarkets, filterAllowedPools, listDefiPlaza, listOciswap, mergeDepth, tokensFromLedger, defaultJsonFetch, Decimal } from '@radix-dex/core';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

const RESOLUTIONS: Record<string, string> = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': '1D', '1w': 'W' };
const RES_SECONDS: Record<string, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };

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
      return;
    }
    const min = { minTvlUsd: this.config.minPoolTvlUsd };
    const results = await Promise.allSettled([listOciswap(min), listDefiPlaza(min)]);
    const listed: Pool[] = [];
    const tokens = new Map<string, Token>();
    const errors: string[] = [];
    for (const r of results) {
      if (r.status === 'rejected') { errors.push(String(r.reason?.message ?? r.reason)); continue; }
      listed.push(...r.value.pools);
      for (const t of r.value.tokens) tokens.set(t.address, t);
    }
    this.lastError = errors.length ? errors.join('; ') : undefined;
    if (listed.length === 0) return;
    const pools = await filterAllowedPools(this.gateway, listed);
    const missing = [...new Set(pools.flatMap((p) => p.tokens))].filter((a) => !tokens.has(a));
    if (missing.length) for (const t of await tokensFromLedger(this.gateway, missing)) tokens.set(t.address, t);
    this.pools = pools;
    this.tokens = tokens;
    this.markets = buildMarkets(pools, tokens, this.config.quotePriority);
    this.refreshedAt = Date.now();
  }

  market(id: string): Market | undefined {
    return this.markets.find((m) => m.id === id);
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
      this.xrdRates.set(resource, rate);
    }
    return rate.perXrd?.mul(xrdAmount).toFixed(18);
  }

  quote(sell: string, buy: string, amount: string): Promise<Quote | undefined> {
    return this.quoteCache.get(`${sell}|${buy}|${amount}`, () => this.quoter.best(this.pools, sell, buy, amount, this.config.network.xrd));
  }

  depth(market: Market): Promise<Depth> {
    return this.depthCache.get(market.id, async () => {
      // Probe the two deepest pools; more would multiply Gateway load for little extra depth.
      const pools = [...market.pools].sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 2);
      const parts = await Promise.all(pools.map((p) => this.quoter.poolDepth(market, p).catch(() => ({ bids: [], asks: [] }))));
      return mergeDepth(market.id, parts);
    });
  }

  /** Candles for a market, as the ratio of the two tokens' USD series from Ociswap's chart feed. */
  candles(market: Market, resolution: string, count = 300): Promise<Candle[]> {
    if (this.config.network.name !== 'mainnet') return Promise.resolve(this.sampledCandles(market, resolution, count));
    const res = RESOLUTIONS[resolution];
    if (!res) return Promise.reject(new Error(`Unsupported resolution "${resolution}"`));
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
      return candles.filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0));
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
    const step = RES_SECONDS[resolution];
    if (!step) throw new Error(`Unsupported resolution "${resolution}"`);
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
