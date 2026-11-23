// The owner's own split OwnerPools ("DIFD pools") on MAINNET: every owner transaction, built by code,
// PREVIEWED against mainnet, saved for the owner to sign in his own Radix Wallet. NOTHING IS SENT TO
// MAINNET BY THIS SCRIPT: there is no code path that submits a mainnet transaction (`--send` with
// `--network mainnet` is refused before anything else runs). Runbook: docs/MAINNET-POOLS.md.
//
//   tsx scripts/mainnet-owner-pool.ts <step> [options]                     mainnet (default): write + preview
//   tsx scripts/mainnet-owner-pool.ts <step> --network stokenet [--send]   the same builders on Stokenet,
//                                                                         signed with the throwaway test keys
//
// Each step writes data/mainnet-pool/<network>/<pool>/<NN>-<step>.rtm (the manifest to sign: no lock_fee
// on mainnet, the wallet adds its own) and <NN>-<step>.json (what the preview showed), prints both, and
// records what the ledger must show afterwards. After the owner signs it on mainnet:
//   tsx scripts/mainnet-owner-pool.ts record <txid>      reads the transaction, records what it created,
//                                                       and checks the pool against what the step set.
// Sign at https://console.radixdlt.com/transaction-manifest with the owner account connected.
//
// Steps (owner = cold badge; nothing here holds or needs the owner's key on mainnet):
//   check                        files, hashes, balances, the tokens' and badges' roles, the market price
//   simulate [--a --b]           ONE mainnet preview of badge + publish + instantiate (allocated addresses):
//                                proves the three builders against mainnet before anything exists
//   badge [--use <resource>]     create the pool owner badge (cold), or adopt an existing one that passes the rules
//   publish [--reuse <package>]  publish data/contracts/owner_pool.* (or adopt an existing package); prints the cost
//   instantiate --a <A> --b <B> [--fee 50] [--market-price p] [--max-gap 0.01] [--force]
//                                create AND fund the pool in one transaction (pool audit F2), price checked
//                                against the market first
//   pause | unpause              the owner's pause (set_paused)
//   inventory --a <A> --b <B>    deposit_inventory (not traded; the operator moves it within its limits)
//   deposit --a <A> --b <B>      deposit into the reserves, guarded by the reserves read now, curve checked against the market
//   withdraw --a <A> [--b <B>]   withdraw from the reserves (B defaults to the proportional amount), guarded
//   withdraw-inventory --a --b   withdraw from the inventory
//   owner-rebalance --a <±A> --b <±B>   inventory <-> reserves with no limits (emergency: restore the curve), guarded
//   operator-badge [--replace]   create the operator (hot) badge into the owner's account (--replace: a new one after a revoke)
//   limits [k=v ...]             set_operator_limits: suggested defaults (budget 300 bps per --window epochs,
//                                caps +10%, floors 50%, fee range --min-fee..--max-fee), any field overridable
//   limits-fee --fee <bps> [k=v ...]   limits AND fee in ONE transaction (a lower max fee does not clamp the fee)
//   appoint --anchor A:B|market [--operator-account <acct>] [--fund 20] [--reopen]
//                                set_operator (stated anchor) + the operator badge and XRD to the operator account
//   anchor --anchor A:B|market   set_anchor, guarded by the reserves read now (zeroes the operator's allowance)
//   fee --fee <bps>              set_fee
//   revoke                       set_operator(None, None): the old badge loses every right, the owner's pause goes on
//   unwind                       withdraw_all: reserves and inventory back to the owner
//   operator-return [--xrd <n>]  (operator key) the operator account's XRD (and on Stokenet, --badges, its badge) back to the owner:
//                                previewed only on mainnet; sent with --send on Stokenet
//   operator-key --create        MAINNET: create the operator's hot key (data/mainnet-owner-pool-operator.key,
//                                mode 600) and print its account. Only with the owner's approval.
//   status                       state, the pool on ledger, the operator's allowance now
//   record <txid> [--step <step>]  (mainnet) after the owner signed a staged step (--step when several are pending)
//
// Options: --name <pool> (default xrd-husdc on mainnet, teur-dry on Stokenet) --pair xrd-husdc|xrd-lsulp
//   --b-resource <resource> (another pair: token B; A is always XRD) --owner <account> (mainnet; default the
//   owner account) --window <epochs> (144) --min-fee <bps> (50) --max-fee <bps> (150) --dir <dir> (data/mainnet-pool)
//
// Keys: on Stokenet the throwaway keys data/stokenet-owner-pool-owner.key and -operator.key (they must
// exist; never created here) are read and never printed. On mainnet no key is read at all, except by
// `operator-key --create`, which writes a new one and never prints it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { ManifestSborStringRepresentation, RadixEngineToolkit } from '@steleaio/radix-engine-toolkit';
import {
  Decimal, Gateway, NETWORKS, OWNER_POOL_BOT_DEFAULTS as BD, OWNER_POOL_PACKAGES, accountOf, aggregateVenues, badgeProblems, buildTransaction, keyFromHex,
  ownerPoolAllowanceNow, ownerPoolAnchorDistance, ownerPoolAppointManifest, ownerPoolCreateBadgeManifest, ownerPoolDepositInventoryManifest, ownerPoolDepositManifest,
  ownerPoolInstantiateManifest, ownerPoolLimitsAndFeeManifest, ownerPoolOwnerRebalanceManifest, ownerPoolPublishManifest, ownerPoolSetAnchorManifest, ownerPoolSetFeeManifest,
  ownerPoolSetOperatorLimitsManifest, ownerPoolSetOperatorManifest, ownerPoolSetPausedManifest, ownerPoolStepMismatches, ownerPoolSuggestedLimits,
  ownerPoolWithdrawAllManifest, ownerPoolWithdrawInventoryManifest, ownerPoolWithdrawManifest, poolTokenProblems, priceGap, proportionalB, readOwnerPools,
  submitAndWait, toHex, transferManifest, type Ed25519Key, type NetworkName, type OwnerPoolOperatorLimits, type OwnerPoolState,
} from '../packages/core/src/index.ts';
import { VENUE_NAMES, makeVenues, readVenueSource } from './owner-pool-sources.ts';

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const step = argv[0] ?? 'status';
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n: string) => argv.includes(`--${n}`);
const NETWORK = (opt('network') ?? 'mainnet') as NetworkName;
if (!NETWORKS[NETWORK]) throw new Error(`Unknown network ${NETWORK}`);
const SEND = flag('send');
// HARD GUARD: this script never submits a mainnet transaction. The owner signs every one in his wallet.
if (NETWORK === 'mainnet' && SEND) {
  console.error('REFUSED: --send is never allowed on mainnet. The owner signs mainnet transactions in his own wallet.');
  process.exit(2);
}
const net = NETWORKS[NETWORK];
const gw = new Gateway(net);
const mainnetGw = NETWORK === 'mainnet' ? gw : new Gateway(NETWORKS.mainnet);
const XRD = net.xrd;
const DIR = opt('dir') ?? 'data/mainnet-pool';

