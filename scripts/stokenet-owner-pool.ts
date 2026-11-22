// OwnerPool (split: cold owner badge, hot operator badge) on Stokenet, with throwaway keys only.
// Preview by default; `--send` to act.
//
//   tsx scripts/stokenet-owner-pool.ts <step> [--send] [--data DIR]
//
// Steps (each skips what the state file says is already done):
//   setup     fund a NEW owner account from the faucet; create its owner badge (fungible, divisibility 0,
//             supply 1, no mint/burn/freeze/recall, locked roles) and a test token TEUR (divisibility 6,
//             fixed supply, same locked roles); publish scrypto/owner-pool (data/contracts/owner_pool.wasm)
//             as its own package; instantiate one XRD/TEUR OwnerPool with liquidity at 0.0008 TEUR per XRD,
//             fee 30 bps; give the test user "alice" some TEUR; put some inventory in the pool; create an
//             operator badge (same rules as the owner badge), set the suggested operator limits (300 bps per
//             72 epochs, caps = reserves +10%, floors = 50% of reserves, fee range 10-100 bps), appoint the
//             operator stating the anchor (1250 XRD : 1 TEUR, i.e. 0.0008 TEUR per XRD, the price the
//             curve was set at), and send the operator badge plus some XRD to a NEW operator account.
//   exercise  on-ledger checks of the owner calls: deposit with matching and with mismatched `expected`,
//             swaps by alice in both directions asserting the exact quoted amount, set_fee, pause/unpause,
//             withdraw; plus preview-only refusals (non-owner deposit, fee above cap, swap while paused).
//   operator  the operator's `rebalance`: one within its budget (planned with the TypeScript copy of the
//             budget arithmetic, whose cost must equal the ledger's event), one over its budget (refused:
//             "Operator price-move limit", sent after its preview failed so the refusal is on ledger), and
//             operator refusals by preview (owner calls with the operator badge).
//   revoke    the owner revokes the operator: the pool is then paused by the owner, the ledger's quote and
//             the TypeScript quote both say "Swaps are paused", the Quoter offers no route, and the old
//             operator badge can no longer rebalance.
//   restore   the owner creates a NEW operator badge, then in one transaction moves the operator's earlier
//             move back (`owner_rebalance`, guarded by the reserves seen), appoints the new badge with a
//             stated anchor and reopens swaps (`set_paused(false)`), and sends the new badge to the operator
//             account; the pool quotes again.
//   quotes    compare the ledger's `quote` (by preview) with the TypeScript copy, many sizes both ways.
//   gas       measure the preview fee of withdraw + swap_with_minimum + deposit_batch.
//   status    print the pool's state.
//
// Every manifest is built by code (packages/core/src/ownerpool-ops.ts for the pool calls) and previewed
// (exact notarised transaction, real signatures, no free credit); it is only sent with --send when the
// preview did what was expected. Transactions meant to fail are sent only after their preview failed
// with the expected message.
//
// Keys: the owner and operator keys are NEW (DIR/stokenet-owner-pool-owner.key and
// DIR/stokenet-owner-pool-operator.key, mode 600, never printed), so the solver test account gains no
// tokens; alice's key comes from DIR/stokenet-keys.json, read the same way the other Stokenet scripts
// read it. Created addresses, transaction ids and measurements go to DIR/stokenet-owner-pool.json (no
// secrets). DIR defaults to data/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { ManifestSborStringRepresentation, RadixEngineToolkit } from '@steleaio/radix-engine-toolkit';
import {
  Decimal, Gateway, NETWORKS, OwnerPoolQuoteError, Quoter, accountOf, addr, buildTransaction, dec, fromAttos, keyFromHex, ownerPoolAllowanceNow,
  ownerPoolAnchorDistance, ownerPoolDepositInventoryManifest, ownerPoolDepositManifest, ownerPoolOwnerRebalanceManifest, ownerPoolPlanRebalance,
  ownerPoolQuote, ownerPoolRebalanceManifest, ownerPoolSetFeeManifest, ownerPoolSetOperatorLimitsManifest, ownerPoolSetOperatorManifest,
  ownerPoolSetPausedManifest, ownerPoolSuggestedLimits, ownerPoolSwapInstruction, ownerPoolWithdrawManifest, readOwnerPools, submitAndWait, toAttos,
  toHex, type Ed25519Key, type OwnerPoolSigner, type OwnerPoolState, type Pool,
} from '../packages/core/src/index.ts';

const args = process.argv.slice(2);
const step = args[0] ?? 'status';
const send = args.includes('--send');
const dataDir = (() => { const i = args.indexOf('--data'); return i >= 0 ? args[i + 1]! : 'data'; })();
const net = NETWORKS.stokenet;
const gw = new Gateway(net);
const XRD = net.xrd;
/** The anchor stated for the test pair: 1 TEUR for 1250 XRD (0.0008 TEUR per XRD), the curve's starting price. */
const ANCHOR: [string, string] = ['1250', '1'];

const STATE = `${dataDir}/stokenet-owner-pool.json`;
const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
state.txids ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

