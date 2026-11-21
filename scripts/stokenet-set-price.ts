// Move the Stokenet test pool to a chosen XRD price (in TUSD) by swapping from the test accounts.
// Usage: tsx scripts/stokenet-set-price.ts 0.095
import { readFileSync } from 'node:fs';
import { Gateway, NETWORKS, accountOf, addr, buildTransaction, keyFromHex, submitAndWait } from '../packages/core/src/index.ts';

const target = Number(process.argv[2]);
if (!(target > 0)) throw new Error('Give the target price, for example 0.095');
const net = NETWORKS.stokenet;
const s = JSON.parse(readFileSync('data/stokenet-keys.json', 'utf8'));
const gw = new Gateway(net);
const reserves = async () => {
  const [d] = await gw.entityDetails([s.pool]);
  const f = d?.details?.state?.fields ?? [];
  const v = (name: string) => Number(f.find((x: any) => x.field_name === name)?.value);
  const aIsXrd = f.find((x: any) => x.field_name === 'resource_a')?.value === net.xrd;
  return aIsXrd ? { xrd: v('reserve_a'), tusd: v('reserve_b') } : { xrd: v('reserve_b'), tusd: v('reserve_a') };
};

for (let round = 0; round < 3; round++) {
  const r = await reserves(), price = r.tusd / r.xrd;
  console.log('pool: ' + r.xrd.toFixed(2) + ' XRD, ' + r.tusd.toFixed(2) + ' TUSD, price ' + price.toFixed(6));
  if (Math.abs(price / target - 1) < 0.001) break;
  // Constant product: at the target price the pool holds sqrt(k * target) TUSD and sqrt(k / target) XRD.
  const k = r.xrd * r.tusd, up = target > price;
  const sell = up ? s.tusd : net.xrd;
  const amount = (up ? Math.sqrt(k * target) - r.tusd : Math.sqrt(k / target) - r.xrd) * 1.004; // allow for the pool's fee
  // Whichever test account holds enough of the token pays.
  let payer: { key: ReturnType<typeof keyFromHex>; account: string } | undefined;
  for (const who of ['solver', 'alice', 'bob']) {
    const key = keyFromHex(s[who]), account = await accountOf(key, net.networkId);
    if (Number(await gw.fungibleBalance(account, sell)) >= amount + (sell === net.xrd ? 20 : 0)) { payer = { key, account }; console.log('paying from the ' + who + ' test account'); break; }
  }
  if (!payer) throw new Error('No test account holds ' + amount.toFixed(2) + ' of the token needed');
  const { epoch } = await gw.status();
  const tx = await buildTransaction({
    manifest: [
      'CALL_METHOD ' + addr(payer.account) + ' "lock_fee" Decimal("10");',
      'CALL_METHOD ' + addr(payer.account) + ' "withdraw" ' + addr(sell) + ' Decimal("' + amount.toFixed(6) + '");',
      'TAKE_ALL_FROM_WORKTOP ' + addr(sell) + ' Bucket("in");',
      'CALL_METHOD ' + addr(s.pool) + ' "swap" Bucket("in");',
      'CALL_METHOD ' + addr(payer.account) + ' "deposit_batch" Expression("ENTIRE_WORKTOP");',
    ].join('\n'),
    window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary: payer.key,
  });
  const out = await submitAndWait(gw, tx);
  console.log('swapped ' + amount.toFixed(4) + ' ' + (up ? 'TUSD' : 'XRD') + ': ' + out.status + ('error' in out ? ' ' + String(out.error).slice(0, 200) : ''));
  if (out.status !== 'CommittedSuccess') break;
}
