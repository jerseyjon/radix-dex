// The Pools page's pure logic: what the page shows of an OwnerPool, its activity, the bot's files, and
// the owner's actions planned with the shared manifest builders (packages/core/src/ownerpool-ops.ts and
// ownerpool-setup.ts, the same ones scripts/mainnet-owner-pool.ts uses). No I/O here; pools.ts reads
// the ledger and the files and calls these.
import {
  Decimal, OWNER_POOL_BOT_DEFAULTS, OWNER_POOL_MAX_FEE_BPS, heartbeatVerdict, ownerPoolAnchorDistance, ownerPoolDepositManifest, ownerPoolLimitsAndFeeManifest,
  ownerPoolSetAnchorManifest, ownerPoolSetFeeManifest, ownerPoolSetOperatorManifest, ownerPoolSetPausedManifest, ownerPoolStepMismatches,
  ownerPoolWithdrawManifest, parseMarkoutLines, priceGap, proportionalB, summarizeMarkouts,
  type OwnerPoolEvent, type OwnerPoolOperatorLimits, type OwnerPoolState, type OwnerPoolTx, type PreviewResult, type VenueReading,
} from '@radix-dex/core';

// ------------------------------------------------------------------ prices

/** B per A on the curve (reserveB / reserveA), or undefined for an empty side. */
export function curvePrice(s: Pick<OwnerPoolState, 'reserveA' | 'reserveB'>): number | undefined {
  const a = Number(s.reserveA), b = Number(s.reserveB);
  return a > 0 && b > 0 ? b / a : undefined;
}

/** The pool's price against the market, in basis points: positive = the pool is dearer (more B per A) than the market. */
export function gapBps(pool: number | undefined, market: number | undefined): number | undefined {
  if (!(pool! > 0) || !(market! > 0)) return undefined;
  return (pool! / market! - 1) * 10_000;
}

// ------------------------------------------------------------------ activity

export type ActivityKind = 'swap' | 'owner' | 'operator' | 'other';
export interface PoolActivity {
  txid: string;
  at: number;
  stateVersion: number;
  kind: ActivityKind;
  /** The pool methods the transaction called (e.g. "set_fee", "swap_with_minimum"). */
  methods: string[];
  /** One line per event the pool emitted, for people. */
  lines: string[];
  /** Swaps only: what went in and came out, and the fee (in the input token). */
  swap?: { input: string; inputAmount: string; output: string; outputAmount: string; fee: string };
}

const OPERATOR_METHODS = new Set(['rebalance', 'operator_set_fee', 'set_operator_paused']);

/**
 * Who acted in a transaction: the OWNER when its manifest proved the owner badge (only the owner badge
 * can call the owner methods, so a proof of it is the owner acting); the OPERATOR when it proved another
 * badge and called an operator method; a swap when the pool emitted a swap event; else "other".
 */
export function describePoolTx(tx: OwnerPoolTx, ctx: { ownerBadge?: string; resourceA: string; resourceB: string; symbol: (r: string) => string }): PoolActivity {
  const proofs = tx.proofs ?? [];
  const sym = ctx.symbol;
  const kind: ActivityKind = ctx.ownerBadge && proofs.includes(ctx.ownerBadge) ? 'owner'
    : tx.methods.some((m) => OPERATOR_METHODS.has(m)) ? 'operator'
      : tx.events.some((e) => e.name === 'OwnerPoolSwapEvent') ? 'swap' : 'other';
  const lines: string[] = [];
  let swap: PoolActivity['swap'];
  for (const e of tx.events) {
    const line = eventLine(e, ctx.resourceA, ctx.resourceB, sym);
    if (line) lines.push(line);
    if (e.name === 'OwnerPoolSwapEvent' && e.inputResource && e.outputResource && e.inputAmount && e.outputAmount) {
      swap ??= { input: e.inputResource, inputAmount: e.inputAmount, output: e.outputResource, outputAmount: e.outputAmount, fee: e.fee ?? '0' };
    }
  }
  return { txid: tx.txid, at: tx.at, stateVersion: tx.stateVersion, kind, methods: tx.methods, lines, ...(swap ? { swap } : {}) };
}

