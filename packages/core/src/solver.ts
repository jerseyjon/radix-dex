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

/**
 * Decide the solver's cut of a pool fill. `quotedOut` is what the route is expected to produce,
 * `gasInBuyToken` the network fee expressed in the bought token.
 * The fill only goes ahead if the user would still clear their minimum by `bufferBps`,
 * so that small price moves between quote and commit do not waste a failed transaction.
 */
export function planPoolFill(o: { quotedOut: string; minBuyAmount: string; feeBps: number; gasInBuyToken: string; divisibility: number; bufferBps?: number }): { solverTake: string; userReceives: string } | undefined {
  const out = new Decimal(o.quotedOut);
  const take = floorTo(out.mul(o.feeBps).div(10_000).plus(o.gasInBuyToken), o.divisibility);
  const user = out.minus(take);
  const needed = new Decimal(o.minBuyAmount).mul(10_000 + (o.bufferBps ?? 20)).div(10_000);
  if (user.lt(needed)) return undefined;
  return { solverTake: take.toFixed(), userReceives: user.toFixed() };
}