/** The owner account (mainnet) given for this work. */
const MAINNET_OWNER = 'account_rdx12xknv0yply6fhvega00ke3x8mymq7lu6va8uw8dl0trsvcg85f6mnz';
const MAINNET = {
  hUSDC: 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv',
  LSULP: 'resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf',
  /** The Radix DEX order book's owner badge (mainnet-setup.ts): a candidate to adopt, but see the runbook. */
  dexOwnerBadge: 'resource_rdx1t4jaj92lfw8faxntgeqaxvp47gjkn09m6l49yl9xwg8vujqzj8kkzq',
};
/** The build proven on Stokenet (scrypto/owner-pool at 934c904; docs/review-2026-11-21/owner-pool-split-stokenet.md). */
const EXPECTED = {
  wasmSha256: '16aed69ed2bad9bcb70ccde0dfdd22cd596d2655d003456cfa8f4d6cf6acb0dd',
  rpdSha256: 'd84ab4b6e1caa39f299e225c9ea22f40f64f171bac21e4dc7c567e67ef54b8d5',
  codeHashBlake2b: '0b460d5f3ba527f36ce3efa316de4200774e227b778f98efb4a3c058446a7872',
};
const WASM = 'data/contracts/owner_pool.wasm', RPD = 'data/contracts/owner_pool.rpd';

// ------------------------------------------------------------------ state (no secrets)
interface PoolRecord {
  pool?: string; resourceA: string; resourceB: string; seed?: [string, string]; feeBps?: number;
  operatorBadge?: string; operatorAccount?: string; txids: Record<string, string>;
}
interface Pending { step: string; name: string; want: Record<string, unknown>; file: string; at: string }
interface State {
  owner?: string; poolBadge?: string; package?: string; operatorAccount?: string;
  pools: Record<string, PoolRecord>;
  /** Staged steps waiting for their transaction, by `<pool>:<step>` (`_setup:badge`, `_setup:publish`). */
  pending: Record<string, Pending>;
  txids: Record<string, string>;
}
const STATE_PATH = `${DIR}/${NETWORK}.json`;
mkdirSync(DIR, { recursive: true });
const state: State = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : { pools: {}, txids: {}, pending: {} };
state.pools ??= {}; state.txids ??= {};
if (!state.pending || 'step' in (state.pending as object)) state.pending = {};
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

// ------------------------------------------------------------------ accounts and keys
/** Stokenet only: the existing throwaway keys. Never created here, never printed. */
function stokenetKey(file: string): Ed25519Key {
  const path = `data/${file}`;
  if (!existsSync(path)) throw new Error(`${path} is missing: run scripts/stokenet-owner-pool.ts setup first (Stokenet only)`);
  return keyFromHex(readFileSync(path, 'utf8').trim());
}
const ownerKey = NETWORK === 'stokenet' ? stokenetKey('stokenet-owner-pool-owner.key') : undefined;
const operatorKey = NETWORK === 'stokenet' ? stokenetKey('stokenet-owner-pool-operator.key') : undefined;
const OWNER = NETWORK === 'stokenet' ? await accountOf(ownerKey!, net.networkId) : (opt('owner') ?? state.owner ?? MAINNET_OWNER);
const STOKENET_OPERATOR = operatorKey ? await accountOf(operatorKey, net.networkId) : undefined;
if (NETWORK === 'mainnet' && !OWNER.startsWith('account_rdx1')) throw new Error('The owner must be a mainnet account');
state.owner = OWNER;
/** Wallet manifests carry no fee lock (the wallet adds it); Stokenet ones lock from the signer. */
const FEE_LOCK = NETWORK === 'stokenet' ? '20' : undefined;

// ------------------------------------------------------------------ the pool being set up
const stokenetTest = NETWORK === 'stokenet' && existsSync('data/stokenet-owner-pool.json') ? JSON.parse(readFileSync('data/stokenet-owner-pool.json', 'utf8')) : {};
const NAME = opt('name') ?? (NETWORK === 'mainnet' ? opt('pair') ?? 'xrd-husdc' : 'teur-dry');
function pairResources(): [string, string] {
  const b = opt('b-resource');
  if (b) return [XRD, b];
  const pair = opt('pair') ?? (NETWORK === 'mainnet' ? NAME : 'xrd-teur');
  if (NETWORK === 'mainnet' && pair === 'xrd-husdc') return [XRD, MAINNET.hUSDC];
  if (NETWORK === 'mainnet' && pair === 'xrd-lsulp') return [XRD, MAINNET.LSULP];
  if (NETWORK === 'stokenet' && pair === 'xrd-teur' && stokenetTest.teur) return [XRD, stokenetTest.teur];
  throw new Error(`Unknown pair ${pair} on ${NETWORK}: give --pair xrd-husdc|xrd-lsulp or --b-resource <resource>`);
}
const rec = (): PoolRecord => {
  if (!state.pools[NAME]) { const [a, b] = pairResources(); state.pools[NAME] = { resourceA: a, resourceB: b, txids: {} }; }
  return state.pools[NAME]!;
};
const symbols = (): Record<string, string> => ({
  [XRD]: 'XRD', [MAINNET.hUSDC]: 'hUSDC', [MAINNET.LSULP]: 'LSULP', ...(stokenetTest.teur ? { [stokenetTest.teur]: 'TEUR' } : {}),
  ...(state.poolBadge ? { [state.poolBadge]: 'POOL OWNER BADGE' } : {}),
  ...Object.fromEntries(Object.entries(state.pools).filter(([, p]) => p.operatorBadge).map(([n, p]) => [p.operatorBadge!, `OPERATOR BADGE (${n})`])),
});
const sym = (r: string) => symbols()[r] ?? r;
const short = (a: string) => (a.length > 30 ? `${a.slice(0, 18)}…${a.slice(-6)}` : a);

async function pool(): Promise<OwnerPoolState> {
  const r = rec();
  if (!r.pool) throw new Error(`No pool recorded for "${NAME}": run instantiate first`);
  const allowed = state.package ? [state.package] : OWNER_POOL_PACKAGES[NETWORK];
  return (await readOwnerPools(gw, [r.pool], allowed))[0]!;
}
const owner = () => { if (!state.poolBadge) throw new Error('No pool owner badge recorded: run badge first'); return { account: OWNER, badge: state.poolBadge }; };
const showPool = (p: OwnerPoolState) => console.log(
  `pool ${p.address}\n  reserves ${p.reserveA} ${sym(p.resourceA)} / ${p.reserveB} ${sym(p.resourceB)} (price ${new Decimal(p.reserveB).div(p.reserveA).toPrecision(8)} ${sym(p.resourceB)} per ${sym(p.resourceA)}), fee ${p.feeBps} bps` +
  (p.split ? `\n  inventory ${p.split.inventoryA} / ${p.split.inventoryB}; owner pause ${p.split.ownerPaused}, operator pause ${p.split.operatorPaused}; operator ${p.split.operator ?? 'none'}; anchor ${p.split.anchor.join(':')}` +
    `\n  limits ${JSON.stringify(p.split.limits)}` : ''));

