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
//   --max-anchor-drift <f>   owner anchor vs reference (default 0.05); --max-pool-drift <f> pool vs reference (default 0.03)
//   --sources a,b,c --scale auto|<n> --max-disagreement <f> --min-sources <n> --max-age <s>   reference, as the bot's;
//                            --scale auto takes the bot's calibration from --bot-state, else calibrates to the owner anchor
//   --bot-sent-log <path>    the bot's sent log (default data/owner-pool-bot-sent.jsonl): operator actions not in it are flagged
//   --bot-state <path>       the bot's state file (default data/owner-pool-bot-state.json), read only, for the scale
//   --alert-url <url>        (or env OWNER_POOL_BOT_ALERT_URL) POST short text alerts there; --alert-interval <s> (default 3600)
//   --state <path>           the watcher's own checkpoint (default data/owner-pool-watch-state.json)
//   --interval <s> --pool <component> --network stokenet
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  AlertSink, Decimal, Gateway, NETWORKS, OWNER_POOL_BOT_DEFAULTS as BD, OWNER_POOL_PACKAGES, OWNER_POOL_WATCH_DEFAULTS as W, aggregateReference, calibrateScale,
  driftFindings, findOwnerAnchor, lastOwnerAnchor, readOwnerPoolTransactions, readOwnerPools, watchTransaction,
  type NetworkName, type OwnerAnchorStatement, type WatchFinding, type WatchState,
} from '../packages/core/src/index.ts';
import { makePriceSources, readSource } from './owner-pool-sources.ts';

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

const NETWORK = (opt('network') ?? 'stokenet') as NetworkName;
if (!NETWORKS[NETWORK]) throw new Error(`Unknown network ${NETWORK}`);
const cfg = {
  once: flag('once'),
  replay: flag('replay'),
  from: opt('from') !== undefined ? num('from', 1) : undefined,
  alertOnReplay: flag('alert-on-replay'),
  intervalSec: num('interval', W.intervalSec),
  maxSpendShare: num('max-spend-share', W.maxSpendShare),
  maxSpend24hBudgets: num('max-spend-24h', W.maxSpend24hBudgets),
  maxAnchorDrift: num('max-anchor-drift', W.maxAnchorDrift),
  maxPoolDrift: num('max-pool-drift', W.maxPoolDrift),
  sources: (opt('sources') ?? 'ociswap,caviarnine,coingecko').split(',').map((s) => s.trim()).filter(Boolean),
  scale: opt('scale') ?? 'auto',
  minSources: num('min-sources', BD.minSources),
  maxSourceAgeSec: num('max-age', BD.maxSourceAgeSec),
  maxDisagreement: num('max-disagreement', BD.maxDisagreement),
  botSentLog: opt('bot-sent-log') ?? 'data/owner-pool-bot-sent.jsonl',
  botState: opt('bot-state') ?? 'data/owner-pool-bot-state.json',
  alertUrl: opt('alert-url') ?? process.env.OWNER_POOL_BOT_ALERT_URL ?? undefined,
  alertIntervalSec: num('alert-interval', W.alertIntervalSec),
  statePath: opt('state') ?? 'data/owner-pool-watch-state.json',
  pool: opt('pool') ?? 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk',
};

const gw = new Gateway(NETWORKS[NETWORK]);
const mainnetGw = new Gateway(NETWORKS.mainnet);
const sources = makePriceSources(cfg.sources, mainnetGw);
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

interface State {
  next?: number;
  watch: WatchState;
  ownerAnchor?: OwnerAnchorStatement;
  calibration?: { reference: number; scale: number; anchor: [string, string]; at: string };
  alertLast?: Record<string, number>;
  /** Drift rules currently firing: logged when they start and when they clear, not on every tick. */
  drifting?: string[];
}
const state: State = existsSync(cfg.statePath) && !cfg.replay && cfg.from === undefined
  ? { watch: { spends: [] }, ...JSON.parse(readFileSync(cfg.statePath, 'utf8')) }
  : { watch: { spends: [] } };
