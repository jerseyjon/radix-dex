import { Decimal, addr, bucket, dec } from './manifest.ts';
import {
  OWNER_POOL_MAX_FEE_BPS, OwnerPoolQuoteError, fromAttos, toAttos, type OwnerPoolOperatorLimits, type OwnerPoolState,
} from './ownerpool.ts';

/**
 * The split OwnerPool (owner badge = cold, operator badge = hot; docs/review-2026-11-21/owner-pool-split-design.md):
 * the operator's budget arithmetic, reproduced exactly so a bot can tell before it sends whether a
 * `rebalance` fits, and manifest builders for every owner and operator call.
 *
 * Manifests here are built by code and must be PREVIEWED before they are signed and sent; nothing
 * in this module sends anything.
 */

// ------------------------------------------------------------------ operator budget, exactly as lib.rs

const ATTO = 10n ** 18n;

/** max(hi/lo) - 1 in attos, rounded up (lib.rs `ratio_excess_attos`). */
function ratioExcessAttos(x: bigint, y: bigint): bigint {
  const [hi, lo] = x >= y ? [x, y] : [y, x];
  return ((hi - lo) * ATTO + lo - 1n) / lo;
}

/** d(P, P') for reserves (ra, rb) versus (na, nb), on attos, rounded up (lib.rs `price_distance_attos`). */
export function ownerPoolPriceDistanceAttos(ra: bigint, rb: bigint, na: bigint, nb: bigint): bigint {
  return ratioExcessAttos(nb * ra, rb * na);
}

/** max(0, k'/k - 1) / 2, on attos, rounded up (lib.rs `depth_growth_attos`). */
export function ownerPoolDepthGrowthAttos(ra: bigint, rb: bigint, na: bigint, nb: bigint): bigint {
  const k = ra * rb, k2 = na * nb;
  if (k2 <= k) return 0n;
  return ((k2 - k) * ATTO + 2n * k - 1n) / (2n * k);
}

/** One budget, as attos: `move_budget_bps / 10000`. */
const budgetAttos = (l: OwnerPoolOperatorLimits): bigint => BigInt(l.moveBudgetBps) * ATTO / 10_000n;

/**
 * The operator's allowance at `epoch` (lib.rs `allowance_now`): what was left plus
 * budget * elapsed / window (Decimal division, truncated), never above one budget.
 */
export function ownerPoolAllowanceNow(state: OwnerPoolState, epoch: number): string {
  const s = needSplit(state);
  const budget = budgetAttos(s.limits);
  const elapsed = BigInt(Math.max(0, epoch - s.allowanceEpoch));
  if (elapsed >= BigInt(s.limits.windowEpochs)) return fromAttos(budget);
  const accrued = (budget * elapsed) / BigInt(s.limits.windowEpochs);
  const now = toAttos(s.allowance) + accrued;
  return fromAttos(now < budget ? now : budget);
}

export interface OwnerPoolRebalancePlan {
  /** Reserves after the move. */
  reserveA: string;
  reserveB: string;
  /** Budget the move costs ('0' for a free proportional decrease). */
  cost: string;
  /** Allowance available before the move (refill included) and left after it. */
  allowanceBefore: string;
  allowanceAfter: string;
  /** The anchor after the move: the new reserves for a costed move, unchanged for a free one. */
  anchor: [string, string];
}

/**
 * What an operator `rebalance(toReserveA, toReserveB, None)` would do at `epoch`, or an
 * `OwnerPoolQuoteError` with the ledger's own message where it would fail, checked in lib.rs's
 * order (`rebalance` then `move_inventory`). Positive moves inventory to reserves; negative the reverse.
 * Not checked here (the ledger checks them): the caller's badge, and inventory/reserve vault balances
 * beyond what the limits imply (a move larger than the inventory fails in the vault take).
 */