// ------------------------------------------------------------------ market price (token B per XRD)
async function marketPrice(): Promise<{ price: number; source: string } | undefined> {
  const given = opt('market-price');
  if (given !== undefined) { const v = Number(given); if (!(v > 0)) throw new Error('--market-price must be positive'); return { price: v, source: 'given by --market-price' }; }
  const b = rec().resourceB;
  if (b !== MAINNET.hUSDC) return undefined;
  const venues = makeVenues(VENUE_NAMES, mainnetGw, { sizeXrd: BD.quoteSizeXrd, smallFraction: BD.smallQuoteFraction });
  const quotes = await Promise.all(venues.map(readVenueSource));
  const ref = aggregateVenues(quotes, Date.now(), { minVenues: 1, maxAgeMs: BD.maxSourceAgeSec * 1000, maxDisagreement: BD.maxDisagreement, maxRoundTrip: BD.maxRoundTrip, minImpactBps: BD.minImpactBps, maxVenueFee: BD.maxVenueFee });
  const used = ref.venues.filter((v) => v.used).map((v) => `${v.venue} ${v.mid?.toPrecision(6)}`).join(', ');
  if (ref.status !== 'ok') { console.log(`  market reference: ${ref.status} (${ref.reason})`); return undefined; }
  return { price: ref.price, source: `on-ledger venues, the bot's rules: ${used}` };
}
/** Refuse when `price` (B per A) is further than --max-gap from the market, unless --force. */
async function checkAgainstMarket(what: string, price: number): Promise<void> {
  const m = await marketPrice();
  const maxGap = Number(opt('max-gap') ?? '0.01');
  if (!m) {
    if (flag('force')) { console.log(`  WARNING: no market price for this pair; ${what} not checked (--force)`); return; }
    throw new Error(`No market price for this pair: give --market-price <${sym(rec().resourceB)} per XRD> (or --force)`);
  }
  const gap = priceGap(price, m.price);
  console.log(`  ${what}: ${price.toPrecision(8)}; market ${m.price.toPrecision(8)} (${m.source}); gap ${(gap * 100).toFixed(3)}% (limit ${(maxGap * 100).toFixed(2)}%)`);
  if (gap > maxGap && !flag('force')) throw new Error(`${what} is ${(gap * 100).toFixed(2)}% from the market: refused (--max-gap, or --force)`);
}

// ------------------------------------------------------------------ preview, write, (Stokenet) send
interface Preview { ok: boolean; error?: string; feeXrd: string; changes: { entity: string; resource: string; amount: string }[] }
async function previewV1(manifest: string, blobs: Uint8Array[] = []): Promise<Preview> {
  const { epoch } = await gw.status();
  const j = await gw.post('/transaction/preview', {
    manifest, blobs_hex: blobs.map(toHex), start_epoch_inclusive: epoch, end_epoch_exclusive: epoch + 10, tip_percentage: 0,
    nonce: Math.floor(Math.random() * 2 ** 31), signer_public_keys: [],
    flags: { use_free_credit: true, assume_all_signature_proofs: true, skip_epoch_check: true },
  });
  const receipt = j?.receipt;
  if (!receipt) throw new Error('Preview response has no receipt');
  const fs = receipt.fee_summary ?? {};
  const fee = ['xrd_total_execution_cost', 'xrd_total_finalization_cost', 'xrd_total_royalty_cost', 'xrd_total_storage_cost', 'xrd_total_tipping_cost'].reduce((a, k) => a + Number(fs[k] ?? 0), 0);
  const changes: Preview['changes'] = [];
  for (const g of j.resource_changes ?? []) for (const c of g.resource_changes ?? []) changes.push({ entity: String(c.component_entity?.entity_address), resource: String(c.resource_address), amount: String(c.amount) });
  const ok = receipt.status === 'Succeeded';
  return { ok, error: ok ? undefined : String(receipt.error_message ?? receipt.status), feeXrd: fee.toFixed(6), changes };
}

function nextFile(stepName: string): string {
  const dir = `${DIR}/${NETWORK}/${['badge', 'publish', 'simulate', 'operator-key'].includes(stepName) ? '_setup' : NAME}`;
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => f.endsWith('.rtm')).length + 1;
  return `${dir}/${String(n).padStart(2, '0')}-${stepName}`;
}

/** What the wallet will show: every account's withdrawals and deposits, and the badges proved. */
function describe(manifest: string, pv: Preview): string[] {
  const out: string[] = [];
  const proofs = [...manifest.matchAll(/CALL_METHOD Address\("([^"]+)"\) "create_proof_of_amount" (?:Address|NamedAddress)\("([^"]+)"\)/g)];
  for (const [, acct, badge] of proofs) out.push(`  presents a proof of ${sym(badge!)} (${short(badge!)}) from ${acct === OWNER ? 'the OWNER account' : acct}`);
  const byEntity = new Map<string, string[]>();
  for (const c of pv.changes) {
    const who = c.entity === OWNER ? 'OWNER account' : c.entity === rec().pool ? 'the pool' : c.entity;
    byEntity.set(who, [...(byEntity.get(who) ?? []), `${Number(c.amount) > 0 ? '+' : ''}${c.amount} ${sym(c.resource)}`]);
  }
  for (const [who, list] of byEntity) out.push(`  ${who}: ${list.join(', ')}`);
  // The Gateway's preview summary does not always list deposits into another account: say it from the manifest.
  for (const [, to] of manifest.matchAll(/CALL_METHOD Address\("([^"]+)"\) "try_deposit_batch_or_abort"/g)) {
    if (!pv.changes.some((c) => c.entity === to)) out.push(`  ${to === OWNER ? 'OWNER account' : to}: receives everything withdrawn above (try_deposit_batch_or_abort)`);
  }
  return out;
}

type Signer = 'owner' | 'operator';
interface StageResult { ok: boolean; txid?: string; created: string[] }
/**
 * Write the manifest, preview it on this network, print what the signer will be asked to approve.
 * Mainnet: stop there (the owner signs; `record <txid>` follows). Stokenet: also preview the exact
 * notarised transaction and, with --send, submit it and run the step's record + checks.
 */
