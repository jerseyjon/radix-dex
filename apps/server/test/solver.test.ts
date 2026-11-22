// The Solver class with a fake Gateway, fake market data and a real in-memory store. Orders are
// signed for real (offline), and transactions are really built, so what is checked is what the
// solver decides to do with them: preview, send, settle, blame, stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  type BookOrder, type Gateway, type Pool, Decimal, NETWORKS, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent,
} from '@radix-dex/core';
import { loadConfig } from '../src/config.ts';
import type { BookWatcher } from '../src/book.ts';
import type { MarketData } from '../src/marketdata.ts';
import { Solver } from '../src/solver.ts';
import { OrderStore } from '../src/store.ts';

const net = NETWORKS.stokenet;
const XRD = net.xrd;
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
const BADGE = 'resource_tdx_2_1tktzk58223qax8lmv6zvtdfy3zvejhzx8pd4ylftqq75c2jjfcecmv';
const newKey = () => keyFromHex(randomBytes(32).toString('hex'));
// Any valid global address will do where the manifest only needs one that parses.
const REGISTRY = await accountOf(newKey(), net.networkId);
const POOL_ADDRESS = await accountOf(newKey(), net.networkId);
const BOOK = await accountOf(newKey(), net.networkId);
const pool: Pool = { venue: 'ociswap', address: POOL_ADDRESS, kind: 'basic', tokens: [XRD, TUSD], feeRate: 0, tvlUsd: 1, volume24hUsd: 0, reserves: [1, 1] };

type Preview = { ok: boolean; status: string; error?: string; feeXrd: string };
type Status = { status: 'CommittedSuccess' | 'CommittedFailure' | 'Rejected' | 'Pending'; error?: string };

/** A Gateway that answers from scripts and counts what it was asked. */
function fakeGateway(o: { previews?: Preview[]; statuses?: (Status | Error)[]; balances?: Record<string, string>; fee?: string; cancelledKeys?: Set<string> } = {}) {
  const calls = { previewV2: 0, submit: 0, status: 0, registry: 0 };
  const previews = o.previews ?? [], statuses = o.statuses ?? [];
  const g = {
    failures: 0, lastFailure: undefined,
    calls,
    status: async () => ({ epoch: 100, stateVersion: 1, timestamp: '' }),
    entityDetails: async (addresses: string[]) => addresses.map((address) => ({ address, details: { divisibility: 18 } })),
    fungibleBalance: async (account: string, resource: string) => o.balances?.[`${account}|${resource}`] ?? o.balances?.[resource] ?? '1000000',
    previewV2: async () => { calls.previewV2++; return previews.length > 1 ? previews.shift()! : previews[0] ?? { ok: true, status: 'Succeeded', feeXrd: '1' }; },
    submitTransaction: async () => { calls.submit++; },
    transactionStatus: async () => {
      calls.status++;
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0] ?? { status: 'CommittedSuccess' };
      if (s instanceof Error) throw s;
      return s;
    },
    committedFee: async () => o.fee ?? '0.4',
    // The registry check previews assert_live.
    preview: async (manifest: string) => {
      calls.registry++;
      const key = /Bytes\("([0-9a-f]{64})"\)/.exec(manifest)?.[1] ?? '';
      return o.cancelledKeys?.has(key) ? { ok: false, error: 'Panic: Order has been cancelled', feeXrd: '0', changes: [], raw: {} } : { ok: true, feeXrd: '0', changes: [], raw: {} };
    },
  };
  return g;
}

/**
 * A pool with a spread: selling TUSD pays 10 XRD each, selling XRD pays 0.08 TUSD each.
 * `listed` says which pairs the site lists.
 */
function fakeData(opts: { listed?: boolean; pool?: Pool } = {}) {
  const route = opts.pool ?? pool;
  const quoter = {
    errors: 0, lastFailure: undefined as string | undefined, bestCalls: 0,
    best: async (_pools: Pool[], sell: string, _buy: string, amount: string) => {
      quoter.bestCalls++;
      const out = new Decimal(amount).mul(sell === TUSD ? 10 : 0.08);
      return { sell, buy: sell === TUSD ? XRD : TUSD, sellAmount: amount, buyAmount: out.toFixed(), price: '0', route: [route], networkFeeXrd: '0.5' };
    },
    divisibility: async () => 18,
  };
  return {
    quoter, pools: [route], tokens: new Map(),
    xrdValueIn: async (resource: string, x: string | number | Decimal) => new Decimal(x).mul(resource === XRD ? 1 : 0.1).toFixed(),
    isListedPair: () => opts.listed ?? true,
  };
}

