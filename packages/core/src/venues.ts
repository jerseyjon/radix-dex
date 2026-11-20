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
  package_rdx1p4lnurhaffzjeg3gu0k27g06ngkvxvyuksczmk9k6gqvztfpks8r7l: { venue: 'defiplaza', blueprint: 'PlazaDex' },
};

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

export interface VenueListing {
  pools: Pool[];
  tokens: Token[];
}

/** Ociswap Basic and Precision pools from its public API. */
export async function listOciswap(opts: { minTvlUsd: number; fetchJson?: JsonFetch; base?: string }): Promise<VenueListing> {
  const fetchJson = opts.fetchJson ?? defaultJsonFetch;
  const base = opts.base ?? 'https://api.ociswap.com';
  const pools: Pool[] = [];
  const tokens = new Map<string, Token>();
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
      pools.push({
        venue: 'ociswap',
        address: String(p.address),
        kind: String(p.pool_type),
        tokens: [x.address, y.address],
        feeRate: num(p.fee_rate),
        tvlUsd: tvl,
        volume24hUsd: num(p?.volume?.usd?.['24h']),
        reserves: [num(p.x?.liquidity?.token?.now), num(p.y?.liquidity?.token?.now)],
      });
    }
    const next = num(j?.next_cursor);
    if (belowThreshold || next <= cursor) break;
    cursor = next;
  }
  return { pools, tokens: [...tokens.values()] };
}

/** DefiPlaza pairs from its public API. The swap call goes to the dex component, not the pair. */
export async function listDefiPlaza(opts: { minTvlUsd: number; fetchJson?: JsonFetch; base?: string }): Promise<VenueListing> {
  const fetchJson = opts.fetchJson ?? defaultJsonFetch;
  const j = await fetchJson(`${opts.base ?? 'https://radix.defiplaza.net'}/api/pairs`);
  const rows: any[] = Array.isArray(j?.data) ? j.data : [];
  const pools: Pool[] = [];
  for (const p of rows) {
    const tvl = num(p.tvlUSD);
    if (tvl < opts.minTvlUsd || !p.baseToken || !p.quoteToken || !p.dexAddress) continue;
    pools.push({
      venue: 'defiplaza',
      address: String(p.dexAddress),
      pairAddress: String(p.address),
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
  return pools.filter((p) => ok.has(p.address) && allowed[detailsPackage(details, p.address)]?.venue === p.venue);
}

function detailsPackage(details: any[], address: string): string {
  return details.find((d) => d.address === address)?.details?.package_address ?? '';
}

/** Manifest line that swaps the whole of `inBucket` through `pool`, leaving the proceeds on the worktop. */
export function swapInstruction(pool: Pool, inBucket: string, outResource: string): string {
  switch (pool.venue) {
    case 'ociswap':
      return `CALL_METHOD ${addr(pool.address)} "swap" ${bucket(inBucket)};`;
    case 'defiplaza':
      return `CALL_METHOD ${addr(pool.address)} "swap" ${bucket(inBucket)} ${addr(outResource)};`;
  }
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
