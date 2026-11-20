import { NETWORKS, type NetworkConfig, type NetworkName } from '@radix-dex/core';

export interface Config {
  network: NetworkConfig;
  gatewayUrl: string;
  port: number;
  host: string;
  dataDir: string;
  /** Pools below this TVL are not listed. */
  minPoolTvlUsd: number;
  /** Quote-currency priority: stablecoins first, then XRD. */
  quotePriority: string[];
  /** Trading fee taken by the solver from limit-order fills, in basis points. */
  feeBps: number;
  webDir: string | undefined;
}

/** Bridged dollar stablecoins on mainnet, by resource address (never matched by symbol, which anyone can copy). */
const MAINNET_STABLES = [
  'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv', // hUSDC
  'resource_rdx1th4v03gezwgzkuma6p38lnum8ww8t4ds9nvcrkr2p9ft6kxx3kxvhe', // hUSDT
  'resource_rdx1t4upr78guuapv5ept7d7ptekk9mqhy605zgms33mcszen8l9fac8vf', // xUSDC
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const name = (env.DEX_NETWORK ?? 'mainnet') as NetworkName;
  const network = NETWORKS[name];
  if (!network) throw new Error(`Unknown DEX_NETWORK "${name}"`);
  const feeBps = Number(env.DEX_FEE_BPS ?? 10);
  if (!(feeBps >= 0 && feeBps <= 100)) throw new Error('DEX_FEE_BPS must be between 0 and 100');
  return {
    network,
    gatewayUrl: env.DEX_GATEWAY_URL ?? network.gatewayUrl,
    port: Number(env.DEX_PORT ?? 8787),
    host: env.DEX_HOST ?? '127.0.0.1',
    dataDir: env.DEX_DATA_DIR ?? 'data',
    minPoolTvlUsd: Number(env.DEX_MIN_POOL_TVL_USD ?? 300),
    quotePriority: [...(name === 'mainnet' ? MAINNET_STABLES : []), network.xrd],
    feeBps,
    webDir: env.DEX_WEB_DIR,
  };
}