function fakeBook(orders: BookOrder[]) {
  return { component: BOOK, refresh: async () => {}, live: () => orders.filter((b) => b.open), info: undefined };
}

async function setup(o: { gateway?: ReturnType<typeof fakeGateway>; data?: ReturnType<typeof fakeData>; env?: Record<string, string>; book?: ReturnType<typeof fakeBook> } = {}) {
  const config = loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: BADGE, DEX_REGISTRY: REGISTRY, DEX_TAKER_FEE_BPS: '10', ...o.env });
  const store = new OrderStore(':memory:');
  const gateway = o.gateway ?? fakeGateway();
  const data = o.data ?? fakeData();
  const solver = new Solver({
    config, store, key: newKey(), badge: BADGE,
    gateway: gateway as unknown as Gateway, data: data as unknown as MarketData, book: o.book as unknown as BookWatcher | undefined,
    timing: { pollMs: 2, waitMs: 40 },
  });
  return { config, store, gateway, data, solver };
}

/** Sign an order for real and put it in the store as the API would. */
async function addOrder(store: OrderStore, o: { sell: string; sellAmount: string; buy: string; minBuyAmount: string; limitBuyAmount?: string; kind?: 'limit' | 'market'; key?: ReturnType<typeof newKey> }) {
  const key = o.key ?? newKey();
  const account = await accountOf(key, net.networkId);
  const orderKeyHex = orderKeyFromSecret(randomBytes(32).toString('hex'));
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const p = { account, sell: o.sell, sellAmount: o.sellAmount, buy: o.buy, minBuyAmount: o.minBuyAmount };
  const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: BADGE, registry: { component: REGISTRY, orderKeyHex } }), { networkId: net.networkId, startEpoch: 90, endEpoch: 190, expiresAt }, key);
  store.insert({ id: signed.hashId, ...p, limitBuyAmount: o.limitBuyAmount ?? o.minBuyAmount, kind: o.kind ?? 'limit', orderKeyHex, expiresAt, createdAt: Math.floor(Date.now() / 1000), signedPartialTransactionHex: signed.signedPartialTransactionHex });
  return { id: signed.hashId, account, orderKeyHex };
}

/** Bob's market order: 10 TUSD for at least 90 XRD. The pool pays 100. */
const bobsOrder = (store: OrderStore) => addOrder(store, { sell: TUSD, sellAmount: '10', buy: XRD, minBuyAmount: '90', kind: 'market' });
/** Alice rests 50 XRD at 4.5 TUSD: better for a buyer than the pool (10 XRD per TUSD), more than the pool pays her (4). */
const alicesOrder = (store: OrderStore) => addOrder(store, { sell: XRD, sellAmount: '50', buy: TUSD, minBuyAmount: '4.5' });

test('a fill whose preview fails is not sent, costs nothing, and counts against the taker', async () => {
  const gateway = fakeGateway({ previews: [{ ok: false, status: 'Failed', error: 'withdraw failed', feeXrd: '0' }] });
  const { store, solver } = await setup({ gateway });
  const bob = await bobsOrder(store);
  const r = await solver.tick();
  assert.equal(r.poolFilled, 0);
  assert.equal(gateway.calls.previewV2, 1);
  assert.equal(gateway.calls.submit, 0, 'nothing was submitted');
  const o = store.get(bob.id)!;
  assert.equal(o.status, 'open');
  assert.equal(o.failures, 1);
  assert.match(o.lastError ?? '', /preview/);
  assert.equal(store.accountFailuresSince(bob.account, 0), 1, 'the account is charged too');
});

