import { priceDistance, anchorPrice } from './ownerpool-bot.ts';
import type { OwnerPoolEvent, OwnerPoolTx } from './ownerpool-events.ts';
import type { OwnerPoolOperatorLimits } from './ownerpool.ts';

/** The pool's operator limits (read from its state) in the form `OwnerPoolOperatorEvent` carries them: field name -> text. */
export function limitsRecord(l: OwnerPoolOperatorLimits): Record<string, string> {
  return {
    move_budget_bps: String(l.moveBudgetBps), window_epochs: String(l.windowEpochs), max_reserve_a: l.maxReserveA, max_reserve_b: l.maxReserveB,
    min_reserve_a: l.minReserveA, min_reserve_b: l.minReserveB, min_fee_bps: String(l.minFeeBps), max_fee_bps: String(l.maxFeeBps),
  };
}

/**
 * Rules of the read-only OwnerPool watcher (scripts/owner-pool-watch.ts, docs/owner-pool-bot.md).
 * It holds no key and sends no transaction: it reads the pool's events and says what looks wrong.
 * The theft pattern it looks for (split design and audits): an operator key in the wrong hands spends
 * MOST of the allowance in one move and keeps doing it every window, or pauses / widens the fee to
 * keep others out while it trades against a mispriced curve. The bot by design spends at most half of
 * the allowance available, so a move above that is not the bot's.
 *
 * Pure: no I/O and no clock. The caller passes each transaction in ledger order and keeps `WatchState`.
 */

export const OWNER_POOL_WATCH_DEFAULTS = {
  intervalSec: 60,
  /** One operator move spending more than this share of the allowance available before it. */
  maxSpendShare: 0.6,
  /** Operator spend over the last 24 h above this many full budgets (one budget refills per window). */
  maxSpend24hBudgets: 1,
  /** Operator moves within any `spendWindowSec` spending more than this share of the allowance available at the window's start (the bot's own cap is the same). */
  maxWindowSpendShare: 0.6,
  spendWindowSec: 600,
  /** The owner's anchor more than this far from the reference: the owner should restate it. */
  maxAnchorDrift: 0.05,
  /** The pool's price more than this far from the reference (mapped). */
  maxPoolDrift: 0.03,
  alertIntervalSec: 3600,
};

export type WatchSeverity = 'alert' | 'warn' | 'info';

export interface WatchFinding {
  rule: 'large-spend' | 'window-spend' | 'spend-24h' | 'limits-change' | 'fee-change' | 'pause-change' | 'operator-change' | 'anchor-restated' | 'not-bot' | 'anchor-drift' | 'pool-drift';
  severity: WatchSeverity;
  txid?: string;
  stateVersion?: number;
  at?: number;
  text: string;
}

export interface WatchState {
  /** The pool's last known config (fee, owner pause, operator pause). */
  config?: { feeBps: number; paused: boolean; operatorPaused: boolean };
  /** Operator spends (budget cost, and the allowance left after it) with their times, last 24 h. */
  spends: { at: number; cost: number; txid: string; after?: number }[];
  operator?: string | null;
  /** The operator limits last announced (OwnerPoolOperatorEvent), as text. */
  limits?: Record<string, string>;
}

export interface WatchContext {
  /** The appointed operator badge and the owner badge (to tell who called an owner-or-operator method). */
  operatorBadge?: string | null;
  ownerBadge?: string;
  /** One full operator budget (move_budget_bps / 10000). */
  budget: number;
  /** Intent hashes the bot recorded before sending (its sent log), and the time that log starts. Absent: not compared. */
  botTxids?: Set<string>;
  botLogSince?: number;
  maxSpendShare: number;
  maxSpend24hBudgets: number;
  /** Rolling window rule; absent: not checked. */
  maxWindowSpendShare?: number;
  spendWindowMs?: number;
}

