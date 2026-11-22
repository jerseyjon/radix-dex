// Display formatting. Numbers here are for reading only; anything signed goes through money.ts.
import { parsePlain } from './money';

const VENUE_NAMES: Record<string, string> = {
  ociswap: 'Ociswap',
  defiplaza: 'DefiPlaza',
  // Routed through on a best-effort basis: the project is no longer maintained.
  caviarnine: 'CaviarNine (unmaintained)',
};

/** A venue id as shown to people ("caviarnine" → "CaviarNine (unmaintained)"). Unknown ids, and "orders", are shown as they are. */
export function venueName(id: string): string {
  return Object.hasOwn(VENUE_NAMES, id) ? VENUE_NAMES[id]! : id;
}

/** Price with about five significant digits, however small: 0.00095123 → "0.00095123", 1234.5678 → "1,234.6". */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  // Beyond 18 places a fixed-point figure would read as 0: show the exponent instead.
  if (v < 1e-14) return v.toExponential(4);
  const decimals = Math.min(18, Math.ceil(-Math.log10(v)) + 4);
  return v.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/** The price fmtPrice shows, as a number: for handing a displayed (rounded) price on, e.g. the book's mid to the order form. */
export function shownPrice(v: number | null | undefined): number | undefined {
  if (v == null || !Number.isFinite(v) || v <= 0) return undefined;
  if (v < 1e-14) return Number(v.toPrecision(5));
  const decimals = v >= 1000 ? 1 : v >= 1 ? 4 : Math.min(18, Math.ceil(-Math.log10(v)) + 4);
  const r = Number(v.toFixed(decimals));
  return r > 0 ? r : undefined;
}

/** Decimals a chart axis needs to show about five significant digits of this price (none for large prices). */
export function pricePrecision(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 4;
  if (v >= 10_000) return 0;
  if (v >= 100) return 1;
  return Math.max(2, Math.min(14, Math.ceil(-Math.log10(v)) + 4));
}

/** A chart-axis price with `decimals` places and thousands grouping, so large prices stay readable. */
export function fmtAxisPrice(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const UNITS: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];

/** An amount: grouped below 10,000; K, M, B, T above; four significant digits below 1, never an exponent. */
export function fmtAmount(v: number | string | null | undefined): string {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a === 0) return '0';
  if (a >= 1e4) {
    // Pick the unit after rounding, so 999,999 reads "1.00M" rather than "1000.0K".
    for (const [size, unit] of UNITS) {
      if (Number((a / size).toFixed(2)) >= 1) {
        const scaled = a / size;
        return sign + (unit === 'T' && scaled >= 1000 ? scaled.toLocaleString('en-US', { maximumFractionDigits: 0 }) : scaled.toFixed(2)) + unit;
      }
    }
    const k = Number((a / 1e3).toFixed(1));
    return k >= 1000 ? `${sign}1.00M` : `${sign}${k.toFixed(1)}K`;
  }
  if (a >= 1) return sign + a.toLocaleString('en-US', { maximumFractionDigits: 2 });
  // Fixed point with four significant digits, trailing zeros dropped: 9e-7 → "0.0000009".
  const decimals = Math.min(20, Math.max(0, Math.ceil(-Math.log10(a))) + 3);
  const s = a.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
  return s === '0' ? `${sign}<0.${'0'.repeat(19)}1` : sign + s;
}

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

export function shortAddr(a: string): string {
  return a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

export function fmtTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Trim a user-typed decimal to something the server accepts (positive, at most 18 places), or return undefined. */
export function cleanAmount(s: string): string | undefined {
  const d = parsePlain(s);
  return d && d.gt(0) ? d.toFixed() : undefined;
}
