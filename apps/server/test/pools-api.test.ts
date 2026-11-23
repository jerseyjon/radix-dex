// The Pools page's API against a fake Gateway: the pool list and detail (ledger state, events, fees,
// the bot's and watcher's files), the owner check, owner actions built and previewed (never sent), the
// check after a commit, and the read-only switch. Offline: every Gateway call is answered here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { OPERATOR, OP_BADGE, OWNER, OWNER_BADGE, POOL, TEUR, XRD, callLine, configEvent, poolItem, proofLine, rebalanceEvent, streamTx, swapEvent, type PoolOpts } from './pool-fixture.ts';

const files = mkdtempSync(join(tmpdir(), 'pools-files-'));
const SECRET_URL = 'https://ntfy.example/secret-topic-123';
let server: Server, base: string, app: Awaited<ReturnType<typeof createApp>>;
let poolOpts: PoolOpts = {};
const previews: string[] = [];
let previewOk = true;
const calls: string[] = [];

/** Every Gateway call the Pools page makes, answered offline. */
async function fakePost(path: string, body: any): Promise<any> {
  calls.push(path);
  if (path === '/state/entity/details') {
    return { ledger_state: { state_version: 100 }, items: body.addresses.map((a: string) => (a === POOL ? poolItem(poolOpts) : { address: a, details: {} })) };
  }
  if (path === '/status/gateway-status') return { ledger_state: { network: 'stokenet', epoch: 24842, state_version: 100, proposer_round_timestamp: '2026-11-23T12:00:00Z' } };
  if (path === '/state/entity/page/fungible-vaults/') {
    const holds = (body.address === OWNER && body.resource_address === OWNER_BADGE) ? '1' : body.resource_address === XRD ? '19.5' : '0';
    return { items: [{ amount: holds }] };
  }
  if (path === '/stream/transactions') {
    const items = [
      streamTx({ txid: 'txid_tdx_2_1own', sv: 90, at: '2026-11-23T11:00:00Z', manifest: [proofLine(OWNER, OWNER_BADGE), callLine('set_fee', '30u16')].join('\n'), events: [configEvent(30, false)] }),
      streamTx({ txid: 'txid_tdx_2_1op', sv: 80, at: '2026-11-23T10:30:00Z', manifest: [proofLine(OPERATOR, OP_BADGE), callLine('rebalance')].join('\n'), events: [rebalanceEvent('-8', '0', false)] }),
      streamTx({ txid: 'txid_tdx_2_1swap', sv: 70, at: '2026-11-23T10:00:00Z', manifest: callLine('swap_with_minimum'), events: [swapEvent(XRD, '100', TEUR, '0.079', '0.3')] }),
    ];
    return { items: body.order === 'asc' ? [...items].reverse() : items, next_cursor: null };
  }
  if (path === '/transaction/preview') {
    previews.push(body.manifest);
    const m = body.manifest as string;
    const changes = m.includes('"withdraw" Decimal') ? [{ component_entity: { entity_address: POOL }, resource_address: XRD, amount: '-100' }] : [];
    return { receipt: { status: previewOk ? 'Succeeded' : 'Failed', error_message: previewOk ? undefined : 'Reserves moved', fee_summary: { xrd_total_execution_cost: '0.3' } }, resource_changes: [{ resource_changes: changes }] };
  }
  if (path === '/transaction/status') return { intent_status: body.intent_hash === 'txid_tdx_2_1pending000000000000000000' ? 'Pending' : 'CommittedSuccess' };
  throw new Error('unexpected Gateway call ' + path);
}

before(async () => {
  // The bot's and watcher's files, as the services write them; the alert URL must never come back out.
  const now = Date.now();
  mkdirSync(join(files, 'heartbeat'), { recursive: true });
  writeFileSync(join(files, 'heartbeat/owner-pool-bot-stokenet.json'), JSON.stringify({ program: 'owner-pool-bot', network: 'stokenet', pool: POOL, pid: 31337, at: now - 20_000, tick: 9, ok: true }));
  writeFileSync(join(files, 'heartbeat/owner-pool-watch-stokenet.json'), JSON.stringify({ program: 'owner-pool-watch', network: 'stokenet', pool: POOL, pid: 31338, at: now - 900_000, tick: 99, ok: true }));
  writeFileSync(join(files, 'owner-pool-bot-stokenet-state.json'), JSON.stringify({
    identity: { network: 'stokenet', pool: POOL, badge: OP_BADGE, operatorAccount: OPERATOR }, history: [{ at: now - 30_000, price: 0.00081 }],
    lastTx: { at: '2026-11-23T10:30:00Z', type: 'rebalance', txid: 'txid_tdx_2_1op', status: 'CommittedSuccess' }, pause: { pausedByBot: false }, consecutiveFailures: 0,
    alertUrl: SECRET_URL,
  }));
  writeFileSync(join(files, 'owner-pool-markout-stokenet.jsonl'), '');
  app = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_OWNER_POOLS: POOL, DEX_OWNER_POOL_FILES: files }));
  app.gateway.post = fakePost;
  app.readGateway.post = fakePost;
  app.data.symbol = (r: string) => (r === XRD ? 'XRD' : r === TEUR ? 'TEUR' : r.slice(0, 16) + '…');
  server = app.api.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any, text: '' };
};
const raw = async (path: string) => (await fetch(base + path)).text();