function eventLine(e: OwnerPoolEvent, a: string, b: string, sym: (r: string) => string): string | undefined {
  switch (e.name) {
    case 'OwnerPoolSwapEvent':
      return e.inputResource && e.outputResource
        ? `swap ${e.inputAmount} ${sym(e.inputResource)} for ${e.outputAmount} ${sym(e.outputResource)} (fee ${e.fee ?? '?'} ${sym(e.inputResource)})`
        : `swap; reserves now ${e.reserveA} ${sym(a)} / ${e.reserveB} ${sym(b)}`;
    case 'OwnerPoolConfigEvent':
      return `fee ${e.feeBps} bps, owner pause ${e.paused ? 'on' : 'off'}, operator pause ${e.operatorPaused ? 'on' : 'off'}`;
    case 'OwnerPoolAnchorEvent':
      return `anchor stated: ${e.anchorA} ${sym(a)} : ${e.anchorB} ${sym(b)}`;
    case 'OwnerPoolRebalanceEvent': {
      // Positive amounts went from the inventory into the reserves; negative ones the other way.
      const move = (amt: string, r: string) => (Number(amt) === 0 ? undefined : `${amt.replace(/^-/, '')} ${sym(r)} ${amt.startsWith('-') ? 'reserves → inventory' : 'inventory → reserves'}`);
      const moves = [move(e.amountA, a), move(e.amountB, b)].filter(Boolean).join(', ') || 'nothing';
      return `${e.byOwner ? 'owner' : 'operator'} moved ${moves}; reserves now ${e.reserveA} ${sym(a)} / ${e.reserveB} ${sym(b)}${e.byOwner ? '' : `; budget used ${e.cost}, left ${e.allowance}`}`;
    }
    case 'OwnerPoolLiquidityEvent':
      return `reserves set to ${e.reserveA} ${sym(a)} / ${e.reserveB} ${sym(b)}`;
    case 'OwnerPoolInventoryEvent':
      return `inventory now ${e.inventoryA} ${sym(a)} / ${e.inventoryB} ${sym(b)}`;
    case 'OwnerPoolOperatorEvent':
      return e.operator ? `operator: ${e.operator}${e.limits ? ' (limits updated)' : ''}` : e.limits ? 'operator limits set' : 'operator revoked';
    default:
      return undefined;
  }
}

/** Fees the pool has kept, per token, summed over swap events (kept in the input token). */
export interface FeeTotals { swaps: number; feeA: string; feeB: string; volumeA: string; volumeB: string; firstAt: number | null; lastAt: number | null }
export const NO_FEES: FeeTotals = { swaps: 0, feeA: '0', feeB: '0', volumeA: '0', volumeB: '0', firstAt: null, lastAt: null };

/** `acc` plus the swaps in `txs` (each counted once by its event; the caller feeds each transaction once). */
export function addFees(acc: FeeTotals, txs: OwnerPoolTx[], resourceA: string, resourceB: string): FeeTotals {
  let { swaps, firstAt, lastAt } = acc;
  let feeA = new Decimal(acc.feeA), feeB = new Decimal(acc.feeB), volA = new Decimal(acc.volumeA), volB = new Decimal(acc.volumeB);
  for (const t of txs) {
    for (const e of t.events) {
      if (e.name !== 'OwnerPoolSwapEvent' || !e.inputResource || e.inputAmount === undefined) continue;
      swaps++;
      firstAt = firstAt === null ? t.at : Math.min(firstAt, t.at);
      lastAt = lastAt === null ? t.at : Math.max(lastAt, t.at);
      const fee = new Decimal(e.fee ?? '0');
      if (e.inputResource === resourceA) { feeA = feeA.plus(fee); volA = volA.plus(e.inputAmount); }
      else if (e.inputResource === resourceB) { feeB = feeB.plus(fee); volB = volB.plus(e.inputAmount); }
    }
  }
  return { swaps, feeA: feeA.toFixed(), feeB: feeB.toFixed(), volumeA: volA.toFixed(), volumeB: volB.toFixed(), firstAt, lastAt };
}

// ------------------------------------------------------------------ the bot's and watcher's files

/** A process's heartbeat as the page shows it: never its pid, host or file path. */
export interface ProcessHealth { status: 'alive' | 'stale' | 'missing' | 'other-pool'; lastSeen: number | null; tick: number | null; ok: boolean | null; note: string | null }

