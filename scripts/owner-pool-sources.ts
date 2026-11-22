// Price sources for the OwnerPool bot and watcher (docs/owner-pool-bot.md, "Reference price").
// Mainnet is only READ here: entity details and free previews; nothing is ever signed for it.
//
// Two kinds:
// - VENUES (`makeVenues`): on-ledger pools of the SAME pair, each quoted both ways by previewing real
//   swaps through the project's Quoter. The bot's reference comes ONLY from these.
// - WATCH sources (`makePriceSources`): CoinGecko and the old single-number readings. Watch only: they
//   are compared with the reference and alerted on, never traded on.
import { readFileSync, statSync } from 'node:fs';
import { Gateway, NETWORKS, OWNER_POOL_BLUEPRINT, OWNER_POOL_PACKAGES, Quoter, filterAllowedPools, listCaviarNine, referenceVenueProblems, type Pool, type PriceSample, type VenueQuote } from '../packages/core/src/index.ts';

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

// ------------------------------------------------------------------ venues (the reference)

export interface VenueSource { name: string; read(): Promise<VenueQuote> }

/** The mainnet XRD/hUSDC pools: Ociswap basic (3% fee) and precision (0.05%), CaviarNine QuantaSwap, DefiPlaza PlazaPair. */
const VENUE_POOLS: Record<string, { venue: Pool['venue']; address: string; note: string }> = {
  ociswap: { venue: 'ociswap', address: OCI_COMPONENT, note: 'Ociswap BasicPool XRD/hUSDC' },
  'ociswap-precision': { venue: 'ociswap', address: 'component_rdx1czy2naejcqx8gv46zdsex2syuxrs4jnqzug58e66zr8wglxzvu97qr', note: 'Ociswap PrecisionPool XRD/hUSDC (0.05%)' },
  caviarnine: { venue: 'caviarnine', address: C9_COMPONENT, note: 'CaviarNine QuantaSwap XRD/hUSDC' },
  defiplaza: { venue: 'defiplaza', address: 'component_rdx1crj9ne37kf0tw2efc3dsl03pzg3qavkhauyu6nvz8z05qrdp009jt0', note: 'DefiPlaza PlazaPair hUSDC/XRD' },
};
export const VENUE_NAMES = Object.keys(VENUE_POOLS);

/**
 * HARD GUARD, run at start-up by the bot and the watcher: no reference venue may be the operated pool or
 * ANY OwnerPool component (blueprint `OwnerPool`, or a component of a package in OWNER_POOL_PACKAGES on
 * any network), checked on ledger from each venue's entity details. Throws with every problem found.
 * Synthetic venues (fixed:, file:) have no address and are not checked.
 */
export async function assertReferenceExcludesOwnerPools(gw: Gateway, names: string[], operatedPool: string): Promise<{ checked: { name: string; address: string; blueprint?: string }[] }> {
  const venues = names.filter((n) => VENUE_POOLS[n]).map((n) => ({ name: n, address: VENUE_POOLS[n]!.address }));
  if (!venues.length) return { checked: [] };
  const raw: any[] = await gw.entityDetails([...new Set(venues.map((v) => v.address))]);
  const details = raw.map((d) => ({ address: String(d?.address), blueprint_name: d?.details?.blueprint_name, package_address: d?.details?.package_address }));
  const problems = referenceVenueProblems({ operatedPool, venues, details, ownerPoolPackages: Object.values(OWNER_POOL_PACKAGES).flat(), ownerPoolBlueprint: OWNER_POOL_BLUEPRINT });
  if (problems.length) throw new Error(`reference venues refused: ${problems.join('; ')}`);
  return { checked: venues.map((v) => ({ ...v, blueprint: details.find((d) => d.address === v.address)?.blueprint_name })) };
}

