import { Decimal } from './manifest.ts';
import { OwnerPoolQuoteError, type OwnerPoolState } from './ownerpool.ts';
import { ownerPoolAllowanceNow, ownerPoolPlanRebalance, type OwnerPoolRebalancePlan } from './ownerpool-ops.ts';

/**
 * Decision logic of the OwnerPool market-making bot (scripts/owner-pool-bot.ts, docs/owner-pool-bot.md).
 * Everything here is pure: no I/O, no clock (the caller passes `now`), so every rule is unit-tested.
 *
 * Prices are always "token B per token A" (the pool's reserveB / reserveA). For the Stokenet pool
 * XRD/TEUR that is TEUR per XRD (0.0008 at the 1250:1 anchor); for a reference read as "USD per XRD"
 * the same orientation holds. A reference is mapped onto the pool by `scale` (see `poolTargetPrice`).
 */

// ------------------------------------------------------------------ defaults

/** Every default, with its reason in docs/owner-pool-bot.md. Seconds unless the name says otherwise. */
export const OWNER_POOL_BOT_DEFAULTS = {
  intervalSec: 60,
  /** Reference health. */
  minSources: 2,
  maxSourceAgeSec: 300,
  /** Highest / lowest fresh source - 1. */
  maxDisagreement: 0.02,
  /** Unhealthy reference for this long: set the operator pause. Healthy for this long: clear it (only if the bot set it). */
  pauseAfterSec: 600,
  resumeAfterSec: 900,
  /** Rebalance. `deadBandBps: null` = half the pool's current fee. */
  deadBandBps: null as number | null,
  spendFraction: 0.5,
  /** Part of ONE full budget the bot never spends (kept for a sudden move). */
  reserveFraction: 0.1,
  /** A planned move smaller than this (price change, bps) is not worth a transaction. */
  minMoveBps: 3,
  side: 'balanced' as RebalanceSide,
  /** Stop following (and pause) when the mapped reference is this far from the OWNER's anchor. */
  maxAnchorDistance: 0.05,
  /** ...and resume only once it is back within this fraction of that distance. */
  anchorResumeFactor: 0.8,
  /** Fee rule. */
  baseFeeBps: 30,
  volMultiplier: 2,
  volWindowSec: 3600,
  behindFeeBps: 10,
  minFeeChangeBps: 5,
  widenIntervalSec: 120,
  narrowIntervalSec: 900,
  /** Operational. */
  maxTxPerHour: 12,
  maxConsecutiveFailures: 3,
  haltSec: 3600,
  feeLockXrd: '5',
  historyKeepSec: 6 * 3600,
  /** Re-read the owner's anchor statement from the ledger this often. */
  anchorRecheckSec: 300,
  /** Alerts: one per condition per interval; "behind" after this many ticks in a row; tick errors after this many. */
  alertIntervalSec: 3600,
  alertBehindTicks: 10,
  alertErrorTicks: 3,
};

export type RebalanceSide = 'balanced' | 'remove' | 'add';

/** d(x, y) = max(x/y, y/x) - 1: the distance the contract's budget uses, here on numbers. */
export function priceDistance(x: number, y: number): number {
  if (!(x > 0 && y > 0)) return Infinity;
  return Math.max(x / y, y / x) - 1;
}

// ------------------------------------------------------------------ reference price

export interface PriceSample {
  source: string;
  /** Token B per token A in the source's own unit (e.g. USD per XRD). */
  price: number;
  /** When the price was true (ms since epoch): the source's own timestamp where it gives one. */
  at: number;
  error?: string;
}

export type ReferenceResult =
  | { ok: true; price: number; fresh: PriceSample[]; disagreement: number }
  | { ok: false; reason: string; fresh: PriceSample[]; disagreement?: number };

