// Read-only watcher for a split OwnerPool: follows the pool's own events on ledger and alerts on the
// theft pattern from the audits and on anything the owner should know. It holds NO key and sends NO
// transaction; it is independent of the bot (run it somewhere the bot's key is not).
// Rules in packages/core/src/ownerpool-watch.ts; read docs/owner-pool-bot.md ("Watcher").
//
//   tsx scripts/owner-pool-watch.ts [--once] [--replay | --from <state version>] [options]
//
//   --replay                 start from the pool's first transaction (prints every finding; sends no alerts
//                            unless --alert-on-replay); otherwise a first run starts from now
//   --max-spend-share <f>    one operator move spending more than this share of the allowance (default 0.6)
//   --max-spend-24h <n>      operator spend in 24 h above n full budgets (default 1)
//   --max-window-spend <f> --spend-window <s>   operator moves within any 10 min spending more than 60% of the
//                            allowance available at the window's start (the bot's own cap; catches "half, then half")
//   --max-anchor-drift <f>   owner anchor vs reference (default 0.05); --max-pool-drift <f> pool vs reference (default 0.03)
//   --venues a,b,c --quote-size <xrd> --scale auto|<n> --max-disagreement <f> --max-age <s>   reference, as the bot's
//                            (on-ledger venues; drift checked only while they agree); --max-venue-fee <f> (0.01) as the bot's;
//                            refuses to start if a venue is the watched pool or any OwnerPool component
//                            --scale auto takes the bot's calibration from --bot-state, else calibrates to the owner anchor
//   --bot-sent-log <path>    the bot's sent log (Stokenet default data/owner-pool-bot-sent.jsonl): operator actions not in it are
//                            flagged (not-bot). MAINNET: required, and must exist, unless --no-sent-log, which turns the rule OFF
//                            and says so at start (log + alert). A log on the bot's host is NOT trustworthy against a thief on that
//                            host (he can append his own txids); the behavioural rules below do not need it.
//   --bot-state <path>       the bot's state file (Stokenet default data/owner-pool-bot-stokenet-state.json), read only, for the
//                            scale (Stokenet --scale auto only; mainnet is always scale 1)
//   behavioural theft rules (H-4, live only, no sent log needed): an operator rebalance that leaves the pool further from the
//                            reference (now and its median of 3) than it was (--move-tolerance <bps>, 10): alert; one while the reference
//                            is unusable: warn; an operator fee outside what the bot's fee rule can produce now: alert. The bot's fee rule
//                            is given by --bot-base-fee (100; the mainnet unit passes 50) --bot-vol-multiplier (2) --bot-behind-fee (10)
//                            --bot-single-venue-fee-add (50) --fee-margin <bps> (10)
//   --max-spend-24h <n>      default: derived from the pool's window (1 + 24 h / (window_epochs x --epoch-sec 301)), so the bot's
//                            legitimate use never alarms
//   --heartbeat <path>       written every tick (default data/heartbeat/owner-pool-watch-<network>.json)
//   --alert-url <url>        (or env OWNER_POOL_BOT_ALERT_URL) POST short text alerts there; --alert-interval <s> (default 3600)
//   --state <path>           the watcher's own checkpoint (Stokenet default data/owner-pool-watch-stokenet-state.json); tied to
//                            network and pool, refused for any other. MAINNET: --pool and --state are required
//   --markout <path>         per-trade profit record (default data/owner-pool-markout.jsonl): every swap through the pool with
//                            the reference at trade time, marked again at +5 and +30 min (--markout-horizons 5,30); --no-markout
//                            to skip. Summary: tsx scripts/owner-pool-markout.ts. Read only, live mode only.
//   --interval <s> --pool <component> --network stokenet
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { loadJsonWithBackup, saveJsonDurable, writeHeartbeat } from '../packages/core/src/ownerpool-files.ts';
import {
  AlertSink, Decimal, Gateway, NETWORKS, OWNER_POOL_BOT_DEFAULTS as BD, OWNER_POOL_PACKAGES, OWNER_POOL_WATCH_DEFAULTS as W, aggregateVenues, calibrateScale, limitsRecord,
  driftFindings, dueMarks, findOwnerAnchor, markRecord, parseMarkoutLines, tradeFromSwap, tradeRecord, type MarkoutRef, lastOwnerAnchor, readOwnerPoolTransactions, readOwnerPools, watchTransaction,
  watchAlertMode, type NetworkName, type OwnerAnchorStatement, type WatchFinding, type WatchState,
  OWNER_POOL_REFERENCE_PAIRS, REPLAY_BASELINE, REFERENCE_MEDIAN_N, botFeeBounds, flagRangeProblems, medianReference, optValue, pairProblem, resolveScale, spend24hBudgets, stampLedgerTime,
  stateIdentityProblem, volatilityBps, type StateIdentity,
} from '../packages/core/src/index.ts';
import { assertReferenceExcludesOwnerPools, makeVenues, readVenueSource } from './owner-pool-sources.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
/** Argument errors are collected and refused together (exit 2), never thrown (L-2). */
const argErrors: string[] = [];
const opt = (n: string): string | undefined => { try { return optValue(argv, n); } catch (e) { argErrors.push(String((e as Error).message)); return undefined; } };
const num = (n: string, d: number): number => {
  const v = opt(n);
  if (v === undefined) return d;
  const x = Number(v);
  if (!Number.isFinite(x)) { argErrors.push(`--${n} must be a number, not ${v}`); return d; }
  return x;
};