/** The heartbeat file's content (undefined: no file) judged for `pool`, stale after `maxAgeMs` (the heartbeat timer's 600 s). */
export function heartbeatView(content: string | undefined, pool: string, now: number, maxAgeMs: number): ProcessHealth {
  const v = heartbeatVerdict(content, now, maxAgeMs);
  const b = v.beat;
  if (!b) return { status: 'missing', lastSeen: null, tick: null, ok: null, note: content === undefined ? null : v.reason.replace(/pid \d+, ?/, '') };
  if (b.pool !== pool) return { status: 'other-pool', lastSeen: null, tick: null, ok: null, note: 'the heartbeat is for another pool' };
  return { status: v.alive ? 'alive' : 'stale', lastSeen: b.at, tick: Number.isFinite(b.tick) ? b.tick : null, ok: typeof b.ok === 'boolean' ? b.ok : null, note: typeof b.note === 'string' ? b.note.slice(0, 200) : null };
}

/** What the page shows of the bot's state file: its last transaction, pause, reference and anchor; nothing else. */
export interface BotView {
  operatorAccount: string | null;
  lastTx: { at: string; type: string; txid: string; status: string } | null;
  pending: { txid: string; type: string; at: number } | null;
  pausedByBot: boolean;
  pauseReason: string | null;
  consecutiveFailures: number;
  haltedUntil: number | null;
  behindTicks: number;
  /** The bot's last reference price in pool units (B per A, its scale applied), and when. */
  reference: { at: number; price: number } | null;
  confirmedVenues: string[];
  singleVenueSince: number | null;
  ownerAnchor: { anchor: [string, string]; txid: string; at: number } | null;
  lastFeeChangeAt: number | null;
}

/** The bot's state file (parsed JSON) for `pool`, or undefined when it is another pool's or unreadable. */
export function botView(j: any, pool: string): BotView | undefined {
  if (!j || typeof j !== 'object' || j.identity?.pool !== pool) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const last = Array.isArray(j.history) ? j.history[j.history.length - 1] : undefined;
  const scale = num(j.calibration?.scale) ?? 1;
  const st = j.ownerAnchor?.statement;
  const lt = j.lastTx;
  return {
    operatorAccount: typeof j.identity?.operatorAccount === 'string' ? j.identity.operatorAccount : null,
    lastTx: lt && typeof lt.txid === 'string' ? { at: String(lt.at), type: String(lt.type), txid: lt.txid, status: String(lt.status) } : null,
    pending: j.pending && typeof j.pending.txid === 'string' ? { txid: j.pending.txid, type: String(j.pending.type), at: num(j.pending.at) ?? 0 } : null,
    pausedByBot: j.pause?.pausedByBot === true,
    pauseReason: typeof j.pause?.pauseReason === 'string' ? j.pause.pauseReason.slice(0, 200) : null,
    consecutiveFailures: num(j.consecutiveFailures) ?? 0,
    haltedUntil: num(j.haltedUntil),
    behindTicks: num(j.behindTicks) ?? 0,
    reference: last && num(last.price) && num(last.at) ? { at: last.at, price: last.price * scale } : null,
    confirmedVenues: Array.isArray(j.venueConfirm?.confirmed) ? j.venueConfirm.confirmed.map(String) : [],
    singleVenueSince: num(j.singleVenue?.since),
    ownerAnchor: st && Array.isArray(st.anchor) ? { anchor: [String(st.anchor[0]), String(st.anchor[1])], txid: String(st.txid), at: num(st.at) ?? 0 } : null,
    lastFeeChangeAt: num(j.lastFeeChangeAt),
  };
}

/** The markout record's summary (scripts/owner-pool-markout.ts's figures), in token A. */
export function markoutView(text: string, horizonsMin = [5, 30]) {
  const records = parseMarkoutLines(text);
  const sum = summarizeMarkouts(records, { horizonsMin });
  const trades = records.filter((r) => r.kind === 'trade');
  return { horizonsMin, trades: sum.all.trades, pending: sum.pending, all: sum.all, bySize: sum.bySize, byFeeBps: sum.byFeeBps, lastTradeAt: trades.length ? Math.max(...trades.map((t) => t.at)) : null };
}

