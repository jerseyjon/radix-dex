import { Decimal, addr, bucket, dec } from './manifest.ts';
import { OWNER_POOL_MAX_FEE_BPS, type OwnerPoolOperatorLimits, type OwnerPoolState } from './ownerpool.ts';
import { ownerPoolSetFeeManifest, ownerPoolSetOperatorLimitsManifest, type OwnerPoolSigner } from './ownerpool-ops.ts';

/**
 * Set-up manifests for a split OwnerPool that the OWNER signs (badges, package, instantiation,
 * appointing the operator, limits and fee together) and the checks the set-up script makes on the
 * ledger's answers. Used by scripts/mainnet-owner-pool.ts for mainnet (printed for the owner's
 * wallet) and Stokenet (signed with throwaway keys), so both networks run the same builders.
 *
 * Nothing here sends anything. Every manifest must be previewed before it is signed.
 * For a manifest signed in the Radix Wallet leave `feeLockXrd` out: the wallet adds its own fee lock.
 */

const join = (lines: string[]) => lines.join('\n');
const lockFee = (account: string, feeLockXrd?: string) => (feeLockXrd ? [`CALL_METHOD ${addr(account)} "lock_fee" ${dec(feeLockXrd)};`] : []);
/** A name usable in a manifest (bucket, reservation or named address). */
const name = (n: string) => { if (!/^[a-z][a-z0-9_]{0,40}$/.test(n)) throw new Error(`Bad manifest name: ${n}`); return n; };
/** Text for a manifest string: refuse anything that would need escaping. */
const text = (v: string) => { if (/["\\\n\r]/.test(v) || v.length > 300) throw new Error(`Bad text for a manifest: ${v}`); return `"${v}"`; };

/** An address argument: a real address, or a NamedAddress allocated earlier in the same manifest. */
export type AddressRef = string | { named: string };
const ref = (a: AddressRef) => (typeof a === 'string' ? addr(a) : `NamedAddress("${name(a.named)}")`);

/**
 * A badge as the OwnerPool design requires (lib.rs, "Operating rules"): a fungible with divisibility 0
 * and a fixed supply of 1, owner role None, and NO mint, burn, freeze or recall roles at all (the
 * features do not exist on the resource; withdraw/deposit default to AllowAll with a DenyAll
 * updater). Name and description are set and locked at creation. It goes to `account`.
 * `reservation`: allocate its address first and name it (`{ named }`), so the same manifest can use it.
 */
export function ownerPoolCreateBadgeManifest(o: { account: string; name: string; description: string; feeLockXrd?: string; reservation?: { resourcePackage: string; named: string } }): string {
  const roles = 'Tuple(None, None, None, None, None, None)';
  const md = `Tuple(Map<String, Tuple>("name" => Tuple(Some(Enum<Metadata::String>(${text(o.name)})), true), ` +
    `"description" => Tuple(Some(Enum<Metadata::String>(${text(o.description)})), true)), Map<String, Enum>())`;
  const lines = lockFee(o.account, o.feeLockXrd);
  let reservation = 'None';
  if (o.reservation) {
    const r = name(`${o.reservation.named}_reservation`);
    lines.push(`ALLOCATE_GLOBAL_ADDRESS ${addr(o.reservation.resourcePackage)} "FungibleResourceManager" AddressReservation("${r}") NamedAddress("${name(o.reservation.named)}");`);
    reservation = `Some(AddressReservation("${r}"))`;
  }
  lines.push(
    `CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<OwnerRole::None>() true 0u8 Decimal("1") ${roles} ${md} ${reservation};`,
    `CALL_METHOD ${addr(o.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  );
  return join(lines);
}

/**
 * Publish the OwnerPool package: owner role None (nobody can change the package), no metadata,
 * no royalties. `definition` is the package definition (the .rpd) as manifest text; `codeHash`
 * the blake2b-256 of the wasm, which travels as a blob. `reservation`: allocate the package address
 * first so the same manifest can call it (only used for previews).
 */
export function ownerPoolPublishManifest(o: { account: string; definition: string; codeHash: string; feeLockXrd?: string; reservation?: { packagePackage: string; named: string } }): string {
  if (!/^[0-9a-f]{64}$/.test(o.codeHash)) throw new Error('Bad code hash');
  const lines = lockFee(o.account, o.feeLockXrd);
  let reservation = 'None';
  if (o.reservation) {
    const r = name(`${o.reservation.named}_reservation`);
    lines.push(`ALLOCATE_GLOBAL_ADDRESS ${addr(o.reservation.packagePackage)} "Package" AddressReservation("${r}") NamedAddress("${name(o.reservation.named)}");`);
    reservation = `Some(AddressReservation("${r}"))`;
  }
  lines.push(`PUBLISH_PACKAGE_ADVANCED Enum<OwnerRole::None>() ${o.definition} Blob("${o.codeHash}") Map<String, Tuple>() ${reservation};`);
  return join(lines);
}

/**
 * Create a pool AND fund it in one transaction (`instantiate_with_liquidity`), so no empty pool
 * ever exists for anyone to touch (pool audit F2, which on this blueprint cannot happen anyway:
 * only the owner badge can deposit, and a swap needs both reserves). The pool's owner is
 * `owner.badge`, whose proof the blueprint requires in the same transaction. Exactly `amountA` of
 * `resourceA` and `amountB` of `resourceB` leave the owner's account; the price is amountB / amountA.
 */
export function ownerPoolInstantiateManifest(o: {
  owner: { account: string; badge: AddressRef }; package: AddressRef; resourceA: string; resourceB: string;
  amountA: string; amountB: string; feeBps: number; feeLockXrd?: string;
}): string {
  if (o.resourceA === o.resourceB) throw new Error('The two tokens must differ');
  if (!Number.isInteger(o.feeBps) || o.feeBps < 0 || o.feeBps > OWNER_POOL_MAX_FEE_BPS) throw new Error(`Fee out of range: ${o.feeBps}`);
  if (!(new Decimal(o.amountA).gt(0) && new Decimal(o.amountB).gt(0))) throw new Error('Both amounts must be positive');
  return join([
    ...lockFee(o.owner.account, o.feeLockXrd),
    `CALL_METHOD ${addr(o.owner.account)} "create_proof_of_amount" ${ref(o.owner.badge)} Decimal("1");`,
    `CALL_METHOD ${addr(o.owner.account)} "withdraw" ${addr(o.resourceA)} ${dec(o.amountA)};`,
    `CALL_METHOD ${addr(o.owner.account)} "withdraw" ${addr(o.resourceB)} ${dec(o.amountB)};`,
    `TAKE_ALL_FROM_WORKTOP ${addr(o.resourceA)} ${bucket('a')};`,
    `TAKE_ALL_FROM_WORKTOP ${addr(o.resourceB)} ${bucket('b')};`,
    `CALL_FUNCTION ${ref(o.package)} "OwnerPool" "instantiate_with_liquidity" ${bucket('a')} ${bucket('b')} ${o.feeBps}u16 ${ref(o.owner.badge)};`,
  ]);
}

/**
 * Appoint (or replace) the operator and hand it its badge, in one transaction: `set_operator` with
 * the anchor the owner states (proofs of the owner badge and of the operator badge, both held by the
 * owner's account at this point), then the proofs are dropped (a proof locks its badge in the vault)
 * and the operator badge, with `fundXrd` XRD for network fees if given, goes to the operator account.
 */
export function ownerPoolAppointManifest(o: {
  pool: string; owner: OwnerPoolSigner; operatorBadge: string; anchor: [string, string]; operatorAccount: string;
  xrd: string; fundXrd?: string; feeLockXrd?: string; reopen?: boolean;
}): string {
  if (o.operatorBadge === o.owner.badge) throw new Error('The operator badge must not be the owner badge');
  if (!(new Decimal(o.anchor[0]).gt(0) && new Decimal(o.anchor[1]).gt(0))) throw new Error('Bad anchor');
  if (o.operatorAccount === o.owner.account) throw new Error('The operator account must not be the owner account');
  const lines = [
    ...lockFee(o.owner.account, o.feeLockXrd),
    `CALL_METHOD ${addr(o.owner.account)} "create_proof_of_amount" ${addr(o.owner.badge)} Decimal("1");`,
    `CALL_METHOD ${addr(o.owner.account)} "create_proof_of_amount" ${addr(o.operatorBadge)} Decimal("1");`,
    `CALL_METHOD ${addr(o.pool)} "set_operator" Some(${addr(o.operatorBadge)}) Some(Tuple(${dec(o.anchor[0])}, ${dec(o.anchor[1])}));`,
    ...(o.reopen ? [`CALL_METHOD ${addr(o.pool)} "set_paused" false;`] : []),
    'DROP_AUTH_ZONE_REGULAR_PROOFS;',
    `CALL_METHOD ${addr(o.owner.account)} "withdraw" ${addr(o.operatorBadge)} Decimal("1");`,
  ];
  if (o.fundXrd && new Decimal(o.fundXrd).gt(0)) lines.push(`CALL_METHOD ${addr(o.owner.account)} "withdraw" ${addr(o.xrd)} ${dec(o.fundXrd)};`);
  lines.push(`CALL_METHOD ${addr(o.operatorAccount)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;`);
  return join(lines);
}

/**
 * The operator's limits and the fee in ONE transaction. On Stokenet (23 Nov 2026) lowering the
 * operator's maximum fee did not clamp the fee already in force, so a limits change that narrows the
 * range must set the fee in the same transaction. Refuses a fee outside the new range (the bot could
 * not move it back inside without a change of its own) unless `allowOutsideRange`.
 */
export function ownerPoolLimitsAndFeeManifest(o: { pool: string; owner: OwnerPoolSigner; limits: OwnerPoolOperatorLimits; feeBps: number; feeLockXrd?: string; allowOutsideRange?: boolean }): string {
  if (!o.allowOutsideRange && (o.feeBps < o.limits.minFeeBps || o.feeBps > o.limits.maxFeeBps)) {
    throw new Error(`Fee ${o.feeBps} bps is outside the new operator range ${o.limits.minFeeBps}-${o.limits.maxFeeBps}`);
  }
  const limits = ownerPoolSetOperatorLimitsManifest({ pool: o.pool, owner: o.owner, feeLockXrd: o.feeLockXrd, limits: o.limits });
  // The fee call reuses the proof already in the auth zone: drop its own proof line.
  const fee = ownerPoolSetFeeManifest({ pool: o.pool, owner: o.owner, feeBps: o.feeBps }).split('\n').filter((l) => !l.includes('"create_proof_of_amount"'));
  return join([limits, ...fee]);
}

/**
 * Owner: take EVERYTHING out of the pool, reserves and inventory, to the owner's account (`withdraw_all`).
 * No reserves guard (emptying sets no price). Fails as a whole if a token issuer has frozen a non-empty
 * vault; then take the rest vault by vault (lib.rs `withdraw_all`).
 */
export function ownerPoolWithdrawAllManifest(o: { pool: string; owner: OwnerPoolSigner; feeLockXrd?: string }): string {
  return join([
    ...lockFee(o.owner.account, o.feeLockXrd),
    `CALL_METHOD ${addr(o.owner.account)} "create_proof_of_amount" ${addr(o.owner.badge)} Decimal("1");`,
    `CALL_METHOD ${addr(o.pool)} "withdraw_all";`,
    `CALL_METHOD ${addr(o.owner.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ]);
}

/** Send what an account holds of `resources` (exact amounts) to another account. For returning test funds. */
export function transferManifest(o: { from: string; to: string; items: { resource: string; amount: string }[]; feeLockXrd?: string }): string {
  const items = o.items.filter((i) => new Decimal(i.amount).gt(0));
  if (!items.length) throw new Error('Nothing to send');
  return join([
    ...lockFee(o.from, o.feeLockXrd),
    ...items.map((i) => `CALL_METHOD ${addr(o.from)} "withdraw" ${addr(i.resource)} ${dec(i.amount)};`),
    `CALL_METHOD ${addr(o.to)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;`,
  ]);
}

// ------------------------------------------------------------------ checks on ledger answers

/** One role of a resource as the Gateway reports it (`details.role_assignments.entries[]`). */
interface GatewayRoleEntry { role_key?: { module?: string; name?: string }; assignment?: { resolution?: string; explicit_rule?: { type?: string } } }

/** Main-module role rule type by name ('DenyAll', 'AllowAll', 'Protected'), or 'Owner' when it falls back to the owner role, or undefined when absent. */
function mainRoles(details: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of (details?.role_assignments?.entries ?? []) as GatewayRoleEntry[]) {
    if (e.role_key?.module !== 'Main' || !e.role_key.name) continue;
    out.set(e.role_key.name, e.assignment?.resolution === 'Owner' ? 'Owner' : String(e.assignment?.explicit_rule?.type));
  }
  return out;
}
const ownerRule = (details: any): string => String(details?.role_assignments?.owner?.rule?.type ?? 'unknown');
const ownerUpdater = (details: any): string => String(details?.role_assignments?.owner?.updater ?? 'unknown');
/** A role nobody holds and nobody can change: DenyAll, with its updater DenyAll; or no such role (feature absent). */
function locked(roles: Map<string, string>, role: string, owner: string): boolean {
  const r = roles.get(role), u = roles.get(`${role}_updater`);
  if (r === undefined && u === undefined) return true;
  const deny = (x: string | undefined) => x === 'DenyAll' || (x === 'Owner' && owner === 'DenyAll');
  return deny(r) && deny(u);
}

/**
 * Problems with a token as a POOL token (lib.rs "Operating rules", audit I-1): a recaller or freezer
 * that someone holds or could be given is refused (`errors`); a minter or burner that someone holds is
 * a `warning` (a bridge or pool-unit token must have one: whoever holds it can mint the token and
 * buy the other side out of the pool; the owner must accept that issuer risk by name).
 * `details` is a Gateway `/state/entity/details` item's `details` for a fungible resource.
 */
export function poolTokenProblems(details: any): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (details?.type !== 'FungibleResource') errors.push('not a fungible resource');
  const roles = mainRoles(details), owner = ownerRule(details);
  for (const role of ['recaller', 'freezer']) if (!locked(roles, role, owner)) errors.push(`${role} is held or can be assigned (${roles.get(role) ?? 'owner'} / updater ${roles.get(role + '_updater') ?? 'owner'})`);
  for (const role of ['withdrawer', 'depositor']) {
    const r = roles.get(role), u = roles.get(`${role}_updater`);
    if (r !== undefined && r !== 'AllowAll') errors.push(`${role} is ${r}, not AllowAll`);
    if (u !== undefined && u !== 'DenyAll' && !(u === 'Owner' && owner === 'DenyAll')) errors.push(`${role}_updater is ${u}: someone can restrict transfers`);
  }
  for (const role of ['minter', 'burner']) if (!locked(roles, role, owner)) warnings.push(`${role} is held by someone (${roles.get(role) ?? 'owner'}): the issuer's power over this token`);
  return { errors, warnings };
}

/**
 * Problems with a BADGE (owner or operator) as the design requires: fungible, divisibility 0, total
 * supply exactly 1, and nobody able to mint, freeze or recall it, now or later. Empty = fine.
 */
export function badgeProblems(details: any): string[] {
  const out: string[] = [];
  if (details?.type !== 'FungibleResource') out.push('not a fungible resource');
  if (details?.divisibility !== 0) out.push(`divisibility ${details?.divisibility}, not 0`);
  if (String(details?.total_supply) !== '1') out.push(`total supply ${details?.total_supply}, not 1`);
  const roles = mainRoles(details), owner = ownerRule(details);
  for (const role of ['minter', 'recaller', 'freezer']) if (!locked(roles, role, owner)) out.push(`${role} is held or can be assigned`);
  if (owner !== 'DenyAll' && ownerUpdater(details) !== 'None') out.push(`owner role ${owner} can be changed (updater ${ownerUpdater(details)})`);
  return out;
}

/** d = max(x/y, y/x) - 1 for two positive prices. */
export function priceGap(x: number, y: number): number {
  if (!(x > 0 && y > 0)) return Infinity;
  return Math.max(x / y, y / x) - 1;
}

/**
 * The amount of token B to withdraw with `amountA` of token A so the curve's price stays where it is
 * (rounded down to B's places: the price moves up by at most one unit of B).
 */
export function proportionalB(state: Pick<OwnerPoolState, 'reserveA' | 'reserveB' | 'divisibilityB'>, amountA: string): string {
  return new Decimal(amountA).mul(state.reserveB).div(state.reserveA).toDecimalPlaces(state.divisibilityB, Decimal.ROUND_DOWN).toFixed();
}

/**
 * What the ledger must show after each owner step: a list of mismatches (empty = as expected).
 * `want` holds only what the step set; anything absent is not compared.
 */
export function ownerPoolStepMismatches(p: OwnerPoolState, want: {
  reserves?: [string, string]; inventory?: [string, string]; feeBps?: number; ownerPaused?: boolean; operatorPaused?: boolean;
  operator?: string | null; anchor?: [string, string]; limits?: OwnerPoolOperatorLimits; ownerBadge?: string; resources?: [string, string];
}): string[] {
  const out: string[] = [];
  const eq = (a: string, b: string) => new Decimal(a).eq(b);
  const s = p.split;
  if (!s) return ['not a split OwnerPool'];
  if (want.resources && (p.resourceA !== want.resources[0] || p.resourceB !== want.resources[1])) out.push(`tokens ${p.resourceA} / ${p.resourceB}`);
  if (want.reserves && !(eq(p.reserveA, want.reserves[0]) && eq(p.reserveB, want.reserves[1]))) out.push(`reserves ${p.reserveA} / ${p.reserveB}, expected ${want.reserves.join(' / ')}`);
  if (want.inventory && !(eq(s.inventoryA, want.inventory[0]) && eq(s.inventoryB, want.inventory[1]))) out.push(`inventory ${s.inventoryA} / ${s.inventoryB}, expected ${want.inventory.join(' / ')}`);
  if (want.feeBps !== undefined && p.feeBps !== want.feeBps) out.push(`fee ${p.feeBps} bps, expected ${want.feeBps}`);
  if (want.ownerPaused !== undefined && s.ownerPaused !== want.ownerPaused) out.push(`owner pause ${s.ownerPaused}, expected ${want.ownerPaused}`);
  if (want.operatorPaused !== undefined && s.operatorPaused !== want.operatorPaused) out.push(`operator pause ${s.operatorPaused}, expected ${want.operatorPaused}`);
  if (want.operator !== undefined && s.operator !== want.operator) out.push(`operator ${s.operator}, expected ${want.operator}`);
  if (want.anchor && !(eq(s.anchor[0], want.anchor[0]) && eq(s.anchor[1], want.anchor[1]))) out.push(`anchor ${s.anchor.join(':')}, expected ${want.anchor.join(':')}`);
  if (want.ownerBadge && s.ownerBadge !== want.ownerBadge) out.push(`owner badge ${s.ownerBadge}, expected ${want.ownerBadge}`);
  if (want.limits) {
    const l = s.limits, w = want.limits;
    for (const k of ['moveBudgetBps', 'windowEpochs', 'minFeeBps', 'maxFeeBps'] as const) if (l[k] !== w[k]) out.push(`limit ${k} ${l[k]}, expected ${w[k]}`);
    for (const k of ['maxReserveA', 'maxReserveB', 'minReserveA', 'minReserveB'] as const) if (!eq(l[k], w[k])) out.push(`limit ${k} ${l[k]}, expected ${w[k]}`);
  }
  return out;
}
