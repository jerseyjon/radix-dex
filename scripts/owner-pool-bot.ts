// Market-making bot for a split OwnerPool, using ONLY the operator (hot) key's powers:
// `rebalance` (inventory <-> reserves, within the owner's budget, caps and floors), `operator_set_fee`
// (inside the owner's fee range) and `set_operator_paused`. The decision logic is pure and unit-tested
// in packages/core/src/ownerpool-bot.ts; this file does the I/O. Read docs/owner-pool-bot.md first.
//
//   tsx scripts/owner-pool-bot.ts [--once] [--send] [options]
//
// DRY RUN by default: reads, decides, PREVIEWS every transaction it would send, logs, sends nothing.
// `--send` submits, and only on Stokenet (hard-coded below). Every transaction is built by code
// (packages/core/src/ownerpool-ops.ts), previewed in the same tick (exact notarised transaction, real
// signature, no free credit) and sent only if that preview succeeded.
//
// Options (defaults in OWNER_POOL_BOT_DEFAULTS, reasons in docs/owner-pool-bot.md):
//   --sources a,b,c          price sources: ociswap, caviarnine, coingecko (mainnet, read-only),
//                            fixed:<price>, file:<path> (JSON {"price": n, "at": iso|ms} or a bare number)
//   --scale auto|<n>         pool target = reference * scale; auto: calibrated once so the first healthy
//                            reference maps to the owner anchor (kept in the state file)
//   --owner-anchor A:B       the anchor the OWNER stated (default 1250:1); the bot stops beyond --max-anchor-distance
//   --interval <s> --min-sources <n> --max-age <s> --max-disagreement <f> --pause-after <s> --resume-after <s>
//   --dead-band <bps> --spend-fraction <f> --reserve-fraction <f> --min-move <bps> --side balanced|remove|add
//   --target-depth <n> --max-anchor-distance <f> --base-fee <bps> --vol-multiplier <f> --behind-fee <bps>
//   --min-fee-change <bps> --widen-interval <s> --narrow-interval <s> --max-tx-per-hour <n> --fee-lock <xrd>
//   --no-fee                 never touch the fee
//   --state <path>           state file (default data/owner-pool-bot-state.json; data/ is gitignored)
//   --key <path> --badge <resource> --pool <component> --network stokenet
//
// Keys: the operator key is loaded from --key (default data/stokenet-owner-pool-operator.key) and never
// printed. The bot holds no owner key and cannot do anything only the owner may do.
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  Decimal, Gateway, NETWORKS, OWNER_POOL_BOT_DEFAULTS as D, OWNER_POOL_PACKAGES, Quoter, accountOf, addr, aggregateReference, anchorCheck, buildTransaction,
  calibrateScale, decideRebalance, feeDecision, feeTarget, keyFromHex, listCaviarNine, ownerPoolAllowanceNow, ownerPoolOperatorSetFeeManifest,
  ownerPoolRebalanceManifest, ownerPoolSetOperatorPausedManifest, pauseDecision, poolTargetPrice, priceDistance, readOwnerPools, submitAndWait,
  txAllowance, volatilityBps, type Ed25519Key, type NetworkName, type OwnerPoolState, type PauseState, type PriceSample, type RebalanceSide,
} from '../packages/core/src/index.ts';

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const num = (n: string, d: number): number => {
  const v = opt(n);
  if (v === undefined) return d;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`--${n} must be a number, not ${v}`);
  return x;
};

const SEND = flag('send');
const ONCE = flag('once');
const NETWORK = (opt('network') ?? 'stokenet') as NetworkName;
if (!NETWORKS[NETWORK]) throw new Error(`Unknown network ${NETWORK}`);
// HARD GUARD. Sending is Stokenet-only for now: running this against a mainnet pool needs the owner's
// explicit go-ahead (and a code change here), not a flag.
if (SEND && NETWORK !== 'stokenet') {
  console.error(JSON.stringify({ t: new Date().toISOString(), event: 'refused', reason: `--send is only allowed on stokenet (asked for ${NETWORK}); mainnet needs the owner's explicit go-ahead` }));
  process.exit(2);
}