async function stage(stepName: string, manifest: string, o: { signer?: Signer; blobs?: Uint8Array[]; want?: Record<string, unknown>; note?: string; standIn?: string; expectFail?: RegExp } = {}): Promise<StageResult> {
  const signer = o.signer ?? 'owner';
  const file = nextFile(stepName);
  writeFileSync(`${file}.rtm`, manifest + '\n');
  const pv = await previewV1(manifest, o.blobs);
  const lines = [
    `===== ${stepName} (${NETWORK}${NETWORK === 'mainnet' ? ', NOT SENT: for the owner to sign' : ''}) =====`,
    `manifest: ${file}.rtm${o.blobs?.length ? ` (+ ${o.blobs.length} blob, ${o.blobs.reduce((a, b) => a + b.length, 0)} bytes)` : ''}`,
    ...(o.note ? [o.note] : []),
    ...(o.standIn ? [`PREVIEW USED A STAND-IN: ${o.standIn}. Do NOT sign this file; run the step again with the real value.`] : []),
    '', manifest, '',
    `preview on ${NETWORK}: ${pv.ok ? 'SUCCEEDS' : 'FAILS: ' + pv.error?.slice(0, 400)}; network fee about ${Number(pv.feeXrd).toFixed(4)} XRD${NETWORK === 'mainnet' ? ' (the wallet adds its fee lock)' : ''}`,
    'the signer will be asked to approve:', ...describe(manifest, pv),
  ];
  console.log(lines.join('\n'));
  const record = { step: stepName, network: NETWORK, pool: NAME, at: new Date().toISOString(), signer, manifestFile: `${file}.rtm`, standIn: o.standIn ?? null, preview: pv, want: o.want ?? {} };
  writeFileSync(`${file}.json`, JSON.stringify(record, null, 2) + '\n');
  if (o.expectFail) {
    if (pv.ok || !o.expectFail.test(pv.error ?? '')) throw new Error(`${stepName}: expected the preview to fail with ${o.expectFail}`);
    return { ok: false, created: [] };
  }
  if (!pv.ok) { process.exitCode = 1; return { ok: false, created: [] }; }
  if (o.standIn) return { ok: true, created: [] };
  const key = pendingKey(stepName);
  state.pending[key] = { step: stepName, name: NAME, want: o.want ?? {}, file: `${file}.rtm`, at: record.at };
  save();
  if (NETWORK === 'mainnet') {
    const where = o.blobs?.length ? `publish ${WASM} + ${RPD} at https://console.radixdlt.com/deploy-package (owner role "None")` : `sign ${file}.rtm at https://console.radixdlt.com/transaction-manifest`;
    console.log(`\nTo do: ${where} (${signer === 'owner' ? 'owner account ' + short(OWNER) : 'the OPERATOR key: see the runbook'}), then:\n  tsx scripts/mainnet-owner-pool.ts record <txid> --step ${stepName}${NAME !== 'xrd-husdc' && !SETUP_STEPS.includes(stepName) ? ' --name ' + NAME : ''}`);
    return { ok: true, created: [] };
  }
  // Stokenet: the exact transaction, signed by the throwaway key, previewed again without free credit.
  const signingKey = signer === 'owner' ? ownerKey! : operatorKey!;
  const { epoch } = await gw.status();
  const tx = await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary: signingKey, blobs: o.blobs });
  const v2 = await gw.previewV2(tx.previewHex);
  console.log(`exact preview (notarised, real signature, no free credit): ${v2.status} (fee ${Number(v2.feeXrd).toFixed(4)} XRD)${v2.error ? ' ' + v2.error.slice(0, 300) : ''}`);
  if (!v2.ok) throw new Error(`${stepName}: exact preview failed; nothing sent`);
  if (!SEND) { console.log('(Stokenet dry run: not sent; --send to send)'); return { ok: true, created: [] }; }
  const out = await submitAndWait(gw, tx, 300_000);
  console.log(`sent: ${out.status}  ${tx.intentHashId}`);
  if (out.status !== 'CommittedSuccess') throw new Error(`${stepName}: ${out.status} ${'error' in out ? out.error : ''}`);
  return { ok: true, txid: tx.intentHashId, created: await afterCommit(tx.intentHashId, key) };
}

// ------------------------------------------------------------------ after a commit: record and check
async function created(txid: string): Promise<string[]> {
  const j = await gw.post('/transaction/committed-details', { intent_hash: txid, opt_ins: { receipt_state_changes: true } });
  if (j.transaction?.transaction_status !== 'CommittedSuccess') throw new Error(`That transaction did not succeed: ${j.transaction?.transaction_status}`);
  return (j.transaction?.receipt?.state_updates?.new_global_entities ?? []).map((e: any) => String(e.entity_address));
}
const SETUP_STEPS = ['badge', 'publish'];
const pendingKey = (stepName: string) => `${SETUP_STEPS.includes(stepName) ? '_setup' : NAME}:${stepName}`;
async function afterCommit(txid: string, key: string): Promise<string[]> {
  const pend = state.pending[key];
  if (!pend) throw new Error(`Nothing pending under ${key}`);
  const r = state.pools[pend.name];
  const made = await created(txid);
  const one = (prefix: string) => {
    const list = made.filter((a) => a.startsWith(prefix));
    if (list.length !== 1) throw new Error(`expected one new ${prefix}… entity, got: ${made.join(', ') || 'none'}`);
    return list[0]!;
  };
  if (pend.step === 'badge') { state.poolBadge = one('resource_'); await checkBadge('pool owner badge', state.poolBadge); }
  else if (pend.step === 'publish') state.package = one('package_');
  else if (pend.step === 'operator-badge') { r!.operatorBadge = one('resource_'); await checkBadge('operator badge', r!.operatorBadge); }
  else if (pend.step === 'instantiate') r!.pool = one('component_');
  if (pend.step === 'appoint' && pend.want.operatorAccount) r!.operatorAccount = String(pend.want.operatorAccount);
  (r ?? state).txids[pend.step] = txid;
  if (r && !['badge', 'publish'].includes(pend.step)) state.txids[`${pend.name}:${pend.step}`] = txid;
  delete state.pending[key];
  save();
  console.log(`recorded ${pend.step}: ${txid}${made.length ? ' created ' + made.join(', ') : ''}`);
  if (r?.pool && !['badge', 'publish', 'operator-badge', 'operator-return'].includes(pend.step)) {
    const p = await pool();
    showPool(p);
    const want = { ...pend.want } as any;
    delete want.operatorAccount;
    const bad = ownerPoolStepMismatches(p, want);
    if (bad.length) { console.log(`CHECK FAILED after ${pend.step}:\n  ${bad.join('\n  ')}\n(reserves can also differ because a swap landed after the transaction: look at the pool's history)`); process.exitCode = 1; }
    else console.log(`check after ${pend.step}: the ledger shows what the step set (${Object.keys(want).join(', ') || 'nothing to compare'})`);
  }
  return made;
}
async function checkBadge(what: string, resource: string) {
  const [d] = await gw.entityDetails([resource]);
  const problems = badgeProblems(d?.details);
  console.log(`  ${what} ${resource}: ${problems.length ? 'PROBLEMS: ' + problems.join('; ') : 'divisibility 0, supply 1, nobody can mint, freeze or recall it'}`);
  if (problems.length) process.exitCode = 1;
}

