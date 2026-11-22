import type { Gateway } from './gateway.ts';
import { addr, bucket } from './manifest.ts';
import type { Pool, Token } from './types.ts';

/**
 * Pool packages we are willing to route through, by network.
 * A pool whose on-ledger package is not listed here is ignored, whatever an API says about it.
 * Ociswap's first-version Flex pools (drained Oct/Nov 2026) are deliberately absent.
 */
export const ALLOWED_PACKAGES: Record<string, { venue: Pool['venue']; blueprint: string }> = {
  package_rdx1pkl8tdw43xqx64etxwdf8rjtvptqurq4c3fky0kaj6vwa0zrkfmcmc: { venue: 'ociswap', blueprint: 'PrecisionPool' },
  package_rdx1p5l6dp3slnh9ycd7gk700czwlck9tujn0zpdnd0efw09n2zdnn0lzx: { venue: 'ociswap', blueprint: 'BasicPool' },
  // DefiPlaza pairs are swapped at the pair component: the dex-level `swap` only knows DFP2-quoted pairs.
  package_rdx1p4lnurhaffzjeg3gu0k27g06ngkvxvyuksczmk9k6gqvztfpks8r7l: { venue: 'defiplaza', blueprint: 'PlazaPair' },
  // Second DefiPlaza package, used by its XRD-quoted pairs (first seen Nov 2026). Its source has not been
  // compared with the published repository. A trader is still protected by the minimum-received assertion.
  package_rdx1p4dhfl7qwthqqu6p2267m5nedlqnzdvfxdl6q7h8g85dflx8n06p93: { venue: 'defiplaza', blueprint: 'PlazaPair' },
  // CaviarNine Shape Liquidity. Unmaintained: only the two pools in CAVIARNINE_POOLS are listed, best-effort.
  // `swap(Bucket) -> (Bucket, Bucket)` is open to anyone, charges no royalty, and returns proceeds and any unswapped input.
  package_rdx1p4r9rkp0cq67wmlve544zgy0l45mswn6h798qdqm47x4762h383wa3: { venue: 'caviarnine', blueprint: 'QuantaSwap' },
};

/**
 * Venues routed through on a best-effort basis: their pools are probed and quoted alongside the
 * usual deepest pools rather than competing with them for a place, and anything that fails for
 * them (listing, quote, depth, trades) drops them silently without touching the other venues.
 * CaviarNine's admin can still disable swaps or raise fees, and its pools are heavily one-sided.
 */
export const BEST_EFFORT_VENUES: ReadonlySet<Pool['venue']> = new Set<Pool['venue']>(['caviarnine']);

export const isBestEffort = (pool: Pool): boolean => BEST_EFFORT_VENUES.has(pool.venue);

/**
 * XRD added to the measured network fee of a swap through these venues, where the cost moves with
 * the pool's state between quote and fill. A CaviarNine swap's cost grows with the bins it crosses:
 * on mainnet (22 Nov 2026) 0.87 to 1.17 XRD on the LSULP pool and 0.93 to 1.50 XRD on the hUSDC pool,
 * against about 0.5 for an Ociswap basic pool and 0.9 for a precision pool.
 */
export const VENUE_GAS_MARGIN_XRD: Partial<Record<Pool['venue'], string>> = { caviarnine: '0.3' };

/**
 * The pools worth probing among `pools`: the `n` deepest ordinary ones by value locked, then every
 * best-effort pool. A best-effort pool's value locked says little about what it can trade (one
 * side is often nearly empty), so it neither takes an ordinary pool's place nor needs one to make room.
 */
export function poolsToProbe(pools: Pool[], n: number): Pool[] {
  const ordinary = pools.filter((p) => !isBestEffort(p)).sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, n);
  return [...ordinary, ...pools.filter(isBestEffort)];
}

/**
 * The only CaviarNine pools listed, by component address. There is no CaviarNine API any more, so
 * this list is static; tokens and balances are read from the ledger.
 */
export const CAVIARNINE_POOLS: readonly string[] = [
  // XRD/hUSDC: millions of XRD against a few hUSDC. Useful for buying XRD with hUSDC.
  'component_rdx1cqelumvmmgwths34k9pp0htd2ykwq7d70m0r389etwh39ul3j5tyj5',
  // LSULP/XRD: over a million XRD against a few dozen LSULP. Useful for selling LSULP.
  'component_rdx1crdhl7gel57erzgpdz3l3vr64scslq4z7vd0xgna6vh5fq5fnn9xas',
];

type JsonFetch = (url: string) => Promise<any>;

export const defaultJsonFetch: JsonFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function balancedReserve(tvlUsd: number, side: any): number {
  const price = num(side?.price?.usd?.now);
  return price > 0 ? tvlUsd / 2 / price : num(side?.liquidity?.token?.now);
}

export interface VenueListing {
  pools: Pool[];
  tokens: Token[];
  /** USD price per token, where the venue's API gives one. */
  pricesUsd?: Record<string, number>;
}