// ------------------------------------------------------------------ the graphics' inputs

/**
 * The bot's rules the page draws around the prices, read from the bot's own defaults
 * (OWNER_POOL_BOT_DEFAULTS): the anchor stop (it stops following, and pauses, when its reference is
 * more than `anchorStop` from the owner's anchor; resumes inside `anchorStop * anchorResume`), the dead
 * band (no rebalance while the curve is this close to the reference; null in the defaults = half the
 * pool's fee), and the share of the allowance it keeps back and spends per tick. The fee band is the
 * pool's own fee either side of the reference: inside it an arbitrage swap does not pay.
 * The defaults, not the running bot's flags: the service passes none of these today.
 */
export interface BotRules {
  source: string;
  anchorStop: number;
  anchorResume: number;
  deadBandBps: number;
  feeBandBps: number;
  reserveFraction: number;
  spendFraction: number;
}

export function botRules(feeBps: number, d: Pick<typeof OWNER_POOL_BOT_DEFAULTS, 'maxAnchorDistance' | 'anchorResumeFactor' | 'deadBandBps' | 'reserveFraction' | 'spendFraction'> = OWNER_POOL_BOT_DEFAULTS): BotRules {
  return {
    source: "the bot's defaults",
    anchorStop: d.maxAnchorDistance,
    anchorResume: d.maxAnchorDistance * d.anchorResumeFactor,
    deadBandBps: d.deadBandBps ?? feeBps / 2,
    feeBandBps: feeBps,
    reserveFraction: d.reserveFraction,
    spendFraction: d.spendFraction,
  };
}

/**
 * The owner's anchor the bot measures its stop from: the owner's last statement on the ledger as the
 * bot read it (its state file), else the pool's ledger anchor (which the operator's costed moves also
 * restate, so it is only the owner's until the bot moves the curve).
 */
export function ownerAnchorView(bot: Pick<BotView, 'ownerAnchor'> | undefined, ledgerAnchor: [string, string] | undefined): { anchor: [string, string]; price: number; source: 'owner-statement' | 'ledger'; at: number | null } | null {
  const pick = bot?.ownerAnchor ? { anchor: bot.ownerAnchor.anchor, source: 'owner-statement' as const, at: bot.ownerAnchor.at || null } : ledgerAnchor ? { anchor: ledgerAnchor, source: 'ledger' as const, at: null } : undefined;
  if (!pick) return null;
  const price = Number(pick.anchor[1]) / Number(pick.anchor[0]);
  return Number.isFinite(price) && price > 0 ? { ...pick, price } : null;
}

/** A reference venue as the page shows it: its fee-free mid, and its measured depth (A) and own fee for the depth overlay. */
export interface VenueView { venue: string; used: boolean; mid: number | null; dropped: string | null; depth: number | null; fee: number | null }
export function venueViews(readings: Pick<VenueReading, 'venue' | 'used' | 'mid' | 'dropped' | 'depth' | 'fee'>[]): VenueView[] {
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return readings.map((v) => ({ venue: v.venue, used: v.used, mid: n(v.mid), dropped: v.dropped ?? null, depth: n(v.depth), fee: n(v.fee) }));
}

// ------------------------------------------------------------------ owner actions

export const OWNER_ACTIONS = ['deposit', 'withdraw', 'pause', 'unpause', 'fee', 'anchor', 'limits-fee', 'revoke'] as const;
export type OwnerAction = typeof OWNER_ACTIONS[number];
export const isOwnerAction = (a: unknown): a is OwnerAction => typeof a === 'string' && (OWNER_ACTIONS as readonly string[]).includes(a);

/** What an action's caller wants, already the right shapes (pools.ts checks the request body into this). */
export interface OwnerActionInput {
  action: OwnerAction;
  state: OwnerPoolState;
  owner: { account: string; badge: string };
  params: Record<string, unknown>;
  /** The market reference (B per A) under the bot's rules, when there is one. */
  market?: { price: number; source: string };
  /** Largest gap from the market a deposit may be made at without `force` (the script's --max-gap). */
  maxGap?: number;
  symbol?: (r: string) => string;
}

