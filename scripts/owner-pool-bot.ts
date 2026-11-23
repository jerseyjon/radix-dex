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
//   --venues a,b,c           the REFERENCE: on-ledger venues of the same pair (mainnet XRD/hUSDC, read-only previews):
//                            ociswap, ociswap-precision, caviarnine, defiplaza (default: all four); or fixed:<price>,
//                            file:<path> (JSON {"price": n, "at": iso|ms} or a bare number) as synthetic venues for drills.
//                            (--sources is accepted as an alias.) --quote-size <xrd> (1000) --small-fraction <f> (0.1)
//                            --min-impact <bps> (10) --max-round-trip <f> (0.1) --min-venues <n> (1)
//                            --max-venue-fee <f> (0.01): a venue whose own swap fee (estimated from its quotes) is over this is excluded
//                            The bot REFUSES to start if a venue is the operated pool or any OwnerPool component (checked on ledger).
//   --venue-hold <s>         the set of live venues changed: no rebalance for this long (900; restarts on another change;
//                            kept in the state file); the fee may widen meanwhile, not narrow
//   --confirm-ticks <n>      a venue counts as dropped only after failing n ticks in a row, and as back only after
//                            quoting n ticks in a row (2); on a tick where a confirmed venue failed but is not yet
//                            dropped, the bot prices from the venues that did quote and does not rebalance
//   --single-venue-fee-add <bps>      only ONE venue confirmed live: fee target + this (50; still clamped to the range)
//   --single-venue-size-factor <f>    ...and the per-tick spend cap and the rolling-window share x this (0.5)
//   --exclude-venues a,b     TEST/DRILL ONLY: treat these venues as dropped. --exclude-venues-file <path>: the same, names
//                            read from the file (comma/whitespace separated) on every tick, so a venue can be dropped mid-run
//   --watch-sources a,b      WATCH ONLY, never traded on: coingecko (default). Alert when it is more than
//                            --watch-max-deviation <f> (0.15) from the on-ledger reference; --no-watch to skip
//   --max-disagreement <f>   live venues further apart than this (0.04): hold (no rebalance) and widen the fee by
//                            --disagree-fee-factor <f> (0.5) x the disagreement; pause if it lasts --pause-after
//   --spend-window <s> --max-window-spend <f>   rolling cap: at most 60% of the allowance in any 10 minutes
//   --scale auto|<n>         pool target = reference * scale; auto: calibrated once so the first healthy
//                            reference maps to the owner anchor (kept in the state file)
//   --owner-anchor A:B       FALLBACK only: the owner's anchor is read from the ledger (the pool's last
//                            OwnerPoolAnchorEvent); this flag is used only when the ledger cannot say. With
//                            neither, the bot does not rebalance. --anchor-recheck <s> (default 300)
//   --alert-url <url>        POST a short text alert there (ntfy-style); env OWNER_POOL_BOT_ALERT_URL; none if unset
//   --alert-interval <s>     one alert per condition per interval (default 3600); --alert-behind-ticks <n> (default 10)
//   --sent-log <path>        every submitted txid is appended here before submission (default data/owner-pool-bot-sent.jsonl),
//                            so the watcher (scripts/owner-pool-watch.ts) can tell the bot's operator actions from anyone else's
//   --interval <s> --max-age <s> --pause-after <s> --resume-after <s>
//   --dead-band <bps> --spend-fraction <f> --reserve-fraction <f> --min-move <bps> --side balanced|remove|add
//   --target-depth <n> --max-anchor-distance <f> --base-fee <bps> --vol-multiplier <f> --behind-fee <bps>
//   --min-fee-change <bps> --widen-interval <s> --narrow-interval <s> --max-tx-per-hour <n> --fee-lock <xrd>
//   --no-fee                 never touch the fee
//   --state <path>           state file (default data/owner-pool-bot-state.json; data/ is gitignored)
//   --key <path> --badge <resource> --pool <component> --network stokenet
//   --gateway-url <url>      the Gateway for the operated network (default: the network's public one); e.g. your own
//                            Gateway, or for TESTS a local fault proxy (scripts/gateway-fault-proxy.ts)
//   --mainnet-gateway-url <url>   the mainnet Gateway the venues are READ from (default: the public one); same uses
//
// Keys: the operator key is loaded from --key (default data/stokenet-owner-pool-operator.key) and never
// printed. The bot holds no owner key and cannot do anything only the owner may do.
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { assertReferenceExcludesOwnerPools, makePriceSources, makeVenues, readSource, readVenueSource, type PriceSource, type VenueSource } from './owner-pool-sources.ts';
import {
  AlertSink, Decimal, Gateway, findOwnerAnchor, parseAnchorFlag, refreshOwnerAnchor, resolveOwnerAnchor, type OwnerAnchorSource, type OwnerAnchorStatement, NETWORKS, OWNER_POOL_BOT_DEFAULTS as D, OWNER_POOL_PACKAGES, accountOf, addr, anchorCheck, buildTransaction,
  calibrateScale, decideRebalance, feeDecision, venueSetHold, venueConfirm, venueGate, volatilityEligible, singleVenueCaution, type VenueHoldState, type VenueConfirmState, type SingleVenueState, feeTargetDetail, keyFromHex, aggregateVenues, watchPriceCheck, windowSpendRoom, recordSendOutcome, sendHalted, behindUpdate, tickOutcome,
  ownerPoolAllowanceNow, ownerPoolOperatorSetFeeManifest,
  ownerPoolRebalanceManifest, ownerPoolSetOperatorPausedManifest, pauseDecision, poolTargetPrice, priceDistance, readOwnerPools, trySubmitAndWait,
  txAllowance, volatilityBps, type Ed25519Key, type VenueReference, type NetworkName, type OwnerPoolState, type PauseState, type RebalanceSide,
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
  minVenues: num('min-venues', D.minVenues),
  maxSourceAgeSec: num('max-age', D.maxSourceAgeSec),
  maxDisagreement: num('max-disagreement', D.maxDisagreement),
  quoteSizeXrd: num('quote-size', D.quoteSizeXrd),
  smallQuoteFraction: num('small-fraction', D.smallQuoteFraction),
  minImpactBps: num('min-impact', D.minImpactBps),
  maxRoundTrip: num('max-round-trip', D.maxRoundTrip),
  maxVenueFee: num('max-venue-fee', D.maxVenueFee),
  venueHoldSec: num('venue-hold', D.venueHoldSec),
  confirmTicks: num('confirm-ticks', D.confirmTicks),
  singleVenueFeeAddBps: num('single-venue-fee-add', D.singleVenueFeeAddBps),
  singleVenueSizeFactor: num('single-venue-size-factor', D.singleVenueSizeFactor),
  excludeVenues: (opt('exclude-venues') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  excludeVenuesFile: opt('exclude-venues-file'),
  disagreeFeeFactor: num('disagree-fee-factor', D.disagreeFeeFactor),
  watchMaxDeviation: num('watch-max-deviation', D.coingeckoMaxDeviation),
  spendWindowSec: num('spend-window', D.spendWindowSec),
  maxWindowSpendShare: num('max-window-spend', D.maxWindowSpendShare),
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
  venues: (opt('venues') ?? opt('sources') ?? 'ociswap,ociswap-precision,caviarnine,defiplaza').split(',').map((s) => s.trim()).filter(Boolean),
  watchSources: flag('no-watch') ? [] : (opt('watch-sources') ?? 'coingecko').split(',').map((s) => s.trim()).filter(Boolean),
  scale: opt('scale') ?? 'auto',
  ownerAnchorFlag: opt('owner-anchor') !== undefined ? parseAnchorFlag(opt('owner-anchor')!) : undefined,
  anchorRecheckSec: num('anchor-recheck', D.anchorRecheckSec),
  alertUrl: opt('alert-url') ?? process.env.OWNER_POOL_BOT_ALERT_URL ?? undefined,
  alertIntervalSec: num('alert-interval', D.alertIntervalSec),
  alertBehindTicks: num('alert-behind-ticks', D.alertBehindTicks),
  alertErrorTicks: num('alert-error-ticks', D.alertErrorTicks),
  sentLog: opt('sent-log') ?? 'data/owner-pool-bot-sent.jsonl',
  statePath: opt('state') ?? 'data/owner-pool-bot-state.json',
  keyPath: opt('key') ?? 'data/stokenet-owner-pool-operator.key',
  badge: opt('badge') ?? 'resource_tdx_2_1tkfvg8qudhzmp4fj8z5jlw3wnlsm6cghhwvcfmekwyz73xnwl2c24q',
  pool: opt('pool') ?? 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk',
};
if (!['balanced', 'remove', 'add'].includes(cfg.side)) throw new Error('--side must be balanced, remove or add');
if (!(cfg.spendFraction > 0 && cfg.spendFraction <= 1) || cfg.reserveFraction < 0 || cfg.reserveFraction >= 1) throw new Error('bad --spend-fraction / --reserve-fraction');
if (!(cfg.maxWindowSpendShare > 0 && cfg.maxWindowSpendShare <= 1) || !(cfg.spendWindowSec > 0)) throw new Error('bad --max-window-spend / --spend-window');
if (!(Number.isInteger(cfg.confirmTicks) && cfg.confirmTicks >= 1)) throw new Error('--confirm-ticks must be a whole number >= 1');
if (!(cfg.singleVenueSizeFactor > 0 && cfg.singleVenueSizeFactor <= 1) || !(cfg.singleVenueFeeAddBps >= 0)) throw new Error('bad --single-venue-size-factor (0-1] / --single-venue-fee-add (>= 0)');
if (!(cfg.quoteSizeXrd > 0) || !(cfg.smallQuoteFraction > 0 && cfg.smallQuoteFraction < 1)) throw new Error('bad --quote-size / --small-fraction');

const net = NETWORKS[NETWORK];
const gw = new Gateway(net, { url: opt('gateway-url') });
/** Mainnet is only READ, for prices: entity details and free previews. Nothing is ever signed for it. */
const mainnetGw = new Gateway(NETWORKS.mainnet, { url: opt('mainnet-gateway-url') });

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
// The alert URL may hold a private topic: it is never logged, only whether one is set.
const redactedCfg = () => ({ ...cfg, keyPath: undefined, alertUrl: cfg.alertUrl ? '(set)' : undefined });

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
  /** The owner's last anchor statement read from the ledger, and how far the search has got. */
  ownerAnchor?: { statement?: OwnerAnchorStatement; complete: boolean; scannedTo: number; checkedAt: number; error?: string };
  /** Consecutive ticks on which the bot could not close the gap. */
  behindTicks?: number;
  /** Alert rate limiter: last alert time per condition. */
  alertLast?: Record<string, number>;
  /** The bot's own budget spends (cost from the ledger event, else the plan), for the rolling cap. */
  spends?: { at: number; cost: number; txid: string }[];
  /** The last fee change that failed (preview or send): not retried at once. */
  lastFeeFailure?: { feeBps: number; at: number };
  /** The live venue set last seen and the venue-set hold (survives a restart). */
  venueHold?: VenueHoldState;
  /** The confirmed live venue set and the two-tick streak counters (survive a restart). */
  venueConfirm?: VenueConfirmState;
  /** The current single-venue episode (survives a restart, so its alert is not repeated). */
  singleVenue?: SingleVenueState;
}
const loadState = (): BotState => {
  const fresh: BotState = { history: [], txTimes: [], pause: { pausedByBot: false }, consecutiveFailures: 0 };
  if (!existsSync(cfg.statePath)) return fresh;
  return { ...fresh, ...JSON.parse(readFileSync(cfg.statePath, 'utf8')) };
};
const state = loadState();
const alerts = new AlertSink(cfg.alertUrl, { intervalMs: cfg.alertIntervalSec * 1000, last: state.alertLast, prefix: `[owner-pool-bot ${NETWORK}${SEND ? '' : ' dry-run'}] ` });
state.alertLast = alerts.limiter.last;
/** Raise an alert (rate-limited per key); the outcome goes into the tick's log line, never the URL. */
async function alert(key: string, text: string, into?: Record<string, unknown>): Promise<void> {
  const r = await alerts.alert(key, text);
  state.alertLast = alerts.limiter.last;
  const rec = { key, sent: r.sent, ...(r.suppressed ? { suppressed: true } : {}), ...(r.error ? { error: r.error } : {}), ...(alerts.enabled ? {} : { noUrl: true }) };
  if (into) ((into.alerts ??= []) as unknown[]).push(rec);
  else log({ event: 'alert', ...rec, text: r.text });
}
async function forceAlert(key: string, text: string): Promise<void> {
  const r = await alerts.alert(key, text, Date.now(), { force: true });
  state.alertLast = alerts.limiter.last;
  log({ event: 'alert', key, sent: r.sent, ...(r.error ? { error: r.error } : {}), ...(alerts.enabled ? {} : { noUrl: true }), text: r.text });
}
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

