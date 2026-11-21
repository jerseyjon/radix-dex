// Write a static data snapshot for the read-only preview build.
// Usage: tsx scripts/snapshot.ts <output-dir> [number-of-markets]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gateway, marketKey } from '../packages/core/src/index.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { MarketData } from '../apps/server/src/marketdata.ts';

const out = process.argv[2];
if (!out) throw new Error('Usage: tsx scripts/snapshot.ts <output-dir> [number-of-markets]');
const count = Number(process.argv[3] ?? 20);
const RESOLUTIONS = ['15m', '1h', '4h', '1d', '1w'];
mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value));

const config = loadConfig({ DEX_NETWORK: 'mainnet' });
const data = new MarketData(config, new Gateway(config.network));
await data.refresh();
if (!data.markets.length) throw new Error('No markets: refusing to write an empty snapshot');

// XRD's own markets first, then the deepest.
const xrdFirst = [...data.markets].sort((a, b) => Number(b.base.address === config.network.xrd) - Number(a.base.address === config.network.xrd));
const markets = xrdFirst.slice(0, count);
write('config.json', {
  network: config.network.name, networkId: config.network.networkId, xrd: config.network.xrd, feeBps: config.feeBps, makerFeeBps: config.makerFeeBps,
  warning: null, limitOrders: { enabled: false }, snapshotAt: Math.floor(Date.now() / 1000),
});
write('markets.json', markets.map((m) => ({
  id: m.id, base: m.base, quote: m.quote, tvlUsd: m.tvlUsd, volume24hUsd: m.volume24hUsd, venues: [...new Set(m.pools.map((p) => p.venue))],
})));
for (const m of markets) {
  const key = marketKey(m.id);
  // One market at a time, to go easy on the public Gateway.
  write(`depth-${key}.json`, await data.depth(m).catch(() => ({ marketId: m.id, mid: null, bids: [], asks: [] })));
  for (const r of RESOLUTIONS) write(`candles-${key}-${r}.json`, await data.candles(m, r).catch(() => []));
  console.log(`${m.base.symbol}/${m.quote.symbol} done`);
}
console.log(`Snapshot of ${markets.length} markets written to ${out}`);
