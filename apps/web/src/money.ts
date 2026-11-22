// Exact decimal arithmetic for every figure the user signs or sends to a contract.
// JavaScript numbers are for display only: nothing in this file goes through Number on its
// way to a manifest. Decimal is core's copy (precision 60), so rounding is always stated.
import { Decimal } from '@radix-dex/core/browser';

export type Dec = InstanceType<typeof Decimal>;
type DecIn = Dec | string | number;

/** Most decimal places a Radix Decimal holds. */
export const MAX_PLACES = 18;
const PLAIN = /^\d{1,30}(\.\d{0,18})?$/;

/** Parse a plain, non-negative decimal string (no sign, no exponent, no hex). Undefined if it is not one. */
export function parsePlain(s: string | null | undefined): Dec | undefined {
  if (s == null) return undefined;
  const t = s.trim().replace(/,/g, '');
  if (!PLAIN.test(t)) return undefined;
  return new Decimal(t.replace(/\.$/, ''));
}

/** A decimal string without exponent notation, rounded down to `places` (at most 18), trailing zeros removed. */
export function toPlain(v: DecIn, places = MAX_PLACES): string {
  let d: Dec;
  try { d = new Decimal(v); } catch { return '0'; }
  if (!d.isFinite() || d.lte(0)) return '0';
  const p = Math.max(0, Math.min(Math.floor(places), MAX_PLACES));
  return d.toDecimalPlaces(p, Decimal.ROUND_DOWN).toFixed();
}

/** A positive amount as a string the server and manifests accept, or undefined if it rounds to nothing. */
export function positivePlain(v: DecIn | undefined, places = MAX_PLACES): string | undefined {
  if (v === undefined) return undefined;
  const s = toPlain(v, places);
  return s === '0' ? undefined : s;
}

