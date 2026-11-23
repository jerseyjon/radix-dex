import { median, priceDistance } from './ownerpool-bot.ts';
import { NETWORKS } from './types.ts';

/**
 * Start-up and run-time guards of the OwnerPool bot and watcher (scripts/owner-pool-bot.ts,
 * scripts/owner-pool-watch.ts), from the independent review of 23 Nov 2026
 * (docs/review-2026-11-23-bot-review.md). Everything here is pure: no I/O and no clock.
 */

// ------------------------------------------------------------------ the reference pair (H-1)

/** mainnet hUSDC (Hyperlane USDC), the B side of every reference venue. */
export const MAINNET_HUSDC = 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv';
/** Stokenet TEUR: the test pool's B side, the stand-in for hUSDC (it has no market; `--scale auto` maps it). */
export const STOKENET_TEUR = 'resource_tdx_2_1tknxk37t6tvqce4ce0jqv7ymydjfgjej4mw0wkdzep4wjfz8trvpj3';

/**
 * The pair the reference venues quote, in their orientation (prices are B per A: hUSDC per XRD), and
 * the pair an operated pool must have on each network. Mainnet: exactly the venues' XRD/hUSDC.
 * Stokenet: XRD/TEUR, the stand-in (the venues are read on mainnet; only relative moves are followed).
 */
export const OWNER_POOL_REFERENCE_PAIRS: Record<string, { a: string; b: string; label: string }> = {
  mainnet: { a: NETWORKS.mainnet.xrd, b: MAINNET_HUSDC, label: 'XRD/hUSDC' },
  stokenet: { a: NETWORKS.stokenet.xrd, b: STOKENET_TEUR, label: 'XRD/TEUR (stand-in for XRD/hUSDC)' },
};

/**
 * Whether the operated pool's (resource_a, resource_b) is the reference pair in the reference's
 * orientation. Undefined when it is; otherwise the reason (an inverted pool is named as such: its
 * target would move against the market).
 */
export function pairProblem(pool: { resourceA: string; resourceB: string }, want: { a: string; b: string; label: string }): string | undefined {
  if (pool.resourceA === want.a && pool.resourceB === want.b) return undefined;
  if (pool.resourceA === want.b && pool.resourceB === want.a) return `the pool is ${want.label} INVERTED (resource_a ${pool.resourceA}, resource_b ${pool.resourceB}): its price is the reciprocal of the reference, every move would go the wrong way`;
  return `the pool's pair (resource_a ${pool.resourceA}, resource_b ${pool.resourceB}) is not the reference pair ${want.label} (${want.a} / ${want.b})`;
}

// ------------------------------------------------------------------ scale (C-1)

/**
 * The scale the bot or watcher may use. Mainnet: only 1 (a real pair: anything else is a lasting price
 * error that neither the anchor stop nor the watcher can see); the default there is 1. Elsewhere: `auto`
 * (default, the Stokenet TEUR stand-in) or a positive number.
 */
export function resolveScale(network: string, flag: string | undefined): { ok: true; scale: 'auto' | number } | { ok: false; reason: string } {
  if (network === 'mainnet') {
    if (flag === undefined || Number(flag) === 1) return { ok: true, scale: 1 };
    return { ok: false, reason: `--scale ${flag} refused on mainnet: only 1 is allowed (C-1: auto or any other scale builds a lasting price error into every target)` };
  }
  if (flag === undefined || flag === 'auto') return { ok: true, scale: 'auto' };
  const x = Number(flag);
  if (!(x > 0) || !Number.isFinite(x)) return { ok: false, reason: `--scale must be auto or a positive number, not ${flag}` };
  return { ok: true, scale: x };
}

// ------------------------------------------------------------------ state identity (H-3)

export interface StateIdentity { network: string; pool: string; badge?: string; operatorAccount?: string }

/**
 * A state file belongs to one (network, pool, badge, operator account). A file without an identity
 * (written before 23 Nov 2026) or with another one is refused: loading it would bring another pool's
 * calibration, depth, spends, anchor cursor and halt into this one.
 */
