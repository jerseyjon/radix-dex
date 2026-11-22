// The solver takes its charges in XRD only (owner's rule, 22 Nov 2026). Every fill the solver
// decides to send is run through a small engine stand-in (ledger-sim.ts) against linear pools, and
// the invariant is checked each time: the solver gains XRD, at least its network fee estimate plus
// the service fee less the stated tolerance, and no other token at all; every user gets at least
// what they signed for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  type BookOrder, type Gateway, type Pool, Decimal, GAS_SHORTFALL_TOLERANCE, NETWORKS, Quoter, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent,
} from '@radix-dex/core';
import { loadConfig } from '../src/config.ts';
import type { BookWatcher } from '../src/book.ts';
import type { MarketData } from '../src/marketdata.ts';
import { NO_XRD_ROUTE, Solver, fillGasXrd } from '../src/solver.ts';
import { OrderStore } from '../src/store.ts';
import { type SimResult, simulate } from './ledger-sim.ts';

const net = NETWORKS.stokenet;
const XRD = net.xrd;
const TUSD = 'resource_tdx_2_1th7w39rfv8dux3egj68femh6e5kp20xruxv8u5ll4j0xnh6enw4kfx';
/** The attacker's own token (H3): it has a pool against XRD and is worth nothing to anyone else. */
const ATK = 'resource_tdx_2_1t5jcmwqx39ym7fw0hrlpnxwechr0mzlgulcfcye59qm9y9fa5uvdrd';
/** A token with no XRD pool at all (only a pool against TUSD). */
const LONE = 'resource_tdx_2_1nfxxxxxxxxxxglcllrxxxxxxxxx002350006550xxxxxxxxxqtcnwk';
const BADGE = 'resource_tdx_2_1tktzk58223qax8lmv6zvtdfy3zvejhzx8pd4ylftqq75c2jjfcecmv';
const FEE_BPS = 10;
const newKey = () => keyFromHex(randomBytes(32).toString('hex'));
const REGISTRY = await accountOf(newKey(), net.networkId);
const BOOK = await accountOf(newKey(), net.networkId);

/** Linear pools, each with a spread: what one unit of `sell` fetches in the other token. */
const RATES: Record<string, Record<string, number>> = {
  [XRD]: { [TUSD]: 0.08, [ATK]: 1000 },
  [TUSD]: { [XRD]: 10, [LONE]: 3 },
  [ATK]: { [XRD]: 0.0009 },
  [LONE]: { [TUSD]: 0.3 },
};
const pools: Pool[] = [];
for (const [a, b] of [[XRD, TUSD], [XRD, ATK], [TUSD, LONE]] as const) {
  pools.push({ venue: 'ociswap', address: await accountOf(newKey(), net.networkId), kind: 'basic', tokens: [a, b], feeRate: 0, tvlUsd: 1000, volume24hUsd: 0, reserves: [1, 1] });
}
const swap = (p: Pool) => (sell: string, amount: Decimal) => {
  const buy = p.tokens[0] === sell ? p.tokens[1] : p.tokens[0];
  return { token: buy, amount: amount.mul(RATES[sell]![buy]!).toDecimalPlaces(18, Decimal.ROUND_DOWN) };
};
const SWAP_FEE = '0.5';

function fakeData() {
  const run = (route: Pool[], sell: string, amount: Decimal) => {
    let token = sell, v = amount;
    for (const p of route) { const r = swap(p)(token, v); token = r.token; v = r.amount; }
    return { token, v };
  };
  const quoter = {
    errors: 0, lastFailure: undefined as string | undefined, bestCalls: 0,
    candidateRoutes: Quoter.prototype.candidateRoutes,
    simulate: async (route: Pool[], sell: string, amount: string | Decimal) => {
      const { token, v } = run(route, sell, new Decimal(amount));
      return { sell, buy: token, sellAmount: new Decimal(amount).toFixed(), buyAmount: v.toFixed(), price: '0', route, networkFeeXrd: new Decimal(SWAP_FEE).mul(route.length).toFixed() };
    },
    best: async (ps: Pool[], sell: string, buy: string, amount: string) => {
      quoter.bestCalls++;
      const route = Quoter.prototype.candidateRoutes(ps, sell, buy, XRD)[0];
      return route ? quoter.simulate(route, sell, amount) : undefined;
    },
    divisibility: async () => 18,
  };
  const data = {
    quoter, pools, tokens: new Map(),
    isListedPair: () => true,
    solverCanFill: (a: string, b: string) => a === XRD || b === XRD || Quoter.prototype.candidateRoutes(pools, a, b, XRD).some((r) => r.length === 2),
    xrdValueIn: async () => { throw new Error('the solver must not price its charges in other tokens'); },
  };
  return data;
}

