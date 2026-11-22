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
  /** Header carrying the visitor's address when the server sits behind a proxy (for example `cf-connecting-ip` behind Cloudflare). */
  clientIpHeader: string | undefined;
  /** Requests allowed per visitor per minute. */
  ratePerMinute: number;
  /** Optional second listener over https (the Radix Connector extension needs https off localhost). */
  tls: { port: number; keyFile: string; certFile: string } | undefined;
  /** Loss limit: the solver stops sending when network fees paid on failed transactions in the last hour reach this (XRD). */
  failedFeeLimitXrd: number;
  /** An account whose orders failed this many times in 24 hours may not post orders, and its open orders are skipped, until the count falls. */
  accountFailureLimit: number;
  /** Most resting signed orders, and most on-ledger book orders, the solver looks at in one pass (market orders are not limited). */
  maxRestingPerTick: number;
  maxBookPerTick: number;
  /**
   * Smallest "In parts" (order-book) order, in XRD, the site lets a user place, and below which the
   * solver does not buy a book order with its own funds: taking a resting order costs the solver about
   * 0.38 XRD of network fee, so a tiny one is never worth routing to. Published in /api/config as
   * `orderBook.minOrderXrd`. Default per network (`DEFAULT_MIN_BOOK_ORDER_XRD`); `DEX_MIN_BOOK_ORDER_XRD`
   * replaces it. The order-book contract itself has no minimum: someone calling it directly is not held to this.
   */
  minBookOrderXrd: number;
  /** /api/health reports the solver as low on funds below this XRD balance. */
  lowXrd: number;
  /**
   * Tokens, by resource address, that may be converted to XRD inside a fill to pay the solver's
   * charges, for pairs with no route through XRD (rule 2(b), not built yet: see
   * docs/review-2026-11-21/fee-side.md). Published in /api/config; the solver itself only ever
   * keeps XRD. `DEX_FEE_TOKENS`, comma-separated, replaces the per-network default.
   */
  feeTokens: string[];
}

