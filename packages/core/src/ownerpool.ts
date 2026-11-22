import type { Gateway } from './gateway.ts';
import { addr, bucket, dec } from './manifest.ts';
import type { Pool } from './types.ts';

/**
 * OwnerPool (scrypto/owner-pool): a constant-product pool funded only by its owner badge.
 *
 * This module reads a pool's state from the Gateway and reproduces the blueprint's `quote` exactly,
 * in integer arithmetic on the same fixed-point units the engine uses (Decimal: 18 places in an
 * I192; PreciseDecimal: 36 places in an I256), so a quote made here equals what the ledger's
 * `quote` (and therefore `swap`) returns for the same state, to the last unit, and fails where it fails.
 *
 * Pools are trusted by component address only: anyone can instantiate an OwnerPool, under any
 * name, so a pool is used only when its address is listed (markets file or `DEX_OWNER_POOLS`) and
 * the ledger confirms it is an `OwnerPool` of an allow-listed package (`OWNER_POOL_PACKAGES`).
 */

/** Packages whose `OwnerPool` blueprint we route through, by network. Nothing is published on mainnet yet. */
export const OWNER_POOL_PACKAGES: Record<string, string[]> = {
  mainnet: [],
  // Published 22 Nov 2026 from scrypto/owner-pool at c8c2be0 with throwaway keys (scripts/stokenet-owner-pool.ts).
  // Code hash (blake2b-256 of the wasm) 1dd88642…6eed78b9d3; wasm sha256 390362e6…c8e68091.
  // Published 22 Nov 2026 from scrypto/owner-pool at 934c904 (pool-split: cold owner badge, hot operator
  // badge, inventory) with throwaway keys, txid_tdx_2_1s9hkv8j4rml4v722epz4q6ycnn0gdca4fy30mzjxmx0rlvsukngsgce0je.
  // Code hash 0b460d5f…446a7872; wasm sha256 16aed69e…f6acb0dd.
  stokenet: ['package_tdx_2_1p4tzj0gfzh8uzr9ca4y26jrwrevgu8uur7aukzmj3050vmp4y4vrzw', 'package_tdx_2_1pklhl0ma6mepuxakg0pk2tgf4ej05uwgwu8gm0ajv5xa9acsjd4fll'],
};
export const OWNER_POOL_BLUEPRINT = 'OwnerPool';
/** The blueprint's hard cap on the swap fee (`OWNER_POOL_MAX_FEE_BPS` in lib.rs). */
export const OWNER_POOL_MAX_FEE_BPS = 500;

/**
 * Network fee, in XRD, of previewing `withdraw` + one OwnerPool `swap` + `deposit_batch` (the same
 * shape `Quoter.simulate` previews for other venues, so the figures compare like for like).
 * Measured on Stokenet on 22 Nov 2026 with `scripts/stokenet-owner-pool.ts gas`, 10 previews each,
 * both directions, 0.01 to 6,000 XRD and 0.000123 to 2 TEUR: the first package (c8c2be0) 0.45578 to
 * 0.45654 XRD; the split package (934c904, larger state read on every call) 0.49082 to 0.49157 XRD
 * (the existing radixdex test Pool, same shape: 0.5253). One figure for both, rounded up from the
 * larger. The figure barely moves with size.
 */
export const OWNER_POOL_SWAP_FEE_XRD = '0.5';

export interface OwnerPoolState {
  address: string;
  packageAddress: string;
  resourceA: string;
  resourceB: string;
  divisibilityA: number;
  divisibilityB: number;
  /** Trading reserves (the curve's two vaults), as exact decimal strings. Never the inventory. */
  reserveA: string;
  reserveB: string;
  feeBps: number;
  /** True while swaps are refused: the owner's pause OR (split pools) the operator's pause. */
  paused: boolean;
  /** Ledger state version the Gateway read this at. */
  stateVersion?: number;
  /** Split (cold owner / hot operator) pools only: everything else the component holds and says. */
  split?: OwnerPoolSplitState;
}

/** What the operator may do (`OperatorLimits` in lib.rs). Decimals as exact strings. */
export interface OwnerPoolOperatorLimits {
  moveBudgetBps: number;
  windowEpochs: number;
  maxReserveA: string;
  maxReserveB: string;
  minReserveA: string;
  minReserveB: string;
  minFeeBps: number;
  maxFeeBps: number;
}