export interface OwnerActionPlan {
  action: OwnerAction;
  title: string;
  manifest: string;
  /** What the ledger must show afterwards (ownerPoolStepMismatches' `want`). */
  want: Parameters<typeof ownerPoolStepMismatches>[1];
  notes: string[];
  /** The step's name in scripts/mainnet-owner-pool.ts, for the runbook. */
  scriptStep: string;
}

export class OwnerActionError extends Error {}

const PLAIN = /^\d{1,30}(\.\d{1,18})?$/;
function amount(v: unknown, what: string, divisibility: number, required = true): string | undefined {
  if (v === undefined || v === null || v === '') { if (required) throw new OwnerActionError(`${what} is required`); return undefined; }
  const s = String(v).trim();
  if (!PLAIN.test(s)) throw new OwnerActionError(`${what} must be a plain decimal amount`);
  const d = new Decimal(s);
  if (d.decimalPlaces() > divisibility) throw new OwnerActionError(`${what} has more than ${divisibility} decimal places (the token's limit)`);
  return d.toFixed();
}
function bps(v: unknown, what: string, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) throw new OwnerActionError(`${what} must be a whole number from 0 to ${max}`);
  return n;
}
const plus = (a: string, b: string) => new Decimal(a).plus(b).toFixed();
const minus = (a: string, b: string) => new Decimal(a).minus(b).toFixed();
const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

/**
 * Build one owner action's manifest with the shared builders, with the same guards and checks as
 * scripts/mainnet-owner-pool.ts. Never a fee lock: the wallet adds its own. Throws OwnerActionError
 * with the reason when the action is refused.
 */
