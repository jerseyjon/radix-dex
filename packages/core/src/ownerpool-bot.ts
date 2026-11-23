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
  /** Reference health (on-ledger venues of the same pair, see `aggregateVenues`). */
  minVenues: 1,
  /** Kept for the old median reference (`aggregateReference`), which the bot no longer uses. */
  minSources: 2,
  maxSourceAgeSec: 300,
  /** Highest / lowest live venue midpoint - 1. Beyond it: hold (no rebalance) and widen the fee. */
  maxDisagreement: 0.04,
  /** Each venue is quoted both ways at this size (XRD), and at `smallQuoteFraction` of it for the impact. */
  quoteSizeXrd: 1000,
  smallQuoteFraction: 0.1,
  /** Depth = quote size / impact, with the impact floored at this (one quote cannot show more depth than that). */
  minImpactBps: 10,
  /** A venue whose round trip (ask / bid - 1) at the quote size is wider than this does not bound the price: dropped. */
  maxRoundTrip: 0.1,
  /** A venue whose own swap fee (estimated from its quotes, `readVenue`) is over this is excluded (owner, 22 Nov 2026). */
  maxVenueFee: 0.01,
  /** The set of live venues changed: no rebalance for this long (restarts on another change; persisted). */
  venueHoldSec: 900,
  /**
   * A venue counts as dropped only after failing this many ticks in a row, and as back only after
   * quoting this many ticks in a row (`venueConfirm`; owner, 23 Nov 2026). 1 = the old behaviour.
   */
  confirmTicks: 2,
  /** Only ONE venue in the confirmed live set: fee target + this (bps, still clamped to the operator range)... */
  singleVenueFeeAddBps: 50,
  /** ...and the per-tick spend cap and the rolling-window share are multiplied by this (owner, 23 Nov 2026). */
  singleVenueSizeFactor: 0.5,
  /** While the venues disagree: fee + this fraction of the disagreement (in bps), inside the operator range. */
  disagreeFeeFactor: 0.5,
  /** CoinGecko (watch only) this far from the on-ledger reference: alert. Never affects a trade. */
  coingeckoMaxDeviation: 0.15,
  /** Rolling spend cap: at most this share of the allowance available at the start of any window of this length. */
  spendWindowSec: 600,
  maxWindowSpendShare: 0.6,
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
  /** Fee rule. 100 bps needs an operator fee range of about 50-200 bps on mainnet; Stokenet's 10-100 clamps it at 100. */
  baseFeeBps: 100,
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

// ------------------------------------------------------------------ on-ledger venue reference

/**
 * One venue's executable quotes for the pair (prices in B per A, e.g. hUSDC per XRD), from previews of
 * real swaps: `bid` = what selling `sizeA` of A gets per A, `ask` = what buying about `sizeA` of A costs
 * per A; `bidSmall`/`askSmall` the same at `smallA`. A synthetic venue (fixed: / file:, tests and drills)
 * has all four equal.
 */
export interface VenueQuote {
  venue: string;
  /** When the quotes were made (ms): the previews run on the ledger state of that moment. */
  at: number;
  sizeA: number;
  smallA: number;
  bid: number;
  ask: number;
  bidSmall: number;
  askSmall: number;
  error?: string;
}

export interface VenueReading {
  venue: string;
  /** sqrt(bid * ask): a proportional swap fee charged both ways cancels out of it. */
  mid?: number;
  /** ask / bid - 1 at the quote size: fees both ways plus impact both ways. */
  roundTrip?: number;
  /** Price impact going from the small size to the quote size, mean of both sides (fee-free: the fee is the same share at both sizes). */
  impact?: number;
  /** quote size / max(impact, floor), in A: the reserve of a constant-product pool with the same impact. */
  depth?: number;
  /** The venue's own one-way swap fee, estimated from its quotes (`venueFee`). */
  fee?: number;
  weight?: number;
  used: boolean;
  dropped?: string;
}

export type VenueReference =
  /** ok: the reference. disagree: a depth-weighted price exists but the live venues are too far apart to trade on. none: no live venue. */
  | { status: 'ok' | 'disagree'; price: number; disagreement: number; live: number; venues: VenueReading[]; reason: string }
  | { status: 'none'; price?: undefined; disagreement?: undefined; live: 0; venues: VenueReading[]; reason: string };