test('a previewed fill is sent and recorded with its gross, fill time and transaction', async () => {
  const { store, solver, gateway } = await setup();
  const bob = await bobsOrder(store);
  const r = await solver.tick();
  assert.equal(r.poolFilled, 1);
  assert.equal(gateway.calls.submit, 1);
  const o = store.get(bob.id)!;
  assert.equal(o.status, 'filled');
  assert.match(o.fillTx ?? '', /^txid_/);
  assert.equal(o.gross, '100');
  assert.ok(o.filledAt! > 0);
  assert.equal(o.pendingTx, null);
  // 100 XRD less the 1 XRD network fee and 0.10%.
  assert.equal(o.received, '98.9');
});

test('a fill whose outcome is unknown stays pending, is never sent twice, and is settled from the ledger', async () => {
  const statuses: Status[] = [{ status: 'Pending' }];
  const gateway = fakeGateway({ statuses });
  const { store, solver } = await setup({ gateway });
  const bob = await bobsOrder(store);
  await solver.tick();
  let o = store.get(bob.id)!;
  assert.equal(o.status, 'open');
  assert.match(o.pendingTx ?? '', /^txid_/, 'the transaction is recorded against the order');
  assert.equal(o.failures, 0, 'not counted as a failure');
  await solver.tick();
  assert.equal(gateway.calls.submit, 1, 'not sent again while its outcome is unknown');
  statuses[0] = { status: 'CommittedSuccess' };
  await solver.tick();
  o = store.get(bob.id)!;
  assert.equal(o.status, 'filled');
  assert.equal(o.fillTx, o.fillTx && /^txid_/.test(o.fillTx) ? o.fillTx : 'bad');
  assert.equal(o.failures, 0);
  assert.equal(gateway.calls.submit, 1);
});

test('a status error after submission leaves the fill pending rather than failed', async () => {
  const gateway = fakeGateway({ statuses: [new Error('Gateway down')] });
  const { store, solver } = await setup({ gateway });
  const bob = await bobsOrder(store);
  await solver.tick();
  const o = store.get(bob.id)!;
  assert.equal(o.status, 'open');
  assert.equal(o.failures, 0);
  assert.notEqual(o.pendingTx, null);
});

test('a committed fill is recorded even after the server marked the order cancelled', async () => {
  const statuses: Status[] = [{ status: 'Pending' }];
  const { store, solver } = await setup({ gateway: fakeGateway({ statuses }) });
  const bob = await bobsOrder(store);
  await solver.tick();
  store.markCancelled(bob.id, 'soft cancel while in flight');
  statuses[0] = { status: 'CommittedSuccess' };
  await solver.tick();
  assert.equal(store.get(bob.id)!.status, 'filled', 'the ledger is the truth');
});

test('fees lost on failed transactions trip the loss limit, which stops all sending until the hour has passed', async () => {
  const statuses: Status[] = [{ status: 'CommittedFailure', error: 'boom' }];
  const gateway = fakeGateway({ statuses, fee: '3.2' });
  const { store, solver } = await setup({ gateway });
  await bobsOrder(store);
  await solver.tick();
  assert.equal(solver.health().lossLimit.reached, true);
  assert.equal(solver.health().lossLimit.failedFeesXrdLastHour, '3.2');
  const before = gateway.calls.previewV2;
  await bobsOrder(store);
  await solver.tick();
  assert.equal(gateway.calls.previewV2, before, 'nothing more is even previewed');
  // An hour later the loss falls out of the window and the solver resumes.
  const [failed] = (store as any).db.prepare(`SELECT intent_hash FROM transactions WHERE status = 'failure'`).all();
  (store as any).db.prepare('UPDATE transactions SET settled_at = settled_at - 4000 WHERE intent_hash = ?').run(failed.intent_hash);
  statuses[0] = { status: 'CommittedSuccess' };
  await solver.tick();
  assert.equal(solver.health().lossLimit.reached, false);
  assert.ok(gateway.calls.previewV2 > before);
});