export function stateIdentityProblem(saved: Partial<StateIdentity> | undefined, want: StateIdentity): string | undefined {
  if (!saved || !saved.network || !saved.pool) return 'the state file has no identity (network, pool, badge): it predates the identity check or is not this program\'s. Start a fresh state file (a new --state path)';
  const diffs: string[] = [];
  for (const k of ['network', 'pool', 'badge', 'operatorAccount'] as const) {
    if (want[k] !== undefined && saved[k] !== want[k]) diffs.push(`${k} ${saved[k] ?? '(none)'} != ${want[k]}`);
  }
  return diffs.length ? `the state file belongs to another run: ${diffs.join('; ')}` : undefined;
}

// ------------------------------------------------------------------ lock (L-1)

/** The lock file name for one pool on one network (the badge is not in it: two badges on one pool is still two bots). */
export function lockFileName(program: string, network: string, pool: string): string {
  return `${program}-${network}-${pool.replace(/[^a-z0-9_]/gi, '_')}.lock`;
}

/**
 * What to do with an existing lock: its content is "pid\nprogram\nstartedAt". `alive(pid)` says whether
 * that pid runs `program` now (PID reuse by another program counts as stale). Unreadable: stale.
 */
export function lockVerdict(content: string | undefined, alive: (pid: number, program: string) => boolean, selfPid: number): { stale: boolean; pid?: number; reason: string } {
  const [p, program] = (content ?? '').split('\n');
  const pid = Number(p);
  if (!Number.isInteger(pid) || pid <= 0) return { stale: true, reason: 'lock unreadable' };
  if (pid === selfPid) return { stale: true, pid, reason: 'our own pid' };
  if (alive(pid, program ?? '')) return { stale: false, pid, reason: `pid ${pid} (${program}) holds it` };
  return { stale: true, pid, reason: `pid ${pid} is gone` };
}

// ------------------------------------------------------------------ numeric flags (L-2)

/** Allowed range of each numeric flag [min, max] (inclusive), and a tighter one on mainnet where given. */
export const OWNER_POOL_FLAG_RANGES: Record<string, { min: number; max: number; mainnetMax?: number; mainnetMin?: number; integer?: boolean }> = {
  intervalSec: { min: 5, max: 3600, mainnetMin: 20 },
  minVenues: { min: 1, max: 10, integer: true },
  maxSourceAgeSec: { min: 10, max: 3600, mainnetMax: 600 },
  maxDisagreement: { min: 0, max: 0.2, mainnetMax: 0.05 },
  quoteSizeXrd: { min: 1, max: 1_000_000 },
  smallQuoteFraction: { min: 0.01, max: 0.9 },
  minImpactBps: { min: 0, max: 1000 },
  maxRoundTrip: { min: 0, max: 0.5, mainnetMax: 0.1 },
  maxVenueFee: { min: 0, max: 0.1, mainnetMax: 0.01 },
  venueHoldSec: { min: 0, max: 86_400, mainnetMin: 300 },
  confirmTicks: { min: 1, max: 20, integer: true },
  singleVenueFeeAddBps: { min: 0, max: 1000 },
  singleVenueSizeFactor: { min: 0.01, max: 1 },
  disagreeFeeFactor: { min: 0, max: 10 },
  watchMaxDeviation: { min: 0.001, max: 1 },
  spendWindowSec: { min: 60, max: 86_400 },
  maxWindowSpendShare: { min: 0.01, max: 1 },
  pauseAfterSec: { min: 0, max: 86_400, mainnetMax: 3600 },
  resumeAfterSec: { min: 0, max: 86_400 },
  deadBandBps: { min: 0, max: 1000 },
  spendFraction: { min: 0.01, max: 1 },
  reserveFraction: { min: 0, max: 0.99 },
  minMoveBps: { min: 0, max: 1000 },
  targetDepth: { min: 0, max: 1e15 },
  maxAnchorDistance: { min: 0.001, max: 0.5, mainnetMax: 0.1 },
  anchorResumeFactor: { min: 0.1, max: 1 },
  anchorStrikes: { min: 1, max: 10, integer: true },
  referenceMedianN: { min: 1, max: 15, integer: true, mainnetMin: 3 },
  baseFeeBps: { min: 0, max: 10_000 },
  volMultiplier: { min: 0, max: 100 },
  volWindowSec: { min: 60, max: 86_400 },
  behindFeeBps: { min: 0, max: 1000 },
  minFeeChangeBps: { min: 0, max: 1000 },
  widenIntervalSec: { min: 0, max: 86_400 },
  narrowIntervalSec: { min: 0, max: 86_400 },
  maxTxPerHour: { min: 1, max: 120, integer: true, mainnetMax: 30 },
  maxConsecutiveFailures: { min: 1, max: 20, integer: true },
  maxRaceFailures: { min: 1, max: 100, integer: true },
  haltSec: { min: 60, max: 86_400 },
  anchorRecheckSec: { min: 10, max: 3600 },
  alertIntervalSec: { min: 60, max: 86_400 },
  alertBehindTicks: { min: 1, max: 1000, integer: true },
  alertErrorTicks: { min: 1, max: 1000, integer: true },
  maxGatewayLagSec: { min: 10, max: 3600, mainnetMax: 300 },
  txValiditySec: { min: 30, max: 600 },
  brakeMaxDeviation: { min: 0.002, max: 0.15, mainnetMax: 0.05 },
  brakeWarmupDeviation: { min: 0.01, max: 0.5 },
  brakeMinReadings: { min: 1, max: 288, integer: true, mainnetMin: 6 },
  brakeSampleSec: { min: 10, max: 3600, mainnetMin: 60 },
};

