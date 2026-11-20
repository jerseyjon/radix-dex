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
  expect(got > 9.5 && got < Number(quote.buyAmount), 'user received ' + got.toFixed(6) + ' TUSD: above the 9 minimum, below the gross quote (fee and gas taken)');
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
server.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