export function planOwnerAction(i: OwnerActionInput): OwnerActionPlan {
  const p = i.state, s = p.split, sym = i.symbol ?? ((r: string) => r);
  const base = { pool: p.address, owner: i.owner };
  const symA = sym(p.resourceA), symB = sym(p.resourceB);
  const expected: [string, string] = [p.reserveA, p.reserveB];
  const needSplit = () => { if (!s) throw new OwnerActionError('This pool has no operator (not a split OwnerPool)'); return s; };
  const force = i.params.force === true;
  const maxGap = i.maxGap ?? 0.01;
  const checkMarket = (what: string, price: number): string => {
    if (!i.market) {
      if (force) return `No market price for this pair: ${what} (${price.toPrecision(8)} ${symB} per ${symA}) was not checked (you confirmed it yourself).`;
      throw new OwnerActionError(`No market price for this pair, so ${what} cannot be checked. Confirm the price yourself to go ahead.`);
    }
    const gap = priceGap(price, i.market.price);
    const line = `${what}: ${price.toPrecision(8)}; market ${i.market.price.toPrecision(8)} (${i.market.source}); gap ${pct(gap)} (limit ${(maxGap * 100).toFixed(2)}%).`;
    if (gap > maxGap && !force) throw new OwnerActionError(`${line} Refused: restore the curve first, or confirm to go ahead anyway.`);
    return line;
  };

  switch (i.action) {
    case 'deposit': {
      const a = amount(i.params.amountA, `Amount of ${symA}`, p.divisibilityA, false) ?? '0', b = amount(i.params.amountB, `Amount of ${symB}`, p.divisibilityB, false) ?? '0';
      if (new Decimal(a).isZero() && new Decimal(b).isZero()) throw new OwnerActionError('Give an amount of at least one token');
      const empty = new Decimal(p.reserveA).isZero() || new Decimal(p.reserveB).isZero();
      if (empty && (new Decimal(a).isZero() || new Decimal(b).isZero())) throw new OwnerActionError('The pool is empty: deposit both tokens (this sets the price)');
      const price = empty ? new Decimal(b).div(a).toNumber() : new Decimal(p.reserveB).div(p.reserveA).toNumber();
      const marketLine = checkMarket(empty ? 'the price this deposit sets (empty pool)' : "the curve's price", price);
      return {
        action: 'deposit', scriptStep: 'deposit', title: `Deposit ${a} ${symA} and ${b} ${symB} into the reserves`,
        manifest: ownerPoolDepositManifest({ ...base, resourceA: p.resourceA, resourceB: p.resourceB, amountA: a, amountB: b, expected }),
        want: { reserves: [plus(p.reserveA, a), plus(p.reserveB, b)] },
        notes: [marketLine, `Guarded: fails "Reserves moved" unless the pool still holds exactly ${p.reserveA} ${symA} / ${p.reserveB} ${symB} when it runs (a swap in between: prepare it again).`,
          ...(new Decimal(a).isZero() || new Decimal(b).isZero() || !new Decimal(b).div(a).eq(new Decimal(p.reserveB).div(p.reserveA)) ? ['The amounts are not in the curve\'s proportion: the deposit moves the price.'] : [])],
      };
    }
    case 'withdraw': {
      const a = amount(i.params.amountA, `Amount of ${symA}`, p.divisibilityA)!;
      const given = amount(i.params.amountB, `Amount of ${symB}`, p.divisibilityB, false);
      const b = given ?? proportionalB(p, a);
      if (new Decimal(a).gt(p.reserveA) || new Decimal(b).gt(p.reserveB)) throw new OwnerActionError(`More than the reserves (${p.reserveA} ${symA} / ${p.reserveB} ${symB})`);
      if (new Decimal(a).isZero() && new Decimal(b).isZero()) throw new OwnerActionError('Nothing to withdraw');
      return {
        action: 'withdraw', scriptStep: 'withdraw', title: `Withdraw ${a} ${symA} and ${b} ${symB} from the reserves`,
        manifest: ownerPoolWithdrawManifest({ ...base, amountA: a, amountB: b, expected }),
        want: { reserves: [minus(p.reserveA, a), minus(p.reserveB, b)] },
        notes: [`Guarded by the reserves read now (${p.reserveA} ${symA} / ${p.reserveB} ${symB}).`, given === undefined ? `${symB} is the proportional amount, so the price stays where it is.` : 'Both amounts as given: the price moves unless they are in the curve\'s proportion.',
          'The tokens go to the owner account that signs.'],
      };
    }
    case 'pause':
    case 'unpause': {
      const paused = i.action === 'pause';
      const notes = paused ? ['The owner\'s pause: swaps, the operator\'s rebalance and its fee changes stop. Only the owner can lift it.']
        : ['Lifts the owner\'s pause: swaps reopen at the curve as it stands. Check the price against the market first.'];
      if (!paused && s?.operatorPaused) notes.push('The operator\'s own pause is also on: swaps stay closed until the operator (the bot) lifts it.');
      return { action: i.action, scriptStep: i.action, title: paused ? 'Pause the pool (owner pause)' : 'Lift the owner pause', manifest: ownerPoolSetPausedManifest({ ...base, paused }), want: { ownerPaused: paused }, notes };
    }
    case 'fee': {
      const feeBps = bps(i.params.feeBps, 'The fee', OWNER_POOL_MAX_FEE_BPS);
      const notes: string[] = [];
      if (s && (feeBps < s.limits.minFeeBps || feeBps > s.limits.maxFeeBps)) notes.push(`${feeBps} bps is outside the operator's range ${s.limits.minFeeBps}-${s.limits.maxFeeBps}: the bot will move it back inside on its next fee change. Use "limits and fee" to change both.`);
      return { action: 'fee', scriptStep: 'fee', title: `Set the fee to ${feeBps} bps`, manifest: ownerPoolSetFeeManifest({ ...base, feeBps }), want: { feeBps }, notes };
    }
    case 'anchor': {
      needSplit();
      let price: Decimal, source: string;
      if (i.params.price !== undefined && i.params.price !== null && i.params.price !== '') {
        const v = String(i.params.price).trim();
        if (!PLAIN.test(v) || !new Decimal(v).gt(0)) throw new OwnerActionError('The anchor price must be a positive plain decimal');
        price = new Decimal(v); source = 'as you stated it';
      } else {
        if (!i.market) throw new OwnerActionError('No market price for this pair: state the anchor price yourself');
        price = new Decimal(i.market.price).toDecimalPlaces(12, Decimal.ROUND_HALF_EVEN); source = `the market now (${i.market.source})`;
      }
      const anchor: [string, string] = ['1', price.toFixed()];
      const dist = ownerPoolAnchorDistance(p, anchor);
      return {
        action: 'anchor', scriptStep: 'anchor', title: `Restate the anchor: 1 ${symA} : ${anchor[1]} ${symB}`,
        manifest: ownerPoolSetAnchorManifest({ ...base, anchor, expected }), want: { anchor },
        notes: [`Price from ${source}.`, `The anchor is ${pct(dist)} from the curve's price.${dist > 0.02 ? ' That is more than 2%: the operator can only walk the curve toward it within its budget.' : ''}`,
          'Zeroes the operator\'s allowance (it refills over the window). Guarded by the reserves read now.'],
      };
    }
    case 'limits-fee': {
      const cur = needSplit().limits;
      const l = (i.params.limits ?? {}) as Record<string, unknown>;
      if (typeof l !== 'object' || Array.isArray(l)) throw new OwnerActionError('limits must be an object');
      const known = ['moveBudgetBps', 'windowEpochs', 'maxReserveA', 'maxReserveB', 'minReserveA', 'minReserveB', 'minFeeBps', 'maxFeeBps'];
      for (const k of Object.keys(l)) if (!known.includes(k)) throw new OwnerActionError(`Unknown limit ${k}`);
      const pick = <T>(k: string, f: (v: unknown) => T, dflt: T): T => (l[k] === undefined || l[k] === '' ? dflt : f(l[k]));
      const windowEpochs = pick('windowEpochs', (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw new OwnerActionError('The window must be a whole number of epochs from 1'); return n; }, cur.windowEpochs);
      const limits: OwnerPoolOperatorLimits = {
        moveBudgetBps: pick('moveBudgetBps', (v) => bps(v, 'The budget', 10_000), cur.moveBudgetBps),
        windowEpochs,
        maxReserveA: pick('maxReserveA', (v) => amount(v, `Cap of ${symA}`, p.divisibilityA)!, cur.maxReserveA),
        maxReserveB: pick('maxReserveB', (v) => amount(v, `Cap of ${symB}`, p.divisibilityB)!, cur.maxReserveB),
        minReserveA: pick('minReserveA', (v) => amount(v, `Floor of ${symA}`, p.divisibilityA)!, cur.minReserveA),
        minReserveB: pick('minReserveB', (v) => amount(v, `Floor of ${symB}`, p.divisibilityB)!, cur.minReserveB),
        minFeeBps: pick('minFeeBps', (v) => bps(v, 'The lowest operator fee', OWNER_POOL_MAX_FEE_BPS), cur.minFeeBps),
        maxFeeBps: pick('maxFeeBps', (v) => bps(v, 'The highest operator fee', OWNER_POOL_MAX_FEE_BPS), cur.maxFeeBps),
      };
      const feeBps = i.params.feeBps === undefined || i.params.feeBps === '' ? p.feeBps : bps(i.params.feeBps, 'The fee', OWNER_POOL_MAX_FEE_BPS);
      let manifest: string;
      try { manifest = ownerPoolLimitsAndFeeManifest({ ...base, limits, feeBps }); } catch (e) { throw new OwnerActionError((e as Error).message); }
      const changed = known.filter((k) => String((limits as any)[k]) !== String((cur as any)[k]));
      const notes = [changed.length ? `Changes: ${changed.map((k) => `${k} ${(cur as any)[k]} → ${(limits as any)[k]}`).join(', ')}.` : 'The limits stay as they are.',
        `Fee ${p.feeBps} → ${feeBps} bps, in the same transaction (a lower maximum does not clamp the fee in force).`];
      if (new Decimal(p.reserveA).gt(limits.maxReserveA) || new Decimal(p.reserveB).gt(limits.maxReserveB)) notes.push('The reserves are above the new caps: the operator can only reduce them.');
      return { action: 'limits-fee', scriptStep: 'limits-fee', title: 'Set the operator limits and the fee', manifest, want: { limits, feeBps }, notes };
    }
    case 'revoke': {
      const st = needSplit();
      if (i.params.confirm !== 'REVOKE') throw new OwnerActionError('Type REVOKE to confirm the emergency stop');
      return {
        action: 'revoke', scriptStep: 'revoke', title: 'EMERGENCY STOP: revoke the operator',
        manifest: ownerPoolSetOperatorManifest({ ...base, operator: null }),
        want: { operator: null, ownerPaused: true, operatorPaused: false },
        notes: [`The operator badge ${st.operator ?? '(none appointed)'} loses every right in this transaction and the owner's pause goes on: swaps stop.`,
          'To restart: check the curve, make a NEW operator badge and appoint it (scripts/mainnet-owner-pool.ts operator-badge --replace, then appoint), then lift the pause.'],
      };
    }
  }
}

