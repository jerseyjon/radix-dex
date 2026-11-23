// Set-up builders and ledger checks for the owner's split OwnerPools (scripts/mainnet-owner-pool.ts).
// The role fixtures are the shapes the Gateway returned on 23 Nov 2026 for the DIFD pools owner badge
// made on Stokenet (resource_tdx_2_1t4e0yq0…l73ww35) and for mainnet hUSDC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import {
  NETWORKS, badgeProblems, buildTransaction, keyFromHex, ownerPoolAppointManifest, ownerPoolCreateBadgeManifest, ownerPoolInstantiateManifest,
  ownerPoolLimitsAndFeeManifest, ownerPoolPublishManifest, ownerPoolStepMismatches, ownerPoolWithdrawAllManifest, poolTokenProblems, priceGap,
  proportionalB, toHex, transferManifest, type OwnerPoolOperatorLimits, type OwnerPoolState,
} from '../src/index.ts';

const net = NETWORKS.stokenet;
const XRD = net.xrd;
const TEUR = 'resource_tdx_2_1tknxk37t6tvqce4ce0jqv7ymydjfgjej4mw0wkdzep4wjfz8trvpj3';
const OWNER = 'account_tdx_2_129q4ucv5v9j7ukhg5f3nxyle979ek0eyj6j45fxlpargmrcg2qhuaf';
const OPERATOR = 'account_tdx_2_128x3s0xqj8nj55st5s38mjfsfcc2ddyejcq2vjwuctwugy3ukwcj22';
const BADGE = 'resource_tdx_2_1t4e0yq0a0yzxzfyap5feen3lcu4ajn6vf0kheh9h9fsk8pwl73ww35';
const OP_BADGE = 'resource_tdx_2_1tks7440zgkkj5f4u6pu64qk79uau8z3v0kwzd7hs22w3vftfhx0mg2';
const PACKAGE = 'package_tdx_2_1pklhl0ma6mepuxakg0pk2tgf4ej05uwgwu8gm0ajv5xa9acsjd4fll';
const POOL = 'component_tdx_2_1czageep5dckrewazzkt4za3gc5tvzak6ehl20x349fuhl7u58krsh0';
const RESOURCE_PACKAGE = 'package_tdx_2_1pkgxxxxxxxxxresrcexxxxxxxxx000538436477xxxxxxxxxmn4mes';
const PACKAGE_PACKAGE = 'package_tdx_2_1pkgxxxxxxxxxpackgexxxxxxxxx000726633226xxxxxxxxxehawfs';

/** Compiles (Radix Engine Toolkit) or throws: the manifest is well formed for Stokenet. */
async function compiles(manifest: string, blobs: Uint8Array[] = []) {
  await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: 10, endEpoch: 20 }, notary: keyFromHex(randomBytes(32).toString('hex')), blobs });
}

type Rule = 'DenyAll' | 'AllowAll' | 'Protected' | 'Owner';
const entry = (name: string, rule: Rule) => ({ role_key: { module: 'Main', name }, assignment: rule === 'Owner' ? { resolution: 'Owner' } : { resolution: 'Explicit', explicit_rule: { type: rule } } });
function resource(o: { divisibility: number; supply: string; roles: Record<string, Rule>; owner?: string }) {
  return {
    type: 'FungibleResource', divisibility: o.divisibility, total_supply: o.supply,
    role_assignments: { owner: { rule: { type: o.owner ?? 'DenyAll' }, updater: 'None' }, entries: Object.entries(o.roles).map(([n, r]) => entry(n, r)) },
  };
}
const LOCKED_BADGE_ROLES: Record<string, Rule> = {
  burner: 'DenyAll', minter: 'DenyAll', freezer: 'DenyAll', recaller: 'DenyAll', depositor: 'AllowAll', withdrawer: 'AllowAll',
  burner_updater: 'DenyAll', minter_updater: 'DenyAll', freezer_updater: 'DenyAll', recaller_updater: 'DenyAll', depositor_updater: 'DenyAll', withdrawer_updater: 'DenyAll',
};
const HUSDC_ROLES: Record<string, Rule> = { ...LOCKED_BADGE_ROLES, burner: 'Protected', minter: 'Protected' };

