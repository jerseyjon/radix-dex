import type { Gateway } from './gateway.ts';
import { Decimal, addr, bucket, dec } from './manifest.ts';
import type { Depth, DepthLevel, Market, Pool, Quote } from './types.ts';
import { swapInstruction } from './venues.ts';

const other = (pool: Pool, token: string): string | undefined =>
  pool.tokens[0] === token ? pool.tokens[1] : pool.tokens[1] === token ? pool.tokens[0] : undefined;

/** The token path a route takes, starting from `sell`. Throws if the pools do not chain. */
export function routePath(route: Pool[], sell: string): string[] {
  const path = [sell];
  for (const pool of route) {
    const next = other(pool, path[path.length - 1]!);
    if (!next) throw new Error(`Pool ${pool.address} does not trade ${path[path.length - 1]}`);
    path.push(next);
  }
  return path;
}

/** Manifest lines that swap bucket `<prefix>0` (default `in0`) along `route`, leaving the final token on the worktop. */
export function routeInstructions(route: Pool[], sell: string, prefix = 'in'): string[] {
  const path = routePath(route, sell);
  const lines: string[] = [];
  route.forEach((pool, i) => {
    lines.push(swapInstruction(pool, `${prefix}${i}`, path[i + 1]!));
    if (i < route.length - 1) lines.push(`TAKE_ALL_FROM_WORKTOP ${addr(path[i + 1]!)} ${bucket(`${prefix}${i + 1}`)};`);
  });
  return lines;
}

/**
 * Quotes by previewing real swap manifests on the Gateway.
 * The preview withdraws from a large holder of the sold token ("funder") with signatures assumed;
 * nothing is ever submitted.
 */
export class Quoter {
  private readonly gateway: Gateway;
  /** Large holders of each token, used to fund preview quotes. Re-read hourly: holders move their funds. */
  private readonly funders = new Map<string, { at: number; list: Promise<{ address: string; amount: Decimal }[]> }>();
  private readonly divisibilities = new Map<string, Promise<number>>();
  private epoch: { value: number; at: number } | undefined;
  /** Why the most recent failed simulation failed; for diagnostics only. */
  lastFailure: string | undefined;
  /** Quotes that could not be made because a call failed (as opposed to finding no route). Only ever grows. */
  errors = 0;

  constructor(gateway: Gateway) {
    this.gateway = gateway;
  }

  private async currentEpoch(): Promise<number> {
    if (!this.epoch || Date.now() - this.epoch.at > 60_000) {
      this.epoch = { value: (await this.gateway.status()).epoch, at: Date.now() };
    }
    return this.epoch.value;
  }

  /** A token's divisibility: amounts with more decimal places than this cannot be withdrawn at all. */
  divisibility(resource: string): Promise<number> {
    let p = this.divisibilities.get(resource);
    if (!p) {
      p = this.gateway.entityDetails([resource]).then((d) => {
        const div = d[0]?.details?.divisibility;
        if (typeof div !== 'number') throw new Error(`No divisibility for ${resource}`);
        return div;
      });
      p.catch(() => this.divisibilities.delete(resource));
      this.divisibilities.set(resource, p);
    }
    return p;
  }

  private fundersFor(resource: string) {
    const hit = this.funders.get(resource);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.list;
    const list = this.gateway.resourceHolders(resource, 30).then((hs) =>
      hs.filter((h) => h.address.startsWith('account_')).map((h) => ({ address: h.address, amount: new Decimal(h.amount) })),
    );
    list.catch(() => this.funders.delete(resource));
    this.funders.set(resource, { at: Date.now(), list });
    return list;
  }