/**
 * A venue's own one-way swap fee, read from its quotes (no fee table, no venue-specific state): the
 * one-way cost at a size, c = 1 - sqrt(bid / ask) (half the round trip, geometrically: fee plus impact
 * one way), is measured at the small size and the quote size and extrapolated linearly to size zero,
 * where the impact vanishes and only the fee is left: fee = c(small) - (c(size) - c(small)) * small /
 * (size - small). Exact for a pure proportional fee; for a constant-product pool the impact is linear
 * in size to first order, so it is removed. On the 22 Nov 2026 quotes: Ociswap basic 3.000% (its
 * `input_fee_rate` is 0.03), Ociswap precision 0.052% (0.05%), CaviarNine 0.081%, DefiPlaza 10.6% (its
 * asymmetric pricing, not a fee field, but it is what a trader pays at zero size). Never below 0.
 */
export function venueFee(q: Pick<VenueQuote, 'sizeA' | 'smallA' | 'bid' | 'ask' | 'bidSmall' | 'askSmall'>): number {
  const c = (bid: number, ask: number) => 1 - Math.sqrt(bid / ask);
  const cBig = c(q.bid, q.ask), cSmall = c(q.bidSmall, q.askSmall);
  if (!(q.sizeA > q.smallA)) return Math.max(0, cSmall);
  return Math.max(0, cSmall - (cBig - cSmall) * q.smallA / (q.sizeA - q.smallA));
}

/** The fee-free midpoint, round trip, impact, depth and own fee of one venue's quotes (no health checks). */
export function readVenue(q: VenueQuote, minImpact: number): Required<Pick<VenueReading, 'mid' | 'roundTrip' | 'impact' | 'depth' | 'fee'>> {
  const mid = Math.sqrt(q.bid * q.ask);
  const roundTrip = q.ask / q.bid - 1;
  // Selling more gets a worse (lower) bid, buying more a worse (higher) ask.
  const impact = Math.max(0, ((q.bidSmall / q.bid - 1) + (q.ask / q.askSmall - 1)) / 2);
  const depth = q.sizeA / Math.max(impact, minImpact);
  return { mid, roundTrip, impact, depth, fee: venueFee(q) };
}

/**
 * The reference from on-ledger venues of the SAME pair. Each live venue's midpoint (net of its own
 * fee, `readVenue`) is weighted by its depth; the reference is the weighted geometric mean.
 * Dropped: a venue whose quotes failed or are unusable, older than `maxAgeMs` (or in the future), or
 * whose round trip at the quote size is wider than `maxRoundTrip` (its two quotes then bound the
 * price too loosely to be a reference), or whose own swap fee (`venueFee`, from its quotes) is over
 * `maxVenueFee` (default 1%; exactly at it is kept): a high-fee pool's price can sit up to its fee away
 * from the market before anyone arbitrages it. Venues named in `exclude` are dropped too (drills).
 * With fewer than `minVenues` live: none. When the highest and
 * lowest live midpoint differ by more than `maxDisagreement`: disagree (the price is reported for
 * the logs and the fee, never traded on).
 */
