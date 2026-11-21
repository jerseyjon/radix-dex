// Stokenet test of the on-ledger order book through the real server and solver:
//   1. a resting order is placed in the book and shows in the order book and the maker's orders;
//   2. a market order smaller than it takes part of it, at the maker's price;
//   3. a market order larger than what is left takes the rest and the pool for the remainder;
//   4. an order is cancelled and its tokens come back;
//   5. an order priced below what the pool pays is bought by the solver and so fills at its price.
// Uses its own order book (orderBookTest), not the one the test site trades on.
// Needs scripts/stokenet-setup.ts to have run.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  Gateway, NETWORKS, accountOf, addr, bookCancelManifest, bookPlaceManifest, buildTransaction, keyFromHex, limitOrderManifest,
  orderKeyFromSecret, signSubintent, submitAndWait, type Ed25519Key,
} from '../packages/core/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';

const net = NETWORKS.stokenet;
const s = JSON.parse(readFileSync('data/stokenet-keys.json', 'utf8'));
const gw = new Gateway(net);
const app = await createApp(loadConfig({
  DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: s.badge, DEX_SOLVER_KEY_FILE: 'data/stokenet-solver.key',
  DEX_REGISTRY: s.registry, DEX_ORDER_BOOK: s.orderBookTest, DEX_MARKETS_FILE: 'data/stokenet-markets.json', DEX_TAKER_FEE_BPS: '10', DEX_MAKER_FEE_BPS: '0',
}));
await app.data.refresh();
const server = app.api.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + (server.address() as any).port;
const expect = (cond: boolean, what: string) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + what); if (!cond) process.exitCode = 1; };
const balance = async (account: string, resource: string) => Number(await gw.fungibleBalance(account, resource));
const json = async (path: string, init?: RequestInit) => (await fetch(base + path, init)).json() as Promise<any>;
const n = (v: number) => v.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
const quote = async (sell: string, buy: string, amount: string) => Number((await json('/api/quote?sell=' + sell + '&buy=' + buy + '&amount=' + amount)).buyAmount);

const aliceKey = keyFromHex(s.alice), bobKey = keyFromHex(s.bob);
const alice = await accountOf(aliceKey, net.networkId), bob = await accountOf(bobKey, net.networkId);
// Keep the buyer's test account in funds: repeated runs spend its TUSD, and the seller's account collects it.
if ((await balance(bob, s.tusd)) < 80) {
  const give = Math.floor((await balance(alice, s.tusd)) / 2);
  const { epoch } = await gw.status();
  const tx = await buildTransaction({
    manifest: ['CALL_METHOD ' + addr(alice) + ' "lock_fee" Decimal("10");', 'CALL_METHOD ' + addr(alice) + ' "withdraw" ' + addr(s.tusd) + ' Decimal("' + give + '");',
      'CALL_METHOD ' + addr(bob) + ' "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;'].join('\n'),
    window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary: aliceKey,
  });
  console.log('topped up the buyer with ' + give + ' TUSD: ' + (await submitAndWait(gw, tx)).status);
}
const cfg = await json('/api/config');
expect(cfg.orderBook?.component === s.orderBookTest && cfg.orderBook.receipts === s.orderReceiptsTest && cfg.orderBook.makerFeeBps === 0, 'server reads the order book from the ledger (maker fee ' + cfg.orderBook?.makerFeeBps + ' bps)');
const market = encodeURIComponent((await json('/api/markets'))[0].id);