/** A key file in DIR: read it, create it on --send, or use a throwaway in-memory key for a dry run. */
function keyFile(name: string): Ed25519Key {
  const path = `${dataDir}/${name}`;
  if (existsSync(path)) return keyFromHex(readFileSync(path, 'utf8').trim());
  if (send) {
    writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    console.log(`created a new key at ${path} (mode 600)`);
    return keyFromHex(readFileSync(path, 'utf8').trim());
  }
  console.log(`(dry run) no key at ${path} yet: previewing with a throwaway in-memory key; --send creates it`);
  return keyFromHex(randomBytes(32).toString('hex'));
}
const ownerKey = keyFile('stokenet-owner-pool-owner.key');
const operatorKey = keyFile('stokenet-owner-pool-operator.key');
const owner = await accountOf(ownerKey, net.networkId);
const operator = await accountOf(operatorKey, net.networkId);
const keys = JSON.parse(readFileSync(`${dataDir}/stokenet-keys.json`, 'utf8'));
const aliceKey = keyFromHex(keys.alice);
const alice = await accountOf(aliceKey, net.networkId);
const faucet = (await RadixEngineToolkit.Utils.knownAddresses(net.networkId)).componentAddresses.faucet;
state.ownerAccount = owner;
state.operatorAccount = operator;
state.aliceAccount = alice;

const lockFee = (account: string, amount = 20) => `CALL_METHOD ${addr(account)} "lock_fee" Decimal("${amount}");`;
const ownerSigner = (): OwnerPoolSigner => ({ account: owner, badge: state.badge });
const operatorSigner = (badge = state.operatorBadge): OwnerPoolSigner => ({ account: operator, badge });

type RunResult = { txid: string | undefined; created: string[]; previewFee: string; events: any[] };
/** Preview the exact transaction; send it with --send. `fail`: the preview must fail with this message, and so must the commit. */
async function run(label: string, manifest: string, notary: Ed25519Key, o: { blobs?: Uint8Array[]; fail?: RegExp; previewOnly?: boolean } = {}): Promise<RunResult> {
  const { epoch } = await gw.status();
  const tx = await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary, blobs: o.blobs });
  const pv = await gw.previewV2(tx.previewHex);
  console.log(`${label} preview: ${pv.status} (fee ${Number(pv.feeXrd).toFixed(4)} XRD)${pv.error ? ' ' + pv.error.slice(0, 240) : ''}`);
  if (o.fail ? pv.ok || !o.fail.test(pv.error ?? '') : !pv.ok) throw new Error(`${label}: preview did not do what was expected; nothing sent`);
  if (!send || o.previewOnly) return { txid: undefined, created: [], previewFee: pv.feeXrd, events: [] };
  const out = await submitAndWait(gw, tx, 300_000);
  console.log(`${label}: ${out.status}${'error' in out ? ' ' + out.error.slice(0, 240) : ''}  ${tx.intentHashId}`);
  if (o.fail ? out.status !== 'CommittedFailure' : out.status !== 'CommittedSuccess') throw new Error(`${label}: unexpected outcome ${out.status}`);
  let created: string[] = [], events: any[] = [];
  if (!o.fail) {
    const j = await gw.post('/transaction/committed-details', { intent_hash: tx.intentHashId, opt_ins: { receipt_state_changes: true, receipt_events: true } });
    created = (j.transaction?.receipt?.state_updates?.new_global_entities ?? []).map((e: any) => String(e.entity_address));
    events = j.transaction?.receipt?.events ?? [];
  }
  return { txid: tx.intentHashId as string | undefined, created, previewFee: pv.feeXrd, events };
}
const record = (name: string, r: { txid?: string }) => { if (r.txid) { state.txids[name] = r.txid; save(); } };

async function pool(): Promise<OwnerPoolState> {
  // No package check here: this script made the pool and knows its address.
  return (await readOwnerPools(gw, [state.pool]))[0]!;
}
const show = (p: OwnerPoolState) => console.log(`pool ${p.address}: reserves ${p.reserveA} XRD / ${p.reserveB} TEUR, fee ${p.feeBps} bps, paused ${p.paused}` +
  (p.split ? ` (owner ${p.split.ownerPaused}, operator ${p.split.operatorPaused}), inventory ${p.split.inventoryA} XRD / ${p.split.inventoryB} TEUR, operator ${p.split.operator ?? 'none'}, anchor ${p.split.anchor.join(':')}` : '') +
  `, state version ${p.stateVersion}`);
const reservesOf = (p: OwnerPoolState): [string, string] => [p.reserveA, p.reserveB];