const NETWORK = (opt('network') ?? 'stokenet') as NetworkName;
if (!NETWORKS[NETWORK]) throw new Error(`Unknown network ${NETWORK}`);
const MAINNET = NETWORK === 'mainnet';
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const cfg = {
  once: flag('once'),
  replay: flag('replay'),
  from: opt('from') !== undefined ? num('from', 1) : undefined,
  alertOnReplay: flag('alert-on-replay'),
  intervalSec: num('interval', W.intervalSec),
  maxSpendShare: num('max-spend-share', W.maxSpendShare),
  maxSpend24hBudgets: opt('max-spend-24h') !== undefined ? num('max-spend-24h', 1) : undefined,
  epochSec: num('epoch-sec', W.epochSec),
  moveToleranceBps: num('move-tolerance', W.moveAwayToleranceBps),
  feeMarginBps: num('fee-margin', W.feeMarginBps),
  botBaseFeeBps: num('bot-base-fee', BD.baseFeeBps),
  botVolMultiplier: num('bot-vol-multiplier', BD.volMultiplier),
  botBehindFeeBps: num('bot-behind-fee', BD.behindFeeBps),
  botSingleVenueFeeAddBps: num('bot-single-venue-fee-add', BD.singleVenueFeeAddBps),
  maxGatewayLagSec: num('max-gateway-lag', 120),
  maxWindowSpendShare: num('max-window-spend', W.maxWindowSpendShare),
  spendWindowSec: num('spend-window', W.spendWindowSec),
  maxAnchorDrift: num('max-anchor-drift', W.maxAnchorDrift),
  maxPoolDrift: num('max-pool-drift', W.maxPoolDrift),
  venues: (opt('venues') ?? opt('sources') ?? 'ociswap,ociswap-precision,caviarnine,defiplaza').split(',').map((s) => s.trim()).filter(Boolean),
  quoteSizeXrd: num('quote-size', BD.quoteSizeXrd),
  scaleFlag: opt('scale'),
  minVenues: num('min-venues', BD.minVenues),
  maxSourceAgeSec: num('max-age', BD.maxSourceAgeSec),
  maxDisagreement: num('max-disagreement', BD.maxDisagreement),
  maxVenueFee: num('max-venue-fee', BD.maxVenueFee),
  noSentLog: flag('no-sent-log'),
  botSentLog: flag('no-sent-log') ? undefined : opt('bot-sent-log') ?? (MAINNET ? undefined : 'data/owner-pool-bot-sent.jsonl'),
  botState: opt('bot-state') ?? (MAINNET ? undefined : 'data/owner-pool-bot-stokenet-state.json'),
  alertUrl: opt('alert-url') ?? (process.env.OWNER_POOL_BOT_ALERT_URL || undefined),
  alertIntervalSec: num('alert-interval', W.alertIntervalSec),
  statePath: opt('state') ?? (MAINNET ? '' : 'data/owner-pool-watch-stokenet-state.json'),
  pool: opt('pool') ?? (MAINNET ? '' : 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk'),
  heartbeatPath: opt('heartbeat') ?? `data/heartbeat/owner-pool-watch-${NETWORK}.json`,
  markoutPath: argv.includes('--no-markout') ? undefined : opt('markout') ?? 'data/owner-pool-markout.jsonl',
  markoutHorizonsMin: (opt('markout-horizons') ?? '5,30').split(',').map(Number).filter((x) => x > 0),
};

const replaying = cfg.replay || cfg.from !== undefined;
const startAlerts = new AlertSink(cfg.alertUrl, { intervalMs: 1, prefix: `[owner-pool-watch ${NETWORK}] ` });
/** Refuse to run: log, alert (a start-up failure must be seen, M-5), exit 2. */
async function refuse(reason: string, problems?: string[]): Promise<never> {
  log({ event: 'refused', reason, ...(problems ? { problems } : {}) });
  if (!replaying) {
    const r = await startAlerts.alert('start-refused', `WATCHER REFUSED TO START: ${reason}${problems ? ': ' + problems.join(' | ') : ''}`.slice(0, 900), Date.now(), { force: true });
    log({ event: 'alert', key: 'start-refused', sent: r.sent, ...(r.error ? { error: r.error } : {}), ...(startAlerts.enabled ? {} : { noUrl: true }) });
  }
  process.exit(2);
}
const sc = resolveScale(NETWORK, cfg.scaleFlag);
if (!sc.ok) await refuse(sc.reason);
const SCALE = (sc as { scale: 'auto' | number }).scale;
{
  const problems = [...argErrors, ...flagRangeProblems({ intervalSec: cfg.intervalSec, minVenues: cfg.minVenues, maxSourceAgeSec: cfg.maxSourceAgeSec, maxDisagreement: cfg.maxDisagreement, maxVenueFee: cfg.maxVenueFee, quoteSizeXrd: cfg.quoteSizeXrd, alertIntervalSec: cfg.alertIntervalSec, maxGatewayLagSec: cfg.maxGatewayLagSec }, NETWORK)];
  if (MAINNET) {
    if (!opt('pool')) problems.push('--pool must be given on mainnet (no default)');
    if (!opt('state')) problems.push('--state must be given on mainnet (no default)');
    if (!cfg.botSentLog && !cfg.noSentLog) problems.push('--bot-sent-log <path> is required on mainnet, or --no-sent-log to run with the not-bot rule OFF (said at start)');
    if (cfg.botSentLog && !existsSync(cfg.botSentLog)) problems.push(`the bot's sent log ${cfg.botSentLog} does not exist (the bot creates it at start; or ship it here; or --no-sent-log)`);
    if (!replaying && !cfg.alertUrl) problems.push('an alert URL is required for a live mainnet watcher');
  }
  if (problems.length) await refuse(`${problems.length} start-up condition(s) not met`, problems);
}

// --gateway-url / --mainnet-gateway-url: another Gateway (your own, or for tests a local fault proxy).
const gw = new Gateway(NETWORKS[NETWORK], { url: opt('gateway-url') });
const mainnetGw = new Gateway(NETWORKS.mainnet, { url: opt('mainnet-gateway-url') });
const venues = makeVenues(cfg.venues, mainnetGw, { sizeXrd: cfg.quoteSizeXrd, smallFraction: BD.smallQuoteFraction });
const synthetic = cfg.venues.every((v) => v.startsWith('fixed:') || v.startsWith('file:'));
// Same hard guard as the bot: the reference never contains the watched pool or any OwnerPool component.
try { await assertReferenceExcludesOwnerPools(mainnetGw, cfg.venues, cfg.pool); } catch (e) { await refuse(String((e as Error)?.message ?? e)); }
const referencePair = OWNER_POOL_REFERENCE_PAIRS[NETWORK]!;
try {
  const p0 = (await readOwnerPools(gw, [cfg.pool], OWNER_POOL_PACKAGES[NETWORK]))[0]!;
  const why = pairProblem(p0, referencePair);
  if (why) throw new Error(`pair check: ${why}`);
} catch (e) { await refuse(String((e as Error)?.message ?? e)); }

interface State {
  /** Whose checkpoint this is (H-3): refused for another network or pool. */
  identity?: StateIdentity;
  /** The watcher's own healthy references, mapped (for the median and the volatility in the theft rules). */
  refs?: { at: number; price: number }[];
  next?: number;
  watch: WatchState;
  ownerAnchor?: OwnerAnchorStatement;
  calibration?: { reference: number; scale: number; anchor: [string, string]; at: string };
  alertLast?: Record<string, number>;
  /** Drift rules currently firing: logged when they start and when they clear, not on every tick. */
  drifting?: string[];
}
const identity: StateIdentity = { network: NETWORK, pool: cfg.pool };
let state!: State;
{
  let saved: State | undefined;
  if (!replaying) {
    try {
      const l = loadJsonWithBackup<State>(cfg.statePath);
      if (l.recovered) log({ event: 'state-recovered', note: l.recovered });
      saved = l.data;
    } catch (e) { await refuse(String((e as Error)?.message ?? e)); }
    if (saved) { const why = stateIdentityProblem(saved.identity, identity); if (why) await refuse(`${cfg.statePath}: ${why}`); }
  }
  state = { watch: { spends: [] }, ...(saved ?? {}), identity };
}
// A replay never overwrites the live checkpoint.
const saveState = () => { if (!replaying) saveJsonDurable(cfg.statePath, state); };
let tickCount = 0;
const beat = (ok: boolean, note?: string) => {
  if (replaying) return;
  try { writeHeartbeat(cfg.heartbeatPath, { program: 'owner-pool-watch', network: NETWORK, pool: cfg.pool, pid: process.pid, at: Date.now(), tick: tickCount, ok, ...(note ? { note } : {}) }); } catch { /* logged by the check */ }
};
const alerts = new AlertSink(cfg.alertUrl, { intervalMs: cfg.alertIntervalSec * 1000, last: state.alertLast, prefix: `[owner-pool-watch ${NETWORK}] ` });
state.alertLast = alerts.limiter.last;

/** The bot's sent log: every intent hash it submitted (written before submission). */
function botLog(): { txids: Set<string>; since?: number } | undefined {
  if (!cfg.botSentLog || !existsSync(cfg.botSentLog)) return undefined;
  const txids = new Set<string>();
  let since: number | undefined;
  for (const line of readFileSync(cfg.botSentLog, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j.txid === 'string') txids.add(j.txid);
      const at = Date.parse(j.at);
      if (Number.isFinite(at)) since = since === undefined ? at : Math.min(since, at);
    } catch { /* a torn last line: ignore */ }
  }
  return { txids, since };
}

