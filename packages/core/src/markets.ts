import type { Market, Pool, Token } from './types.ts';

/**
 * Group pools into markets. The quote side is chosen by priority: the first of `quotePriority`
 * that the pair contains (stablecoins before XRD before anything else), so XRD/USDC is priced in
 * USDC and FOO/XRD in XRD.
 */
export function buildMarkets(pools: Pool[], tokens: Map<string, Token>, quotePriority: string[]): Market[] {
  const markets = new Map<string, Market>();
  const rank = (t: string) => { const i = quotePriority.indexOf(t); return i === -1 ? Infinity : i; };
  for (const pool of pools) {
    const [a, b] = pool.tokens;
    if (a === b) continue;
    const ra = rank(a), rb = rank(b);
    // Lower rank = better quote currency. Ties (neither listed) fall back to address order for stability.
    const quoteIsA = ra !== rb ? ra < rb : a > b;
    const quote = quoteIsA ? a : b, base = quoteIsA ? b : a;
    const tb = tokens.get(base), tq = tokens.get(quote);
    if (!tb || !tq) continue;
    const id = `${base}/${quote}`;
    let m = markets.get(id);
    if (!m) { m = { id, base: tb, quote: tq, pools: [], tvlUsd: 0, volume24hUsd: 0 }; markets.set(id, m); }
    m.pools.push(pool);
    m.tvlUsd += pool.tvlUsd;
    m.volume24hUsd += pool.volume24hUsd;
  }
  return [...markets.values()].sort((x, y) => y.tvlUsd - x.tvlUsd);
}

/** Short, filename-safe key for a market id (ids contain slashes). FNV-1a, base 36. */
export function marketKey(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