export function aggregateVenues(quotes: VenueQuote[], nowMs: number, o: { minVenues: number; maxAgeMs: number; maxDisagreement: number; maxRoundTrip: number; minImpactBps: number; maxVenueFee?: number; exclude?: string[]; unconfirmed?: Record<string, string> }): VenueReference {
  const maxFee = o.maxVenueFee ?? OWNER_POOL_BOT_DEFAULTS.maxVenueFee;
  const venues: VenueReading[] = quotes.map((q) => {
    if (o.exclude?.includes(q.venue)) return { venue: q.venue, used: false, dropped: 'excluded by --exclude-venues (TEST)' };
    if (q.error) return { venue: q.venue, used: false, dropped: q.error };
    const vals = [q.bid, q.ask, q.bidSmall, q.askSmall, q.sizeA];
    if (!vals.every((v) => Number.isFinite(v) && v > 0)) return { venue: q.venue, used: false, dropped: 'quotes unusable' };
    if (nowMs - q.at > o.maxAgeMs || q.at > nowMs + 60_000) return { venue: q.venue, used: false, dropped: `stale (${Math.round((nowMs - q.at) / 1000)} s old)` };
    const r = readVenue(q, o.minImpactBps / 10_000);
    if (!(r.roundTrip >= -1e-9)) return { venue: q.venue, ...r, used: false, dropped: `ask below bid (round trip ${(r.roundTrip * 100).toFixed(2)}%)` };
    if (r.roundTrip > o.maxRoundTrip) return { venue: q.venue, ...r, used: false, dropped: `round trip ${(r.roundTrip * 100).toFixed(2)}% > ${(o.maxRoundTrip * 100).toFixed(1)}%` };
    if (r.fee > maxFee + 1e-9) return { venue: q.venue, ...r, used: false, dropped: `fee ${(r.fee * 100).toFixed(3)}% > ${(maxFee * 100).toFixed(2)}% (estimated from its quotes)` };
    // Passed every check, but coming back and not yet confirmed (`venueConfirm`): read, logged, not used.
    const pending = o.unconfirmed?.[q.venue];
    if (pending !== undefined) return { venue: q.venue, ...r, used: false, dropped: pending };
    return { venue: q.venue, ...r, used: true };
  });
  const live = venues.filter((v) => v.used);
  if (live.length < Math.max(1, o.minVenues)) {
    return { status: 'none', live: 0, venues, reason: `only ${live.length} live venue(s), need ${Math.max(1, o.minVenues)}` };
  }
  const total = live.reduce((a, v) => a + v.depth!, 0);
  for (const v of live) v.weight = v.depth! / total;
  const price = Math.exp(live.reduce((a, v) => a + v.weight! * Math.log(v.mid!), 0));
  const mids = live.map((v) => v.mid!);
  const disagreement = Math.max(...mids) / Math.min(...mids) - 1;
  const one = live.length === 1 ? ' (ONLY ONE live venue: nothing to check it against)' : '';
  if (disagreement > o.maxDisagreement + 1e-12) {
    return { status: 'disagree', price, disagreement, live: live.length, venues, reason: `venues disagree by ${(disagreement * 100).toFixed(2)}% (bound ${(o.maxDisagreement * 100).toFixed(1)}%): hold and widen` };
  }
  return { status: 'ok', price, disagreement, live: live.length, venues, reason: `${live.length} live venue(s)${one}` };
}

// ------------------------------------------------------------------ venue-set hold

/** Persisted in the bot's state file: the live venue set last seen, and the hold it started. */
export interface VenueHoldState {
  /** Sorted names of the venues live on the last tick; undefined before the first tick. */
  liveSet?: string[];
  holdUntil?: number;
  holdStartedAt?: number;
  holdReason?: string;
}

/**
 * The owner's rule (22 Nov 2026): when the set of live venues changes (a venue drops out or comes back,
 * by a failed or part-filled quote, the round-trip rule or the fee rule), the reference can jump with
 * no market move, so the bot holds its position for `holdMs`: no rebalance. Another change during the
 * hold restarts it. The first tick ever (no set known) only records the set. The state is persisted by
 * the caller, so a restart neither skips a hold nor misses a change made while it was down.
 */
export function venueSetHold(prev: VenueHoldState, live: string[], now: number, holdMs: number): {
  state: VenueHoldState; changed: boolean; started: boolean; holding: boolean; expired: boolean; added: string[]; removed: string[]; remainingMs: number;
} {
  const set = [...new Set(live)].sort();
  const before = prev.liveSet;
  const added = before ? set.filter((v) => !before.includes(v)) : [];
  const removed = before ? before.filter((v) => !set.includes(v)) : [];
  const changed = !!before && (added.length > 0 || removed.length > 0);
  const st: VenueHoldState = { ...prev, liveSet: set };
  let started = false;
  if (changed) {
    started = !(prev.holdUntil !== undefined && now < prev.holdUntil);
    st.holdUntil = now + holdMs;
    st.holdStartedAt = now;
    st.holdReason = [removed.length ? `dropped ${removed.join(',')}` : '', added.length ? `back ${added.join(',')}` : ''].filter(Boolean).join('; ');
  }
  const holding = st.holdUntil !== undefined && now < st.holdUntil;
  const expired = !holding && st.holdUntil !== undefined;
  if (expired) { st.holdUntil = undefined; st.holdStartedAt = undefined; st.holdReason = undefined; }
  return { state: st, changed, started, holding, expired, added, removed, remainingMs: holding ? st.holdUntil! - now : 0 };
}