async function report(f: WatchFinding, live: boolean): Promise<void> {
  const rec: Record<string, unknown> = { event: 'finding', ...f, ...(f.at ? { at: new Date(f.at).toISOString() } : {}) };
  const mode = watchAlertMode(f);
  if (mode !== 'none' && (live || cfg.alertOnReplay)) {
    const r = await alerts.alert(f.rule, `${f.severity.toUpperCase()} ${f.rule}: ${f.text}${f.txid ? ` (${f.txid})` : ''}`, Date.now(), { force: mode === 'force' });
    rec.alert = { sent: r.sent, ...(r.suppressed ? { suppressed: true } : {}), ...(r.error ? { error: r.error } : {}), ...(alerts.enabled ? {} : { noUrl: true }) };
  }
  log(rec);
}

let first = true;
async function tick(): Promise<void> {
  tickCount++;
  const pool = (await readOwnerPools(gw, [cfg.pool], OWNER_POOL_PACKAGES[NETWORK]))[0]!;
  const s = pool.split;
  if (!s) throw new Error(`${cfg.pool} is not a split OwnerPool`);
  const pairWhy = pairProblem(pool, referencePair);
  if (pairWhy) throw new Error(`pair check: ${pairWhy}`);
  const price = new Decimal(pool.reserveB).div(pool.reserveA).toNumber();

  // Where to start: replay from the first transaction, a given state version, the checkpoint, or now.
  if (state.next === undefined || (first && replaying)) {
    if (replaying) {
      state.next = cfg.from ?? 1;
      // From the pool's first transaction: instantiate emits no config event, so start from a fresh pool's.
      if (state.next <= 1) state.watch = { spends: [], ...structuredClone(REPLAY_BASELINE) };
    } else {
      state.next = (pool.stateVersion ?? 0) + 1;
      state.watch = { spends: [], config: { feeBps: pool.feeBps, paused: s.ownerPaused, operatorPaused: s.operatorPaused }, operator: s.operator, limits: limitsRecord(s.limits) };
      const f = await findOwnerAnchor(gw, cfg.pool);
      state.ownerAnchor = f.statement;
    }
  }
  // In a replay the live checks (drift, behavioural theft rules) describe now, not then: only on the first tick and after.
  const live = !(first && replaying);
  first = false;

  // Reference first (the behavioural rules compare each operator move with it). Quotes carry the mainnet
  // Gateway's ledger time (M-4).
  const now = Date.now();
  const ledgerAt = await mainnetGw.status().then((x) => Date.parse(x.timestamp), () => NaN);
  const rawQuotes = await Promise.all(venues.map(readVenueSource));
  const stamped = synthetic ? { quotes: rawQuotes, lagMs: 0, lagging: false } : stampLedgerTime(rawQuotes, ledgerAt, Date.now(), cfg.maxGatewayLagSec * 1000);
  const vref = aggregateVenues(stamped.quotes, now, { minVenues: cfg.minVenues, maxAgeMs: cfg.maxSourceAgeSec * 1000, maxDisagreement: cfg.maxDisagreement, maxRoundTrip: BD.maxRoundTrip, minImpactBps: BD.minImpactBps, maxVenueFee: cfg.maxVenueFee });
  const ref = vref.status === 'ok' ? { ok: true as const, price: vref.price, disagreement: vref.disagreement } : { ok: false as const, reason: vref.reason };
  let scale: number | undefined, scaleFrom = 'flag';
  if (SCALE !== 'auto') scale = SCALE;
  else {
    // Stokenet only (mainnet is always 1): take the bot's calibration, else calibrate to the owner anchor.
    const anchor = state.ownerAnchor?.anchor;
    let bot: any;
    try { bot = cfg.botState && existsSync(cfg.botState) ? JSON.parse(readFileSync(cfg.botState, 'utf8')) : undefined; } catch { bot = undefined; }
    if (anchor && bot?.calibration?.scale > 0 && bot.calibration.anchor?.join(':') === anchor.join(':')) { scale = bot.calibration.scale; scaleFrom = 'bot state'; }
    else if (anchor && state.calibration && state.calibration.anchor.join(':') === anchor.join(':')) { scale = state.calibration.scale; scaleFrom = 'own calibration'; }
    else if (anchor && ref.ok) {
      state.calibration = { reference: ref.price, scale: calibrateScale(ref.price, anchor), anchor, at: new Date(now).toISOString() };
      scale = state.calibration.scale; scaleFrom = 'calibrated now';
    }
  }
  const mapped = ref.ok && scale ? ref.price * scale : undefined;
  if (mapped && live) state.refs = [...(state.refs ?? []), { at: now, price: mapped }].filter((r) => now - r.at <= 6 * 3_600_000);
  const med = medianReference(state.refs ?? [], now, { n: REFERENCE_MEDIAN_N, maxAgeMs: REFERENCE_MEDIAN_N * cfg.intervalSec * 3 * 1000 });
  const volBps = volatilityBps(state.refs ?? [], now, BD.volWindowSec * 1000, cfg.intervalSec * 1000);
  const feeBounds = botFeeBounds({ baseFeeBps: cfg.botBaseFeeBps, volMultiplier: cfg.botVolMultiplier, volBps, behindFeeBps: cfg.botBehindFeeBps, singleVenueAddBps: cfg.botSingleVenueFeeAddBps, disagreeing: vref.status === 'disagree', minFeeBps: s.limits.minFeeBps, maxFeeBps: s.limits.maxFeeBps, marginBps: cfg.feeMarginBps });
  const liveCtx = live && !replaying ? {
    refs: mapped ? [mapped, ...(med.price ? [med.price] : [])] : [], healthy: !!mapped, reason: ref.ok ? (scale ? undefined : 'not calibrated') : ref.reason,
    toleranceBps: cfg.moveToleranceBps, feeBounds,
  } : undefined;
  const maxSpend24h = cfg.maxSpend24hBudgets ?? spend24hBudgets(s.limits.windowEpochs, cfg.epochSec);

  const bl = botLog();
  const r = await readOwnerPoolTransactions(gw, cfg.pool, state.next, { maxPages: 50, manifest: true });
  const findings: WatchFinding[] = [];
  for (const t of r.txs) {
    findings.push(...watchTransaction(t, state.watch, {
      operatorBadge: s.operator, ownerBadge: s.ownerBadge, budget: s.limits.moveBudgetBps / 10_000,
      botTxids: bl?.txids, botLogSince: bl?.since, maxSpendShare: cfg.maxSpendShare, maxSpend24hBudgets: maxSpend24h,
      maxWindowSpendShare: cfg.maxWindowSpendShare, spendWindowMs: cfg.spendWindowSec * 1000, live: liveCtx,
    }));
  }
  const newest = lastOwnerAnchor(r.txs);
  if (newest && (!state.ownerAnchor || newest.stateVersion > state.ownerAnchor.stateVersion)) state.ownerAnchor = newest;
  state.next = r.next;
  for (const f of findings) await report(f, live);

  // Markout (read only): record each swap with the reference now (the tick that saw it), and mark due trades.
  let markoutLine: Record<string, unknown> | undefined;
  if (cfg.markoutPath && !replaying) {
    const refNow: MarkoutRef | null = mapped && ref.ok ? { price: mapped, raw: ref.price, scale: scale!, at: now } : null;
    let trades = 0, marks = 0;
    for (const t of r.txs) for (const ev of t.events) {
      if (ev.name !== 'OwnerPoolSwapEvent') continue;
      const tr = tradeFromSwap(t, ev, pool.resourceA, pool.resourceB);
      if (!tr) continue;
      const rec = tradeRecord(tr, refNow);
      appendFileSync(cfg.markoutPath, JSON.stringify(rec) + '\n');
      trades++;
      log({ event: 'markout-trade', txid: tr.txid, side: tr.side, input: tr.inputAmount, output: tr.outputAmount, feeBps: tr.feeBps, feeA: rec.feeA, volumeA: rec.volumeA, tradePrice: tr.tradePrice, reference: refNow?.price ?? null, lagSec: Math.round((now - tr.at) / 1000) });
    }
    const records = existsSync(cfg.markoutPath) ? parseMarkoutLines(readFileSync(cfg.markoutPath, 'utf8')) : [];
    for (const d of dueMarks(records, now, cfg.markoutHorizonsMin)) {
      const m = markRecord(d.trade, d.horizonMin, now, refNow, price);
      appendFileSync(cfg.markoutPath, JSON.stringify(m) + '\n');
      marks++;
      log({ event: 'markout-mark', txid: d.trade.txid, horizonMin: d.horizonMin, lateSec: m.lateSec, markoutA: m.atRef?.markout ?? null, profitA: m.atRef ? d.trade.feeA + m.atRef.markout : null, atPoolMid: m.atPoolMid?.markout ?? null });
    }
    if (trades || marks) markoutLine = { trades, marks };
  }
  if (mapped) {
    const drift = driftFindings({ reference: mapped, poolPrice: price, ownerAnchor: state.ownerAnchor?.anchor, maxAnchorDrift: cfg.maxAnchorDrift, maxPoolDrift: cfg.maxPoolDrift });
    const before = new Set(state.drifting ?? []);
    for (const f of drift) {
      if (!before.has(f.rule)) await report(f, live);
      else if (live && alerts.limiter.allow(f.rule, Date.now())) {
        // Still drifting: re-alert once per interval, and log only that.
        alerts.limiter.clear(f.rule);
        await report(f, live);
      }
    }
    for (const r of before) if (!drift.some((f) => f.rule === r)) { log({ event: 'finding', rule: r, severity: 'info', text: `${r} cleared` }); alerts.limiter.clear(r); }
    state.drifting = drift.map((f) => f.rule);
  }
  log({
    event: 'tick', transactions: r.txs.length, complete: r.complete, next: state.next, findings: findings.length,
    pool: { price, feeBps: pool.feeBps, ownerPaused: s.ownerPaused, operatorPaused: s.operatorPaused, operator: s.operator, allowanceStored: s.allowance },
    ownerAnchor: state.ownerAnchor ? { anchor: state.ownerAnchor.anchor, txid: state.ownerAnchor.txid } : null,
    reference: ref.ok ? { price: ref.price, mapped, scale, scaleFrom, disagreement: Math.round(ref.disagreement * 1e5) / 1e5 } : { ok: false, reason: ref.reason },
    botLog: bl ? { txids: bl.txids.size, since: bl.since ? new Date(bl.since).toISOString() : null } : cfg.noSentLog ? 'OFF (--no-sent-log): not-bot rule off' : 'none: operator actions not compared',
    theftRules: liveCtx ? { refs: liveCtx.refs, healthy: liveCtx.healthy, feeBounds, volBps: Math.round(volBps * 100) / 100 } : 'off (replay)',
    mainnetGateway: synthetic ? 'not used' : { lagSec: Number.isFinite(stamped.lagMs) ? Math.round(stamped.lagMs / 1000) : null, lagging: stamped.lagging },
    spend24h: state.watch.spends.reduce((a, x) => a + x.cost, 0), spend24hLimitBudgets: Math.round(maxSpend24h * 1000) / 1000,
    ...(markoutLine ? { markout: markoutLine } : {}),
  });
}

