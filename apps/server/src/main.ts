import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

// Everything the server writes (the order database and its WAL among them) is for its owner only.
process.umask(0o077);

const config = loadConfig();
const { api, data, store, solver, book } = await createApp(config);

await data.refresh().catch((e) => console.error('[markets] first refresh failed:', e));
// Request handlers never wait for the book; read it once now so the first visitors see it.
await book?.refresh().catch((e) => console.error('[book] first read failed:', e));
const timers: NodeJS.Timeout[] = [];
timers.push(setInterval(() => data.refresh().catch((e) => console.error('[markets] refresh failed:', e)), 5 * 60_000));

if (solver) {
  console.log(`solver account: ${await solver.account()}`);
  timers.push(setInterval(() => void solver.tick().catch((e) => console.error('[solver] tick failed:', e)), 5_000));
} else {
  timers.push(setInterval(() => store.expire(Math.floor(Date.now() / 1000)), 30_000));
}

if (config.network.name !== 'mainnet') {
  // No chart feed off mainnet: build the chart from our own price samples.
  const sample = () => data.samplePrices().catch((e) => console.error('[samples] failed:', e));
  void sample();
  timers.push(setInterval(sample, 30_000));
}

const servers: Server[] = [api.listen(config.port, config.host)];
if (config.tls) {
  servers.push(api.listen(config.tls.port, config.host, { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) }));
  console.log(`also on https://${config.host}:${config.tls.port}`);
}
console.log(`radix-dex server on http://${config.host}:${config.port} (${config.network.name}${config.readOnly ? ', READ ONLY' : ''}, ${data.markets.length} markets, limit orders ${config.solverBadge ? 'on' : 'off'}, solver ${solver ? 'on' : 'off'})`);

/**
 * On SIGTERM or SIGINT: stop the timers, stop taking requests, let the solver's pass in progress
 * finish (a transaction already sent is recorded and will be settled from the ledger on the next
 * start if its outcome is not known), then close the database. Gives up after 90 s.
 */
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal}: stopping`);
  const force = setTimeout(() => { console.error('[server] did not stop within 90 s; exiting'); process.exit(1); }, 90_000);
  force.unref();
  for (const t of timers) clearInterval(t);
  for (const s of servers) s.close();
  await solver?.stop();
  store.close();
  console.log('[server] stopped cleanly');
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