test('badgeProblems: the badge made on Stokenet passes; divisible, minted or recallable badges do not', () => {
  assert.deepEqual(badgeProblems(resource({ divisibility: 0, supply: '1', roles: LOCKED_BADGE_ROLES })), []);
  assert.deepEqual(badgeProblems(resource({ divisibility: 0, supply: '1', roles: {} })), [], 'no roles at all: the features do not exist');
  assert.match(badgeProblems(resource({ divisibility: 18, supply: '1', roles: LOCKED_BADGE_ROLES })).join(), /divisibility 18/);
  assert.match(badgeProblems(resource({ divisibility: 0, supply: '2', roles: LOCKED_BADGE_ROLES })).join(), /total supply 2/);
  assert.match(badgeProblems(resource({ divisibility: 0, supply: '1', roles: { ...LOCKED_BADGE_ROLES, minter_updater: 'Protected' } })).join(), /minter/);
  assert.match(badgeProblems(resource({ divisibility: 0, supply: '1', roles: { ...LOCKED_BADGE_ROLES, recaller: 'Protected' } })).join(), /recaller/);
  assert.match(badgeProblems({ type: 'NonFungibleResource' }).join(), /not a fungible/);
});

test('poolTokenProblems: hUSDC is accepted with an issuer warning; a recallable or freezable token is refused', () => {
  const h = poolTokenProblems(resource({ divisibility: 6, supply: '255481.948667', roles: HUSDC_ROLES }));
  assert.deepEqual(h.errors, []);
  assert.equal(h.warnings.length, 2);
  assert.match(h.warnings.join(), /minter is held/);
  assert.deepEqual(poolTokenProblems(resource({ divisibility: 18, supply: '1000', roles: LOCKED_BADGE_ROLES })), { errors: [], warnings: [] });
  assert.match(poolTokenProblems(resource({ divisibility: 6, supply: '1', roles: { ...HUSDC_ROLES, recaller: 'Protected' } })).errors.join(), /recaller/);
  assert.match(poolTokenProblems(resource({ divisibility: 6, supply: '1', roles: { ...HUSDC_ROLES, freezer_updater: 'Protected' } })).errors.join(), /freezer/);
  assert.match(poolTokenProblems(resource({ divisibility: 6, supply: '1', roles: { ...HUSDC_ROLES, withdrawer: 'Protected' } })).errors.join(), /withdrawer is Protected/);
  assert.match(poolTokenProblems(resource({ divisibility: 6, supply: '1', roles: { ...HUSDC_ROLES, depositor_updater: 'Protected' } })).errors.join(), /depositor_updater/);
  // A role that falls back to an owner who can do nothing (DenyAll) is as good as DenyAll.
  assert.deepEqual(poolTokenProblems(resource({ divisibility: 6, supply: '1', roles: { ...LOCKED_BADGE_ROLES, recaller: 'Owner', recaller_updater: 'Owner' } })).errors, []);
  assert.match(poolTokenProblems(resource({ divisibility: 6, supply: '1', owner: 'Protected', roles: { ...LOCKED_BADGE_ROLES, recaller: 'Owner', recaller_updater: 'Owner' } })).errors.join(), /recaller/);
});