/** The reference: on-ledger venues of the same pair. */
const venues: VenueSource[] = makeVenues(cfg.venues, mainnetGw, { sizeXrd: cfg.quoteSizeXrd, smallFraction: cfg.smallQuoteFraction });
/** Watch only (CoinGecko): compared with the reference, never traded on. */
const watchSources: PriceSource[] = makePriceSources(cfg.watchSources, mainnetGw);
/** The watch comparison makes sense only when every venue is a real one (synthetic venues are in pool units). */
const watchComparable = cfg.venues.every((v) => !v.startsWith('fixed:') && !v.startsWith('file:'));
// HARD GUARD: the reference must never contain the pool the bot operates, nor any OwnerPool component.
try {
  const g = await assertReferenceExcludesOwnerPools(mainnetGw, cfg.venues, cfg.pool);
  log({ event: 'venue-guard', ok: true, checked: g.checked });
} catch (e) {
  log({ event: 'refused', reason: String((e as Error)?.message ?? e) });
  unlock();
  process.exit(2);
}
/** Venues excluded for a test or drill: the flag, plus the file's names (re-read each tick). */
function excludedVenues(): string[] {
  let fromFile: string[] = [];
  if (cfg.excludeVenuesFile && existsSync(cfg.excludeVenuesFile)) fromFile = readFileSync(cfg.excludeVenuesFile, 'utf8').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return [...new Set([...cfg.excludeVenues, ...fromFile])];
}

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
  if (SEND && sendHalted(state, now)) {
    return { type, preview: { ok: false, feeXrd: '0' }, sent: false, skipped: `halted after ${cfg.maxConsecutiveFailures} failed transactions until ${new Date(state.haltedUntil ?? 0).toISOString()}` };
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
  // Recorded BEFORE submission: an operator action on ledger that is not in this file was not ours.
  appendFileSync(cfg.sentLog, JSON.stringify({ at: new Date().toISOString(), txid: tx.intentHashId, type, pool: cfg.pool, network: NETWORK }) + '\n');
  // Never throws: a refused or unreachable submit is a FAILED SEND (counted toward the halt), not a tick error.
  const out = await trySubmitAndWait(gw, tx, 180_000);
  const ok = out.status === 'CommittedSuccess';
  const so = recordSendOutcome(state, ok, Date.now(), { maxFailures: cfg.maxConsecutiveFailures, haltMs: cfg.haltSec * 1000 });
  state.consecutiveFailures = so.consecutiveFailures;
  state.haltedUntil = so.haltedUntil;
  if (so.recovered) {
    // The halted run is over: the next halt must be alerted even inside the alert interval.
    alerts.limiter.clear('halt');
    log({ event: 'halt-recovered', txid: tx.intentHashId, type });
  }
  if (so.halted) {
    await alert('halt', `HALTED: ${state.consecutiveFailures} failed sends in a row (last ${type} ${tx.intentHashId}: ${out.status}${'error' in out ? ' ' + out.error.slice(0, 120) : ''}). No sends until ${new Date(state.haltedUntil ?? 0).toISOString()}.`);
  }
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

// ------------------------------------------------------------------ the owner's anchor (ledger)

/**
 * The owner's last anchor statement, cached in the state file and re-read from the ledger every
 * --anchor-recheck seconds (incrementally: only transactions after the last one searched).
 */
async function ownerAnchor(now: number, line: Record<string, unknown>): Promise<OwnerAnchorSource> {
  const c = state.ownerAnchor;
  if (!c || !c.complete || now - c.checkedAt >= cfg.anchorRecheckSec * 1000) {
    try {
      const r = c && c.scannedTo > 0
        ? await refreshOwnerAnchor(gw, cfg.pool, c.statement, c.scannedTo)
        : await findOwnerAnchor(gw, cfg.pool);
      const prev = c?.statement;
      state.ownerAnchor = { statement: r.statement, complete: r.complete, scannedTo: r.newest, checkedAt: now };
      if (r.statement && prev && r.statement.stateVersion !== prev.stateVersion) {
        line.ownerAnchorChanged = { from: prev.anchor, to: r.statement.anchor, txid: r.statement.txid };
        await alert('anchor-restated', `Owner restated the anchor: ${prev.anchor.join(':')} -> ${r.statement.anchor.join(':')} (${r.statement.txid}). Allowance restarts from zero.`, line);
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      // Keep what was known (it was the ledger's answer at the last check); record the failure.
      state.ownerAnchor = c ? { ...c, error: msg } : { complete: false, scannedTo: 0, checkedAt: 0, error: msg };
    }
  }
  const k = state.ownerAnchor!;
  return resolveOwnerAnchor({ ledger: k.statement, ledgerComplete: k.complete, ledgerError: k.statement ? undefined : k.error, flag: cfg.ownerAnchorFlag });
}

// ------------------------------------------------------------------ one tick

let tickNo = 0;
async function tick(): Promise<void> {
  tickNo++;
  const now = Date.now();
  const line: Record<string, unknown> = { event: 'tick', tick: tickNo, mode: SEND ? 'send' : 'dry-run', network: NETWORK };
  const actions: Sent[] = [];
  line.actions = actions;

  // 1. Reference: on-ledger venues only. Watch sources (CoinGecko) are read beside them, never used.
  const [quotes, watch] = await Promise.all([Promise.all(venues.map(readVenueSource)), Promise.all(watchSources.map(readSource))]);
  const exclude = excludedVenues();
  const aggOpts = { minVenues: cfg.minVenues, maxAgeMs: cfg.maxSourceAgeSec * 1000, maxDisagreement: cfg.maxDisagreement, maxRoundTrip: cfg.maxRoundTrip, minImpactBps: cfg.minImpactBps, maxVenueFee: cfg.maxVenueFee, exclude };
  const raw: VenueReference = aggregateVenues(quotes, now, aggOpts);
  if (exclude.length) line.testExcluded = exclude;
  // Two-tick confirmation: one failed tick does not drop a venue, one good tick does not bring one back.
  // A state file from before this rule has no confirmed set: start from the hold's last live set.
  const vc = venueConfirm(state.venueConfirm ?? (state.venueHold?.liveSet ? { confirmed: state.venueHold.liveSet } : {}), raw.venues.filter((v) => v.used).map((v) => v.venue), cfg.confirmTicks);
  state.venueConfirm = vc.state;
  // A venue coming back is read and logged but does not enter the price until it is confirmed.
  const unconfirmed = Object.fromEntries(vc.returning.map((r) => [r.venue, `coming back: ${r.ticks}/${cfg.confirmTicks} good ticks in a row, not counted yet`]));
  const vref: VenueReference = vc.returning.length ? aggregateVenues(quotes, now, { ...aggOpts, unconfirmed }) : raw;
  const uncertainMsg = vc.uncertain ? `venue(s) failed this tick, not dropped yet: ${vc.failing.map((f) => `${f.venue} ${f.ticks}/${cfg.confirmTicks}`).join(', ')}` : undefined;
  line.venueConfirm = { confirmed: vc.confirmed, ...(vc.failing.length ? { failing: vc.failing } : {}), ...(vc.returning.length ? { returning: vc.returning } : {}), ...(vc.dropped.length ? { dropped: vc.dropped } : {}), ...(vc.added.length ? { added: vc.added } : {}) };
  // Venue-set hold: a change in the CONFIRMED live set (any rule) holds the position for --venue-hold.
  const vh = venueSetHold(state.venueHold ?? {}, vc.confirmed, now, cfg.venueHoldSec * 1000);
  state.venueHold = vh.state;
  const holdMsg = vh.holding ? `venue-set hold (${vh.state.holdReason}) for ${Math.round(vh.remainingMs / 1000)} s more` : undefined;
  line.venueSet = { live: vh.state.liveSet, ...(vh.changed ? { changed: { removed: vh.removed, added: vh.added } } : {}), ...(vh.holding ? { holdUntil: new Date(vh.state.holdUntil!).toISOString(), remainingSec: Math.round(vh.remainingMs / 1000), reason: vh.state.holdReason } : {}), ...(vh.expired ? { holdEnded: true } : {}) };
  if (vh.started) await alert('venue-hold', `VENUE SET CHANGED (${vh.state.holdReason}): holding position (no rebalance) for ${Math.round(cfg.venueHoldSec / 60)} min; the fee may widen, not narrow. Live now: ${vh.state.liveSet!.join(',') || 'none'}.`, line);
  if (vh.expired) alerts.limiter.clear('venue-hold');
  // Single-venue caution: one confirmed venue = trade, but with a wider fee and half the sizes.
  const sv = singleVenueCaution(state.singleVenue ?? {}, vc.confirmed.length, now);
  state.singleVenue = sv.state;
  const caution = sv.active ? { feeAddBps: cfg.singleVenueFeeAddBps, sizeFactor: cfg.singleVenueSizeFactor } : undefined;
  if (sv.active) {
    line.singleVenueCaution = {
      active: true, venue: vc.confirmed[0], since: new Date(sv.state.since!).toISOString(), feeAddBps: caution!.feeAddBps, sizeFactor: caution!.sizeFactor,
      spendFraction: cfg.spendFraction * caution!.sizeFactor, windowShare: cfg.maxWindowSpendShare * caution!.sizeFactor,
    };
  }
  if (sv.started) await alert('single-venue', `SINGLE VENUE: only ${vc.confirmed[0]} is confirmed live. Trading cautiously: fee target +${cfg.singleVenueFeeAddBps} bps (inside the operator range), per-tick spend and rolling-window share x${cfg.singleVenueSizeFactor}.`, line);
  if (sv.ended) alerts.limiter.clear('single-venue');
  const ref = vref.status === 'ok' ? { ok: true as const, price: vref.price } : { ok: false as const, reason: vref.reason };
  const r6 = (x: number | undefined) => (x === undefined ? null : Number(x.toPrecision(6)));
  line.reference = {
    status: vref.status, price: vref.price ?? null, disagreement: vref.disagreement === undefined ? null : round(vref.disagreement, 5), live: vref.live, reason: vref.reason,
    venues: vref.venues.map((v) => ({ venue: v.venue, used: v.used, mid: r6(v.mid), fee: r6(v.fee), roundTrip: r6(v.roundTrip), impact: r6(v.impact), depth: r6(v.depth), weight: r6(v.weight), ...(v.dropped ? { dropped: v.dropped } : {}) })),
  };
  if (vref.live === 1) line.referenceWarning = `only ONE live venue (${vref.venues.find((v) => v.used)!.venue}): its price is not checked against another venue${sv.active ? ' (single-venue caution on)' : vc.uncertain ? ' (another venue failed this tick: no rebalance)' : ''}`;
  const watchLines = watch.map((w) => {
    if (w.error) return { source: w.source, error: w.error };
    const c = watchComparable ? watchPriceCheck(vref.price, w.price, cfg.watchMaxDeviation) : { alarm: false, deviation: undefined };
    return { source: w.source, price: w.price, ageSec: Math.round((now - w.at) / 1000), deviation: c.deviation === undefined ? null : round(c.deviation, 5), alarm: c.alarm };
  });
  line.watch = watchLines;
  for (const w of watchLines) {
    // Watch only: an alert, never a change to what the bot does.
    if ('alarm' in w && w.alarm) await alert(`watch-${w.source}`, `WATCH: ${w.source} ${w.price} is ${((w.deviation ?? 0) * 100).toFixed(1)}% from the on-ledger reference ${r6(vref.price)} (limit ${(cfg.watchMaxDeviation * 100).toFixed(0)}%). Trading is NOT affected; check the venues.`, line);
    else if ('alarm' in w && w.deviation !== null) alerts.limiter.clear(`watch-${w.source}`);
  }
  // Volatility history: only prices from the full confirmed set (trade or hold ticks, never uncertain,
  // disagree or none), so a one-tick jump from a partial venue set cannot raise the fee.
  const volOk = volatilityEligible({ status: vref.status, holding: vh.holding, uncertain: vc.uncertain });
  line.volatilitySample = volOk;
  if (ref.ok && volOk) {
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

  // 3. The owner's anchor (ledger first), then map the reference onto the pool.
  const oa = await ownerAnchor(now, line);
  const ownerAnchorNow = oa.source === 'none' ? undefined : oa.anchor;
  line.ownerAnchorSource = oa.source === 'ledger'
    ? { source: 'ledger', anchor: oa.anchor, txid: oa.txid, stateVersion: oa.stateVersion, ...(oa.flagMismatch ? { warning: `--owner-anchor ${oa.flagMismatch.join(':')} differs from the ledger's; the ledger is used` } : {}) }
    : { source: oa.source, reason: oa.reason, ...(oa.source === 'flag' ? { anchor: oa.anchor } : {}) };
  if (oa.source === 'ledger') alerts.limiter.clear('anchor-unknown');
  else await alert('anchor-unknown', `Owner anchor ${oa.source === 'flag' ? `taken from --owner-anchor ${oa.anchor.join(':')}` : 'UNKNOWN: not rebalancing'}: ${oa.reason}`, line);
  let scale: number | undefined;
  if (cfg.scale !== 'auto') scale = Number(cfg.scale);
  else if (ownerAnchorNow && state.calibration && state.calibration.anchor.join(':') === ownerAnchorNow.join(':')) scale = state.calibration.scale;
  else if (ref.ok && ownerAnchorNow) {
    scale = calibrateScale(ref.price, ownerAnchorNow);
    state.calibration = { reference: ref.price, scale, at: new Date(now).toISOString(), anchor: ownerAnchorNow };
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
  // Unknown anchor: no distance can be measured, so no anchor stop either; the rebalance is refused below.
  const anchor = target && ownerAnchorNow ? anchorCheck(target, ownerAnchorNow, { maxDistance: cfg.maxAnchorDistance, resumeFactor: cfg.anchorResumeFactor, stopped: stoppedForAnchor }) : { ok: true, distance: NaN };
  line.ownerAnchor = { anchor: ownerAnchorNow ?? null, distance: Number.isNaN(anchor.distance) ? null : round(anchor.distance, 5), ok: anchor.ok };
  if (!anchor.ok) {
    line.ownerMustAct = `reference maps to ${target} B per A, ${(anchor.distance * 100).toFixed(2)}% from the owner's anchor ${ownerAnchorNow!.join(':')} (limit ${(cfg.maxAnchorDistance * 100).toFixed(1)}%): the bot stops following. The OWNER must restate the anchor (set_anchor) from the market; the bot cannot and must not.`;
    await alert('anchor-stop', `ANCHOR STOP: ${line.ownerMustAct}`, line);
  } else alerts.limiter.clear('anchor-stop');
  if (!ref.ok && state.pause.unhealthySince !== undefined && now - state.pause.unhealthySince >= cfg.pauseAfterSec * 1000) {
    await alert('reference-unhealthy', `On-ledger reference unusable for ${Math.round((now - state.pause.unhealthySince) / 60_000)} min (${ref.reason}).`, line);
  } else if (ref.ok) alerts.limiter.clear('reference-unhealthy');

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
    const outcome = r.sent ? `${r.status} ${r.txid}` : r.skipped ?? (r.preview.ok ? 'previewed ok, not sent (dry run)' : `PREVIEW FAILED: ${r.preview.error ?? ''}`);
    alerts.limiter.clear(pd.action === 'pause' ? 'pool-unpause' : 'pool-pause');
    await alert(`pool-${pd.action}`, `Bot ${pd.action === 'pause' ? 'PAUSED' : 'RESUMED'} the pool (operator pause ${pd.action === 'pause' ? 'on' : 'off'}): ${pd.reason}. ${outcome}`, line);
    return void log(line);
  }
  state.pause = pd.state;
  if (s.ownerPaused) { line.decision = 'owner pause on: nothing to do (only the owner reopens)'; return void log(line); }
  if (s.operatorPaused) { line.decision = 'operator pause on: no rebalance or fee change'; return void log(line); }
  if (!ownerAnchorNow) { line.decision = 'owner anchor unknown: no rebalance, no fee change'; return void log(line); }
  const gate = venueGate({ status: vref.status, holding: !!holdMsg, uncertain: vc.uncertain });
  line.gate = gate;
  if (gate === 'disagree') {
    // Hold the position (no rebalance) and widen the fee: the venues do not agree where the price is.
    const fr = cfg.feeControl ? await feeStep(now, pool.feeBps, s, false, vref.disagreement, actions, line, holdMsg ?? uncertainMsg, caution) : undefined;
    line.decision = `HOLD: ${vref.reason}${fr ? `; ${fr}` : ''}`;
    return void log(line);
  }
  if (gate === 'hold') {
    // The venue set changed: hold the position (no rebalance) until the hold ends; the fee may widen, not narrow.
    const fr = cfg.feeControl ? await feeStep(now, pool.feeBps, s, false, undefined, actions, line, holdMsg, caution) : undefined;
    line.decision = `HOLD: ${holdMsg}: no rebalance${fr ? `; ${fr}` : ''}`;
    return void log(line);
  }
  if (gate === 'uncertain') {
    // A confirmed venue failed once: priced from the venues that quoted, but the reference is less certain.
    // No rebalance this tick, no hold; the fee may widen, not narrow (as in a hold).
    const fr = cfg.feeControl ? await feeStep(now, pool.feeBps, s, false, undefined, actions, line, uncertainMsg, caution) : undefined;
    line.decision = `NO REBALANCE: ${uncertainMsg}${fr ? `; ${fr}` : ''}`;
    return void log(line);
  }
  if (gate === 'none' || !ref.ok || !target) { line.decision = `no reference (${ref.ok ? 'no target' : ref.reason}): no rebalance, no fee change`; return void log(line); }
  if (!anchor.ok) { line.decision = 'beyond the owner anchor distance: not following'; return void log(line); }

  // 6. Rebalance.
  state.spends = (state.spends ?? []).filter((x) => now - x.at < 86_400_000);
  // Single-venue caution: half the window share (60% -> 30% of the allowance at the window's start) and
  // half the per-tick cap (sizeFactor on min(allowance x spendFraction, allowance - reserve)).
  const sizeFactor = caution?.sizeFactor ?? 1;
  const windowShare = cfg.maxWindowSpendShare * sizeFactor;
  const win = windowSpendRoom(state.spends, Number(allowanceLocal), now, { windowMs: cfg.spendWindowSec * 1000, maxShare: windowShare });
  line.spendWindow = { spentInWindow: round(win.spentInWindow, 9), room: round(win.room, 9), maxShare: windowShare, windowSec: cfg.spendWindowSec, ...(caution ? { sizeFactor } : {}) };
  const dec = decideRebalance(pool, epoch, target, { deadBandBps: cfg.deadBandBps, spendFraction: cfg.spendFraction, reserveFraction: cfg.reserveFraction, minMoveBps: cfg.minMoveBps, side: cfg.side, targetDepth, spendCap: win.room, sizeFactor });
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
      const ev: { cost?: string; allowance?: string } = await rebalanceEvent(r.txid).catch(() => ({}));
      state.spends.push({ at: Date.now(), cost: Number(ev.cost ?? dec.plan.cost), txid: r.txid });
      const after = (await readOwnerPools(gw, [cfg.pool], OWNER_POOL_PACKAGES[NETWORK]))[0]!;
      feeNow = after.feeBps;
      line.after = { event: ev, price: new Decimal(after.reserveB).div(after.reserveA).toNumber(), reserveA: after.reserveA, reserveB: after.reserveB, gapBps: round(priceDistance(new Decimal(after.reserveB).div(after.reserveA).toNumber(), target) * 10_000, 2) };
    } else if (r.sent || !r.preview.ok) behind = true; // sent but failed, preview failed, or skipped (halt, cap): the gap stays open
  } else line.rebalance = { action: 'none', reason: dec.reason, allowance: dec.allowance, spendable: dec.spendable };

  const bu = behindUpdate(state.behindTicks, behind, cfg.alertBehindTicks);
  state.behindTicks = bu.ticks;
  line.behindTicks = state.behindTicks;
  if (bu.alert) {
    await alert('behind', `Bot BEHIND for ${state.behindTicks} ticks: pool ${round(price, 9)} vs target ${round(target, 9)} (gap ${round(priceDistance(price, target) * 10_000, 1)} bps; ${dec.action === 'none' ? dec.reason : 'clipped move'}).`, line);
  } else if (bu.cleared) alerts.limiter.clear('behind');

  // 7. Fee.
  if (cfg.feeControl) await feeStep(now, feeNow, s, behind, undefined, actions, line, undefined, caution);
  line.decision = actions.length ? actions.map((a) => `${a.type}: ${a.sent ? a.status : a.skipped ?? (a.preview.ok ? 'previewed ok (dry run)' : 'PREVIEW FAILED, not sent')}`).join('; ') : 'nothing to do';
  log(line);
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The fee step: target from the rule (base + volatility + behind + the venues' disagreement while they
 * disagree), clamped to the owner's operator range (logged when clamped), with hysteresis; a change that
 * failed is not retried at once. Returns a short summary.
 */
async function feeStep(now: number, feeNow: number, s: NonNullable<OwnerPoolState['split']>, behind: boolean, disagreement: number | undefined, actions: Sent[], line: Record<string, unknown>, noNarrow?: string, caution?: { feeAddBps: number }): Promise<string> {
  const volBps = volatilityBps(state.history, now, cfg.volWindowSec * 1000, cfg.intervalSec * 1000);
  const ft = feeTargetDetail({ volBps, behind, disagreement, singleVenueAddBps: caution?.feeAddBps, minFeeBps: s.limits.minFeeBps, maxFeeBps: s.limits.maxFeeBps, cfg });
  const fd = feeDecision({ currentFeeBps: feeNow, targetFeeBps: ft.feeBps, lastChangeAt: state.lastFeeChangeAt, now, minFeeBps: s.limits.minFeeBps, maxFeeBps: s.limits.maxFeeBps, lastFailure: state.lastFeeFailure, noNarrow, cfg: { minFeeChangeBps: cfg.minFeeChangeBps, widenIntervalMs: cfg.widenIntervalSec * 1000, narrowIntervalMs: cfg.narrowIntervalSec * 1000 } });
  line.fee = {
    current: feeNow, target: ft.feeBps, rule: ft.rawBps, ...(ft.clamped ? { clamped: `${ft.clamped} of the operator range ${s.limits.minFeeBps}-${s.limits.maxFeeBps} bps` } : {}),
    volBps: round(volBps, 2), behind, ...(caution ? { singleVenueAddBps: caution.feeAddBps } : {}), ...(disagreement !== undefined ? { disagreement: round(disagreement, 5) } : {}), decision: fd.reason,
  };
  if (fd.action !== 'set') return `fee: ${fd.reason}`;
  const r = await execute(`operator_set_fee(${fd.feeBps})`, ownerPoolOperatorSetFeeManifest({ pool: cfg.pool, operator: signer, feeBps: fd.feeBps, feeLockXrd: cfg.feeLockXrd }));
  actions.push(r);
  if (r.status === 'CommittedSuccess') { state.lastFeeChangeAt = Date.now(); state.lastFeeFailure = undefined; }
  else if (r.sent || (!r.preview.ok && !r.skipped)) state.lastFeeFailure = { feeBps: fd.feeBps, at: Date.now() };
  return `operator_set_fee(${fd.feeBps}): ${r.sent ? r.status : r.skipped ?? (r.preview.ok ? 'previewed ok (dry run)' : 'PREVIEW FAILED, not sent')}`;
}

// ------------------------------------------------------------------ loop

let stopping = false;
let wake: (() => void) | undefined;
const stop = (sig: string) => { if (!stopping) log({ event: 'stopping', signal: sig, note: 'finishing the current tick' }); stopping = true; wake?.(); };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });

log({ event: 'start', mode: SEND ? 'send' : 'dry-run', network: NETWORK, pool: cfg.pool, operatorAccount, badge: cfg.badge, gateway: opt('gateway-url') ?? 'public', mainnetGateway: opt('mainnet-gateway-url') ?? 'public', venues: venues.map((s) => s.name), watch: watchSources.map((s) => s.name), config: redactedCfg() });
// Start and stop are never rate-limited: every restart (a crash loop included) must be seen.
if (!ONCE) await forceAlert('start', `Bot started (pid ${process.pid}) on ${cfg.pool.slice(0, 24)}...: venues ${cfg.venues.join(',')}, quote size ${cfg.quoteSizeXrd} XRD, disagreement bound ${(cfg.maxDisagreement * 100).toFixed(1)}%.`);
let errors = 0;
try {
  while (!stopping) {
    let failed: unknown;
    try { await tick(); } catch (e) { failed = e ?? new Error('tick failed'); }
    const prev = errors;
    const to = tickOutcome(errors, failed !== undefined, { intervalMs: cfg.intervalSec * 1000, alertTicks: cfg.alertErrorTicks });
    errors = to.errors;
    if (failed !== undefined) {
      // A tick that throws (Gateway down, ...) has sent nothing after the failing read: no action this tick.
      const message = String((failed as Error)?.message ?? failed).slice(0, 400);
      log({ event: 'error', tick: tickNo, consecutiveErrors: errors, nextInSec: Math.round(to.delayMs / 1000), message });
      if (to.alert) await alert('tick-errors', `Bot ticks failing: ${errors} in a row (backing off ${Math.round(to.delayMs / 1000)} s). Last: ${message.slice(0, 200)}`);
      if (ONCE) process.exitCode = 1;
    } else if (prev >= cfg.alertErrorTicks) alerts.limiter.clear('tick-errors');
    saveState();
    if (ONCE || stopping) break;
    // Back off on errors: interval * 2^errors, at most 15 minutes.
    await sleep(to.delayMs);
  }
} finally {
  if (!ONCE) await forceAlert('stop', `Bot stopped after ${tickNo} ticks${stopping ? '' : ' (unexpectedly)'}.`);
  saveState();
  unlock();
  log({ event: 'stopped', ticks: tickNo });
}