export function median(xs: number[]): number {
  if (!xs.length) throw new Error('median of nothing');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * The reference: the median of the FRESH sources (no error, positive, not older than `maxAgeMs`,
 * not more than a minute in the future). Refused when fewer than `minSources` are fresh, or when
 * the highest and lowest fresh source differ by more than `maxDisagreement` (max/min - 1).
 */
export function aggregateReference(samples: PriceSample[], nowMs: number, o: { minSources: number; maxAgeMs: number; maxDisagreement: number }): ReferenceResult {
  const fresh = samples.filter((s) => !s.error && Number.isFinite(s.price) && s.price > 0 && nowMs - s.at <= o.maxAgeMs && s.at <= nowMs + 60_000);
  if (fresh.length < Math.max(1, o.minSources)) {
    return { ok: false, reason: `only ${fresh.length} fresh source(s), need ${o.minSources}`, fresh };
  }
  const prices = fresh.map((s) => s.price);
  const disagreement = Math.max(...prices) / Math.min(...prices) - 1;
  if (disagreement > o.maxDisagreement) {
    return { ok: false, reason: `sources disagree by ${(disagreement * 100).toFixed(2)}% (bound ${(o.maxDisagreement * 100).toFixed(2)}%)`, fresh, disagreement };
  }
  return { ok: true, price: median(prices), fresh, disagreement };
}

/**
 * The pool price the bot aims for: reference * scale. On mainnet against a real pair the scale is 1.
 * TEUR on Stokenet has no market, so the scale is calibrated once (`calibrateScale`): the reference
 * seen at calibration maps to the OWNER's anchor price, and the pool then follows the reference's
 * relative moves from there.
 */
export function poolTargetPrice(reference: number, scale: number): number {
  return reference * scale;
}

/** The scale that maps `reference` onto the anchor price (anchor (A, B) = B per A as B / A). */
export function calibrateScale(reference: number, anchor: [string, string]): number {
  const p = Number(anchor[1]) / Number(anchor[0]);
  if (!(p > 0 && reference > 0)) throw new Error('Cannot calibrate: anchor and reference must be positive');
  return p / reference;
}

export const anchorPrice = (anchor: [string, string]): number => Number(anchor[1]) / Number(anchor[0]);

/**
 * May the bot follow `target`? Not when it is more than `maxDistance` from the OWNER's stated anchor:
 * only the owner can restate the anchor; the bot must not chase a market that far on its own. Once
 * stopped for this, it resumes only within `maxDistance * resumeFactor` (hysteresis).
 */
export function anchorCheck(target: number, ownerAnchor: [string, string], o: { maxDistance: number; resumeFactor: number; stopped: boolean }): { ok: boolean; distance: number } {
  const distance = priceDistance(target, anchorPrice(ownerAnchor));
  const bound = o.stopped ? o.maxDistance * o.resumeFactor : o.maxDistance;
  return { ok: distance <= bound, distance };
}

// ------------------------------------------------------------------ pause control

export interface PauseState {
  /** The bot set the operator pause (it only ever clears a pause it set). */
  pausedByBot: boolean;
  pauseReason?: string;
  unhealthySince?: number;
  healthySince?: number;
}

export type PauseAction = { action: 'pause' | 'unpause' | 'none'; reason: string; state: PauseState };

/**
 * Operator-pause control. `healthy`: the reference is usable. `anchorOk`: it is within the owner's
 * anchor distance. An anchor problem pauses at once (the pool is then known to be off the market
 * and the bot may not follow); an unhealthy reference pauses only after `pauseAfterMs` (sources
 * blink). The bot clears only a pause it set, after `resumeAfterMs` of everything being fine.
 */
export function pauseDecision(o: { now: number; healthy: boolean; anchorOk: boolean; operatorPaused: boolean; ownerPaused: boolean; state: PauseState; pauseAfterMs: number; resumeAfterMs: number }): PauseAction {
  const st: PauseState = { ...o.state };
  const problem = !o.healthy ? 'reference unhealthy' : !o.anchorOk ? 'reference too far from the owner\'s anchor: the OWNER must restate the anchor' : undefined;
  if (problem) {
    st.healthySince = undefined;
    st.unhealthySince ??= o.now;
    if (o.operatorPaused) return { action: 'none', reason: `${problem}; operator pause already on`, state: st };
    if (o.ownerPaused) return { action: 'none', reason: `${problem}; owner pause on`, state: st };
    if (!o.anchorOk || o.now - st.unhealthySince >= o.pauseAfterMs) {
      return { action: 'pause', reason: problem, state: { ...st, pausedByBot: true, pauseReason: problem } };
    }
    return { action: 'none', reason: `${problem} for ${Math.round((o.now - st.unhealthySince) / 1000)} s (pause after ${Math.round(o.pauseAfterMs / 1000)} s)`, state: st };
  }
  st.unhealthySince = undefined;
  st.healthySince ??= o.now;
  if (!o.operatorPaused) {
    // Someone else cleared it, or it was never set: the bot no longer holds a pause.
    return { action: 'none', reason: 'healthy', state: { ...st, pausedByBot: false, pauseReason: undefined } };
  }
  if (!st.pausedByBot) return { action: 'none', reason: 'operator pause set by someone else: left alone', state: st };
  if (o.now - st.healthySince >= o.resumeAfterMs) return { action: 'unpause', reason: `healthy for ${Math.round((o.now - st.healthySince) / 1000)} s`, state: { ...st, pausedByBot: false, pauseReason: undefined } };
  return { action: 'none', reason: `healthy for ${Math.round((o.now - st.healthySince) / 1000)} s (resume after ${Math.round(o.resumeAfterMs / 1000)} s)`, state: st };
}

// ------------------------------------------------------------------ rebalance

export interface RebalanceConfig {
  /** null: half the pool's current fee. */
  deadBandBps: number | null;
  spendFraction: number;
  reserveFraction: number;
  minMoveBps: number;
  side: RebalanceSide;
  /** For side 'balanced': the depth sqrt(Ra * Rb) to keep the curve near. */
  targetDepth?: number;
}

export type RebalanceDecision =
  | { action: 'none'; reason: string; gapBps: number; deadBandBps: number; behind: boolean; allowance?: string; spendable?: string }
  | {
    action: 'rebalance'; toReserveA: string; toReserveB: string; kind: 'removeA' | 'removeB' | 'addA' | 'addB';
    plan: OwnerPoolRebalancePlan; priceBefore: number; priceAfter: number; gapBps: number; gapAfterBps: number;
    deadBandBps: number; behind: boolean; clipped: boolean; allowance: string; spendable: string;
  };

/** The largest spend allowed now: min(allowance * spendFraction, allowance - reserveFraction * budget), at least 0. */
export function spendableAllowance(allowance: string, budgetBps: number, o: { spendFraction: number; reserveFraction: number }): Decimal {
  const a = new Decimal(allowance), budget = new Decimal(budgetBps).div(10_000);
  const s = Decimal.min(a.mul(o.spendFraction), a.minus(budget.mul(o.reserveFraction)));
  return s.gt(0) ? s.toDecimalPlaces(18, Decimal.ROUND_DOWN) : new Decimal(0);
}

const bps = (d: number) => d * 10_000;

/**
 * One tick's rebalance: move the curve toward `target` (B per A) when it is outside the dead band,
 * by a one-sided move between inventory and reserves, as large as fits in the spendable part of
 * the allowance and inside the owner's caps and floors (checked with `ownerPoolPlanRebalance`, the
 * exact copy of the contract's checks: a returned move never breaches a cap or floor). Candidates:
 * removing the side that is too plentiful, or adding the scarce side from inventory; 'remove'
 * prefers the cheaper removal (cost = price move), 'add' the addition (about 1.5x), 'balanced'
 * removes while the curve is deeper than `targetDepth` and adds while shallower. The candidate that
 * closes more of the gap wins; the preferred one wins near ties.
 */
export function decideRebalance(pool: OwnerPoolState, epoch: number, target: number, cfg: RebalanceConfig): RebalanceDecision {
  const s = pool.split;
  const deadBandBps = cfg.deadBandBps ?? pool.feeBps / 2;
  const ra = new Decimal(pool.reserveA), rb = new Decimal(pool.reserveB);
  const price = rb.div(ra).toNumber();
  const gapBps = bps(priceDistance(price, target));
  const none = (reason: string, behind = false, extra: { allowance?: string; spendable?: string } = {}): RebalanceDecision => ({ action: 'none', reason, gapBps, deadBandBps, behind, ...extra });
  if (!s) return none('not a split pool');
  if (!s.operator) return none('no operator appointed');
  if (s.ownerPaused) return none('paused by the owner');
  if (!(target > 0) || !Number.isFinite(target)) return none('no target price');
  if (gapBps <= deadBandBps) return none('inside the dead band');
  const allowance = ownerPoolAllowanceNow(pool, epoch);
  const spendable = spendableAllowance(allowance, s.limits.moveBudgetBps, cfg);
  const extra = { allowance, spendable: spendable.toFixed() };
  if (spendable.lte(0)) return none('allowance spent (or inside the reserve): waiting for refill', true, extra);

  const T = new Decimal(target);
  const up = target > price;
  // One-sided moves that land exactly on the target: change A to rb/T, or B to T*ra.
  const moveA = rb.div(T).minus(ra), moveB = T.mul(ra).minus(rb);
  const removal = up ? { kind: 'removeA' as const, a: moveA, b: null } : { kind: 'removeB' as const, a: null, b: moveB };
  const addition = up ? { kind: 'addB' as const, a: null, b: moveB } : { kind: 'addA' as const, a: moveA, b: null };
  const depth = Math.sqrt(ra.toNumber() * rb.toNumber());
  const preferRemove = cfg.side === 'remove' || (cfg.side === 'balanced' && (cfg.targetDepth === undefined || depth >= cfg.targetDepth));
  const candidates = preferRemove ? [removal, addition] : [addition, removal];

  type Found = { kind: (typeof candidates)[number]['kind']; da: string; db: string; plan: OwnerPoolRebalancePlan; after: number; clipped: boolean };
  const tryCandidate = (c: (typeof candidates)[number]): Found | undefined => {
    const full = (c.a ?? c.b)!;
    const div = c.a ? pool.divisibilityA : pool.divisibilityB;
    const at = (t: number) => {
      const amount = full.mul(t).toDecimalPlaces(div, Decimal.ROUND_DOWN);
      if (amount.isZero()) return undefined;
      const [da, db] = c.a ? [amount.toFixed(), '0'] : ['0', amount.toFixed()];
      try {
        const plan = ownerPoolPlanRebalance(pool, da, db, epoch);
        if (new Decimal(plan.cost).gt(spendable)) return undefined;
        return { da, db, plan };
      } catch (e) {
        if (e instanceof OwnerPoolQuoteError) return undefined;
        throw e;
      }
    };
    let best = at(1), clipped = false;
    if (!best) {
      clipped = true;
      let lo = 0, hi = 1;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        const r = at(mid);
        if (r) { lo = mid; best = r; } else hi = mid;
      }
    }
    if (!best) return undefined;
    const after = new Decimal(best.plan.reserveB).div(best.plan.reserveA).toNumber();
    return { kind: c.kind, ...best, after, clipped };
  };
  const found = candidates.map(tryCandidate).filter((f): f is Found => !!f);
  if (!found.length) return none('no move fits the allowance, caps, floors and inventory', true, extra);
  // Most progress wins; the preferred candidate (first) wins within 1 bps.
  const progress = (f: Found) => gapBps - bps(priceDistance(f.after, target));
  let pick = found[0]!;
  for (const f of found.slice(1)) if (progress(f) > progress(pick) + 1) pick = f;
  const moveBps = bps(priceDistance(price, pick.after));
  if (moveBps < cfg.minMoveBps) return none(`best move only ${moveBps.toFixed(2)} bps (minimum ${cfg.minMoveBps})`, true, extra);
  const gapAfterBps = bps(priceDistance(pick.after, target));
  return {
    action: 'rebalance', toReserveA: pick.da, toReserveB: pick.db, kind: pick.kind, plan: pick.plan, priceBefore: price, priceAfter: pick.after,
    gapBps, gapAfterBps, deadBandBps, behind: gapAfterBps > deadBandBps, clipped: pick.clipped, ...extra,
  };
}

