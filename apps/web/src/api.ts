import { type Depth, type Pool, type Token, marketKey } from '@radix-dex/core/browser';
import { retryAfterSec } from './live';

/** A token as /api/markets lists it: `divisibility` once the server has read it from the ledger. */
export type MarketToken = Token & { divisibility?: number };
export interface MarketSummary { id: string; base: MarketToken; quote: MarketToken; tvlUsd: number; volume24hUsd: number; venues: string[];
  /** The market's pool components (newer servers). */
  pools?: string[];
  /** Whether the solver fills signed orders here: XRD on one side, or a route through XRD (servers since 22 Nov 2026). */
  solverFills?: boolean }
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface ServerConfig {
  network: 'mainnet' | 'stokenet'; networkId: number; xrd: string;
  /** Taker fee, and the fee a resting order pays when another order takes it (often zero). */
  feeBps: number; makerFeeBps?: number; warning: string | null;
  /** dApp definition account; null means the wallet cannot connect and the site is read-only. */
  dAppDefinition?: string | null;
  limitOrders: { enabled: false } | { enabled: true; solverBadge: string; registry: string | null; maxLifetimeSec: number; filling: boolean;
    /** Fallback network fee in XRD when a quote gives no route figure, and the margin to add to it for a signed allowance. */
    gasXrd: string; gasAllowanceMargin?: number; marketOrderLifetimeSec: number };
  /** The solver's charges are taken in XRD (`token`). `feeTokens` could be converted to XRD for fees; not done yet. */
  fees?: { token: string; takenIn: 'XRD'; feeTokens: string[]; convertsFeeTokens: boolean };
  /**
   * The on-ledger order book, for resting orders that fill in part. The fee is read from the ledger.
   * `minOrderXrd`: the smallest order, valued in XRD, the form lets a user place (absent from older servers).
   */
  orderBook?: { component: string; receipts: string; makerFeeBps: number; minOrderXrd?: string } | null;
  /** Set by the static preview build: data is a snapshot taken at this time and nothing can be traded. */
  snapshotAt?: number;
  /** A read-only server takes no orders (servers since 23 Nov 2026). */
  readOnly?: boolean;
  /** How many OwnerPools the server lists on its Pools page (servers since 23 Nov 2026). */
  ownerPools?: number;
}
export interface QuoteResult { sell: string; buy: string; sellAmount: string; buyAmount: string; price: string; route: Pool[]; networkFeeXrd: string;
  /** The network fee of a plain fill, valued in the token being bought; null if no pool prices that token. */
  gasInBuyToken?: string | null;
  /** The allowance to sign for that fee: the solver's estimate plus 25%. The solver fills an order whose allowance covers 75% of its estimate. */
  gasAllowanceInBuyToken?: string | null;
  /**
   * Where the solver's charges are taken, always in XRD: 'buy' from the XRD bought, 'sell' from the XRD
   * sold before the swap, 'hop' between two swaps through XRD; null when the solver cannot fill this pair.
   */
  feeAt?: 'buy' | 'sell' | 'hop' | null; feeToken?: string | null;
  /** The network fee estimate in XRD, and the allowance to sign for it (the estimate plus 25%). */
  gasXrd?: string; gasAllowanceXrd?: string;
  /** The XRD the service fee is charged on for this quote: XRD bought, XRD sold, or what the first swap produces. */
  xrdBase?: string | null }
export interface OrderView {
  id: string; account: string; sell: string; sellAmount: string; buy: string; minBuyAmount: string;
  /** Gross amount at which the order fills (price times size); the signed minimum is this less the fee allowance. */
  limitBuyAmount?: string; kind?: 'limit' | 'market' | 'book';
  /** Orders in the on-ledger book: their number there, how much has sold and how much is still for sale. */
  bookId?: number; sold?: string; remaining?: string;
  expiresAt: number; createdAt: number; status: 'open' | 'filled' | 'cancelled' | 'expired'; fillTx: string | null; received: string | null;
  /** When the order filled (seconds), if the server reports it; older servers do not. */
  filledAt?: number | null;
  /** What the fill produced before fees (its gross), when the server recorded it. */
  gross?: string | null;
  /** A fill transaction has been sent and its outcome is not known yet. */
  pending?: boolean;
  /** Open signed orders: whether the order checks the server's registry, so a cancel recorded there stops it. */
  registry?: boolean;
  /** Open orders: what the market would pay for the whole order now, before fees, against what it needs to fill. */
  outlook?: { available: string; needed: string; at: number;
    /** Set when the exchange will not fill the order as things stand, with why. */
    reason?: string } | null;
}

