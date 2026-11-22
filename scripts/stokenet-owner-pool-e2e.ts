// End-to-end on Stokenet: the real server and solver, in this process, on their own port, with an
// in-memory order store and their OWN markets file listing only XRD/TEUR on the test OwnerPool
// (scripts/stokenet-owner-pool.ts). Nothing here touches the running test site, its database, its
// markets file or the XRD/TUSD pool.
//   1. the server lists the OwnerPool, quotes it exactly as the ledger's arithmetic does, and shows depth;
//   2. a market order selling XRD for TEUR is filled by the solver through the OwnerPool;
//   3. a market order selling TEUR for XRD likewise;
// and in each fill the pool paid exactly what its quote says for what went in, the swap carried a
// minimum (`swap_with_minimum`), and the solver kept XRD only.
//
// Usage: tsx scripts/stokenet-owner-pool-e2e.ts [--data DIR]   (DIR holds stokenet-keys.json, stokenet-solver.key
// and stokenet-owner-pool.json; default data/). Throwaway Stokenet keys only.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Decimal, Gateway, NETWORKS, accountOf, keyFromHex, limitOrderManifest, orderKeyFromSecret, ownerPoolQuote, readOwnerPools, signSubintent,
} from '../packages/core/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';

const args = process.argv.slice(2);
const dataDir = (() => { const i = args.indexOf('--data'); return i >= 0 ? args[i + 1]! : 'data'; })();
const net = NETWORKS.stokenet;
const XRD = net.xrd;
const s = JSON.parse(readFileSync(`${dataDir}/stokenet-keys.json`, 'utf8'));
const op = JSON.parse(readFileSync(`${dataDir}/stokenet-owner-pool.json`, 'utf8'));
const TEUR: string = op.teur, POOL: string = op.pool;
const gw = new Gateway(net);

// This instance's own markets file: XRD/TEUR on the OwnerPool, nothing else.
const marketsFile = join(mkdtempSync(join(tmpdir(), 'owner-pool-e2e-')), 'markets.json');
writeFileSync(marketsFile, JSON.stringify({
  tokens: [{ address: XRD, symbol: 'XRD', name: 'Radix (Stokenet)' }, { address: TEUR, symbol: 'TEUR', name: 'Test euro' }],
  pools: [{ venue: 'ownerpool', address: POOL, kind: 'owner', tokens: [XRD, TEUR], feeRate: 0.003, tvlUsd: 30, volume24hUsd: 0, reserves: [0, 0] }],
}, null, 2));

const app = await createApp(loadConfig({
  DEX_NETWORK: 'stokenet', DEX_DATA_DIR: ':memory:', DEX_SOLVER_BADGE: s.badge, DEX_SOLVER_KEY_FILE: `${dataDir}/stokenet-solver.key`,
  DEX_REGISTRY: s.registry, DEX_MARKETS_FILE: marketsFile, DEX_FEE_BPS: '10', DEX_MAKER_FEE_BPS: '10',
}));
await app.data.refresh();
const server = app.api.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + (server.address() as any).port;
console.log(`separate server instance on ${base}, in-memory store, markets file ${marketsFile}`);
const expect = (cond: boolean, what: string) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + what); if (!cond) process.exitCode = 1; };
const json = async (path: string, init?: RequestInit) => (await fetch(base + path, init)).json() as Promise<any>;
const balance = async (account: string, resource: string) => new Decimal(await gw.fungibleBalance(account, resource));
const poolState = async () => (await readOwnerPools(gw, [POOL]))[0]!;

const aliceKey = keyFromHex(s.alice);
const alice = await accountOf(aliceKey, net.networkId);
const solverAccount = await app.solver!.account();

