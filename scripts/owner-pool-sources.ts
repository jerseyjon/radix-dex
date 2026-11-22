// Price sources for the OwnerPool bot and watcher (docs/owner-pool-bot.md, "Reference price").
// Mainnet is only READ here: entity details and free previews; nothing is ever signed for it.
import { readFileSync, statSync } from 'node:fs';
import { Gateway, NETWORKS, Quoter, listCaviarNine, type PriceSample } from '../packages/core/src/index.ts';

const MAINNET_XRD = NETWORKS.mainnet.xrd;
const HUSDC = 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv';
/** Ociswap BasicPool XRD/hUSDC (constant product) and the native pool that holds its funds. */
const OCI_COMPONENT = 'component_rdx1cpqg9y55tv8652k32cznhmu8rz3jgtw57vdg460ld2sy650zpfh5fr';
/** CaviarNine QuantaSwap XRD/hUSDC (also in CAVIARNINE_POOLS). */
const C9_COMPONENT = 'component_rdx1cqelumvmmgwths34k9pp0htd2ykwq7d70m0r389etwh39ul3j5tyj5';

export interface PriceSource { name: string; read(): Promise<PriceSample> }

/** Ociswap XRD/hUSDC basic pool, from the ledger: hUSDC reserve / XRD reserve (the curve's mid price, no fee). */
const ociswapSource = (mainnetGw: Gateway): PriceSource => ({
  name: 'ociswap-xrd-husdc-ledger',
  async read() {
    const c = await mainnetGw.post('/state/entity/details', { addresses: [OCI_COMPONENT] });
    const fields: any[] = c?.items?.[0]?.details?.state?.fields ?? [];
    const f = (n: string) => fields.find((x) => x?.field_name === n)?.value;
    if (c?.items?.[0]?.details?.blueprint_name !== 'BasicPool' || f('x_address') !== MAINNET_XRD || f('y_address') !== HUSDC) throw new Error('Ociswap pool is not XRD/hUSDC BasicPool');
    const pool = String(f('liquidity_pool'));
    const j = await mainnetGw.post('/state/entity/details', { addresses: [pool], aggregation_level: 'Global' });
    const items: any[] = j?.items?.[0]?.fungible_resources?.items ?? [];
    const bal = (r: string) => Number(items.find((i) => i?.resource_address === r)?.amount);
    const x = bal(MAINNET_XRD), y = bal(HUSDC);
    if (!(x > 0 && y > 0)) throw new Error('Ociswap pool reserves unreadable');
    return { source: this.name, price: y / x, at: Date.parse(j.ledger_state.proposer_round_timestamp) };
  },
});

/**
 * CaviarNine XRD/hUSDC, through the project's own Quoter: previews of a small sell each way on
 * mainnet (free, nothing signed); the mid is the geometric mean of the two prices, so the venue fee
 * cancels out. Its active bin is ~5% wide, so the bin bounds alone are too coarse.
 */
const caviarNineSource = (mainnetGw: Gateway): PriceSource => {
  const quoter = new Quoter(mainnetGw);
  return {
    name: 'caviarnine-xrd-husdc-quoter',
    async read() {
      const { pools } = await listCaviarNine(mainnetGw, { addresses: [C9_COMPONENT] });
      const pool = pools[0];
      if (!pool || !pool.tokens.includes(MAINNET_XRD) || !pool.tokens.includes(HUSDC)) throw new Error('CaviarNine XRD/hUSDC pool unreadable');
      const at = Date.now();
      const [sellXrd, sellUsd] = await Promise.all([quoter.simulate([pool], MAINNET_XRD, '100'), quoter.simulate([pool], HUSDC, '0.08')]);
      if (!sellXrd || !sellUsd) throw new Error(`CaviarNine preview failed: ${quoter.lastFailure ?? 'no quote'}`);
      const bid = Number(sellXrd.buyAmount) / Number(sellXrd.sellAmount); // hUSDC per XRD when selling XRD
      const ask = Number(sellUsd.sellAmount) / Number(sellUsd.buyAmount); // hUSDC per XRD when buying XRD
      if (!(bid > 0 && ask > 0)) throw new Error('CaviarNine quotes unusable');
      return { source: this.name, price: Math.sqrt(bid * ask), at };
    },
  };
};

/** CoinGecko simple price (keyless, off-ledger): XRD in USD, with its own last-updated time. */
const coingeckoSource = (): PriceSource => ({
  name: 'coingecko-xrd-usd',
  async read() {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=radix&vs_currencies=usd&include_last_updated_at=true', { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const j: any = await res.json();
    const price = Number(j?.radix?.usd), at = Number(j?.radix?.last_updated_at) * 1000;
    if (!(price > 0) || !(at > 0)) throw new Error('CoinGecko response unusable');
    return { source: this.name, price, at };
  },
});

/** A fixed price, always fresh: tests and drills only. */
const fixedSource = (price: number, i: number): PriceSource => ({
  name: `fixed#${i}`,
  async read() { return { source: this.name, price, at: Date.now() }; },
});

/** A price kept in a file (JSON {"price": n, "at": iso|ms} or a bare number, then the file's mtime is its time). */
const fileSource = (path: string): PriceSource => ({
  name: `file:${path}`,
  async read() {
    const text = readFileSync(path, 'utf8').trim();
    let price: number, at: number;
    if (text.startsWith('{')) {
      const j = JSON.parse(text);
      price = Number(j.price);
      at = j.at === undefined ? statSync(path).mtimeMs : typeof j.at === 'number' ? j.at : Date.parse(j.at);
    } else { price = Number(text); at = statSync(path).mtimeMs; }
    if (!(price > 0) || !Number.isFinite(at)) throw new Error('price file unusable');
    return { source: this.name, price, at };
  },
});

export function makePriceSources(names: string[], mainnetGw: Gateway): PriceSource[] {
  return names.map((s, i) => {
  if (s === 'ociswap') return ociswapSource(mainnetGw);
  if (s === 'caviarnine') return caviarNineSource(mainnetGw);
  if (s === 'coingecko') return coingeckoSource();
  if (s.startsWith('fixed:')) { const p = Number(s.slice(6)); if (!(p > 0)) throw new Error(`bad ${s}`); return fixedSource(p, i); }
  if (s.startsWith('file:')) return fileSource(s.slice(5));
  throw new Error(`Unknown price source ${s}`);
  });
}

export const readSource = async (s: PriceSource): Promise<PriceSample> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The timer is cleared afterwards, so a stopping process does not wait 30 s for it.
    return await Promise.race([s.read(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after 30 s')), 30_000); })]);
  } catch (e) {
    return { source: s.name, price: NaN, at: 0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
};
