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

export type VenueId = 'ociswap' | 'defiplaza';

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
  /** Roughly half the pool's value expressed in tokens[0] and in tokens[1]. Used only to size depth probes. */
  reserves: [number, number];
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
