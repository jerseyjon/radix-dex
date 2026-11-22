import { Decimal } from './manifest.ts';

/** The fields of an open order the matching logic needs. */
export interface OpenOrder {
  id: string;
  sell: string;
  sellAmount: string;
  buy: string;
  minBuyAmount: string;
  /**
   * What the order must be worth, before fees, for it to fill: its price times its size.
   * The signed minimum sits below this by the fee allowance. Absent on older orders, where the
   * minimum is also the trigger.
   */
  limitBuyAmount?: string;
}

/** The gross amount at which an order triggers. */
export const limitOf = (o: OpenOrder): Decimal => Decimal.max(o.limitBuyAmount ?? o.minBuyAmount, o.minBuyAmount);

const floorTo = (d: Decimal, divisibility: number) => d.toDecimalPlaces(divisibility, Decimal.ROUND_DOWN);
const ceilTo = (d: Decimal, divisibility: number) => d.toDecimalPlaces(divisibility, Decimal.ROUND_UP);

/**
 * How much of `gross` to hand a user who must receive at least `min`: the gross less the fee,
 * never below their minimum, expressed in amounts the token's divisibility can represent.
 * Returns undefined if `gross` cannot cover the minimum.
 */
export function payout(gross: Decimal, min: Decimal, feeBps: number, divisibility: number): Decimal | undefined {
  const floor = ceilTo(min, divisibility);
  if (gross.lt(floor)) return undefined;
  const afterFee = floorTo(gross.mul(10_000 - feeBps).div(10_000), divisibility);
  return Decimal.max(floor, afterFee);
}

export interface CrossPlan {
  a: OpenOrder;
  b: OpenOrder;
  /** Amount of a.buy paid to A (taken from what B sells). */
  payA: string;
  /** Amount of b.buy paid to B (taken from what A sells). */
  payB: string;
}

/**
 * Two orders cross when each sells what the other buys and each one's whole sale covers the
 * other's minimum. Both fill completely; any surplus beyond fee stays with the users.
 */
export function planCross(a: OpenOrder, b: OpenOrder, feeBps: number, divisibility: (resource: string) => number): CrossPlan | undefined {
  if (a.id === b.id || a.sell !== b.buy || a.buy !== b.sell) return undefined;
  const payA = payout(new Decimal(b.sellAmount), new Decimal(a.minBuyAmount), feeBps, divisibility(a.buy));
  const payB = payout(new Decimal(a.sellAmount), new Decimal(b.minBuyAmount), feeBps, divisibility(b.buy));
  if (!payA || !payB) return undefined;
  return { a, b, payA: payA.toFixed(), payB: payB.toFixed() };
}

/** First crossing pair among open orders, oldest first. Each order appears in at most one plan. */
export function findCrosses(orders: OpenOrder[], feeBps: number, divisibility: (resource: string) => number): CrossPlan[] {
  const used = new Set<string>();
  const plans: CrossPlan[] = [];
  for (const a of orders) {
    if (used.has(a.id)) continue;
    for (const b of orders) {
      if (used.has(b.id) || used.has(a.id)) continue;
      const plan = planCross(a, b, feeBps, divisibility);
      if (plan) { used.add(a.id); used.add(b.id); plans.push(plan); }
    }
  }
  return plans;
}

/** Margin by which a pool fill must clear the user's minimum, so a small price move between quote and commit does not waste a failed transaction. */
export const POOL_FILL_BUFFER_BPS = 5;

/**
 * Share of the network fee the solver will absorb on an order whose trigger is reached but whose
 * signed allowance (trigger less minimum) falls a little short of the solver's current estimate.
 * The trigger is the price the user was shown and promised; estimates move between signing and
 * filling (a pool's swap cost changes with its state), so a small shortfall is the solver's to bear.
 */
export const GAS_SHORTFALL_TOLERANCE = 0.25;

