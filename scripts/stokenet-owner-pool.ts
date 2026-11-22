// OwnerPool on Stokenet, with throwaway keys only. Preview by default; `--send` to act.
//
//   tsx scripts/stokenet-owner-pool.ts <step> [--send] [--data DIR]
//
// Steps (each skips what the state file says is already done):
//   setup     fund a NEW owner account from the faucet; create its owner badge (fungible, divisibility 0,
//             supply 1, no mint/burn/freeze/recall, locked roles) and a test token TEUR (divisibility 6,
//             fixed supply, same locked roles); publish scrypto/owner-pool as its own package; instantiate
//             one XRD/TEUR OwnerPool with liquidity at 0.0008 TEUR per XRD, fee 30 bps; give the test
//             user "alice" some TEUR.
//   exercise  on-ledger checks: owner deposit with matching and with mismatched `expected`, swaps by
//             alice in both directions asserting the exact quoted amount, set_fee, pause/unpause,
//             withdraw; plus preview-only refusals (non-owner deposit, fee above cap, swap while paused).
//   quotes    compare the ledger's `quote` (by preview) with the TypeScript copy, many sizes both ways.
//   gas       measure the preview fee of withdraw + swap_with_minimum + deposit_batch.
//   status    print the pool's state.
//
// Every transaction is previewed (exact notarised transaction, real signatures, no free credit) and
// only sent with --send when the preview did what was expected. Transactions meant to fail are sent
// only after their preview failed with the expected message.
//
// Keys: the owner key is NEW (DIR/stokenet-owner-pool-owner.key, mode 600, never printed), so the
// solver test account gains no tokens; alice's key comes from DIR/stokenet-keys.json, read the same
// way the other Stokenet scripts read it. Created addresses, transaction ids and measurements go to
// DIR/stokenet-owner-pool.json (no secrets). DIR defaults to data/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { ManifestSborStringRepresentation, RadixEngineToolkit } from '@steleaio/radix-engine-toolkit';
import {
  Decimal, Gateway, NETWORKS, accountOf, addr, buildTransaction, dec, fromAttos, keyFromHex, ownerPoolQuote, OwnerPoolQuoteError,
  ownerPoolSwapInstruction, readOwnerPools, submitAndWait, toAttos, toHex, type Ed25519Key, type OwnerPoolState,
} from '../packages/core/src/index.ts';

const args = process.argv.slice(2);
const step = args[0] ?? 'status';
const send = args.includes('--send');
const dataDir = (() => { const i = args.indexOf('--data'); return i >= 0 ? args[i + 1]! : 'data'; })();
const net = NETWORKS.stokenet;
const gw = new Gateway(net);
const XRD = net.xrd;

const STATE = `${dataDir}/stokenet-owner-pool.json`;
const KEY = `${dataDir}/stokenet-owner-pool-owner.key`;
const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
state.txids ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