/** Every numeric flag outside its range (the mainnet range on mainnet). Unknown keys are not checked. */
export function flagRangeProblems(values: Record<string, number | undefined | null>, network: string, ranges = OWNER_POOL_FLAG_RANGES): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const r = ranges[k];
    if (!r || v === undefined || v === null) continue;
    const min = network === 'mainnet' && r.mainnetMin !== undefined ? r.mainnetMin : r.min;
    const max = network === 'mainnet' && r.mainnetMax !== undefined ? r.mainnetMax : r.max;
    if (!Number.isFinite(v) || v < min || v > max) out.push(`${k} = ${v} is outside ${min}..${max}${network === 'mainnet' && (r.mainnetMin !== undefined || r.mainnetMax !== undefined) ? ' (mainnet)' : ''}`);
    else if (r.integer && !Number.isInteger(v)) out.push(`${k} = ${v} must be a whole number`);
  }
  return out;
}

/**
 * The value of `--name`, or undefined when absent. A flag given with no value, or followed by another
 * flag (`--scale --send`), throws, so it cannot silently swallow the next flag.
 */
export function optValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || /^--[a-z]/.test(v)) throw new Error(`--${name} needs a value`);
  return v;
}

// ------------------------------------------------------------------ the mainnet --send guard

/** Pools the bot may SEND for on mainnet. Committed in code, filled only on the owner's explicit go-ahead. */
export const MAINNET_SEND_POOLS: readonly string[] = [];

export interface SendGuardInput {
  network: string;
  send: boolean;
  /** The --scale flag as given (undefined: not given). */
  scaleFlag?: string;
  /** Which of pool, badge, key, state, sent-log were given on the command line. */
  explicit: { pool: boolean; badge: boolean; key: boolean; state: boolean; sentLog: boolean };
  venues: string[];
  excludeVenues: boolean;
  ownerAnchorFlag: boolean;
  alertUrl?: string;
  /** The separate acknowledgement flag (--mainnet-live). */
  ack: boolean;
  /** CoinGecko is among the watch sources (the brake needs it). Undefined: not checked. */
  coingecko?: boolean;
  pool: string;
  /** OWNER_POOL_PACKAGES.mainnet and MAINNET_SEND_POOLS, passed in so the rule is testable. */
  mainnetPackages: readonly string[];
  sendPools: readonly string[];
}

