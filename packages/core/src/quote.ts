import type { Gateway } from './gateway.ts';
import { Decimal, addr, bucket, dec } from './manifest.ts';
import {
  OWNER_POOL_PACKAGES, OWNER_POOL_SWAP_FEE_XRD, OwnerPoolQuoteError, ownerPoolQuote, ownerPoolSwapInstruction, readOwnerPools, type OwnerPoolState,
} from './ownerpool.ts';
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

const isOwnerPool = (p: Pool) => p.venue === 'ownerpool';

/**
 * Manifest lines that swap bucket `<prefix>0` (default `in0`) along `route`, leaving the final token on the worktop.
 *
 * `minOut` is the least the route's last swap must produce. A route through an OwnerPool must
 * have one (the owner can change the fee or move the price at any moment, so its swaps always
 * carry a minimum): when the last pool is an OwnerPool it calls `swap_with_minimum` with it,
 * otherwise an `ASSERT_WORKTOP_CONTAINS` of the final token follows the route (an OwnerPool
 * earlier in the route is covered by that, since a later swap pays more the more it is given).
 * Other routes are unchanged and ignore `minOut`. `previewOnly` allows an OwnerPool route without a
 * minimum (`swap_with_minimum` of zero), for quotes by preview that are never submitted.
 */
export function routeInstructions(route: Pool[], sell: string, prefix = 'in', minOut?: string | Decimal, opts: { previewOnly?: boolean } = {}): string[] {
  const path = routePath(route, sell);
  const owner = route.some(isOwnerPool);
  let min: string | undefined;
  if (owner) {
    if (minOut === undefined) {
      if (!opts.previewOnly) throw new Error('a route through an OwnerPool needs a minimum output');
      min = '0';
    } else {
      const m = new Decimal(minOut);
      if (!m.gt(0)) throw new Error(`OwnerPool route minimum must be positive, not ${m.toFixed()}`);
      min = m.toFixed();
    }
  }
  const lines: string[] = [];
  route.forEach((pool, i) => {
    const last = i === route.length - 1;
    if (isOwnerPool(pool) && last) lines.push(ownerPoolSwapInstruction(pool.address, `${prefix}${i}`, min!));
    else if (isOwnerPool(pool)) lines.push(`CALL_METHOD ${addr(pool.address)} "swap" ${bucket(`${prefix}${i}`)};`);
    else lines.push(swapInstruction(pool, `${prefix}${i}`, path[i + 1]!));
    if (!last) lines.push(`TAKE_ALL_FROM_WORKTOP ${addr(path[i + 1]!)} ${bucket(`${prefix}${i + 1}`)};`);
  });
  if (owner && !isOwnerPool(route[route.length - 1]!) && new Decimal(min!).gt(0)) {
    lines.push(`ASSERT_WORKTOP_CONTAINS ${addr(path[path.length - 1]!)} ${dec(min!)};`);
  }
  return lines;
}

/**
 * The score `Quoter.best` ranks routes by: what the trader is left with after the route's network
 * fee, where the fee can be put in the bought token's terms. Selling into XRD the fee comes off the
 * XRD received; selling XRD it is valued at the quote's own rate; otherwise only the amount counts.
 */