test('badge, publish and instantiate chain through allocated addresses and compile (the mainnet "simulate" shape)', async () => {
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const codeHash = toHex(blake2b(wasm, { dkLen: 32 }));
  const m = [
    ownerPoolCreateBadgeManifest({ account: OWNER, name: 'DIFD pools owner badge', description: 'test', reservation: { resourcePackage: RESOURCE_PACKAGE, named: 'badge' } }),
    ownerPoolPublishManifest({ account: OWNER, definition: 'Tuple(Map<String, Tuple>())', codeHash, reservation: { packagePackage: PACKAGE_PACKAGE, named: 'pkg' } }),
    ownerPoolInstantiateManifest({ owner: { account: OWNER, badge: { named: 'badge' } }, package: { named: 'pkg' }, resourceA: XRD, resourceB: TEUR, amountA: '2', amountB: '0.0016', feeBps: 50 }),
  ].join('\n');
  assert.match(m, /ALLOCATE_GLOBAL_ADDRESS Address\("package_tdx_2_1pkgxxxxxxxxxresrce[^"]+"\) "FungibleResourceManager" AddressReservation\("badge_reservation"\) NamedAddress\("badge"\);/);
  assert.match(m, /Some\(AddressReservation\("badge_reservation"\)\);/);
  assert.match(m, /PUBLISH_PACKAGE_ADVANCED Enum<OwnerRole::None>\(\) .* Some\(AddressReservation\("pkg_reservation"\)\);/);
  assert.match(m, /CALL_FUNCTION NamedAddress\("pkg"\) "OwnerPool" "instantiate_with_liquidity" Bucket\("a"\) Bucket\("b"\) 50u16 NamedAddress\("badge"\);/);
  assert.doesNotMatch(m, /lock_fee/, 'wallet manifests carry no fee lock');
  await compiles(m, [wasm]);
  // The separate, signable versions compile too.
  await compiles(ownerPoolCreateBadgeManifest({ account: OWNER, name: 'x', description: 'y', feeLockXrd: '20' }));
  await compiles(ownerPoolPublishManifest({ account: OWNER, definition: 'Tuple(Map<String, Tuple>())', codeHash }), [wasm]);
  const inst = ownerPoolInstantiateManifest({ owner: { account: OWNER, badge: BADGE }, package: PACKAGE, resourceA: XRD, resourceB: TEUR, amountA: '2000', amountB: '1.6', feeBps: 50 });
  assert.equal((inst.match(/"withdraw"/g) ?? []).length, 2);
  assert.match(inst, /instantiate_with_liquidity/);
  assert.doesNotMatch(inst, /"instantiate" /, 'never the empty instantiate (pool audit F2)');
  await compiles(inst);
});

test('instantiate and badge builders refuse bad input', () => {
  const base = { owner: { account: OWNER, badge: BADGE }, package: PACKAGE, resourceA: XRD, resourceB: TEUR, amountA: '1', amountB: '1', feeBps: 50 };
  assert.throws(() => ownerPoolInstantiateManifest({ ...base, resourceB: XRD }), /must differ/);
  assert.throws(() => ownerPoolInstantiateManifest({ ...base, feeBps: 501 }), /Fee out of range/);
  assert.throws(() => ownerPoolInstantiateManifest({ ...base, amountB: '0' }), /positive/);
  assert.throws(() => ownerPoolCreateBadgeManifest({ account: OWNER, name: 'a"b', description: 'x' }), /Bad text/);
  assert.throws(() => ownerPoolPublishManifest({ account: OWNER, definition: 'x', codeHash: 'nothex' }), /Bad code hash/);
});

test('appoint: both badges proved, set_operator with the anchor, proofs dropped, badge and XRD to the operator account', async () => {
  const m = ownerPoolAppointManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, operatorBadge: OP_BADGE, anchor: ['1250', '1'], operatorAccount: OPERATOR, xrd: XRD, fundXrd: '20' });
  const lines = m.split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/create_proof_of_amount.*t4e0yq0/) < at(/"set_operator" Some\(Address\("resource_tdx_2_1tks7440/));
  assert.ok(at(/create_proof_of_amount.*tks7440/) < at(/"set_operator"/));
  assert.match(m, /"set_operator" Some\(Address\("[^"]+"\)\) Some\(Tuple\(Decimal\("1250"\), Decimal\("1"\)\)\);/);
  assert.ok(at(/"set_operator"/) < at(/DROP_AUTH_ZONE_REGULAR_PROOFS/) && at(/DROP_AUTH_ZONE_REGULAR_PROOFS/) < at(/"withdraw" Address\("resource_tdx_2_1tks7440/), 'a proof locks the badge: drop before withdrawing it');
  assert.match(lines.at(-1)!, new RegExp(`${OPERATOR}.*try_deposit_batch_or_abort`));
  assert.match(m, /"withdraw" Address\("resource_tdx_2_1tknxxxxxxxxxradxrd[^"]+"\) Decimal\("20"\)/);
  assert.doesNotMatch(m, /set_paused/);
  assert.match(ownerPoolAppointManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, operatorBadge: OP_BADGE, anchor: ['1', '1'], operatorAccount: OPERATOR, xrd: XRD, reopen: true }), /"set_paused" false;\nDROP_AUTH_ZONE_REGULAR_PROOFS/);
  assert.doesNotMatch(ownerPoolAppointManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, operatorBadge: OP_BADGE, anchor: ['1', '1'], operatorAccount: OPERATOR, xrd: XRD }), /radxrd[^"]*"\) Decimal/, 'no XRD without fundXrd');
  assert.throws(() => ownerPoolAppointManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, operatorBadge: BADGE, anchor: ['1', '1'], operatorAccount: OPERATOR, xrd: XRD }), /must not be the owner badge/);
  assert.throws(() => ownerPoolAppointManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, operatorBadge: OP_BADGE, anchor: ['1', '1'], operatorAccount: OWNER, xrd: XRD }), /must not be the owner account/);
  assert.throws(() => ownerPoolAppointManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, operatorBadge: OP_BADGE, anchor: ['0', '1'], operatorAccount: OPERATOR, xrd: XRD }), /Bad anchor/);
  await compiles(m);
});

