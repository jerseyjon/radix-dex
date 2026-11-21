import { readFileSync } from 'node:fs';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { api, data, store, solver } = await createApp(config);

await data.refresh().catch((e) => console.error('[markets] first refresh failed:', e));
setInterval(() => data.refresh().catch((e) => console.error('[markets] refresh failed:', e)), 5 * 60_000).unref();

if (solver) {
  console.log(`solver account: ${await solver.account()}`);
  setInterval(() => solver.tick().catch((e) => console.error('[solver] tick failed:', e)), 5_000);
} else {
  setInterval(() => store.expire(Math.floor(Date.now() / 1000)), 30_000).unref();
}

if (config.network.name !== 'mainnet') {
  // No chart feed off mainnet: build the chart from our own price samples.
  const sample = () => data.samplePrices().catch((e) => console.error('[samples] failed:', e));
  void sample();
  setInterval(sample, 30_000).unref();
}

api.listen(config.port, config.host);
if (config.tls) {
  api.listen(config.tls.port, config.host, { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) });
  console.log(`also on https://${config.host}:${config.tls.port}`);
}
console.log(`radix-dex server on http://${config.host}:${config.port} (${config.network.name}, ${data.markets.length} markets, limit orders ${config.solverBadge ? 'on' : 'off'}, solver ${solver ? 'on' : 'off'})`);
