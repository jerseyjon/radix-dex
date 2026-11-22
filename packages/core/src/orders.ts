import type { Gateway } from './gateway.ts';
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
  if (!new Decimal(p.sellAmount).gt(0) || !new Decimal(p.minBuyAmount).gt(0)) throw new Error('amounts must be positive');
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

/**
 * Has this order key been cancelled in the on-ledger registry? Asks the ledger by previewing the
 * very call every order makes (`assert_live`), so nothing is assumed about the registry's storage.
 * Undefined when the answer could not be had (Gateway error, or the preview failed for another reason).
 */
export async function orderKeyCancelled(gateway: Gateway, registry: string, orderKeyHex: string, epoch?: number): Promise<boolean | undefined> {
  if (!HEX32.test(orderKeyHex)) throw new Error('order key must be 32 bytes of lowercase hex');
  try {
    const res = await gateway.preview(`CALL_METHOD ${addr(registry)} "assert_live" Bytes("${orderKeyHex}");`, epoch ?? (await gateway.status()).epoch);
    if (res.ok) return false;
    return /cancelled/i.test(res.error ?? '') ? true : undefined;
  } catch {
    return undefined;
  }
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

/**
 * The last line before the solver sweeps the worktop into its account: the transaction fails unless
 * nothing but XRD is left there. The solver earns and holds XRD only, so any other token left over
 * (a pool handing back input, rounding change from the order book) stops the fill, in preview, for free.
 */
export const onlyXrdLeft = (xrd: string): string =>
  `ASSERT_WORKTOP_RESOURCES_ONLY Map<Address, Enum>(${addr(xrd)} => Enum<2u8>(Decimal("0")));`;

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
  if (new Decimal(o.solverTake).gt(0)) {
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
 * Each maker is paid `pay` of the token the taker sells; book orders are paid `pay` the same way.
 * Everything of the sold token left after that goes through `route` (`poolIn` is what the plan
 * expects to be there). The taker gets everything the makers sold plus what the pools returned.
 *
 * The solver's charges, `solverTake`, are XRD, taken where `chargeAt` says (see `ChargeAt`):
 * out of the XRD the taker sells before anything else (`input`), out of the XRD it buys at the end
 * (`proceeds`), or between the two swaps of a route through XRD (`hop`, pools only). Whatever is left
 * at the end goes to the solver, and must be XRD alone or the transaction fails.
 */
export function takeFillManifest(o: {
  solver: SolverIdentity; feeLockXrd: string; sell: string; buy: string; makerPays: string[]; poolIn: string; route: Pool[]; solverTake: string;
  /** XRD's address on this network: the only token the solver may be left holding. */
  xrd: string;
  /** Where the charges are taken. Default `proceeds`, which needs the taker to buy XRD. */
  chargeAt?: 'proceeds' | 'input' | 'hop';
  /** Purchases from the on-ledger order book, paid in the token the taker sells. */
  bookFills?: { book: string; id: number; pay: string }[];
  /** What the makers and the book must have delivered between them before the pool leg, or the transaction fails. */
  assertBought?: string;
}): string {
  const at = o.chargeAt ?? 'proceeds';
  const take = new Decimal(o.solverTake);
  if (at === 'proceeds' && o.buy !== o.xrd && take.gt(0)) throw new Error('charges from the proceeds need the taker to buy XRD');
  if (at === 'input' && o.sell !== o.xrd) throw new Error('charges from the input need the taker to sell XRD');
  const keep = (name: string) => [
    `TAKE_FROM_WORKTOP ${addr(o.xrd)} ${dec(o.solverTake)} ${bucket(name)};`,
    `CALL_METHOD ${addr(o.solver.account)} "deposit" ${bucket(name)};`,
  ];
  const lines = [...head(o.solver, o.feeLockXrd), `YIELD_TO_CHILD NamedIntent("taker");`];
  o.makerPays.forEach((_, i) => lines.push(`YIELD_TO_CHILD NamedIntent("maker_${i}");`));
  if (at === 'input' && take.gt(0)) lines.push(...keep('fee'));
  o.makerPays.forEach((pay, i) => lines.push(
    `TAKE_FROM_WORKTOP ${addr(o.sell)} ${dec(pay)} ${bucket(`pay_${i}`)};`,
    `YIELD_TO_CHILD NamedIntent("maker_${i}") ${bucket(`pay_${i}`)};`,
  ));
  (o.bookFills ?? []).forEach((f, i) => {
    if (!Number.isSafeInteger(f.id) || f.id < 0) throw new Error('bad order id');
    lines.push(
      `TAKE_FROM_WORKTOP ${addr(o.sell)} ${dec(f.pay)} ${bucket(`book_${i}`)};`,
      `CALL_METHOD ${addr(f.book)} "fill" ${f.id}u64 ${bucket(`book_${i}`)};`,
    );
  });
  // If a book order was bought by someone else first, stop here rather than short-change the taker.
  if (o.assertBought && new Decimal(o.assertBought).gt(0)) lines.push(`ASSERT_WORKTOP_CONTAINS ${addr(o.buy)} ${dec(o.assertBought)};`);
  if (at === 'hop') {
    // Pools only: sell → XRD, keep the charges, XRD → buy.
    const path = routePath(o.route, o.sell);
    if (o.route.length !== 2 || path[1] !== o.xrd || path[2] !== o.buy || o.makerPays.length || o.bookFills?.length) throw new Error('a hop fill needs a two-pool route through XRD and nothing else');
    lines.push(`TAKE_ALL_FROM_WORKTOP ${addr(o.sell)} ${bucket('in0')};`, ...routeInstructions([o.route[0]!], o.sell));
    if (take.gt(0)) lines.push(...keep('fee'));
    lines.push(`TAKE_ALL_FROM_WORKTOP ${addr(o.xrd)} ${bucket('hop0')};`, ...routeInstructions([o.route[1]!], o.xrd, 'hop'));
  } else if (o.route.length && new Decimal(o.poolIn).gt(0)) {
    const path = routePath(o.route, o.sell);
    if (path[path.length - 1] !== o.buy) throw new Error('route does not end in the bought token');
    // All that is left of the sold token, including any change a book order handed back.
    lines.push(`TAKE_ALL_FROM_WORKTOP ${addr(o.sell)} ${bucket('in0')};`, ...routeInstructions(o.route, o.sell));
  }
  if (at === 'proceeds' && take.gt(0)) lines.push(...keep('fee'));
  lines.push(
    `TAKE_ALL_FROM_WORKTOP ${addr(o.buy)} ${bucket('out')};`,
    `YIELD_TO_CHILD NamedIntent("taker") ${bucket('out')};`,
    onlyXrdLeft(o.xrd),
    `CALL_METHOD ${addr(o.solver.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  );
  return lines.join('\n');
}