// ------------------------------------------------------------------ previews

export interface PreviewView {
  ok: boolean;
  error: string | null;
  feeXrd: string;
  /** Badges the manifest proves, and from which account. */
  proofs: { account: string; badge: string; label: string }[];
  /** Net balance changes by entity, as the wallet will show them. */
  changes: { entity: string; label: string; items: { resource: string; symbol: string; amount: string }[] }[];
}

/** The Gateway's preview of a manifest, in the terms the owner reads (the script's `describe`). */
export function previewView(manifest: string, pv: Pick<PreviewResult, 'ok' | 'error' | 'feeXrd' | 'changes'>, ctx: { owner: string; pool: string; ownerBadge: string; symbol: (r: string) => string }): PreviewView {
  const label = (e: string) => (e === ctx.owner ? 'your account' : e === ctx.pool ? 'the pool' : e);
  const proofs = [...manifest.matchAll(/CALL_METHOD Address\("([^"]+)"\) "create_proof_of_amount" Address\("([^"]+)"\)/g)]
    .map(([, account, badge]) => ({ account: account!, badge: badge!, label: badge === ctx.ownerBadge ? 'pool owner badge' : ctx.symbol(badge!) }));
  const by = new Map<string, PreviewView['changes'][number]>();
  for (const c of pv.changes) {
    const g = by.get(c.entity) ?? { entity: c.entity, label: label(c.entity), items: [] };
    g.items.push({ resource: c.resource, symbol: c.resource === ctx.ownerBadge ? 'pool owner badge' : ctx.symbol(c.resource), amount: c.amount });
    by.set(c.entity, g);
  }
  return { ok: pv.ok, error: pv.ok ? null : String(pv.error ?? 'failed').slice(0, 600), feeXrd: pv.feeXrd, proofs, changes: [...by.values()] };
}

