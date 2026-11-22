import type { Gateway } from './gateway.ts';
import { Decimal, addr, bucket, dec } from './manifest.ts';
import {
  OWNER_POOL_PACKAGES, OWNER_POOL_SWAP_FEE_XRD, OwnerPoolQuoteError, ownerPoolQuote, ownerPoolSwapInstruction, readOwnerPools, type OwnerPoolState,
} from './ownerpool.ts';
import type { Depth, DepthLevel, Market, Pool, Quote } from './types.ts';
import { isBestEffort, poolsToProbe, swapInstruction } from './venues.ts';

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
 * The score `Quoter.best` ranks routes by, for every venue alike: what the trader is left with after
 * the route's own network fee, in the bought token. The fee is the MEASURED one (`networkFeeXrd`, no
 * venue margin: see `chargedSwapFeeXrd`), valued in the bought token at `buyPerXrd` when given (best
 * passes one rate for all of a quote's routes). Without it: buying XRD the fee comes straight off;
 * selling XRD it is valued at the quote's own rate; otherwise the fee cannot be valued and only the
 * amount counts.
 */
export function netOfGas(q: Quote, xrd: string, buyPerXrd?: Decimal): Decimal {
  const out = new Decimal(q.buyAmount);
  const n = Number(q.networkFeeXrd);
  const gas = new Decimal(Number.isFinite(n) && n > 0 ? q.networkFeeXrd : 0);
  if (q.buy === xrd) return out.minus(gas);
  if (buyPerXrd) return out.minus(gas.mul(buyPerXrd));
  if (q.sell === xrd && new Decimal(q.sellAmount).gt(0)) return out.minus(gas.mul(out).div(q.sellAmount));
  return out;
}

/** XRD sold to value a network fee in a token neither side of which is XRD (see `Quoter.xrdRate`). */
const RATE_PROBE_XRD = '100';

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
    // A paused OwnerPool (the owner's pause, the operator's, or a revoked operator) is not a route at all:
    // no preview of a route through it, so it is never offered and never ranked.
    for (const p of route) {
      if (p.venue !== 'ownerpool') continue;
      const st = await this.ownerPoolState(p.address);
      if (st.paused) { this.lastFailure = `${p.address}: Swaps are paused`; return undefined; }
    }
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
      // The fee as measured. A venue's safety margin (VENUE_GAS_MARGIN_XRD) is added only to what a fill
      // is charged (chargedSwapFeeXrd), never here, so that it does not count against the venue in ranking.
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

  /**
   * Candidate routes: the deepest direct pools, plus a two-hop route through `hub` (normally XRD)
   * over the deepest pool on each side. Best-effort pools and OwnerPools (see `poolsToProbe`) are added to these
   * rather than ranked against them: each direct one as a route of its own, and each as an
   * alternative leg of the two-hop route. The first two-hop route is the one over the deepest
   * ordinary pools whenever both legs have one.
   */
  candidateRoutes(pools: Pool[], sell: string, buy: string, hub: string, maxDirect = 3): Pool[][] {
    // Listed OwnerPools are always tried, like best-effort pools: they are quoted from their state
    // without a preview, and their display TVL (often zero) says nothing about the price they give.
    const routes = poolsToProbe(pools.filter((p) => other(p, sell) === buy), maxDirect).map((p) => [p]);
    if (sell !== hub && buy !== hub) {
      const legs1 = poolsToProbe(pools.filter((p) => other(p, sell) === hub), 1);
      const legs2 = poolsToProbe(pools.filter((p) => other(p, hub) === buy), 1);
      // poolsToProbe puts the ordinary pool first, so the first pair is the ordinary route when there is one.
      for (const leg1 of legs1) for (const leg2 of legs2) routes.push([leg1, leg2]);
    }
    return routes;
  }

  /**
   * Best single route. A route that sells the whole amount beats one that hands part of it back (a
   * pool short of liquidity on one side), whatever their fees: received amounts are only comparable
   * for the same amount sold. Among routes alike in that, the most received NET OF THE ROUTE'S OWN
   * NETWORK FEE wins (`netOfGas`; `hub` is XRD), for every venue, so a cheaper route wins a near tie
   * on a small trade and the better price wins on a large one. The fee is the measured one, without
   * any venue's charging margin. Fees differ by venue: on mainnet an Ociswap basic pool swap previews
   * at ~0.5 XRD, a precision pool ~0.9, CaviarNine 0.9 to 1.5; on Stokenet an OwnerPool 0.46 (split package 0.49).
   *
   * All routes' fees are valued in the bought token at one rate: 1 when buying XRD, the best quote's
   * own price when selling XRD, and otherwise `xrdRate` (one cached preview per token, only for pairs
   * without XRD). Any one route failing, by error or by failed preview, only drops that route.
   */
  async best(pools: Pool[], sell: string, buy: string, sellAmount: string | Decimal, hub: string): Promise<Quote | undefined> {
    const routes = this.candidateRoutes(pools, sell, buy, hub);
    const quotes = await Promise.all(routes.map((r) => this.simulate(r, sell, sellAmount).catch((e) => { this.errors++; this.lastFailure = String((e as Error)?.message ?? e).slice(0, 200); return undefined; })));
    const whole = await this.divisibility(sell).then((d) => new Decimal(sellAmount).toDecimalPlaces(d, Decimal.ROUND_DOWN), () => new Decimal(sellAmount));
    const full = (q: Quote) => new Decimal(q.sellAmount).gte(whole);
    const found = quotes.filter((q): q is Quote => !!q);
    if (found.length < 2) return found[0];
    const fullOnes = found.filter(full);
    const rate = await this.feeRate(pools, fullOnes.length ? fullOnes : found, sell, buy, hub);
    const score = (q: Quote) => netOfGas(q, hub, rate);
    let best: Quote | undefined;
    for (const q of found) {
      if (!best || (full(q) && !full(best)) || (full(q) === full(best) && score(q).gt(score(best)))) best = q;
    }
    return best;
  }

  /**
   * Bought-token units per XRD, to value every candidate route's network fee alike. Buying XRD: 1.
   * Selling XRD: the highest price among the quotes themselves (no extra call). Otherwise `xrdRate`,
   * or undefined if that cannot be had (fees are then left out of the ranking, as before).
   */
  private async feeRate(pools: Pool[], quotes: Quote[], sell: string, buy: string, hub: string): Promise<Decimal | undefined> {
    if (buy === hub) return new Decimal(1);
    if (sell === hub) {
      return quotes.reduce<Decimal | undefined>((m, q) => {
        const p = new Decimal(q.buyAmount).div(q.sellAmount);
        return !m || p.gt(m) ? p : m;
      }, undefined);
    }
    return this.xrdRate(pools, buy, hub).catch(() => undefined);
  }

  private readonly xrdRates = new Map<string, { at: number; rate: Promise<Decimal | undefined> }>();
  /** How long a token's XRD rate for valuing network fees is reused. */
  xrdRateTtlMs = 120_000;

  /**
   * `token` per XRD, from one preview selling `RATE_PROBE_XRD` through the deepest ordinary pool
   * between `hub` (XRD) and `token`, reused for `xrdRateTtlMs`. Only used to value network fees in
   * ranking, where a rough rate is enough. A failure is not remembered.
   */
  xrdRate(pools: Pool[], token: string, hub: string): Promise<Decimal | undefined> {
    const hit = this.xrdRates.get(token);
    if (hit && Date.now() - hit.at < this.xrdRateTtlMs) return hit.rate;
    const pool = poolsToProbe(pools.filter((p) => other(p, hub) === token && p.venue !== 'ownerpool' && !isBestEffort(p)), 1)[0];
    if (!pool) return Promise.resolve(undefined);
    const rate = this.simulate([pool], hub, RATE_PROBE_XRD).then((q) => (q ? new Decimal(q.buyAmount).div(q.sellAmount) : undefined));
    const entry = { at: Date.now(), rate };
    this.xrdRates.set(token, entry);
    const forget = () => { if (this.xrdRates.get(token) === entry) this.xrdRates.delete(token); };
    rate.then((r) => { if (!r) forget(); }, forget);
    return rate;
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
