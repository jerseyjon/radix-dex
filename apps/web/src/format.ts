/** Price with about five significant digits, however small: 0.00095123 → "0.00095123", 1234.5678 → "1,234.6". */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const decimals = Math.min(18, Math.ceil(-Math.log10(v)) + 4);
  return v.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/** Number of decimals a chart axis needs to show ~5 significant digits of this price. */
export function pricePrecision(v: number): number {
  if (!(v > 0)) return 4;
  return Math.max(2, Math.min(14, Math.ceil(-Math.log10(v)) + 4));
}

export function fmtAmount(v: number | string | null | undefined): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  if (a >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a === 0) return '0';
  return n.toPrecision(4).replace(/\.?0+$/, '');
}

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '—';
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

/** Trim a user-typed decimal to something the server accepts, or return undefined. */
export function cleanAmount(s: string): string | undefined {
  const t = s.trim().replace(/,/g, '');
  if (!/^\d{1,30}(\.\d{0,18})?$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 ? t.replace(/\.$/, '') : undefined;
}

/** Decimal string from a number without exponent notation, at most 18 places, rounded down. */
export function toPlain(n: number, places = 18): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const p = Math.max(0, Math.min(places, 18));
  const factor = 10 ** Math.min(p, 12);
  const floored = Math.floor(n * factor) / factor;
  return floored.toFixed(Math.min(p, 12)).replace(/\.?0+$/, '') || '0';
}