test('a combined fill that fails is not charged to the resting order when the taker then fails alone', async () => {
  const gateway = fakeGateway({ previews: [{ ok: false, status: 'Failed', error: 'taker key cancelled', feeXrd: '0' }] });
  const { store, solver } = await setup({ gateway });
  const alice = await alicesOrder(store);
  const bob = await bobsOrder(store);
  await solver.tick();
  assert.equal(gateway.calls.previewV2, 2, 'tried with the resting order, then without it');
  assert.equal(gateway.calls.submit, 0);
  assert.equal(store.get(alice.id)!.failures, 0, 'the resting order is not charged');
  assert.equal(store.get(alice.id)!.status, 'open');
  assert.equal(store.get(bob.id)!.failures, 1, 'the taker is');
  assert.equal(store.accountFailuresSince(alice.account, 0), 0);
});

test('a resting order is charged only when the taker fills without it', async () => {
  const gateway = fakeGateway({ previews: [{ ok: false, status: 'Failed', error: 'maker withdraw failed', feeXrd: '0' }, { ok: true, status: 'Succeeded', feeXrd: '1' }] });
  const { store, solver } = await setup({ gateway });
  const alice = await alicesOrder(store);
  const bob = await bobsOrder(store);
  await solver.tick();
  assert.equal(store.get(bob.id)!.status, 'filled');
  assert.equal(store.get(bob.id)!.failures, 0);
  assert.equal(store.get(alice.id)!.failures, 1, 'the evidence points at the resting order');
  assert.equal(store.get(alice.id)!.status, 'open');
});

test('an order whose key was cancelled on ledger is closed before anything is previewed', async () => {
  const gateway = fakeGateway();
  const { store, solver } = await setup({ gateway });
  const bob = await bobsOrder(store);
  (gateway as any).preview = async () => ({ ok: false, error: 'Order has been cancelled', feeXrd: '0', changes: [], raw: {} });
  await solver.tick();
  assert.equal(gateway.calls.previewV2, 0);
  assert.equal(store.get(bob.id)!.status, 'cancelled');
  assert.match(store.get(bob.id)!.lastError ?? '', /cancelled on ledger/i);
});

test('orders and book orders outside the listed markets are not touched', async () => {
  const data = fakeData({ listed: false });
  const book = fakeBook([{ id: 1, maker: REGISTRY, sell: TUSD, buy: XRD, price: '1', sellAmount: '100', remaining: '100', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true }]);
  const gateway = fakeGateway();
  const { store, solver } = await setup({ data, gateway, book });
  await bobsOrder(store);
  await solver.tick();
  assert.equal(data.quoter.bestCalls, 0, 'not even quoted');
  assert.equal(gateway.calls.previewV2, 0);
});

test('buying from the book never spends the XRD the fee lock needs', async () => {
  // A book order selling 100 TUSD at 9 XRD each; the pool pays 10. The smallest share tried (10%) costs 90 XRD.
  const b: BookOrder = { id: 7, maker: REGISTRY, sell: TUSD, buy: XRD, price: '9', sellAmount: '100', remaining: '100', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true };
  // 95 XRD would cover 90 but not the 10 XRD fee lock on top: nothing may be sent. The solver has no TUSD for the other way round.
  const poor = fakeGateway({ balances: { [XRD]: '95', [TUSD]: '0' } });
  const s1 = await setup({ gateway: poor, book: fakeBook([b]) });
  await s1.solver.tick();
  assert.equal(poor.calls.previewV2, 0);
  // 102 XRD covers 90 plus the lock and its margin.
  const enough = fakeGateway({ balances: { [XRD]: '102', [TUSD]: '0' } });
  const s2 = await setup({ gateway: enough, book: fakeBook([{ ...b }]) });
  const r = await s2.solver.tick();
  assert.equal(enough.calls.submit, 1);
  assert.equal(r.bookBought, 1);
});

test('a book purchase that keeps failing is retried with growing gaps, then left alone until the order changes', async () => {
  const b: BookOrder = { id: 8, maker: REGISTRY, sell: TUSD, buy: XRD, price: '9', sellAmount: '100', remaining: '100', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true };
  const gateway = fakeGateway({ previews: [{ ok: false, status: 'Failed', error: 'vault frozen', feeXrd: '0' }] });
  const { solver } = await setup({ gateway, book: fakeBook([b]) });
  const backoff = (solver as any).bookBackoff as Map<string, { retryAt: number }>;
  for (let i = 0; i < 3; i++) {
    await solver.tick();
    assert.equal(gateway.calls.previewV2, i + 1);
    await solver.tick();
    assert.equal(gateway.calls.previewV2, i + 1, 'not tried again before its time');
    if (i < 2) backoff.get('book:8')!.retryAt = 0; // let the time pass
  }
  assert.equal(backoff.get('book:8')!.retryAt, Infinity);
  await solver.tick();
  assert.equal(gateway.calls.previewV2, 3, 'given up on');
  b.remaining = '50'; // the order changed on ledger: worth a fresh look
  await solver.tick();
  assert.equal(gateway.calls.previewV2, 4);
});

