/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHOW_ALL_KEY, filterMarkets, matchesMarket, nextActive, readShowAll, topMarkets, visibleMarkets, writeShowAll } from '../src/marketlist.ts';

const tok = (symbol: string, name?: string) => ({ address: `res_${symbol}`, symbol, name: name ?? symbol }) as never;
const mk = (id: string, base: string, quote: string, tvlUsd: number, name?: string) => ({ id, base: tok(base, name), quote: tok(quote), tvlUsd });
// In the server's order (liquidity, high to low), with zero-liquidity markets appended at the end.
const MARKETS = Array.from({ length: 20 }, (_, i) => mk(`m${i}`, `T${i}`, 'XRD', 2000 - i * 100))
  .concat([mk('xh', 'XRD', 'hUSDC', 0, 'Radix'), mk('oci', 'OCI', 'XRD', 0, 'Ociswap')]);
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

test('topMarkets: the n deepest, in the order given', () => {
  assert.deepEqual(ids(topMarkets(MARKETS, 3)), ['m0', 'm1', 'm2']);
  // Order of the input is kept, not re-sorted.
  const shuffled = [MARKETS[2]!, MARKETS[0]!, MARKETS[1]!, MARKETS[5]!];
  assert.deepEqual(ids(topMarkets(shuffled, 2)), ['m0', 'm1']);
  assert.deepEqual(ids(topMarkets([MARKETS[2]!, MARKETS[0]!, MARKETS[1]!], 2)), ['m0', 'm1']);
});

test('topMarkets: keeps the selected market when it is not in the top n', () => {
  const top = topMarkets(MARKETS, 15, 'xh');
  assert.equal(top.length, 16);
  assert.deepEqual(ids(top).slice(0, 15), ids(MARKETS.slice(0, 15)));
  assert.equal(top[15]!.id, 'xh');
  // Already in the top n: not added twice.
  assert.equal(topMarkets(MARKETS, 15, 'm3').length, 15);
  // Unknown or missing selection: nothing added.
  assert.equal(topMarkets(MARKETS, 15, 'nope').length, 15);
  assert.equal(topMarkets(MARKETS, 15).length, 15);
});

test('topMarkets: ties keep the earlier market; fewer markets than n', () => {
  const tied = [mk('a', 'A', 'XRD', 5), mk('b', 'B', 'XRD', 5), mk('c', 'C', 'XRD', 5)];
  assert.deepEqual(ids(topMarkets(tied, 2)), ['a', 'b']);
  assert.deepEqual(ids(topMarkets(tied, 15)), ['a', 'b', 'c']);
  assert.deepEqual(topMarkets([], 15, 'x'), []);
});

test('search: pair symbols and base name, case-insensitive, trimmed', () => {
  assert.ok(matchesMarket(MARKETS[20]!, 'xrd/husdc'));
  assert.ok(matchesMarket(MARKETS[20]!, '  HUSD '));
  assert.ok(matchesMarket(MARKETS[21]!, 'ociswap'));
  assert.ok(!matchesMarket(MARKETS[21]!, 'husdc'));
  assert.ok(matchesMarket(MARKETS[21]!, ''));
  assert.deepEqual(ids(filterMarkets(MARKETS, 'oci')), ['oci']);
  assert.equal(filterMarkets(MARKETS, '  ').length, MARKETS.length);
});

test('visibleMarkets: short list, show all, and search over every market', () => {
  const short = visibleMarkets(MARKETS, { query: '', showAll: false, selected: 'm0' });
  assert.equal(short.rows.length, 15);
  assert.equal(short.hidden, MARKETS.length - 15);
  const withSel = visibleMarkets(MARKETS, { query: '', showAll: false, selected: 'oci' });
  assert.equal(withSel.rows.length, 16);
  assert.equal(withSel.hidden, MARKETS.length - 16);
  const all = visibleMarkets(MARKETS, { query: '', showAll: true, selected: 'm0' });
  assert.equal(all.rows.length, MARKETS.length);
  assert.equal(all.hidden, MARKETS.length - 15);
  // A search reaches markets outside the top 15 even with the short list on.
  const hit = visibleMarkets(MARKETS, { query: 'T19', showAll: false, selected: 'm0' });
  assert.deepEqual(ids(hit.rows), ['m19']);
  assert.equal(hit.hidden, 0);
  // Small market sets: nothing hidden.
  assert.equal(visibleMarkets(MARKETS.slice(0, 4), { query: '', showAll: false }).hidden, 0);
});

test('show-all preference: stored as 1/0, and storage errors are harmless', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(readShowAll(store), false);
  writeShowAll(store, true);
  assert.equal(m.get(SHOW_ALL_KEY), '1');
  assert.equal(readShowAll(store), true);
  writeShowAll(store, false);
  assert.equal(readShowAll(store), false);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readShowAll(broken), false);
  assert.doesNotThrow(() => writeShowAll(broken, true));
  assert.equal(readShowAll(undefined), false);
});

test('nextActive: arrows clamp at the ends, start from nothing, ignore other keys', () => {
  assert.equal(nextActive('ArrowDown', -1, 5), 0);
  assert.equal(nextActive('ArrowUp', -1, 5), 4);
  assert.equal(nextActive('ArrowDown', 4, 5), 4);
  assert.equal(nextActive('ArrowUp', 0, 5), 0);
  assert.equal(nextActive('ArrowDown', 1, 5), 2);
  assert.equal(nextActive('PageDown', 0, 20), 8);
  assert.equal(nextActive('PageUp', 3, 20), 0);
  assert.equal(nextActive('Home', 3, 5), undefined);
  assert.equal(nextActive('a', 3, 5), undefined);
  assert.equal(nextActive('ArrowDown', 0, 0), undefined);
});
