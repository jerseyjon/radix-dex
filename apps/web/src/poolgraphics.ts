// Pure maths behind the Pools page's at-a-glance graphics (tested in test/poolgraphics.test.ts).
// Prices are B per A (hUSDC per XRD), as everywhere on the page. Numbers, not decimals: these draw
// pictures; the exact figures stay in the cards and in the server's quotes.

/** d(x, y) = max(x/y, y/x) - 1: the distance the bot and the contract measure prices with. */
export function distance(x: number, y: number): number {
  if (!(x > 0 && y > 0)) return Infinity;
  return Math.max(x / y, y / x) - 1;
}

/** The prices within `frac` of `center` by that distance: [center / (1 + frac), center * (1 + frac)]. */
export function band(center: number, frac: number): [number, number] {
  return [center / (1 + frac), center * (1 + frac)];
}

// ------------------------------------------------------------------ depth (constant product, fee on input)

export interface Impact {
  /** XRD (A) traded. */
  size: number;
  /** What the trader gets (selling A) or pays (buying A), in B. */
  amountB: number;
  /** Average price of the trade, B per A. */
  avgPrice: number;
  /** How much worse than the pool's price before the trade, fee included, as a fraction (0.012 = 1.2%). */
  cost: number;
  /** The pool's price after the trade. */
  priceAfter: number;
  /** How far the trade moves the pool's price, signed (selling A lowers it). */
  move: number;
}

/**
 * Selling `x` A into a constant-product pool of reserves `ra`/`rb` with a fee of `feeBps` taken from
 * the input (the OwnerPool's `compute_swap`): out = rb * x' / (ra + x'), x' = x (1 - fee). The whole
 * input, fee included, stays in the pool.
 */
export function sellA(ra: number, rb: number, feeBps: number, x: number): Impact | undefined {
  if (!(ra > 0 && rb > 0 && x > 0)) return undefined;
  const eff = x * (1 - feeBps / 10_000);
  const out = (rb * eff) / (ra + eff);
  const p0 = rb / ra, after = (rb - out) / (ra + x);
  return { size: x, amountB: out, avgPrice: out / x, cost: 1 - out / (x * p0), priceAfter: after, move: after / p0 - 1 };
}

/**
 * Buying `x` A out of the same pool: the B input whose effective part takes exactly `x` out,
 * in = x rb / ((ra - x)(1 - fee)). Undefined when `x` is the whole reserve or more.
 */
export function buyA(ra: number, rb: number, feeBps: number, x: number): Impact | undefined {
  if (!(ra > 0 && rb > 0 && x > 0) || x >= ra) return undefined;
  const f = 1 - feeBps / 10_000;
  if (!(f > 0)) return undefined;
  const input = (x * rb) / ((ra - x) * f);
  const p0 = rb / ra, after = (rb + input) / (ra - x);
  return { size: x, amountB: input, avgPrice: input / x, cost: input / (x * p0) - 1, priceAfter: after, move: after / p0 - 1 };
}

/**
 * The cost of selling `x` A on a venue measured as a constant-product pool of `depthA` A with its own
 * one-way fee `fee` (a fraction), the bot's reading of a venue (`readVenue`: depth = size / impact).
 * An approximation for a concentrated-liquidity venue: good near the size it was measured at (1,000 XRD).
 */
export function venueSellCost(depthA: number, fee: number, x: number): number | undefined {
  if (!(depthA > 0 && x > 0 && fee >= 0 && fee < 1)) return undefined;
  const eff = x * (1 - fee);
  return 1 - ((1 - fee) * depthA) / (depthA + eff);
}

// ------------------------------------------------------------------ positions on a scale

export interface Scale { min: number; max: number; pos: (v: number) => number }

/** A linear scale holding every finite positive value given, padded by `pad` of the span each side; `pos` is 0-100 (%), clamped. */
export function priceScale(values: (number | null | undefined)[], pad = 0.08): Scale | undefined {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!xs.length) return undefined;
  let lo = Math.min(...xs), hi = Math.max(...xs);
  if (hi === lo) { lo *= 0.99; hi *= 1.01; }
  const span = hi - lo;
  const min = lo - span * pad, max = hi + span * pad;
  return { min, max, pos: (v: number) => Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) };
}

// ------------------------------------------------------------------ the split and the limits

export interface SplitPart { key: 'reserveA' | 'inventoryA' | 'reserveB' | 'inventoryB'; amount: number; valueB: number; share: number }

/** Each holding's value in B at `price` (B per A), and its share of the whole; parts at zero are kept with share 0. */
export function splitParts(h: { reserveA: number; reserveB: number; inventoryA: number; inventoryB: number }, price: number): SplitPart[] {
  const raw: Omit<SplitPart, 'share'>[] = [
    { key: 'reserveA', amount: h.reserveA, valueB: h.reserveA * price },
    { key: 'inventoryA', amount: h.inventoryA, valueB: h.inventoryA * price },
    { key: 'reserveB', amount: h.reserveB, valueB: h.reserveB },
    { key: 'inventoryB', amount: h.inventoryB, valueB: h.inventoryB },
  ];
  const total = raw.reduce((s, p) => s + Math.max(0, p.valueB), 0);
  return raw.map((p) => ({ ...p, share: total > 0 ? Math.max(0, p.valueB) / total : 0 }));
}