// ------------------------------------------------------------------ venue confirmation (two ticks)

/** Persisted in the bot's state file: the CONFIRMED live venue set and the per-venue streak counters. */
export interface VenueConfirmState {
  /** Sorted; undefined before the first tick. */
  confirmed?: string[];
  /** Confirmed venue -> failed ticks in a row (it is still confirmed). */
  fails?: Record<string, number>;
  /** Unconfirmed venue -> good ticks in a row (it does not count yet). */
  goods?: Record<string, number>;
}

/**
 * The owner's rule (23 Nov 2026): one failed quote does not change the live set. A confirmed venue
 * must fail on `confirmTicks` ticks in a row before it is dropped (and the venue-set hold starts); a
 * venue that is not confirmed must quote on `confirmTicks` ticks in a row before it counts. `quoting`
 * is the set of venues that passed every check this tick (`aggregateVenues` without `unconfirmed`).
 * `uncertain`: a confirmed venue failed this tick and is not dropped yet; the caller prices from the
 * confirmed venues that did quote but does not rebalance on that tick. The first tick ever (no
 * confirmed set) confirms whatever quotes, as before. `confirmTicks` 1 = the old behaviour.
 */
export function venueConfirm(prev: VenueConfirmState, quoting: string[], confirmTicks: number): {
  state: VenueConfirmState; confirmed: string[]; failing: { venue: string; ticks: number }[]; returning: { venue: string; ticks: number }[];
  dropped: string[]; added: string[]; uncertain: boolean;
} {
  const n = Math.max(1, Math.floor(confirmTicks));
  const q = [...new Set(quoting)].sort();
  if (!prev.confirmed) return { state: { confirmed: q, fails: {}, goods: {} }, confirmed: q, failing: [], returning: [], dropped: [], added: [], uncertain: false };
  const fails: Record<string, number> = {}, goods: Record<string, number> = {};
  const failing: { venue: string; ticks: number }[] = [], returning: { venue: string; ticks: number }[] = [];
  const dropped: string[] = [], added: string[] = [];
  const confirmed: string[] = [];
  for (const v of prev.confirmed) {
    if (q.includes(v)) { confirmed.push(v); continue; }
    const t = (prev.fails?.[v] ?? 0) + 1;
    if (t >= n) dropped.push(v);
    else { confirmed.push(v); fails[v] = t; failing.push({ venue: v, ticks: t }); }
  }
  for (const v of q) {
    if (prev.confirmed.includes(v)) continue;
    const t = (prev.goods?.[v] ?? 0) + 1;
    if (t >= n) { added.push(v); confirmed.push(v); } else { goods[v] = t; returning.push({ venue: v, ticks: t }); }
  }
  confirmed.sort();
  return { state: { confirmed, fails, goods }, confirmed, failing, returning, dropped, added, uncertain: failing.length > 0 };
}

/**
 * What the venue rules allow this tick, in the bot's order: venues disagreeing (> max disagreement):
 * hold and widen; a venue-set hold running: hold; a confirmed venue failed once (`uncertain`): no
 * rebalance; no reference: nothing; otherwise trade. Hold, uncertain and disagree all keep the fee
 * step with narrowing blocked; `none` skips it.
 */
export function venueGate(o: { status: VenueReference['status']; holding: boolean; uncertain: boolean }): 'disagree' | 'hold' | 'uncertain' | 'none' | 'trade' {
  if (o.status === 'disagree') return 'disagree';
  if (o.status !== 'ok') return 'none';
  if (o.holding) return 'hold';
  if (o.uncertain) return 'uncertain';
  return 'trade';
}