/** Ociswap Basic and Precision pools from its public API. */
export async function listOciswap(opts: { minTvlUsd: number; fetchJson?: JsonFetch; base?: string }): Promise<VenueListing> {
  const fetchJson = opts.fetchJson ?? defaultJsonFetch;
  const base = opts.base ?? 'https://api.ociswap.com';
  const pools: Pool[] = [];
  const tokens = new Map<string, Token>();
  const pricesUsd: Record<string, number> = {};
  let cursor = 0;
  // The API is ordered by rank (TVL), so we can stop at the first page that falls below the threshold.
  // Its last page returns next_cursor 0, which would wrap round to the start: stop on that too.
  for (let page = 0; page < 40; page++) {
    const j = await fetchJson(`${base}/pools?limit=100&cursor=${cursor}`);
    const rows: any[] = Array.isArray(j?.data) ? j.data : [];
    let belowThreshold = rows.length === 0;
    for (const p of rows) {
      const tvl = num(p?.total_value_locked?.usd?.now);
      if (tvl < opts.minTvlUsd) { belowThreshold = true; continue; }
      if (p.pool_type !== 'precision' && p.pool_type !== 'basic') continue;
      const x = p.x?.token, y = p.y?.token;
      if (!x?.address || !y?.address) continue;
      for (const t of [x, y]) {
        tokens.set(t.address, { address: t.address, symbol: String(t.symbol ?? '?'), name: String(t.name ?? ''), iconUrl: t.icon_url || undefined });
      }
      for (const side of [p.x, p.y]) {
        const usd = num(side?.price?.usd?.now);
        if (usd > 0 && !(side.token.address in pricesUsd)) pricesUsd[side.token.address] = usd;
      }
      pools.push({
        venue: 'ociswap',
        address: String(p.address),
        kind: String(p.pool_type),
        tokens: [x.address, y.address],
        feeRate: num(p.fee_rate),
        tvlUsd: tvl,
        volume24hUsd: num(p?.volume?.usd?.['24h']),
        // Concentrated pools can hold almost none of one token while still quoting it deeply, so size
        // depth probes from half the pool's value expressed in each token, not from raw balances.
        reserves: [balancedReserve(tvl, p.x), balancedReserve(tvl, p.y)],
      });
    }
    const next = num(j?.next_cursor);
    if (belowThreshold || next <= cursor) break;
    cursor = next;
  }
  return { pools, tokens: [...tokens.values()], pricesUsd };
}

/** DefiPlaza pairs from its public API. */
export async function listDefiPlaza(opts: { minTvlUsd: number; fetchJson?: JsonFetch; base?: string }): Promise<VenueListing> {
  const fetchJson = opts.fetchJson ?? defaultJsonFetch;
  const j = await fetchJson(`${opts.base ?? 'https://radix.defiplaza.net'}/api/pairs`);
  const rows: any[] = Array.isArray(j?.data) ? j.data : [];
  const pools: Pool[] = [];
  for (const p of rows) {
    const tvl = num(p.tvlUSD);
    if (tvl < opts.minTvlUsd || !p.baseToken || !p.quoteToken || !p.address) continue;
    pools.push({
      venue: 'defiplaza',
      address: String(p.address),
      kind: 'calm',
      tokens: [String(p.baseToken), String(p.quoteToken)],
      feeRate: 0,
      tvlUsd: tvl,
      volume24hUsd: num(p.volume),
      reserves: [num(p.baseTVL), num(p.quoteTVL)],
    });
  }
  return { pools, tokens: [] };
}

/**
 * The CaviarNine pools in `addresses` (default `CAVIARNINE_POOLS`), read from the ledger: which two
 * tokens each holds (from its own `tokens_x` and `tokens_y` vaults), its balances, and its price
 * (from the active bin's bounds). A pool that cannot be read or makes no sense is left out; this
 * never throws for one pool. `pricesUsd` (XRD at least) values the pools for display; without it
 * their value locked is 0.
 *
 * `reserves` are what each side can take in, from the other side's balance at the pool's price, so
 * depth probes sell into the deep side at sensible sizes and stay well within the thin side, which
 * a swap cannot exceed (it fails, or hands the input back).
 */
export async function listCaviarNine(gateway: Gateway, opts: { pricesUsd?: Record<string, number>; addresses?: readonly string[] } = {}): Promise<VenueListing> {
  const addresses = [...(opts.addresses ?? CAVIARNINE_POOLS)];
  const j = await gateway.post('/state/entity/details', { addresses, aggregation_level: 'Vault' });
  const xrd = gateway.network.xrd;
  const pools: Pool[] = [];
  for (const d of j?.items ?? []) {
    try {
      const pool = caviarNinePool(d, xrd, opts.pricesUsd ?? {});
      if (pool) pools.push(pool);
    } catch { /* leave this pool out */ }
  }
  return { pools, tokens: [] };
}