  /** Simulate selling `sellAmount` of `sell` along `route`. Returns undefined if no funder can cover it or the swap fails. */
  async simulate(route: Pool[], sell: string, sellAmount: string | Decimal): Promise<Quote | undefined> {
    const amount = new Decimal(sellAmount).toDecimalPlaces(await this.divisibility(sell), Decimal.ROUND_DOWN);
    if (!amount.gt(0)) return undefined;
    const path = routePath(route, sell);
    const buy = path[path.length - 1]!;
    const epoch = await this.currentEpoch();
    const funders = (await this.fundersFor(sell)).filter((f) => f.amount.gte(amount)).slice(0, 3);
    for (const funder of funders) {
      const manifest = [
        `CALL_METHOD ${addr(funder.address)} "withdraw" ${addr(sell)} ${dec(amount)};`,
        `TAKE_ALL_FROM_WORKTOP ${addr(sell)} ${bucket('in0')};`,
        ...routeInstructions(route, sell),
        `CALL_METHOD ${addr(funder.address)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
      ].join('\n');
      const res = await this.gateway.preview(manifest, epoch);
      if (!res.ok) {
        // An account that is securified or otherwise unusable fails at the withdraw; try the next holder.
        this.lastFailure = res.error;
        if (/withdraw|Unauthorized|AuthError/i.test(res.error ?? '')) continue;
        return undefined;
      }
      const net = (resource: string) => res.changes
        .filter((c) => c.entity === funder.address && c.resource === resource)
        .reduce((a, c) => a.plus(c.amount), new Decimal(0));
      const received = net(buy);
      // A pool short of liquidity can hand part of the input back, so measure what was really sold.
      const sold = net(sell).neg();
      if (!received.gt(0) || !sold.gt(0)) return undefined;
      return {
        sell, buy,
        sellAmount: sold.toFixed(),
        buyAmount: received.toFixed(),
        price: received.div(sold).toSignificantDigits(12).toFixed(),
        route,
        networkFeeXrd: res.feeXrd,
      };
    }
    return undefined;
  }

  /** Candidate routes: the deepest direct pools, plus one two-hop route through `hub` (normally XRD). */
  candidateRoutes(pools: Pool[], sell: string, buy: string, hub: string, maxDirect = 3): Pool[][] {
    const byDepth = (a: Pool, b: Pool) => b.tvlUsd - a.tvlUsd;
    const direct = pools.filter((p) => other(p, sell) === buy).sort(byDepth).slice(0, maxDirect).map((p) => [p]);
    const routes = [...direct];
    if (sell !== hub && buy !== hub) {
      const leg1 = pools.filter((p) => other(p, sell) === hub).sort(byDepth)[0];
      const leg2 = pools.filter((p) => other(p, hub) === buy).sort(byDepth)[0];
      if (leg1 && leg2) routes.push([leg1, leg2]);
    }
    return routes;
  }

  /** Best single route by amount received. */
  async best(pools: Pool[], sell: string, buy: string, sellAmount: string | Decimal, hub: string): Promise<Quote | undefined> {
    const routes = this.candidateRoutes(pools, sell, buy, hub);
    const quotes = await Promise.all(routes.map((r) => this.simulate(r, sell, sellAmount).catch((e) => { this.errors++; this.lastFailure = String((e as Error)?.message ?? e).slice(0, 200); return undefined; })));
    let best: Quote | undefined;
    for (const q of quotes) if (q && (!best || new Decimal(q.buyAmount).gt(best.buyAmount))) best = q;
    return best;
  }

  /**
   * Order-book style depth for one pool, from previews at a ladder of sizes.
   * `fractions` are cumulative shares of the pool's reserve of the token being sold.
   */
  async poolDepth(market: Market, pool: Pool, fractions = [0.002, 0.01, 0.025, 0.05, 0.1, 0.2]): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }> {
    const base = market.base.address, quote = market.quote.address;
    const reserve = (token: string) => pool.reserves[pool.tokens[0] === token ? 0 : 1];
    const ladder = async (sell: string) => {
      const sizes = fractions.map((f) => new Decimal(reserve(sell)).mul(f)).filter((s) => s.gt(0));
      const qs = await Promise.all(sizes.map((s) => this.simulate([pool], sell, s).catch(() => undefined)));
      const steps: { sold: Decimal; got: Decimal }[] = [];
      let prevSold = new Decimal(0), prevGot = new Decimal(0);
      for (const q of qs) {
        if (!q) continue;
        const sold = new Decimal(q.sellAmount), got = new Decimal(q.buyAmount);
        if (sold.lte(prevSold) || got.lte(prevGot)) continue;
        steps.push({ sold: sold.minus(prevSold), got: got.minus(prevGot) });
        prevSold = sold; prevGot = got;
      }
      return steps;
    };
    const [sellBase, sellQuote] = await Promise.all([ladder(base), ladder(quote)]);
    return {
      // Selling base into the pool consumes its bids: price = quote received per base sold.
      bids: sellBase.map((s) => ({ price: s.got.div(s.sold).toNumber(), size: s.sold.toNumber(), source: pool.venue })),
      // Selling quote into the pool lifts its asks: price = quote paid per base received.
      asks: sellQuote.map((s) => ({ price: s.sold.div(s.got).toNumber(), size: s.got.toNumber(), source: pool.venue })),
    };
  }
}

/** Merge per-source levels into one book: bids high to low, asks low to high. */
export function mergeDepth(marketId: string, parts: { bids: DepthLevel[]; asks: DepthLevel[] }[]): Depth {
  const bids = parts.flatMap((p) => p.bids).filter((l) => l.price > 0 && l.size > 0).sort((a, b) => b.price - a.price);
  const asks = parts.flatMap((p) => p.asks).filter((l) => l.price > 0 && l.size > 0).sort((a, b) => a.price - b.price);
  const mid = bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : (bids[0]?.price ?? asks[0]?.price ?? null);
  return { marketId, mid, bids, asks };
}