// ------------------------------------------------------------------ fee (spread) control

export interface FeeConfig {
  baseFeeBps: number;
  volMultiplier: number;
  behindFeeBps: number;
  minFeeChangeBps: number;
  widenIntervalMs: number;
  narrowIntervalMs: number;
  /** For the volatility measure: the bot's tick interval. */
  intervalMs: number;
}

/**
 * Recent volatility of the reference, in bps per tick interval: the standard deviation of the log
 * returns between consecutive samples in the window, each scaled by sqrt(interval / its own gap) so
 * irregular sampling does not distort it. 0 with fewer than three samples.
 */
export function volatilityBps(history: { at: number; price: number }[], now: number, windowMs: number, intervalMs: number): number {
  const xs = history.filter((h) => h.at <= now && now - h.at <= windowMs && h.price > 0).sort((a, b) => a.at - b.at);
  const r: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const dt = xs[i]!.at - xs[i - 1]!.at;
    if (dt <= 0) continue;
    r.push(Math.log(xs[i]!.price / xs[i - 1]!.price) * Math.sqrt(intervalMs / dt));
  }
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * 10_000;
}

/** fee = base + volMultiplier * volatility (+ behindFeeBps when the bot cannot catch up), rounded, inside [min, max]. */
export function feeTarget(o: { volBps: number; behind: boolean; minFeeBps: number; maxFeeBps: number; cfg: Pick<FeeConfig, 'baseFeeBps' | 'volMultiplier' | 'behindFeeBps'> }): number {
  const raw = o.cfg.baseFeeBps + o.cfg.volMultiplier * o.volBps + (o.behind ? o.cfg.behindFeeBps : 0);
  return Math.min(o.maxFeeBps, Math.max(o.minFeeBps, Math.round(raw)));
}