/**
 * The conditions that must ALL hold before the bot may start with --send on mainnet (review, "The
 * mainnet --send guard", and docs/MAINNET-POOLS.md section 5). Checked before any key is read. Returns
 * every unmet condition (empty: the static guard passes); the ledger conditions (the pool's pair and
 * package) and the delivered test alert are checked after, at start-up. Off mainnet: --send needs only
 * an alert URL (M-6).
 */
export function sendGuardProblems(o: SendGuardInput): string[] {
  if (!o.send) return [];
  const out: string[] = [];
  if (!o.alertUrl) out.push('--send needs an alert URL (--alert-url or OWNER_POOL_BOT_ALERT_URL); a start alert is sent and must be delivered (M-6)');
  if (o.network !== 'mainnet') return out;
  if (o.scaleFlag !== undefined && Number(o.scaleFlag) !== 1) out.push(`--scale ${o.scaleFlag}: only --scale 1 on mainnet (C-1)`);
  const missing = (Object.entries(o.explicit) as [string, boolean][]).filter(([, v]) => !v).map(([k]) => `--${k === 'sentLog' ? 'sent-log' : k}`);
  if (missing.length) out.push(`${missing.join(', ')} must be given explicitly on mainnet: there are no mainnet defaults (H-3)`);
  const synthetic = o.venues.filter((v) => v.startsWith('fixed:') || v.startsWith('file:'));
  if (synthetic.length) out.push(`synthetic venues ${synthetic.join(', ')} are test inputs, refused with --send on mainnet (L-3)`);
  if (o.excludeVenues) out.push('--exclude-venues / --exclude-venues-file are drill inputs, refused with --send on mainnet (L-3)');
  if (o.ownerAnchorFlag) out.push('--owner-anchor is a fallback for tests, refused with --send on mainnet: the anchor must come from the ledger (L-3)');
  if (!o.mainnetPackages.length) out.push('OWNER_POOL_PACKAGES.mainnet is empty: the audited OwnerPool package must be listed in packages/core/src/ownerpool.ts (and committed) first');
  if (!o.sendPools.includes(o.pool)) out.push(`the pool ${o.pool || '(none)'} is not in MAINNET_SEND_POOLS (packages/core/src/ownerpool-guard.ts), the committed allow-list of pools the owner approved for sending (empty until he does)`);
  if (o.coingecko === false) out.push('CoinGecko is not a watch source (--no-watch or --watch-sources without coingecko): the CoinGecko brake would never engage');
  if (!o.ack) out.push('--mainnet-live is missing: the separate acknowledgement that this run trades real funds (so a copied Stokenet command line cannot reach mainnet by changing --network alone)');
  return out;
}

// ------------------------------------------------------------------ the reference target (H-2)

/** How many healthy reference readings the target is the median of (owner's open question: N=3, see docs). */
export const REFERENCE_MEDIAN_N = 3;

/**
 * The target reference: the median of the last `n` healthy readings no older than `maxAgeMs`. With fewer
 * than `n` such readings there is no target yet (warming up), so one manipulated tick can never be the
 * target on its own: with n = 3 it must be held for 2 of 3 ticks. Readings are pushed by the caller on
 * every tick whose reference is healthy (from the full confirmed venue set).
 */
export function medianReference(readings: { at: number; price: number }[], now: number, o: { n: number; maxAgeMs: number }): { price?: number; used: number; reason?: string } {
  const fresh = readings.filter((r) => r.at <= now && now - r.at <= o.maxAgeMs && r.price > 0).sort((a, b) => a.at - b.at).slice(-o.n);
  if (fresh.length < o.n) return { used: fresh.length, reason: `warming up: ${fresh.length} of ${o.n} healthy reference readings in the last ${Math.round(o.maxAgeMs / 1000)} s` };
  return { price: median(fresh.map((r) => r.price)), used: fresh.length };
}