function fakeGateway(balances: Record<string, string> = {}) {
  const calls = { previewV2: 0, submit: 0 };
  return {
    failures: 0, lastFailure: undefined, calls,
    status: async () => ({ epoch: 100, stateVersion: 1, timestamp: '' }),
    entityDetails: async (addresses: string[]) => addresses.map((address) => ({ address, details: { divisibility: 18 } })),
    fungibleBalance: async (_account: string, resource: string) => balances[resource] ?? '1000000',
    fungibleBalances: async () => ({ [XRD]: '1000', [BADGE]: '1', ...balances }),
    previewV2: async () => { calls.previewV2++; return { ok: true, status: 'Succeeded', feeXrd: '1' }; },
    submitTransaction: async () => { calls.submit++; },
    transactionStatus: async () => ({ status: 'CommittedSuccess' as const }),
    committedFee: async () => '0.4',
    preview: async () => ({ ok: true, feeXrd: '0', changes: [], raw: {} }),
  };
}

async function setup(o: { book?: BookOrder[]; env?: Record<string, string>; balances?: Record<string, string> } = {}) {
  const config = loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: BADGE, DEX_REGISTRY: REGISTRY, DEX_TAKER_FEE_BPS: String(FEE_BPS), ...o.env });
  const store = new OrderStore(':memory:');
  const gateway = fakeGateway(o.balances);
  const book = o.book ? { component: BOOK, refresh: async () => {}, live: () => o.book!.filter((b) => b.open && new Decimal(b.remaining).gt(0)) } : undefined;
  const solver = new Solver({
    config, store, key: newKey(), badge: BADGE, gateway: gateway as unknown as Gateway, data: fakeData() as unknown as MarketData,
    book: book as unknown as BookWatcher | undefined, timing: { pollMs: 2, waitMs: 40 },
  });
  const account = await solver.account();
  // Every transaction runs in the engine stand-in first; one that would fail there is treated as a failed preview.
  const results: { manifest: string; sim: SimResult; record: any }[] = [];
  const realSend = (solver as any).send.bind(solver);
  (solver as any).send = async (manifest: string, children: Record<string, unknown>, record: any) => {
    const kids: Record<string, any> = {};
    Object.keys(children).forEach((name, i) => { const s = store.get(record.orders[i].id)!; kids[name] = { sell: s.sell, sellAmount: s.sellAmount, buy: s.buy, minBuyAmount: s.minBuyAmount }; });
    let sim: SimResult;
    try {
      sim = simulate(manifest, { solver: account, xrd: XRD, children: kids, pools: Object.fromEntries(pools.map((p) => [p.address, swap(p)])), book: new Map((o.book ?? []).map((b) => [b.id, b])), divisibility: () => 18 });
    } catch (e) { return { kind: 'previewFailed', error: String((e as Error).message) }; }
    results.push({ manifest, sim, record });
    return realSend(manifest, children, record);
  };
  return { config, store, gateway, solver, results, account };
}