/**
 * Decide the solver's cut of a fill. `quotedOut` is everything the fill is expected to produce
 * for the order, `gasInBuyToken` the network fee expressed in the bought token.
 * The order fills only when the proceeds reach its trigger (`limitBuyAmount`, default the minimum).
 * The network fee comes out of the proceeds, never taking the user below their signed minimum
 * (plus `bufferBps`). When that leaves less than the whole fee, the order still fills if the
 * shortfall is within `gasShortfall` (a share of the fee) and the solver takes what there is.
 * The service fee comes out of whatever is left after the network fee.
 */
export function planPoolFill(o: { quotedOut: string; minBuyAmount: string; limitBuyAmount?: string; feeBps: number; gasInBuyToken: string; divisibility: number; bufferBps?: number; gasShortfall?: number }): { solverTake: string; userReceives: string } | undefined {
  const out = new Decimal(o.quotedOut);
  if (o.limitBuyAmount !== undefined && out.lt(o.limitBuyAmount)) return undefined;
  const needed = new Decimal(o.minBuyAmount).mul(10_000 + (o.bufferBps ?? POOL_FILL_BUFFER_BPS)).div(10_000);
  const room = out.minus(needed);
  const gas = new Decimal(o.gasInBuyToken);
  const tolerance = Math.min(Math.max(o.gasShortfall ?? 0, 0), 1);
  if (room.lt(gas.mul(1 - tolerance))) return undefined;
  const gasTake = Decimal.min(gas, room);
  const fee = Decimal.max(0, Decimal.min(out.mul(o.feeBps).div(10_000), room.minus(gasTake)));
  const take = floorTo(fee.plus(gasTake), o.divisibility);
  return { solverTake: take.toFixed(), userReceives: out.minus(take).toFixed() };
}

/** The least a fill must produce, before fees, for `planPoolFill` to accept it. */
export function grossNeeded(o: { minBuyAmount: string; limitBuyAmount?: string; gasInBuyToken: string; bufferBps?: number; gasShortfall?: number }): Decimal {
  const tolerance = Math.min(Math.max(o.gasShortfall ?? 0, 0), 1);
  const floor = new Decimal(o.minBuyAmount).mul(10_000 + (o.bufferBps ?? POOL_FILL_BUFFER_BPS)).div(10_000).plus(new Decimal(o.gasInBuyToken).mul(1 - tolerance));
  return Decimal.max(floor, o.limitBuyAmount ?? 0);
}

// ---------------------------------------------------------------- charges in XRD (since 22 Nov 2026)

/**
 * Where the solver takes its charges (network fee and service fee) on a fill. They are always XRD:
 * - `proceeds`: the order buys XRD; the charges come out of the XRD it receives.
 * - `input`: the order sells XRD; the charges come out of the XRD it sells, before the rest is swapped.
 * - `hop`: neither token is XRD; the route goes through XRD and the charges are taken between the two swaps.
 */
export type ChargeAt = 'proceeds' | 'input' | 'hop';

export function chargeAt(sell: string, buy: string, xrd: string): ChargeAt {
  return buy === xrd ? 'proceeds' : sell === xrd ? 'input' : 'hop';
}

/**
 * The solver's full charges in XRD: the network fee estimate plus the service fee on `xrdBase` (the
 * XRD the trade moves: what it sells, receives, or passes through), rounded down to XRD's 18 places
 * so the solver never takes more than it states.
 */
export function xrdCharges(xrdBase: string | Decimal, gasXrd: string | Decimal, feeBps: number): Decimal {
  return floorTo(new Decimal(gasXrd).plus(new Decimal(xrdBase).mul(feeBps).div(10_000)), 18);
}

/** The least the solver takes when the signed allowance falls short of its estimate: the network fee less the tolerated shortfall, no service fee. */
export function reducedXrdCharges(gasXrd: string | Decimal, gasShortfall = GAS_SHORTFALL_TOLERANCE): Decimal {
  const tolerance = Math.min(Math.max(gasShortfall, 0), 1);
  return floorTo(new Decimal(gasXrd).mul(1 - tolerance), 18);
}

/**
 * What a fill that takes `take` XRD before the last swap must deliver: the signed minimum (plus the
 * buffer when a pool is involved), and the order's trigger scaled to the XRD actually swapped, so
 * the order's own price is met on what is traded for it. `xrdBase` is the XRD available at the point
 * of the take (the amount sold for `input`, the first swap's output for `hop`). The scaled trigger is
 * rounded down to the bought token's places (`buyDivisibility`, default 18), as a pool's output is.
 */
