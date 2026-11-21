// Stokenet test of the deployed contracts through the real server and solver:
//   1. a limit order is filled through our own pool, with price improvement going to the user;
//   2. an order hard-cancelled in the on-ledger registry can no longer be filled.
// Needs scripts/stokenet-setup.ts to have run.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  Gateway, NETWORKS, accountOf, addr, buildTransaction, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent, submitAndWait,
} from '../packages/core/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';

const net = NETWORKS.stokenet;
const s = JSON.parse(readFileSync('data/stokenet-keys.json', 'utf8'));
const gw = new Gateway(net);
const app = await createApp(loadConfig({
  DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: s.badge, DEX_SOLVER_KEY_FILE: 'data/stokenet-solver.key',
  DEX_REGISTRY: s.registry, DEX_MARKETS_FILE: 'data/stokenet-markets.json', DEX_FEE_BPS: '10',
}));
await app.data.refresh();
const server = app.api.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + (server.address() as any).port;
const expect = (cond: boolean, what: string) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + what); if (!cond) process.exitCode = 1; };
const balance = async (account: string, resource: string) => Number(await gw.fungibleBalance(account, resource));
const json = async (path: string, init?: RequestInit) => (await fetch(base + path, init)).json() as Promise<any>;

const aliceKey = keyFromHex(s.alice);
const alice = await accountOf(aliceKey, net.networkId);

const bobKey = keyFromHex(s.bob);
const bob = await accountOf(bobKey, net.networkId);
const solverAccount = await app.solver!.account();
const feeOf = async (txid: string) => (await gw.accountActivity(solverAccount, 10)).find((t) => t.txid === txid)?.feeXrd;

/** Any order through the HTTP API: who, what, the signed minimum, and optionally a trigger above it or a market kind. */
async function post(key: typeof aliceKey, o: { sell: string; sellAmount: string; buy: string; minBuyAmount: string; limitBuyAmount?: string; kind?: string; lifetime?: number }) {
  const account = await accountOf(key, net.networkId);
  const secret = randomBytes(32).toString('hex');
  const orderKeyHex = orderKeyFromSecret(secret);
  const { epoch } = await gw.status();
  const p = { account, sell: o.sell, sellAmount: o.sellAmount, buy: o.buy, minBuyAmount: o.minBuyAmount };
  const signed = await signSubintent(
    limitOrderManifest({ ...p, solverBadge: s.badge, registry: { component: s.registry, orderKeyHex } }),
    { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 50, expiresAt: Math.floor(Date.now() / 1000) + (o.lifetime ?? 900) }, key);
  const res = await json('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, limitBuyAmount: o.limitBuyAmount, kind: o.kind, orderKeyHex, signedPartialTransactionHex: signed.signedPartialTransactionHex }) });
  if (!res.id) throw new Error('place failed: ' + JSON.stringify(res));
  return { id: res.id as string, secret, account };
}
const stateOf = async (account: string, id: string) => (await json('/api/orders?account=' + account)).find((o: any) => o.id === id);
const softCancel = (o: { id: string; secret: string }) => json('/api/orders/' + o.id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: o.secret }) });
const n = (v: number) => v.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');

