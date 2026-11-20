import { type Depth, type Pool, type Token, marketKey } from '@radix-dex/core/browser';

export interface MarketSummary { id: string; base: Token; quote: Token; tvlUsd: number; volume24hUsd: number; venues: string[] }
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface ServerConfig {
  network: 'mainnet' | 'stokenet'; networkId: number; xrd: string; feeBps: number; warning: string | null;
  limitOrders: { enabled: false } | { enabled: true; solverBadge: string; registry: string | null; maxLifetimeSec: number; filling: boolean };
  /** Set by the static preview build: data is a snapshot taken at this time and nothing can be traded. */
  snapshotAt?: number;
}
export interface QuoteResult { sell: string; buy: string; sellAmount: string; buyAmount: string; price: string; route: Pool[]; networkFeeXrd: string }
export interface OrderView {
  id: string; account: string; sell: string; sellAmount: string; buy: string; minBuyAmount: string;
  expiresAt: number; createdAt: number; status: 'open' | 'filled' | 'cancelled' | 'expired'; fillTx: string | null; received: string | null;
}

/** Static preview builds read pre-generated JSON instead of a live server. */
export const STATIC = import.meta.env.VITE_STATIC === '1';
const BASE = import.meta.env.BASE_URL;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try { message = (await res.json()).error ?? message; } catch { /* keep the status */ }
    throw new Error(message);
  }
  return res.json();
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

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
  trades: (id: string) => (STATIC ? Promise.resolve([] as OrderView[]) : get<OrderView[]>(`/api/trades?market=${q(id)}`)),
  placeOrder: (body: unknown) => post<{ id: string; expiresAt: number }>('/api/orders', body),
  cancelOrder: (id: string, secret: string) => post<{ id: string }>(`/api/orders/${q(id)}/cancel`, { secret }),
};