test('an order whose account is short of funds is held, not charged', async () => {
  const key = newKey();
  const account = await accountOf(key, net.networkId);
  const gateway = fakeGateway({ balances: { [`${account}|${TUSD}`]: '1' } });
  const { store, solver } = await setup({ gateway });
  const bob = await addOrder(store, { sell: TUSD, sellAmount: '10', buy: XRD, minBuyAmount: '90', kind: 'market', key });
  await solver.tick();
  const o = store.get(bob.id)!;
  assert.equal(o.failures, 0);
  assert.ok(o.retryAt > Date.now() / 1000);
  assert.equal(gateway.calls.previewV2, 0);
});

test('a preview rejected for the solver\'s own fee lock is not blamed on the order', async () => {
  const gateway = fakeGateway({ previews: [{ ok: false, status: 'Rejected', error: 'ErrorBeforeLoanAndDeferredCostsRepaid', feeXrd: '0' }] });
  const { store, solver } = await setup({ gateway });
  const bob = await bobsOrder(store);
  await solver.tick();
  assert.equal(gateway.calls.submit, 0);
  assert.equal(store.get(bob.id)!.failures, 0);
  assert.equal(store.accountFailuresSince(bob.account, 0), 0);
});

test('nothing is sent while the solver holds too little XRD for the fee lock', async () => {
  const gateway = fakeGateway({ balances: { [XRD]: '5' } });
  const { store, solver } = await setup({ gateway });
  const bob = await bobsOrder(store);
  await solver.tick();
  assert.equal(gateway.calls.previewV2, 0);
  assert.equal(store.get(bob.id)!.failures, 0);
  assert.equal(solver.health().xrd, 'low');
});

test('a fill through an OwnerPool calls swap_with_minimum with the floor the taker\'s own minimum implies', async () => {
  const ownerPool: Pool = { ...pool, venue: 'ownerpool', kind: 'owner' };
  const { store, solver } = await setup({ data: fakeData({ pool: ownerPool }) });
  const sent: string[] = [];
  const s = solver as unknown as { send: (m: string, ...rest: unknown[]) => Promise<unknown> };
  const send = s.send.bind(solver);
  s.send = (m: string, ...rest: unknown[]) => { sent.push(m); return send(m, ...rest); };
  // Bob sells 10 TUSD for at least 90 XRD; the pool pays 100. Charges from the proceeds: network fee
  // 1.0 (0.5 measured for the swap, 0.5 for the fill) and 0.10% of 100 = 1.1 XRD, so the pool must bring 90 + 1.1.
  const bob = await bobsOrder(store);
  assert.equal((await solver.tick()).poolFilled, 1);
  assert.equal(store.get(bob.id)!.status, 'filled');
  assert.match(sent[0]!, new RegExp(`CALL_METHOD Address\\("${POOL_ADDRESS}"\\) "swap_with_minimum" Bucket\\("in0"\\) Decimal\\("91.1"\\);`));
  assert.doesNotMatch(sent[0]!, /"swap" Bucket/);
  // Alice sells 50 XRD for at least 3.9 TUSD; charges set aside from the XRD first, and she gets all the pool pays: its floor is her minimum.
  const alice = await addOrder(store, { sell: XRD, sellAmount: '50', buy: TUSD, minBuyAmount: '3.9', kind: 'market' });
  assert.equal((await solver.tick()).poolFilled, 1);
  assert.equal(store.get(alice.id)!.status, 'filled');
  assert.match(sent[1]!, /"swap_with_minimum" Bucket\("in0"\) Decimal\("3.9"\);/);
});