export function xrdLegNeeded(o: { xrdBase: string; take: string; minBuyAmount: string; limitBuyAmount?: string; bufferBps?: number; buyDivisibility?: number }): Decimal | undefined {
  const base = new Decimal(o.xrdBase), take = new Decimal(o.take);
  if (!base.gt(0) || take.lt(0) || !take.lt(base)) return undefined;
  const floor = new Decimal(o.minBuyAmount).mul(10_000 + (o.bufferBps ?? POOL_FILL_BUFFER_BPS)).div(10_000);
  const trigger = floorTo(new Decimal(o.limitBuyAmount ?? o.minBuyAmount).mul(base.minus(take)).div(base), o.buyDivisibility ?? 18);
  return Decimal.max(floor, trigger);
}

/**
 * Check a fill whose charges are taken in XRD before the last swap (`input` and `hop`): the user
 * receives everything the swap (and any resting orders) produce, `out`. Undefined if that is short
 * of what `xrdLegNeeded` asks.
 */
export function planXrdLegFill(o: { xrdBase: string; take: string; out: string; minBuyAmount: string; limitBuyAmount?: string; bufferBps?: number; buyDivisibility?: number }): { solverTake: string; userReceives: string } | undefined {
  const need = xrdLegNeeded(o);
  if (!need || new Decimal(o.out).lt(need)) return undefined;
  return { solverTake: new Decimal(o.take).toFixed(), userReceives: new Decimal(o.out).toFixed() };
}

/**
 * A smaller take to try when the full charges leave the order short: estimated from one quote
 * (`out` for `xrdBase − takeFull`) at its average rate, with 10% to spare, and never below `takeMin`.
 * The result is only a candidate: the caller must quote it and check it with `planXrdLegFill`.
 */
export function retryXrdTake(o: { xrdBase: string; takeFull: string; takeMin: string; out: string; need: string }): Decimal | undefined {
  const full = new Decimal(o.takeFull), min = new Decimal(o.takeMin), out = new Decimal(o.out);
  const swapped = new Decimal(o.xrdBase).minus(full);
  if (!swapped.gt(0) || !out.gt(0) || min.gte(full)) return undefined;
  const short = new Decimal(o.need).minus(out);
  if (!short.gt(0)) return full;
  const rate = out.div(swapped);
  const take = floorTo(full.minus(short.div(rate).mul('1.1')), 18);
  return take.lt(min) ? min : take;
}

export interface MakerFill {
  order: OpenOrder;
  /** What the maker is owed before fees, in the token the taker sells. */
  cost: string;
  /** What the maker is paid: its limit less the fee, never below its signed minimum. */
  pay: string;
}

/**
 * Resting orders a taker can absorb, best price for the taker first. Orders fill whole or not at
 * all, so a maker qualifies only while the makers chosen so far, at their own prices, fit inside
 * what the taker sells. The caller decides how many of them to use.
 */
export function pickMakers(taker: OpenOrder, resting: OpenOrder[], feeBps: number, divisibility: (resource: string) => number, max = 3): MakerFill[] {
  const div = divisibility(taker.sell);
  const candidates = resting
    .filter((m) => m.id !== taker.id && m.sell === taker.buy && m.buy === taker.sell)
    .map((m) => ({ m, limit: limitOf(m) }))
    .sort((x, y) => x.limit.div(x.m.sellAmount).cmp(y.limit.div(y.m.sellAmount)));
  const out: MakerFill[] = [];
  let left = new Decimal(taker.sellAmount);
  for (const { m, limit } of candidates) {
    if (out.length >= max) break;
    const cost = ceilTo(limit, div);
    const pay = payout(cost, new Decimal(m.minBuyAmount), feeBps, div);
    if (!pay || cost.gt(left)) continue;
    left = left.minus(cost);
    out.push({ order: m, cost: cost.toFixed(), pay: pay.toFixed() });
  }
  return out;
}
