// Settings whose defaults depend on the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MIN_BOOK_ORDER_XRD, loadConfig } from '../src/config.ts';

test('smallest book order: 100 XRD on mainnet, 5 on Stokenet, and the setting replaces either', () => {
  assert.equal(loadConfig({}).minBookOrderXrd, 100);
  assert.equal(loadConfig({ DEX_NETWORK: 'mainnet' }).minBookOrderXrd, 100);
  assert.equal(loadConfig({ DEX_NETWORK: 'stokenet' }).minBookOrderXrd, 5);
  assert.deepEqual(DEFAULT_MIN_BOOK_ORDER_XRD, { mainnet: 100, stokenet: 5 });
  assert.equal(loadConfig({ DEX_NETWORK: 'mainnet', DEX_MIN_BOOK_ORDER_XRD: '250' }).minBookOrderXrd, 250);
  assert.equal(loadConfig({ DEX_NETWORK: 'stokenet', DEX_MIN_BOOK_ORDER_XRD: '0.5' }).minBookOrderXrd, 0.5);
  assert.equal(loadConfig({ DEX_NETWORK: 'mainnet', DEX_MIN_BOOK_ORDER_XRD: '0' }).minBookOrderXrd, 0);
  // Empty means "not set": the network's default.
  assert.equal(loadConfig({ DEX_NETWORK: 'mainnet', DEX_MIN_BOOK_ORDER_XRD: '' }).minBookOrderXrd, 100);
  for (const bad of ['-1', 'abc', '1e3', '100 XRD']) assert.throws(() => loadConfig({ DEX_MIN_BOOK_ORDER_XRD: bad }), /DEX_MIN_BOOK_ORDER_XRD/, bad);
});
