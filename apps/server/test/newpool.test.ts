// A new pool from the Pools page and the discovery of the owner's pools: the planner's guards (the same
// as scripts/mainnet-owner-pool.ts `instantiate`), discovery's resistance to spoofed pools, and the API
// end to end against a fake Gateway (offline). Nothing is sent anywhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Gateway, OwnerPoolDiscovery, createdComponents, judgeDiscoveredPool, ownerPoolInstantiateManifest } from '@radix-dex/core';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { NewPoolError, createdPool, newPoolPackage, planNewPool, probeMid, seedPriceText, type NewPoolInput, type NewPoolToken } from '../src/newpool.ts';
import { OWNER, OWNER_BADGE, PACKAGE, POOL, TEUR, XRD, net, poolItem } from './pool-fixture.ts';

const ATTACKER_BADGE = 'resource_tdx_2_1tks7440zgkkj5f4u6pu64qk79uau8z3v0kwzd7hs22w3vftfhx0mg2';
const OTHER_PACKAGE = 'package_tdx_2_1p4tzj0gfzh8uzr9ca4y26jrwrevgu8uur7aukzmj3050vmp4y4vrzw';
const NEW_POOL = 'component_tdx_2_1czageep5dckrewazzkt4za3gc5tvzak6ehl20x349fuhl7u58krsh0';
const SPOOF = 'component_tdx_2_1czcpugh5ga9x6xzz8mtvhatlduhkm7qfnnqkuy5w96vzrv0rk6fj9v';
const FOREIGN_PKG_POOL = 'component_tdx_2_1cpnd6hau0uqju4pjzgdusy8jnk0hlglc9zsclgzsd2ayqywgae3rvp';
const NOT_A_POOL = 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qx';
const STRANGER = 'account_tdx_2_128x3s0xqj8nj55st5s38mjfsfcc2ddyejcq2vjwuctwugy3ukwcj22';
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const RECALLABLE = 'resource_tdx_2_1t5m4z5cv7ytwu8uh8d39ltf6rx852rhftlxqcghajh84e882sxknmw';

// ------------------------------------------------------------------ tokens as the Gateway shows them
type Rule = 'DenyAll' | 'AllowAll' | 'Protected';
const entry = (name: string, rule: Rule) => ({ role_key: { module: 'Main', name }, assignment: { resolution: 'Explicit', explicit_rule: { type: rule } } });
const LOCKED: Record<string, Rule> = {
  burner: 'DenyAll', minter: 'DenyAll', freezer: 'DenyAll', recaller: 'DenyAll', depositor: 'AllowAll', withdrawer: 'AllowAll',
  burner_updater: 'DenyAll', minter_updater: 'DenyAll', freezer_updater: 'DenyAll', recaller_updater: 'DenyAll', depositor_updater: 'DenyAll', withdrawer_updater: 'DenyAll',
};
function resourceItem(address: string, symbol: string, divisibility: number, roles: Record<string, Rule>) {
  return {
    address, metadata: { items: [{ key: 'symbol', value: { typed: { value: symbol } } }, { key: 'name', value: { typed: { value: `${symbol} token` } } }] },
    details: { type: 'FungibleResource', divisibility, total_supply: '1000000', role_assignments: { owner: { rule: { type: 'DenyAll' }, updater: 'None' }, entries: Object.entries(roles).map(([n, r]) => entry(n, r)) } },
  };
}
const RESOURCES: Record<string, any> = {
  [XRD]: resourceItem(XRD, 'XRD', 18, { ...LOCKED, minter: 'Protected', burner: 'Protected' }),
  [TEUR]: resourceItem(TEUR, 'TEUR', 6, LOCKED),
  [TUSD]: resourceItem(TUSD, 'TUSD', 6, { ...LOCKED, minter: 'Protected' }),
  [RECALLABLE]: resourceItem(RECALLABLE, 'BAD', 6, { ...LOCKED, recaller: 'Protected' }),
};

const tok = (address: string, symbol: string, divisibility: number, warnings: string[] = [], errors: string[] = []): NewPoolToken => ({ address, symbol, divisibility, warnings, errors });
const base = (over: Partial<NewPoolInput> = {}): NewPoolInput => ({
  owner: { account: OWNER, badge: OWNER_BADGE }, package: PACKAGE, packages: [PACKAGE], tokenA: tok(XRD, 'XRD', 18), tokenB: tok(TEUR, 'TEUR', 6),
  params: { amountA: '2000', amountB: '1.6', feeBps: 50 }, botPairs: ['XRD/hUSDC'], ...over,
});