/**
 * The anchor stop needs `need` consecutive ticks beyond the owner's anchor distance before the bot
 * pauses the pool (a one-tick spike on a thin venue cannot pause it). The bot still stops FOLLOWING at
 * once; only the pause waits. `strikes` is kept in the state file.
 */
export function anchorStrike(prev: number | undefined, ok: boolean, need: number): { strikes: number; confirmed: boolean } {
  const strikes = ok ? 0 : (prev ?? 0) + 1;
  return { strikes, confirmed: strikes >= Math.max(1, need) };
}

/**
 * The shape of an off-ledger veto: it may only stop the bot (no rebalance, no fee narrowing), never be a
 * price. The bot's one veto is the CoinGecko brake (`coingeckoBrake`, owner's decision 23 Nov 2026);
 * this type and NO_REFERENCE_VETO remain for a second off-ledger source.
 */
export type ReferenceVeto = (o: { reference: number; watch: { source: string; price: number; at: number; error?: string }[]; now: number }) => string | undefined;
export const NO_REFERENCE_VETO: ReferenceVeto = () => undefined;

// ------------------------------------------------------------------ halt, cap and races (M-2)

/** A commit failure caused by a swap landing between the bot's read and its rebalance (the `expected` guard). */
export const isReserveRace = (error: string | undefined): boolean => !!error && /Reserves moved/.test(error);

/**
 * Whether a send must go out even while halted or at the hourly cap: the protective pause
 * (set_operator_paused(true)) and a fee WIDEN. Everything else (rebalance, unpause, narrowing) waits.
 */
export const isProtectiveSend = (type: string, o: { feeFrom?: number; feeTo?: number } = {}): boolean =>
  type === 'set_operator_paused(true)' || (type.startsWith('operator_set_fee') && o.feeFrom !== undefined && o.feeTo !== undefined && o.feeTo > o.feeFrom);

/**
 * After a send, like `recordSendOutcome`, but a "Reserves moved" failure (a swap raced the rebalance:
 * by design, harmless) does not count toward the halt; it counts toward its own, higher limit
 * (`maxRaces` in a row) and leaves the failure count alone.
 */
export function recordSendOutcomeV2(st: { consecutiveFailures: number; consecutiveRaces?: number; haltedUntil?: number }, outcome: { ok: boolean; error?: string }, now: number, o: { maxFailures: number; maxRaces: number; haltMs: number }): {
  consecutiveFailures: number; consecutiveRaces: number; haltedUntil?: number; halted: boolean; recovered: boolean; race: boolean;
} {
  const race = !outcome.ok && isReserveRace(outcome.error);
  if (race) {
    const consecutiveRaces = (st.consecutiveRaces ?? 0) + 1;
    if (consecutiveRaces >= o.maxRaces) return { consecutiveFailures: st.consecutiveFailures, consecutiveRaces, haltedUntil: now + o.haltMs, halted: true, recovered: false, race };
    return { consecutiveFailures: st.consecutiveFailures, consecutiveRaces, haltedUntil: st.haltedUntil, halted: false, recovered: false, race };
  }
  const consecutiveFailures = outcome.ok ? 0 : st.consecutiveFailures + 1;
  const consecutiveRaces = outcome.ok ? 0 : st.consecutiveRaces ?? 0;
  const recovered = outcome.ok && (st.consecutiveFailures >= o.maxFailures || (st.consecutiveRaces ?? 0) >= o.maxRaces);
  if (consecutiveFailures >= o.maxFailures) return { consecutiveFailures, consecutiveRaces, haltedUntil: now + o.haltMs, halted: true, recovered, race };
  return { consecutiveFailures, consecutiveRaces, haltedUntil: st.haltedUntil, halted: false, recovered, race };
}

// ------------------------------------------------------------------ validity and ordering (M-3)

