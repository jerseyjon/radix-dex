// Which markets the markets list and the pair picker show: the deepest few by liquidity (plus the
// market on screen), all of them on request, and every market when searching. Pure, for the tests.
import type { MarketSummary } from './api';

/** How many markets are shown before "Show all". */
export const TOP_MARKETS = 15;

type Listed = Pick<MarketSummary, 'id' | 'base' | 'quote' | 'tvlUsd'>;

/** Whether a market matches a search: pair symbols ("xrd/husdc", "xrd/") or the base token's name. */
export function matchesMarket(m: Listed, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${m.base.symbol}/${m.quote.symbol} ${m.base.name ?? ''}`.toLowerCase().includes(q);
}

/** Every market matching `query`, in the order given. */
export function filterMarkets<M extends Listed>(markets: M[], query: string): M[] {
  return query.trim() ? markets.filter((m) => matchesMarket(m, query)) : markets;
}

/**
 * The `n` markets with the most liquidity, plus `selected` if it is not among them, kept in the
 * order given (the list's own sort). Ties keep the earlier market.
 */
export function topMarkets<M extends Listed>(markets: M[], n: number, selected?: string): M[] {
  const keep = new Set(
    markets.map((m, i) => ({ m, i }))
      .sort((a, b) => (b.m.tvlUsd || 0) - (a.m.tvlUsd || 0) || a.i - b.i)
      .slice(0, Math.max(0, n))
      .map(({ m }) => m.id),
  );
  if (selected) keep.add(selected);
  return markets.filter((m) => keep.has(m.id));
}

/**
 * The rows to show. A search always covers every market; otherwise the top `n` (plus the selected
 * market) unless `showAll`. `hidden` is how many markets the short list leaves out (0 when searching).
 */
export function visibleMarkets<M extends Listed>(markets: M[], o: { query: string; showAll: boolean; selected?: string; n?: number }): { rows: M[]; hidden: number } {
  if (o.query.trim()) return { rows: filterMarkets(markets, o.query), hidden: 0 };
  const top = topMarkets(markets, o.n ?? TOP_MARKETS, o.selected);
  return { rows: o.showAll ? markets : top, hidden: markets.length - top.length };
}

/** The remembered "show all markets" choice, per browser. Storage may be missing or throw. */
export const SHOW_ALL_KEY = 'dex.markets.showAll';
export function readShowAll(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try { return storage?.getItem(SHOW_ALL_KEY) === '1'; } catch { return false; }
}
export function writeShowAll(storage: Pick<Storage, 'setItem'> | undefined, on: boolean): void {
  try { storage?.setItem(SHOW_ALL_KEY, on ? '1' : '0'); } catch { /* private window: not remembered */ }
}

/**
 * The next active row for a key in the picker's list, or undefined if the key does not move it.
 * Home and End are left to the search box's text.
 */
export function nextActive(key: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : Math.min(count - 1, current + 1);
    case 'ArrowUp': return current < 0 ? count - 1 : Math.max(0, current - 1);
    case 'PageDown': return Math.min(count - 1, Math.max(0, current) + 8);
    case 'PageUp': return Math.max(0, current - 8);
    default: return undefined;
  }
}