/**
 * Hysteresis: change the fee only when the target is at least `minFeeChangeBps` away, and the last
 * change was at least `widenIntervalMs` ago to widen (protection: soon) or `narrowIntervalMs` ago to
 * narrow (calm must last). The operator has fee power only when the owner's range is not a single value.
 */
export function feeDecision(o: { currentFeeBps: number; targetFeeBps: number; lastChangeAt?: number; now: number; minFeeBps: number; maxFeeBps: number; cfg: Pick<FeeConfig, 'minFeeChangeBps' | 'widenIntervalMs' | 'narrowIntervalMs'> }): { action: 'set'; feeBps: number; reason: string } | { action: 'none'; reason: string } {
  if (o.minFeeBps >= o.maxFeeBps) return { action: 'none', reason: 'the operator has no fee range' };
  const diff = o.targetFeeBps - o.currentFeeBps;
  if (Math.abs(diff) < o.cfg.minFeeChangeBps) return { action: 'none', reason: `fee ${o.currentFeeBps} bps within ${o.cfg.minFeeChangeBps} bps of target ${o.targetFeeBps}` };
  const wait = diff > 0 ? o.cfg.widenIntervalMs : o.cfg.narrowIntervalMs;
  const since = o.lastChangeAt === undefined ? Infinity : o.now - o.lastChangeAt;
  if (since < wait) return { action: 'none', reason: `${diff > 0 ? 'widen' : 'narrow'} to ${o.targetFeeBps} bps held: last fee change ${Math.round(since / 1000)} s ago (< ${Math.round(wait / 1000)} s)` };
  return { action: 'set', feeBps: o.targetFeeBps, reason: `${diff > 0 ? 'widen' : 'narrow'} ${o.currentFeeBps} -> ${o.targetFeeBps} bps` };
}

