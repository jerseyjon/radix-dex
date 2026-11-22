import type { OwnerPoolEvent, OwnerPoolTx } from './ownerpool-events.ts';

/**
 * Per-trade profit record ("markout") for an OwnerPool: READ ONLY, never in the trading path. The
 * watcher (scripts/owner-pool-watch.ts) records every swap through the pool with the reference at
 * trade time, marks it again at +5 and +30 minutes, and appends to a JSONL file; the summary command
 * (scripts/owner-pool-markout.ts) reads it back. docs/owner-pool-bot.md, "Markout".
 *
 * Everything is valued in token A (XRD on the pools we run) at a price P in B per A (the pool's
 * orientation, reserveB / reserveA), from the POOL's side:
 *   trader sells A (input A, output B):  pnl(P) = inA - outB / P
 *   trader buys A  (input B, output A):  pnl(P) = inB / P - outA
 * The fee (charged in the input token, kept by the pool) is valued at the trade-time reference P0:
 *   feeA = fee (input A)  or  fee / P0 (input B).
 * markout(P) = pnl(P) - feeA: what the pool made or lost on the price alone. NEGATIVE = the trader was
 * right (the price moved their way). Profit at a mark = feeA + markout(P) = pnl(P).
 */

export type TradeSide = 'sellA' | 'buyA';

export interface MarkoutTrade {
  txid: string;
  at: number;
  stateVersion: number;
  side: TradeSide;
  inputResource: string;
  inputAmount: number;
  outputResource: string;
  outputAmount: number;
  /** In the input resource. */
  fee: number;
  /** The fee level in force, read off the trade: round(fee / input * 10,000). */
  feeBps: number;
  /** B per A the trader got (fee included). */
  tradePrice: number;
  /** Pool mid (reserveB / reserveA) right after the swap, from the event. */
  poolMidAfter: number;
}

/** A swap event of `tx` as a trade, or undefined when the event lacks the amounts (an old event shape). */
export function tradeFromSwap(tx: Pick<OwnerPoolTx, 'txid' | 'at' | 'stateVersion'>, ev: Extract<OwnerPoolEvent, { name: 'OwnerPoolSwapEvent' }>, resourceA: string, resourceB: string): MarkoutTrade | undefined {
  if (!ev.inputResource || !ev.outputResource || ev.inputAmount === undefined || ev.outputAmount === undefined || ev.fee === undefined) return undefined;
  const side: TradeSide | undefined = ev.inputResource === resourceA && ev.outputResource === resourceB ? 'sellA' : ev.inputResource === resourceB && ev.outputResource === resourceA ? 'buyA' : undefined;
  if (!side) return undefined;
  const inputAmount = Number(ev.inputAmount), outputAmount = Number(ev.outputAmount), fee = Number(ev.fee);
  if (!(inputAmount > 0 && outputAmount > 0 && fee >= 0)) return undefined;
  const tradePrice = side === 'sellA' ? outputAmount / inputAmount : inputAmount / outputAmount;
  return {
    txid: tx.txid, at: tx.at, stateVersion: tx.stateVersion, side, inputResource: ev.inputResource, inputAmount, outputResource: ev.outputResource, outputAmount, fee,
    feeBps: Math.round((fee / inputAmount) * 10_000), tradePrice, poolMidAfter: Number(ev.reserveB) / Number(ev.reserveA),
  };
}

/** The pool's gain on the trade valued at P (B per A), in A, fee included. */
export function tradePnl(t: Pick<MarkoutTrade, 'side' | 'inputAmount' | 'outputAmount'>, P: number): number {
  return t.side === 'sellA' ? t.inputAmount - t.outputAmount / P : t.inputAmount / P - t.outputAmount;
}

/** The fee in A, valued at the trade-time reference P0 (when the fee was charged in B). */
export function feeInA(t: Pick<MarkoutTrade, 'side' | 'fee'>, P0: number): number {
  return t.side === 'sellA' ? t.fee : t.fee / P0;
}