// ------------------------------------------------------------------ helpers for the steps
const amountArg = (n: string, required = true): string | undefined => {
  const v = opt(n);
  if (v === undefined) { if (required) throw new Error(`--${n} <amount> is required`); return undefined; }
  if (!(new Decimal(v).gte(0))) throw new Error(`--${n} must be a non-negative amount`);
  return new Decimal(v).toFixed();
};
const plus = (a: string, b: string) => new Decimal(a).plus(b).toFixed();
const minus = (a: string, b: string) => new Decimal(a).minus(b).toFixed();
async function anchorArg(): Promise<[string, string]> {
  const v = opt('anchor');
  if (!v) throw new Error('--anchor A:B is required ("B of token B for A of token A", from the MARKET), or --anchor market');
  if (v === 'market') {
    const m = await marketPrice();
    if (!m) throw new Error('No market price for this pair: state the anchor as A:B');
    const b = new Decimal(m.price).toDecimalPlaces(12, Decimal.ROUND_HALF_EVEN).toFixed();
    console.log(`  anchor from the market: 1 ${sym(rec().resourceA)} : ${b} ${sym(rec().resourceB)} (${m.source})`);
    return ['1', b];
  }
  const m = /^([0-9.]+):([0-9.]+)$/.exec(v);
  if (!m || !(Number(m[1]) > 0 && Number(m[2]) > 0)) throw new Error('--anchor must be A:B with both positive');
  return [new Decimal(m[1]!).toFixed(), new Decimal(m[2]!).toFixed()];
}
function limitsFrom(p: OwnerPoolState, base?: OwnerPoolOperatorLimits): OwnerPoolOperatorLimits {
  const limits = { ...(base ?? ownerPoolSuggestedLimits(p, {
    moveBudgetBps: 300, windowEpochs: Number(opt('window') ?? 144), minFeeBps: Number(opt('min-fee') ?? 50), maxFeeBps: Number(opt('max-fee') ?? 150),
  })) } as Record<string, string | number>;
  const NUM = ['moveBudgetBps', 'windowEpochs', 'minFeeBps', 'maxFeeBps'], STR = ['maxReserveA', 'maxReserveB', 'minReserveA', 'minReserveB'];
  for (const kv of argv.slice(1).filter((x) => /^[a-zA-Z]+=/.test(x))) {
    const [k, v] = kv.split('=') as [string, string];
    if (NUM.includes(k)) limits[k] = Number(v); else if (STR.includes(k)) limits[k] = new Decimal(v).toFixed(); else throw new Error(`unknown limit ${k} (known: ${[...NUM, ...STR].join(', ')})`);
  }
  return limits as unknown as OwnerPoolOperatorLimits;
}
async function readPackageDefinition(): Promise<{ wasm: Uint8Array; definition: string; codeHash: string }> {
  const wasm = new Uint8Array(readFileSync(WASM)), rpd = new Uint8Array(readFileSync(RPD));
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const codeHash = toHex(blake2b(wasm, { dkLen: 32 }));
  if (sha(wasm) !== EXPECTED.wasmSha256 || sha(rpd) !== EXPECTED.rpdSha256 || codeHash !== EXPECTED.codeHashBlake2b) {
    throw new Error(`${WASM} / ${RPD} are not the build proven on Stokenet (wasm sha256 ${sha(wasm)}, rpd ${sha(rpd)}, code hash ${codeHash})`);
  }
  const definition = await RadixEngineToolkit.ManifestSbor.decodeToString(rpd, net.networkId, ManifestSborStringRepresentation.ManifestString);
  return { wasm, definition, codeHash };
}
async function knownPackages(): Promise<{ resourcePackage: string; packagePackage: string }> {
  const k = await RadixEngineToolkit.Utils.knownAddresses(net.networkId);
  return { resourcePackage: k.packageAddresses.resourcePackage, packagePackage: k.packageAddresses.packagePackage };
}
/** Mainnet previews that need some account other than the owner's: an existing XRD holder. */
async function standInAccount(not: string[]): Promise<string> {
  const holders = await gw.resourceHolders(XRD, 20);
  const a = holders.map((h) => h.address).find((x) => x.startsWith('account_') && !not.includes(x));
  if (!a) throw new Error('No stand-in account found');
  return a;
}
const BADGE_TEXT = {
  ownerName: opt('badge-name') ?? 'DIFD pools owner badge',
  ownerDescription: 'Owner (cold) badge of the DIFD OwnerPools: total and permanent control of every pool it owns. Keep it in cold storage.',
  operatorName: () => `DIFD pools operator badge (${NAME})`,
  operatorDescription: () => `Operator (hot) badge of the DIFD OwnerPool ${NAME}: held by the market-making bot; the owner can revoke it at any time.`,
};

// ====================================================================== steps
if (step === 'check') {
  console.log(`network ${NETWORK}; owner account ${OWNER}; state ${STATE_PATH}`);
  const { definition, codeHash } = await readPackageDefinition();
  console.log(`package files: ${WASM} and ${RPD} match the Stokenet-proven build (code hash ${codeHash}; definition ${definition.length} chars)`);
  const bal = await gw.fungibleBalances(OWNER);
  const [a, b] = pairResources();
  console.log(`owner holds ${bal[a] ?? '0'} ${sym(a)} and ${bal[b] ?? '0'} ${sym(b)}${state.poolBadge ? `, ${bal[state.poolBadge] ?? '0'} pool owner badge` : ''}`);
  const [bd] = await gw.entityDetails([b]);
  const tp = poolTokenProblems(bd?.details);
  console.log(`token B ${b}: ${tp.errors.length ? 'REFUSED: ' + tp.errors.join('; ') : 'no recaller, no freezer, transfers open and locked'}${tp.warnings.length ? '\n  WARNING (issuer risk, the owner accepts it by name): ' + tp.warnings.join('; ') : ''}`);
  if (tp.errors.length) process.exitCode = 1;
  if (NETWORK === 'mainnet') {
    const [dex] = await gw.entityDetails([MAINNET.dexOwnerBadge]);
    const bp = badgeProblems(dex?.details);
    console.log(`the DEX owner badge ${MAINNET.dexOwnerBadge} (could be adopted with "badge --use"): ${bp.length ? 'PROBLEMS: ' + bp.join('; ') : 'passes the badge rules'}; held by the owner: ${bal[MAINNET.dexOwnerBadge] ?? '0'}`);
  }
  if (state.poolBadge) await checkBadge('pool owner badge', state.poolBadge);
  if (state.package) console.log(`package ${state.package}: ${(OWNER_POOL_PACKAGES[NETWORK] ?? []).includes(state.package) ? 'allow-listed in OWNER_POOL_PACKAGES' : 'NOT yet in OWNER_POOL_PACKAGES.' + NETWORK + ' (packages/core/src/ownerpool.ts): the bot, watcher and router will refuse the pool until it is'}`);
  const m = await marketPrice().catch((e) => { console.log(`  market reference failed: ${(e as Error).message}`); return undefined; });
  if (m) console.log(`market: ${m.price.toPrecision(8)} ${sym(b)} per XRD (${m.source})`);
  const st = await gw.status();
  console.log(`ledger epoch ${st.epoch} at ${st.timestamp}`);
}

