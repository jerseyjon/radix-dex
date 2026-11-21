// Runs the real server in-process against Stokenet: two users post crossing orders over HTTP, the solver settles them.
// Requires data/stokenet-keys.json from scripts/stokenet-e2e.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Gateway, NETWORKS, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, signSubintent } from '../packages/core/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';

const net = NETWORKS.stokenet;
const keys = JSON.parse(readFileSync('data/stokenet-keys.json', 'utf8'));
writeFileSync('data/stokenet-solver.key', keys.solver, { mode: 0o600 });
const app = await createApp(loadConfig({ DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: keys.badge, DEX_SOLVER_KEY_FILE: 'data/stokenet-solver.key', DEX_FEE_BPS: '10' }));
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
// Bob's order arrived second, so it is the taker and carries the network fee (1.35 XRD with one maker).
// Alice gets 4 * 0.999 = 3.996 TUSD; Bob gets 40 XRD less 0.10% and the network fee = 38.61.
expect(Math.abs(after.at - before.at - 3.996) < 1e-9, `Alice received 3.996 TUSD (got ${after.at - before.at})`);
expect(Math.abs(after.bx - before.bx - 38.61) < 1e-9, `Bob received 38.61 XRD (got ${after.bx - before.bx})`);
const cancel = await fetch(`${base}/api/orders/${far.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: far.secret }) });
expect(cancel.ok, 'far order soft-cancelled');
void b;
server.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