const cfg = {
  intervalSec: num('interval', D.intervalSec),
  minSources: num('min-sources', D.minSources),
  maxSourceAgeSec: num('max-age', D.maxSourceAgeSec),
  maxDisagreement: num('max-disagreement', D.maxDisagreement),
  pauseAfterSec: num('pause-after', D.pauseAfterSec),
  resumeAfterSec: num('resume-after', D.resumeAfterSec),
  deadBandBps: opt('dead-band') !== undefined ? num('dead-band', 0) : D.deadBandBps,
  spendFraction: num('spend-fraction', D.spendFraction),
  reserveFraction: num('reserve-fraction', D.reserveFraction),
  minMoveBps: num('min-move', D.minMoveBps),
  side: (opt('side') ?? D.side) as RebalanceSide,
  targetDepth: opt('target-depth') !== undefined ? num('target-depth', 0) : undefined,
  maxAnchorDistance: num('max-anchor-distance', D.maxAnchorDistance),
  anchorResumeFactor: num('anchor-resume-factor', D.anchorResumeFactor),
  baseFeeBps: num('base-fee', D.baseFeeBps),
  volMultiplier: num('vol-multiplier', D.volMultiplier),
  volWindowSec: num('vol-window', D.volWindowSec),
  behindFeeBps: num('behind-fee', D.behindFeeBps),
  minFeeChangeBps: num('min-fee-change', D.minFeeChangeBps),
  widenIntervalSec: num('widen-interval', D.widenIntervalSec),
  narrowIntervalSec: num('narrow-interval', D.narrowIntervalSec),
  maxTxPerHour: num('max-tx-per-hour', D.maxTxPerHour),
  maxConsecutiveFailures: num('max-failures', D.maxConsecutiveFailures),
  haltSec: num('halt', D.haltSec),
  feeLockXrd: opt('fee-lock') ?? D.feeLockXrd,
  feeControl: !flag('no-fee'),
  sources: (opt('sources') ?? 'ociswap,caviarnine,coingecko').split(',').map((s) => s.trim()).filter(Boolean),
  scale: opt('scale') ?? 'auto',
  ownerAnchor: (opt('owner-anchor') ?? '1250:1').split(':') as [string, string],
  statePath: opt('state') ?? 'data/owner-pool-bot-state.json',
  keyPath: opt('key') ?? 'data/stokenet-owner-pool-operator.key',
  badge: opt('badge') ?? 'resource_tdx_2_1tkfvg8qudhzmp4fj8z5jlw3wnlsm6cghhwvcfmekwyz73xnwl2c24q',
  pool: opt('pool') ?? 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk',
};
if (!['balanced', 'remove', 'add'].includes(cfg.side)) throw new Error('--side must be balanced, remove or add');
if (cfg.ownerAnchor.length !== 2 || !(Number(cfg.ownerAnchor[0]) > 0 && Number(cfg.ownerAnchor[1]) > 0)) throw new Error('--owner-anchor must be A:B with both positive');
if (!(cfg.spendFraction > 0 && cfg.spendFraction <= 1) || cfg.reserveFraction < 0 || cfg.reserveFraction >= 1) throw new Error('bad --spend-fraction / --reserve-fraction');

const net = NETWORKS[NETWORK];
const gw = new Gateway(net);
/** Mainnet is only READ, for prices: entity details and free previews. Nothing is ever signed for it. */
const mainnetGw = new Gateway(NETWORKS.mainnet);

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

// ------------------------------------------------------------------ state file

