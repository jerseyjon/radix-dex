import type { Depth, DepthLevel } from '@radix-dex/core/browser';

export interface BookEstimate { received: number; avgPrice: number; filledAll: boolean }

/**
 * Walk the book to estimate a market order. `side` "buy" spends `amount` of quote on the asks;
 * "sell" sells `amount` of base into the bids. An estimate only: the exact figure comes from a preview.
 */
export function estimate(depth: Depth | undefined, side: 'buy' | 'sell', amount: number): BookEstimate | undefined {
  if (!depth || !(amount > 0)) return undefined;
  const levels = side === 'buy' ? depth.asks : depth.bids;
  if (!levels.length) return undefined;
  let left = amount, received = 0;
  for (const l of levels) {
    const capacity = side === 'buy' ? l.price * l.size : l.size; // in the currency being spent
    const take = Math.min(left, capacity);
    received += side === 'buy' ? take / l.price : take * l.price;
    left -= take;
    if (left <= 0) break;
  }
  const spent = amount - left;
  if (!(spent > 0) || !(received > 0)) return undefined;
  return { received, avgPrice: side === 'buy' ? spent / received : received / spent, filledAll: left <= amount * 1e-9 };
}

/** Group levels into at most `rows` rows with cumulative totals, best price first. */
export function ladder(levels: DepthLevel[], rows: number): { price: number; size: number; total: number; sources: string[] }[] {
  const out: { price: number; size: number; total: number; sources: string[] }[] = [];
  let total = 0;
  for (const l of levels.slice(0, rows)) {
    total += l.size;
    out.push({ price: l.price, size: l.size, total, sources: [l.source] });
  }
  return out;
}