if (step === 'simulate') {
  // Badge, package and pool in ONE preview, joined by allocated addresses: what three separate signed
  // transactions will do, run against this network's real engine before any of them exists.
  const { wasm, definition, codeHash } = await readPackageDefinition();
  const kp = await knownPackages();
  const [ra, rb] = pairResources();
  const amountA = amountArg('a', false) ?? '2', amountB = amountArg('b', false) ?? '0.0016';
  const bal = await gw.fungibleBalances(OWNER);
  let account = OWNER, standIn: string | undefined;
  if (new Decimal(bal[rb] ?? '0').lt(amountB) || new Decimal(bal[ra] ?? '0').lt(amountA)) {
    const holders = await gw.resourceHolders(rb, 20);
    let h: { address: string } | undefined;
    for (const x of holders.filter((y) => y.address.startsWith('account_') && new Decimal(y.amount).gte(amountB))) {
      if (new Decimal(await gw.fungibleBalance(x.address, ra)).gte(amountA)) { h = x; break; }
    }
    if (!h) throw new Error(`No account holds ${amountA} ${sym(ra)} and ${amountB} ${sym(rb)} to simulate with`);
    account = h.address; standIn = `the account ${h.address} (holds ${sym(rb)}) instead of the owner's, who holds ${bal[rb] ?? '0'} ${sym(rb)}`;
  }
  const manifest = [
    ownerPoolCreateBadgeManifest({ account, name: BADGE_TEXT.ownerName, description: BADGE_TEXT.ownerDescription, reservation: { resourcePackage: kp.resourcePackage, named: 'badge' } }),
    ownerPoolPublishManifest({ account, definition, codeHash, reservation: { packagePackage: kp.packagePackage, named: 'owner_pool_package' } }),
    ownerPoolInstantiateManifest({ owner: { account, badge: { named: 'badge' } }, package: { named: 'owner_pool_package' }, resourceA: ra, resourceB: rb, amountA, amountB, feeBps: Number(opt('fee') ?? 50) }),
  ].join('\n');
  const file = nextFile('simulate');
  writeFileSync(`${file}.rtm`, manifest + '\n');
  const pv = await previewV1(manifest, [wasm]);
  console.log(`===== simulate (${NETWORK}; preview only, never signed) =====\nmanifest: ${file}.rtm (+ the wasm as a blob)\n${standIn ? 'account: ' + standIn + '\n' : ''}` +
    `preview: ${pv.ok ? 'SUCCEEDS' : 'FAILS: ' + pv.error?.slice(0, 400)}; network fee about ${Number(pv.feeXrd).toFixed(4)} XRD for all three\n${describe(manifest, pv).join('\n')}`);
  writeFileSync(`${file}.json`, JSON.stringify({ step: 'simulate', network: NETWORK, at: new Date().toISOString(), account, standIn: standIn ?? null, amountA, amountB, preview: pv }, null, 2) + '\n');
  if (!pv.ok) process.exitCode = 1;
}

if (step === 'badge') {
  const use = opt('use');
  if (use) {
    const [d] = await gw.entityDetails([use]);
    const problems = badgeProblems(d?.details);
    const held = (await gw.fungibleBalances(OWNER))[use] ?? '0';
    if (problems.length || held !== '1') throw new Error(`Cannot adopt ${use}: ${[...problems, held !== '1' ? `the owner holds ${held}` : ''].filter(Boolean).join('; ')}`);
    state.poolBadge = use; delete state.pending['_setup:badge']; save();
    console.log(`adopted ${use} as the pool owner badge (passes the badge rules; the owner holds it)`);
  } else {
    if (state.poolBadge) throw new Error(`A pool owner badge is already recorded: ${state.poolBadge}`);
    await stage('badge', ownerPoolCreateBadgeManifest({ account: OWNER, name: BADGE_TEXT.ownerName, description: BADGE_TEXT.ownerDescription, feeLockXrd: FEE_LOCK }));
  }
}

if (step === 'publish') {
  const reuse = opt('reuse');
  const { wasm, definition, codeHash } = await readPackageDefinition();
  if (reuse) {
    const [d] = await gw.entityDetails([reuse]);
    const hash = d?.details?.codehash_hex ?? d?.details?.code_hash_hex;
    if (!reuse.startsWith('package_') || (hash && hash !== codeHash)) throw new Error(`${reuse} is not a package with code hash ${codeHash} (it has ${hash})`);
    state.package = reuse; delete state.pending['_setup:publish']; save();
    console.log(`adopted package ${reuse}${hash ? ' (code hash matches)' : ''}`);
  } else {
    if (state.package) throw new Error(`A package is already recorded: ${state.package}`);
    await stage('publish', ownerPoolPublishManifest({ account: OWNER, definition, codeHash, feeLockXrd: NETWORK === 'stokenet' ? '500' : undefined }), {
      blobs: [wasm],
      note: NETWORK === 'mainnet' ? `The manifest carries the wasm as a blob. To publish in the wallet use https://console.radixdlt.com/deploy-package with ${WASM} and ${RPD}, owner role "None" (as for the DEX package); the fee is the one previewed here.` : undefined,
    });
  }
}

if (step === 'instantiate') {
  const r = rec();
  if (r.pool) throw new Error(`Pool "${NAME}" already exists: ${r.pool}`);
  if (!state.package) throw new Error('No package recorded: run publish first (or simulate, before it exists)');
  const amountA = amountArg('a')!, amountB = amountArg('b')!, feeBps = Number(opt('fee') ?? 50);
  const [d] = await gw.entityDetails([r.resourceB]);
  const tp = poolTokenProblems(d?.details);
  if (tp.errors.length) throw new Error(`Token B refused: ${tp.errors.join('; ')}`);
  if (tp.warnings.length) console.log(`  WARNING (issuer risk): ${tp.warnings.join('; ')}`);
  await checkAgainstMarket('seed price', new Decimal(amountB).div(amountA).toNumber());
  const res = await stage('instantiate', ownerPoolInstantiateManifest({ owner: owner(), package: state.package, resourceA: r.resourceA, resourceB: r.resourceB, amountA, amountB, feeBps, feeLockXrd: FEE_LOCK }), {
    want: { resources: [r.resourceA, r.resourceB], reserves: [amountA, amountB], inventory: ['0', '0'], feeBps, ownerPaused: false, operatorPaused: false, operator: null, ownerBadge: state.poolBadge },
    note: 'Pool audit F2 guard: the pool is created and funded in this one transaction (no empty pool ever exists) and the seed price was checked against the market above. Swaps are open from the moment it commits: pause it next unless the bot is about to start.',
  });
  if (res.ok) { r.seed = [amountA, amountB]; r.feeBps = feeBps; save(); }
}

