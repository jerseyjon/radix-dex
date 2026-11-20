// Print the probe ladder for one market, to see how depth is built. Usage: tsx scripts/depth-check.ts XRD hUSDC
import { Gateway, NETWORKS, Quoter, buildMarkets, filterAllowedPools, listDefiPlaza, listOciswap, tokensFromLedger } from '../packages/core/src/index.ts';

const [baseSym = 'XRD', quoteSym = 'hUSDC'] = process.argv.slice(2);
const net = NETWORKS.mainnet;
const gw = new Gateway(net);
const [o, d] = await Promise.all([listOciswap({ minTvlUsd: 300 }), listDefiPlaza({ minTvlUsd: 300 })]);
const pools = await filterAllowedPools(gw, [...o.pools, ...d.pools]);
const tokens = new Map(o.tokens.map((t) => [t.address, t]));
const missing = [...new Set(pools.flatMap((p) => p.tokens))].filter((a) => !tokens.has(a));
for (const t of await tokensFromLedger(gw, missing)) tokens.set(t.address, t);
const sym = (a: string) => tokens.get(a)?.symbol ?? '?';

const pair = pools.filter((p) => {
  const s = p.tokens.map(sym);
  return s.includes(baseSym) && s.includes(quoteSym);
});
if (!pair.length) throw new Error('no pools for that pair');
void buildMarkets;

const q = new Quoter(gw);
for (const pool of pair) {
  console.log('\n' + [pool.venue, pool.kind, pool.address.slice(-8), 'tvl $' + pool.tvlUsd.toFixed(0), 'reserves', pool.reserves.map((r) => r.toPrecision(5)).join(' / '), pool.tokens.map(sym).join('/')].join(' '));
  for (const sell of pool.tokens) {
    const reserve = pool.reserves[pool.tokens[0] === sell ? 0 : 1];
    for (const f of [0.002, 0.05]) {
      const amount = (reserve * f).toFixed(12);
      const r = await q.simulate([pool], sell, amount).catch((e) => 'ERR ' + e.message);
      console.log('  sell', sym(sell), amount, '->', typeof r === 'string' ? r : r ? r.buyAmount : 'no quote: ' + String(q.lastFailure).slice(0, 220));
    }
  }
}
