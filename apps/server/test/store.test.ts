import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrderStore } from '../src/store.ts';

test('a database made with the first schema is migrated in place, its rows kept, its files made private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radix-dex-store-'));
  try {
    const path = join(dir, 'orders.sqlite');
    const d = new DatabaseSync(path);
    d.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, account TEXT NOT NULL, sell TEXT NOT NULL, sell_amount TEXT NOT NULL, buy TEXT NOT NULL,
      min_buy_amount TEXT NOT NULL, order_key TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
      spt_hex TEXT NOT NULL, fill_tx TEXT, received TEXT, last_error TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO orders VALUES ('o1', 'acc', 's', '1', 'b', '2', 'key1', 99999999999, 5, 'filled', '00', 'txid_x', '2', NULL, 0);`);
    d.close();
    const s = new OrderStore(path);
    const o = s.get('o1')!;
    assert.equal(o.status, 'filled');
    assert.equal(o.failures, 0);
    assert.equal(o.kind, 'limit');
    assert.equal(o.limitBuyAmount, '2');
    assert.equal(o.pendingTx, null);
    assert.equal(o.filledAt, null);
    assert.equal(s.orderKeyUsed('key1'), true);
    assert.equal(s.orderKeyUsed('key2'), false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a transaction is recorded with its orders, which are not expired while it is in flight', () => {
  const s = new OrderStore(':memory:');
  const base = { account: 'acc', sell: 's', sellAmount: '1', buy: 'b', minBuyAmount: '1', limitBuyAmount: '1', kind: 'limit' as const, orderKeyHex: 'k', createdAt: 1, signedPartialTransactionHex: '00' };
  s.insert({ ...base, id: 'a', expiresAt: 10 });
  s.recordSent({ intentHash: 'txid_1', kind: 'fill', orders: [{ id: 'a', received: '1', gross: '1.1' }], bookIds: [], createdAt: 1, expiresAt: 100 });
  assert.equal(s.expire(50), 0, 'not expired while a transaction may still fill it');
  assert.equal(s.get('a')!.pendingTx, 'txid_1');
  s.settle('txid_1', 'failure', '0.4', 'boom', 60);
  assert.equal(s.get('a')!.pendingTx, null);
  assert.deepEqual(s.failedFeesSince(0), ['0.4']);
  assert.equal(s.expire(50), 1);
});