if (step === 'pause' || step === 'unpause') {
  const paused = step === 'pause';
  const p = await pool();
  await stage(step, ownerPoolSetPausedManifest({ pool: p.address, owner: owner(), paused, feeLockXrd: FEE_LOCK }), { want: { ownerPaused: paused } });
}

if (step === 'inventory' || step === 'withdraw-inventory') {
  const p = await pool();
  const a = amountArg('a')!, b = amountArg('b')!;
  const inv: [string, string] = step === 'inventory' ? [plus(p.split!.inventoryA, a), plus(p.split!.inventoryB, b)] : [minus(p.split!.inventoryA, a), minus(p.split!.inventoryB, b)];
  const m = step === 'inventory'
    ? ownerPoolDepositInventoryManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, resourceA: p.resourceA, resourceB: p.resourceB, amountA: a, amountB: b })
    : ownerPoolWithdrawInventoryManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, amountA: a, amountB: b });
  await stage(step, m, { want: { inventory: inv } });
}

if (step === 'deposit') {
  const p = await pool(); showPool(p);
  const a = amountArg('a')!, b = amountArg('b')!;
  // Depth added at a price someone moved with a swap is exposed to him: check the curve first. An
  // emptied pool (after unwind) has no price: then this deposit sets it, and its own ratio is checked.
  const empty = new Decimal(p.reserveA).isZero() || new Decimal(p.reserveB).isZero();
  if (empty && (new Decimal(a).isZero() || new Decimal(b).isZero())) throw new Error('The pool is empty: deposit both tokens (this sets the price)');
  await checkAgainstMarket(empty ? 'the price this deposit sets (empty pool)' : 'the curve\'s price', empty ? new Decimal(b).div(a).toNumber() : new Decimal(p.reserveB).div(p.reserveA).toNumber());
  await stage('deposit', ownerPoolDepositManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, resourceA: p.resourceA, resourceB: p.resourceB, amountA: a, amountB: b, expected: [p.reserveA, p.reserveB] }), {
    want: { reserves: [plus(p.reserveA, a), plus(p.reserveB, b)] },
    note: `Guarded: fails "Reserves moved" unless the pool holds exactly ${p.reserveA} / ${p.reserveB} when it runs (a swap in between: run this step again).`,
  });
}

if (step === 'withdraw') {
  const p = await pool(); showPool(p);
  const a = amountArg('a')!, b = amountArg('b', false) ?? proportionalB(p, a);
  await stage('withdraw', ownerPoolWithdrawManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, amountA: a, amountB: b, expected: [p.reserveA, p.reserveB] }), {
    want: { reserves: [minus(p.reserveA, a), minus(p.reserveB, b)] },
    note: `Guarded by the reserves read now (${p.reserveA} / ${p.reserveB}).${opt('b') ? '' : ` B is the proportional amount, so the price stays where it is.`}`,
  });
}

if (step === 'owner-rebalance') {
  // Emergency procedure step 2: move between inventory and reserves with no limits (works while paused),
  // guarded by the reserves read now. Positive = inventory to reserves. Does not move the anchor.
  const p = await pool(); showPool(p);
  const a = opt('a') ?? '0', b = opt('b') ?? '0';
  if (new Decimal(a).isZero() && new Decimal(b).isZero()) throw new Error('--a and/or --b (signed amounts; positive = inventory to reserves)');
  const after: [string, string] = [plus(p.reserveA, a), plus(p.reserveB, b)];
  await checkAgainstMarket('the curve\'s price after the move', new Decimal(after[1]).div(after[0]).toNumber());
  await stage('owner-rebalance', ownerPoolOwnerRebalanceManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, toReserveA: a, toReserveB: b, expected: [p.reserveA, p.reserveB] }), {
    want: { reserves: after, inventory: [minus(p.split!.inventoryA, a), minus(p.split!.inventoryB, b)] },
  });
}

if (step === 'operator-badge') {
  const r = rec();
  // --replace: a NEW badge after a revoke (emergency procedure step 3); the old one stays revoked on ledger.
  if (r.operatorBadge && !flag('replace')) throw new Error(`An operator badge is already recorded for "${NAME}": ${r.operatorBadge} (--replace to make a new one after a revoke)`);
  await stage('operator-badge', ownerPoolCreateBadgeManifest({ account: OWNER, name: BADGE_TEXT.operatorName(), description: BADGE_TEXT.operatorDescription(), feeLockXrd: FEE_LOCK }));
}

if (step === 'limits' || step === 'limits-fee') {
  const p = await pool(); showPool(p);
  const limits = limitsFrom(p, flag('keep') ? p.split!.limits : undefined);
  console.log(`limits now:   ${JSON.stringify(p.split!.limits)}\nlimits after: ${JSON.stringify(limits)}`);
  if (step === 'limits') {
    if (p.feeBps < limits.minFeeBps || p.feeBps > limits.maxFeeBps) console.log(`  WARNING: the fee in force (${p.feeBps} bps) is outside the new range: use limits-fee to set both together`);
    await stage('limits', ownerPoolSetOperatorLimitsManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, limits }), { want: { limits } });
  } else {
    const feeBps = Number(opt('fee'));
    if (!Number.isInteger(feeBps)) throw new Error('--fee <bps> is required');
    await stage('limits-fee', ownerPoolLimitsAndFeeManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, limits, feeBps }), { want: { limits, feeBps } });
  }
}

if (step === 'appoint') {
  const r = rec();
  const p = await pool(); showPool(p);
  if (!r.operatorBadge) throw new Error('No operator badge recorded: run operator-badge first');
  const anchor = await anchorArg();
  const dist = ownerPoolAnchorDistance(p, anchor);
  console.log(`  anchor ${anchor.join(':')} is ${(dist * 100).toFixed(3)}% from the curve's price`);
  if (dist > 0.02 && !flag('force')) throw new Error('The anchor is more than 2% from the curve: restore the curve first (deposit/withdraw), or --force');
  let operatorAccount = opt('operator-account') ?? r.operatorAccount ?? STOKENET_OPERATOR ?? state.operatorAccount;
  let standIn: string | undefined;
  if (!operatorAccount) {
    operatorAccount = await standInAccount([OWNER]);
    standIn = `operator account ${operatorAccount} (an existing XRD holder): the operator key does not exist yet (operator-key --create, with the owner's approval)`;
  }
  const fund = opt('fund') ?? '20';
  await stage('appoint', ownerPoolAppointManifest({ pool: p.address, owner: owner(), operatorBadge: r.operatorBadge, anchor, operatorAccount, xrd: XRD, fundXrd: fund, feeLockXrd: FEE_LOCK, reopen: flag('reopen') }), {
    want: { operator: r.operatorBadge, anchor, operatorPaused: false, operatorAccount, ...(flag('reopen') ? { ownerPaused: false } : {}) },
    standIn,
    note: `Appoints ${r.operatorBadge} with the stated anchor (the allowance starts at zero and refills over the window), then sends that badge${Number(fund) > 0 ? ` and ${fund} XRD for network fees` : ''} to the operator account ${operatorAccount}.`,
  });
}

