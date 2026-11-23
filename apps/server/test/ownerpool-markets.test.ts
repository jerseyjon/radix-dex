// OwnerPools are listed by component address only (markets file or DEX_OWNER_POOLS), and each is
// checked on the ledger: an OwnerPool of an allow-listed package, trading the tokens it is listed for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway, NETWORKS, OWNER_POOL_PACKAGES } from '@radix-dex/core';
import { loadConfig } from '../src/config.ts';
import { MarketData } from '../src/marketdata.ts';

const net = NETWORKS.stokenet;
const XRD = net.xrd;
const TEUR = 'resource_tdx_2_1t5m4z5cv7ytwu8uh8d39ltf6rx852rhftlxqcghajh84e882sxknmw';
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const GOOD = 'component_tdx_2_1czcpugh5ga9x6xzz8mtvhatlduhkm7qfnnqkuy5w96vzrv0rk6fj9v';
const LOOKALIKE = 'component_tdx_2_1cpnd6hau0uqju4pjzgdusy8jnk0hlglc9zsclgzsd2ayqywgae3rvp';
const ALLOWED = OWNER_POOL_PACKAGES.stokenet![0]!;
const ROGUE_PACKAGE = 'package_tdx_2_1pkgxxxxxxxxxpackgexxxxxxxxx000726633226xxxxxxxxxxt5ntj';

function gateway() {
  const gw = new Gateway(net, { fetch: async () => { throw new Error('offline'); } });
  const component = (address: string, pkg: string, a: string, b: string) => ({
    address,
    fungible_resources: { items: [{ resource_address: a, amount: '20000' }, { resource_address: b, amount: '16' }] },
    details: { type: 'Component', package_address: pkg, blueprint_name: 'OwnerPool', state: { fields: [
      { field_name: 'resource_a', value: a }, { field_name: 'resource_b', value: b },
      { field_name: 'divisibility_a', value: '18' }, { field_name: 'divisibility_b', value: '6' },
      { field_name: 'fee_bps', value: '30' }, { field_name: 'paused', value: false },
    ] } },
  });
  gw.post = async (path: string, body: any) => {
    if (path !== '/state/entity/details') throw new Error('unexpected ' + path);
    return { ledger_state: { state_version: 1 }, items: body.addresses.map((a: string) =>
      a === GOOD ? component(GOOD, ALLOWED, XRD, TEUR)
        : a === LOOKALIKE ? component(LOOKALIKE, ROGUE_PACKAGE, XRD, TEUR)
          : { address: a, details: { divisibility: a === TEUR ? 6 : 18 }, metadata: { items: [{ key: 'symbol', value: { typed: { value: a === TEUR ? 'TEUR' : '?' } } }] } }) };
  };
  return gw;
}

const file = (pools: unknown[]) => {
  const path = join(mkdtempSync(join(tmpdir(), 'ownerpool-')), 'markets.json');
  writeFileSync(path, JSON.stringify({ tokens: [{ address: XRD, symbol: 'XRD', name: 'Radix' }, { address: TUSD, symbol: 'TUSD', name: '' }], pools }));
  return path;
};
const listing = (address: string, tokens: string[]) => ({ venue: 'ownerpool', address, kind: 'owner', tokens, feeRate: 0, tvlUsd: 25, volume24hUsd: 0, reserves: [0, 0] });

test('a listed OwnerPool is read from the ledger; a look-alike from another package is left out and reported', async () => {
  const config = loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_MARKETS_FILE: file([listing(GOOD, [XRD, TEUR]), listing(LOOKALIKE, [XRD, TEUR])]) });
  const data = new MarketData(config, gateway());
  data.loadDivisibilities = async () => {};
  await data.refresh();
  assert.deepEqual(data.pools.map((p) => p.address), [GOOD]);
  const p = data.pools[0]!;
  assert.equal(p.venue, 'ownerpool');
  assert.deepEqual(p.tokens, [XRD, TEUR]);
  assert.deepEqual(p.reserves, [20000, 16]);
  assert.equal(p.tvlUsd, 25, 'display figures come from the file');
  assert.match(data.lastError ?? '', /component_tdx_2_1cpnd6.* left out: .*not allow-listed/);
  // TEUR was not in the file: its symbol came from the ledger, so the market is listed.
  assert.equal(data.markets.length, 1);
  assert.equal(data.markets[0]!.base.symbol, 'TEUR');
  assert.equal(data.markets[0]!.quote.address, XRD);
});

test('a file entry naming other tokens than the ledger is refused', async () => {
  const config = loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_MARKETS_FILE: file([listing(GOOD, [XRD, TUSD])]) });
  const data = new MarketData(config, gateway());
  data.loadDivisibilities = async () => {};
  await data.refresh();
  assert.equal(data.pools.length, 0);
  assert.match(data.lastError ?? '', /other tokens than the ledger/);
});

test('DEX_OWNER_POOLS lists OwnerPools by component address, checked the same way', async () => {
  assert.throws(() => loadConfig({ DEX_NETWORK: 'stokenet', DEX_OWNER_POOLS: 'resource_tdx_2_1t5m4z5cv7ytwu8uh8d39ltf6rx852rhftlxqcghajh84e882sxknmw' }), /not a component address/);
  assert.throws(() => loadConfig({ DEX_NETWORK: 'mainnet', DEX_OWNER_POOLS: GOOD }), /not a component address on this network/);
  const config = loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_OWNER_POOLS: `${GOOD}, ${LOOKALIKE}` });
  assert.deepEqual(config.ownerPools, [GOOD, LOOKALIKE]);
  const data = new MarketData(config, gateway());
  data.loadDivisibilities = async () => {};
  await data.refresh();
  assert.deepEqual(data.pools.map((p) => p.address), [GOOD]);
  // Exactly the owner's package published 23 Nov 2026 is allow-listed on mainnet.
  assert.deepEqual(OWNER_POOL_PACKAGES.mainnet, ['package_rdx1p4k62xfkcakva7wmll67zgc8udn6tsujzfs9hqq399hdzujtksdlsv']);
});