/**
 * One venue, quoted by previews (free, nothing signed): sell `sizeXrd` XRD (the bid) and sell hUSDC
 * worth about `sizeXrd` XRD (the ask), and the same at `smallFraction` of the size, for the impact.
 * The pool must be a component of an allow-listed package and blueprint (checked on ledger once).
 * A quote that fails, or that the pool only part-fills (it handed input back), fails the venue.
 */
const venueSource = (name: string, def: { venue: Pool['venue']; address: string }, gw: Gateway, quoter: Quoter, o: { sizeXrd: number; smallFraction: number }): VenueSource => {
  let checked: Promise<Pool> | undefined;
  const pool = (): Promise<Pool> => {
    checked ??= filterAllowedPools(gw, [{ venue: def.venue, address: def.address, kind: '', tokens: [MAINNET_XRD, HUSDC], feeRate: 0, tvlUsd: 0, volume24hUsd: 0, reserves: [0, 0] }])
      .then((ps) => { if (ps.length !== 1) throw new Error(`${def.address} is not an allow-listed ${def.venue} pool`); return ps[0]!; });
    checked.catch(() => { checked = undefined; });
    return checked;
  };
  const sell = async (p: Pool, token: string, amount: number): Promise<{ sold: number; got: number }> => {
    const q = await quoter.simulate([p], token, amount.toFixed(6));
    if (!q) throw new Error(`preview failed selling ${amount.toPrecision(6)} ${token === HUSDC ? 'hUSDC' : 'XRD'}: ${(quoter.lastFailure ?? 'no quote').slice(0, 140)}`);
    const sold = Number(q.sellAmount), got = Number(q.buyAmount);
    if (!(sold >= amount * 0.999)) throw new Error(`part fill: sold ${sold.toPrecision(6)} of ${amount.toPrecision(6)} (the pool handed input back)`);
    return { sold, got };
  };
  return {
    name,
    async read() {
      const p = await pool();
      const at = Date.now();
      const size = o.sizeXrd, small = o.sizeXrd * o.smallFraction;
      const [b, bs] = await Promise.all([sell(p, MAINNET_XRD, size), sell(p, MAINNET_XRD, small)]);
      const bid = b.got / b.sold, bidSmall = bs.got / bs.sold;
      // Buy about the same amount of XRD: sell hUSDC worth it at the bid.
      const [a, as] = await Promise.all([sell(p, HUSDC, size * bid), sell(p, HUSDC, small * bidSmall)]);
      const ask = a.sold / a.got, askSmall = as.sold / as.got;
      return { venue: name, at, sizeA: size, smallA: small, bid, ask, bidSmall, askSmall };
    },
  };
};

/** A synthetic venue at one price (fixed:<p>, file:<path>): tests and drills, in pool units with --scale 1. */
const syntheticVenue = (s: PriceSource): VenueSource => ({
  name: s.name,
  async read() {
    const r = await s.read();
    return { venue: s.name, at: r.at, sizeA: 1, smallA: 0.1, bid: r.price, ask: r.price, bidSmall: r.price, askSmall: r.price };
  },
});

export function makeVenues(names: string[], mainnetGw: Gateway, o: { sizeXrd: number; smallFraction: number }): VenueSource[] {
  const quoter = new Quoter(mainnetGw);
  return names.map((n) => {
    const def = VENUE_POOLS[n];
    if (def) return venueSource(n, def, mainnetGw, quoter, o);
    if (n.startsWith('fixed:') || n.startsWith('file:')) return syntheticVenue(makePriceSources([n], mainnetGw)[0]!);
    throw new Error(`Unknown venue ${n} (known: ${VENUE_NAMES.join(', ')}, fixed:<price>, file:<path>)`);
  });
}

export const readVenueSource = async (s: VenueSource): Promise<VenueQuote> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([s.read(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after 45 s')), 45_000); })]);
  } catch (e) {
    return { venue: s.name, at: 0, sizeA: 0, smallA: 0, bid: NaN, ask: NaN, bidSmall: NaN, askSmall: NaN, error: String((e as Error)?.message ?? e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
};

// ------------------------------------------------------------------ watch sources

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