export function netOfGas(q: Quote, xrd: string): Decimal {
  const out = new Decimal(q.buyAmount), gas = new Decimal(q.networkFeeXrd || 0);
  if (q.buy === xrd) return out.minus(gas);
  if (q.sell === xrd && new Decimal(q.sellAmount).gt(0)) return out.minus(gas.mul(out).div(q.sellAmount));
  return out;
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
  private readonly ownerPools = new Map<string, { at: number; state: Promise<OwnerPoolState> }>();
  /** How long a read OwnerPool state is reused. Short: quotes from it go straight into fills. */
  ownerPoolTtlMs = 2_000;
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

  /**
   * An OwnerPool's state from the ledger, reused for `ownerPoolTtlMs`. Only components of an
   * allow-listed package (`OWNER_POOL_PACKAGES` for the Gateway's network) are read.
   */
  ownerPoolState(address: string): Promise<OwnerPoolState> {
    const hit = this.ownerPools.get(address);
    if (hit && Date.now() - hit.at < this.ownerPoolTtlMs) return hit.state;
    const state = readOwnerPools(this.gateway, [address], OWNER_POOL_PACKAGES[this.gateway.network.name] ?? []).then((s) => s[0]!);
    state.catch(() => this.ownerPools.delete(address));
    this.ownerPools.set(address, { at: Date.now(), state });
    return state;
  }

  /** Forget cached OwnerPool states (after a trade through one, its reserves have changed). */
  forgetOwnerPools(): void {
    this.ownerPools.clear();
  }

  /**
   * Quote a one-pool OwnerPool route from its ledger state, with the blueprint's own arithmetic:
   * exactly what its `quote` returns. Undefined where the ledger's quote would fail (paused, too
   * small, ...). The network fee is the measured `OWNER_POOL_SWAP_FEE_XRD`.
   */
  private async ownerPoolQuote(pool: Pool, sell: string, amount: Decimal): Promise<Quote | undefined> {
    const state = await this.ownerPoolState(pool.address);
    let out: string;
    try {
      out = ownerPoolQuote(state, sell, amount.toFixed());
    } catch (e) {
      if (e instanceof OwnerPoolQuoteError) { this.lastFailure = `${pool.address}: ${e.message}`; return undefined; }
      throw e;
    }
    const buy = state.resourceA === sell ? state.resourceB : state.resourceA;
    const received = new Decimal(out);
    return {
      sell, buy, sellAmount: amount.toFixed(), buyAmount: received.toFixed(), price: received.div(amount).toSignificantDigits(12).toFixed(),
      route: [pool], networkFeeXrd: OWNER_POOL_SWAP_FEE_XRD, stateVersion: state.stateVersion,
    };
  }

  /** Simulate selling `sellAmount` of `sell` along `route`. Returns undefined if no funder can cover it or the swap fails. */
  async simulate(route: Pool[], sell: string, sellAmount: string | Decimal): Promise<Quote | undefined> {
    const amount = new Decimal(sellAmount).toDecimalPlaces(await this.divisibility(sell), Decimal.ROUND_DOWN);
    if (!amount.gt(0)) return undefined;
    const path = routePath(route, sell);
    const buy = path[path.length - 1]!;
    // A lone OwnerPool is quoted from its state, no preview needed. Longer routes through one are previewed like any other.
    if (route.length === 1 && route[0]!.venue === 'ownerpool') return this.ownerPoolQuote(route[0]!, sell, amount);
    const epoch = await this.currentEpoch();
    const funders = (await this.fundersFor(sell)).filter((f) => f.amount.gte(amount)).slice(0, 3);
    for (const funder of funders) {
      const manifest = [
        `CALL_METHOD ${addr(funder.address)} "withdraw" ${addr(sell)} ${dec(amount)};`,
        `TAKE_ALL_FROM_WORKTOP ${addr(sell)} ${bucket('in0')};`,
        ...routeInstructions(route, sell, 'in', undefined, { previewOnly: true }),
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
    const pairPools = pools.filter((p) => other(p, sell) === buy);
    // Listed OwnerPools are always tried: they are quoted from their state without a preview, and
    // their display TVL (often zero) says nothing about the price they give.
    const deepest = pairPools.filter((p) => p.venue !== 'ownerpool').sort(byDepth).slice(0, maxDirect);
    const direct = [...deepest, ...pairPools.filter((p) => p.venue === 'ownerpool')].map((p) => [p]);
    const routes = [...direct];
    if (sell !== hub && buy !== hub) {
      const leg1 = pools.filter((p) => other(p, sell) === hub).sort(byDepth)[0];
      const leg2 = pools.filter((p) => other(p, hub) === buy).sort(byDepth)[0];
      if (leg1 && leg2) routes.push([leg1, leg2]);
    }
    return routes;
  }

  /**
   * Best single route: most received after the route's own network fee where that can be valued
   * (`netOfGas`; `hub` is XRD), so a cheaper venue wins a near tie. Routes' fees differ: on Stokenet an
   * OwnerPool swap previews at 0.46 XRD, the radixdex Pool at 0.53; on mainnet Ociswap basic ~0.5, precision ~0.9.
   */
  async best(pools: Pool[], sell: string, buy: string, sellAmount: string | Decimal, hub: string): Promise<Quote | undefined> {
    const routes = this.candidateRoutes(pools, sell, buy, hub);
    const quotes = await Promise.all(routes.map((r) => this.simulate(r, sell, sellAmount).catch((e) => { this.errors++; this.lastFailure = String((e as Error)?.message ?? e).slice(0, 200); return undefined; })));
    let best: Quote | undefined;
    for (const q of quotes) if (q && (!best || netOfGas(q, hub).gt(netOfGas(best, hub)))) best = q;
    return best;
  }

  /**
   * Order-book style depth for one pool, from previews at a ladder of sizes.
   * `fractions` are cumulative shares of the pool's reserve of the token being sold.
   */
  async poolDepth(market: Market, pool: Pool, fractions = [0.002, 0.01, 0.025, 0.05, 0.1, 0.2]): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }> {
    const base = market.base.address, quote = market.quote.address;
    // An OwnerPool's reserves move with every trade and every owner deposit: size the ladder from its live state.
    const live = pool.venue === 'ownerpool' ? await this.ownerPoolState(pool.address) : undefined;
    const reserve = (token: string) => live
      ? Number(live.resourceA === token ? live.reserveA : live.reserveB)
      : pool.reserves[pool.tokens[0] === token ? 0 : 1];
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