async function addOrder(store: OrderStore, o: { sell: string; sellAmount: string; buy: string; minBuyAmount: string; limitBuyAmount?: string; kind?: 'limit' | 'market' }) {
  const key = newKey();
  const account = await accountOf(key, net.networkId);
  const orderKeyHex = orderKeyFromSecret(randomBytes(32).toString('hex'));
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const p = { account, sell: o.sell, sellAmount: o.sellAmount, buy: o.buy, minBuyAmount: o.minBuyAmount };
  const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: BADGE, registry: { component: REGISTRY, orderKeyHex } }), { networkId: net.networkId, startEpoch: 90, endEpoch: 190, expiresAt }, key);
  store.insert({ id: signed.hashId, ...p, limitBuyAmount: o.limitBuyAmount ?? o.minBuyAmount, kind: o.kind ?? 'limit', orderKeyHex, expiresAt, createdAt: Math.floor(Date.now() / 1000), signedPartialTransactionHex: signed.signedPartialTransactionHex });
  return signed.hashId;
}

/** The invariant: XRD only, and at least the charges stated (`minXrd`). */
function assertXrdOnly(sim: SimResult, minXrd: Decimal | string) {
  for (const [token, v] of Object.entries(sim.solver)) if (token !== XRD) assert.ok(v.isZero(), `the solver must not keep ${v} of ${token}`);
  assert.ok((sim.solver[XRD] ?? new Decimal(0)).gte(minXrd), `the solver gained ${sim.solver[XRD]} XRD, less than ${minXrd}`);
}
/** Network fee estimate plus the service fee on `xrdBase`, less the shortfall the solver tolerates. */
const leastCharge = (gasXrd: Decimal, xrdBase: string | Decimal) => gasXrd.plus(new Decimal(xrdBase).mul(FEE_BPS).div(10_000)).minus(gasXrd.mul(GAS_SHORTFALL_TOLERANCE));

test('H3 replayed: an attacker buys their own token with XRD, again and again; the solver ends with more XRD and none of the token', async () => {
  const { store, solver, results } = await setup();
  const ids: string[] = [];
  // 20 market orders, each spending 5 XRD on the attacker's token, minimum next to nothing.
  for (let i = 0; i < 20; i++) ids.push(await addOrder(store, { sell: XRD, sellAmount: '5', buy: ATK, minBuyAmount: '1', kind: 'market' }));
  for (let i = 0; i < 20 && results.length < 20; i++) await solver.tick();
  assert.equal(results.length, 20, 'every order filled');
  const gas = fillGasXrd(0, SWAP_FEE);
  let xrdGained = new Decimal(0);
  for (const r of results) {
    assertXrdOnly(r.sim, leastCharge(gas, '5'));
    xrdGained = xrdGained.plus(r.sim.solver[XRD]!);
    // The attacker got their token, from the swap of what was left after the charges: (5 − 1.005) × 1000.
    assert.equal(r.sim.received.taker![ATK]!.toFixed(), '3995');
  }
  // Net of its network fee estimate the solver is ahead: it collected the estimate plus 0.10% each time.
  assert.equal(xrdGained.minus(gas.mul(20)).toFixed(), '0.1');
  for (const id of ids) assert.equal(store.get(id)!.status, 'filled');
});

test('selling a token for XRD: the charges come out of the XRD proceeds, as before', async () => {
  const { store, solver, results } = await setup();
  const id = await addOrder(store, { sell: TUSD, sellAmount: '10', buy: XRD, minBuyAmount: '90', kind: 'market' });
  await solver.tick();
  assert.equal(results.length, 1);
  assertXrdOnly(results[0]!.sim, leastCharge(fillGasXrd(0, SWAP_FEE), '100'));
  assert.equal(store.get(id)!.received, '98.9'); // 100 less 1 XRD network fee and 0.10%
  assert.equal(results[0]!.sim.received.taker![XRD]!.toFixed(), '98.9');
});

test('buying with XRD: the charges are set aside from the XRD sold, and the user gets the whole swap', async () => {
  const { store, solver, results } = await setup();
  // 100 XRD for TUSD at 0.08: charges 1 + 0.1 XRD, 98.9 XRD swapped, 7.912 TUSD.
  const id = await addOrder(store, { sell: XRD, sellAmount: '100', buy: TUSD, minBuyAmount: '7.8', limitBuyAmount: '8', kind: 'limit' });
  await solver.tick();
  assert.equal(results.length, 1);
  assertXrdOnly(results[0]!.sim, leastCharge(fillGasXrd(0, SWAP_FEE), '100'));
  assert.equal(results[0]!.sim.solver[XRD]!.toFixed(), '1.1');
  assert.equal(store.get(id)!.received, '7.912');
  // Recorded at the trade's own price before the charges: 8 TUSD for 100 XRD.
  assert.equal(store.get(id)!.gross, '8');
});

