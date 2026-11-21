// FIRST VERSION, KEPT ONLY TO CREATE THE TEST KEYS. It exercises the first-version manifests
// (inventoryFillManifest, crossFillManifest) that the server no longer uses; the tests of what runs
// today are stokenet-server-e2e.ts, stokenet-pool-e2e.ts and stokenet-book-e2e.ts. It is still the
// script that creates data/stokenet-keys.json, which stokenet-setup.ts and those tests need. Once key
// creation moves into stokenet-setup.ts it can be deleted.
//
// End-to-end test of subintent limit orders on Stokenet with throwaway keys.
// Usage: tsx scripts/stokenet-e2e.ts      (keys are kept in data/stokenet-keys.json, which is git-ignored)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { RadixEngineToolkit } from '@steleaio/radix-engine-toolkit';
import {
  Gateway, NETWORKS, accountOf, buildTransaction, crossFillManifest, inventoryFillManifest, keyFromHex,
  limitOrderManifest, signSubintent, submitAndWait, addr, type Ed25519Key, type IntentWindow,
} from '../packages/core/src/index.ts';

const net = NETWORKS.stokenet;
const gw = new Gateway(net);
const KEYFILE = 'data/stokenet-keys.json';
mkdirSync('data', { recursive: true });
const saved: Record<string, string> = existsSync(KEYFILE) ? JSON.parse(readFileSync(KEYFILE, 'utf8')) : {};
const save = () => writeFileSync(KEYFILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
const key = (name: string): Ed25519Key => {
  saved[name] ??= randomBytes(32).toString('hex');
  save();
  return keyFromHex(saved[name]!);
};

const faucet = (await RadixEngineToolkit.Utils.knownAddresses(net.networkId)).componentAddresses.faucet;
const window = async (expiresInSec?: number): Promise<IntentWindow> => {
  const { epoch } = await gw.status();
  return { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20, expiresAt: expiresInSec ? Math.floor(Date.now() / 1000) + expiresInSec : undefined };
};
const run = async (label: string, manifest: string, notary: Ed25519Key, children?: Parameters<typeof buildTransaction>[0]['children']) => {
  const tx = await buildTransaction({ manifest, window: await window(), notary, children });
  const out = await submitAndWait(gw, tx);
  console.log(`${label}: ${out.status}${'error' in out ? ' — ' + out.error.slice(0, 200) : ''}  ${tx.intentHashId}`);
  return { ...out, id: tx.intentHashId };
};
const balance = async (account: string, resource: string): Promise<string> => {
  const [d] = await gw.entityDetails([account]);
  return d?.fungible_resources?.items?.find((i: any) => i.resource_address === resource)?.amount ?? '0';
};
const expect = (cond: boolean, what: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) process.exitCode = 1; };

const solverKey = key('solver'), aliceKey = key('alice'), bobKey = key('bob');
const [solver, alice, bob] = (await Promise.all([solverKey, aliceKey, bobKey].map((k) => accountOf(k, net.networkId)))) as [string, string, string];
console.log({ solver, alice, bob });

// 1. Fund the three accounts from the faucet if they are short of XRD.
for (const [k, a] of [[solverKey, solver], [aliceKey, alice], [bobKey, bob]] as const) {
  if (Number(await balance(a, net.xrd)) < 2000) {
    await run(`fund ${a.slice(-6)}`, [
      `CALL_METHOD ${addr(faucet)} "lock_fee" Decimal("10");`,
      `CALL_METHOD ${addr(faucet)} "free";`,
      `CALL_METHOD ${addr(a)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") Enum<0u8>();`,
    ].join('\n'), k);
  }
}