export function ownerPoolPlanRebalance(state: OwnerPoolState, toReserveA: string, toReserveB: string, epoch: number): OwnerPoolRebalancePlan {
  const s = needSplit(state);
  if (s.ownerPaused) throw new OwnerPoolQuoteError('Paused by the owner');
  const da = toAttos(toReserveA), db = toAttos(toReserveB);
  const ra = toAttos(state.reserveA), rb = toAttos(state.reserveB);
  if (!(ra > 0n && rb > 0n)) throw new OwnerPoolQuoteError('Pool is empty');
  const na = ra + da, nb = rb + db;
  if (!(na > 0n && nb > 0n)) throw new OwnerPoolQuoteError('Operator cannot empty a side');
  const raises = da > 0n || db > 0n;
  if (raises && !(na <= toAttos(s.limits.maxReserveA) && nb <= toAttos(s.limits.maxReserveB))) throw new OwnerPoolQuoteError("Above the operator's reserve cap");
  if (da < 0n && na < toAttos(s.limits.minReserveA)) throw new OwnerPoolQuoteError("Below the operator's reserve floor");
  if (db < 0n && nb < toAttos(s.limits.minReserveB)) throw new OwnerPoolQuoteError("Below the operator's reserve floor");
  if (da > 0n && da > toAttos(s.inventoryA)) throw new OwnerPoolQuoteError('Not enough inventory of token A');
  if (db > 0n && db > toAttos(s.inventoryB)) throw new OwnerPoolQuoteError('Not enough inventory of token B');
  const before = ownerPoolAllowanceNow(state, epoch);
  const fromCurrent = ownerPoolPriceDistanceAttos(ra, rb, na, nb);
  if (!raises && fromCurrent === 0n) {
    return { reserveA: fromAttos(na), reserveB: fromAttos(nb), cost: '0', allowanceBefore: before, allowanceAfter: before, anchor: [...s.anchor] };
  }
  const aa = toAttos(s.anchor[0]), ab = toAttos(s.anchor[1]);
  if (!(aa > 0n && ab > 0n)) throw new OwnerPoolQuoteError('No anchor price');
  const fromAnchor = ownerPoolPriceDistanceAttos(aa, ab, na, nb);
  const total = (fromCurrent >= fromAnchor ? fromCurrent : fromAnchor) + ownerPoolDepthGrowthAttos(ra, rb, na, nb);
  const have = toAttos(before);
  if (total > have) throw new OwnerPoolQuoteError('Operator price-move limit');
  return { reserveA: fromAttos(na), reserveB: fromAttos(nb), cost: fromAttos(total), allowanceBefore: before, allowanceAfter: fromAttos(have - total), anchor: [fromAttos(na), fromAttos(nb)] };
}

function needSplit(state: OwnerPoolState) {
  if (!state.split) throw new Error(`${state.address} is not a split OwnerPool (no operator)`);
  return state.split;
}

/**
 * The limits the split design recommends (Q1-Q5): budget 300 bps per 72 epochs, caps = reserves
 * +10%, floors = 50% of the reserves, operator fee range 10-100 bps. Caps round up and floors down
 * to the tokens' places.
 */
export function ownerPoolSuggestedLimits(state: Pick<OwnerPoolState, 'reserveA' | 'reserveB' | 'divisibilityA' | 'divisibilityB'>, o: Partial<OwnerPoolOperatorLimits> = {}): OwnerPoolOperatorLimits {
  const cap = (r: string, div: number) => new Decimal(r).mul(1.1).toDecimalPlaces(div, Decimal.ROUND_UP).toFixed();
  const floor = (r: string, div: number) => new Decimal(r).mul(0.5).toDecimalPlaces(div, Decimal.ROUND_DOWN).toFixed();
  return {
    moveBudgetBps: 300, windowEpochs: 72,
    maxReserveA: cap(state.reserveA, state.divisibilityA), maxReserveB: cap(state.reserveB, state.divisibilityB),
    minReserveA: floor(state.reserveA, state.divisibilityA), minReserveB: floor(state.reserveB, state.divisibilityB),
    minFeeBps: 10, maxFeeBps: 100, ...o,
  };
}

/**
 * How far a stated anchor is from the curve's current price, as d = max(r, 1/r) - 1. Owner tooling
 * warns when this is large; it must NOT compute the anchor from the curve (a swap sets the curve).
 */
export function ownerPoolAnchorDistance(state: Pick<OwnerPoolState, 'reserveA' | 'reserveB'>, anchor: [string, string]): number {
  const p = new Decimal(state.reserveB).div(state.reserveA), a = new Decimal(anchor[1]).div(anchor[0]);
  const r = p.div(a);
  return Decimal.max(r, new Decimal(1).div(r)).minus(1).toNumber();
}

// ------------------------------------------------------------------ manifests

/** An account that holds a badge (a 0-place fungible of supply 1, as the design requires). */
export interface OwnerPoolSigner {
  account: string;
  badge: string;
}

/** A signed decimal argument (rebalance amounts may be negative). */
function sdec(v: string): string {
  const d = new Decimal(v);
  if (!d.isFinite() || d.abs().gt('1e38')) throw new Error(`Not a valid amount: ${v}`);
  if (!d.toDecimalPlaces(18).eq(d)) throw new Error(`More than 18 decimal places: ${v}`);
  return `Decimal("${d.toFixed()}")`;
}