/** The trade's size in A at P0: what the trader put in, valued in A. */
export function volumeInA(t: Pick<MarkoutTrade, 'side' | 'inputAmount'>, P0: number): number {
  return t.side === 'sellA' ? t.inputAmount : t.inputAmount / P0;
}

/** markout = pnl(P) - feeA (negative = the trader was right); profit = feeA + markout = pnl(P). */
export function markout(t: Pick<MarkoutTrade, 'side' | 'inputAmount' | 'outputAmount' | 'fee'>, P0: number, P: number): { pnl: number; feeA: number; markout: number } {
  const pnl = tradePnl(t, P), feeA = feeInA(t, P0);
  return { pnl, feeA, markout: pnl - feeA };
}

/**
 * The fee (bps of volume) at which these trades would have broken even at a horizon: the fees would
 * have to cover the markout, so fee * volume + markout = 0. 0 when the markout is not negative (any
 * fee is profitable). Assumes the same trades would have happened at that fee, which a wider fee does
 * not guarantee.
 */
export function breakEvenFeeBps(totalMarkoutA: number, volumeA: number): number {
  if (!(volumeA > 0) || totalMarkoutA >= 0) return 0;
  return (-totalMarkoutA / volumeA) * 10_000;
}

// ------------------------------------------------------------------ records (JSONL)

/** The reference at a moment, in pool units (B per A, after --scale) and as read. */
export interface MarkoutRef { price: number; raw: number; scale: number; at: number }

export type MarkoutRecord =
  | ({ kind: 'trade' } & MarkoutTrade & { ref: MarkoutRef | null; feeA: number; volumeA: number; at0?: { pnl: number; markout: number } })
  | { kind: 'mark'; txid: string; horizonMin: number; at: number; lateSec: number; ref: MarkoutRef | null; poolMid: number | null; atRef: { pnl: number; markout: number } | null; atPoolMid: { pnl: number; markout: number } | null };

/** A new trade record: the reference at trade time (null when none was usable) and the trade's fee and volume in A. */
export function tradeRecord(t: MarkoutTrade, ref: MarkoutRef | null): Extract<MarkoutRecord, { kind: 'trade' }> {
  // No usable reference: value the fee and the size at the trade's own price.
  const P0 = ref?.price ?? t.tradePrice;
  const m = ref ? markout(t, P0, ref.price) : undefined;
  return { kind: 'trade', ...t, ref, feeA: feeInA(t, P0), volumeA: volumeInA(t, P0), ...(m ? { at0: { pnl: m.pnl, markout: m.markout } } : {}) };
}

/** A mark at `horizonMin` for a trade: at the reference now and (second view) at the pool's own mid now. */
export function markRecord(tr: Extract<MarkoutRecord, { kind: 'trade' }>, horizonMin: number, now: number, ref: MarkoutRef | null, poolMid: number | null): Extract<MarkoutRecord, { kind: 'mark' }> {
  const P0 = tr.ref?.price ?? tr.tradePrice;
  const view = (P: number | null | undefined) => (P && P > 0 ? (({ pnl, markout: mk }) => ({ pnl, markout: mk }))(markout(tr, P0, P)) : null);
  return { kind: 'mark', txid: tr.txid, horizonMin, at: now, lateSec: Math.round((now - (tr.at + horizonMin * 60_000)) / 1000), ref, poolMid, atRef: view(ref?.price), atPoolMid: view(poolMid) };
}

/** Parse a JSONL file's text into records (a torn or foreign line is skipped). */
export function parseMarkoutLines(text: string): MarkoutRecord[] {
  const out: MarkoutRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j?.kind === 'trade' || j?.kind === 'mark') out.push(j); } catch { /* torn last line */ }
  }
  return out;
}