if (step === 'anchor') {
  const p = await pool(); showPool(p);
  const anchor = await anchorArg();
  console.log(`  anchor ${anchor.join(':')} is ${(ownerPoolAnchorDistance(p, anchor) * 100).toFixed(3)}% from the curve's price`);
  await stage('anchor', ownerPoolSetAnchorManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, anchor, expected: [p.reserveA, p.reserveB] }), {
    want: { anchor }, note: 'Zeroes the operator\'s allowance (it refills over the window). Guarded by the reserves read now.',
  });
}

if (step === 'fee') {
  const p = await pool();
  const feeBps = Number(opt('fee'));
  if (!Number.isInteger(feeBps)) throw new Error('--fee <bps> is required');
  const l = p.split!.limits;
  if (feeBps < l.minFeeBps || feeBps > l.maxFeeBps) console.log(`  NOTE: ${feeBps} bps is outside the operator range ${l.minFeeBps}-${l.maxFeeBps}; the bot will move it back inside on its next fee change`);
  await stage('fee', ownerPoolSetFeeManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, feeBps }), { want: { feeBps } });
}

if (step === 'revoke') {
  const p = await pool(); showPool(p);
  await stage('revoke', ownerPoolSetOperatorManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK, operator: null }), {
    want: { operator: null, ownerPaused: true, operatorPaused: false },
    note: 'Emergency stop: the operator badge loses every right in this transaction and the owner\'s pause goes on (swaps stop). Reopen with "unpause" only after checking the curve.',
  });
}

if (step === 'unwind') {
  const p = await pool(); showPool(p);
  await stage('unwind', ownerPoolWithdrawAllManifest({ pool: p.address, owner: owner(), feeLockXrd: FEE_LOCK }), {
    want: { reserves: ['0', '0'], inventory: ['0', '0'] },
    note: 'Everything in the pool (reserves and inventory) goes back to the owner account. Revoke first so nothing trades meanwhile.',
  });
}

if (step === 'operator-return') {
  const r = rec();
  const from = r.operatorAccount ?? STOKENET_OPERATOR;
  if (!from) throw new Error('No operator account recorded');
  const bal = await gw.fungibleBalances(from);
  const badges = Object.values(state.pools).map((x) => x.operatorBadge).filter((b): b is string => !!b && (bal[b] ?? '0') !== '0');
  const keep = new Decimal(opt('keep') ?? '1');
  // --xrd <amount>: exactly that much (e.g. what appoint sent); otherwise everything but --keep (1 XRD).
  const xrd = opt('xrd') !== undefined ? new Decimal(opt('xrd')!).toFixed() : Decimal.max(new Decimal(bal[XRD] ?? '0').minus(keep), 0).toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed();
  const items = [...(NETWORK === 'stokenet' && flag('badges') ? badges.map((b) => ({ resource: b, amount: '1' })) : []), { resource: XRD, amount: xrd }];
  await stage('operator-return', transferManifest({ from, to: OWNER, items, feeLockXrd: NETWORK === 'stokenet' ? '2' : '1' }), {
    signer: 'operator',
    note: NETWORK === 'mainnet' ? 'Signed by the OPERATOR key (on the server), not the owner\'s wallet: this script never sends on mainnet. See the runbook, "Unwind".' : undefined,
  });
}

if (step === 'operator-key') {
  // MAINNET: the operator's hot key. Writes a NEW key file (mode 600, refuses to overwrite) and prints
  // only its account address. Run ONLY with the owner's approval; nothing else in this script creates keys.
  if (NETWORK !== 'mainnet') throw new Error('operator-key is for mainnet; Stokenet uses data/stokenet-owner-pool-operator.key');
  const path = 'data/mainnet-owner-pool-operator.key';
  if (!flag('create')) { console.log(`Would create ${path} (mode 600) and print its account. Not created: add --create, with the owner's approval.`); process.exit(0); }
  writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  state.operatorAccount = await accountOf(keyFromHex(readFileSync(path, 'utf8').trim()), net.networkId);
  save();
  console.log(`created ${path} (mode 600). Operator account: ${state.operatorAccount}`);
}

if (step === 'record') {
  if (NETWORK !== 'mainnet' && SEND) throw new Error('record is for transactions signed elsewhere');
  const txid = argv[1];
  if (!txid || !/^txid_/.test(txid)) throw new Error('usage: record <txid>');
  const keys = Object.keys(state.pending);
  const key = opt('step') ? pendingKey(opt('step')!) : keys.length === 1 ? keys[0] : undefined;
  if (!key || !state.pending[key]) throw new Error(keys.length ? `Say which step this transaction was: --step <step> (pending: ${keys.join(', ')})` : 'Nothing pending: run a step first');
  console.log(`recording ${state.pending[key]!.step} for "${state.pending[key]!.name}" (manifest ${state.pending[key]!.file})`);
  await afterCommit(txid, key);
}

if (step === 'status') {
  console.log(JSON.stringify({ network: NETWORK, owner: OWNER, poolBadge: state.poolBadge, package: state.package, pending: state.pending, pools: state.pools }, null, 2));
  for (const [n, r] of Object.entries(state.pools)) {
    if (!r.pool) continue;
    const p = (await readOwnerPools(gw, [r.pool], state.package ? [state.package] : undefined))[0]!;
    console.log(`\n[${n}]`); showPool(p);
    const { epoch } = await gw.status();
    if (p.split?.operator) console.log(`  operator allowance now ${ownerPoolAllowanceNow(p, epoch)} of ${p.split.limits.moveBudgetBps / 10_000} (epoch ${epoch})`);
  }
}

const KNOWN = ['check', 'simulate', 'badge', 'publish', 'instantiate', 'pause', 'unpause', 'inventory', 'withdraw-inventory', 'deposit', 'withdraw', 'owner-rebalance', 'operator-badge',
  'limits', 'limits-fee', 'appoint', 'anchor', 'fee', 'revoke', 'unwind', 'operator-return', 'operator-key', 'record', 'status'];
if (!KNOWN.includes(step)) { console.log(`Unknown step ${step}. Steps: ${KNOWN.join(', ')}. See the top of this file.`); process.exitCode = 2; }