test('a pair without XRD goes through XRD, and the charges are taken between the two swaps', async () => {
  const { store, solver, results } = await setup();
  // 10 ATK → XRD (0.0009 each, 0.009 XRD) is too little to pay any fee: not filled.
  const small = await addOrder(store, { sell: ATK, sellAmount: '10', buy: TUSD, minBuyAmount: '0.0000001', kind: 'limit' });
  // 1,000,000 ATK → 900 XRD; charges 1.5 + 0.9 = 2.4 XRD; 897.6 XRD → 71.808 TUSD.
  const big = await addOrder(store, { sell: ATK, sellAmount: '1000000', buy: TUSD, minBuyAmount: '70', limitBuyAmount: '71.5', kind: 'limit' });
  await solver.tick();
  assert.equal(results.length, 1, String(store.get(big)!.lastError));
  const gas = fillGasXrd(0, '1'); // two swaps
  assertXrdOnly(results[0]!.sim, leastCharge(gas, '900'));
  assert.equal(results[0]!.sim.solver[XRD]!.toFixed(), '2.4');
  assert.equal(store.get(big)!.received, '71.808');
  assert.equal(store.get(small)!.status, 'open');
});

test('an order in a pair with no route through XRD is left open with the reason, and nothing is quoted for it', async () => {
  const { store, solver, results } = await setup();
  const id = await addOrder(store, { sell: LONE, sellAmount: '100', buy: TUSD, minBuyAmount: '1', kind: 'limit' });
  await solver.tick();
  assert.equal(results.length, 0);
  assert.equal(store.get(id)!.status, 'open');
  assert.equal(solver.outlook.get(id)?.reason, NO_XRD_ROUTE);
});

test('an order signed under the old rule (fees from what it buys) still fills at its price under the new one', async () => {
  const { store, solver, results } = await setup();
  // Signed before 22 Nov: sell 1000 XRD at 0.08 TUSD; trigger 80, minimum 80 less the old allowance
  // in TUSD (1.25 × 1 XRD × 0.08 = 0.1) and 0.10% (0.08): 79.82.
  const id = await addOrder(store, { sell: XRD, sellAmount: '1000', buy: TUSD, minBuyAmount: '79.82', limitBuyAmount: '80', kind: 'limit' });
  await solver.tick();
  assert.equal(results.length, 1, 'filled when the market is at its price');
  // Its allowance, less the 5 bp margin kept above its minimum, covers the network fee in full but not
  // all of the service fee: the solver takes what fits (as it did under the old rule), never less than the network fee.
  assertXrdOnly(results[0]!.sim, fillGasXrd(0, SWAP_FEE));
  assert.ok(results[0]!.sim.solver[XRD]!.lt(2));
  const got = new Decimal(store.get(id)!.received!);
  assert.ok(got.gte(new Decimal('79.82').mul('1.0005')), 'above the signed minimum, with the margin');
});

test('a taker selling XRD takes a resting order and the pool; the maker fee (in XRD) and the charges stay XRD', async () => {
  const { store, solver, results } = await setup({ env: { DEX_MAKER_FEE_BPS: '10' } });
  // The maker sells 5 TUSD for 45 XRD (9 XRD each: cheaper than the pool's 12.5).
  const maker = await addOrder(store, { sell: TUSD, sellAmount: '5', buy: XRD, minBuyAmount: '44.9', limitBuyAmount: '45' });
  const taker = await addOrder(store, { sell: XRD, sellAmount: '100', buy: TUSD, minBuyAmount: '8', kind: 'market' });
  await solver.tick();
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.match(r.manifest, /maker_0/);
  assertXrdOnly(r.sim, leastCharge(fillGasXrd(1, SWAP_FEE), '100'));
  assert.ok(r.sim.received.maker_0![XRD]!.gte('44.9'));
  assert.ok(r.sim.received.taker![TUSD]!.gte('8'));
  assert.equal(store.get(maker)!.status, 'filled');
  assert.equal(store.get(taker)!.status, 'filled');
});

