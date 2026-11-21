// Cancel any orders the test seller account still has open in the Stokenet order book
// (left behind when a test run stops half way), so they do not show on the test site.
import { readFileSync } from 'node:fs';
import { Gateway, NETWORKS, accountOf, addr, bookCancelManifest, buildTransaction, keyFromHex, readBook, readBookOrders, submitAndWait } from '../packages/core/src/index.ts';

const net = NETWORKS.stokenet;
const s = JSON.parse(readFileSync('data/stokenet-keys.json', 'utf8'));
const gw = new Gateway(net);
const key = keyFromHex(s.alice), alice = await accountOf(key, net.networkId);
const info = await readBook(gw, s.orderBook);
const orders = await readBookOrders(gw, info.ordersStore, Array.from({ length: info.nextId - 1 }, (_, i) => i + 1));
console.log(orders.length + ' orders ever placed; open: ' + (orders.filter((o) => o.open).map((o) => '#' + o.id + ' ' + o.remaining + (o.maker === alice ? ' (test)' : '')).join(', ') || 'none'));
for (const o of orders.filter((x) => x.open && x.maker === alice)) {
  const { epoch } = await gw.status();
  const tx = await buildTransaction({
    manifest: 'CALL_METHOD ' + addr(alice) + ' "lock_fee" Decimal("10");\n' + bookCancelManifest({ account: alice, book: s.orderBook, receipts: info.receipts, id: o.id }),
    window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 20 }, notary: key,
  });
  console.log('cancel #' + o.id + ': ' + (await submitAndWait(gw, tx)).status);
}