async function post(o: { sell: string; sellAmount: string; buy: string; minBuyAmount: string }) {
  const secret = randomBytes(32).toString('hex');
  const orderKeyHex = orderKeyFromSecret(secret);
  const { epoch } = await gw.status();
  const p = { account: alice, ...o };
  const signed = await signSubintent(limitOrderManifest({ ...p, solverBadge: s.badge, registry: { component: s.registry, orderKeyHex } }),
    { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 50, expiresAt: Math.floor(Date.now() / 1000) + 180 }, aliceKey);
  const res = await json('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, kind: 'market', orderKeyHex, signedPartialTransactionHex: signed.signedPartialTransactionHex }) });
  if (!res.id) throw new Error('place failed: ' + JSON.stringify(res));
  return res.id as string;
}
const stateOf = async (id: string) => (await json('/api/orders?account=' + alice)).find((x: any) => x.id === id);

/** The fill's movements from the ledger, and whether its manifest called swap_with_minimum on the pool. */
async function fillDetails(txid: string) {
  const j = await gw.post('/transaction/committed-details', { intent_hash: txid, opt_ins: { balance_changes: true, manifest_instructions: true } });
  const t = j.transaction;
  const change = (entity: string, resource: string) => (t.balance_changes?.fungible_balance_changes ?? [])
    .filter((c: any) => c.entity_address === entity && c.resource_address === resource).reduce((a: Decimal, c: any) => a.plus(c.balance_change), new Decimal(0));
  const fee = (t.balance_changes?.fungible_fee_balance_changes ?? []).filter((c: any) => c.entity_address === solverAccount && c.type === 'FeePayment')
    .reduce((a: Decimal, c: any) => a.plus(new Decimal(c.balance_change).abs()), new Decimal(0));
  return { change, fee, manifest: String(t.manifest_instructions ?? '') };
}

async function waitFilled(id: string) {
  for (let i = 0; i < 30 && (await stateOf(id))?.status === 'open'; i++) { await new Promise((r) => setTimeout(r, 1500)); await app.solver!.tick(); }
  return stateOf(id);
}

const solverTeur0 = await balance(solverAccount, TEUR);
const fees: { direction: string; txid: string; feeXrd: string; estimateXrd: string }[] = [];

// 1. Listing, quote, depth.
const markets = await json('/api/markets');
expect(markets.length === 1 && markets[0].venues[0] === 'ownerpool' && markets[0].pools[0] === POOL, 'this instance lists only XRD/TEUR, on the OwnerPool by its address');
{
  const before = await poolState();
  const q = await json(`/api/quote?sell=${XRD}&buy=${TEUR}&amount=50`);
  const local = ownerPoolQuote(before, XRD, '50');
  expect(q.buyAmount === local && q.route?.[0]?.venue === 'ownerpool', `quote for 50 XRD: ${q.buyAmount} TEUR, the OwnerPool arithmetic on its ledger state gives ${local}`);
  expect(q.networkFeeXrd === '0.46' && q.gasXrd === '0.96', `quote carries the measured swap fee ${q.networkFeeXrd} XRD; fill estimate ${q.gasXrd} XRD`);
  const depth = await json('/api/depth?market=' + encodeURIComponent(markets[0].id));
  expect(depth.bids.length === 6 && depth.asks.length === 6 && depth.bids[0].price < depth.asks[0].price, `depth from the pool: ${depth.bids.length} bids (best ${depth.bids[0]?.price}), ${depth.asks.length} asks (best ${depth.asks[0]?.price})`);
}

// 2. Market order: sell 40 XRD for TEUR. Charges are set aside from the XRD first; the rest goes through the pool.
{
  const q = await json(`/api/quote?sell=${XRD}&buy=${TEUR}&amount=40`);
  const min = new Decimal(q.buyAmount).mul(0.95).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed();
  const x0 = await balance(alice, XRD), t0 = await balance(alice, TEUR);
  const before = await poolState();
  const id = await post({ sell: XRD, sellAmount: '40', buy: TEUR, minBuyAmount: min });
  const st = await waitFilled(id);
  expect(st?.status === 'filled', `market order 40 XRD -> TEUR (min ${min}) is ${st?.status}${st?.fillTx ? ' in ' + st.fillTx : ''}`);
  if (st?.fillTx) {
    const d = await fillDetails(st.fillTx);
    const poolIn = d.change(POOL, XRD), poolOut = d.change(POOL, TEUR).neg();
    const paid = x0.minus(await balance(alice, XRD)), got = (await balance(alice, TEUR)).minus(t0);
    expect(paid.eq(40), `alice paid exactly 40 XRD (${paid})`);
    expect(got.eq(poolOut) && got.gte(min), `alice received everything the pool paid: ${got} TEUR (min ${min})`);
    expect(poolOut.toFixed() === ownerPoolQuote(before, XRD, poolIn.toFixed()), `the pool paid ${poolOut} TEUR for ${poolIn} XRD, exactly its quote for that input at the state before`);
    expect(/"swap_with_minimum"/.test(d.manifest) && !/"swap" /.test(d.manifest), 'the fill called swap_with_minimum on the pool');
    console.log('      pool call: ' + (/"swap_with_minimum"\s+Bucket\("[^"]+"\)\s+Decimal\("[^"]+"\)/.exec(d.manifest)?.[0] ?? '?').replace(/\s+/g, ' '));
    fees.push({ direction: 'XRD->TEUR', txid: st.fillTx, feeXrd: d.fee.toFixed(), estimateXrd: '0.96' });
  }
}

// 3. Market order: sell 0.02 TEUR for XRD. Charges come out of the XRD bought.
{
  const q = await json(`/api/quote?sell=${TEUR}&buy=${XRD}&amount=0.02`);
  const min = new Decimal(q.buyAmount).minus(q.gasAllowanceXrd).mul(0.95).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed();
  const x0 = await balance(alice, XRD), t0 = await balance(alice, TEUR);
  const before = await poolState();
  const id = await post({ sell: TEUR, sellAmount: '0.02', buy: XRD, minBuyAmount: min });
  const st = await waitFilled(id);
  expect(st?.status === 'filled', `market order 0.02 TEUR -> XRD (min ${min}) is ${st?.status}${st?.fillTx ? ' in ' + st.fillTx : ''}`);
  if (st?.fillTx) {
    const d = await fillDetails(st.fillTx);
    const poolIn = d.change(POOL, TEUR), poolOut = d.change(POOL, XRD).neg();
    const paid = t0.minus(await balance(alice, TEUR)), got = (await balance(alice, XRD)).minus(x0);
    // The Gateway reports fee payments apart from other balance changes: this is what the solver took from the trade.
    const kept = d.change(solverAccount, XRD);
    expect(paid.eq('0.02') && poolIn.eq('0.02'), `alice paid exactly 0.02 TEUR, all of it into the pool (${paid})`);
    expect(poolOut.toFixed() === ownerPoolQuote(before, TEUR, '0.02'), `the pool paid ${poolOut} XRD, exactly its quote at the state before`);
    expect(got.gte(min) && got.plus(kept).eq(poolOut), `alice received ${got} XRD (min ${min}); the solver took ${kept} XRD (its charges; it paid ${d.fee} XRD network fee)`);
    expect(/"swap_with_minimum"/.test(d.manifest), 'the fill called swap_with_minimum on the pool');
    console.log('      pool call: ' + (/"swap_with_minimum"\s+Bucket\("[^"]+"\)\s+Decimal\("[^"]+"\)/.exec(d.manifest)?.[0] ?? '?').replace(/\s+/g, ' '));
    fees.push({ direction: 'TEUR->XRD', txid: st.fillTx, feeXrd: d.fee.toFixed(), estimateXrd: '0.96' });
  }
}

const solverTeur = await balance(solverAccount, TEUR);
expect(solverTeur.eq(solverTeur0), `the solver holds no more TEUR than before (${solverTeur0} -> ${solverTeur})`);
for (const f of fees) console.log(`fill ${f.direction}: network fee paid ${f.feeXrd} XRD (solver's estimate ${f.estimateXrd}) ${f.txid}`);
op.e2e = { at: new Date().toISOString(), fills: fees, passed: !process.exitCode };
writeFileSync(`${dataDir}/stokenet-owner-pool.json`, JSON.stringify(op, null, 2) + '\n');
server.close();
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
process.exit();