test('a taker buying XRD takes a resting order: no maker fee in the other token, so the solver keeps XRD alone', async () => {
  const { store, solver, results } = await setup({ env: { DEX_MAKER_FEE_BPS: '10' } });
  // The maker sells 50 XRD for 4.5 TUSD; the taker sells 10 TUSD for XRD.
  await addOrder(store, { sell: XRD, sellAmount: '50', buy: TUSD, minBuyAmount: '4.5' });
  await addOrder(store, { sell: TUSD, sellAmount: '10', buy: XRD, minBuyAmount: '90', kind: 'market' });
  await solver.tick();
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.match(r.manifest, /maker_0/);
  assertXrdOnly(r.sim, leastCharge(fillGasXrd(1, SWAP_FEE), r.sim.received.taker![XRD]!));
  assert.equal(r.sim.received.maker_0![TUSD]!.toFixed(), '4.5', 'the maker is paid its full price: a fee in TUSD would stay with the solver');
});

test('the solver buys a book order only with XRD, ends with XRD alone, and leaves orders that sell XRD to takers', async () => {
  const sellsTusd: BookOrder = { id: 1, maker: REGISTRY, sell: TUSD, buy: XRD, price: '9', sellAmount: '100', remaining: '100', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true };
  const sellsXrd: BookOrder = { id: 2, maker: REGISTRY, sell: XRD, buy: TUSD, price: '0.12', sellAmount: '1000', remaining: '1000', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true };
  const { solver, results, gateway } = await setup({ book: [sellsTusd, sellsXrd] });
  const r = await solver.tick();
  assert.equal(r.bookBought, 1);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.record.bookIds, [1]);
  // Bought 100 TUSD for 900 XRD, sold it for 1000: 100 XRD back on top of the 900, before the network fee.
  assertXrdOnly(results[0]!.sim, '1');
  assert.equal(gateway.calls.previewV2, 1, 'the XRD-selling order was not even tried');
});

test('two crossing book orders are settled with XRD only, with no token left over', async () => {
  // Sells 10 TUSD at 9 XRD; buys TUSD at 10 XRD each (sells XRD at 0.1 TUSD per XRD). The pool pays less than either, so only the cross is worth doing.
  const ask: BookOrder = { id: 3, maker: REGISTRY, sell: TUSD, buy: XRD, price: '9', sellAmount: '10', remaining: '10', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true };
  const bid: BookOrder = { id: 4, maker: REGISTRY, sell: XRD, buy: TUSD, price: '0.1', sellAmount: '200', remaining: '200', returned: '0', unclaimed: '0', makerFeeBps: 0, expiresAt: 0, open: true };
  const saved = RATES[TUSD]![XRD]!;
  RATES[TUSD]![XRD] = 8; // the pool pays 8 XRD per TUSD: no arbitrage against it
  try {
    const { solver, results } = await setup({ book: [ask, bid] });
    const r = await solver.tick();
    assert.equal(r.bookCrossed, 1);
    assert.deepEqual(results[0]!.record.bookIds, [3, 4]);
    // 90 XRD paid for 10 TUSD, which the bid takes for 100 XRD.
    assertXrdOnly(results[0]!.sim, '10');
    assert.equal(results[0]!.sim.solver[XRD]!.toFixed(), '10');
  } finally { RATES[TUSD]![XRD] = saved; }
});

test('/api/health learns from the solver when its account holds anything but XRD and its badge', async () => {
  const clean = await setup();
  await clean.solver.checkHoldings(true);
  assert.equal(clean.solver.health().otherTokens, 0);
  const dirty = await setup({ balances: { [ATK]: '5000' } });
  await dirty.solver.checkHoldings(true);
  assert.equal(dirty.solver.health().otherTokens, 1);
});