interface BotState {
  history: { at: number; price: number }[];
  calibration?: { reference: number; scale: number; at: string; anchor: [string, string] };
  targetDepth?: number;
  lastFeeChangeAt?: number;
  txTimes: number[];
  pause: PauseState;
  consecutiveFailures: number;
  haltedUntil?: number;
  lastTx?: { at: string; type: string; txid: string; status: string };
}
const loadState = (): BotState => {
  const fresh: BotState = { history: [], txTimes: [], pause: { pausedByBot: false }, consecutiveFailures: 0 };
  if (!existsSync(cfg.statePath)) return fresh;
  return { ...fresh, ...JSON.parse(readFileSync(cfg.statePath, 'utf8')) };
};
const state = loadState();
const saveState = () => {
  const tmp = `${cfg.statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
  renameSync(tmp, cfg.statePath);
};

// One bot per state file: a second one would double the sends.
const lockPath = `${cfg.statePath}.lock`;
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
  if (alive && pid !== process.pid) { log({ event: 'refused', reason: `another bot (pid ${pid}) holds ${lockPath}` }); process.exit(2); }
}
writeFileSync(lockPath, String(process.pid));
const unlock = () => { try { unlinkSync(lockPath); } catch { /* gone */ } };

// ------------------------------------------------------------------ price sources (mainnet, read-only)

const MAINNET_XRD = NETWORKS.mainnet.xrd;
const HUSDC = 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv';
/** Ociswap BasicPool XRD/hUSDC (constant product) and the native pool that holds its funds. */
const OCI_COMPONENT = 'component_rdx1cpqg9y55tv8652k32cznhmu8rz3jgtw57vdg460ld2sy650zpfh5fr';
/** CaviarNine QuantaSwap XRD/hUSDC (also in CAVIARNINE_POOLS). */
const C9_COMPONENT = 'component_rdx1cqelumvmmgwths34k9pp0htd2ykwq7d70m0r389etwh39ul3j5tyj5';

interface PriceSource { name: string; read(): Promise<PriceSample> }

/** Ociswap XRD/hUSDC basic pool, from the ledger: hUSDC reserve / XRD reserve (the curve's mid price, no fee). */
const ociswapSource = (): PriceSource => ({
  name: 'ociswap-xrd-husdc-ledger',
  async read() {
    const c = await mainnetGw.post('/state/entity/details', { addresses: [OCI_COMPONENT] });
    const fields: any[] = c?.items?.[0]?.details?.state?.fields ?? [];
    const f = (n: string) => fields.find((x) => x?.field_name === n)?.value;
    if (c?.items?.[0]?.details?.blueprint_name !== 'BasicPool' || f('x_address') !== MAINNET_XRD || f('y_address') !== HUSDC) throw new Error('Ociswap pool is not XRD/hUSDC BasicPool');
    const pool = String(f('liquidity_pool'));
    const j = await mainnetGw.post('/state/entity/details', { addresses: [pool], aggregation_level: 'Global' });
    const items: any[] = j?.items?.[0]?.fungible_resources?.items ?? [];
    const bal = (r: string) => Number(items.find((i) => i?.resource_address === r)?.amount);
    const x = bal(MAINNET_XRD), y = bal(HUSDC);
    if (!(x > 0 && y > 0)) throw new Error('Ociswap pool reserves unreadable');
    return { source: this.name, price: y / x, at: Date.parse(j.ledger_state.proposer_round_timestamp) };
  },
});

/**
 * CaviarNine XRD/hUSDC, through the project's own Quoter: previews of a small sell each way on
 * mainnet (free, nothing signed); the mid is the geometric mean of the two prices, so the venue fee
 * cancels out. Its active bin is ~5% wide, so the bin bounds alone are too coarse.
 */
const caviarNineSource = (): PriceSource => {
  const quoter = new Quoter(mainnetGw);
  return {
    name: 'caviarnine-xrd-husdc-quoter',
    async read() {
      const { pools } = await listCaviarNine(mainnetGw, { addresses: [C9_COMPONENT] });
      const pool = pools[0];
      if (!pool || !pool.tokens.includes(MAINNET_XRD) || !pool.tokens.includes(HUSDC)) throw new Error('CaviarNine XRD/hUSDC pool unreadable');
      const at = Date.now();
      const [sellXrd, sellUsd] = await Promise.all([quoter.simulate([pool], MAINNET_XRD, '100'), quoter.simulate([pool], HUSDC, '0.08')]);
      if (!sellXrd || !sellUsd) throw new Error(`CaviarNine preview failed: ${quoter.lastFailure ?? 'no quote'}`);
      const bid = Number(sellXrd.buyAmount) / Number(sellXrd.sellAmount); // hUSDC per XRD when selling XRD
      const ask = Number(sellUsd.sellAmount) / Number(sellUsd.buyAmount); // hUSDC per XRD when buying XRD
      if (!(bid > 0 && ask > 0)) throw new Error('CaviarNine quotes unusable');
      return { source: this.name, price: Math.sqrt(bid * ask), at };
    },
  };
};

/** CoinGecko simple price (keyless, off-ledger): XRD in USD, with its own last-updated time. */
const coingeckoSource = (): PriceSource => ({
  name: 'coingecko-xrd-usd',
  async read() {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=radix&vs_currencies=usd&include_last_updated_at=true', { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const j: any = await res.json();
    const price = Number(j?.radix?.usd), at = Number(j?.radix?.last_updated_at) * 1000;
    if (!(price > 0) || !(at > 0)) throw new Error('CoinGecko response unusable');
    return { source: this.name, price, at };
  },
});

/** A fixed price, always fresh: tests and drills only. */
const fixedSource = (price: number, i: number): PriceSource => ({
  name: `fixed#${i}`,
  async read() { return { source: this.name, price, at: Date.now() }; },
});