/** One trade in a market; `side` is the base token's taker side, `venue` is "here" or the pool's venue. */
export interface MarketTrade { txid: string; time: number; side: 'buy' | 'sell'; price: number; size: number; venue: string }
export interface TradeView { txid: string; time: number; sell: string; sellAmount: string; buy: string; buyAmount: string; feeXrd: string;
  /** Set when this is a sale from the account's order in the on-ledger book: the order's number there. */
  book?: number }

/** Static preview builds read pre-generated JSON instead of a live server. */
export const STATIC = import.meta.env.VITE_STATIC === '1';
const BASE = import.meta.env.BASE_URL;

/** A refusal from the server: its own message, its status, and how long it asked us to wait (429). */
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | undefined;
  constructor(message: string, status: number, retryAfterSec?: number) { super(message); this.status = status; this.retryAfterSec = retryAfterSec; }
}

/** After a 429 nothing is sent until the server's `Retry-After` has passed: every call fails at once instead. */
let quietUntil = 0;
const waitSec = () => Math.ceil((quietUntil - Date.now()) / 1000);

async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (waitSec() > 0) throw new ApiError(`Too many requests from this connection: wait ${waitSec()} s and try again`, 429, waitSec());
  const res = await fetch(path, init);
  const json = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message = typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`;
    if (res.status === 429) {
      const after = retryAfterSec(res.headers.get('retry-after'));
      if (after) quietUntil = Math.max(quietUntil, Date.now() + after * 1000);
      throw new ApiError(after ? `${message}: wait ${after} s and try again` : message, 429, after);
    }
    throw new ApiError(message, res.status);
  }
  if (json === undefined) throw new ApiError('The server sent an unreadable reply', res.status);
  return json as T;
}
const get = <T>(path: string) => request<T>(path, { headers: { accept: 'application/json' } });
const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const q = encodeURIComponent;

// ---------------------------------------------------------------- the owner's pools (/api/pools)

export interface PoolToken { address: string; symbol: string; divisibility: number }
export interface ProcessHealth { status: 'alive' | 'stale' | 'missing' | 'other-pool'; lastSeen: number | null; tick: number | null; ok: boolean | null; note: string | null }
export interface PoolMarket { price: number | null; source: string; status: 'ok' | 'disagree' | 'none' | 'bot'; reason: string; at: number;
  venues?: { venue: string; used: boolean; mid: number | null; dropped: string | null }[] }
export interface PoolRow {
  address: string; pair: { a: PoolToken; b: PoolToken }; reserves: { a: string; b: string };
  /** B per A on the curve. */
  price: number | null; market: PoolMarket | null;
  /** Pool against market in bps: positive = the pool is dearer. */
  gapBps: number | null; tvl: { a: number | null; usd: number | null };
  feeBps: number; paused: boolean; ownerPaused: boolean; operatorPaused: boolean;
  bot: { healthy: boolean; bot: ProcessHealth; watcher: ProcessHealth };
  stateVersion: number | null; readAt: number;
}
export interface OperatorLimits { moveBudgetBps: number; windowEpochs: number; maxReserveA: string; maxReserveB: string; minReserveA: string; minReserveB: string; minFeeBps: number; maxFeeBps: number }
export interface PoolActivity { txid: string; at: number; stateVersion: number; kind: 'swap' | 'owner' | 'operator' | 'other'; methods: string[]; lines: string[] }
export interface MarkoutBucket { trades: number; volumeA: number; feesA: number;
  horizons: Record<string, { marked: number; markoutA: number; profitA: number; feesA: number; volumeA: number; breakEvenFeeBps: number; poolMid: { marked: number; markoutA: number } }> }
export interface PoolDetail extends PoolRow {
  packageAddress: string; usdPerA: number | null;
  inventory: { a: string; b: string; valueA: number | null } | null;
  ownerBadge: string | null;
  operator: { badge: string | null; limits: OperatorLimits; anchor: [string, string];
    allowance: { now: string; budget: string; epoch: number; windowEpochs: number } | null; account: string | null; accountXrd: string | null } | null;
  botState: { operatorAccount: string | null; lastTx: { at: string; type: string; txid: string; status: string } | null; pending: { txid: string; type: string; at: number } | null;
    pausedByBot: boolean; pauseReason: string | null; consecutiveFailures: number; haltedUntil: number | null; behindTicks: number;
    reference: { at: number; price: number } | null; confirmedVenues: string[]; singleVenueSince: number | null;
    ownerAnchor: { anchor: [string, string]; txid: string; at: number } | null; lastFeeChangeAt: number | null } | null;
  fees: { swaps: number; feeA: string; feeB: string; volumeA: string; volumeB: string; firstAt: number | null; lastAt: number | null; complete: boolean; valueA: number | null; valueUsd: number | null };
  markout: { horizonsMin: number[]; trades: number; pending: number; all: MarkoutBucket; lastTradeAt: number | null } | null;
  activity: PoolActivity[];
  errors: string[];
}
export type OwnerAction = 'deposit' | 'withdraw' | 'pause' | 'unpause' | 'fee' | 'anchor' | 'limits-fee' | 'revoke';
export interface PreparedAction {
  action: OwnerAction; title: string; manifest: string; notes: string[]; scriptStep: string; want: unknown; network: string;
  readAt: { stateVersion: number | null; reserves: [string, string] };
  preview: { ok: boolean; error: string | null; feeXrd: string; proofs: { account: string; badge: string; label: string }[];
    changes: { entity: string; label: string; items: { resource: string; symbol: string; amount: string }[] }[] };
}

export const api = {
  config: () => (STATIC ? get<ServerConfig>(`${BASE}snapshot/config.json`) : get<ServerConfig>('/api/config')),
  markets: () => (STATIC ? get<MarketSummary[]>(`${BASE}snapshot/markets.json`) : get<MarketSummary[]>('/api/markets')),
  depth: (id: string) => (STATIC ? get<Depth>(`${BASE}snapshot/depth-${marketKey(id)}.json`) : get<Depth>(`/api/depth?market=${q(id)}`)),
  candles: (id: string, resolution: string) =>
    STATIC ? get<Candle[]>(`${BASE}snapshot/candles-${marketKey(id)}-${resolution}.json`) : get<Candle[]>(`/api/candles?market=${q(id)}&resolution=${resolution}`),
  quote: (sell: string, buy: string, amount: string) => get<QuoteResult>(`/api/quote?sell=${q(sell)}&buy=${q(buy)}&amount=${q(amount)}`),
  balances: (account: string) => get<Record<string, string>>(`/api/balances?account=${q(account)}`),
  orders: (account: string) => get<OrderView[]>(`/api/orders?account=${q(account)}`),
  history: (account: string) => get<TradeView[]>(`/api/history?account=${q(account)}`),
  trades: (id: string) => (STATIC ? Promise.resolve([] as MarketTrade[]) : get<MarketTrade[]>(`/api/trades?market=${q(id)}`)),
  placeOrder: (body: unknown) => post<{ id: string; expiresAt: number }>('/api/orders', body),
  cancelOrder: (id: string, secret: string) => post<{ id: string }>(`/api/orders/${q(id)}/cancel`, { secret }),
  pools: () => get<(PoolRow | { address: string; error: string })[]>('/api/pools'),
  pool: (component: string) => get<PoolDetail>(`/api/pools/${q(component)}`),
  poolOwner: (component: string, account: string) => get<{ owner: boolean; ownerBadge: string | null }>(`/api/pools/${q(component)}/owner?account=${q(account)}`),
  preparePoolAction: (component: string, body: { account: string; action: OwnerAction; params: Record<string, unknown> }) => post<PreparedAction>(`/api/pools/${q(component)}/prepare`, body),
  verifyPoolAction: (component: string, txid: string, want: unknown) =>
    post<{ status: string; error: string | null; mismatches: string[] | null }>(`/api/pools/${q(component)}/verify`, { txid, want }),
};