/**
 * Whether this tick's reference price enters the volatility history (and so the fee target). Only a
 * price from the full confirmed set counts: `trade` ticks, and `hold` ticks unless a confirmed venue
 * also failed this tick (during a hold the confirmed set is the new, stable one, so its price is sound).
 * `uncertain` (a confirmed venue missing: priced from fewer venues), `disagree` and `none` never count,
 * so a one-tick jump from a partial venue set cannot raise the fee.
 */
export function volatilityEligible(o: { status: VenueReference['status']; holding: boolean; uncertain: boolean }): boolean {
  return o.status === 'ok' && !o.uncertain;
}

// ------------------------------------------------------------------ single-venue caution

/** Persisted: when the current single-venue episode began (undefined: not in one). */
export interface SingleVenueState { since?: number }

/**
 * The owner's rule (23 Nov 2026): with only ONE venue in the confirmed live set the bot keeps trading,
 * cautiously (fee + `singleVenueFeeAddBps`, sizes x `singleVenueSizeFactor`, applied by the caller).
 * `active` when the confirmed set has exactly one venue; `started` on the first such tick of an episode
 * (alert once); `ended` when two or more venues are confirmed again (clear the alert key). Zero confirmed
 * venues neither starts nor ends an episode (no reference: no trade anyway).
 */
export function singleVenueCaution(prev: SingleVenueState, confirmedCount: number, now: number): { state: SingleVenueState; active: boolean; started: boolean; ended: boolean } {
  const active = confirmedCount === 1;
  if (active) return { state: { since: prev.since ?? now }, active, started: prev.since === undefined, ended: false };
  if (confirmedCount >= 2) return { state: {}, active, started: false, ended: prev.since !== undefined };
  return { state: { ...prev }, active, started: false, ended: false };
}

// ------------------------------------------------------------------ reference must not contain our own pool

/**
 * Hard guard, checked at start-up: no reference venue may be the pool the bot operates, nor ANY
 * OwnerPool component (blueprint `OwnerPool`, or a component of a package in `ownerPoolPackages`).
 * An OwnerPool's price is set by its owner/operator, so following it would be following ourselves.
 * `details` are the Gateway's entity details of the venue addresses; a venue the Gateway did not
 * describe is refused too (it cannot be shown not to be one). Returns the problems; empty = fine.
 */
export function referenceVenueProblems(o: {
  operatedPool: string;
  venues: { name: string; address: string }[];
  details: { address: string; blueprint_name?: string; package_address?: string }[];
  ownerPoolPackages: string[];
  ownerPoolBlueprint?: string;
}): string[] {
  const bp = o.ownerPoolBlueprint ?? 'OwnerPool';
  const out: string[] = [];
  for (const v of o.venues) {
    if (v.address === o.operatedPool) { out.push(`venue ${v.name} IS the operated pool ${v.address}`); continue; }
    const d = o.details.find((x) => x.address === v.address);
    if (!d) { out.push(`venue ${v.name} (${v.address}): no entity details from the Gateway, cannot show it is not an OwnerPool`); continue; }
    if (d.blueprint_name === bp) out.push(`venue ${v.name} (${v.address}) is an ${bp} component`);
    else if (d.package_address && o.ownerPoolPackages.includes(d.package_address)) out.push(`venue ${v.name} (${v.address}) is a component of OwnerPool package ${d.package_address}`);
  }
  return out;
}

/**
 * CoinGecko (or any off-ledger price) is WATCH ONLY: compared with the on-ledger reference, both in the
 * same unit (e.g. USD per XRD), never used for a price or a trade. `alarm` when they are more than
 * `maxDeviation` apart (d(x, y) = max(x/y, y/x) - 1).
 */
export function watchPriceCheck(reference: number | undefined, watch: number | undefined, maxDeviation: number): { alarm: boolean; deviation?: number } {
  if (!(reference! > 0) || !(watch! > 0)) return { alarm: false };
  const deviation = priceDistance(reference!, watch!);
  return { alarm: deviation > maxDeviation, deviation };
}

// ------------------------------------------------------------------ rolling spend cap