/** Check a `want` sent back by the page: only the fields ownerPoolStepMismatches reads, in their shapes. */
export function cleanWant(w: any): Parameters<typeof ownerPoolStepMismatches>[1] {
  const out: Parameters<typeof ownerPoolStepMismatches>[1] = {};
  if (!w || typeof w !== 'object') return out;
  const dec = (v: unknown) => typeof v === 'string' && /^-?\d{1,40}(\.\d{1,18})?$/.test(v);
  const pairOk = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && dec(v[0]) && dec(v[1]);
  if (pairOk(w.reserves)) out.reserves = w.reserves;
  if (pairOk(w.inventory)) out.inventory = w.inventory;
  const res = (v: unknown): v is string => typeof v === 'string' && /^resource_[a-z0-9_]{20,90}$/.test(v);
  if (Array.isArray(w.resources) && w.resources.length === 2 && w.resources.every(res)) out.resources = [w.resources[0], w.resources[1]];
  if (res(w.ownerBadge)) out.ownerBadge = w.ownerBadge;
  if (pairOk(w.anchor)) out.anchor = w.anchor;
  if (Number.isInteger(w.feeBps)) out.feeBps = w.feeBps;
  if (typeof w.ownerPaused === 'boolean') out.ownerPaused = w.ownerPaused;
  if (typeof w.operatorPaused === 'boolean') out.operatorPaused = w.operatorPaused;
  if (w.operator === null || (typeof w.operator === 'string' && /^resource_[a-z0-9_]+$/.test(w.operator))) out.operator = w.operator;
  const l = w.limits;
  if (l && typeof l === 'object' && ['moveBudgetBps', 'windowEpochs', 'minFeeBps', 'maxFeeBps'].every((k) => Number.isInteger(l[k])) && ['maxReserveA', 'maxReserveB', 'minReserveA', 'minReserveB'].every((k) => dec(l[k]))) {
    out.limits = { moveBudgetBps: l.moveBudgetBps, windowEpochs: l.windowEpochs, minFeeBps: l.minFeeBps, maxFeeBps: l.maxFeeBps, maxReserveA: l.maxReserveA, maxReserveB: l.maxReserveB, minReserveA: l.minReserveA, minReserveB: l.minReserveB };
  }
  return out;
}