/** The ledger's own `quote`, by preview: the decimal it returns, or the error it fails with. */
async function ledgerQuote(input: string, amount: string): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const { epoch } = await gw.status();
  const res = await gw.preview(`CALL_METHOD ${addr(state.pool)} "quote" ${addr(input)} Decimal("${amount}");`, epoch);
  if (!res.ok) return { ok: false, error: res.error ?? '' };
  const out = res.raw?.receipt?.output?.[0]?.programmatic_json;
  if (out?.kind !== 'Decimal' || typeof out.value !== 'string') throw new Error('Unexpected quote output: ' + JSON.stringify(res.raw?.receipt?.output).slice(0, 300));
  return { ok: true, out: out.value };
}
const localQuote = (p: OwnerPoolState, input: string, amount: string): { ok: true; out: string } | { ok: false; error: string } => {
  try { return { ok: true, out: ownerPoolQuote(p, input, amount) }; } catch (e) { if (e instanceof OwnerPoolQuoteError) return { ok: false, error: e.message }; throw e; }
};
/** The ledger's `operator_status`, by preview: (badge, limits, allowance now, operator pause, anchor). */
async function ledgerOperatorStatus(): Promise<{ allowance: string; operator: string | null; epoch: number }> {
  const { epoch } = await gw.status();
  const res = await gw.preview(`CALL_METHOD ${addr(state.pool)} "operator_status";`, epoch);
  if (!res.ok) throw new Error('operator_status failed: ' + res.error);
  const f = res.raw?.receipt?.output?.[0]?.programmatic_json?.fields;
  // Preview output carries no variant names: Option's Some is variant 1.
  return { operator: String(f?.[0]?.variant_id) === '1' ? f[0].fields[0].value : null, allowance: String(f?.[2]?.value), epoch };
}
/** A Quoter that reads this pool as any listed OwnerPool would be read (allow-listed package only). */
const quoterRoute = async (sell: string, amount: string) => {
  const p = await pool();
  const listed: Pool = { venue: 'ownerpool', address: state.pool, kind: 'owner', tokens: [p.resourceA, p.resourceB], feeRate: p.feeBps / 10_000, tvlUsd: 0, volume24hUsd: 0, reserves: [0, 0] };
  const q = new Quoter(gw);
  const best = await q.best([listed], sell, sell === XRD ? state.teur : XRD, amount, XRD);
  return { best, failure: q.lastFailure };
};

