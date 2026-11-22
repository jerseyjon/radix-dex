// Read-only check of the CaviarNine venue against mainnet: quotes with and without it, depth ladders,
// and fill-shaped manifests previewed through each pool. Nothing is signed or submitted.
// Usage: npx tsx scripts/caviarnine-check.ts
import {
  Decimal, Gateway, NETWORKS, Quoter, type Pool, buildMarkets, filterAllowedPools, isBestEffort, listCaviarNine, listDefiPlaza, listOciswap,
  chargedSwapFeeXrd, takeFillManifest, tokensFromLedger, xrdCharges,
} from '../packages/core/src/index.ts';
import { fillGasXrd } from '../apps/server/src/solver.ts';
import { MarketData } from '../apps/server/src/marketdata.ts';
import { loadConfig } from '../apps/server/src/config.ts';

const net = NETWORKS.mainnet;
const gw = new Gateway(net);
const HUSDC = 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv';
const LSULP = 'resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf';
const XRD = net.xrd;

const [oci, dfp] = await Promise.all([listOciswap({ minTvlUsd: 300 }), listDefiPlaza({ minTvlUsd: 300 })]);
const c9 = await listCaviarNine(gw, { pricesUsd: oci.pricesUsd });
const pools = await filterAllowedPools(gw, [...oci.pools, ...dfp.pools, ...c9.pools]);
const without = pools.filter((p) => !isBestEffort(p));
const tokens = new Map(oci.tokens.map((t) => [t.address, t]));
const missing = [...new Set(pools.flatMap((p) => p.tokens))].filter((a) => !tokens.has(a));
for (const t of await tokensFromLedger(gw, missing)) tokens.set(t.address, t);
const sym = (a: string) => tokens.get(a)?.symbol ?? a.slice(-6);
const routeText = (r: Pool[]) => r.map((p) => `${p.venue}:${p.kind}:${p.address.slice(-6)}`).join(' > ');

console.log('CaviarNine pools listed and allowed:');
for (const p of pools.filter(isBestEffort)) {
  console.log(`  ${p.address} ${p.tokens.map(sym).join('/')} tvl $${p.tvlUsd.toFixed(0)} can take in ${p.reserves.map((r, i) => `${r.toPrecision(5)} ${sym(p.tokens[i]!)}`).join(', ')}`);
}

const q = new Quoter(gw);
const cases: [string, string, string[]][] = [
  [HUSDC, XRD, ['10', '100', '1000']],
  [LSULP, XRD, ['100', '10000', '100000']],
  [XRD, HUSDC, ['1000', '10000', '100000']],
  [XRD, LSULP, ['10', '100', '1000']],
];
console.log('\n| Sell | With CaviarNine: route, received | Without: route, received | Gain |');
console.log('|---|---|---|---|');
for (const [sell, buy, sizes] of cases) {
  for (const size of sizes) {
    const [a, b] = await Promise.all([
      q.best(pools, sell, buy, size, XRD).catch((e) => `ERR ${e.message}`),
      q.best(without, sell, buy, size, XRD).catch((e) => `ERR ${e.message}`),
    ]);
    const show = (x: typeof a) => (typeof x === 'string' ? x : x ? `${routeText(x.route)}, ${new Decimal(x.buyAmount).toSignificantDigits(8).toFixed()} ${sym(buy)}${new Decimal(x.sellAmount).lt(size) ? ` (only ${x.sellAmount} sold)` : ''} [gas ${x.networkFeeXrd}]` : 'no route');
    const gain = typeof a === 'object' && a && typeof b === 'object' && b ? `${new Decimal(a.buyAmount).div(b.buyAmount).minus(1).mul(100).toFixed(2)}%` : '';
    console.log(`| ${size} ${sym(sell)} → ${sym(buy)} | ${show(a)} | ${show(b)} | ${gain} |`);
  }
}

// The server's own market data, in process (memory only: no server started, nothing written).
const data = new MarketData(loadConfig({ DEX_NETWORK: 'mainnet', DEX_DATA_DIR: ':memory:' }), gw);
await data.refresh();
console.log(`\nServer market list: ${data.markets.length} markets, ${data.pools.length} pools; last error: ${data.lastError ?? 'none'}`);
for (const m of data.markets.filter((x) => x.pools.some(isBestEffort))) {
  const d = await data.depth(m);
  const side = (ls: typeof d.bids) => [...new Set(ls.map((l) => l.source))].map((s) => `${s} ${ls.filter((l) => l.source === s).length}`).join(', ');
  const tape = [...new Set((await data.venueTrades(m)).map((t) => t.venue))].join(', ');
  console.log(`  ${m.base.symbol}/${m.quote.symbol}: ${m.pools.map((p) => p.venue).join(', ')}, $${m.tvlUsd.toFixed(0)}; mid ${d.mid?.toPrecision(5)}; bids from ${side(d.bids)}; asks from ${side(d.asks)}; tape from ${tape}`);
}