let stopping = false, wake: (() => void) | undefined;
const stop = () => { stopping = true; wake?.(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
log({ event: 'start', network: NETWORK, pool: cfg.pool, mode: replaying ? 'replay' : 'live', scale: SCALE, config: { ...cfg, alertUrl: cfg.alertUrl ? '(set)' : undefined } });
if (!replaying) {
  // Said plainly at start: whether the not-bot rule is on, and what it can be trusted for (H-4).
  const nb = cfg.noSentLog ? 'not-bot rule OFF (--no-sent-log): operator actions are NOT compared with the bot\'s sent log; the behavioural rules (move-away, fee-outside-rule) and the spend rules still run'
    : cfg.botSentLog && existsSync(cfg.botSentLog) ? `not-bot rule ON (sent log ${cfg.botSentLog}); a log on the bot's host can be forged by a thief on that host`
    : `not-bot rule OFF until ${cfg.botSentLog} exists`;
  log({ event: 'not-bot-rule', text: nb });
  const r = await alerts.alert('start', `Watcher started (pid ${process.pid}) on ${cfg.pool.slice(0, 24)}...; ${nb}.`, Date.now(), { force: true });
  log({ event: 'alert', key: 'start', sent: r.sent, ...(r.error ? { error: r.error } : {}), ...(alerts.enabled ? {} : { noUrl: true }) });
}
beat(true, 'started');
let errors = 0;
while (!stopping) {
  try { await tick(); errors = 0; } catch (e) {
    errors++;
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    log({ event: 'error', consecutiveErrors: errors, message });
    if (errors >= 3) await alerts.alert('watch-errors', `Watcher failing: ${errors} ticks in a row. Last: ${message.slice(0, 200)}`);
    if (cfg.once) process.exitCode = 1;
  }
  saveState();
  beat(errors === 0, errors ? 'tick error' : undefined);
  if (cfg.once || stopping) break;
  await new Promise<void>((r) => { const t = setTimeout(r, Math.min(cfg.intervalSec * 1000 * 2 ** errors, 900_000)); wake = () => { clearTimeout(t); r(); }; });
}
saveState();
beat(false, 'stopped');
if (!replaying && !cfg.once) { const r = await alerts.alert('stop', `Watcher stopped after ${tickCount} ticks.`, Date.now(), { force: true }); log({ event: 'alert', key: 'stop', sent: r.sent }); }
log({ event: 'stopped' });