let ownerKey: Ed25519Key;
if (existsSync(KEY)) ownerKey = keyFromHex(readFileSync(KEY, 'utf8').trim());
else if (send) {
  writeFileSync(KEY, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  console.log(`created a new owner key at ${KEY} (mode 600)`);
  ownerKey = keyFromHex(readFileSync(KEY, 'utf8').trim());
} else {
  // Dry run before the key exists: preview with a key that is thrown away, and save nothing.
  console.log(`(dry run) no owner key yet: previewing with a throwaway in-memory key; --send creates ${KEY}`);
  ownerKey = keyFromHex(randomBytes(32).toString('hex'));
}
const owner = await accountOf(ownerKey, net.networkId);
const keys = JSON.parse(readFileSync(`${dataDir}/stokenet-keys.json`, 'utf8'));
const aliceKey = keyFromHex(keys.alice);
const alice = await accountOf(aliceKey, net.networkId);
const faucet = (await RadixEngineToolkit.Utils.knownAddresses(net.networkId)).componentAddresses.faucet;
state.ownerAccount = owner;
state.aliceAccount = alice;

const lockFee = (account: string, amount = 20) => `CALL_METHOD ${addr(account)} "lock_fee" Decimal("${amount}");`;
const badgeProof = () => `CALL_METHOD ${addr(owner)} "create_proof_of_amount" ${addr(state.badge)} Decimal("1");`;

/** Preview the exact transaction; send it with --send. `fail`: the preview must fail with this message, and so must the commit. */
async function run(label: string, manifest: string, notary: Ed25519Key, o: { blobs?: Uint8Array[]; fail?: RegExp; previewOnly?: boolean } = {}) {
  const { epoch } = await gw.status();
  const tx = await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary, blobs: o.blobs });
  const pv = await gw.previewV2(tx.previewHex);
  console.log(`${label} preview: ${pv.status} (fee ${Number(pv.feeXrd).toFixed(4)} XRD)${pv.error ? ' ' + pv.error.slice(0, 240) : ''}`);
  if (o.fail ? pv.ok || !o.fail.test(pv.error ?? '') : !pv.ok) throw new Error(`${label}: preview did not do what was expected; nothing sent`);
  if (!send || o.previewOnly) return { txid: undefined as string | undefined, created: [] as string[], previewFee: pv.feeXrd };
  const out = await submitAndWait(gw, tx, 300_000);
  console.log(`${label}: ${out.status}${'error' in out ? ' ' + out.error.slice(0, 240) : ''}  ${tx.intentHashId}`);
  if (o.fail ? out.status !== 'CommittedFailure' : out.status !== 'CommittedSuccess') throw new Error(`${label}: unexpected outcome ${out.status}`);
  let created: string[] = [];
  if (!o.fail) {
    const j = await gw.post('/transaction/committed-details', { intent_hash: tx.intentHashId, opt_ins: { receipt_state_changes: true } });
    created = (j.transaction?.receipt?.state_updates?.new_global_entities ?? []).map((e: any) => String(e.entity_address));
  }
  return { txid: tx.intentHashId as string | undefined, created, previewFee: pv.feeXrd };
}
const record = (name: string, r: { txid?: string }) => { if (r.txid) { state.txids[name] = r.txid; save(); } };

async function pool(): Promise<OwnerPoolState> {
  // No package check here: this script made the pool and knows its address.
  return (await readOwnerPools(gw, [state.pool]))[0]!;
}
const show = (p: OwnerPoolState) => console.log(`pool ${p.address}: ${p.reserveA} ${p.resourceA === XRD ? 'XRD' : 'TEUR'} / ${p.reserveB} ${p.resourceB === XRD ? 'XRD' : 'TEUR'}, fee ${p.feeBps} bps, paused ${p.paused}, state version ${p.stateVersion}`);

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

// ====================================================================== setup
if (step === 'setup') {
  console.log(`owner account ${owner}`);
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
      `CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<OwnerRole::None>() true 0u8 Decimal("1") ${roles} ${md('radix-dex OwnerPool test owner badge', '', 'Stokenet test: owner badge of one OwnerPool. No value.')} None;`,
      `CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<OwnerRole::None>() true 6u8 Decimal("1000") ${roles} ${md('Test euro', 'TEUR', 'Stokenet test token for the OwnerPool test. No value.')} None;`,
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
    const wasm = new Uint8Array(readFileSync('data/contracts/owner_pool.wasm'));
    const rpd = new Uint8Array(readFileSync('data/contracts/owner_pool.rpd'));
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
      badgeProof(),
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
  show(await pool());
  console.log(JSON.stringify({ owner, badge: state.badge, teur: state.teur, package: state.package, pool: state.pool }, null, 2));
}

