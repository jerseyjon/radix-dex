// Read-only: measure the on-ledger venues the OwnerPool bot takes its reference from (mainnet
// XRD/hUSDC, free previews, nothing signed), and CoinGecko beside them (watch only). One JSON line per
// sample: each venue's bid/ask midpoint, round trip, impact, depth and weight, the depth-weighted
// reference, the disagreement, and CoinGecko's distance from the reference. docs/owner-pool-bot.md.
//
//   tsx scripts/owner-pool-venues.ts [--venues a,b,c] [--sizes 1000[,3000...]] [--interval <s>] [--count <n>]
//                                    [--max-round-trip <f>] [--min-impact <bps>] [--max-disagreement <f>]
import { Gateway, NETWORKS, OWNER_POOL_BOT_DEFAULTS as D, aggregateVenues, watchPriceCheck } from '../packages/core/src/index.ts';
import { VENUE_NAMES, makePriceSources, makeVenues, readSource, readVenueSource } from './owner-pool-sources.ts';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const num = (n: string, d: number) => (opt(n) === undefined ? d : Number(opt(n)));
const venues = (opt('venues') ?? VENUE_NAMES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const sizes = (opt('sizes') ?? String(D.quoteSizeXrd)).split(',').map(Number).filter((x) => x > 0);
const intervalSec = num('interval', 60), count = num('count', 1);
const o = { minVenues: D.minVenues, maxAgeMs: D.maxSourceAgeSec * 1000, maxDisagreement: num('max-disagreement', D.maxDisagreement), maxRoundTrip: num('max-round-trip', D.maxRoundTrip), minImpactBps: num('min-impact', D.minImpactBps) };

const gw = new Gateway(NETWORKS.mainnet);
const bySize = sizes.map((s) => ({ size: s, sources: makeVenues(venues, gw, { sizeXrd: s, smallFraction: D.smallQuoteFraction }) }));
const [cg] = makePriceSources(['coingecko'], gw);
const r6 = (x: number | undefined) => (x === undefined ? null : Number(x.toPrecision(6)));

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
for (let i = 0; i < count && !stopping; i++) {
  const started = Date.now();
  const watch = await readSource(cg!);
  for (const { size, sources } of bySize) {
    const quotes = await Promise.all(sources.map(readVenueSource));
    const ref = aggregateVenues(quotes, Date.now(), o);
    const w = watchPriceCheck(ref.price, watch.error ? undefined : watch.price, D.coingeckoMaxDeviation);
    console.log(JSON.stringify({
      t: new Date().toISOString(), sizeXrd: size, status: ref.status, reference: r6(ref.price), disagreement: ref.disagreement === undefined ? null : r6(ref.disagreement), live: ref.live, reason: ref.reason,
      venues: ref.venues.map((v, k) => ({ venue: v.venue, used: v.used, mid: r6(v.mid), bid: r6(quotes[k]!.bid), ask: r6(quotes[k]!.ask), roundTrip: r6(v.roundTrip), impact: r6(v.impact), depth: r6(v.depth), weight: r6(v.weight), ...(v.dropped ? { dropped: v.dropped } : {}) })),
      coingecko: watch.error ? { error: watch.error } : { price: watch.price, ageSec: Math.round((Date.now() - watch.at) / 1000), deviation: r6(w.deviation), alarm: w.alarm },
    }));
  }
  if (i + 1 < count && !stopping) await new Promise((r) => setTimeout(r, Math.max(0, intervalSec * 1000 - (Date.now() - started))));
}
