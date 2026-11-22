export type NetworkName = 'mainnet' | 'stokenet';

export interface NetworkConfig {
  name: NetworkName;
  networkId: number;
  gatewayUrl: string;
  xrd: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  mainnet: {
    name: 'mainnet',
    networkId: 1,
    gatewayUrl: 'https://mainnet.radixdlt.com',
    xrd: 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
  },
  stokenet: {
    name: 'stokenet',
    networkId: 2,
    gatewayUrl: 'https://stokenet.radixdlt.com',
    xrd: 'resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc',
  },
};

export interface Token {
  address: string;
  symbol: string;
  name: string;
  iconUrl?: string;
}

/**
 * 'radixdex' is this project's own Pool blueprint; 'ownerpool' its OwnerPool blueprint (liquidity
 * from one owner). 'caviarnine' is two CaviarNine Shape Liquidity pools, routed through on a
 * best-effort basis only (see `BEST_EFFORT_VENUES`).
 */
export type VenueId = 'ociswap' | 'defiplaza' | 'radixdex' | 'caviarnine' | 'ownerpool';

/** One swappable pool on some venue. Amounts are decimal strings or plain numbers for display-only stats. */
export interface Pool {
  venue: VenueId;
  /** Component the swap call goes to. */
  address: string;
  /** Venue-specific pool kind, e.g. "precision", "basic", "calm". */
  kind: string;
  tokens: [string, string];
  feeRate: number;
  /** Display-only statistics from the venue's own API. */
  tvlUsd: number;
  volume24hUsd: number;
  /**
   * How much of tokens[0] and of tokens[1] the pool can take in: roughly the value of its other
   * side expressed in that token (for a balanced pool, half its value). Used only to size depth probes.
   */
  reserves: [number, number];
  /**
   * Native pool entities (`pool_…`) named in the component's own state, which hold its funds for
   * it (Ociswap basic pools, DefiPlaza pairs). Read from the ledger; used to recognise the pool's
   * side of a trade in a transaction.
   */
  holders?: string[];
}

export interface Market {
  /** `${base}/${quote}` resource addresses. */
  id: string;
  base: Token;
  quote: Token;
  pools: Pool[];
  tvlUsd: number;
  volume24hUsd: number;
}

export interface Quote {
  sell: string;
  buy: string;
  sellAmount: string;
  buyAmount: string;
  /** buyAmount / sellAmount */
  price: string;
  route: Pool[];
  networkFeeXrd: string;
  stateVersion?: number;
}

export interface DepthLevel {
  /** Price in quote per base. */
  price: number;
  /** Size in base units at this level. */
  size: number;
  /** Where the liquidity is: a venue id or "orders". */
  source: string;
}

export interface Depth {
  marketId: string;
  mid: number | null;
  bids: DepthLevel[];
  asks: DepthLevel[];
}