// Depth ladders as the server builds them, per pool.
const markets = buildMarkets(pools, tokens, [HUSDC, XRD]);
for (const p of pools.filter(isBestEffort)) {
  const m = markets.find((x) => x.pools.includes(p))!;
  const d = await q.poolDepth(m, p);
  console.log(`\nDepth from ${p.address.slice(-6)} in ${m.base.symbol}/${m.quote.symbol}:`);
  console.log('  bids', d.bids.map((l) => `${l.size.toPrecision(4)}@${l.price.toPrecision(5)}`).join(' '));
  console.log('  asks', d.asks.map((l) => `${l.size.toPrecision(4)}@${l.price.toPrecision(5)}`).join(' '));
}

// Fill-shaped manifests: what the solver submits for a taker selling into XRD (charges from the proceeds),
// with the taker's yield replaced by a withdrawal from a large holder (signatures assumed in preview).
const epoch = (await gw.status()).epoch;
const fill = async (route: Pool[], sell: string, amount: string, minFactor: string) => {
  const holders = (await gw.resourceHolders(sell, 30)).filter((h) => h.address.startsWith('account_') && new Decimal(h.amount).gte(amount));
  const quote = await q.simulate(route, sell, amount);
  if (!quote) return `no quote (${q.lastFailure?.slice(0, 120)})`;
  const gasXrd = fillGasXrd(0, chargedSwapFeeXrd(quote));
  const take = xrdCharges(quote.buyAmount, gasXrd, 30);
  const min = new Decimal(quote.buyAmount).mul(minFactor).minus(take).toDecimalPlaces(6, Decimal.ROUND_DOWN);
  for (const h of holders.slice(0, 3)) {
    const solver = { account: h.address, badge: XRD };
    const text = takeFillManifest({ solver, feeLockXrd: '10', sell, buy: XRD, makerPays: [], poolIn: amount, route, solverTake: take.toFixed(), xrd: XRD })
      .split('\n')
      // No solver badge here; and ASSERT_WORKTOP_RESOURCES_ONLY is V2-only, so the "only XRD left" check is made on the result instead.
      .filter((l) => !l.includes('create_proof_of_amount') && !l.startsWith('ASSERT_WORKTOP_RESOURCES_ONLY'))
      .map((l) => l === 'YIELD_TO_CHILD NamedIntent("taker");'
        ? `CALL_METHOD Address("${h.address}") "withdraw" Address("${sell}") Decimal("${amount}");`
        : l.startsWith('TAKE_ALL_FROM_WORKTOP') && l.endsWith('Bucket("out");')
          // The taker's subintent asserts it receives at least its minimum: the same check, made on the worktop.
          ? `ASSERT_WORKTOP_CONTAINS Address("${XRD}") Decimal("${min.toFixed()}");\n${l}`
          : l === 'YIELD_TO_CHILD NamedIntent("taker") Bucket("out");'
            ? `CALL_METHOD Address("${h.address}") "deposit" Bucket("out");`
            : l)
      .join('\n');
    const res = await gw.preview(text, epoch);
    if (!res.ok && /withdraw|Unauthorized|AuthError/i.test(res.error ?? '')) continue;
    const soldAll = res.changes.filter((c) => c.entity === h.address && c.resource === sell).reduce((a, c) => a.plus(c.amount), new Decimal(0)).eq(new Decimal(amount).neg());
    return `${res.ok ? (soldAll ? 'OK, whole input swapped' : 'OK but input handed back') : 'FAILED'} fee ${res.feeXrd} XRD (swap alone ${quote.networkFeeXrd}, fillGasXrd ${gasXrd.toFixed()}), min ${min.toFixed()} of quoted ${new Decimal(quote.buyAmount).toSignificantDigits(8).toFixed()}${res.ok ? '' : ': ' + res.error?.slice(0, 160)}`;
  }
  return 'no usable holder';
};
const p1 = pools.find((p) => p.address.endsWith('j5tyj5'))!, p2 = pools.find((p) => p.address.endsWith('nn9xas'))!;
const oci1 = without.filter((p) => p.tokens.includes(HUSDC) && p.tokens.includes(XRD) && p.venue === 'ociswap').sort((a, b) => b.tvlUsd - a.tvlUsd)[0]!;
console.log('\nFill-shaped previews (ASSERT_WORKTOP_CONTAINS stands in for the taker\'s minimum):');
console.log('  hUSDC→XRD 100 via CaviarNine:', await fill([p1], HUSDC, '100', '0.99'));
console.log('  hUSDC→XRD 100 via Ociswap (reference):', await fill([oci1], HUSDC, '100', '0.99'));
console.log('  LSULP→XRD 10000 via CaviarNine:', await fill([p2], LSULP, '10000', '0.99'));
console.log('  hUSDC→XRD 1000 via CaviarNine:', await fill([p1], HUSDC, '1000', '0.99'));
console.log('  LSULP→XRD 100000 via CaviarNine:', await fill([p2], LSULP, '100000', '0.99'));
console.log('  minimum above what the pool gives (must fail):', await fill([p1], HUSDC, '100', '1.01'));