/** Number of decimal places written in a decimal string ("1.500" → 3). */
export function placesIn(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Decimal places to round an amount of a token to. A known divisibility wins; XRD is 18.
 * Otherwise, when a balance string is given, the places written in it are a safe lower bound
 * (the ledger never reports more places than the token allows); with neither, 18.
 */
export function placesFor(token: { address: string; divisibility?: number }, xrd: string, balance?: string): number {
  if (typeof token.divisibility === 'number' && token.divisibility >= 0) return Math.min(MAX_PLACES, token.divisibility);
  if (token.address === xrd) return MAX_PLACES;
  if (balance !== undefined) return Math.min(MAX_PLACES, placesIn(balance));
  return MAX_PLACES;
}

/** `share` (0 to 1) of a balance, rounded down to `places`: 100% is the balance itself and never more. */
export function shareOf(balance: string, share: number, places: number): string | undefined {
  const b = parsePlain(balance);
  if (!b || b.lte(0) || !(share > 0)) return undefined;
  const v = share >= 1 ? b : b.times(new Decimal(String(share)));
  return positivePlain(v.gt(b) ? b : v, places);
}

/**
 * A pasted or typed number made into a plain decimal string, or undefined to refuse the edit.
 * Accepts digits with one dot, thousands commas, and plain scientific notation ("1e-5" → "0.00001").
 * Refuses signs, hex and anything else rather than silently deleting characters.
 */
export function normaliseInput(raw: string): string | undefined {
  const t = raw.trim().replace(/[,\s_]/g, '');
  if (t === '') return '';
  if (/^\d*\.?\d*$/.test(t)) return t;
  if (/^(\d+\.?\d*|\.\d+)e[+-]?\d{1,3}$/i.test(t)) {
    const d = new Decimal(t);
    if (!d.isFinite() || d.gt('1e30')) return undefined;
    return toPlain(d, MAX_PLACES);
  }
  return undefined;
}

export interface LimitTerms {
  /** What the user gives up: quote for a buy, base for a sell. */
  sellAmount: string;
  /** The order's price times its size, in the token bought: what the market must pay for it to fill. */
  gross: string;
}

/**
 * The amounts of a limit order from the typed price (quote per base) and size (base).
 * A buy sells `price × amount` of quote (rounded down to the quote token's places, so it never
 * spends more than typed) for `amount` of base. A sell sells `amount` (rounded down to the base
 * token's places) for `price ×` that amount of quote.
 */
export function limitTerms(side: 'buy' | 'sell', price: string, amount: string, sellPlaces = MAX_PLACES): LimitTerms | undefined {
  const p = parsePlain(price), a = parsePlain(amount);
  if (!p || !a || p.lte(0) || a.lte(0)) return undefined;
  if (side === 'buy') {
    const sellAmount = positivePlain(p.times(a), sellPlaces), gross = positivePlain(a);
    return sellAmount && gross ? { sellAmount, gross } : undefined;
  }
  // A sell is priced on the amount really sold, after rounding to the token's places.
  const sellAmount = positivePlain(a, sellPlaces);
  const gross = sellAmount ? positivePlain(p.times(sellAmount)) : undefined;
  return sellAmount && gross ? { sellAmount, gross } : undefined;
}

export interface Fees { network: Dec; service: Dec }

/**
 * Where the solver takes its charges: they are always XRD (since 22 Nov 2026).
 * `proceeds`: from the XRD the order buys. `input`: from the XRD it sells, before the swap.
 * `hop`: neither token is XRD; between the two swaps of a route through XRD.
 */
export type ChargeAt = 'proceeds' | 'input' | 'hop';
export const chargeAtFor = (sell: string, buy: string, xrd: string): ChargeAt => (buy === xrd ? 'proceeds' : sell === xrd ? 'input' : 'hop');

export interface XrdCharges {
  at: ChargeAt;
  /** In XRD: the network fee (or its signed allowance) and the service fee, and their sum, rounded down to 18 places as the solver rounds. */
  network: Dec; service: Dec; totalXrd: Dec;
  /** The XRD the service fee is charged on: the XRD bought, the XRD sold, or what the first swap produces. */
  xrdBase: Dec;
  /** What the user is left with, in the token bought, and the charges' equivalent in it. */
  net: Dec; inBuyToken: Dec;
  /** For `input`: the XRD actually swapped, after the charges are set aside. */
  swappedXrd?: Dec;
}

/**
 * The solver's charges in XRD on an order whose trade produces `gross` of the token bought (its
 * price times size for a limit order, the quote for a market order), and what that leaves the user.
 * Charges taken from the proceeds come straight off `gross`; charges taken before the last swap
 * reduce what is swapped, so the user gets `gross × (base − charges) / base`: their own price on
 * what is swapped. `gasXrd` is the network fee in XRD (for a signed limit order its allowance:
 * the estimate plus 25%). `xrdBase` is needed for `hop` (from the quote). Undefined if the charges
 * would take everything, or the base is unknown.
 */
export function xrdCharges(o: { at: ChargeAt; gross: DecIn; sellAmount: DecIn; xrdBase?: string | null; gasXrd: DecIn; feeBps: number }): XrdCharges | undefined {
  const gross = new Decimal(o.gross);
  const base = o.at === 'proceeds' ? gross : o.at === 'input' ? new Decimal(o.sellAmount) : o.xrdBase != null ? new Decimal(o.xrdBase) : undefined;
  if (!base || !base.gt(0) || !gross.gt(0)) return undefined;
  const network = new Decimal(o.gasXrd), service = base.times(o.feeBps).div(10_000);
  const totalXrd = network.plus(service).toDecimalPlaces(MAX_PLACES, Decimal.ROUND_DOWN);
  if (!totalXrd.lt(base)) return undefined;
  const net = o.at === 'proceeds' ? gross.minus(totalXrd) : gross.times(base.minus(totalXrd)).div(base);
  return { at: o.at, network, service, totalXrd, xrdBase: base, net, inBuyToken: gross.minus(net), swappedXrd: o.at === 'input' ? base.minus(totalXrd) : undefined };
}

/** Gross less two fees in the same token, rounded down. Undefined if not positive. */
export function minAfterFees(gross: DecIn, fees: Fees): string | undefined {
  return positivePlain(new Decimal(gross).minus(fees.network).minus(fees.service));
}

/** The signed minimum after XRD charges: what they leave the user, rounded down to the bought token's places. Undefined if nothing is left. */
export function minAfterXrdCharges(c: XrdCharges | undefined, places = MAX_PLACES): string | undefined {
  return c ? positivePlain(c.net, places) : undefined;
}

/** Least a market order accepts: `expected` less the slippage allowance (percent), rounded down. */
export function withSlippage(expected: DecIn, slippagePct: number): string | undefined {
  return positivePlain(new Decimal(expected).times(new Decimal(100).minus(String(slippagePct))).div(100));
}

/**
 * The order-book contract's price (tokens bought per token sold) for a price typed as quote per base.
 * A sell is the typed price itself. A buy is its inverse, rounded up at 18 places, which is in the
 * maker's favour (more base for each quote). Refused when 18 places cannot carry the inverse to
 * within `tolerance` (prices above about 10^12 quote per base).
 */
export function bookContractPrice(side: 'buy' | 'sell', price: string, tolerance = '0.000001'): { ok: true; price: string } | { ok: false; reason: string } {
  const p = parsePlain(price);
  if (!p || p.lte(0)) return { ok: false, reason: 'Enter a price' };
  if (side === 'sell') {
    const s = positivePlain(p);
    return s ? { ok: true, price: s } : { ok: false, reason: 'Enter a price' };
  }
  const inv = new Decimal(1).div(p).toDecimalPlaces(MAX_PLACES, Decimal.ROUND_UP);
  // The price the contract will really charge, against the price typed.
  const effective = new Decimal(1).div(inv);
  if (p.minus(effective).div(p).abs().gt(tolerance)) {
    return { ok: false, reason: 'This price is too high for the order book to hold exactly; use a lower-priced unit or a “Whole only” order' };
  }
  return { ok: true, price: inv.toFixed() };
}

/** A number as a plain decimal string (no exponent), for putting a picked price into a field. */
export function numberToPlain(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Decimal(n).toFixed();
}

/** a > b, exactly, for decimal strings; false if either is not a plain decimal. */
export function exceeds(a: string | undefined, b: string | undefined): boolean {
  const x = parsePlain(a ?? undefined), y = parsePlain(b ?? '0') ?? new Decimal(0);
  return Boolean(x && x.gt(y));
}