/** A wallet transaction, as the user's wallet would send it: the account pays its own fee. */
async function walletTx(key: Ed25519Key, account: string, manifest: string) {
  const { epoch } = await gw.status();
  const tx = await buildTransaction({ manifest: 'CALL_METHOD ' + addr(account) + ' "lock_fee" Decimal("10");\n' + manifest, window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary: key });
  const out = await submitAndWait(gw, tx);
  if (out.status !== 'CommittedSuccess') throw new Error('wallet transaction failed: ' + JSON.stringify(out).slice(0, 300));
  return tx.intentHashId;
}
async function placeInBook(sellAmount: string, price: number) {
  const before = (await json('/api/orders?account=' + alice)).filter((o: any) => o.kind === 'book').map((o: any) => o.bookId);
  await walletTx(aliceKey, alice, bookPlaceManifest({ account: alice, book: s.orderBookTest, sell: net.xrd, sellAmount, buy: s.tusd, price: n(price), expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
  await app.book!.refresh();
  const mine = (await json('/api/orders?account=' + alice)).filter((o: any) => o.kind === 'book' && !before.includes(o.bookId));
  if (mine.length !== 1) throw new Error('placed order not found');
  return mine[0].bookId as number;
}
const bookOrder = async (id: number) => { await app.book!.refresh(); return (await json('/api/orders?account=' + alice)).find((o: any) => o.bookId === id); };

/** Bob's market buy of XRD, as the site sends it. */
async function marketBuy(spend: string, minBuy: string) {
  const secret = randomBytes(32).toString('hex'), orderKeyHex = orderKeyFromSecret(secret);
  const { epoch } = await gw.status();
  const p = { account: bob, sell: s.tusd, sellAmount: spend, buy: net.xrd, minBuyAmount: minBuy };
  const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: s.badge, registry: { component: s.registry, orderKeyHex } }),
    { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 50, expiresAt: Math.floor(Date.now() / 1000) + 150 }, bobKey);
  const res = await json('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, kind: 'market', orderKeyHex, signedPartialTransactionHex: signed.signedPartialTransactionHex }) });
  if (!res.id) throw new Error('place failed: ' + JSON.stringify(res));
  const state = async () => (await json('/api/orders?account=' + bob)).find((o: any) => o.id === res.id);
  for (let i = 0; i < 30 && (await state())?.status === 'open'; i++) { await new Promise((r) => setTimeout(r, 1500)); await app.solver!.tick(); }
  return state();
}

// Prices from the pool itself: what it pays for XRD and what it charges a buyer.
const sellPrice = (await quote(net.xrd, s.tusd, '300')) / 300;
const buyPrice = 30 / (await quote(s.tusd, net.xrd, '30'));
const mid = Number(n((sellPrice + buyPrice) / 2));

// 1. Place.
const id = await placeInBook('300', mid);
{
  const o = await bookOrder(id);
  expect(o?.status === 'open' && Number(o.remaining) === 300, 'book order ' + id + ' is open with 300 XRD for sale at ' + mid);
  const depth = await json('/api/depth?market=' + market);
  expect(depth.asks.some((l: any) => l.source === 'orders' && Math.abs(l.price - mid) < 1e-9 && Math.abs(l.size - 300) < 1e-9), 'it shows in the order book as an ask of 300 at its price');
  expect((await app.solver!.tick()).bookBought === 0, 'it rests: the pool does not pay that much');
}

// 2. A market buy for about a third of it.
{
  const spend = n(100 * mid);
  const poolOnly = await quote(s.tusd, net.xrd, spend);
  const before = { at: await balance(alice, s.tusd), bx: await balance(bob, net.xrd), bt: await balance(bob, s.tusd) };
  const st = await marketBuy(spend, n((poolOnly - 1.35) * 0.98));
  const o = await bookOrder(id);
  const got = (await balance(bob, net.xrd)) - before.bx, paid = before.bt - (await balance(bob, s.tusd));
  const aliceGot = (await balance(alice, s.tusd)) - before.at;
  expect(st?.status === 'filled', 'the market order filled (' + st?.status + ') in ' + st?.fillTx);
  expect(o?.status === 'open' && Math.abs(Number(o.remaining) - 200) < 1e-6, 'the book order is part filled: ' + o?.remaining + ' XRD left of 300');
  expect(Math.abs(aliceGot - Number(spend)) < 1e-9 && Math.abs(paid - Number(spend)) < 1e-9, 'the maker was paid ' + aliceGot.toFixed(6) + ' TUSD at once, her full price with no fee');
  expect(got > (poolOnly - 1) * 0.999, 'the buyer got ' + got.toFixed(4) + ' XRD after fees, better than the pool alone would leave (' + ((poolOnly - 1) * 0.999).toFixed(4) + ')');
}

// 3. A market buy for more than is left: the rest of the order, then the pool.
{
  const spend = n(260 * mid);
  const poolOnly = await quote(s.tusd, net.xrd, spend);
  const before = { at: await balance(alice, s.tusd), bx: await balance(bob, net.xrd) };
  const st = await marketBuy(spend, n((poolOnly - 1.35) * 0.98));
  const o = await bookOrder(id);
  const got = (await balance(bob, net.xrd)) - before.bx, aliceGot = (await balance(alice, s.tusd)) - before.at;
  expect(st?.status === 'filled' && o?.status === 'filled' && Number(o.remaining) === 0, 'the market order filled and the book order is now complete (' + o?.status + ')');
  expect(Math.abs(aliceGot - 200 * mid) < 1e-6, 'the maker was paid for the last 200 XRD: ' + aliceGot.toFixed(6) + ' TUSD');
  expect(got > (poolOnly - 1) * 0.999, 'the buyer got ' + got.toFixed(4) + ' XRD: the 200 from the order and the rest from the pool');
}

// 4. Cancel.
{
  const far = await placeInBook('100', mid * 3);
  const before = await balance(alice, net.xrd);
  await walletTx(aliceKey, alice, bookCancelManifest({ account: alice, book: s.orderBookTest, receipts: s.orderReceiptsTest, id: far }));
  const o = await bookOrder(far);
  const back = (await balance(alice, net.xrd)) - before;
  expect(o?.status === 'cancelled' && back > 99 && back < 100, 'a cancelled order returns its 100 XRD (' + back.toFixed(4) + ' after the network fee) and reads as ' + o?.status);
}

// 5. An order priced under what the pool pays: the solver buys it with its own funds and sells through the pool.
{
  const price = Number(n(((await quote(net.xrd, s.tusd, '150')) / 150) * 0.97));
  const cheap = await placeInBook('150', price);
  const before = await balance(alice, s.tusd);
  let bought = 0;
  for (let i = 0; i < 5 && (await bookOrder(cheap))?.status === 'open'; i++) bought += (await app.solver!.tick()).bookBought;
  const o = await bookOrder(cheap);
  const aliceGot = (await balance(alice, s.tusd)) - before;
  expect(bought >= 1 && o?.status === 'filled', 'the solver bought the order when the pool paid more than it asked (' + o?.status + ', ' + bought + ' purchase(s))');
  expect(Math.abs(aliceGot - 150 * price) < 1e-6, 'the maker got exactly her price: ' + aliceGot.toFixed(6) + ' TUSD for 150 XRD');
}

// 6. Two book orders that cross: a seller asking a little over the pool, and a buyer bidding above that.
{
  const sellNow = (await quote(net.xrd, s.tusd, '100')) / 100;
  const askPrice = Number(n(sellNow * 1.02));
  const ask = await placeInBook('300', askPrice);
  expect((await app.solver!.tick()).bookBought === 0, 'an ask 2% over what the pool pays rests');
  // Bob bids 8% over what the pool pays, for 20 TUSD worth: enough of a gap to pay the network fee. The contract's price is XRD per TUSD.
  const bidPrice = sellNow * 1.08, perTusd = n(1 / bidPrice);
  await walletTx(bobKey, bob, bookPlaceManifest({ account: bob, book: s.orderBookTest, sell: s.tusd, sellAmount: '20', buy: net.xrd, price: perTusd, expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
  await app.book!.refresh();
  const bid = (await json('/api/orders?account=' + bob)).find((o: any) => o.kind === 'book' && o.status === 'open');
  const before = { at: await balance(alice, s.tusd), bx: await balance(bob, net.xrd) };
  const tick = await app.solver!.tick();
  const a = await bookOrder(ask), b = (await json('/api/orders?account=' + bob)).find((o: any) => o.bookId === bid?.bookId);
  const xrd = 20 * Number(perTusd);
  expect(tick.bookCrossed === 1 && b?.status === 'filled', 'the solver crossed the two orders (' + tick.bookCrossed + '); the bid is ' + b?.status);
  expect(Math.abs((await balance(bob, net.xrd)) - before.bx - xrd) < 1e-6, 'the buyer got ' + xrd.toFixed(4) + ' XRD, exactly their bid price');
  expect(Math.abs((await balance(alice, s.tusd)) - before.at - xrd * askPrice) < 1e-6, 'the seller got ' + (xrd * askPrice).toFixed(6) + ' TUSD, exactly their ask price');
  expect(a?.status === 'open' && Math.abs(Number(a.remaining) - (300 - xrd)) < 1e-6, 'the ask is part filled: ' + a?.remaining + ' XRD left');
  const hist = await json('/api/history?account=' + alice);
  expect(hist.some((t: any) => t.book === ask && Math.abs(Number(t.sellAmount) - xrd) < 1e-6 && t.sell === net.xrd), 'the sale shows in the seller\'s trade history against order #' + ask);
  const placed = (await json('/api/orders?account=' + alice)).find((o: any) => o.bookId === ask);
  expect(placed?.createdAt > Date.now() / 1000 - 600, 'the order shows the time it was placed');
  await walletTx(aliceKey, alice, bookCancelManifest({ account: alice, book: s.orderBookTest, receipts: s.orderReceiptsTest, id: ask }));
}
server.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
