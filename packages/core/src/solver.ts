import { Decimal } from './manifest.ts';

/** The fields of an open order the matching logic needs. */
export interface OpenOrder {
  id: string;
  sell: string;
  sellAmount: string;
  buy: string;
  minBuyAmount: string;
}

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
 * Decide the solver's cut of a pool fill. `quotedOut` is what the route is expected to produce,
 * `gasInBuyToken` the network fee expressed in the bought token.
 * The network fee always comes out of the proceeds. The service fee is taken only from what is
 * left above the user's minimum (plus `bufferBps`), so it never stops an order filling and
 * never takes the user below their limit.
 */
export function planPoolFill(o: { quotedOut: string; minBuyAmount: string; feeBps: number; gasInBuyToken: string; divisibility: number; bufferBps?: number }): { solverTake: string; userReceives: string } | undefined {
  const out = new Decimal(o.quotedOut);
  const needed = new Decimal(o.minBuyAmount).mul(10_000 + (o.bufferBps ?? POOL_FILL_BUFFER_BPS)).div(10_000);
  const surplus = out.minus(o.gasInBuyToken).minus(needed);
  if (surplus.isNegative()) return undefined;
  const fee = Decimal.min(out.mul(o.feeBps).div(10_000), surplus);
  const take = floorTo(fee.plus(o.gasInBuyToken), o.divisibility);
  return { solverTake: take.toFixed(), userReceives: out.minus(take).toFixed() };
}
