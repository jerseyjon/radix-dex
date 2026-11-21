// Small pure helpers for live data: which reply still belongs on screen, retry timing, and
// the header's change figure. Kept free of React so they can be unit-tested.

/** A value tagged with what it was loaded for (a market id, an account address, ...). */
export interface Keyed<T> { key: string; value: T }

/** The value only if it was loaded for `key`; a reply for anything else is never shown. */
export function forKey<T>(s: Keyed<T> | undefined, key: string | undefined): T | undefined {
  return s !== undefined && key !== undefined && s.key === key ? s.value : undefined;
}

/**
 * A guard for one run of an effect: `isCurrent()` turns false for good once `stop()` is called
 * (when the effect's inputs change or the component unmounts). Check it after every await.
 */
export function pollGuard(): { isCurrent: () => boolean; stop: () => void } {
  let live = true;
  return { isCurrent: () => live, stop: () => { live = false; } };
}

/** Wait before retry number `attempt` (0-based): 1 s, 2 s, 4 s ... up to 30 s. */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 20)));
}

export const RESOLUTION_SEC: Record<string, number> = { '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400, '1w': 604_800 };

interface Bar { time: number; open: number; close: number }

/**
 * The change shown in the header. A true 24-hour change (latest close against the last close at or
 * before 24 hours ago) when the candles are fine enough (1 hour or less) and reach back that far;
 * otherwise the change across the loaded candles, labelled with their span so it is not read as 24 h.
 */
export function headerChange(candles: Bar[], resolution: string, nowSec: number): { pct: number; label: string; title: string } | undefined {
  const res = RESOLUTION_SEC[resolution];
  const last = candles[candles.length - 1], first = candles[0];
  if (!last || !first || !res || !(last.close > 0)) return undefined;
  if (res <= 3600) {
    const target = nowSec - 86_400;
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i]!;
      if (c.time + res <= target) {
        if (!(c.close > 0)) break;
        return { pct: (last.close / c.close - 1) * 100, label: '24h', title: 'Change over the last 24 hours, from trade prices' };
      }
    }
  }
  if (!(first.open > 0)) return undefined;
  const span = spanLabel(last.time + res - first.time);
  return { pct: (last.close / first.open - 1) * 100, label: span, title: `Change across the chart's ${span} of ${resolution} candles (not a 24-hour change)` };
}

/** "18h", "12d", "40w" for a duration in seconds. */
export function spanLabel(sec: number): string {
  if (sec < 2 * 86_400) return `${Math.max(1, Math.round(sec / 3600))}h`;
  if (sec < 70 * 86_400) return `${Math.round(sec / 86_400)}d`;
  return `${Math.round(sec / 604_800)}w`;
}