/** Transaction validity: two epochs, and the proposer timestamp bound `validitySec` after the LEDGER's time. */
export function txWindow(epoch: number, ledgerTimestamp: string, validitySec: number): { startEpoch: number; endEpoch: number; expiresAt: number } {
  const t = Date.parse(ledgerTimestamp);
  if (!Number.isFinite(t)) throw new Error(`ledger timestamp unreadable: ${ledgerTimestamp}`);
  return { startEpoch: epoch, endEpoch: epoch + 2, expiresAt: Math.floor(t / 1000) + validitySec };
}

/** A sent transaction whose final status is not known yet (a Timeout). */
export interface PendingTx { txid: string; type: string; at: number; expiresAt: number; plannedCost?: number; reason?: string }

/**
 * Whether an earlier unresolved send blocks new sends. Until it is resolved (committed, failed, or its
 * validity has passed on the LEDGER's clock plus a margin), no new transaction is sent, so a late
 * pause/fee transaction can never land after a newer one.
 */
export function pendingGate(p: PendingTx | undefined, ledgerNowSec: number, marginSec = 30): 'none' | 'wait' | 'expired' {
  if (!p) return 'none';
  return ledgerNowSec >= p.expiresAt + marginSec ? 'expired' : 'wait';
}

// ------------------------------------------------------------------ Gateway lag (M-4)

/**
 * Venue quotes are as old as the ledger state the Gateway previewed them on, not the local clock. Each
 * quote's `at` becomes the mainnet Gateway's proposer round timestamp; when that is more than `maxLagMs`
 * behind `now`, every quote fails (a lagging Gateway prices an old ledger).
 */
export function stampLedgerTime<Q extends { at: number; error?: string }>(quotes: Q[], ledgerAtMs: number, now: number, maxLagMs: number): { quotes: Q[]; lagMs: number; lagging: boolean } {
  const lagMs = now - ledgerAtMs;
  const lagging = !Number.isFinite(lagMs) || lagMs > maxLagMs;
  return {
    lagMs, lagging,
    quotes: quotes.map((q) => (q.error ? q : lagging ? { ...q, error: `mainnet Gateway lagging: ledger ${Math.round(lagMs / 1000)} s behind (limit ${Math.round(maxLagMs / 1000)} s)` } : { ...q, at: ledgerAtMs })),
  };
}

// ------------------------------------------------------------------ heartbeat (M-5)

export interface Heartbeat { program: string; network: string; pool: string; pid: number; at: number; tick: number; ok: boolean; note?: string }

/** Each heartbeat file's verdict: missing, unreadable, or older than `maxAgeMs` is a dead process. */
export function heartbeatVerdict(content: string | undefined, now: number, maxAgeMs: number): { alive: boolean; reason: string; beat?: Heartbeat } {
  if (content === undefined) return { alive: false, reason: 'no heartbeat file' };
  let b: Heartbeat;
  try { b = JSON.parse(content); } catch { return { alive: false, reason: 'heartbeat file unreadable' }; }
  if (!Number.isFinite(b?.at)) return { alive: false, reason: 'heartbeat has no time' };
  const age = now - b.at;
  if (age > maxAgeMs) return { alive: false, reason: `last beat ${Math.round(age / 1000)} s ago (limit ${Math.round(maxAgeMs / 1000)} s), pid ${b.pid}, tick ${b.tick}`, beat: b };
  return { alive: true, reason: `beat ${Math.round(age / 1000)} s ago`, beat: b };
}

// ------------------------------------------------------------------ target depth (L-4)

/**
 * The depth `--side balanced` steers toward: explicit config wins; otherwise re-read from the reserves
 * whenever the OWNER changed them (an OwnerPoolLiquidityEvent or an owner rebalance newer than the one
 * the depth was taken after), and on the first start.
 */
export function targetDepthUpdate(o: { configured?: number; saved?: { depth: number; afterStateVersion: number }; ownerChangeStateVersion?: number; reserveA: number; reserveB: number; stateVersion: number }): { depth: number; afterStateVersion: number; reset: boolean } {
  if (o.configured !== undefined) return { depth: o.configured, afterStateVersion: o.stateVersion, reset: false };
  const fromReserves = () => ({ depth: Math.sqrt(o.reserveA * o.reserveB), afterStateVersion: o.stateVersion });
  if (!o.saved) return { ...fromReserves(), reset: true };
  if (o.ownerChangeStateVersion !== undefined && o.ownerChangeStateVersion > o.saved.afterStateVersion) return { ...fromReserves(), reset: true };
  return { ...o.saved, reset: false };
}