/** The split blueprint's extra state (pool-split, 934c904 and later). */
export interface OwnerPoolSplitState {
  ownerPaused: boolean;
  operatorPaused: boolean;
  /** Inventory vaults: owned by the pool's owner, not traded, not part of any quote. */
  inventoryA: string;
  inventoryB: string;
  ownerBadge: string;
  /** The operator badge, or null when there is none (never appointed, or revoked). */
  operator: string | null;
  limits: OwnerPoolOperatorLimits;
  /** Stored allowance as of `allowanceEpoch`; use `ownerPoolAllowanceNow` for what is available. */
  allowance: string;
  allowanceEpoch: number;
  /** The anchor (A, B): "B of token B for A of token A". ['0', '0'] until the owner states one. */
  anchor: [string, string];
}

/** A quote the ledger would refuse, with the blueprint's own panic message. */
export class OwnerPoolQuoteError extends Error {}

// ------------------------------------------------------------------ fixed-point arithmetic

const E18 = 10n ** 18n;
const E36 = 10n ** 36n;
/** Largest Decimal (I192) and PreciseDecimal (I256) raw values. */
const DECIMAL_MAX = 2n ** 191n - 1n;
const PRECISE_MAX = 2n ** 255n - 1n;

/** An exact decimal string as attos (Decimal's raw I192 units). Throws on anything a Decimal cannot hold. */
export function toAttos(v: string): bigint {
  const s = String(v).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new OwnerPoolQuoteError(`Not a decimal: ${JSON.stringify(v)}`);
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > 18) throw new OwnerPoolQuoteError('Amount has more than 18 decimal places');
  const raw = BigInt(m[2]!) * E18 + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  if (raw > DECIMAL_MAX) throw new OwnerPoolQuoteError('Amount out of range');
  return m[1] ? -raw : raw;
}

