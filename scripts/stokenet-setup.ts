// One-off, repeatable set-up of a test deployment on Stokenet with throwaway keys:
// publishes the contracts, creates the order registry and an XRD/TUSD pool with liquidity,
// creates a dApp definition account, and writes the server's market file.
// Usage: tsx scripts/stokenet-setup.ts [site-origin ...]
// Needs data/contracts/dex_contracts.{wasm,rpd} (see scrypto/run.sh) and data/stokenet-keys.json (stokenet-e2e.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { ManifestSborStringRepresentation, RadixEngineToolkit } from '@steleaio/radix-engine-toolkit';
import { Gateway, NETWORKS, accountOf, addr, buildTransaction, keyFromHex, submitAndWait, toHex, type Ed25519Key } from '../packages/core/src/index.ts';

const net = NETWORKS.stokenet;
const gw = new Gateway(net);
const STATE = 'data/stokenet-keys.json';
const state: Record<string, string> = JSON.parse(readFileSync(STATE, 'utf8'));
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
const origins = process.argv.slice(2).length ? process.argv.slice(2) : ['http://localhost:8788'];

const solverKey = keyFromHex(state.solver!);
const solver = await accountOf(solverKey, net.networkId);
const faucet = (await RadixEngineToolkit.Utils.knownAddresses(net.networkId)).componentAddresses.faucet;

async function run(label: string, manifest: string, notary: Ed25519Key, blobs?: Uint8Array[]) {
  const { epoch } = await gw.status();
  const tx = await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary, blobs });
  const out = await submitAndWait(gw, tx, 90_000);
  console.log(label + ': ' + out.status + ('error' in out ? ' — ' + out.error.slice(0, 300) : '') + '  ' + tx.intentHashId);
  if (out.status !== 'CommittedSuccess') throw new Error(label + ' failed');
  const j = await gw.post('/transaction/committed-details', { intent_hash: tx.intentHashId, opt_ins: { receipt_state_changes: true } });
  const created: string[] = (j.transaction?.receipt?.state_updates?.new_global_entities ?? []).map((e: any) => String(e.entity_address));
  return { created, find: (prefix: string) => created.find((a) => a.startsWith(prefix)) };
}
const need = (v: string | undefined, what: string): string => { if (!v) throw new Error('Missing ' + what); return v; };
const lockFee = (account: string, amount = 30) => 'CALL_METHOD ' + addr(account) + ' "lock_fee" Decimal("' + amount + '");';

// 1. Publish the package.
if (!state.package) {
  const wasm = new Uint8Array(readFileSync('data/contracts/dex_contracts.wasm'));
  const rpd = new Uint8Array(readFileSync('data/contracts/dex_contracts.rpd'));
  const definition = await RadixEngineToolkit.ManifestSbor.decodeToString(rpd, net.networkId, ManifestSborStringRepresentation.ManifestString);
  const codeHash = toHex(blake2b(wasm, { dkLen: 32 }));
  const r = await run('publish package', [
    lockFee(solver, 200),
    'PUBLISH_PACKAGE_ADVANCED Enum<OwnerRole::None>() ' + definition + ' Blob("' + codeHash + '") Map<String, Tuple>() None;',
  ].join('\n'), solverKey, [wasm]);
  state.package = need(r.find('package_'), 'package address');
  save();
}

// 2. Order registry.
if (!state.registry) {
  const r = await run('instantiate registry', [lockFee(solver), 'CALL_FUNCTION ' + addr(state.package!) + ' "OrderRegistry" "instantiate";'].join('\n'), solverKey);
  state.registry = need(r.find('component_'), 'registry address');
  save();
}

// 3. XRD/TUSD pool with liquidity. The solver badge doubles as the pool's owner badge.
if (!state.pool) {
  const r = await run('instantiate pool', [
    lockFee(solver),
    'CALL_FUNCTION ' + addr(state.package!) + ' "Pool" "instantiate" ' + addr(net.xrd) + ' ' + addr(state.tusd!) + ' 30u16 10u16 ' + addr(state.badge!) + ';',
  ].join('\n'), solverKey);
  state.pool = need(r.find('component_'), 'pool address');
  state.poolUnits = need(r.find('resource_'), 'pool unit address');
  save();
}
if (!state.poolFunded) {
  // The faucet hands out 10,000 XRD a time; take three lots so the pool can hold 25,000.
  for (let i = 0; i < 3; i++) {
    await run('faucet ' + (i + 1), [
      'CALL_METHOD ' + addr(faucet) + ' "lock_fee" Decimal("10");',
      'CALL_METHOD ' + addr(faucet) + ' "free";',
      'CALL_METHOD ' + addr(solver) + ' "deposit_batch" Expression("ENTIRE_WORKTOP");',
    ].join('\n'), solverKey);
  }
  await run('add liquidity', [
    lockFee(solver),
    'CALL_METHOD ' + addr(solver) + ' "withdraw" ' + addr(net.xrd) + ' Decimal("25000");',
    'CALL_METHOD ' + addr(solver) + ' "withdraw" ' + addr(state.tusd!) + ' Decimal("2500");',
    'TAKE_ALL_FROM_WORKTOP ' + addr(net.xrd) + ' Bucket("a");',
    'TAKE_ALL_FROM_WORKTOP ' + addr(state.tusd!) + ' Bucket("b");',
    'CALL_METHOD ' + addr(state.pool!) + ' "add_liquidity" Bucket("a") Bucket("b");',
    'CALL_METHOD ' + addr(solver) + ' "deposit_batch" Expression("ENTIRE_WORKTOP");',
  ].join('\n'), solverKey);
  state.poolFunded = 'yes';
  save();
}

