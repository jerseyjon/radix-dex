import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MarketData } from '../src/marketdata.ts';
import type { Config } from '../src/config.ts';
import {
  C9_HUSDC, C9_LSULP, HUSDC, LSULP, OCI_BASIC_PACKAGE, XRD, addCaviarNinePools, constantProduct, fakeAddress, fakeLedger, net,
} from '../../../packages/core/test/fake-ledger.ts';

const OCI = fakeAddress('component', 'o');
const config = { network: net, minPoolTvlUsd: 300, quotePriority: [HUSDC, XRD] } as unknown as Config;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** The venue APIs: Ociswap lists one XRD/hUSDC basic pool; DefiPlaza is down unless `defiplaza` is true. */
function venueApis(opts: { defiplaza?: boolean } = {}) {
  globalThis.fetch = (async (url: string) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).startsWith('https://api.ociswap.com/pools')) {
      return json(200, { next_cursor: 0, data: [{
        address: OCI, pool_type: 'basic', fee_rate: '0.003', total_value_locked: { usd: { now: '1200' } }, volume: { usd: { '24h': '50' } },
        x: { token: { address: XRD, symbol: 'XRD', name: 'Radix' }, price: { usd: { now: '0.0008' } } },
        y: { token: { address: HUSDC, symbol: 'hUSDC', name: 'USD Coin' }, price: { usd: { now: '1' } } },
      }] });
    }
    if (String(url).startsWith('https://radix.defiplaza.net') && opts.defiplaza) return json(200, { data: [] });
    return json(503, { message: 'unavailable' });
  }) as typeof fetch;
}

function ledgerWithPools() {
  const ledger = fakeLedger();
  addCaviarNinePools(ledger);
  ledger.details.set(OCI, { address: OCI, details: { package_address: OCI_BASIC_PACKAGE, blueprint_name: 'BasicPool', state: {} } });
  ledger.swaps.set(OCI, constantProduct(XRD, 780_000, HUSDC, 684));
  return ledger;
}

test('market list: CaviarNine adds its two pools beside the API venues; one venue down fails nothing else', async () => {
  venueApis();
  const ledger = ledgerWithPools();
  const data = new MarketData(config, ledger.gateway);
  await data.refresh();
  const byId = new Map(data.markets.map((m) => [m.id, m]));
  assert.deepEqual(byId.get(`${XRD}/${HUSDC}`)?.pools.map((p) => p.venue).sort(), ['caviarnine', 'ociswap']);
  // LSULP is traded only on CaviarNine; its symbol comes from the ledger.
  assert.deepEqual(byId.get(`${LSULP}/${XRD}`)?.pools.map((p) => p.address), [C9_LSULP]);
  assert.match(data.lastError ?? '', /radix\.defiplaza\.net/, 'DefiPlaza down is reported');
  // XRD's price from Ociswap values the CaviarNine pools.
  assert.ok((data.pools.find((p) => p.address === C9_HUSDC)?.tvlUsd ?? 0) > 8_000);
});

test('market list: CaviarNine unreadable leaves the other venues listed as before', async () => {
  venueApis({ defiplaza: true });
  const ledger = ledgerWithPools();
  ledger.down.add('/state/entity/details#vault');
  const data = new MarketData(config, ledger.gateway);
  await data.refresh();
  assert.deepEqual(data.markets.map((m) => m.id), [`${XRD}/${HUSDC}`]);
  assert.deepEqual(data.pools.map((p) => p.address), [OCI]);
  assert.match(data.lastError ?? '', /^caviarnine: /);
});

test('market list: with every API venue down the previous list is kept, CaviarNine alone does not replace it', async () => {
  venueApis({ defiplaza: true });
  const ledger = ledgerWithPools();
  const data = new MarketData(config, ledger.gateway);
  await data.refresh();
  const before = data.markets.map((m) => m.id);
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
  await data.refresh();
  assert.deepEqual(data.markets.map((m) => m.id), before);
});

test('depth, quote and trades: CaviarNine failing drops only its own part', async () => {
  venueApis({ defiplaza: true });
  const ledger = ledgerWithPools();
  const data = new MarketData(config, ledger.gateway);
  await data.refresh();
  const market = data.market(`${XRD}/${HUSDC}`)!;
  const swapTx = (pool: string, txid: string) => ({ transaction_status: 'CommittedSuccess', intent_hash: txid, confirmed_at: '2026-11-22T10:00:00.000Z',
    balance_changes: { fungible_balance_changes: [
      { entity_address: pool, resource_address: XRD, balance_change: '1000' }, { entity_address: pool, resource_address: HUSDC, balance_change: '-0.85' },
    ] } });
  ledger.streams.set(OCI, [swapTx(OCI, 'tx_oci')]);
  ledger.streams.set(C9_HUSDC, [swapTx(C9_HUSDC, 'tx_c9')]);

  const both = await data.depth(market);
  assert.ok(both.asks.some((l) => l.source === 'caviarnine') && both.asks.some((l) => l.source === 'ociswap'));
  assert.deepEqual((await data.venueTrades(market)).map((t) => t.venue).sort(), ['caviarnine', 'ociswap']);

  // Now every CaviarNine preview errors and its transaction stream is unreadable.
  ledger.previewDown.add(C9_HUSDC);
  ledger.streams.delete(C9_HUSDC);
  const fresh = new MarketData(config, ledger.gateway);
  fresh.markets = data.markets; fresh.pools = data.pools;
  const origPost = ledger.gateway.post.bind(ledger.gateway);
  ledger.gateway.post = async (path: string, body: any) => {
    if (path === '/stream/transactions' && body?.affected_global_entities_filter?.[0] === C9_HUSDC) throw new Error('stream down');
    return origPost(path, body);
  };
  const depth = await fresh.depth(market);
  assert.ok(depth.asks.length > 0 && depth.bids.length > 0, 'Ociswap levels still there');
  assert.ok(depth.asks.every((l) => l.source === 'ociswap') && depth.bids.every((l) => l.source === 'ociswap'));
  assert.deepEqual((await fresh.venueTrades(market)).map((t) => t.venue), ['ociswap']);
  const q = await fresh.quote(HUSDC, XRD, '100');
  assert.equal(q?.route[0]!.venue, 'ociswap');
});