const saveState = () => { const tmp = `${cfg.statePath}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n'); renameSync(tmp, cfg.statePath); };

const replaying = cfg.replay || cfg.from !== undefined;
const alerts = new AlertSink(cfg.alertUrl, { intervalMs: cfg.alertIntervalSec * 1000, last: state.alertLast, prefix: `[owner-pool-watch ${NETWORK}] ` });
state.alertLast = alerts.limiter.last;

/** The bot's sent log: every intent hash it submitted (written before submission). */
function botLog(): { txids: Set<string>; since?: number } | undefined {
  if (!existsSync(cfg.botSentLog)) return undefined;
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
  if (f.severity !== 'info' && (live || cfg.alertOnReplay)) {
    const r = await alerts.alert(f.rule, `${f.severity.toUpperCase()} ${f.rule}: ${f.text}${f.txid ? ` (${f.txid})` : ''}`);
    rec.alert = { sent: r.sent, ...(r.suppressed ? { suppressed: true } : {}), ...(r.error ? { error: r.error } : {}), ...(alerts.enabled ? {} : { noUrl: true }) };
  }
  log(rec);
}

let first = true;
async function tick(): Promise<void> {
  const now = Date.now();
  const pool = (await readOwnerPools(gw, [cfg.pool], OWNER_POOL_PACKAGES[NETWORK]))[0]!;
  const s = pool.split;
  if (!s) throw new Error(`${cfg.pool} is not a split OwnerPool`);
  const price = new Decimal(pool.reserveB).div(pool.reserveA).toNumber();

  // Where to start: replay from the first transaction, a given state version, the checkpoint, or now.
  if (state.next === undefined || (first && replaying)) {
    if (replaying) state.next = cfg.from ?? 1;
    else {
      state.next = (pool.stateVersion ?? 0) + 1;
      state.watch = { spends: [], config: { feeBps: pool.feeBps, paused: s.ownerPaused, operatorPaused: s.operatorPaused }, operator: s.operator };
      const f = await findOwnerAnchor(gw, cfg.pool);
      state.ownerAnchor = f.statement;
    }
  }
  // In a replay the live checks (drift) describe now, not then: only on the first tick and after.
  const live = !(first && replaying);
  first = false;

  const bl = botLog();
  const r = await readOwnerPoolTransactions(gw, cfg.pool, state.next, { maxPages: 50, manifest: true });
  const findings: WatchFinding[] = [];
  for (const t of r.txs) {
    findings.push(...watchTransaction(t, state.watch, {
      operatorBadge: s.operator, ownerBadge: s.ownerBadge, budget: s.limits.moveBudgetBps / 10_000,
      botTxids: bl?.txids, botLogSince: bl?.since, maxSpendShare: cfg.maxSpendShare, maxSpend24hBudgets: cfg.maxSpend24hBudgets,
    }));
  }
  const newest = lastOwnerAnchor(r.txs);
  if (newest && (!state.ownerAnchor || newest.stateVersion > state.ownerAnchor.stateVersion)) state.ownerAnchor = newest;
  state.next = r.next;
  for (const f of findings) await report(f, live);

  // Reference and drift (live state only).
  const samples = await Promise.all(sources.map(readSource));
  const ref = aggregateReference(samples, now, { minSources: cfg.minSources, maxAgeMs: cfg.maxSourceAgeSec * 1000, maxDisagreement: cfg.maxDisagreement });
  let scale: number | undefined, scaleFrom = 'flag';
  if (cfg.scale !== 'auto') scale = Number(cfg.scale);
  else {
    const anchor = state.ownerAnchor?.anchor;
    let bot: any;
    try { bot = existsSync(cfg.botState) ? JSON.parse(readFileSync(cfg.botState, 'utf8')) : undefined; } catch { bot = undefined; }
    if (anchor && bot?.calibration?.scale > 0 && bot.calibration.anchor?.join(':') === anchor.join(':')) { scale = bot.calibration.scale; scaleFrom = 'bot state'; }
    else if (anchor && state.calibration && state.calibration.anchor.join(':') === anchor.join(':')) { scale = state.calibration.scale; scaleFrom = 'own calibration'; }
    else if (anchor && ref.ok) {
      state.calibration = { reference: ref.price, scale: calibrateScale(ref.price, anchor), anchor, at: new Date(now).toISOString() };
      scale = state.calibration.scale; scaleFrom = 'calibrated now';
    }
  }
  const mapped = ref.ok && scale ? ref.price * scale : undefined;
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
    botLog: bl ? { txids: bl.txids.size, since: bl.since ? new Date(bl.since).toISOString() : null } : 'none: operator actions not compared',
    spend24h: state.watch.spends.reduce((a, x) => a + x.cost, 0),
  });
}

let stopping = false, wake: (() => void) | undefined;
const stop = () => { stopping = true; wake?.(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
log({ event: 'start', network: NETWORK, pool: cfg.pool, mode: replaying ? 'replay' : 'live', config: { ...cfg, alertUrl: cfg.alertUrl ? '(set)' : undefined } });
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
  if (cfg.once || stopping) break;
  await new Promise<void>((r) => { const t = setTimeout(r, Math.min(cfg.intervalSec * 1000 * 2 ** errors, 900_000)); wake = () => { clearTimeout(t); r(); }; });
}
saveState();
log({ event: 'stopped' });
