import { type Depth, type Pool, type Token, marketKey } from '@radix-dex/core/browser';
import { retryAfterSec } from './live';

/** A token as /api/markets lists it: `divisibility` once the server has read it from the ledger. */
export type MarketToken = Token & { divisibility?: number };
export interface MarketSummary { id: string; base: MarketToken; quote: MarketToken; tvlUsd: number; volume24hUsd: number; venues: string[];
  /** The market's pool components (newer servers). */
  pools?: string[] }
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
  /** The on-ledger order book, for resting orders that fill in part. The fee is read from the ledger. */
  orderBook?: { component: string; receipts: string; makerFeeBps: number } | null;
  /** Set by the static preview build: data is a snapshot taken at this time and nothing can be traded. */
  snapshotAt?: number;
}
export interface QuoteResult { sell: string; buy: string; sellAmount: string; buyAmount: string; price: string; route: Pool[]; networkFeeXrd: string;
  /** The network fee of a plain fill, valued in the token being bought; null if no pool prices that token. */
  gasInBuyToken?: string | null;
  /** The allowance to sign for that fee: the solver's estimate plus 25%. The solver fills an order whose allowance covers 75% of its estimate. */
  gasAllowanceInBuyToken?: string | null }
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
  outlook?: { available: string; needed: string; at: number } | null;
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
};