/** Create one 0-place, supply-1 badge (no roles, locked metadata) into the owner's account; returns its address. */
async function createBadge(label: string, name: string): Promise<string | undefined> {
  const roles = 'Tuple(None, None, None, None, None, None)';
  const md = `Tuple(Map<String, Tuple>("name" => Tuple(Some(Enum<Metadata::String>("${name}")), true), ` +
    `"description" => Tuple(Some(Enum<Metadata::String>("Stokenet test: operator (hot) badge of one OwnerPool. No value.")), true)), Map<String, Enum>())`;
  const r = await run(label, [
    lockFee(owner),
    `CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<OwnerRole::None>() true 0u8 Decimal("1") ${roles} ${md} None;`,
    `CALL_METHOD ${addr(owner)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n'), ownerKey);
  if (!send) return undefined;
  record(label, r);
  const created = r.created.filter((a) => a.startsWith('resource_'));
  if (created.length !== 1) throw new Error('expected one new resource: ' + created.join(', '));
  return created[0];
}

// ====================================================================== setup
if (step === 'setup') {
  console.log(`owner account ${owner}\noperator account ${operator}`);
  const lots = 3;
  for (let i = state.faucetLots ?? 0; i < lots; i++) {
    const r = await run(`faucet ${i + 1}/${lots} to the owner`, [
      `CALL_METHOD ${addr(faucet)} "lock_fee" Decimal("10");`,
      `CALL_METHOD ${addr(faucet)} "free";`,
      `CALL_METHOD ${addr(owner)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    ].join('\n'), ownerKey);
    if (!send) { console.log('(dry run: stopping at the first step that later steps depend on)'); process.exit(0); }
    record(`faucet${i + 1}`, r); state.faucetLots = i + 1; save();
  }
  if (!state.badge || !state.teur) {
    // Owner role None and no mint/burn/freeze/recall roles: those features do not exist on the resource at all.
    // Withdraw/deposit default to AllowAll with a DenyAll updater (radix-engine-interface resource/mod.rs).
    // Metadata is set and locked at creation; with no owner, nobody can change it.
    const md = (name: string, symbol: string, description: string) => `Tuple(Map<String, Tuple>(` +
      `"name" => Tuple(Some(Enum<Metadata::String>("${name}")), true), ` +
      (symbol ? `"symbol" => Tuple(Some(Enum<Metadata::String>("${symbol}")), true), ` : '') +
      `"description" => Tuple(Some(Enum<Metadata::String>("${description}")), true)` +
      `), Map<String, Enum>())`;
    const roles = 'Tuple(None, None, None, None, None, None)';
    const r = await run('create owner badge and TEUR', [
      lockFee(owner),
      `CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<OwnerRole::None>() true 0u8 Decimal("1") ${roles} ${md('radix-dex OwnerPool test owner badge', '', 'Stokenet test: owner (cold) badge of one split OwnerPool. No value.')} None;`,
      `CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<OwnerRole::None>() true 6u8 Decimal("1000") ${roles} ${md('Test euro', 'TEUR', 'Stokenet test token for the split OwnerPool test. No value.')} None;`,
      `CALL_METHOD ${addr(owner)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    ].join('\n'), ownerKey);
    if (!send) process.exit(0);
    record('createTokens', r);
    const resources = r.created.filter((a) => a.startsWith('resource_'));
    const details = await gw.entityDetails(resources);
    state.badge = details.find((d) => d.details?.divisibility === 0)?.address;
    state.teur = details.find((d) => d.details?.divisibility === 6)?.address;
    if (!state.badge || !state.teur) throw new Error('could not tell the two new resources apart: ' + resources.join(', '));
    save();
  }
  if (!state.aliceTeur) {
    const r = await run('give alice 3 TEUR', [
      lockFee(owner),
      `CALL_METHOD ${addr(owner)} "withdraw" ${addr(state.teur)} Decimal("3");`,
      `CALL_METHOD ${addr(alice)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;`,
    ].join('\n'), ownerKey);
    if (!send) process.exit(0);
    record('fundAlice', r); state.aliceTeur = '3'; save();
  }
  if (!state.package) {
    const wasm = new Uint8Array(readFileSync(`${dataDir}/contracts/owner_pool.wasm`));
    const rpd = new Uint8Array(readFileSync(`${dataDir}/contracts/owner_pool.rpd`));
    const definition = await RadixEngineToolkit.ManifestSbor.decodeToString(rpd, net.networkId, ManifestSborStringRepresentation.ManifestString);
    const codeHash = toHex(blake2b(wasm, { dkLen: 32 }));
    state.codeHashBlake2b = codeHash;
    const r = await run('publish OwnerPool package', [
      lockFee(owner, 500),
      `PUBLISH_PACKAGE_ADVANCED Enum<OwnerRole::None>() ${definition} Blob("${codeHash}") Map<String, Tuple>() None;`,
    ].join('\n'), ownerKey, { blobs: [wasm] });
    if (!send) process.exit(0);
    record('publish', r);
    state.package = r.created.find((a) => a.startsWith('package_'));
    if (!state.package) throw new Error('no package address in the receipt');
    save();
  }
  if (!state.pool) {
    // 20,000 XRD and 16 TEUR: 0.0008 TEUR per XRD, about where XRD trades in euros. Fee 30 bps.
    const r = await run('instantiate OwnerPool with liquidity', [
      lockFee(owner),
      `CALL_METHOD ${addr(owner)} "create_proof_of_amount" ${addr(state.badge)} Decimal("1");`,
      `CALL_METHOD ${addr(owner)} "withdraw" ${addr(XRD)} Decimal("20000");`,
      `CALL_METHOD ${addr(owner)} "withdraw" ${addr(state.teur)} Decimal("16");`,
      `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("a");`,
      `TAKE_ALL_FROM_WORKTOP ${addr(state.teur)} Bucket("b");`,
      `CALL_FUNCTION ${addr(state.package)} "OwnerPool" "instantiate_with_liquidity" Bucket("a") Bucket("b") 30u16 ${addr(state.badge)};`,
    ].join('\n'), ownerKey);
    if (!send) process.exit(0);
    record('instantiate', r);
    state.pool = r.created.find((a) => a.startsWith('component_'));
    if (!state.pool) throw new Error('no component address in the receipt');
    save();
  }
  if (!state.txids.depositInventory) {
    // Inventory the operator can move into the reserves; it must never show up in the reserves or a quote.
    record('depositInventory', await run('deposit 1000 XRD + 0.8 TEUR into the inventory', ownerPoolDepositInventoryManifest({
      pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', resourceA: XRD, resourceB: state.teur, amountA: '1000', amountB: '0.8',
    }), ownerKey));
  }
  if (!state.operatorBadge) {
    state.operatorBadge = await createBadge('createOperatorBadge', 'radix-dex OwnerPool test operator badge');
    if (!send) process.exit(0);
    save();
  }
  if (!state.limits) {
    const p = await pool();
    const limits = ownerPoolSuggestedLimits(p);
    record('setOperatorLimits', await run('set_operator_limits (suggested defaults)', ownerPoolSetOperatorLimitsManifest({ pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', limits }), ownerKey));
    if (!send) process.exit(0);
    state.limits = limits; save();
  }
  if (!state.txids.appointOperator) {
    const p = await pool();
    console.log(`  anchor ${ANCHOR.join(':')} is ${(ownerPoolAnchorDistance(p, ANCHOR) * 100).toFixed(3)}% from the curve's price`);
    // The operator badge is still in the owner's account: both badges proved in one transaction.
    await run('set_operator without an anchor (must fail)', ownerPoolSetOperatorManifest({ pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', operator: { account: owner, badge: state.operatorBadge }, anchor: ['1', '1'] })
      .replace(/Some\(Tuple\(Decimal\("1"\), Decimal\("1"\)\)\);$/, 'None;'), ownerKey, { fail: /State the anchor price/, previewOnly: true });
    record('appointOperator', await run('set_operator (appoint, anchor 1250:1)', ownerPoolSetOperatorManifest({
      pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', operator: { account: owner, badge: state.operatorBadge }, anchor: ANCHOR,
    }), ownerKey));
    if (!send) process.exit(0);
  }
  if (!state.txids.fundOperator) {
    record('fundOperator', await run('send the operator badge and 200 XRD to the operator account', [
      lockFee(owner),
      `CALL_METHOD ${addr(owner)} "withdraw" ${addr(state.operatorBadge)} Decimal("1");`,
      `CALL_METHOD ${addr(owner)} "withdraw" ${addr(XRD)} Decimal("200");`,
      `CALL_METHOD ${addr(operator)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;`,
    ].join('\n'), ownerKey));
  }
  const p = await pool(); show(p);
  if (send && (p.split?.operator !== state.operatorBadge || p.paused)) throw new Error('operator not appointed, or the pool is paused');
  console.log(JSON.stringify({ owner, operator, badge: state.badge, operatorBadge: state.operatorBadge, teur: state.teur, package: state.package, pool: state.pool }, null, 2));
}

// ====================================================================== exercise
if (step === 'exercise') {
  if (!state.pool) throw new Error('run setup first');
  let p = await pool(); show(p);
  if (p.resourceA !== XRD) throw new Error('expected XRD as resource A');
  const bump = (q: OwnerPoolState, bumpA = 0n): [string, string] => [fromAttos(toAttos(q.reserveA) + bumpA), q.reserveB];
  const deposit = (q: OwnerPoolState, bumpA = 0n) => ownerPoolDepositManifest({
    pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', resourceA: XRD, resourceB: state.teur, amountA: '100', amountB: '0.08', expected: bump(q, bumpA),
  });

  if (!state.txids.depositMatching) record('depositMatching', await run('deposit 100 XRD + 0.08 TEUR, expected = current reserves', deposit(p), ownerKey));
  p = await pool(); show(p);
  if (!state.txids.depositMismatched) record('depositMismatched', await run('deposit with expected XRD reserve one atto off (must fail)', deposit(p, 1n), ownerKey, { fail: /Reserves moved/ }));
  await run('alice deposits (not the owner: must be refused)', [
    lockFee(alice),
    `CALL_METHOD ${addr(alice)} "withdraw" ${addr(XRD)} Decimal("1");`,
    `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("a");`,
    `CALL_METHOD ${addr(state.pool)} "deposit" Some(Bucket("a")) None None;`,
  ].join('\n'), aliceKey, { fail: /Unauthorized|AssertAccessRuleFailed|auth/i, previewOnly: true });

  // Swaps by alice, each asserting exactly the amount the TypeScript quote says.
  const swap = async (name: string, sell: string, amount: string, buy: string) => {
    const q = await pool();
    const want = ownerPoolQuote(q, sell, amount);
    const ledger = await ledgerQuote(sell, amount);
    console.log(`  ${name}: local quote ${want}, ledger quote ${ledger.ok ? ledger.out : 'FAILED ' + ledger.error}`);
    if (!ledger.ok || ledger.out !== want) throw new Error('quote mismatch');
    const r = await run(name, [
      lockFee(alice),
      `CALL_METHOD ${addr(alice)} "withdraw" ${addr(sell)} Decimal("${amount}");`,
      `TAKE_ALL_FROM_WORKTOP ${addr(sell)} Bucket("in");`,
      `CALL_METHOD ${addr(state.pool)} "swap" Bucket("in");`,
      `ASSERT_WORKTOP_CONTAINS ${addr(buy)} ${dec(want)};`,
      `CALL_METHOD ${addr(alice)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    ].join('\n'), aliceKey);
    state.swaps ??= {}; state.swaps[name] = { sell: amount, quoted: want }; record(name, r);
  };
  if (!state.txids.swapXrdForTeur) await swap('swapXrdForTeur', XRD, '50', state.teur);
  if (!state.txids.swapTeurForXrd) await swap('swapTeurForXrd', state.teur, '0.02', XRD);
  {
    const q = await pool();
    const want = ownerPoolQuote(q, XRD, '50');
    await run('swap_with_minimum one TEUR unit above the quote (must fail)', [
      lockFee(alice),
      `CALL_METHOD ${addr(alice)} "withdraw" ${addr(XRD)} Decimal("50");`,
      `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("in");`,
      ownerPoolSwapInstruction(state.pool, 'in', new Decimal(want).plus('0.000001').toFixed()),
      `CALL_METHOD ${addr(alice)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    ].join('\n'), aliceKey, { fail: /Less than the minimum/, previewOnly: true });
  }

  const setFee = (bps: number) => ownerPoolSetFeeManifest({ pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', feeBps: bps });
  await run('set_fee 501 (above the cap: must fail)', setFee(500).replace('500u16', '501u16'), ownerKey, { fail: /Fee too high/, previewOnly: true });
  if (!state.txids.setFee50) record('setFee50', await run('set_fee 50', setFee(50), ownerKey));
  if (send) { p = await pool(); console.log(`  fee now ${p.feeBps} bps`); if (p.feeBps !== 50) throw new Error('fee not 50'); }
  if (!state.txids.setFee30) record('setFee30', await run('set_fee 30', setFee(30), ownerKey));

  const setPaused = (v: boolean) => ownerPoolSetPausedManifest({ pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', paused: v });
  if (!state.txids.pause) {
    record('pause', await run('set_paused true', setPaused(true), ownerKey));
    if (send) {
      p = await pool();
      const lq = await ledgerQuote(XRD, '10'), tq = localQuote(p, XRD, '10');
      console.log(`  paused ${p.paused}; ledger quote: ${lq.ok ? lq.out : lq.error.slice(0, 120)}; local quote: ${tq.ok ? tq.out : tq.error}`);
      if (lq.ok || tq.ok || !/Swaps are paused/.test(lq.error) || tq.error !== 'Swaps are paused') throw new Error('pause not seen by both quotes');
    }
  }
  if (!state.txids.unpause) record('unpause', await run('set_paused false', setPaused(false), ownerKey));

  p = await pool();
  const withdraw = (q: OwnerPoolState, bumpA = 0n) => ownerPoolWithdrawManifest({ pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', amountA: '100', amountB: '0.05', expected: bump(q, bumpA) });
  await run('withdraw with expected XRD reserve one atto off (must fail)', withdraw(p, 1n), ownerKey, { fail: /Reserves moved/, previewOnly: true });
  if (!state.txids.withdraw) record('withdraw', await run('withdraw 100 XRD + 0.05 TEUR, expected = current reserves', withdraw(p), ownerKey));
  show(await pool());
}

// ====================================================================== operator
if (step === 'operator') {
  if (!state.txids.appointOperator || !state.txids.fundOperator) throw new Error('run setup first');
  let p = await pool(); show(p);
  const st = await ledgerOperatorStatus();
  const local = ownerPoolAllowanceNow(p, st.epoch);
  console.log(`  epoch ${st.epoch}: allowance on ledger ${st.allowance}, TypeScript ${local}`);
  if (st.allowance !== local) throw new Error('allowance mismatch');

  if (!state.txids.operatorRebalance) {
    // Largest one-sided removal (reserves -> inventory) the budget allows now, either side: a removal
    // costs only its price move (no depth growth). Planned with the TypeScript copy; waits for refill.
    let plan: { da: string; db: string; cost: string; anchor: [string, string] } | undefined;
    for (let tries = 0; !plan; tries++) {
      const { epoch } = await gw.status();
      p = await pool();
      for (const f of ['0.002', '0.001', '0.0005', '0.0002', '0.0001']) {
        for (const side of ['a', 'b'] as const) {
          const amt = new Decimal(side === 'a' ? p.reserveA : p.reserveB).mul(f).toDecimalPlaces(side === 'a' ? p.divisibilityA : p.divisibilityB, Decimal.ROUND_DOWN).neg().toFixed();
          const [da, db] = side === 'a' ? [amt, '0'] : ['0', amt];
          try { const r = ownerPoolPlanRebalance(p, da, db, epoch); plan = { da, db, cost: r.cost, anchor: r.anchor }; break; } catch (e) { if (!(e instanceof OwnerPoolQuoteError)) throw e; }
        }
        if (plan) break;
      }
      if (!plan) {
        if (tries > 40) throw new Error('no removal fits the budget');
        console.log(`  epoch ${epoch}: allowance ${ownerPoolAllowanceNow(p, epoch)} too small for the smallest move; waiting 60 s`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
    console.log(`  planned: rebalance(${plan.da}, ${plan.db}) costs ${plan.cost}`);
    const r = await run('operator rebalance within budget', ownerPoolRebalanceManifest({
      pool: state.pool, operator: operatorSigner(), feeLockXrd: '10', toReserveA: plan.da, toReserveB: plan.db, expected: reservesOf(p),
    }), operatorKey);
    if (send) {
      record('operatorRebalance', r);
      const ev = r.events.find((e: any) => e.name === 'OwnerPoolRebalanceEvent');
      const field = (n: string) => ev?.data?.fields?.find((x: any) => x.field_name === n)?.value;
      console.log(`  event: cost ${field('cost')}, allowance after ${field('allowance')}, by_owner ${field('by_owner')}`);
      if (field('cost') !== plan.cost) throw new Error(`ledger cost ${field('cost')} != planned ${plan.cost}`);
      state.operatorMove = { toReserveA: plan.da, toReserveB: plan.db, cost: plan.cost, ledgerCost: field('cost'), allowanceAfter: field('allowance') };
      save();
      p = await pool(); show(p);
      if (p.split!.anchor[0] !== plan.anchor[0] || p.split!.anchor[1] !== plan.anchor[1]) throw new Error('anchor did not follow the move');
    }
  }

  // Over budget: a 5% one-sided removal of XRD (well above the floor) costs ~5%, more than the whole 3% budget.
  if (!state.txids.operatorOverBudget) {
    const { epoch } = await gw.status();
    p = await pool();
    const da = new Decimal(p.reserveA).mul('0.05').toDecimalPlaces(18, Decimal.ROUND_DOWN).neg().toFixed();
    try { ownerPoolPlanRebalance(p, da, '0', epoch); throw new Error('planned to fit'); } catch (e) { if (!(e instanceof OwnerPoolQuoteError) || e.message !== 'Operator price-move limit') throw e; console.log(`  TypeScript plan of rebalance(${da}, 0): ${e.message}`); }
    record('operatorOverBudget', await run('operator rebalance over budget (must fail)', ownerPoolRebalanceManifest({
      pool: state.pool, operator: operatorSigner(), feeLockXrd: '10', toReserveA: da, toReserveB: '0', expected: reservesOf(p),
    }), operatorKey, { fail: /Operator price-move limit/ }));
  }
  // Caps and floors, by preview: raising XRD above its cap, lowering it below its floor.
  {
    const { epoch } = await gw.status();
    p = await pool();
    const up = new Decimal(state.limits.maxReserveA).minus(p.reserveA).plus(1).toFixed();
    const down = new Decimal(state.limits.minReserveA).minus(p.reserveA).minus(1).toFixed();
    for (const [label, da, msg] of [['above the cap', up, /Above the operator's reserve cap/], ['below the floor', down, /Below the operator's reserve floor/]] as const) {
      let localMsg = '';
      try { ownerPoolPlanRebalance(p, da, '0', epoch); } catch (e) { localMsg = (e as Error).message; }
      if (!msg.test(localMsg)) throw new Error(`TypeScript plan ${label}: ${localMsg}`);
      await run(`operator rebalance ${label} (must fail)`, ownerPoolRebalanceManifest({ pool: state.pool, operator: operatorSigner(), feeLockXrd: '10', toReserveA: da, toReserveB: '0' }), operatorKey, { fail: msg, previewOnly: true });
    }
  }
  // The operator badge cannot do owner things (preview only).
  await run('operator badge calls withdraw (must be refused)', ownerPoolWithdrawManifest({ pool: state.pool, owner: operatorSigner(), feeLockXrd: '10', amountA: '1', amountB: '0', to: operator }),
    operatorKey, { fail: /Unauthorized|AssertAccessRuleFailed|auth/i, previewOnly: true });
  await run('operator badge calls set_paused(false) (must be refused)', ownerPoolSetPausedManifest({ pool: state.pool, owner: operatorSigner(), feeLockXrd: '10', paused: false }),
    operatorKey, { fail: /Unauthorized|AssertAccessRuleFailed|auth/i, previewOnly: true });
  show(await pool());
}

// ====================================================================== revoke
if (step === 'revoke') {
  if (!state.txids.operatorRebalance) throw new Error('run operator first');
  if (!state.txids.revokeOperator) {
    record('revokeOperator', await run('set_operator(None, None): revoke', ownerPoolSetOperatorManifest({ pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', operator: null }), ownerKey));
  }
  if (send) {
    const p = await pool(); show(p);
    const lq = await ledgerQuote(XRD, '10'), tq = localQuote(p, XRD, '10');
    const { best, failure } = await quoterRoute(XRD, '10');
    console.log(`  owner pause ${p.split!.ownerPaused}, operator ${p.split!.operator}; ledger quote: ${lq.ok ? lq.out : lq.error.slice(-60)}; local: ${tq.ok ? tq.out : tq.error}; Quoter: ${best ? 'route ' + best.buyAmount : 'no route (' + failure + ')'}`);
    if (!p.split!.ownerPaused || p.split!.operator !== null || lq.ok || tq.ok || !/Swaps are paused/.test(lq.error) || best) throw new Error('revoke did not leave the pool paused and unoffered');
    state.revokeCheck = { ownerPaused: true, ledgerQuote: lq.error.slice(-80), localQuote: tq.error, quoterRoute: null, quoterFailure: failure };
    save();
    await run('old operator badge rebalances after the revoke (must be refused)', ownerPoolRebalanceManifest({ pool: state.pool, operator: operatorSigner(), feeLockXrd: '10', toReserveA: '-1', toReserveB: '0' }),
      operatorKey, { fail: /Unauthorized|AssertAccessRuleFailed|auth/i, previewOnly: true });
  }
}

// ====================================================================== restore
if (step === 'restore') {
  if (!state.txids.revokeOperator) throw new Error('run revoke first');
  if (!state.operatorBadge2) {
    state.operatorBadge2 = await createBadge('createOperatorBadge2', 'radix-dex OwnerPool test operator badge 2');
    if (!send) process.exit(0);
    save();
  }
  if (!state.txids.restore) {
    const p = await pool(); show(p);
    // Undo the operator's move (the emergency procedure's step 2), guarded by the reserves seen.
    const back = state.operatorMove as { toReserveA: string; toReserveB: string };
    const neg = (v: string) => new Decimal(v).neg().toFixed();
    const manifest = [
      ownerPoolOwnerRebalanceManifest({ pool: state.pool, owner: ownerSigner(), feeLockXrd: '20', toReserveA: neg(back.toReserveA), toReserveB: neg(back.toReserveB), expected: reservesOf(p) }),
      // Steps 3-4: appoint the NEW badge with an anchor stated from the market, and reopen.
      ownerPoolSetOperatorManifest({ pool: state.pool, owner: ownerSigner(), operator: { account: owner, badge: state.operatorBadge2 }, anchor: ANCHOR, reopen: true }),
      // Hand the new badge to the bot's account (badge proofs dropped first: a proof locks the badge in its vault; the signature proof stays).
      'DROP_AUTH_ZONE_REGULAR_PROOFS;',
      `CALL_METHOD ${addr(owner)} "withdraw" ${addr(state.operatorBadge2)} Decimal("1");`,
      `CALL_METHOD ${addr(operator)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;`,
    ].join('\n');
    record('restore', await run('owner_rebalance back + set_operator(new badge, anchor) + set_paused(false) + badge to the operator', manifest, ownerKey));
  }
  if (send) {
    const p = await pool(); show(p);
    const lq = await ledgerQuote(XRD, '10'), tq = localQuote(p, XRD, '10');
    const { best } = await quoterRoute(XRD, '10');
    console.log(`  ledger quote ${lq.ok ? lq.out : lq.error}; local ${tq.ok ? tq.out : tq.error}; Quoter route ${best?.buyAmount ?? 'none'}`);
    if (p.paused || p.split!.operator !== state.operatorBadge2 || !lq.ok || !tq.ok || lq.out !== tq.out || best?.buyAmount !== tq.out) throw new Error('not restored');
    const st = await ledgerOperatorStatus();
    console.log(`  new operator ${st.operator}, allowance ${st.allowance} (zero at appointment, refilling)`);
    await run('the first operator badge rebalances after the restore (must be refused)', ownerPoolRebalanceManifest({ pool: state.pool, operator: operatorSigner(), feeLockXrd: '10', toReserveA: '-1', toReserveB: '0' }),
      operatorKey, { fail: /Unauthorized|AssertAccessRuleFailed|auth/i, previewOnly: true });
    state.restoreCheck = { paused: p.paused, operator: p.split!.operator, ledgerQuote10Xrd: lq.out, quoterRoute: best?.buyAmount };
    save();
  }
}

// ====================================================================== quotes
if (step === 'quotes') {
  const p = await pool(); show(p);
  const xrdSizes = ['0.000000000000000001', '0.001', '1', '7.123456789012345678', '50', '333.33', '1000', '2500.5', '6000', '19000'];
  const teurSizes = ['0.000001', '0.000123', '0.01', '0.05', '0.123456', '1', '3.3', '8', '15'];
  const odd = [[state.teur, '0.0000001'], [state.teur, '1.0000005'], [XRD, '0'], [state.badge, '1']] as const;
  const rows: any[] = [];
  let agree = 0, differ = 0;
  for (const [res, amount] of [...xrdSizes.map((a) => [XRD, a] as const), ...teurSizes.map((a) => [state.teur, a] as const), ...odd]) {
    const [l, t] = [await ledgerQuote(res, amount), localQuote(p, res, amount)];
    // Failures agree when both fail; the ledger's message wraps the panic text, so compare by containment.
    const same = l.ok && t.ok ? l.out === t.out : !l.ok && !t.ok ? l.error.includes(t.error) : false;
    if (same) agree++; else differ++;
    const name = res === XRD ? 'XRD' : res === state.teur ? 'TEUR' : 'badge';
    console.log(`${same ? 'SAME' : 'DIFF'}  ${amount} ${name} -> ledger ${l.ok ? l.out : 'fails: ' + l.error.slice(-80)} | local ${t.ok ? t.out : 'fails: ' + t.error}`);
    rows.push({ sell: name, amount, ledger: l.ok ? l.out : 'fails: ' + l.error.slice(-120), local: t.ok ? t.out : 'fails: ' + t.error, same });
  }
  // A state version read after the previews: if it moved, someone traded meanwhile and the comparison is void.
  const after = await pool();
  const stable = after.reserveA === p.reserveA && after.reserveB === p.reserveB && after.feeBps === p.feeBps && after.paused === p.paused;
  console.log(`${agree} agree, ${differ} differ; pool unchanged during the run: ${stable}`);
  state.quoteCheck = { at: new Date().toISOString(), stateVersion: p.stateVersion, reserves: [p.reserveA, p.reserveB], feeBps: p.feeBps, agree, differ, stable, rows };
  save();
  if (differ || !stable) process.exitCode = 1;
}

// ====================================================================== gas
if (step === 'gas') {
  const p = await pool(); show(p);
  const fees: { sell: string; amount: string; feeXrd: string }[] = [];
  const { epoch } = await gw.status();
  for (const [res, amount] of [[XRD, '0.01'], [XRD, '1'], [XRD, '50'], [XRD, '500'], [XRD, '2000'], [XRD, '6000'], [state.teur, '0.000123'], [state.teur, '0.01'], [state.teur, '0.5'], [state.teur, '2']] as const) {
    const out = ownerPoolQuote(p, res, amount);
    // The shape Quoter.simulate previews for other venues: a holder withdraws, swaps, deposits everything back.
    const r = await gw.preview([
      `CALL_METHOD ${addr(alice)} "withdraw" ${addr(res)} Decimal("${amount}");`,
      `TAKE_ALL_FROM_WORKTOP ${addr(res)} Bucket("in0");`,
      ownerPoolSwapInstruction(state.pool, 'in0', out),
      `CALL_METHOD ${addr(alice)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    ].join('\n'), epoch);
    if (!r.ok) throw new Error(`gas preview failed: ${r.error}`);
    const name = res === XRD ? 'XRD' : 'TEUR';
    console.log(`  sell ${amount} ${name}: fee ${r.feeXrd} XRD`);
    fees.push({ sell: name, amount, feeXrd: r.feeXrd });
  }
  // For comparison, the same shape through the existing XRD/TUSD test Pool (preview only: nothing changes).
  const ref = await gw.preview([
    `CALL_METHOD ${addr(alice)} "withdraw" ${addr(XRD)} Decimal("50");`,
    `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("in0");`,
    `CALL_METHOD ${addr(keys.pool)} "swap" Bucket("in0");`,
    `CALL_METHOD ${addr(alice)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n'), epoch);
  console.log(`  reference, existing radixdex Pool, sell 50 XRD: ${ref.ok ? ref.feeXrd + ' XRD' : 'failed ' + ref.error}`);
  const vals = fees.map((f) => Number(f.feeXrd));
  state.gas = { at: new Date().toISOString(), shape: 'withdraw + swap_with_minimum + deposit_batch, V1 preview with free credit', min: Math.min(...vals), max: Math.max(...vals), samples: fees, referenceRadixdexPool: ref.ok ? ref.feeXrd : null };
  save();
  console.log(`min ${Math.min(...vals)} max ${Math.max(...vals)} XRD`);
}

if (step === 'status') {
  if (state.pool) show(await pool());
  console.log(JSON.stringify({ owner, operator, badge: state.badge, operatorBadge: state.operatorBadge, operatorBadge2: state.operatorBadge2, teur: state.teur, package: state.package, pool: state.pool, txids: state.txids }, null, 2));
}
