/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffMs, forKey, headerChange, pollGuard } from '../src/live.ts';

test('a reply for another market is never shown', () => {
  assert.equal(forKey({ key: 'A', value: 1 }, 'A'), 1);
  assert.equal(forKey({ key: 'A', value: 1 }, 'B'), undefined);
  assert.equal(forKey(undefined, 'A'), undefined);
  assert.equal(forKey({ key: 'A', value: 1 }, undefined), undefined);
});

test('replies that resolve out of order: only the current run writes', async () => {
  // Market A is selected, then B; A's reply arrives after B's.
  let shown: Keyed | undefined;
  type Keyed = { key: string; value: number };
  const delay = (ms: number, v: number) => new Promise<number>((r) => setTimeout(() => r(v), ms));
  const load = async (key: string, ms: number, v: number, g: ReturnType<typeof pollGuard>) => {
    const d = await delay(ms, v);
    if (g.isCurrent()) shown = { key, value: d };
  };
  const ga = pollGuard();
  const a = load('A', 30, 1.2267, ga);
  ga.stop(); // the user switched market
  const gb = pollGuard();
  const b = load('B', 5, 1.0042, gb);
  await Promise.all([a, b]);
  assert.deepEqual(shown, { key: 'B', value: 1.0042 });
  // And even if a stale write got through, the keyed read would hide it.
  assert.equal(forKey({ key: 'A', value: 1.2267 }, 'B'), undefined);
});

test('retry backoff doubles up to a cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map((a) => backoffMs(a)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('header change is a true 24h change when hourly candles reach back far enough', () => {
  const now = 100 * 86_400;
  const hourly = Array.from({ length: 48 }, (_, i) => ({ time: now - (48 - i) * 3600, open: 1 + i, close: 1 + i }));
  const c = headerChange(hourly, '1h', now)!;
  // Last close 48; the candle closing at or before now − 24h closes at 24.
  assert.equal(c.label, '24h');
  assert.equal(c.pct, (48 / 24 - 1) * 100);
});

test('header change on coarse candles is labelled with the span, not as 24h', () => {
  const now = 100 * 86_400;
  const daily = Array.from({ length: 30 }, (_, i) => ({ time: now - (30 - i) * 86_400, open: 2, close: i === 29 ? 3 : 2 }));
  const c = headerChange(daily, '1d', now)!;
  assert.equal(c.label, '30d');
  assert.equal(c.pct, 50);
  assert.match(c.title, /not a 24-hour change/);
  // Hourly candles that start less than a day ago: falls back to the span.
  const short = [{ time: now - 7200, open: 1, close: 1 }, { time: now - 3600, open: 1, close: 2 }];
  assert.equal(headerChange(short, '1h', now)!.label, '2h');
  assert.equal(headerChange([], '1h', now), undefined);
});

test('no trades for over a day means no change', () => {
  const now = 100 * 86_400;
  const old = [{ time: now - 5 * 86_400, open: 1, close: 1 }, { time: now - 3 * 86_400, open: 1, close: 4 }];
  assert.equal(headerChange(old, '1h', now)!.pct, 0);
});