/** Marks due now: (trade, horizon) pairs whose time has come and which have no mark yet. Survives restarts: it is read from the records. */
export function dueMarks(records: MarkoutRecord[], now: number, horizonsMin: number[]): { trade: Extract<MarkoutRecord, { kind: 'trade' }>; horizonMin: number }[] {
  const have = new Set(records.filter((r) => r.kind === 'mark').map((r) => `${r.txid}@${(r as { horizonMin: number }).horizonMin}`));
  const out: { trade: Extract<MarkoutRecord, { kind: 'trade' }>; horizonMin: number }[] = [];
  for (const r of records) {
    if (r.kind !== 'trade') continue;
    for (const h of horizonsMin) if (!have.has(`${r.txid}@${h}`) && now >= r.at + h * 60_000) out.push({ trade: r, horizonMin: h });
  }
  return out;
}

// ------------------------------------------------------------------ summary

export interface MarkoutBucket {
  trades: number;
  volumeA: number;
  feesA: number;
  /** Per horizon (minutes): trades marked, their markout total, profit (fees of those trades + markout), break-even fee, and the same at the pool's mid. */
  horizons: Record<string, { marked: number; markoutA: number; profitA: number; feesA: number; volumeA: number; breakEvenFeeBps: number; poolMid: { marked: number; markoutA: number } }>;
}

export const MARKOUT_SIZE_BUCKETS_A = [10, 100, 1000];

const sizeBucket = (v: number, edges: number[]): string => {
  let lo = 0;
  for (const e of edges) { if (v < e) return `${lo}-${e}`; lo = e; }
  return `>=${lo}`;
};

/** Totals over all trades, and split by trade size (in A) and by the fee level in force at the time. */
export function summarizeMarkouts(records: MarkoutRecord[], o: { horizonsMin: number[]; sizeEdgesA?: number[] }): { all: MarkoutBucket; bySize: Record<string, MarkoutBucket>; byFeeBps: Record<string, MarkoutBucket>; pending: number } {
  const trades = records.filter((r): r is Extract<MarkoutRecord, { kind: 'trade' }> => r.kind === 'trade');
  const marks = records.filter((r): r is Extract<MarkoutRecord, { kind: 'mark' }> => r.kind === 'mark');
  const empty = (): MarkoutBucket => ({ trades: 0, volumeA: 0, feesA: 0, horizons: Object.fromEntries(o.horizonsMin.map((h) => [String(h), { marked: 0, markoutA: 0, profitA: 0, feesA: 0, volumeA: 0, breakEvenFeeBps: 0, poolMid: { marked: 0, markoutA: 0 } }])) });
  const all = empty(), bySize: Record<string, MarkoutBucket> = {}, byFeeBps: Record<string, MarkoutBucket> = {};
  let pending = 0;
  for (const t of trades) {
    const buckets = [all, (bySize[sizeBucket(t.volumeA, o.sizeEdgesA ?? MARKOUT_SIZE_BUCKETS_A)] ??= empty()), (byFeeBps[String(t.feeBps)] ??= empty())];
    for (const b of buckets) { b.trades++; b.volumeA += t.volumeA; b.feesA += t.feeA; }
    for (const h of o.horizonsMin) {
      const m = marks.find((x) => x.txid === t.txid && x.horizonMin === h);
      if (!m) { pending++; continue; }
      for (const b of buckets) {
        const hb = b.horizons[String(h)]!;
        if (m.atRef) { hb.marked++; hb.markoutA += m.atRef.markout; hb.feesA += t.feeA; hb.volumeA += t.volumeA; hb.profitA += t.feeA + m.atRef.markout; }
        if (m.atPoolMid) { hb.poolMid.marked++; hb.poolMid.markoutA += m.atPoolMid.markout; }
      }
    }
  }
  for (const b of [all, ...Object.values(bySize), ...Object.values(byFeeBps)]) for (const hb of Object.values(b.horizons)) hb.breakEvenFeeBps = breakEvenFeeBps(hb.markoutA, hb.volumeA);
  return { all, bySize, byFeeBps, pending };
}