/** Who made a transaction's operator-side changes, from what its manifest called and proved. */
export function operatorActions(t: OwnerPoolTx, ctx: Pick<WatchContext, 'operatorBadge' | 'ownerBadge'>): string[] {
  const out: string[] = [];
  for (const e of t.events) if (e.name === 'OwnerPoolRebalanceEvent' && !e.byOwner) out.push('rebalance');
  if (t.methods.includes('operator_set_fee')) out.push('operator_set_fee');
  if (t.methods.includes('set_operator_paused')) {
    // Owner or operator may call it: the operator's when the manifest names the operator badge and not the owner's.
    const byOwner = !!ctx.ownerBadge && t.resources.includes(ctx.ownerBadge);
    const byOperator = !!ctx.operatorBadge && t.resources.includes(ctx.operatorBadge);
    if (byOperator && !byOwner) out.push('set_operator_paused');
  }
  return out;
}

const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Findings for one committed transaction of the pool; updates `st`. */
export function watchTransaction(t: OwnerPoolTx, st: WatchState, ctx: WatchContext): WatchFinding[] {
  const out: WatchFinding[] = [];
  const base = { txid: t.txid, stateVersion: t.stateVersion, at: t.at };
  // The operator badge as of this transaction: the last one the pool announced, else the current one.
  const ops = operatorActions(t, { ownerBadge: ctx.ownerBadge, operatorBadge: st.operator !== undefined ? st.operator : ctx.operatorBadge });
  st.spends = st.spends.filter((s) => t.at - s.at < 86_400_000);
  for (const e of t.events) {
    if (e.name === 'OwnerPoolRebalanceEvent' && !e.byOwner) {
      const cost = Number(e.cost), after = Number(e.allowance);
      // The event's allowance is what was left after the move, refill included; before = cost + after.
      const before = cost + after;
      const share = before > 0 ? cost / before : 0;
      if (cost > 0 && share > ctx.maxSpendShare) {
        out.push({ rule: 'large-spend', severity: 'alert', ...base, text: `Operator move spent ${fmtPct(share)} of the allowance available (cost ${e.cost} of ${before.toPrecision(6)}; limit ${fmtPct(ctx.maxSpendShare)}). The bot never spends more than half: check the operator key.` });
      }
      if (cost > 0) {
        st.spends.push({ at: t.at, cost, txid: t.txid, after });
        // Rolling window: the moves of the last spendWindowMs (this one included) against the allowance
        // available when the first of them was made (spent in the window + left now). Catches a thief
        // copying the bot's "half, then half" pattern, which no single move gives away.
        if (ctx.maxWindowSpendShare !== undefined && ctx.spendWindowMs) {
          const win = st.spends.filter((s) => t.at - s.at < ctx.spendWindowMs! && s.at <= t.at);
          const spent = win.reduce((a, s) => a + s.cost, 0);
          const wshare = spent / (spent + after);
          if (win.length >= 2 && wshare > ctx.maxWindowSpendShare) {
            out.push({ rule: 'window-spend', severity: 'alert', ...base, text: `Operator spent ${fmtPct(wshare)} of the allowance available in ${win.length} moves within ${Math.round(ctx.spendWindowMs / 60_000)} min (${spent.toPrecision(6)}; limit ${fmtPct(ctx.maxWindowSpendShare)}). The bot caps itself at ${fmtPct(ctx.maxWindowSpendShare)}: check the operator key.` });
          }
        }
        const total = st.spends.reduce((a, s) => a + s.cost, 0);
        const limit = ctx.maxSpend24hBudgets * ctx.budget;
        if (total > limit * (1 + 1e-9)) out.push({ rule: 'spend-24h', severity: 'alert', ...base, text: `Operator spent ${total.toPrecision(6)} of budget in 24 h over ${st.spends.length} moves (limit ${limit.toPrecision(6)} = ${ctx.maxSpend24hBudgets} budget(s)).` });
      }
    }
    if (e.name === 'OwnerPoolConfigEvent') {
      const prev = st.config;
      const who = ops.includes('operator_set_fee') || ops.includes('set_operator_paused') ? 'operator' : t.methods.length ? `owner/other (${t.methods.join(',')})` : 'unknown caller';
      if (prev && prev.feeBps !== e.feeBps) out.push({ rule: 'fee-change', severity: who === 'operator' ? 'warn' : 'info', ...base, text: `Fee ${prev.feeBps} -> ${e.feeBps} bps by ${who}.` });
      if (prev && prev.operatorPaused !== e.operatorPaused) out.push({ rule: 'pause-change', severity: 'warn', ...base, text: `Operator pause ${e.operatorPaused ? 'ON' : 'off'} (by ${who}).` });
      if (prev && prev.paused !== e.paused) out.push({ rule: 'pause-change', severity: 'warn', ...base, text: `OWNER pause ${e.paused ? 'ON' : 'off'} (by ${who}).` });
      st.config = { feeBps: e.feeBps, paused: e.paused, operatorPaused: e.operatorPaused };
    }
    if (e.name === 'OwnerPoolOperatorEvent' && (st.operator === undefined || st.operator !== e.operator)) {
      if (st.operator !== undefined) out.push({ rule: 'operator-change', severity: 'alert', ...base, text: `Operator ${e.operator ? `set to ${e.operator}` : 'REVOKED'} (was ${st.operator ?? 'none'}).` });
      st.operator = e.operator;
    }
    if (e.name === 'OwnerPoolOperatorEvent' && e.limits) {
      const prev = st.limits;
      const changed = prev ? Object.keys({ ...prev, ...e.limits }).filter((k) => prev[k] !== e.limits![k]) : [];
      if (changed.length) out.push({ rule: 'limits-change', severity: 'alert', ...base, text: `Operator limits changed (${t.methods.length ? t.methods.join(',') : 'unknown call'}): ${changed.map((k) => `${k} ${prev![k] ?? '-'} -> ${e.limits![k] ?? '-'}`).join(', ')}.` });
      st.limits = e.limits;
    }
    if (e.name === 'OwnerPoolAnchorEvent') out.push({ rule: 'anchor-restated', severity: 'info', ...base, text: `Owner stated the anchor ${e.anchorA}:${e.anchorB} (price ${(Number(e.anchorB) / Number(e.anchorA)).toPrecision(6)}); operator allowance restarts from zero.` });
  }
  if (ops.length && ctx.botTxids) {
    if (!ctx.botTxids.has(t.txid)) {
      const before = ctx.botLogSince !== undefined && t.at < ctx.botLogSince;
      out.push(before
        ? { rule: 'not-bot', severity: 'info', ...base, text: `Operator action (${ops.join(', ')}) before the bot's sent log starts: cannot be attributed.` }
        : { rule: 'not-bot', severity: 'alert', ...base, text: `Operator action (${ops.join(', ')}) that the bot did NOT send (not in its sent log): someone else holds the operator key, or a second bot runs.` });
    }
  }
  return out;
}

