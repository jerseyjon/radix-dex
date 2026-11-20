import { Gateway, isResource, Decimal } from '@radix-dex/core';
import { loadConfig } from './config.ts';
import { Api, HttpError } from './http.ts';
import { MarketData } from './marketdata.ts';

const config = loadConfig();
const gateway = new Gateway(config.network, { url: config.gatewayUrl });
const data = new MarketData(config, gateway);

const api = new Api({ staticDir: config.webDir });

const need = (v: string | null, name: string): string => {
  if (!v) throw new HttpError(400, `Missing "${name}"`);
  return v;
};
const marketOr404 = (id: string) => {
  const m = data.market(id);
  if (!m) throw new HttpError(404, 'Unknown market');
  return m;
};

api.on('GET', '/api/config', () => ({
  network: config.network.name, networkId: config.network.networkId, xrd: config.network.xrd,
  feeBps: config.feeBps, refreshedAt: data.refreshedAt, warning: data.lastError ?? null,
}));

api.on('GET', '/api/markets', () => data.markets.map((m) => ({
  id: m.id, base: m.base, quote: m.quote, tvlUsd: m.tvlUsd, volume24hUsd: m.volume24hUsd,
  venues: [...new Set(m.pools.map((p) => p.venue))],
})));

api.on('GET', '/api/depth', ({ url }) => data.depth(marketOr404(need(url.searchParams.get('market'), 'market'))));

api.on('GET', '/api/candles', ({ url }) =>
  data.candles(marketOr404(need(url.searchParams.get('market'), 'market')), url.searchParams.get('resolution') ?? '1h'));

api.on('GET', '/api/quote', async ({ url }) => {
  const sell = need(url.searchParams.get('sell'), 'sell');
  const buy = need(url.searchParams.get('buy'), 'buy');
  const amount = need(url.searchParams.get('amount'), 'amount');
  if (!isResource(sell) || !isResource(buy) || sell === buy) throw new HttpError(400, 'Bad token addresses');
  let d: InstanceType<typeof Decimal>;
  try { d = new Decimal(amount); } catch { throw new HttpError(400, 'Bad amount'); }
  if (!d.isFinite() || !d.isPositive()) throw new HttpError(400, 'Bad amount');
  const q = await data.quote(sell, buy, d.toDecimalPlaces(18).toFixed());
  if (!q) throw new HttpError(404, 'No route with enough liquidity');
  return q;
});

await data.refresh().catch((e) => console.error('[markets] first refresh failed:', e));
setInterval(() => data.refresh().catch((e) => console.error('[markets] refresh failed:', e)), 5 * 60_000).unref();

api.listen(config.port, config.host);
console.log(`radix-dex server on http://${config.host}:${config.port} (${config.network.name}, ${data.markets.length} markets)`);