async function place(sellAmount: string, minBuyAmount: string) {
  const secret = randomBytes(32).toString('hex');
  const orderKeyHex = orderKeyFromSecret(secret);
  const { epoch } = await gw.status();
  const p = { account: alice, sell: net.xrd, sellAmount, buy: s.tusd, minBuyAmount };
  const signed = await signSubintent(
    limitOrderManifest({ ...p, solverBadge: s.badge, registry: { component: s.registry, orderKeyHex } }),
    { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 50, expiresAt: Math.floor(Date.now() / 1000) + 900 }, aliceKey);
  const res = await json('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, orderKeyHex, signedPartialTransactionHex: signed.signedPartialTransactionHex }) });
  if (!res.id) throw new Error('place failed: ' + JSON.stringify(res));
  return { id: res.id as string, secret };
}
const orderState = async (id: string) => (await json('/api/orders?account=' + alice)).find((o: any) => o.id === id);

// The market and a quote come from the deployed pool.
const markets = await json('/api/markets');
expect(markets.length === 1 && markets[0].venues[0] === 'radixdex', 'server lists the XRD/TUSD market on our own pool');
const quote = await json('/api/quote?sell=' + net.xrd + '&buy=' + s.tusd + '&amount=100');
expect(Number(quote.buyAmount) > 9 && Number(quote.buyAmount) < 10, 'quote for 100 XRD is ' + quote.buyAmount + ' TUSD');
const depth = await json('/api/depth?market=' + encodeURIComponent(markets[0].id));
expect(depth.bids.length > 0 && depth.asks.length > 0, 'order book has ' + depth.bids.length + ' bids and ' + depth.asks.length + ' asks from the pool');

// 1. Pool fill. Minimum is well below the pool price, so the user should get much more than the minimum.
{
  const before = { xrd: await balance(alice, net.xrd), tusd: await balance(alice, s.tusd) };
  const far = await place('100', '20');   // 0.2 TUSD per XRD: twice the market, must stay open
  const o = await place('100', '9');      // 0.09 TUSD per XRD: below the market, fills
  const tick = await app.solver!.tick();
  expect(tick.poolFilled === 1, 'solver filled exactly one order through the pool (poolFilled=' + tick.poolFilled + ')');
  const st = await orderState(o.id);
  expect(st?.status === 'filled', 'order is ' + st?.status + (st?.fillTx ? ' in ' + st.fillTx : ''));
  const got = (await balance(alice, s.tusd)) - before.tusd;
  const paid = before.xrd - (await balance(alice, net.xrd));
  expect(Math.abs(paid - 100) < 1e-9, 'user paid exactly 100 XRD, no network fee (paid ' + paid + ')');
  expect(got > 9 && got < Number(quote.buyAmount), 'user received ' + got.toFixed(6) + ' TUSD: above the 9 minimum, below the gross quote (fee and gas taken)');
  expect((await orderState(far.id))?.status === 'open', 'the order priced away from the market is still open');
  const book = await json('/api/depth?market=' + encodeURIComponent(markets[0].id));
  expect(book.asks.some((l: any) => l.source === 'orders' && Math.abs(l.price - 0.2) < 1e-9), 'that open order shows in the book as an ask at 0.2');
  await json('/api/orders/' + far.id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: far.secret }) });
}

// 2. Hard cancel. The order stays on the server (as if the server ignored the user), but the ledger refuses it.
{
  const o = await place('100', '9');
  const { epoch } = await gw.status();
  // Anyone holding the secret can cancel; here Alice does, paying her own fee.
  const cancelTx = await buildTransaction({
    manifest: ['CALL_METHOD ' + addr(alice) + ' "lock_fee" Decimal("10");', 'CALL_METHOD ' + addr(s.registry) + ' "cancel" Bytes("' + o.secret + '");'].join('\n'),
    window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary: aliceKey,
  });
  const cancelled = await submitAndWait(gw, cancelTx);
  expect(cancelled.status === 'CommittedSuccess', 'registry.cancel(secret) committed');
  const before = await balance(alice, net.xrd);
  const tick = await app.solver!.tick();
  const st = app.store.get(o.id)!;
  expect(tick.poolFilled === 0, 'solver could not fill the cancelled order');
  expect(/cancelled/i.test(st.lastError ?? ''), 'the ledger refused it: ' + String(st.lastError).slice(0, 90));
  expect((await balance(alice, net.xrd)) === before, 'user\'s XRD untouched');
}

// 3. Exchange-style limit order: it fills when the market reaches its price, and the fees come out of the proceeds.
{
  const q = Number((await json('/api/quote?sell=' + net.xrd + '&buy=' + s.tusd + '&amount=60')).buyAmount);
  const terms = (gross: number) => ({ limitBuyAmount: n(gross), minBuyAmount: n(gross - gross / 60 - gross * 0.001) }); // less 1 XRD of network fee and 0.10%
  const above = await post(aliceKey, { sell: net.xrd, sellAmount: '60', buy: s.tusd, ...terms(q * 1.02) });
  const at = await post(aliceKey, { sell: net.xrd, sellAmount: '60', buy: s.tusd, ...terms(q * 0.9995) });
  const before = await balance(alice, s.tusd);
  const tick = await app.solver!.tick();
  const st = await stateOf(alice, at.id);
  const got = (await balance(alice, s.tusd)) - before;
  expect(tick.poolFilled === 1 && st?.status === 'filled', 'a limit order priced just under the market fills (' + st?.status + '), fee paid by solver: ' + (st?.fillTx ? await feeOf(st.fillTx) : '?') + ' XRD');
  expect(got >= Number(terms(q * 0.9995).minBuyAmount) && got < q * 0.9995, 'it paid ' + got.toFixed(6) + ' TUSD: below its price of ' + (q * 0.9995).toFixed(6) + ' by the fees, above its signed minimum');
  const stAbove = await stateOf(alice, above.id);
  expect(stAbove?.status === 'open', 'the same order priced 2% above the market is still open');
  const book = await json('/api/depth?market=' + encodeURIComponent(markets[0].id));
  expect(book.asks.some((l: any) => l.source === 'orders' && Math.abs(l.price - q * 1.02 / 60) < 1e-9), 'and shows in the book at its price, not at its lower signed minimum');
  await softCancel(above);
}