test('the pool list: price, status, TVL in token A, and the bot\'s health from its heartbeat', async () => {
  const r = await call('GET', '/api/pools');
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
  const p = r.json[0];
  assert.equal(p.address, POOL);
  assert.equal(p.pair.a.symbol, 'XRD');
  assert.equal(p.pair.b.symbol, 'TEUR');
  assert.equal(p.price, 0.0008);
  assert.equal(p.tvl.a, 40000, 'the reserves valued in XRD at the curve');
  assert.equal(p.tvl.usd, null, 'no dollar price on Stokenet');
  assert.equal(p.feeBps, 30);
  assert.equal(p.paused, false);
  assert.equal(p.bot.bot.status, 'alive');
  assert.equal(p.bot.watcher.status, 'stale', 'the watcher beat 15 minutes ago');
  assert.equal(p.bot.healthy, false, 'healthy needs the watcher too');
  // No market venues for this pair: the bot's own fresh reference is used, and says so.
  assert.equal(p.market.status, 'bot');
  assert.ok(Math.abs(p.gapBps - (0.0008 / 0.00081 - 1) * 10_000) < 1e-6);
  assert.equal((await call('GET', '/api/config')).json.ownerPools, 1);
});

test('the pool detail: operator, allowance, activity by who acted, fees, the bot\'s state; never a path, pid or alert URL', async () => {
  const r = await call('GET', `/api/pools/${POOL}`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.deepEqual(d.inventory, { a: '1000', b: '0.8', valueA: 2000 });
  assert.equal(d.ownerBadge, OWNER_BADGE);
  assert.equal(d.operator.badge, OP_BADGE);
  assert.equal(d.operator.limits.maxFeeBps, 100);
  assert.equal(d.operator.allowance.budget, '0.03');
  assert.equal(d.operator.allowance.now, '0.015', '36 of 72 epochs since the allowance was zeroed');
  assert.equal(d.operator.account, OPERATOR);
  assert.equal(d.operator.accountXrd, '19.5');
  assert.deepEqual(d.activity.map((a: any) => a.kind), ['owner', 'operator', 'swap']);
  assert.equal(d.fees.swaps, 1);
  assert.equal(d.fees.feeA, '0.3');
  assert.equal(d.fees.complete, true);
  assert.equal(d.botState.lastTx.type, 'rebalance');
  assert.equal(d.markout.trades, 0, 'the markout file is read (the watcher\'s heartbeat names this pool)');
  const text = await raw(`/api/pools/${POOL}`) + await raw('/api/pools');
  for (const secret of [files, 'heartbeat/', '31337', '31338', SECRET_URL, 'alertUrl']) assert.ok(!text.includes(secret), `must not show ${secret}`);
});

test('only listed pools are served', async () => {
  assert.equal((await call('GET', '/api/pools/component_tdx_2_1cpnd6hau0uqju4pjzgdusy8jnk0hlglc9zsclgzsd2ayqywgae3rvp')).status, 404);
  assert.equal((await call('POST', '/api/pools/component_tdx_2_1cpnd6hau0uqju4pjzgdusy8jnk0hlglc9zsclgzsd2ayqywgae3rvp/prepare', { account: OWNER, action: 'pause' })).status, 404);
});

test('the owner check reads the badge on the ledger', async () => {
  assert.deepEqual((await call('GET', `/api/pools/${POOL}/owner?account=${OWNER}`)).json, { owner: true, ownerBadge: OWNER_BADGE });
  assert.equal((await call('GET', `/api/pools/${POOL}/owner?account=${OPERATOR}`)).json.owner, false);
  assert.equal((await call('GET', `/api/pools/${POOL}/owner?account=account_rdx12xknv0yply6fhvega00ke3x8mymq7lu6va8uw8dl0trsvcg85f6mnz`)).status, 400, 'a mainnet account on Stokenet');
  assert.equal((await call('GET', `/api/pools/${POOL}/owner`)).status, 400);
});

test('an owner action is built, previewed on the Gateway, and handed back; nothing is sent', async () => {
  previews.length = 0; calls.length = 0;
  const r = await call('POST', `/api/pools/${POOL}/prepare`, { account: OWNER, action: 'withdraw', params: { amountA: '100' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.action, 'withdraw');
  assert.equal(r.json.network, 'stokenet');
  assert.equal(previews.length, 1);
  assert.equal(previews[0], r.json.manifest, 'the manifest handed back is exactly the one previewed');
  assert.ok(!r.json.manifest.includes('lock_fee'));
  assert.ok(r.json.manifest.startsWith(proofLine(OWNER, OWNER_BADGE)));
  assert.match(r.json.manifest, /Some\(Tuple\(Decimal\("20000"\), Decimal\("16"\)\)\)/, 'guarded by the reserves read now');
  assert.equal(r.json.preview.ok, true);
  assert.deepEqual(r.json.preview.changes[0].items[0], { resource: XRD, symbol: 'XRD', amount: '-100' });
  assert.equal(r.json.preview.changes[0].label, 'the pool');
  assert.deepEqual(r.json.readAt.reserves, ['20000', '16']);
  assert.ok(!calls.some((c) => c.startsWith('/transaction/submit')), 'never submits');
  // A failing preview is reported, not hidden.
  previewOk = false;
  const f = await call('POST', `/api/pools/${POOL}/prepare`, { account: OWNER, action: 'pause' });
  previewOk = true;
  assert.equal(f.json.preview.ok, false);
  assert.equal(f.json.preview.error, 'Reserves moved');
});

test('owner actions are refused for an account without the owner badge, and for bad requests', async () => {
  assert.equal((await call('POST', `/api/pools/${POOL}/prepare`, { account: OPERATOR, action: 'pause' })).status, 403);
  assert.equal((await call('POST', `/api/pools/${POOL}/prepare`, { account: OWNER, action: 'withdraw_all' })).status, 400);
  assert.equal((await call('POST', `/api/pools/${POOL}/prepare`, { account: 'account_nope', action: 'pause' })).status, 400);
  const revoke = await call('POST', `/api/pools/${POOL}/prepare`, { account: OWNER, action: 'revoke', params: {} });
  assert.equal(revoke.status, 400);
  assert.match(revoke.json.error, /Type REVOKE/);
  assert.equal((await call('POST', `/api/pools/${POOL}/prepare`, { account: OWNER, action: 'revoke', params: { confirm: 'REVOKE' } })).status, 200);
  const fee = await call('POST', `/api/pools/${POOL}/prepare`, { account: OWNER, action: 'fee', params: { feeBps: 9999 } });
  assert.equal(fee.status, 400);
  // A pool with no operator cannot have its operator's limits set.
  poolOpts = { operator: null };
  try {
    const r = await call('POST', `/api/pools/${POOL}/prepare`, { account: OWNER, action: 'pause' });
    assert.equal(r.status, 200, 'the pause still works without an operator');
  } finally { poolOpts = {}; }
});

test('after a commit, the check compares the pool with what the action set', async () => {
  poolOpts = { fee: 31 };
  try {
    const ok = await call('POST', `/api/pools/${POOL}/verify`, { txid: 'txid_tdx_2_1abcdefabcdefabcdefabcdef', want: { feeBps: 31, junk: 'x' } });
    assert.deepEqual(ok.json, { status: 'CommittedSuccess', error: null, mismatches: [] });
    const off = await call('POST', `/api/pools/${POOL}/verify`, { txid: 'txid_tdx_2_1abcdefabcdefabcdefabcdef', want: { feeBps: 40 } });
    assert.deepEqual(off.json.mismatches, ['fee 31 bps, expected 40']);
  } finally { poolOpts = {}; }
  assert.equal((await call('POST', `/api/pools/${POOL}/verify`, { txid: 'txid_tdx_2_1pending000000000000000000' })).json.status, 'Pending');
  assert.equal((await call('POST', `/api/pools/${POOL}/verify`, { txid: 'nope' })).status, 400);
});

test('read only: no solver even with a key configured, and no orders taken', async () => {
  const ro = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_READ_ONLY: '1', DEX_SOLVER_BADGE: OWNER_BADGE, DEX_SOLVER_KEY_FILE: '/nonexistent/solver.key' }));
  assert.equal(ro.solver, undefined);
  assert.equal(ro.config.readOnly, true);
  const s = ro.api.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  try {
    const u = `http://127.0.0.1:${(s.address() as any).port}`;
    const cfg = await (await fetch(u + '/api/config')).json() as any;
    assert.equal(cfg.readOnly, true);
    assert.equal(cfg.limitOrders.enabled, false);
    assert.equal((await fetch(u + '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  } finally { s.close(); }
  assert.equal(loadConfig({ DEX_NETWORK: 'stokenet' }).readOnly, false);
});