/**
 * The most the operator may spend now so that, over the last `windowMs`, its moves spend at most
 * `maxShare` of the allowance that was available when the window began. Spent S in the window and
 * allowance A now, that allowance was S + A (a refill inside the window only adds to it), so the next
 * move c must keep (S + c) / (S + A) <= maxShare: c <= maxShare * (S + A) - S. The watcher's
 * `window-spend` rule checks the same quantity from the pool's events.
 */
export function windowSpendRoom(spends: { at: number; cost: number }[], allowanceNow: number, now: number, o: { windowMs: number; maxShare: number }): { room: number; spentInWindow: number } {
  const spentInWindow = spends.filter((s) => s.at <= now && now - s.at < o.windowMs).reduce((a, s) => a + s.cost, 0);
  const room = Math.max(0, o.maxShare * (spentInWindow + Math.max(0, allowanceNow)) - spentInWindow);
  return { room, spentInWindow };
}

// ------------------------------------------------------------------ send failures

/**
 * After a send: reset or count failures; halt sending for `haltMs` when `maxFailures` fail in a row.
 * The count is not reset when a halt runs out, so ONE more failure after it halts again at once.
 * `recovered`: this success ended a run that had halted (the caller clears the `halt` alert key, so the
 * next halt is alerted even within the alert interval).
 */
export function recordSendOutcome(st: { consecutiveFailures: number; haltedUntil?: number }, ok: boolean, now: number, o: { maxFailures: number; haltMs: number }): { consecutiveFailures: number; haltedUntil?: number; halted: boolean; recovered: boolean } {
  const consecutiveFailures = ok ? 0 : st.consecutiveFailures + 1;
  const recovered = ok && st.consecutiveFailures >= o.maxFailures;
  if (consecutiveFailures >= o.maxFailures) return { consecutiveFailures, haltedUntil: now + o.haltMs, halted: true, recovered };
  return { consecutiveFailures, haltedUntil: st.haltedUntil, halted: false, recovered };
}

/** Whether sending is halted at `now`. */
export const sendHalted = (st: { haltedUntil?: number }, now: number): boolean => st.haltedUntil !== undefined && now < st.haltedUntil;

/**
 * After a tick: consecutive failed ticks (a Gateway outage throws before anything is sent), whether to
 * alert (`alertTicks` in a row), and the wait before the next tick: interval * 2^errors, at most `maxMs`.
 */
export function tickOutcome(prevErrors: number, failed: boolean, o: { intervalMs: number; alertTicks: number; maxMs?: number }): { errors: number; alert: boolean; delayMs: number } {
  const errors = failed ? prevErrors + 1 : 0;
  return { errors, alert: failed && errors >= o.alertTicks, delayMs: Math.min(o.intervalMs * 2 ** errors, o.maxMs ?? 900_000) };
}