/** One QuantaSwap component's entity details (vault aggregation) as a Pool, or undefined. */
export function caviarNinePool(d: any, xrd: string, pricesUsd: Record<string, number>): Pool | undefined {
  if (d?.details?.blueprint_name !== 'QuantaSwap' || typeof d.address !== 'string') return undefined;
  const fields: any[] = Array.isArray(d.details?.state?.fields) ? d.details.state.fields : [];
  const field = (name: string) => fields.find((f) => f?.field_name === name)?.value;
  const vaultX = field('tokens_x'), vaultY = field('tokens_y');
  const lower = Number(field('lower_limit')), upper = Number(field('upper_limit'));
  // The bin bounds are square roots of prices (y per x): their product is the bin's geometric mid price.
  const price = lower * upper;
  if (!(price > 0) || !Number.isFinite(price) || typeof vaultX !== 'string' || typeof vaultY !== 'string') return undefined;
  // Balance and resource of each vault, from the component's own fungible holdings.
  const inVault = (vault: string): { resource: string; amount: number } | undefined => {
    for (const r of d.fungible_resources?.items ?? []) {
      for (const v of r?.vaults?.items ?? []) {
        if (v?.vault_address === vault) return { resource: String(r.resource_address), amount: num(v.amount) };
      }
    }
    return undefined;
  };
  const x = inVault(vaultX), y = inVault(vaultY);
  if (!x || !y || x.resource === y.resource) return undefined;
  // Each side can take in what the other side holds, at the pool's price.
  const reserves: [number, number] = [y.amount / price, x.amount * price];
  // Value locked, in XRD and then USD: needs XRD on one side and a USD price for XRD.
  const xrdUsd = pricesUsd[xrd] ?? 0;
  const inXrd = x.resource === xrd ? x.amount + y.amount / price : y.resource === xrd ? y.amount + x.amount * price : 0;
  return {
    venue: 'caviarnine',
    address: d.address,
    kind: 'shape',
    tokens: [x.resource, y.resource],
    // Not published in its state; the previews that quote it include it.
    feeRate: 0,
    tvlUsd: inXrd * xrdUsd,
    volume24hUsd: 0,
    reserves,
  };
}

/**
 * Keep only pools whose component really is an instance of an allow-listed package and blueprint.
 * This reads the ledger; the venue API is not trusted for it.
 */
export async function filterAllowedPools(gateway: Gateway, pools: Pool[], allowed = ALLOWED_PACKAGES): Promise<Pool[]> {
  const addresses = [...new Set(pools.map((p) => p.address))];
  const details = await gateway.entityDetails(addresses);
  const ok = new Set<string>();
  for (const d of details) {
    const rule = allowed[d?.details?.package_address];
    if (rule && rule.blueprint === d?.details?.blueprint_name) ok.add(d.address);
  }
  return pools.filter((p) => ok.has(p.address) && allowed[detailsPackage(details, p.address)]?.venue === p.venue)
    .map((p) => ({ ...p, holders: nativePoolsIn(details.find((d) => d.address === p.address)) }));
}

/** Every native pool address (`pool_…`) the component's state names: the pools that hold its funds. */
export function nativePoolsIn(detail: any): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof v === 'string') { if (/^pool_(rdx|tdx_2_|sim)1[a-z0-9]{20,80}$/.test(v)) found.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(detail?.details?.state, 0);
  return [...found];
}

function detailsPackage(details: any[], address: string): string {
  return details.find((d) => d.address === address)?.details?.package_address ?? '';
}

/** Manifest line that swaps the whole of `inBucket` through `pool`, leaving the proceeds on the worktop. */
export function swapInstruction(pool: Pool, inBucket: string, _outResource: string): string {
  // Ociswap pools, DefiPlaza pairs and CaviarNine QuantaSwap pools share the same shape: `swap(bucket)`,
  // proceeds returned to the worktop. A DefiPlaza pair or a CaviarNine pool may also return part of the
  // input unswapped if it runs out of liquidity (a CaviarNine pool may instead fail the transaction).
  return `CALL_METHOD ${addr(pool.address)} "swap" ${bucket(inBucket)};`;
}

/** Token symbol, name and icon from on-ledger metadata, for tokens no venue API described. */
export async function tokensFromLedger(gateway: Gateway, addresses: string[]): Promise<Token[]> {
  const details = await gateway.entityDetails(addresses);
  return details.map((d) => {
    const md = new Map<string, any>((d?.metadata?.items ?? []).map((i: any) => [i.key, i.value?.typed?.value]));
    return {
      address: d.address,
      symbol: String(md.get('symbol') ?? '?').slice(0, 16),
      name: String(md.get('name') ?? '').slice(0, 64),
      iconUrl: typeof md.get('icon_url') === 'string' ? md.get('icon_url') : undefined,
    };
  });
}