const pair = (p: [string, string]) => `Tuple(${dec(p[0])}, ${dec(p[1])})`;
const optPair = (p?: [string, string] | null) => (p ? `Some(${pair(p)})` : 'None');
const u16 = (n: number, what: string, max = 65_535) => {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${what} out of range: ${n}`);
  return `${n}u16`;
};
const proof = (s: OwnerPoolSigner) => `CALL_METHOD ${addr(s.account)} "create_proof_of_amount" ${addr(s.badge)} Decimal("1");`;
const head = (s: OwnerPoolSigner, feeLockXrd?: string) => [
  ...(feeLockXrd ? [`CALL_METHOD ${addr(s.account)} "lock_fee" ${dec(feeLockXrd)};`] : []),
  proof(s),
];
const call = (pool: string, method: string, ...args: string[]) => `CALL_METHOD ${addr(pool)} "${method}"${args.map((a) => ' ' + a).join('')};`;
const depositAll = (account: string) => `CALL_METHOD ${addr(account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`;
const join = (lines: string[]) => lines.join('\n');

interface Base { pool: string; owner: OwnerPoolSigner; feeLockXrd?: string }

/** Owner: deposit into the RESERVES, guarded by the reserves seen (`expected`). Does not move the anchor. */
export function ownerPoolDepositManifest(o: Base & { resourceA: string; resourceB: string; amountA?: string; amountB?: string; expected?: [string, string] }): string {
  const lines = head(o.owner, o.feeLockXrd);
  const take = (res: string, amount: string | undefined, name: string) => {
    if (!amount || new Decimal(amount).isZero()) return 'None';
    lines.push(`CALL_METHOD ${addr(o.owner.account)} "withdraw" ${addr(res)} ${dec(amount)};`, `TAKE_ALL_FROM_WORKTOP ${addr(res)} ${bucket(name)};`);
    return `Some(${bucket(name)})`;
  };
  const a = take(o.resourceA, o.amountA, 'a'), b = take(o.resourceB, o.amountB, 'b');
  lines.push(call(o.pool, 'deposit', a, b, optPair(o.expected)));
  return join(lines);
}

/** Owner: withdraw from the RESERVES to the owner's account (or `to`). */
export function ownerPoolWithdrawManifest(o: Base & { amountA: string; amountB: string; expected?: [string, string]; to?: string }): string {
  return join([...head(o.owner, o.feeLockXrd), call(o.pool, 'withdraw', dec(o.amountA), dec(o.amountB), optPair(o.expected)), depositAll(o.to ?? o.owner.account)]);
}

/** Owner: deposit into the INVENTORY (not traded; the operator can move it into the reserves within its limits). */
export function ownerPoolDepositInventoryManifest(o: Base & { resourceA: string; resourceB: string; amountA?: string; amountB?: string }): string {
  const lines = head(o.owner, o.feeLockXrd);
  const take = (res: string, amount: string | undefined, name: string) => {
    if (!amount || new Decimal(amount).isZero()) return 'None';
    lines.push(`CALL_METHOD ${addr(o.owner.account)} "withdraw" ${addr(res)} ${dec(amount)};`, `TAKE_ALL_FROM_WORKTOP ${addr(res)} ${bucket(name)};`);
    return `Some(${bucket(name)})`;
  };
  const a = take(o.resourceA, o.amountA, 'a'), b = take(o.resourceB, o.amountB, 'b');
  lines.push(call(o.pool, 'deposit_inventory', a, b));
  return join(lines);
}

/** Owner: withdraw from the INVENTORY. */
export function ownerPoolWithdrawInventoryManifest(o: Base & { amountA: string; amountB: string; to?: string }): string {
  return join([...head(o.owner, o.feeLockXrd), call(o.pool, 'withdraw_inventory', dec(o.amountA), dec(o.amountB)), depositAll(o.to ?? o.owner.account)]);
}

/** Owner: move between inventory and reserves with no limits; works while paused; does not move the anchor. */
export function ownerPoolOwnerRebalanceManifest(o: Base & { toReserveA: string; toReserveB: string; expected?: [string, string] }): string {
  return join([...head(o.owner, o.feeLockXrd), call(o.pool, 'owner_rebalance', sdec(o.toReserveA), sdec(o.toReserveB), optPair(o.expected))]);
}

/** Owner: state the anchor (A, B) = "B of token B for A of token A", from the MARKET. Zeroes the operator's allowance. */
export function ownerPoolSetAnchorManifest(o: Base & { anchor: [string, string]; expected?: [string, string] }): string {
  checkAnchor(o.anchor);
  return join([...head(o.owner, o.feeLockXrd), call(o.pool, 'set_anchor', dec(o.anchor[0]), dec(o.anchor[1]), optPair(o.expected))]);
}

/**
 * Owner: appoint or replace the operator (`operator` given: its badge must be provable in the same
 * transaction, from `operator.account`, and the anchor is required), or revoke it (`operator: null`;
 * the anchor is optional). A revoke turns the OWNER's pause on: offer `ownerPoolSetPausedManifest(false)`
 * after the curve has been checked. With `reopen`, `set_paused(false)` is appended (the emergency
 * procedure's steps 3-4 in one transaction).
 */
export function ownerPoolSetOperatorManifest(o: Base & { operator: OwnerPoolSigner | null; anchor?: [string, string]; reopen?: boolean }): string {
  if (o.operator && !o.anchor) throw new Error('State the anchor price when appointing an operator');
  if (o.anchor) checkAnchor(o.anchor);
  const lines = head(o.owner, o.feeLockXrd);
  if (o.operator) {
    if (o.operator.badge === o.owner.badge) throw new Error('The operator badge must not be the owner badge');
    lines.push(proof(o.operator));
  }
  lines.push(call(o.pool, 'set_operator', o.operator ? `Some(${addr(o.operator.badge)})` : 'None', optPair(o.anchor)));
  if (o.reopen) lines.push(call(o.pool, 'set_paused', 'false'));
  return join(lines);
}

/** Owner: the operator's limits (budget per window, caps, floors, fee range). Checked here as on ledger. */
export function ownerPoolSetOperatorLimitsManifest(o: Base & { limits: OwnerPoolOperatorLimits }): string {
  const l = o.limits;
  if (l.moveBudgetBps > 10_000) throw new Error('Budget too high');
  if (!Number.isSafeInteger(l.windowEpochs) || l.windowEpochs < 1) throw new Error('Window must be at least one epoch');
  if (new Decimal(l.minReserveA).gt(l.maxReserveA) || new Decimal(l.minReserveB).gt(l.maxReserveB)) throw new Error('Floor above cap');
  if (l.minFeeBps > l.maxFeeBps || l.maxFeeBps > OWNER_POOL_MAX_FEE_BPS) throw new Error('Bad fee range');
  return join([...head(o.owner, o.feeLockXrd), call(o.pool, 'set_operator_limits',
    u16(l.moveBudgetBps, 'budget'), `${l.windowEpochs}u64`, dec(l.maxReserveA), dec(l.maxReserveB), dec(l.minReserveA), dec(l.minReserveB),
    u16(l.minFeeBps, 'min fee'), u16(l.maxFeeBps, 'max fee'))]);
}

/** Owner: the owner's pause (stops swaps, `rebalance` and `operator_set_fee`). */
export function ownerPoolSetPausedManifest(o: Base & { paused: boolean }): string {
  return join([...head(o.owner, o.feeLockXrd), call(o.pool, 'set_paused', String(o.paused))]);
}

/** Owner: the fee, up to the cap fixed in code. */
export function ownerPoolSetFeeManifest(o: Base & { feeBps: number }): string {
  return join([...head(o.owner, o.feeLockXrd), call(o.pool, 'set_fee', u16(o.feeBps, 'fee', OWNER_POOL_MAX_FEE_BPS))]);
}

/**
 * Operator (the bot's hot key): move between inventory and reserves within its limits. Positive
 * moves inventory into the reserves. `expected` (the reserves the bot read) makes it fail rather
 * than act on a curve that moved. Plan it with `ownerPoolPlanRebalance` first.
 */
export function ownerPoolRebalanceManifest(o: { pool: string; operator: OwnerPoolSigner; toReserveA: string; toReserveB: string; expected?: [string, string]; feeLockXrd?: string }): string {
  return join([...head(o.operator, o.feeLockXrd), call(o.pool, 'rebalance', sdec(o.toReserveA), sdec(o.toReserveB), optPair(o.expected))]);
}

/** Operator: the fee inside the owner's range. */
export function ownerPoolOperatorSetFeeManifest(o: { pool: string; operator: OwnerPoolSigner; feeBps: number; feeLockXrd?: string }): string {
  return join([...head(o.operator, o.feeLockXrd), call(o.pool, 'operator_set_fee', u16(o.feeBps, 'fee', OWNER_POOL_MAX_FEE_BPS))]);
}

/** Operator or owner: the operator's pause flag. */
export function ownerPoolSetOperatorPausedManifest(o: { pool: string; signer: OwnerPoolSigner; paused: boolean; feeLockXrd?: string }): string {
  return join([...head(o.signer, o.feeLockXrd), call(o.pool, 'set_operator_paused', String(o.paused))]);
}

function checkAnchor(a: [string, string]) {
  if (!(new Decimal(a[0]).gt(0) && new Decimal(a[1]).gt(0))) throw new Error('Bad anchor');
}