// 2. Solver creates its badge and a test token (once).
const createToken = (supply: string, divisibility: number) => [
  `CALL_METHOD ${addr(solver)} "lock_fee" Decimal("20");`,
  `CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<0u8>() true ${divisibility}u8 Decimal("${supply}") Tuple(None, None, None, None, None, None) Tuple(Map<String, Tuple>(), Map<String, Enum>()) None;`,
  `CALL_METHOD ${addr(solver)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
].join('\n');
const newResource = async (txid: string): Promise<string> => {
  const j = await gw.post('/transaction/committed-details', { intent_hash: txid, opt_ins: { receipt_state_changes: true } });
  const found = (j.transaction?.receipt?.state_updates?.new_global_entities ?? []).find((e: any) => String(e.entity_address).startsWith('resource_'));
  if (!found) throw new Error('No new resource in receipt');
  return found.entity_address;
};
if (!saved.badge) { saved.badge = await newResource((await run('create badge', createToken('1', 0), solverKey)).id); save(); }
if (!saved.tusd) { saved.tusd = await newResource((await run('create TUSD', createToken('1000000', 18), solverKey)).id); save(); }
const { badge, tusd } = saved as { badge: string; tusd: string };
const solverId = { account: solver, badge };
console.log({ badge, tusd });

// 3. Alice signs a limit order: sell 100 XRD for at least 9 TUSD. Solver fills from inventory at 10.
{
  const before = { xrd: Number(await balance(alice, net.xrd)), tusd: Number(await balance(alice, tusd)) };
  const order = await signSubintent(
    limitOrderManifest({ account: alice, sell: net.xrd, sellAmount: '100', buy: tusd, minBuyAmount: '9', solverBadge: badge }),
    await window(600), aliceKey);
  console.log('order', order.hashId);
  const out = await run('inventory fill', inventoryFillManifest({ solver: solverId, feeLockXrd: '10', sell: net.xrd, buy: tusd, payAmount: '10' }), solverKey, { order });
  const after = { xrd: Number(await balance(alice, net.xrd)), tusd: Number(await balance(alice, tusd)) };
  expect(out.status === 'CommittedSuccess', 'order filled from solver inventory');
  expect(Math.abs(before.xrd - after.xrd - 100) < 1e-9, `Alice paid exactly 100 XRD and no fee (paid ${before.xrd - after.xrd})`);
  expect(Math.abs(after.tusd - before.tusd - 10) < 1e-9, `Alice received 10 TUSD (got ${after.tusd - before.tusd})`);
  const st = await gw.post('/transaction/subintent-status', { subintent_hash: order.hashId });
  expect(st.subintent_status === 'CommittedSuccess', `Gateway reports the subintent as ${st.subintent_status}`);

  // Replay: the same signed order must not fill twice.
  const replay = await run('replay', inventoryFillManifest({ solver: solverId, feeLockXrd: '10', sell: net.xrd, buy: tusd, payAmount: '10' }), solverKey, { order }).catch((e) => ({ status: 'Rejected', error: String(e) }));
  expect(replay.status !== 'CommittedSuccess', `replay refused (${replay.status})`);
}

// 4. Underpaying: the engine must refuse a fill below the user's minimum.
{
  const order = await signSubintent(
    limitOrderManifest({ account: alice, sell: net.xrd, sellAmount: '100', buy: tusd, minBuyAmount: '9', solverBadge: badge }),
    await window(600), aliceKey);
  const out = await run('underpay', inventoryFillManifest({ solver: solverId, feeLockXrd: '10', sell: net.xrd, buy: tusd, payAmount: '8.99' }), solverKey, { order }).catch((e) => ({ status: 'Rejected', error: String(e) }));
  expect(out.status !== 'CommittedSuccess', `fill below the minimum refused (${out.status})`);
}

// 5. Wrong wrapper: Bob (no solver badge) tries to fill Alice's order himself.
{
  const order = await signSubintent(
    limitOrderManifest({ account: alice, sell: net.xrd, sellAmount: '100', buy: tusd, minBuyAmount: '0.000001', solverBadge: badge }),
    await window(600), aliceKey);
  const manifest = [
    `CALL_METHOD ${addr(bob)} "lock_fee" Decimal("10");`,
    `YIELD_TO_CHILD NamedIntent("order");`,
    `CALL_METHOD ${addr(solver)} "withdraw" ${addr(tusd)} Decimal("0.000001");`,
    `TAKE_ALL_FROM_WORKTOP ${addr(tusd)} Bucket("out");`,
    `YIELD_TO_CHILD NamedIntent("order") Bucket("out");`,
    `CALL_METHOD ${addr(bob)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
  const out = await run('stranger fill', manifest, bobKey, { order }).catch((e) => ({ status: 'Rejected', error: String(e) }));
  expect(out.status !== 'CommittedSuccess', `fill by a wrapper without the solver badge refused (${out.status})`);
}

// 6. Two crossing orders settle against each other: Alice sells 50 XRD for >= 4 TUSD, Bob sells 5 TUSD for >= 45 XRD.
{
  if (Number(await balance(bob, tusd)) < 5) {
    await run('give Bob TUSD', [
      `CALL_METHOD ${addr(solver)} "lock_fee" Decimal("10");`,
      `CALL_METHOD ${addr(solver)} "withdraw" ${addr(tusd)} Decimal("100");`,
      `CALL_METHOD ${addr(bob)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") Enum<0u8>();`,
    ].join('\n'), solverKey);
  }
  const b0 = { ax: Number(await balance(alice, net.xrd)), at: Number(await balance(alice, tusd)), bx: Number(await balance(bob, net.xrd)), bt: Number(await balance(bob, tusd)) };
  const a = await signSubintent(limitOrderManifest({ account: alice, sell: net.xrd, sellAmount: '50', buy: tusd, minBuyAmount: '4', solverBadge: badge }), await window(600), aliceKey);
  const b = await signSubintent(limitOrderManifest({ account: bob, sell: tusd, sellAmount: '5', buy: net.xrd, minBuyAmount: '45', solverBadge: badge }), await window(600), bobKey);
  // Alice gets 4.9 of Bob's 5 TUSD, Bob gets 49 of Alice's 50 XRD; the solver keeps 0.1 TUSD and 1 XRD.
  const out = await run('cross fill', crossFillManifest({ solver: solverId, feeLockXrd: '10', x: net.xrd, y: tusd, payA: '4.9', payB: '49' }), solverKey, { order_a: a, order_b: b });
  const b1 = { ax: Number(await balance(alice, net.xrd)), at: Number(await balance(alice, tusd)), bx: Number(await balance(bob, net.xrd)), bt: Number(await balance(bob, tusd)) };
  expect(out.status === 'CommittedSuccess', 'two crossing orders settled in one transaction');
  expect(Math.abs(b0.ax - b1.ax - 50) < 1e-9 && Math.abs(b1.at - b0.at - 4.9) < 1e-9, 'Alice: -50 XRD, +4.9 TUSD');
  expect(Math.abs(b1.bx - b0.bx - 49) < 1e-9 && Math.abs(b0.bt - b1.bt - 5) < 1e-9, 'Bob: +49 XRD, -5 TUSD');
}

// 7. Expired order must not fill.
{
  const order = await signSubintent(
    limitOrderManifest({ account: alice, sell: net.xrd, sellAmount: '100', buy: tusd, minBuyAmount: '9', solverBadge: badge }),
    await window(8), aliceKey);
  await new Promise((r) => setTimeout(r, 15_000));
  const out = await run('expired', inventoryFillManifest({ solver: solverId, feeLockXrd: '10', sell: net.xrd, buy: tusd, payAmount: '10' }), solverKey, { order }).catch((e) => ({ status: 'Rejected', error: String(e) }));
  expect(out.status !== 'CommittedSuccess', `expired order refused (${out.status})`);
}
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