/** Attos back to the shortest exact decimal string. */
export function fromAttos(a: bigint): string {
  const neg = a < 0n;
  const s = (neg ? -a : a).toString().padStart(19, '0');
  const out = `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '');
  return (neg ? '-' : '') + (out || '0');
}

const unit = (divisibility: number): bigint => 10n ** BigInt(36 - divisibility);
/** PreciseDecimal::checked_round(div, ToNegativeInfinity) for a non-negative value. */
const floorPrecise = (p: bigint, divisibility: number): bigint => (p / unit(divisibility)) * unit(divisibility);
/** PreciseDecimal::checked_round(div, ToPositiveInfinity) for a non-negative value. */
const ceilPrecise = (p: bigint, divisibility: number): bigint => ((p + unit(divisibility) - 1n) / unit(divisibility)) * unit(divisibility);
const checkPrecise = (p: bigint): bigint => { if (p > PRECISE_MAX) throw new OwnerPoolQuoteError('Overflow'); return p; };

/**
 * `compute_swap` from lib.rs, on attos. Returns the output in attos; 0 when the fee eats the whole input.
 *   fee    = ceil_to(PreciseDecimal(input) * fee_bps / 10000, div_in)
 *   share  = eff / (r_in + eff)           (PreciseDecimal division: truncated to 36 places)
 *   output = floor_to(r_out * share, div_out)   (PreciseDecimal multiplication: truncated)
 */
export function ownerPoolCompute(o: { rIn: bigint; rOut: bigint; divIn: number; divOut: number; input: bigint; feeBps: number }): bigint {
  if (o.input <= 0n) throw new OwnerPoolQuoteError('Nothing to swap');
  if (o.rIn <= 0n || o.rOut <= 0n) throw new OwnerPoolQuoteError('Pool is empty');
  // PreciseDecimal(input) * PreciseDecimal(fee_bps): (in·1e18 · bps·1e36) / 1e36, held in an I256.
  const product = checkPrecise(o.input * E18 * BigInt(o.feeBps));
  // ... / PreciseDecimal(10000): (product · 1e36) / (10000 · 1e36), truncated.
  const feeAttos = ceilPrecise(product / 10_000n, o.divIn) / E18;
  const effective = o.input - feeAttos;
  if (effective <= 0n) return 0n;
  const eff = effective * E18, rIn = o.rIn * E18, rOut = o.rOut * E18;
  const share = (eff * E36) / checkPrecise(rIn + eff);
  const outPrecise = checkPrecise((rOut * share) / E36);
  const out = floorPrecise(outPrecise, o.divOut) / E18;
  if (out >= o.rOut) throw new OwnerPoolQuoteError('Not enough liquidity');
  return out;
}

/** The side of the pool `resource` is on, or a throw like the blueprint's. */
function sides(state: OwnerPoolState, inputResource: string) {
  const a = { r: toAttos(state.reserveA), div: state.divisibilityA }, b = { r: toAttos(state.reserveB), div: state.divisibilityB };
  if (inputResource === state.resourceA) return { inp: a, out: b, outResource: state.resourceB };
  if (inputResource === state.resourceB) return { inp: b, out: a, outResource: state.resourceA };
  throw new OwnerPoolQuoteError('Token is not in this pool');
}

/**
 * The blueprint's `quote`: what `swap` pays for `inputAmount` of `inputResource` in this state,
 * as an exact decimal string. Throws `OwnerPoolQuoteError` with the ledger's message wherever the
 * ledger's `quote` (and `swap`) would fail, checked in the same order.
 */
export function ownerPoolQuote(state: OwnerPoolState, inputResource: string, inputAmount: string): string {
  if (state.paused) throw new OwnerPoolQuoteError('Swaps are paused');
  const s = sides(state, inputResource);
  const input = toAttos(inputAmount);
  if (input % 10n ** BigInt(18 - s.inp.div) !== 0n) throw new OwnerPoolQuoteError('Amount has more decimal places than the token allows');
  const out = ownerPoolCompute({ rIn: s.inp.r, rOut: s.out.r, divIn: s.inp.div, divOut: s.out.div, input, feeBps: state.feeBps });
  if (out <= 0n) throw new OwnerPoolQuoteError('Trade too small');
  return fromAttos(out);
}

/** The pool's state after a swap that paid `output` for `input` (the input, fee included, stays in the pool). */
export function ownerPoolAfterSwap(state: OwnerPoolState, inputResource: string, input: string, output: string): OwnerPoolState {
  const aIn = inputResource === state.resourceA;
  const ra = toAttos(state.reserveA) + (aIn ? toAttos(input) : -toAttos(output));
  const rb = toAttos(state.reserveB) + (aIn ? -toAttos(output) : toAttos(input));
  return { ...state, reserveA: fromAttos(ra), reserveB: fromAttos(rb) };
}

// ------------------------------------------------------------------ reading the ledger

const fieldNode = (fields: any[], name: string): any => {
  const f = (fields ?? []).find((x: any) => x?.field_name === name);
  if (!f) throw new Error(`OwnerPool state has no field "${name}"`);
  return f;
};
const fieldOf = (fields: any[], name: string): any => fieldNode(fields, name).value;
const hasField = (fields: any[], name: string): boolean => (fields ?? []).some((x: any) => x?.field_name === name);

/** A Decimal field of programmatic JSON, checked. */
const decimalOf = (v: any, what: string): string => {
  const s = String(v?.value ?? v);
  try { toAttos(s); } catch { throw new Error(`OwnerPool ${what} is not a decimal: ${s}`); }
  return s;
};
const intOf = (v: any, what: string, max: number): number => {
  const n = Number(v?.value ?? v);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`OwnerPool ${what} out of range: ${v?.value ?? v}`);
  return n;
};

/** The split blueprint's state fields (present only when the component has an `inventory_a` field). */
function parseSplit(fields: any[], vaultAmount: (field: string) => string): OwnerPoolSplitState {
  const operatorPaused = fieldOf(fields, 'operator_paused');
  if (typeof operatorPaused !== 'boolean') throw new Error('OwnerPool operator_paused is not a boolean');
  // Option<ResourceAddress>: an Enum whose Some variant holds one Reference.
  const op = fieldNode(fields, 'operator');
  const variant = op.variant_name ?? (op.variant_id === '1' || op.variant_id === 1 ? 'Some' : op.variant_id === '0' || op.variant_id === 0 ? 'None' : undefined);
  let operator: string | null;
  if (variant === 'None') operator = null;
  else if (variant === 'Some' && typeof op.fields?.[0]?.value === 'string') operator = op.fields[0].value;
  else throw new Error('OwnerPool operator is not an Option<ResourceAddress>');
  const lf = fieldNode(fields, 'limits').fields;
  const limits: OwnerPoolOperatorLimits = {
    moveBudgetBps: intOf(fieldOf(lf, 'move_budget_bps'), 'move_budget_bps', 10_000),
    windowEpochs: intOf(fieldOf(lf, 'window_epochs'), 'window_epochs', Number.MAX_SAFE_INTEGER),
    maxReserveA: decimalOf(fieldOf(lf, 'max_reserve_a'), 'max_reserve_a'),
    maxReserveB: decimalOf(fieldOf(lf, 'max_reserve_b'), 'max_reserve_b'),
    minReserveA: decimalOf(fieldOf(lf, 'min_reserve_a'), 'min_reserve_a'),
    minReserveB: decimalOf(fieldOf(lf, 'min_reserve_b'), 'min_reserve_b'),
    minFeeBps: intOf(fieldOf(lf, 'min_fee_bps'), 'min_fee_bps', OWNER_POOL_MAX_FEE_BPS),
    maxFeeBps: intOf(fieldOf(lf, 'max_fee_bps'), 'max_fee_bps', OWNER_POOL_MAX_FEE_BPS),
  };
  const anchor = fieldNode(fields, 'anchor').fields ?? [];
  if (anchor.length !== 2) throw new Error('OwnerPool anchor is not a pair');
  return {
    ownerPaused: fieldOf(fields, 'paused') === true,
    operatorPaused,
    inventoryA: vaultAmount('inventory_a'),
    inventoryB: vaultAmount('inventory_b'),
    ownerBadge: String(fieldOf(fields, 'owner_badge')),
    operator,
    limits,
    allowance: decimalOf(fieldOf(fields, 'allowance'), 'allowance'),
    allowanceEpoch: intOf(fieldOf(fields, 'allowance_epoch'), 'allowance_epoch', Number.MAX_SAFE_INTEGER),
    anchor: [decimalOf(anchor[0], 'anchor'), decimalOf(anchor[1], 'anchor')],
  };
}

/**
 * Parse one item of `/state/entity/details` for an OwnerPool component. Checks the blueprint, and
 * the package when `allowedPackages` is given.
 *
 * Reserves are read vault by vault: the state names each vault (`vault_a`, `vault_b`, and on split
 * pools `inventory_a`, `inventory_b`), and the item must be read with `aggregation_level: "Vault"`
 * so each vault's own balance is listed. A split pool holds each token in TWO vaults (reserve and
 * inventory), so a per-resource total would overstate the curve; such an item is refused. The
 * pre-split blueprint holds exactly two vaults, so a per-resource total is still accepted for it.
 */
export function parseOwnerPoolDetails(item: any, allowedPackages?: string[], stateVersion?: number): OwnerPoolState {
  const d = item?.details;
  if (d?.type !== 'Component' || d?.blueprint_name !== OWNER_POOL_BLUEPRINT) throw new Error(`${item?.address} is not an ${OWNER_POOL_BLUEPRINT} component`);
  if (allowedPackages && !allowedPackages.includes(d.package_address)) throw new Error(`${item.address} is an ${OWNER_POOL_BLUEPRINT} of package ${d.package_address}, which is not allow-listed`);
  const fields = d.state?.fields;
  const resourceA = String(fieldOf(fields, 'resource_a')), resourceB = String(fieldOf(fields, 'resource_b'));
  const divisibilityA = Number(fieldOf(fields, 'divisibility_a')), divisibilityB = Number(fieldOf(fields, 'divisibility_b'));
  const feeBps = Number(fieldOf(fields, 'fee_bps'));
  const paused = fieldOf(fields, 'paused');
  for (const [n, v] of [['divisibility_a', divisibilityA], ['divisibility_b', divisibilityB]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 18) throw new Error(`OwnerPool ${n} is not a divisibility: ${v}`);
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > OWNER_POOL_MAX_FEE_BPS) throw new Error(`OwnerPool fee_bps out of range: ${feeBps}`);
  if (typeof paused !== 'boolean') throw new Error('OwnerPool paused is not a boolean');
  const items: any[] = item?.fungible_resources?.items ?? [];
  if (item?.fungible_resources?.next_cursor) throw new Error('OwnerPool holds more resources than expected');
  const isSplit = hasField(fields, 'inventory_a');
  const byVault = items.some((i) => i?.vaults !== undefined);
  const vaults = new Map<string, string>();
  for (const it of items) {
    if (it?.vaults?.next_cursor) throw new Error('OwnerPool holds more vaults than expected');
    for (const v of it?.vaults?.items ?? []) vaults.set(String(v.vault_address), String(v.amount));
  }
  const checked = (amount: string) => { toAttos(amount); return amount; };
  /** The balance of the vault a state field names. A vault never funded may be listed with 0 or not at all. */
  const vaultAmount = (field: string) => {
    const v = fieldOf(fields, field);
    if (typeof v !== 'string' || !v.startsWith('internal_vault_')) throw new Error(`OwnerPool ${field} is not a vault`);
    return checked(vaults.get(v) ?? '0');
  };
  const total = (resource: string) => {
    const it = items.find((i) => i?.resource_address === resource);
    return checked(it === undefined ? '0' : String(it.amount));
  };
  if (isSplit && !byVault) throw new Error('OwnerPool with inventory: read it with aggregation_level "Vault" (a per-token total includes the inventory)');
  const reserveA = byVault ? vaultAmount('vault_a') : total(resourceA);
  const reserveB = byVault ? vaultAmount('vault_b') : total(resourceB);
  const out: OwnerPoolState = {
    address: String(item.address), packageAddress: String(d.package_address), resourceA, resourceB, divisibilityA, divisibilityB,
    reserveA, reserveB, feeBps, paused, stateVersion,
  };
  if (isSplit) {
    out.split = parseSplit(fields, vaultAmount);
    // Swaps (and the ledger's `quote`) are refused while EITHER pause is on.
    out.paused = out.split.ownerPaused || out.split.operatorPaused;
  }
  return out;
}

/** Read OwnerPool components from the ledger, vault by vault, in one Gateway call per 20. */
export async function readOwnerPools(gateway: Gateway, addresses: string[], allowedPackages?: string[]): Promise<OwnerPoolState[]> {
  const out: OwnerPoolState[] = [];
  for (let i = 0; i < addresses.length; i += 20) {
    const j = await gateway.post('/state/entity/details', { addresses: addresses.slice(i, i + 20), aggregation_level: 'Vault' });
    const sv = j?.ledger_state?.state_version;
    for (const a of addresses.slice(i, i + 20)) {
      const item = (j?.items ?? []).find((x: any) => x?.address === a);
      if (!item) throw new Error(`Gateway returned nothing for ${a}`);
      out.push(parseOwnerPoolDetails(item, allowedPackages, sv));
    }
  }
  return out;
}

/**
 * The `Pool` record for an OwnerPool, built from its ledger state alone (whatever a markets file
 * said about its tokens). `reserves` are the live balances; display figures are left at zero.
 */
export function ownerPoolAsPool(state: OwnerPoolState, display?: { tvlUsd?: number; volume24hUsd?: number }): Pool {
  return {
    venue: 'ownerpool', address: state.address, kind: 'owner', tokens: [state.resourceA, state.resourceB],
    feeRate: state.feeBps / 10_000, tvlUsd: display?.tvlUsd ?? 0, volume24hUsd: display?.volume24hUsd ?? 0,
    reserves: [Number(state.reserveA), Number(state.reserveB)],
  };
}

// ------------------------------------------------------------------ manifests

/**
 * The swap call for an OwnerPool, always with a minimum: `swap_with_minimum` fails ("Less than the
 * minimum") unless at least `minimum` comes out, so an owner raising the fee or moving the price
 * between quote and commit can only make the transaction fail, never pay less.
 */
export function ownerPoolSwapInstruction(pool: string, inBucket: string, minimum: string): string {
  if (!/^\d+(\.\d+)?$/.test(String(minimum).trim())) throw new Error(`OwnerPool swap needs a minimum, not ${JSON.stringify(minimum)}`);
  return `CALL_METHOD ${addr(pool)} "swap_with_minimum" ${bucket(inBucket)} ${dec(minimum)};`;
}