// ====================================================================== exercise
if (step === 'exercise') {
  if (!state.pool) throw new Error('run setup first');
  let p = await pool(); show(p);
  const aIsXrd = p.resourceA === XRD;
  if (!aIsXrd) throw new Error('expected XRD as resource A');
  const expected = (q: OwnerPoolState, bumpA = 0n) => `Some(Tuple(Decimal("${fromAttos(toAttos(q.reserveA) + bumpA)}"), Decimal("${q.reserveB}")))`;
  const deposit = (q: OwnerPoolState, bumpA = 0n) => [
    lockFee(owner), badgeProof(),
    `CALL_METHOD ${addr(owner)} "withdraw" ${addr(XRD)} Decimal("100");`,
    `CALL_METHOD ${addr(owner)} "withdraw" ${addr(state.teur)} Decimal("0.08");`,
    `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("a");`,
    `TAKE_ALL_FROM_WORKTOP ${addr(state.teur)} Bucket("b");`,
    `CALL_METHOD ${addr(state.pool)} "deposit" Some(Bucket("a")) Some(Bucket("b")) ${expected(q, bumpA)};`,
  ].join('\n');

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
  // The same swap asserting one unit more than the quote must fail.
  {
    const q = await pool();
    const want = ownerPoolQuote(q, XRD, '50');
    await run('swap asserting one TEUR unit above the quote (must fail)', [
      lockFee(alice),
      `CALL_METHOD ${addr(alice)} "withdraw" ${addr(XRD)} Decimal("50");`,
      `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("in");`,
      `CALL_METHOD ${addr(state.pool)} "swap" Bucket("in");`,
      `ASSERT_WORKTOP_CONTAINS ${addr(state.teur)} ${dec(new Decimal(want).plus('0.000001'))};`,
      `CALL_METHOD ${addr(alice)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    ].join('\n'), aliceKey, { fail: /Assert|WorktopError|InsufficientBalance|ResourceAssertion/i, previewOnly: true });
    await run('swap_with_minimum one TEUR unit above the quote (must fail)', [
      lockFee(alice),
      `CALL_METHOD ${addr(alice)} "withdraw" ${addr(XRD)} Decimal("50");`,
      `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("in");`,
      ownerPoolSwapInstruction(state.pool, 'in', new Decimal(want).plus('0.000001').toFixed()),
      `CALL_METHOD ${addr(alice)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
    ].join('\n'), aliceKey, { fail: /Less than the minimum/, previewOnly: true });
  }

  const setFee = (bps: number) => [lockFee(owner), badgeProof(), `CALL_METHOD ${addr(state.pool)} "set_fee" ${bps}u16;`].join('\n');
  await run('set_fee 501 (above the cap: must fail)', setFee(501), ownerKey, { fail: /Fee too high/, previewOnly: true });
  if (!state.txids.setFee50) record('setFee50', await run('set_fee 50', setFee(50), ownerKey));
  if (send) { p = await pool(); console.log(`  fee now ${p.feeBps} bps`); if (p.feeBps !== 50) throw new Error('fee not 50'); }
  if (!state.txids.setFee30) record('setFee30', await run('set_fee 30', setFee(30), ownerKey));

  const setPaused = (v: boolean) => [lockFee(owner), badgeProof(), `CALL_METHOD ${addr(state.pool)} "set_paused" ${v};`].join('\n');
  if (!state.txids.pause) {
    record('pause', await run('set_paused true', setPaused(true), ownerKey));
    if (send) {
      p = await pool();
      const lq = await ledgerQuote(XRD, '10'), tq = localQuote(p, XRD, '10');
      console.log(`  paused ${p.paused}; ledger quote: ${lq.ok ? lq.out : lq.error.slice(0, 120)}; local quote: ${tq.ok ? tq.out : tq.error}`);
      if (lq.ok || tq.ok || !/Swaps are paused/.test(lq.error) || tq.error !== 'Swaps are paused') throw new Error('pause not seen by both quotes');
      await run('swap while paused (must fail)', [
        lockFee(alice),
        `CALL_METHOD ${addr(alice)} "withdraw" ${addr(XRD)} Decimal("10");`,
        `TAKE_ALL_FROM_WORKTOP ${addr(XRD)} Bucket("in");`,
        `CALL_METHOD ${addr(state.pool)} "swap" Bucket("in");`,
        `CALL_METHOD ${addr(alice)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
      ].join('\n'), aliceKey, { fail: /Swaps are paused/, previewOnly: true });
    }
  }
  if (!state.txids.unpause) record('unpause', await run('set_paused false', setPaused(false), ownerKey));

  p = await pool();
  const withdraw = (q: OwnerPoolState, bumpA = 0n) => [
    lockFee(owner), badgeProof(),
    `CALL_METHOD ${addr(state.pool)} "withdraw" Decimal("100") Decimal("0.05") ${expected(q, bumpA)};`,
    `CALL_METHOD ${addr(owner)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
  await run('withdraw with expected XRD reserve one atto off (must fail)', withdraw(p, 1n), ownerKey, { fail: /Reserves moved/, previewOnly: true });
  if (!state.txids.withdraw) record('withdraw', await run('withdraw 100 XRD + 0.05 TEUR, expected = current reserves', withdraw(p), ownerKey));
  show(await pool());
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
  console.log(JSON.stringify({ owner, badge: state.badge, teur: state.teur, package: state.package, pool: state.pool, txids: state.txids }, null, 2));
}