// ------------------------------------------------------------------ spend in 24 h (L-5)

/**
 * The most the operator can legitimately spend in 24 h, in budgets: the full allowance at the start plus
 * the refill over 24 h (one budget per window of `windowEpochs` x `epochSec`). On mainnet (5-minute
 * epochs, 144-epoch window = 12 h) that is 3 budgets; with a 72-epoch window, 5.
 */
export function spend24hBudgets(windowEpochs: number, epochSec: number): number {
  if (!(windowEpochs > 0 && epochSec > 0)) return 1;
  return 1 + 86_400 / (windowEpochs * epochSec);
}

// ------------------------------------------------------------------ behavioural theft rule (H-4)

/**
 * The bot's fee rule can only produce fees in [lo, hi]: never below the base fee (its rule only adds),
 * and above it only by volatility, being behind, the single-venue add and the venues' disagreement, all
 * clamped to the owner's range. The watcher bounds volatility by its own measure (x `volSlack`) and adds
 * `marginBps`. While its venues disagree the bot may widen to the range's top, so `hi` is the max then.
 */
export function botFeeBounds(o: { baseFeeBps: number; volMultiplier: number; volBps: number; behindFeeBps: number; singleVenueAddBps: number; disagreeing: boolean; minFeeBps: number; maxFeeBps: number; marginBps: number; volSlack?: number }): { lo: number; hi: number } {
  const clamp = (x: number) => Math.min(o.maxFeeBps, Math.max(o.minFeeBps, x));
  const lo = clamp(o.baseFeeBps - o.marginBps);
  const hi = o.disagreeing ? o.maxFeeBps : clamp(o.baseFeeBps + o.volMultiplier * o.volBps * (o.volSlack ?? 2) + o.behindFeeBps + o.singleVenueAddBps + o.marginBps);
  return { lo, hi };
}

/**
 * An operator rebalance that leaves the pool FURTHER from the reference than it was is never the bot's
 * (it only moves toward its target). `refs` are the watcher's current reference and its recent median
 * (both mapped onto the pool): the move counts as "away" only if it is away from every one of them by
 * more than `toleranceBps`, so a bot target that lags the watcher's reading by a tick is not flagged.
 */
export function moveAwayFromReference(before: number, after: number, refs: number[], toleranceBps: number): { away: boolean; gapBeforeBps: number; gapAfterBps: number } | undefined {
  const rs = refs.filter((r) => r > 0 && Number.isFinite(r));
  if (!rs.length || !(before > 0 && after > 0)) return undefined;
  const gaps = rs.map((r) => ({ b: priceDistance(before, r) * 10_000, a: priceDistance(after, r) * 10_000 }));
  const away = gaps.every((g) => g.a > g.b + toleranceBps);
  const g0 = gaps[0]!;
  return { away, gapBeforeBps: g0.b, gapAfterBps: g0.a };
}

// ------------------------------------------------------------------ CoinGecko brake (H-2, owner's decision 23 Nov 2026)

/** Persisted in the bot's state file. */
export interface BrakeState {
  /** Ratios on-ledger reference / CoinGecko, sampled at most once per `sampleMs`, last `windowMs`. */
  ratios: { at: number; r: number }[];
  /** Start of the current brake episode (undefined: not braking). */
  since?: number;
  /** Since when CoinGecko has been unavailable or stale (undefined: it is fine). */
  unavailableSince?: number;
}