export interface LimitRow {
  reserve: number; floor: number; cap: number;
  /** Room before the cap and above the floor, in the token (negative: already past it). */
  toCap: number; aboveFloor: number;
  /** Where the reserve sits between floor (0) and cap (1); outside 0-1 when past a limit. */
  within: number;
  state: 'ok' | 'near' | 'past';
}

/** A reserve against its operator floor and cap. "near" = within `nearFrac` of the floor-to-cap span of either. */
export function limitRow(reserve: number, floor: number, cap: number, nearFrac = 0.1): LimitRow {
  const span = cap - floor;
  const within = span > 0 ? (reserve - floor) / span : reserve >= cap ? 1 : 0;
  const state = reserve > cap || reserve < floor ? 'past' : within <= nearFrac || within >= 1 - nearFrac ? 'near' : 'ok';
  return { reserve, floor, cap, toCap: cap - reserve, aboveFloor: reserve - floor, within, state };
}

// ------------------------------------------------------------------ the allowance

/** Radix mainnet's epoch is about five minutes (the consensus manager's target); the page says "about". */
export const EPOCH_MINUTES = 5;

export interface AllowanceGauge {
  now: number; budget: number;
  /** now / budget, 0-1. */
  share: number;
  /** The part the bot keeps back (reserveFraction of one budget). */
  held: number;
  /** What the bot would spend on its next move: min(now * spendFraction, now - held), never below 0. */
  spendable: number;
  /** Epochs until full, by the contract's linear refill (budget over the window). */
  epochsToFull: number;
  minutesToFull: number;
}

export function allowanceGauge(a: { now: number; budget: number; windowEpochs: number }, rules: { reserveFraction: number; spendFraction: number }): AllowanceGauge | undefined {
  if (!(a.budget > 0) || !(a.windowEpochs > 0) || !Number.isFinite(a.now)) return undefined;
  const now = Math.min(Math.max(0, a.now), a.budget);
  const held = a.budget * rules.reserveFraction;
  const spendable = Math.max(0, Math.min(now * rules.spendFraction, now - held));
  const epochsToFull = Math.max(0, Math.ceil(((a.budget - now) / a.budget) * a.windowEpochs - 1e-9));
  return { now, budget: a.budget, share: now / a.budget, held, spendable, epochsToFull, minutesToFull: epochsToFull * EPOCH_MINUTES };
}

/** "35 min", "4 h 10 min", "1 d 3 h". */
export function fmtDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'now';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; }
  const d = Math.floor(m / 1440), h = Math.round((m % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** A fraction as a signed or plain percentage: 0.01234 → "1.23%", with `sign` "+1.23%" / "-1.23%". */
export function fmtPct(f: number, digits = 2, sign = false): string {
  if (!Number.isFinite(f)) return '—';
  const s = (Math.abs(f) * 100).toFixed(digits);
  return `${sign ? (f > 0 ? '+' : f < 0 ? '-' : '') : f < 0 ? '-' : ''}${s}%`;
}

/**
 * Ticks for a price scale, as percentages from `ref` (the market): the finest of 0.5 / 1 / 2 / 5 / 10 / 20%
 * that gives at most `maxTicks` inside the scale. Each tick's price is ref * (1 + pct).
 */
export function pctTicks(s: Pick<Scale, 'min' | 'max'>, ref: number, maxTicks = 7): { price: number; pct: number }[] {
  if (!(ref > 0) || !(s.max > s.min)) return [];
  const lo = s.min / ref - 1, hi = s.max / ref - 1;
  for (const step of [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]) {
    const first = Math.ceil(lo / step - 1e-9), last = Math.floor(hi / step + 1e-9);
    if (last - first + 1 <= maxTicks) {
      const out: { price: number; pct: number }[] = [];
      for (let k = first; k <= last; k++) { const pct = Math.round(k * step * 1e6) / 1e6; out.push({ price: ref * (1 + pct), pct }); }
      return out;
    }
  }
  return [];
}

/**
 * The table row's mini gauge: the pool's gap to the market on a scale of ± max(2 × fee, 1.25 × |gap|),
 * as percentages across the gauge (market at 50). `band` is the fee either side of the market.
 */
export function miniGap(gapBps: number | null | undefined, feeBps: number): { dot: number; bandLo: number; bandHi: number; clipped: boolean } | undefined {
  if (gapBps == null || !Number.isFinite(gapBps)) return undefined;
  const half = Math.max(2 * feeBps, 1.25 * Math.abs(gapBps), 1);
  const at = (b: number) => 50 + (b / half) * 50;
  const dot = at(gapBps);
  return { dot: Math.min(100, Math.max(0, dot)), bandLo: at(-feeBps), bandHi: at(feeBps), clipped: dot < 0 || dot > 100 };
}