// ------------------------------------------------------------------ the planner's guards

test('planNewPool: at the market, the script\'s own builder makes the manifest: one transaction, no fee lock, the owner badge proved', () => {
  const plan = planNewPool(base({ market: { price: 0.000801, source: 'test venues' } }));
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.manifest, ownerPoolInstantiateManifest({ owner: { account: OWNER, badge: OWNER_BADGE }, package: PACKAGE, resourceA: XRD, resourceB: TEUR, amountA: '2000', amountB: '1.6', feeBps: 50 }));
  assert.match(plan.manifest!, /"instantiate_with_liquidity"/);
  assert.match(plan.manifest!, /"create_proof_of_amount" Address\("resource_tdx_2_1tkzuv/);
  assert.doesNotMatch(plan.manifest!, /lock_fee/, 'the wallet adds its own fee lock');
  assert.equal(plan.seedPrice, '0.0008');
  assert.deepEqual(plan.want, { resources: [XRD, TEUR], reserves: ['2000', '1.6'], inventory: ['0', '0'], feeBps: 50, ownerPaused: false, operatorPaused: false, operator: null, ownerBadge: OWNER_BADGE });
  assert.ok(plan.notes.some((n) => /gap 0\.125%/.test(n)));
  assert.ok(plan.notes.some((n) => /bot manages only XRD\/hUSDC/.test(n)), 'says a new pair runs as a plain pool');
});

test('planNewPool: a seed price more than 1% from the market is refused outright', () => {
  assert.throws(() => planNewPool(base({ market: { price: 0.00082, source: 'test venues' } })), (e: Error) => e instanceof NewPoolError && /2\.5\d\d%.*Refused/.test(e.message));
  // Just inside 1% is allowed (the script's --max-gap is inclusive).
  assert.equal(planNewPool(base({ market: { price: 0.0008 * 1.0099, source: 't' } })).blocked.length, 0);
});

test('planNewPool: no market means the owner must confirm the exact price stated; a different one does not do', () => {
  const blocked = planNewPool(base({ noMarketReason: 'no route' }));
  assert.equal(blocked.manifest, null);
  assert.deepEqual(blocked.needs, ['price']);
  assert.match(blocked.blocked[0]!, /1 XRD = 0\.0008 TEUR/);
  assert.equal(planNewPool(base({ params: { amountA: '2000', amountB: '1.6', feeBps: 50, confirmPrice: '0.0009' } })).manifest, null);
  const ok = planNewPool(base({ params: { amountA: '2000', amountB: '1.6', feeBps: 50, confirmPrice: '0.0008' } }));
  assert.ok(ok.manifest);
  assert.ok(ok.notes.some((n) => /confirmed the seed price/.test(n)));
});

test('planNewPool: an issuer\'s minter or burner needs the owner to accept it; a recaller or freezer is refused', () => {
  const p = base({ tokenB: tok(TUSD, 'TUSD', 6, ['minter is held by someone (Protected)']), market: { price: 0.0008, source: 't' } });
  const blocked = planNewPool(p);
  assert.equal(blocked.manifest, null);
  assert.deepEqual(blocked.needs, ['issuer-risk']);
  assert.match(blocked.warnings.join(), /TUSD: minter is held/);
  assert.ok(planNewPool({ ...p, params: { ...p.params, acceptIssuerRisk: true } }).manifest);
  assert.throws(() => planNewPool(base({ tokenB: tok(RECALLABLE, 'BAD', 6, [], ['recaller is held or can be assigned']) })), /BAD .* refused as a pool token: recaller/);
});

test('planNewPool: bad input is refused before anything is built', () => {
  const bad = (params: Record<string, unknown>, re: RegExp, over: Partial<NewPoolInput> = {}) => assert.throws(() => planNewPool(base({ params, ...over })), (e: Error) => e instanceof NewPoolError && re.test(e.message));
  bad({ amountA: '2000', amountB: '1.6', feeBps: 501 }, /fee must be a whole number/);
  bad({ amountA: '2000', amountB: '1.6', feeBps: 1.5 }, /fee must be a whole number/);
  bad({ amountA: '2000', amountB: '1.6000001', feeBps: 50 }, /more than 6 decimal places/);
  bad({ amountA: '0', amountB: '1', feeBps: 50 }, /more than zero/);
  bad({ amountA: '-1', amountB: '1', feeBps: 50 }, /plain decimal/);
  bad({ amountA: '1e3', amountB: '1', feeBps: 50 }, /plain decimal/);
  bad({ amountB: '1', feeBps: 50 }, /XRD is required/);
  bad({ amountA: '1', amountB: '1', feeBps: 50 }, /must differ/, { tokenB: tok(XRD, 'XRD', 18) });
  bad({ amountA: '1', amountB: '1', feeBps: 50 }, /owner badge cannot be one of the pool's tokens/, { tokenB: tok(OWNER_BADGE, 'BADGE', 0) });
  bad({ amountA: '1', amountB: '1', feeBps: 50 }, /not allow-listed/, { package: OTHER_PACKAGE });
});

test('probeMid, seedPriceText, newPoolPackage, createdPool', () => {
  const m = probeMid({ sellA: '10', getB: '0.0099', sellB: '0.01', getA: '9.9' });
  assert.ok('price' in m && Math.abs(m.price - 0.001) < 1e-12 && m.spread > 0.02 && m.spread < 0.021);
  assert.match((probeMid({ sellA: '10', getB: '0.009', sellB: '0.01', getA: '9' }) as any).reason, /spread is 23\.\d\d%/);
  assert.match((probeMid({ sellA: '10', getB: '0', sellB: '0.01', getA: '9' }) as any).reason, /no usable quote/);
  assert.equal(seedPriceText('3', '1'), '0.3333333333');
  assert.equal(newPoolPackage(['a', 'b']), 'b');
  assert.equal(newPoolPackage([]), undefined);
  assert.equal(createdPool(['account_x', NEW_POOL]), NEW_POOL);
  assert.equal(createdPool([NEW_POOL, SPOOF]), undefined, 'one pool per instantiate, or nothing is claimed');
});

// ------------------------------------------------------------------ discovery and spoofing

test('judgeDiscoveredPool: only an OwnerPool of an allow-listed package whose own state names a configured owner badge', () => {
  const o = { packages: [PACKAGE], badges: [OWNER_BADGE] };
  assert.equal(judgeDiscoveredPool(poolItem({ address: NEW_POOL }), o).accepted, true);
  // Anyone can instantiate the public package with THEIR OWN badge: refused.
  const spoof = judgeDiscoveredPool(poolItem({ address: SPOOF, ownerBadge: ATTACKER_BADGE }), o);
  assert.equal(spoof.accepted, false);
  assert.match((spoof as any).reason, /owned by resource_tdx_2_1tks7440/);
  // Our badge in the state, but another package (a look-alike blueprint): refused.
  assert.match((judgeDiscoveredPool(poolItem({ address: FOREIGN_PKG_POOL, packageAddress: OTHER_PACKAGE }), o) as any).reason, /not allow-listed/);
  // Something else altogether: refused.
  assert.match((judgeDiscoveredPool(poolItem({ address: NOT_A_POOL, blueprint: 'Radiswap' }), o) as any).reason, /not an OwnerPool/);
  // A pre-split OwnerPool (no owner badge field): refused.
  const old = poolItem({ address: NEW_POOL });
  old.details.state.fields = old.details.state.fields.filter((f: any) => !['inventory_a', 'inventory_b', 'owner_badge', 'operator_paused', 'operator', 'limits', 'allowance', 'allowance_epoch', 'anchor'].includes(f.field_name));
  for (const r of old.fungible_resources.items) r.vaults.items = r.vaults.items.filter((v: any) => !/tqkpyngpeq|tqhju6gnwz/.test(v.vault_address));
  assert.match((judgeDiscoveredPool(old, o) as any).reason, /no owner badge/);
  assert.match((judgeDiscoveredPool(poolItem(), { packages: [], badges: [OWNER_BADGE] }) as any).reason, /no allow-listed/);
});

test('createdComponents: only components, only from committed successes', () => {
  const items = [
    { transaction_status: 'CommittedSuccess', receipt: { state_updates: { new_global_entities: [{ entity_address: NEW_POOL }, { entity_address: 'resource_tdx_2_1xyz' }, { entity_address: STRANGER }] } } },
    { transaction_status: 'CommittedFailure', receipt: { state_updates: { new_global_entities: [{ entity_address: SPOOF }] } } },
  ];
  assert.deepEqual(createdComponents(items), [NEW_POOL]);
});

/** A fake Gateway for discovery: a stream of badge-presenting transactions and the components they created. */
function discoveryGateway(stream: { sv: number; created: string[] }[], items: Record<string, any>) {
  const calls: { path: string; body: any }[] = [];
  const gw = new Gateway(net);
  gw.post = async (path: string, body: any) => {
    calls.push({ path, body });
    if (path === '/stream/transactions') {
      const from = body.from_ledger_state?.state_version ?? 0;
      const all = stream.filter((t) => t.sv >= from);
      const start = body.cursor ? Number(body.cursor) : 0;
      const page = all.slice(start, start + 2);
      return { items: page.map((t) => ({ transaction_status: 'CommittedSuccess', state_version: t.sv, receipt: { state_updates: { new_global_entities: t.created.map((a) => ({ entity_address: a })) } } })), next_cursor: start + 2 < all.length ? String(start + 2) : null };
    }
    if (path === '/state/entity/details') return { ledger_state: { state_version: 500 }, items: body.addresses.filter((a: string) => items[a]).map((a: string) => items[a]) };
    throw new Error('unexpected ' + path);
  };
  return { gw, calls };
}

test('OwnerPoolDiscovery: lists our pool, never a spoof; reads incrementally; remembers verdicts; retries a missing read', async () => {
  const stream = [
    { sv: 10, created: [NEW_POOL] },
    { sv: 11, created: [] }, // a pause: nothing created
    { sv: 12, created: [SPOOF, FOREIGN_PKG_POOL] }, // cannot happen on ledger (the badge is proved), and refused anyway
    { sv: 13, created: [NOT_A_POOL] },
  ];
  const items: Record<string, any> = {
    [NEW_POOL]: poolItem({ address: NEW_POOL }),
    [SPOOF]: poolItem({ address: SPOOF, ownerBadge: ATTACKER_BADGE }),
    [FOREIGN_PKG_POOL]: poolItem({ address: FOREIGN_PKG_POOL, packageAddress: OTHER_PACKAGE }),
  };
  const { gw, calls } = discoveryGateway(stream, items);
  const d = new OwnerPoolDiscovery(gw, { badges: [OWNER_BADGE], packages: [PACKAGE] });
  assert.equal(d.enabled, true);
  await d.refresh();
  assert.equal(d.lastError, undefined);
  assert.deepEqual(d.addresses(), [NEW_POOL]);
  const streamCalls = calls.filter((c) => c.path === '/stream/transactions');
  assert.equal(streamCalls.length, 2, 'two pages');
  assert.deepEqual(streamCalls[0]!.body.manifest_badges_presented_filter, [OWNER_BADGE]);
  assert.equal(streamCalls[0]!.body.opt_ins.receipt_state_changes, true);
  assert.deepEqual(d.verdicts().rejected.map((r) => r.address).sort(), [SPOOF, FOREIGN_PKG_POOL].sort());
  // NOT_A_POOL got no answer from the Gateway: tried again next time, not remembered as refused.
  items[NOT_A_POOL] = poolItem({ address: NOT_A_POOL, blueprint: 'Radiswap' });
  stream.push({ sv: 20, created: [NEW_POOL] });
  calls.length = 0;
  await d.refresh();
  const s2 = calls.find((c) => c.path === '/stream/transactions')!;
  assert.deepEqual(s2.body.from_ledger_state, { state_version: 14 }, 'reads only what is new');
  const judged = calls.filter((c) => c.path === '/state/entity/details').flatMap((c) => c.body.addresses);
  assert.deepEqual(judged, [NOT_A_POOL], 'a known verdict is not read again');
  assert.deepEqual(d.addresses(), [NEW_POOL]);
  assert.equal(d.verdicts().rejected.length, 3);
});

test('OwnerPoolDiscovery: off without badges; a Gateway failure is kept as lastError and never thrown', async () => {
  const { gw, calls } = discoveryGateway([], {});
  const off = new OwnerPoolDiscovery(gw, { badges: [], packages: [PACKAGE] });
  await off.refresh();
  assert.equal(calls.length, 0);
  const broken = new Gateway(net);
  broken.post = async () => { throw new Error('Gateway down'); };
  const d = new OwnerPoolDiscovery(broken, { badges: [OWNER_BADGE], packages: [PACKAGE] });
  await d.refresh();
  assert.match(d.lastError ?? '', /Gateway down/);
  assert.deepEqual(d.addresses(), []);
});

test('config: DEX_POOL_OWNER_BADGES defaults to the DIFD pools owner badge on mainnet only; empty turns discovery off', () => {
  assert.deepEqual(loadConfig({ DEX_NETWORK: 'mainnet' }).poolOwnerBadges, ['resource_rdx1th7yck078twm9znh2kmcn68axgylpp6ctnxwl5rkpmjj636cfzda6m']);
  assert.deepEqual(loadConfig({ DEX_NETWORK: 'mainnet', DEX_POOL_OWNER_BADGES: '' }).poolOwnerBadges, []);
  assert.deepEqual(loadConfig({ DEX_NETWORK: 'stokenet' }).poolOwnerBadges, []);
  assert.throws(() => loadConfig({ DEX_NETWORK: 'stokenet', DEX_POOL_OWNER_BADGES: 'resource_rdx1th7yck078twm9znh2kmcn68axgylpp6ctnxwl5rkpmjj636cfzda6m' }), /not a resource address on this network/);
});

// ------------------------------------------------------------------ the API end to end

let server: Server, baseUrl: string, app: Awaited<ReturnType<typeof createApp>>;
const previews: string[] = [];
/** What the fake ledger's stream shows: the instantiate appears once the wallet "sent" it. */
const ledgerStream: { sv: number; created: string[] }[] = [{ sv: 50, created: [SPOOF] }];

async function fakePost(path: string, body: any): Promise<any> {
  if (path === '/state/entity/details') {
    return {
      ledger_state: { state_version: 100 },
      items: body.addresses.map((a: string) => RESOURCES[a] ?? (a === POOL || a === NEW_POOL ? poolItem({ address: a }) : a === SPOOF ? poolItem({ address: SPOOF, ownerBadge: ATTACKER_BADGE }) : { address: a, details: {} })),
    };
  }
  if (path === '/status/gateway-status') return { ledger_state: { network: 'stokenet', epoch: 24842, state_version: 100, proposer_round_timestamp: '2026-11-23T12:00:00Z' } };
  if (path === '/state/entity/page/fungible-vaults/') return { items: [{ amount: body.address === OWNER && body.resource_address === OWNER_BADGE ? '1' : '0' }] };
  if (path === '/stream/transactions') {
    if (!body.manifest_badges_presented_filter) return { items: [], next_cursor: null };
    const from = body.from_ledger_state?.state_version ?? 0;
    return { items: ledgerStream.filter((t) => t.sv >= from).map((t) => ({ transaction_status: 'CommittedSuccess', state_version: t.sv, receipt: { state_updates: { new_global_entities: t.created.map((a) => ({ entity_address: a })) } } })), next_cursor: null };
  }
  if (path === '/transaction/preview') {
    previews.push(body.manifest);
    return { receipt: { status: 'Succeeded', fee_summary: { xrd_total_execution_cost: '0.6' } }, resource_changes: [{ resource_changes: [{ component_entity: { entity_address: OWNER }, resource_address: XRD, amount: '-2000' }, { component_entity: { entity_address: OWNER }, resource_address: TEUR, amount: '-1.6' }] }] };
  }
  if (path === '/transaction/status') return { intent_status: 'CommittedSuccess' };
  if (path === '/transaction/committed-details') return { transaction: { transaction_status: 'CommittedSuccess', receipt: { state_updates: { new_global_entities: [{ entity_address: NEW_POOL }] } } } };
  throw new Error('unexpected Gateway call ' + path);
}

before(async () => {
  app = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_READ_ONLY: '1', DEX_POOL_OWNER_BADGES: OWNER_BADGE }));
  app.gateway.post = fakePost;
  app.readGateway.post = fakePost;
  // The market list's own reads go through the read client too (MarketData was built with it).
  server = app.api.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  await app.data.refresh();
});
after(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(baseUrl + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};

test('API: a spoofed pool on the ledger is never listed, and the new-pool form is for the badge holder only', async () => {
  assert.deepEqual((await call('GET', '/api/pools')).json, [], 'the spoof (another owner badge) is not listed');
  assert.equal((await call('GET', '/api/config')).json.ownerPoolDiscovery.enabled, true);
  const owner = await call('GET', `/api/new-pool?account=${OWNER}`);
  assert.equal(owner.json.owner, true);
  assert.equal(owner.json.ownerBadge, OWNER_BADGE);
  assert.equal(owner.json.package, 'package_tdx_2_1pklhl0ma6mepuxakg0pk2tgf4ej05uwgwu8gm0ajv5xa9acsjd4fll', 'the newest allow-listed package');
  assert.equal((await call('GET', `/api/new-pool?account=${STRANGER}`)).json.owner, false);
  assert.equal((await call('GET', '/api/new-pool?account=nonsense')).status, 400);
  const r = await call('POST', '/api/new-pool/prepare', { account: STRANGER, params: { resourceA: XRD, resourceB: TEUR, amountA: '2000', amountB: '1.6', feeBps: 50 } });
  assert.equal(r.status, 403);
  assert.equal(previews.length, 0);
});

test('API: the token picker reads a pasted address with its checks; a recallable token is refused when preparing', async () => {
  const t = await call('GET', `/api/new-pool/tokens?q=${TEUR}`);
  assert.equal(t.json[0].symbol, 'TEUR');
  assert.equal(t.json[0].divisibility, 6);
  assert.deepEqual(t.json[0].errors, []);
  const x = await call('GET', `/api/new-pool/tokens?q=${XRD}`);
  assert.deepEqual(x.json[0].warnings, [], 'the network\'s XRD is native: not checked as an issuer token');
  const bad = await call('POST', '/api/new-pool/prepare', { account: OWNER, params: { resourceA: XRD, resourceB: RECALLABLE, amountA: '1', amountB: '1', feeBps: 50 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /refused as a pool token: recaller/);
  const wrongNet = await call('POST', '/api/new-pool/prepare', { account: OWNER, params: { resourceA: XRD, resourceB: 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv', amountA: '1', amountB: '1', feeBps: 50 } });
  assert.equal(wrongNet.status, 400);
});

test('API: no market for the pair: blocked until the owner confirms the price, then built, previewed, verified and auto-listed', async () => {
  const params = { resourceA: XRD, resourceB: TEUR, amountA: '2000', amountB: '1.6', feeBps: 50 };
  const first = await call('POST', '/api/new-pool/prepare', { account: OWNER, params });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.manifest, null);
  assert.equal(first.json.preview, null);
  assert.deepEqual(first.json.needs, ['price']);
  assert.equal(first.json.seedPrice, '0.0008');
  const ok = await call('POST', '/api/new-pool/prepare', { account: OWNER, params: { ...params, confirmPrice: first.json.seedPrice } });
  assert.equal(ok.json.preview.ok, true);
  assert.equal(ok.json.manifest, previews.at(-1), 'the manifest previewed is the one handed to the wallet');
  assert.deepEqual(ok.json.preview.proofs.map((p: any) => p.label), ['pool owner badge']);
  assert.equal(ok.json.scriptStep, 'instantiate');

  // The wallet sent it: the ledger now shows the instantiate presenting our badge.
  ledgerStream.push({ sv: 120, created: [NEW_POOL] });
  const v = await call('POST', '/api/new-pool/verify', { txid: 'txid_tdx_2_1newpool000000000000000000', want: ok.json.want });
  assert.equal(v.json.status, 'CommittedSuccess');
  assert.equal(v.json.pool, NEW_POOL);
  assert.equal(v.json.listed, true);
  assert.deepEqual(v.json.mismatches, ['reserves 20000 / 16, expected 2000 / 1.6', 'inventory 1000 / 0.8, expected 0 / 0', 'fee 30 bps, expected 50', 'operator resource_tdx_2_1tkaa0etdc2q42skhlrm223a9yrk34ff3876gzndrgnjhcj2yr7wvff, expected null'],
    'the check compares the ledger with what the step set (the fixture pool is an older, funded one)');
  const list = await call('GET', '/api/pools');
  assert.deepEqual(list.json.map((p: any) => p.address), [NEW_POOL], 'listed without DEX_OWNER_POOLS; the spoof still is not');
  // The owner's actions work on it at once (Pause is offered straight after).
  const pause = await call('POST', `/api/pools/${NEW_POOL}/prepare`, { account: OWNER, action: 'pause' });
  assert.equal(pause.status, 200);
  assert.match(pause.json.manifest, /"set_paused" true/);
});