// ------------------------------------------------------------------ transaction rate cap

/** Transactions still allowed in the hour before `now`, given the send times (ms) so far. */
export function txAllowance(sentAt: number[], now: number, maxPerHour: number): number {
  return Math.max(0, maxPerHour - sentAt.filter((t) => now - t < 3_600_000 && t <= now).length);
}

// ------------------------------------------------------------------ the owner's anchor

export type OwnerAnchorSource =
  | { source: 'ledger'; anchor: [string, string]; txid: string; stateVersion: number; at: number; flagMismatch?: [string, string] }
  | { source: 'flag'; anchor: [string, string]; reason: string }
  | { source: 'none'; reason: string };

/**
 * Which anchor the bot measures its distance from. The ledger's last owner statement (the most recent
 * `OwnerPoolAnchorEvent`, see ownerpool-events.ts) whenever it is known; the `--owner-anchor` flag only
 * when the ledger cannot say (no statement found, search incomplete, or the Gateway failed before any
 * answer) AND the flag was given explicitly; otherwise none, and the bot must not rebalance.
 * A flag that disagrees with the ledger is reported, never used.
 */
export function resolveOwnerAnchor(o: {
  ledger?: { anchor: [string, string]; txid: string; stateVersion: number; at: number };
  /** The ledger search reached the pool's first event (or found a statement): its answer is final. */
  ledgerComplete: boolean;
  ledgerError?: string;
  flag?: [string, string];
}): OwnerAnchorSource {
  if (o.ledger && o.ledgerComplete) {
    const mismatch = o.flag && priceDistance(anchorPrice(o.flag), anchorPrice(o.ledger.anchor)) > 1e-9 ? o.flag : undefined;
    return { source: 'ledger', ...o.ledger, ...(mismatch ? { flagMismatch: mismatch } : {}) };
  }
  const why = o.ledgerError ? `ledger lookup failed: ${o.ledgerError}`
    : !o.ledgerComplete ? 'ledger search incomplete'
    : 'the pool has no owner anchor statement on ledger';
  if (o.flag) return { source: 'flag', anchor: o.flag, reason: `${why}; using --owner-anchor` };
  return { source: 'none', reason: `${why}; no --owner-anchor given: the bot will not rebalance` };
}

/** Parse "A:B" (both positive) or throw. */
export function parseAnchorFlag(s: string): [string, string] {
  const p = s.split(':');
  if (p.length !== 2 || !(Number(p[0]) > 0 && Number(p[1]) > 0)) throw new Error('--owner-anchor must be A:B with both positive');
  return [p[0]!.trim(), p[1]!.trim()];
}