// 3b. Order book (resting orders with partial fills). The first package cannot be changed, so
// the current build is published as a second package and the order book made from that.
if (!state.orderBookPackage) {
  const wasm = new Uint8Array(readFileSync('data/contracts/dex_contracts.wasm'));
  const rpd = new Uint8Array(readFileSync('data/contracts/dex_contracts.rpd'));
  const definition = await RadixEngineToolkit.ManifestSbor.decodeToString(rpd, net.networkId, ManifestSborStringRepresentation.ManifestString);
  const r = await run('publish order book package', [
    lockFee(solver, 300),
    'PUBLISH_PACKAGE_ADVANCED Enum<OwnerRole::None>() ' + definition + ' Blob("' + toHex(blake2b(wasm, { dkLen: 32 })) + '") Map<String, Tuple>() None;',
  ].join('\n'), solverKey, [wasm]);
  state.orderBookPackage = need(r.find('package_'), 'order book package address');
  save();
}
if (!state.orderBook) {
  // Maker fee 0: the solver badge is the owner and may change it for future orders, up to 1%.
  const r = await run('instantiate order book', [
    lockFee(solver),
    'CALL_FUNCTION ' + addr(state.orderBookPackage!) + ' "OrderBook" "instantiate" 0u16 ' + addr(state.badge!) + ';',
  ].join('\n'), solverKey);
  state.orderBook = need(r.find('component_'), 'order book address');
  state.orderReceipts = need(r.find('resource_'), 'order receipt address');
  save();
}

// 4. Give the test token a name and symbol so the wallet shows something readable.
if (!state.tusdNamed) {
  // TUSD was created with no owner, so its metadata cannot be set. Record that and move on.
  state.tusdNamed = 'no-owner';
  save();
}

// 5. dApp definition account: what the Radix Wallet checks a site against.
if (!state.dapp) { state.dapp = randomBytes(32).toString('hex'); save(); }
const dappKey = keyFromHex(state.dapp);
const dapp = await accountOf(dappKey, net.networkId);
const wantOrigins = origins.join(',');
if (state.dappOrigins !== wantOrigins) {
  const str = (v: string) => 'Enum<Metadata::String>("' + v + '")';
  await run('dApp definition', [
    'CALL_METHOD ' + addr(faucet) + ' "lock_fee" Decimal("10");',
    'SET_METADATA ' + addr(dapp) + ' "account_type" ' + str('dapp definition') + ';',
    'SET_METADATA ' + addr(dapp) + ' "name" ' + str('Radix DEX (Stokenet test)') + ';',
    'SET_METADATA ' + addr(dapp) + ' "description" ' + str('Test deployment of radix-dex. Stokenet only; tokens have no value.') + ';',
    'SET_METADATA ' + addr(dapp) + ' "claimed_websites" Enum<Metadata::OriginArray>(Array<String>(' + origins.map((o) => '"' + o + '"').join(', ') + '));',
  ].join('\n'), dappKey);
  state.dappOrigins = wantOrigins;
  state.dappDefinition = dapp;
  save();
}

// 6. Market file for the server.
const [poolDetails] = await gw.entityDetails([state.pool!]);
const reserve = (resource: string) => Number(poolDetails?.fungible_resources?.items?.find((i: any) => i.resource_address === resource)?.amount ?? 0);
const markets = {
  quotePriority: [state.tusd],
  tokens: [
    { address: net.xrd, symbol: 'XRD', name: 'Radix (Stokenet)' },
    { address: state.tusd, symbol: 'TUSD', name: 'Test dollar' },
  ],
  pools: [{
    venue: 'radixdex', address: state.pool, kind: 'pool', tokens: [net.xrd, state.tusd], feeRate: 0.004,
    tvlUsd: reserve(state.tusd!) * 2, volume24hUsd: 0, reserves: [reserve(net.xrd), reserve(state.tusd!)],
  }],
};
writeFileSync('data/stokenet-markets.json', JSON.stringify(markets, null, 2));
writeFileSync('data/stokenet-solver.key', state.solver!, { mode: 0o600 });

console.log(JSON.stringify({
  package: state.package, registry: state.registry, orderBook: state.orderBook, orderReceipts: state.orderReceipts, pool: state.pool, poolUnits: state.poolUnits,
  solverAccount: solver, solverBadge: state.badge, tusd: state.tusd, dAppDefinition: dapp, origins,
  poolReserves: { xrd: reserve(net.xrd), tusd: reserve(state.tusd!) },
}, null, 2));
