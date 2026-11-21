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
  /** Taker fee, in basis points: charged to the order that takes liquidity (from a pool or from a resting order). */
  feeBps: number;
  /** Maker fee, in basis points: charged to a resting order when another order takes it. Often zero. */
  makerFeeBps: number;
  webDir: string | undefined;
  /** Limit orders are accepted only when a solver badge is configured. */
  solverBadge: string | undefined;
  /** File holding the solver's Ed25519 private key (hex), mode 600. Without it orders are stored but not filled. */
  solverKeyFile: string | undefined;
  /** On-ledger order book component (resting orders with partial fills), if deployed. */
  orderBook: string | undefined;
  /** Hard-cancel registry component, if deployed. */
  registry: string | undefined;
  maxOrderLifetimeSec: number;
  maxOpenOrdersPerAccount: number;
  /** Optional JSON file of extra tokens and pools (used on Stokenet, where no venue API exists). */
  marketsFile: string | undefined;
  /** dApp definition account the wallet checks the site against. Without it the site is read-only. */
  dAppDefinition: string | undefined;
  /** Optional second listener over https (the Radix Connector extension needs https off localhost). */
  tls: { port: number; keyFile: string; certFile: string } | undefined;
}

/**
 * Bridged dollar stablecoins on mainnet, by resource address (never matched by symbol, which anyone can copy).
 * xUSDC is left out on purpose: its bridge is gone and it no longer trades near a dollar.
 */
const MAINNET_STABLES = [
  'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv', // hUSDC
  'resource_rdx1th4v03gezwgzkuma6p38lnum8ww8t4ds9nvcrkr2p9ft6kxx3kxvhe', // hUSDT
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const name = (env.DEX_NETWORK ?? 'mainnet') as NetworkName;
  const network = NETWORKS[name];
  if (!network) throw new Error(`Unknown DEX_NETWORK "${name}"`);
  const feeBps = Number(env.DEX_TAKER_FEE_BPS ?? env.DEX_FEE_BPS ?? 10);
  const makerFeeBps = Number(env.DEX_MAKER_FEE_BPS ?? 0);
  for (const f of [feeBps, makerFeeBps]) if (!(f >= 0 && f <= 100)) throw new Error('Fees must be between 0 and 100 basis points');
  return {
    network,
    gatewayUrl: env.DEX_GATEWAY_URL ?? network.gatewayUrl,
    port: Number(env.DEX_PORT ?? 8787),
    host: env.DEX_HOST ?? '127.0.0.1',
    dataDir: env.DEX_DATA_DIR ?? 'data',
    minPoolTvlUsd: Number(env.DEX_MIN_POOL_TVL_USD ?? 300),
    quotePriority: [...(name === 'mainnet' ? MAINNET_STABLES : []), network.xrd],
    feeBps,
    makerFeeBps,
    webDir: env.DEX_WEB_DIR,
    solverBadge: env.DEX_SOLVER_BADGE,
    solverKeyFile: env.DEX_SOLVER_KEY_FILE,
    registry: env.DEX_REGISTRY,
    orderBook: env.DEX_ORDER_BOOK,
    maxOrderLifetimeSec: Number(env.DEX_MAX_ORDER_LIFETIME_SEC ?? 30 * 86400),
    maxOpenOrdersPerAccount: Number(env.DEX_MAX_OPEN_ORDERS ?? 50),
    marketsFile: env.DEX_MARKETS_FILE,
    dAppDefinition: env.DEX_DAPP_DEFINITION,
    tls: env.DEX_TLS_KEY_FILE && env.DEX_TLS_CERT_FILE
      ? { port: Number(env.DEX_TLS_PORT ?? 8443), keyFile: env.DEX_TLS_KEY_FILE, certFile: env.DEX_TLS_CERT_FILE } : undefined,
  };
}