// 4. A market order takes a resting limit order that beats the pool, and the pool for the rest, in one transaction.
{
  // Fresh prices from the pool itself: what it pays for 50 XRD, and what it charges someone buying about that much.
  const sellPrice = Number((await json('/api/quote?sell=' + net.xrd + '&buy=' + s.tusd + '&amount=50')).buyAmount) / 50;
  const buyPrice = 5 / Number((await json('/api/quote?sell=' + s.tusd + '&buy=' + net.xrd + '&amount=5')).buyAmount);
  const mid = (sellPrice + buyPrice) / 2;
  // Alice offers 50 XRD at the mid price: better for a buyer than the pool, but the pool will not pay it, so it rests.
  const gross = 50 * mid;
  const maker = await post(aliceKey, { sell: net.xrd, sellAmount: '50', buy: s.tusd, limitBuyAmount: n(gross), minBuyAmount: n(gross - gross / 50 - gross * 0.001) });
  expect((await app.solver!.tick()).poolFilled === 0, 'a sell at the mid price rests: the pool does not pay that much');
  // Bob buys with enough TUSD to take all of it and a little more from the pool.
  const spend = n(gross + 1);
  const poolOnly = Number((await json('/api/quote?sell=' + s.tusd + '&buy=' + net.xrd + '&amount=' + spend)).buyAmount);
  const before = { bx: await balance(bob, net.xrd), bt: await balance(bob, s.tusd), at: await balance(alice, s.tusd), ax: await balance(alice, net.xrd) };
  const taker = await post(bobKey, { sell: s.tusd, sellAmount: spend, buy: net.xrd, minBuyAmount: n((poolOnly - 1.35) * 0.98), kind: 'market', lifetime: 120 });
  await new Promise((r) => setTimeout(r, 500));
  let tick = await app.solver!.tick(); // the POST already started a pass; this one may find it done
  for (let i = 0; i < 20 && (await stateOf(bob, taker.id))?.status === 'open'; i++) { await new Promise((r) => setTimeout(r, 1500)); tick = await app.solver!.tick(); }
  void tick;
  const stT = await stateOf(bob, taker.id), stM = await stateOf(alice, maker.id);
  expect(stT?.status === 'filled' && stM?.status === 'filled' && stT.fillTx === stM.fillTx, 'market order and resting order filled in the same transaction (' + stT?.status + ', ' + stM?.status + '), fee paid by solver: ' + (stT?.fillTx ? await feeOf(stT.fillTx) : '?') + ' XRD');
  const bobGot = (await balance(bob, net.xrd)) - before.bx, bobPaid = before.bt - (await balance(bob, s.tusd));
  const aliceGot = (await balance(alice, s.tusd)) - before.at, alicePaid = before.ax - (await balance(alice, net.xrd));
  expect(Math.abs(bobPaid - Number(spend)) < 1e-9 && Math.abs(alicePaid - 50) < 1e-9, 'Bob paid exactly ' + spend + ' TUSD and Alice exactly 50 XRD');
  expect(Math.abs(aliceGot - gross * 0.999) < 1e-6, 'Alice received her price less 0.10%: ' + aliceGot.toFixed(6) + ' TUSD');
  const bobGross = bobGot + 1.35 + (bobGot + 1.35) / 0.999 * 0.001;
  expect(bobGross > poolOnly, 'Bob got ' + bobGot.toFixed(4) + ' XRD after fees (' + bobGross.toFixed(4) + ' before), better than the pool alone at ' + poolOnly.toFixed(4));
}
server.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