/** The "behind" counter after a tick, and whether to alert (at `alertTicks` in a row, rate-limited by the caller). */
export function behindUpdate(prevTicks: number | undefined, behind: boolean, alertTicks: number): { ticks: number; alert: boolean; cleared: boolean } {
  const ticks = behind ? (prevTicks ?? 0) + 1 : 0;
  return { ticks, alert: ticks >= alertTicks, cleared: ticks === 0 };
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
  /** Further cap on this tick's spend (the rolling-window room, `windowSpendRoom`). */
  spendCap?: number;
  /**
   * Multiplies the per-tick spend cap min(allowance x spendFraction, allowance - reserve) (default 1).
   * The single-venue caution passes 0.5; the caller halves the window share for `spendCap` itself.
   */
  sizeFactor?: number;
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
  const f = cfg.sizeFactor ?? 1;
  if (!(f > 0 && f <= 1)) throw new Error(`sizeFactor must be in (0, 1], not ${f}`);
  const base = spendableAllowance(allowance, s.limits.moveBudgetBps, cfg).mul(f).toDecimalPlaces(18, Decimal.ROUND_DOWN);
  const windowCapped = cfg.spendCap !== undefined && base.gt(Math.max(0, cfg.spendCap));
  const spendable = windowCapped ? new Decimal(Math.max(0, cfg.spendCap!)).toDecimalPlaces(18, Decimal.ROUND_DOWN) : base;
  const extra = { allowance, spendable: spendable.toFixed() };
  if (spendable.lte(0)) return none(windowCapped ? 'rolling spend cap reached: waiting for the window to pass' : 'allowance spent (or inside the reserve): waiting for refill', true, extra);

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

/**
 * fee = base + volMultiplier * volatility (+ behindFeeBps when the bot cannot catch up) (+ disagreeFeeFactor
 * * the venues' disagreement, in bps, while they disagree) (+ `singleVenueAddBps` while only one venue is
 * confirmed live), rounded, inside [min, max].
 */
export function feeTarget(o: { volBps: number; behind: boolean; disagreement?: number; singleVenueAddBps?: number; minFeeBps: number; maxFeeBps: number; cfg: Pick<FeeConfig, 'baseFeeBps' | 'volMultiplier' | 'behindFeeBps'> & { disagreeFeeFactor?: number } }): number {
  return feeTargetDetail(o).feeBps;
}

/** `feeTarget` with the unclamped value, and whether the owner's range clamped it. */
export function feeTargetDetail(o: { volBps: number; behind: boolean; disagreement?: number; singleVenueAddBps?: number; minFeeBps: number; maxFeeBps: number; cfg: Pick<FeeConfig, 'baseFeeBps' | 'volMultiplier' | 'behindFeeBps'> & { disagreeFeeFactor?: number } }): { feeBps: number; rawBps: number; clamped: 'min' | 'max' | null } {
  const rawBps = Math.round(o.cfg.baseFeeBps + o.cfg.volMultiplier * o.volBps + (o.behind ? o.cfg.behindFeeBps : 0) + (o.disagreement ? (o.cfg.disagreeFeeFactor ?? 0) * o.disagreement * 10_000 : 0) + (o.singleVenueAddBps ?? 0));
  const feeBps = Math.min(o.maxFeeBps, Math.max(o.minFeeBps, rawBps));
  return { feeBps, rawBps, clamped: rawBps > o.maxFeeBps ? 'max' : rawBps < o.minFeeBps ? 'min' : null };
}

/**
 * Hysteresis: change the fee only when the target is at least `minFeeChangeBps` away, and the last
 * change was at least `widenIntervalMs` ago to widen (protection: soon) or `narrowIntervalMs` ago to
 * narrow (calm must last). The operator has fee power only when the owner's range is not a single value.
 */
export function feeDecision(o: { currentFeeBps: number; targetFeeBps: number; lastChangeAt?: number; now: number; minFeeBps: number; maxFeeBps: number; cfg: Pick<FeeConfig, 'minFeeChangeBps' | 'widenIntervalMs' | 'narrowIntervalMs'>; lastFailure?: { feeBps: number; at: number }; noNarrow?: string }): { action: 'set'; feeBps: number; reason: string } | { action: 'none'; reason: string } {
  if (o.minFeeBps >= o.maxFeeBps) return { action: 'none', reason: 'the operator has no fee range' };
  const diff = o.targetFeeBps - o.currentFeeBps;
  // Already at the edge of the range and the target is clamped there: nothing to do, whatever minFeeChange says.
  if (o.targetFeeBps === o.currentFeeBps) return { action: 'none', reason: `fee ${o.currentFeeBps} bps is the target` };
  // A change to this fee failed (preview or send) recently: do not retry the same thing every tick.
  if (o.lastFailure && o.lastFailure.feeBps === o.targetFeeBps && o.now - o.lastFailure.at < o.cfg.narrowIntervalMs) {
    return { action: 'none', reason: `fee change to ${o.targetFeeBps} bps failed ${Math.round((o.now - o.lastFailure.at) / 1000)} s ago: not retried before ${Math.round(o.cfg.narrowIntervalMs / 1000)} s` };
  }
  // During a venue-set hold the fee may widen (protection) but not narrow (the new reference is not trusted yet).
  if (diff < 0 && o.noNarrow) return { action: 'none', reason: `narrow to ${o.targetFeeBps} bps held: ${o.noNarrow}` };
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