/** A whole number from the environment, or the default; anything else is a start-up error rather than a silent NaN. */
function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  if (!/^\d+$/.test(v.trim()) || Number(v) < min || Number(v) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, not "${v}"`);
  return Number(v);
}

/** A non-negative decimal number from the environment, or the default. */
function num(env: NodeJS.ProcessEnv, name: string, dflt: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  if (!/^\d+(\.\d+)?$/.test(v.trim()) || Number(v) > max) throw new Error(`${name} must be a number from 0 to ${max}, not "${v}"`);
  return Number(v);
}

/**
 * Bridged dollar stablecoins on mainnet, by resource address (never matched by symbol, which anyone can copy).
 * xUSDC is left out on purpose: its bridge is gone and it no longer trades near a dollar.
 */
const MAINNET_STABLES = [
  'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv', // hUSDC
  'resource_rdx1th4v03gezwgzkuma6p38lnum8ww8t4ds9nvcrkr2p9ft6kxx3kxvhe', // hUSDT
];

/**
 * Default fee-conversion tokens, by resource address, checked against the ledger on 22 Nov 2026
 * (evidence in docs/review-2026-11-21/fee-side.md). Left out on purpose: xUSDC and xUSDT (Instabridge;
 * thin DefiPlaza pools, about 16% lost on a round trip), hUSDT (0.04 in existence).
 */
const DEFAULT_FEE_TOKENS: Record<string, string[]> = {
  mainnet: [
    'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv', // hUSDC (Hyperlane)
    'resource_rdx1t5ywq4c6nd2lxkemkv4uzt8v7x7smjcguzq5sgafwtasa6luq7fclq', // DFP2 (DefiPlaza's own token, not a dollar token)
  ],
  stokenet: [
    'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx', // TUSD, the test dollar token
  ],
};

/**
 * Default smallest book order, in XRD. Mainnet: 100 (the owner's figure, 22 Nov 2026). Stokenet: 5, the
 * old default for every network, kept low because test XRD is not priced like the real thing (the test
 * pool has had it at about 200x mainnet) and tests place small orders.
 */
export const DEFAULT_MIN_BOOK_ORDER_XRD: Record<string, number> = { mainnet: 100, stokenet: 5 };

/** A comma-separated list of resource addresses on this network; a bad entry stops the server. */
function resources(env: NodeJS.ProcessEnv, name: string, dflt: string[], hrp: string): string[] {
  const v = env[name];
  if (v === undefined) return dflt;
  const list = v.split(',').map((x) => x.trim()).filter(Boolean);
  for (const r of list) if (!new RegExp(`^resource_${hrp}1[02-9ac-hj-np-z]{50,70}$`).test(r)) throw new Error(`${name}: "${r}" is not a resource address on this network`);
  return [...new Set(list)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const name = (env.DEX_NETWORK ?? 'mainnet') as NetworkName;
  const network = NETWORKS[name];
  if (!network) throw new Error(`Unknown DEX_NETWORK "${name}"`);
  const feeBps = env.DEX_TAKER_FEE_BPS !== undefined ? int(env, 'DEX_TAKER_FEE_BPS', 10, 0, 100) : int(env, 'DEX_FEE_BPS', 10, 0, 100);
  const makerFeeBps = int(env, 'DEX_MAKER_FEE_BPS', 0, 0, 100);
  return {
    network,
    gatewayUrl: env.DEX_GATEWAY_URL ?? network.gatewayUrl,
    port: int(env, 'DEX_PORT', 8787, 0, 65535),
    host: env.DEX_HOST ?? '127.0.0.1',
    dataDir: env.DEX_DATA_DIR ?? 'data',
    minPoolTvlUsd: num(env, 'DEX_MIN_POOL_TVL_USD', 300, 1e12),
    quotePriority: [...(name === 'mainnet' ? MAINNET_STABLES : []), network.xrd],
    feeBps,
    makerFeeBps,
    webDir: env.DEX_WEB_DIR,
    solverBadge: env.DEX_SOLVER_BADGE,
    solverKeyFile: env.DEX_SOLVER_KEY_FILE,
    registry: env.DEX_REGISTRY,
    orderBook: env.DEX_ORDER_BOOK,
    maxOrderLifetimeSec: int(env, 'DEX_MAX_ORDER_LIFETIME_SEC', 30 * 86400, 60, 365 * 86400),
    maxOpenOrdersPerAccount: int(env, 'DEX_MAX_OPEN_ORDERS', 50, 1, 10_000),
    marketsFile: env.DEX_MARKETS_FILE,
    dAppDefinition: env.DEX_DAPP_DEFINITION,
    clientIpHeader: env.DEX_CLIENT_IP_HEADER,
    ratePerMinute: int(env, 'DEX_RATE_PER_MINUTE', 240, 1, 1_000_000),
    tls: env.DEX_TLS_KEY_FILE && env.DEX_TLS_CERT_FILE
      ? { port: int(env, 'DEX_TLS_PORT', 8443, 0, 65535), keyFile: env.DEX_TLS_KEY_FILE, certFile: env.DEX_TLS_CERT_FILE } : undefined,
    failedFeeLimitXrd: num(env, 'DEX_FAILED_FEE_LIMIT_XRD', 3, 1e6),
    accountFailureLimit: int(env, 'DEX_ACCOUNT_FAILURE_LIMIT', 6, 1, 1_000_000),
    maxRestingPerTick: int(env, 'DEX_MAX_RESTING_PER_TICK', 20, 1, 10_000),
    maxBookPerTick: int(env, 'DEX_MAX_BOOK_PER_TICK', 20, 1, 10_000),
    minBookOrderXrd: num(env, 'DEX_MIN_BOOK_ORDER_XRD', DEFAULT_MIN_BOOK_ORDER_XRD[name] ?? 5, 1e9),
    lowXrd: num(env, 'DEX_LOW_XRD', 30, 1e9),
    feeTokens: resources(env, 'DEX_FEE_TOKENS', DEFAULT_FEE_TOKENS[name] ?? [], name === 'mainnet' ? 'rdx' : 'tdx_2_'),
  };
}
