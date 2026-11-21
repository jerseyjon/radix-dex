import { Decimal, addr, bucket, dec } from './manifest.ts';
import type { Pool } from './types.ts';
import { routeInstructions, routePath } from './quote.ts';

/** Access rule "holds at least one of this fungible badge", as RTM. */
export function requireResourceRule(resource: string): string {
  return `Enum<AccessRule::Protected>(Enum<CompositeRequirement::BasicRequirement>(Enum<BasicRequirement::Require>(Enum<ResourceOrNonFungible::Resource>(${addr(resource)}))))`;
}

export interface LimitOrderParams {
  account: string;
  sell: string;
  sellAmount: string;
  buy: string;
  /** The least the user will accept. Enforced by the engine. */
  minBuyAmount: string;
  /** Fungible badge the wrapping transaction must present; pins the order to our solver. */
  solverBadge: string;
  /** Optional hard-cancel registry: component address and the 32-byte order key (hex). */
  registry?: { component: string; orderKeyHex: string };
}

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * The subintent manifest a user signs for a limit order. This exact text is also the template the
 * server checks submitted orders against, so any change here changes what the server accepts.
 */
export function limitOrderManifest(p: LimitOrderParams): string {
  if (p.sell === p.buy) throw new Error('sell and buy must differ');
  if (!new Decimal(p.sellAmount).isPositive() || !new Decimal(p.minBuyAmount).isPositive()) throw new Error('amounts must be positive');
  const lines = [
    `VERIFY_PARENT ${requireResourceRule(p.solverBadge)};`,
    `ASSERT_WORKTOP_IS_EMPTY;`,
  ];
  if (p.registry) {
    if (!HEX32.test(p.registry.orderKeyHex)) throw new Error('order key must be 32 bytes of lowercase hex');
    lines.push(`CALL_METHOD ${addr(p.registry.component)} "assert_live" Bytes("${p.registry.orderKeyHex}");`);
  }
  lines.push(
    `CALL_METHOD ${addr(p.account)} "withdraw" ${addr(p.sell)} ${dec(p.sellAmount)};`,
    `TAKE_ALL_FROM_WORKTOP ${addr(p.sell)} ${bucket('sell')};`,
    `ASSERT_NEXT_CALL_RETURNS_ONLY Map<Address, Enum>(${addr(p.buy)} => Enum<2u8>(${dec(p.minBuyAmount)}));`,
    `YIELD_TO_PARENT ${bucket('sell')};`,
    `CALL_METHOD ${addr(p.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    `YIELD_TO_PARENT;`,
  );
  return lines.join('\n');
}

export interface MarketOrderParams {
  account: string;
  sell: string;
  sellAmount: string;
  minBuyAmount: string;
  route: Pool[];
}

/** Ordinary transaction manifest for a market order: the wallet adds the fee lock. */
export function marketOrderManifest(p: MarketOrderParams): string {
  const path = routePath(p.route, p.sell);
  const buy = path[path.length - 1]!;
  return [
    `CALL_METHOD ${addr(p.account)} "withdraw" ${addr(p.sell)} ${dec(p.sellAmount)};`,
    `TAKE_ALL_FROM_WORKTOP ${addr(p.sell)} ${bucket('in0')};`,
    ...routeInstructions(p.route, p.sell),
    `ASSERT_WORKTOP_CONTAINS ${addr(buy)} ${dec(p.minBuyAmount)};`,
    `CALL_METHOD ${addr(p.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
}

export interface SolverIdentity {
  account: string;
  badge: string;
}

const head = (s: SolverIdentity, feeLockXrd: string) => [
  `CALL_METHOD ${addr(s.account)} "lock_fee" ${dec(feeLockXrd)};`,
  `CALL_METHOD ${addr(s.account)} "create_proof_of_amount" ${addr(s.badge)} Decimal("1");`,
];

/**
 * Root manifest that fills one order through pools.
 * The solver keeps exactly `solverTake` of the bought token; everything else the route produced goes to the user.
 */
export function poolFillManifest(o: { solver: SolverIdentity; feeLockXrd: string; sell: string; route: Pool[]; solverTake: string }): string {
  const path = routePath(o.route, o.sell);
  const buy = path[path.length - 1]!;
  const lines = [
    ...head(o.solver, o.feeLockXrd),
    `YIELD_TO_CHILD NamedIntent("order");`,
    `TAKE_ALL_FROM_WORKTOP ${addr(o.sell)} ${bucket('in0')};`,
    ...routeInstructions(o.route, o.sell),
  ];
  if (new Decimal(o.solverTake).isPositive()) {
    lines.push(
      `TAKE_FROM_WORKTOP ${addr(buy)} ${dec(o.solverTake)} ${bucket('fee')};`,
      `CALL_METHOD ${addr(o.solver.account)} "deposit" ${bucket('fee')};`,
    );
  }
  lines.push(
    `TAKE_ALL_FROM_WORKTOP ${addr(buy)} ${bucket('out')};`,
    `YIELD_TO_CHILD NamedIntent("order") ${bucket('out')};`,
    // Normally empty. Catches any part of the input a pool handed back unswapped, which would otherwise fail the transaction.
    `CALL_METHOD ${addr(o.solver.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  );
  return lines.join('\n');
}

/** Root manifest that fills one order from the solver's own inventory. */
export function inventoryFillManifest(o: { solver: SolverIdentity; feeLockXrd: string; sell: string; buy: string; payAmount: string }): string {
  return [
    ...head(o.solver, o.feeLockXrd),
    `YIELD_TO_CHILD NamedIntent("order");`,
    `CALL_METHOD ${addr(o.solver.account)} "withdraw" ${addr(o.buy)} ${dec(o.payAmount)};`,
    `TAKE_ALL_FROM_WORKTOP ${addr(o.buy)} ${bucket('out')};`,
    `YIELD_TO_CHILD NamedIntent("order") ${bucket('out')};`,
    `CALL_METHOD ${addr(o.solver.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
}

/**
 * Root manifest that settles two crossing orders against each other.
 * Order A sells X for Y; order B sells Y for X. A receives `payA` of Y, B receives `payB` of X;
 * whatever is left over (the spread) goes to the solver.
 */
export function crossFillManifest(o: { solver: SolverIdentity; feeLockXrd: string; x: string; y: string; payA: string; payB: string }): string {
  return [
    ...head(o.solver, o.feeLockXrd),
    `YIELD_TO_CHILD NamedIntent("order_a");`,
    `YIELD_TO_CHILD NamedIntent("order_b");`,
    `TAKE_FROM_WORKTOP ${addr(o.y)} ${dec(o.payA)} ${bucket('to_a')};`,
    `YIELD_TO_CHILD NamedIntent("order_a") ${bucket('to_a')};`,
    `TAKE_FROM_WORKTOP ${addr(o.x)} ${dec(o.payB)} ${bucket('to_b')};`,
    `YIELD_TO_CHILD NamedIntent("order_b") ${bucket('to_b')};`,
    `CALL_METHOD ${addr(o.solver.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
}

/**
 * Root manifest that fills a taker order against resting orders and, for what is left, pools.
 * Each maker is paid `pay` of the token the taker sells. `poolIn` of that token goes through
 * `route`. The taker gets everything the makers sold plus what the pools returned, less
 * `solverTake`. Whatever remains (the makers' fees) goes to the solver.
 */
export function takeFillManifest(o: { solver: SolverIdentity; feeLockXrd: string; sell: string; buy: string; makerPays: string[]; poolIn: string; route: Pool[]; solverTake: string }): string {
  const lines = [...head(o.solver, o.feeLockXrd), `YIELD_TO_CHILD NamedIntent("taker");`];
  o.makerPays.forEach((_, i) => lines.push(`YIELD_TO_CHILD NamedIntent("maker_${i}");`));
  o.makerPays.forEach((pay, i) => lines.push(
    `TAKE_FROM_WORKTOP ${addr(o.sell)} ${dec(pay)} ${bucket(`pay_${i}`)};`,
    `YIELD_TO_CHILD NamedIntent("maker_${i}") ${bucket(`pay_${i}`)};`,
  ));
  if (o.route.length && new Decimal(o.poolIn).isPositive()) {
    const path = routePath(o.route, o.sell);
    if (path[path.length - 1] !== o.buy) throw new Error('route does not end in the bought token');
    lines.push(`TAKE_FROM_WORKTOP ${addr(o.sell)} ${dec(o.poolIn)} ${bucket('in0')};`, ...routeInstructions(o.route, o.sell));
  }
  if (new Decimal(o.solverTake).isPositive()) {
    lines.push(
      `TAKE_FROM_WORKTOP ${addr(o.buy)} ${dec(o.solverTake)} ${bucket('fee')};`,
      `CALL_METHOD ${addr(o.solver.account)} "deposit" ${bucket('fee')};`,
    );
  }
  lines.push(
    `TAKE_ALL_FROM_WORKTOP ${addr(o.buy)} ${bucket('out')};`,
    `YIELD_TO_CHILD NamedIntent("taker") ${bucket('out')};`,
    `CALL_METHOD ${addr(o.solver.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  );
  return lines.join('\n');
}
