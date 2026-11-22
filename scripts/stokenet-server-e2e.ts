// Runs the real server in-process against Stokenet: two users post crossing orders over HTTP, the solver settles them.
// Since 22 Nov 2026 the solver's charges are XRD only: checked here both ways (taken from the XRD the taker
// receives, and from the XRD the taker sells), with the solver ending with no TUSD, and a pair with no
// route through XRD is refused. Requires data/stokenet-keys.json from scripts/stokenet-e2e.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Gateway, NETWORKS, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent } from '../packages/core/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';

const net = NETWORKS.stokenet;
const keys = JSON.parse(readFileSync('data/stokenet-keys.json', 'utf8'));
writeFileSync('data/stokenet-solver.key', keys.solver, { mode: 0o600 });
const app = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: keys.badge, DEX_SOLVER_KEY_FILE: 'data/stokenet-solver.key', DEX_FEE_BPS: '10', DEX_MAKER_FEE_BPS: '10' }));
// The server only accepts orders in markets it lists. List XRD/TUSD with no pool, so the two orders
// can only fill against each other (the figures checked below assume no pool leg).
app.data.markets = [{ id: `${net.xrd}/${keys.tusd}`, base: { address: net.xrd, symbol: 'XRD', name: 'Radix' }, quote: { address: keys.tusd, symbol: 'TUSD', name: 'Test USD' }, pools: [], tvlUsd: 0, volume24hUsd: 0 }];
const server = app.api.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const gw = new Gateway(net);
const expect = (cond: boolean, what: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) process.exitCode = 1; };
const balance = async (account: string, resource: string) => Number((await gw.entityDetails([account]))[0]?.fungible_resources?.items?.find((i: any) => i.resource_address === resource)?.amount ?? 0);

async function place(keyHex: string, sell: string, sellAmount: string, buy: string, minBuyAmount: string) {
  const key = keyFromHex(keyHex), account = await accountOf(key, net.networkId);
  const cfg = await (await fetch(base + '/api/config')).json() as any;
  const { epoch } = await gw.status();
  const secret = randomBytes(32).toString('hex');
  const p = { account, sell, sellAmount, buy, minBuyAmount };
  const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: cfg.limitOrders.solverBadge }), { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 50, expiresAt: Math.floor(Date.now() / 1000) + 900 }, key);
  const res = await fetch(base + '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, orderKeyHex: orderKeyFromSecret(secret), signedPartialTransactionHex: signed.signedPartialTransactionHex }) });
  const json = await res.json() as any;
  if (!res.ok) throw new Error(`place failed: ${JSON.stringify(json)}`);
  return { id: json.id as string, account, secret };
}

const alice = await accountOf(keyFromHex(keys.alice), net.networkId), bob = await accountOf(keyFromHex(keys.bob), net.networkId);
const solverAccount = await app.solver!.account();
// (The live Stokenet site may share this solver account; if it fills something meanwhile, the TUSD checks below can trip on that.)
const solverTusdAtStart = await balance(solverAccount, keys.tusd);
const before = { at: await balance(alice, keys.tusd), bx: await balance(bob, net.xrd) };

// Alice sells 40 XRD for >= 3 TUSD; Bob sells 4 TUSD for >= 35 XRD. A third order is far from the market and must stay open.
const a = await place(keys.alice, net.xrd, '40', keys.tusd, '3');
const far = await place(keys.alice, net.xrd, '40', keys.tusd, '4000');
expect((await app.solver!.tick()).crossed === 0, 'nothing fills while only one side is present');
const b = await place(keys.bob, keys.tusd, '4', net.xrd, '35');
const tick = await app.solver!.tick();
expect(tick.crossed === 2, `solver crossed the two orders (crossed=${tick.crossed})`);

const orders = await (await fetch(`${base}/api/orders?account=${alice}`)).json() as any[];
const oa = orders.find((o) => o.id === a.id), of = orders.find((o) => o.id === far.id);
expect(oa?.status === 'filled' && /^txid_/.test(oa.fillTx), `Alice's order is filled (${oa?.status}, ${oa?.fillTx})`);
expect(of?.status === 'open', 'the far-from-market order is still open');
const after = { at: await balance(alice, keys.tusd), bx: await balance(bob, net.xrd) };
// Bob's order arrived second, so it is the taker and carries the network fee (1.08 XRD with one maker and no pool).
// The charges come out of the XRD Bob buys. A maker fee would be in TUSD, which the solver does not keep, so Alice
// gets her full 4 TUSD; Bob gets 40 XRD less 0.10% and the network fee = 38.88.
expect(Math.abs(after.at - before.at - 4) < 1e-9, `Alice received 4 TUSD, no maker fee in TUSD (got ${after.at - before.at})`);
expect(Math.abs(after.bx - before.bx - 38.88) < 1e-9, `Bob received 38.88 XRD (got ${after.bx - before.bx})`);

// The other way round: Bob's TUSD order rests and Alice sells XRD to take it, so the charges come out of the XRD she sells.
{
  const bt0 = await balance(bob, net.xrd), at0 = await balance(alice, keys.tusd), ax0 = await balance(alice, net.xrd);
  const maker = await place(keys.bob, keys.tusd, '4', net.xrd, '35');
  expect((await app.solver!.tick()).crossed === 0, 'a lone TUSD seller rests');
  const taker = await place(keys.alice, net.xrd, '40', keys.tusd, '3.9');
  const t2 = await app.solver!.tick();
  expect(t2.crossed === 2, `solver crossed them with Alice as the taker (crossed=${t2.crossed})`);
  // 1.08 XRD network fee and 0.04 XRD (0.10% of 40) set aside first; the maker fee (0.10%, in XRD) on what Bob is paid.
  // Bob is paid all the rest of the 40 XRD as a better price: 38.88 less 0.10% = 38.84112. Alice gets all 4 TUSD.
  const bobGot = (await balance(bob, net.xrd)) - bt0, aliceGot = (await balance(alice, keys.tusd)) - at0, alicePaid = ax0 - (await balance(alice, net.xrd));
  expect(Math.abs(aliceGot - 4) < 1e-9 && Math.abs(alicePaid - 40) < 1e-9, `Alice paid exactly 40 XRD and received 4 TUSD (got ${aliceGot})`);
  expect(Math.abs(bobGot - 38.84112) < 1e-9, `Bob received 38.84112 XRD (got ${bobGot})`);
  void maker; void taker;
}
expect(Math.abs((await balance(solverAccount, keys.tusd)) - solverTusdAtStart) < 1e-12, 'the solver holds no more TUSD than before: its charges were all XRD');

// A pair the solver cannot charge in XRD is refused at submission: list TUSD against a resource with no XRD pool.
{
  const OTHER = 'resource_tdx_2_1nfxxxxxxxxxxglcllrxxxxxxxxx002350006550xxxxxxxxxqtcnwk';
  app.data.markets.push({ id: `${OTHER}/${keys.tusd}`, base: { address: OTHER, symbol: 'OTHER', name: '' }, quote: { address: keys.tusd, symbol: 'TUSD', name: 'Test USD' }, pools: [], tvlUsd: 0, volume24hUsd: 0 });
  const refused = await place(keys.bob, keys.tusd, '1', OTHER, '1').then(() => '', (e) => String(e.message));
  expect(/fees are taken in XRD/.test(refused), 'an order between TUSD and a token with no route through XRD is refused: ' + refused.slice(0, 120));
}
const cancel = await fetch(`${base}/api/orders/${far.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: far.secret }) });
expect(cancel.ok, 'far order soft-cancelled');
void b;
server.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