/** A price kept in a file (JSON {"price": n, "at": iso|ms} or a bare number, then the file's mtime is its time). */
const fileSource = (path: string): PriceSource => ({
  name: `file:${path}`,
  async read() {
    const text = readFileSync(path, 'utf8').trim();
    let price: number, at: number;
    if (text.startsWith('{')) {
      const j = JSON.parse(text);
      price = Number(j.price);
      at = j.at === undefined ? statSync(path).mtimeMs : typeof j.at === 'number' ? j.at : Date.parse(j.at);
    } else { price = Number(text); at = statSync(path).mtimeMs; }
    if (!(price > 0) || !Number.isFinite(at)) throw new Error('price file unusable');
    return { source: this.name, price, at };
  },
});

const sources: PriceSource[] = cfg.sources.map((s, i) => {
  if (s === 'ociswap') return ociswapSource();
  if (s === 'caviarnine') return caviarNineSource();
  if (s === 'coingecko') return coingeckoSource();
  if (s.startsWith('fixed:')) { const p = Number(s.slice(6)); if (!(p > 0)) throw new Error(`bad ${s}`); return fixedSource(p, i); }
  if (s.startsWith('file:')) return fileSource(s.slice(5));
  throw new Error(`Unknown price source ${s}`);
});

const readSource = async (s: PriceSource): Promise<PriceSample> => {
  try {
    return await Promise.race([s.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 30 s')), 30_000))]);
  } catch (e) {
    return { source: s.name, price: NaN, at: 0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
};

// ------------------------------------------------------------------ ledger reads

/** The ledger's own `operator_status` by preview: (badge, limits, allowance now, operator pause, anchor). */
async function operatorStatus(epoch: number): Promise<{ operator: string | null; allowance: string; operatorPaused: boolean; anchor: [string, string] }> {
  const res = await gw.preview(`CALL_METHOD ${addr(cfg.pool)} "operator_status";`, epoch);
  if (!res.ok) throw new Error('operator_status failed: ' + res.error);
  const f = res.raw?.receipt?.output?.[0]?.programmatic_json?.fields;
  if (!Array.isArray(f) || f.length !== 5) throw new Error('operator_status: unexpected output');
  // Preview output carries no variant names: Option's Some is variant 1.
  const operator = String(f[0]?.variant_id) === '1' ? String(f[0].fields[0].value) : null;
  const allowance = String(f[2]?.value);
  const operatorPaused = f[3]?.value === true;
  const anchor: [string, string] = [String(f[4]?.fields?.[0]?.value), String(f[4]?.fields?.[1]?.value)];
  if (!/^\d+(\.\d+)?$/.test(allowance)) throw new Error('operator_status: allowance unreadable');
  return { operator, allowance, operatorPaused, anchor };
}

// ------------------------------------------------------------------ sending

const operatorKey: Ed25519Key = keyFromHex(readFileSync(cfg.keyPath, 'utf8').trim());
const operatorAccount = await accountOf(operatorKey, net.networkId);
const signer = { account: operatorAccount, badge: cfg.badge };

type Sent = { type: string; preview: { ok: boolean; feeXrd: string; error?: string }; sent: boolean; txid?: string; status?: string; error?: string; skipped?: string };

/** Preview the exact transaction now; send it (with --send) only if the preview succeeded and the caps allow. */
async function execute(type: string, manifest: string): Promise<Sent> {
  const now = Date.now();
  if (SEND && state.haltedUntil && now < state.haltedUntil) {
    return { type, preview: { ok: false, feeXrd: '0' }, sent: false, skipped: `halted after ${cfg.maxConsecutiveFailures} failed transactions until ${new Date(state.haltedUntil).toISOString()}` };
  }
  if (SEND && txAllowance(state.txTimes, now, cfg.maxTxPerHour) <= 0) {
    return { type, preview: { ok: false, feeXrd: '0' }, sent: false, skipped: `transaction cap reached (${cfg.maxTxPerHour} per hour)` };
  }
  const { epoch } = await gw.status();
  const tx = await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 5 }, notary: operatorKey });
  const pv = await gw.previewV2(tx.previewHex);
  const preview = { ok: pv.ok, feeXrd: pv.feeXrd, ...(pv.error ? { error: pv.error.slice(0, 300) } : {}) };
  if (!pv.ok || !SEND) return { type, preview, sent: false };
  state.txTimes = [...state.txTimes.filter((t) => now - t < 3_600_000), now];
  saveState();
  const out = await submitAndWait(gw, tx, 180_000);
  const ok = out.status === 'CommittedSuccess';
  state.consecutiveFailures = ok ? 0 : state.consecutiveFailures + 1;
  if (state.consecutiveFailures >= cfg.maxConsecutiveFailures) state.haltedUntil = Date.now() + cfg.haltSec * 1000;
  state.lastTx = { at: new Date().toISOString(), type, txid: tx.intentHashId, status: out.status };
  saveState();
  return { type, preview, sent: true, txid: tx.intentHashId, status: out.status, ...('error' in out ? { error: out.error.slice(0, 300) } : {}) };
}

/** The ledger's OwnerPoolRebalanceEvent of a committed transaction: cost and allowance after. */
async function rebalanceEvent(txid: string): Promise<{ cost?: string; allowance?: string }> {
  const j = await gw.post('/transaction/committed-details', { intent_hash: txid, opt_ins: { receipt_events: true } });
  const ev = (j.transaction?.receipt?.events ?? []).find((e: any) => e.name === 'OwnerPoolRebalanceEvent');
  const field = (n: string) => ev?.data?.fields?.find((x: any) => x.field_name === n)?.value;
  return { cost: field('cost'), allowance: field('allowance') };
}

// ------------------------------------------------------------------ one tick

let tickNo = 0;
async function tick(): Promise<void> {
  tickNo++;
  const now = Date.now();
  const line: Record<string, unknown> = { event: 'tick', tick: tickNo, mode: SEND ? 'send' : 'dry-run', network: NETWORK };
  const actions: Sent[] = [];
  line.actions = actions;

  // 1. Reference.
  const samples = await Promise.all(sources.map(readSource));
  const ref = aggregateReference(samples, now, { minSources: cfg.minSources, maxAgeMs: cfg.maxSourceAgeSec * 1000, maxDisagreement: cfg.maxDisagreement });
  line.sources = samples.map((s) => ({ source: s.source, price: s.error ? null : s.price, ageSec: s.error ? null : Math.round((now - s.at) / 1000), ...(s.error ? { error: s.error } : {}) }));
  line.reference = ref.ok ? { ok: true, price: ref.price, disagreement: round(ref.disagreement, 5) } : { ok: false, reason: ref.reason, disagreement: ref.disagreement === undefined ? null : round(ref.disagreement, 5) };
  if (ref.ok) {
    state.history.push({ at: now, price: ref.price });
    state.history = state.history.filter((h) => now - h.at <= D.historyKeepSec * 1000);
  }

  // 2. Ledger: pool state (vault by vault) and the contract's own operator_status.
  const { epoch } = await gw.status();
  const pool: OwnerPoolState = (await readOwnerPools(gw, [cfg.pool], OWNER_POOL_PACKAGES[NETWORK]))[0]!;
  const s = pool.split;
  if (!s) throw new Error(`${cfg.pool} is not a split OwnerPool`);
  const st = await operatorStatus(epoch);
  const allowanceLocal = ownerPoolAllowanceNow(pool, epoch);
  const price = new Decimal(pool.reserveB).div(pool.reserveA).toNumber();
  line.pool = {
    epoch, stateVersion: pool.stateVersion, price, reserveA: pool.reserveA, reserveB: pool.reserveB, inventoryA: s.inventoryA, inventoryB: s.inventoryB,
    feeBps: pool.feeBps, ownerPaused: s.ownerPaused, operatorPaused: s.operatorPaused, ledgerAnchor: s.anchor,
  };
  line.allowance = { ledger: st.allowance, local: allowanceLocal, budget: s.limits.moveBudgetBps / 10_000 };
  if (st.allowance !== allowanceLocal) line.warning = 'allowance: ledger and local copy differ (the ledger is used for nothing but this check; the plan is re-checked by preview)';
  state.targetDepth ??= cfg.targetDepth ?? Math.sqrt(Number(pool.reserveA) * Number(pool.reserveB));
  const targetDepth = cfg.targetDepth ?? state.targetDepth;

  // 3. Map the reference onto the pool.
  let scale: number | undefined;
  if (cfg.scale !== 'auto') scale = Number(cfg.scale);
  else if (state.calibration && state.calibration.anchor.join(':') === cfg.ownerAnchor.join(':')) scale = state.calibration.scale;
  else if (ref.ok) {
    scale = calibrateScale(ref.price, cfg.ownerAnchor);
    state.calibration = { reference: ref.price, scale, at: new Date(now).toISOString(), anchor: cfg.ownerAnchor };
    line.calibrated = state.calibration;
  }
  if (scale !== undefined && !(scale > 0)) throw new Error(`--scale must be positive or auto, not ${cfg.scale}`);
  // Not calibrated yet (auto, and no healthy reference so far): no target.
  const target = ref.ok && scale ? poolTargetPrice(ref.price, scale) : undefined;
  line.scale = scale ?? null;
  line.target = target ?? null;
  line.gapBps = target ? round(priceDistance(price, target) * 10_000, 2) : null;

  // 4. The owner's anchor: how far may the bot follow?
  const stoppedForAnchor = state.pause.pausedByBot && /anchor/.test(state.pause.pauseReason ?? '');
  const anchor = target ? anchorCheck(target, cfg.ownerAnchor, { maxDistance: cfg.maxAnchorDistance, resumeFactor: cfg.anchorResumeFactor, stopped: stoppedForAnchor }) : { ok: true, distance: NaN };
  line.ownerAnchor = { anchor: cfg.ownerAnchor, distance: Number.isNaN(anchor.distance) ? null : round(anchor.distance, 5), ok: anchor.ok };
  if (!anchor.ok) line.ownerMustAct = `reference maps to ${target} B per A, ${(anchor.distance * 100).toFixed(2)}% from the owner's anchor ${cfg.ownerAnchor.join(':')} (limit ${(cfg.maxAnchorDistance * 100).toFixed(1)}%): the bot stops following. The OWNER must restate the anchor (set_anchor) from the market; the bot cannot and must not.`;

  const isOperator = st.operator === cfg.badge && s.operator === cfg.badge;
  if (!isOperator) {
    line.decision = `not the appointed operator (pool operator ${st.operator ?? 'none'}, our badge ${cfg.badge}): nothing sent`;
    return void log(line);
  }

  // 5. Pause control.
  const pd = pauseDecision({
    now, healthy: ref.ok, anchorOk: anchor.ok, operatorPaused: s.operatorPaused, ownerPaused: s.ownerPaused, state: state.pause,
    pauseAfterMs: cfg.pauseAfterSec * 1000, resumeAfterMs: cfg.resumeAfterSec * 1000,
  });
  line.pause = { action: pd.action, reason: pd.reason };
  if (pd.action !== 'none') {
    const r = await execute(pd.action === 'pause' ? 'set_operator_paused(true)' : 'set_operator_paused(false)',
      ownerPoolSetOperatorPausedManifest({ pool: cfg.pool, signer, paused: pd.action === 'pause', feeLockXrd: cfg.feeLockXrd }));
    actions.push(r);
    // Keep the timers; record the pause as the bot's only if it really happened.
    state.pause = r.status === 'CommittedSuccess' ? pd.state : { ...pd.state, pausedByBot: state.pause.pausedByBot, pauseReason: state.pause.pauseReason };
    line.decision = `${pd.action}: ${pd.reason}`;
    return void log(line);
  }
  state.pause = pd.state;
  if (s.ownerPaused) { line.decision = 'owner pause on: nothing to do (only the owner reopens)'; return void log(line); }
  if (s.operatorPaused) { line.decision = 'operator pause on: no rebalance or fee change'; return void log(line); }
  if (!ref.ok || !target) { line.decision = `no reference (${ref.ok ? 'no target' : ref.reason}): no rebalance`; return void log(line); }
  if (!anchor.ok) { line.decision = 'beyond the owner anchor distance: not following'; return void log(line); }

  // 6. Rebalance.
  const dec = decideRebalance(pool, epoch, target, { deadBandBps: cfg.deadBandBps, spendFraction: cfg.spendFraction, reserveFraction: cfg.reserveFraction, minMoveBps: cfg.minMoveBps, side: cfg.side, targetDepth });
  line.deadBandBps = dec.deadBandBps;
  let behind = dec.behind;
  let feeNow = pool.feeBps;
  if (dec.action === 'rebalance') {
    line.rebalance = { kind: dec.kind, toReserveA: dec.toReserveA, toReserveB: dec.toReserveB, cost: dec.plan.cost, allowance: dec.allowance, spendable: dec.spendable, priceAfter: dec.priceAfter, gapAfterBps: round(dec.gapAfterBps, 2), clipped: dec.clipped };
    const r = await execute('rebalance', ownerPoolRebalanceManifest({
      pool: cfg.pool, operator: signer, toReserveA: dec.toReserveA, toReserveB: dec.toReserveB, expected: [pool.reserveA, pool.reserveB], feeLockXrd: cfg.feeLockXrd,
    }));
    actions.push(r);
    if (r.status === 'CommittedSuccess' && r.txid) {
      const ev = await rebalanceEvent(r.txid).catch(() => ({}));
      const after = (await readOwnerPools(gw, [cfg.pool], OWNER_POOL_PACKAGES[NETWORK]))[0]!;
      feeNow = after.feeBps;
      line.after = { event: ev, price: new Decimal(after.reserveB).div(after.reserveA).toNumber(), reserveA: after.reserveA, reserveB: after.reserveB, gapBps: round(priceDistance(new Decimal(after.reserveB).div(after.reserveA).toNumber(), target) * 10_000, 2) };
    } else if (!r.sent && !r.preview.ok) behind = true;
  } else line.rebalance = { action: 'none', reason: dec.reason, allowance: dec.allowance, spendable: dec.spendable };

  // 7. Fee.
  if (cfg.feeControl) {
    const volBps = volatilityBps(state.history, now, cfg.volWindowSec * 1000, cfg.intervalSec * 1000);
    const ft = feeTarget({ volBps, behind, minFeeBps: s.limits.minFeeBps, maxFeeBps: s.limits.maxFeeBps, cfg });
    const fd = feeDecision({ currentFeeBps: feeNow, targetFeeBps: ft, lastChangeAt: state.lastFeeChangeAt, now, minFeeBps: s.limits.minFeeBps, maxFeeBps: s.limits.maxFeeBps, cfg: { minFeeChangeBps: cfg.minFeeChangeBps, widenIntervalMs: cfg.widenIntervalSec * 1000, narrowIntervalMs: cfg.narrowIntervalSec * 1000 } });
    line.fee = { current: feeNow, target: ft, volBps: round(volBps, 2), behind, decision: fd.reason };
    if (fd.action === 'set') {
      const r = await execute(`operator_set_fee(${fd.feeBps})`, ownerPoolOperatorSetFeeManifest({ pool: cfg.pool, operator: signer, feeBps: fd.feeBps, feeLockXrd: cfg.feeLockXrd }));
      actions.push(r);
      if (r.status === 'CommittedSuccess') state.lastFeeChangeAt = Date.now();
    }
  }
  line.decision = actions.length ? actions.map((a) => `${a.type}: ${a.sent ? a.status : a.skipped ?? (a.preview.ok ? 'previewed ok (dry run)' : 'PREVIEW FAILED, not sent')}`).join('; ') : 'nothing to do';
  log(line);
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------ loop

let stopping = false;
let wake: (() => void) | undefined;
const stop = (sig: string) => { if (!stopping) log({ event: 'stopping', signal: sig, note: 'finishing the current tick' }); stopping = true; wake?.(); };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });

log({ event: 'start', mode: SEND ? 'send' : 'dry-run', network: NETWORK, pool: cfg.pool, operatorAccount, badge: cfg.badge, sources: sources.map((s) => s.name), config: { ...cfg, keyPath: undefined } });
let errors = 0;
try {
  while (!stopping) {
    try {
      await tick();
      errors = 0;
    } catch (e) {
      errors++;
      log({ event: 'error', tick: tickNo, consecutiveErrors: errors, message: String((e as Error)?.message ?? e).slice(0, 400) });
      if (ONCE) process.exitCode = 1;
    }
    saveState();
    if (ONCE || stopping) break;
    // Back off on errors: interval * 2^errors, at most 15 minutes.
    const delay = Math.min(cfg.intervalSec * 1000 * 2 ** errors, 900_000);
    await sleep(delay);
  }
} finally {
  saveState();
  unlock();
  log({ event: 'stopped', ticks: tickNo });
}