const LIMITS: OwnerPoolOperatorLimits = { moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '2255', maxReserveB: '1.804', minReserveA: '1025', minReserveB: '0.82', minFeeBps: 50, maxFeeBps: 100 };

test('limits and fee in one transaction: one proof, limits first, the fee inside the new range', async () => {
  const m = ownerPoolLimitsAndFeeManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, limits: LIMITS, feeBps: 50 });
  assert.equal((m.match(/create_proof_of_amount/g) ?? []).length, 1);
  assert.ok(m.indexOf('"set_operator_limits" 300u16 72u64') < m.indexOf('"set_fee" 50u16'));
  assert.throws(() => ownerPoolLimitsAndFeeManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, limits: LIMITS, feeBps: 120 }), /outside the new operator range 50-100/);
  assert.match(ownerPoolLimitsAndFeeManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, limits: LIMITS, feeBps: 120, allowOutsideRange: true }), /"set_fee" 120u16/);
  const locked = ownerPoolLimitsAndFeeManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE }, limits: LIMITS, feeBps: 60, feeLockXrd: '20' });
  assert.equal((locked.match(/lock_fee/g) ?? []).length, 1, 'one fee lock');
  await compiles(m);
  await compiles(locked);
});

test('withdraw_all and the transfer back compile; the transfer skips zero amounts', async () => {
  const w = ownerPoolWithdrawAllManifest({ pool: POOL, owner: { account: OWNER, badge: BADGE } });
  assert.match(w, /"withdraw_all";\nCALL_METHOD Address\("account_tdx_2_129q4[^"]+"\) "deposit_batch"/);
  await compiles(w);
  const t = transferManifest({ from: OPERATOR, to: OWNER, items: [{ resource: OP_BADGE, amount: '1' }, { resource: XRD, amount: '0' }, { resource: XRD, amount: '20' }], feeLockXrd: '2' });
  assert.equal((t.match(/"withdraw"/g) ?? []).length, 2);
  assert.throws(() => transferManifest({ from: OPERATOR, to: OWNER, items: [{ resource: XRD, amount: '0' }] }), /Nothing to send/);
  await compiles(t);
});

test('proportionalB keeps the price (rounded down to B\'s places) and priceGap is symmetric', () => {
  assert.equal(proportionalB({ reserveA: '2100', reserveB: '1.68', divisibilityB: 6 }, '50'), '0.04');
  assert.equal(proportionalB({ reserveA: '3', reserveB: '1', divisibilityB: 6 }, '1'), '0.333333');
  assert.equal(priceGap(0.0008, 0.00085).toFixed(6), priceGap(0.00085, 0.0008).toFixed(6));
  assert.equal(priceGap(1, 1), 0);
  assert.equal(priceGap(0, 1), Infinity);
});

test('ownerPoolStepMismatches: empty when the ledger shows what the step set; names each difference', () => {
  const p: OwnerPoolState = {
    address: POOL, packageAddress: PACKAGE, resourceA: XRD, resourceB: TEUR, divisibilityA: 18, divisibilityB: 6, reserveA: '2050', reserveB: '1.64', feeBps: 50, paused: false,
    split: { ownerPaused: false, operatorPaused: false, inventoryA: '200', inventoryB: '0.16', ownerBadge: BADGE, operator: OP_BADGE, limits: LIMITS, allowance: '0', allowanceEpoch: 1, anchor: ['1250', '1'] },
  };
  assert.deepEqual(ownerPoolStepMismatches(p, { reserves: ['2050.0', '1.640'], inventory: ['200', '0.16'], feeBps: 50, ownerPaused: false, operator: OP_BADGE, anchor: ['1250', '1'], limits: LIMITS, ownerBadge: BADGE, resources: [XRD, TEUR] }), []);
  const bad = ownerPoolStepMismatches(p, { feeBps: 60, ownerPaused: true, operator: null, anchor: ['1', '1'], limits: { ...LIMITS, maxFeeBps: 150, minReserveB: '1' } });
  assert.equal(bad.length, 6);
  assert.match(bad.join('|'), /fee 50 bps, expected 60.*owner pause false.*operator resource.*anchor 1250:1.*maxFeeBps 100.*minReserveB 0.82/);
  assert.deepEqual(ownerPoolStepMismatches({ ...p, split: undefined }, {}), ['not a split OwnerPool']);
});