export const COINGECKO_BRAKE_DEFAULTS = {
  /** The ratio more than this from its rolling normal: no rebalance this tick. */
  maxDeviation: 0.02,
  /** Before the normal has `minReadings`: only a deviation beyond this (the old watch alarm) brakes. */
  warmupDeviation: 0.15,
  minReadings: 12,
  /** The rolling normal is the median ratio over this window... */
  windowMs: 24 * 3_600_000,
  /** ...sampled at most this often (288 a day), so a burst of ticks cannot dominate it. */
  sampleMs: 300_000,
  /** A CoinGecko price older than this (its own last_updated_at) counts as unavailable. */
  maxAgeMs: 15 * 60_000,
  /** Unavailable for longer than this: alert (trading continues). */
  unavailableAlertMs: 3_600_000,
};

/**
 * The CoinGecko BRAKE. CoinGecko is never a price: only the ratio reference / CoinGecko is tracked, and
 * when the current ratio is more than `maxDeviation` from its rolling normal (the median over the last
 * 24 h; `warmupDeviation` from the latest ratio until `minReadings` exist... see below) the bot does not
 * rebalance on that tick. It never pauses the pool by itself and never changes a price or an amount.
 * - Warm-up (fewer than `minReadings` ratios): the normal is 1 (reference and CoinGecko both quote USD per
 *   XRD), and only a deviation beyond `warmupDeviation` brakes.
 * - Every healthy reading enters the normal, braking or not (a lasting real divergence is learned after
 *   ~12 h; a manipulation would have to be held that long).
 * - CoinGecko unavailable or stale: no brake signal (trading continues on the median and two-tick
 *   protections), `unavailableLong` after `unavailableAlertMs`.
 * `reference` undefined (unhealthy, or not comparable): nothing is recorded, no brake.
 */
export function coingeckoBrake(prev: BrakeState | undefined, o: { reference?: number; coingecko?: { price: number; at: number; error?: string }; now: number }, c: Partial<typeof COINGECKO_BRAKE_DEFAULTS> = {}): {
  state: BrakeState; braking: boolean; mode: 'warmup' | 'normal' | 'unavailable' | 'no-reference'; ratio?: number; normal?: number; deviation?: number; threshold: number;
  started: boolean; ended: boolean; unavailableLong: boolean; readings: number;
} {
  const k = { ...COINGECKO_BRAKE_DEFAULTS, ...c };
  const st: BrakeState = { ratios: (prev?.ratios ?? []).filter((x) => o.now - x.at <= k.windowMs && x.at <= o.now), since: prev?.since, unavailableSince: prev?.unavailableSince };
  const wasBraking = st.since !== undefined;
  const cg = o.coingecko;
  const cgOk = !!cg && !cg.error && cg.price > 0 && o.now - cg.at <= k.maxAgeMs;
  const end = (mode: 'unavailable' | 'no-reference', threshold: number) => {
    st.since = undefined;
    return { state: st, braking: false, mode, threshold, started: false, ended: wasBraking, unavailableLong: st.unavailableSince !== undefined && o.now - st.unavailableSince >= k.unavailableAlertMs, readings: st.ratios.length };
  };
  if (!cgOk) { st.unavailableSince ??= o.now; return end('unavailable', k.maxDeviation); }
  st.unavailableSince = undefined;
  if (!(o.reference! > 0)) return end('no-reference', k.maxDeviation);
  const ratio = o.reference! / cg!.price;
  const warm = st.ratios.length >= k.minReadings;
  const normal = warm ? median(st.ratios.map((x) => x.r)) : 1;
  const threshold = warm ? k.maxDeviation : k.warmupDeviation;
  const deviation = priceDistance(ratio, normal);
  const last = st.ratios[st.ratios.length - 1];
  if (!last || o.now - last.at >= k.sampleMs) st.ratios.push({ at: o.now, r: ratio });
  const braking = deviation > threshold;
  if (braking) st.since ??= o.now; else st.since = undefined;
  return { state: st, braking, mode: warm ? 'normal' : 'warmup', ratio, normal, deviation, threshold, started: braking && !wasBraking, ended: !braking && wasBraking, unavailableLong: false, readings: st.ratios.length };
}