/**
 * Live drift checks against the reference (already mapped onto the pool: B per A). The owner's
 * anchor far from the market means the bot will stop (and the owner should restate it); the pool's
 * own price far from it means the curve is off, by a stuck bot, a pause or someone moving it.
 */
export function driftFindings(o: { reference: number; poolPrice: number; ownerAnchor?: [string, string]; maxAnchorDrift: number; maxPoolDrift: number }): WatchFinding[] {
  const out: WatchFinding[] = [];
  if (o.ownerAnchor) {
    const d = priceDistance(anchorPrice(o.ownerAnchor), o.reference);
    if (d > o.maxAnchorDrift) out.push({ rule: 'anchor-drift', severity: 'warn', text: `Owner anchor ${o.ownerAnchor.join(':')} is ${fmtPct(d)} from the reference ${o.reference.toPrecision(6)} (limit ${fmtPct(o.maxAnchorDrift)}): the owner should restate it.` });
  }
  const p = priceDistance(o.poolPrice, o.reference);
  if (p > o.maxPoolDrift) out.push({ rule: 'pool-drift', severity: 'warn', text: `Pool price ${o.poolPrice.toPrecision(6)} is ${fmtPct(p)} from the reference ${o.reference.toPrecision(6)} (limit ${fmtPct(o.maxPoolDrift)}).` });
  return out;
}

/** The pool's last config from its events in `txs` (for a baseline), or undefined. */
export function lastConfig(txs: OwnerPoolTx[]): WatchState['config'] {
  let c: WatchState['config'];
  for (const t of txs) for (const e of t.events as OwnerPoolEvent[]) if (e.name === 'OwnerPoolConfigEvent') c = { feeBps: e.feeBps, paused: e.paused, operatorPaused: e.operatorPaused };
  return c;
}
