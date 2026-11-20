import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired';

export interface StoredOrder {
  id: string;
  account: string;
  sell: string;
  sellAmount: string;
  buy: string;
  minBuyAmount: string;
  orderKeyHex: string;
  expiresAt: number;
  createdAt: number;
  status: OrderStatus;
  signedPartialTransactionHex: string;
  fillTx: string | null;
  received: string | null;
  lastError: string | null;
  retryAt: number;
  failures: number;
}

const COLUMNS = `id, account, sell, sell_amount AS sellAmount, buy, min_buy_amount AS minBuyAmount, order_key AS orderKeyHex,
  expires_at AS expiresAt, created_at AS createdAt, status, spt_hex AS signedPartialTransactionHex,
  fill_tx AS fillTx, received, last_error AS lastError, retry_at AS retryAt, failures`;

/** Orders in SQLite. All statements are parameterised. */
export class OrderStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, sell TEXT NOT NULL, sell_amount TEXT NOT NULL,
        buy TEXT NOT NULL, min_buy_amount TEXT NOT NULL, order_key TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        spt_hex TEXT NOT NULL, fill_tx TEXT, received TEXT, last_error TEXT, retry_at INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);
      CREATE INDEX IF NOT EXISTS orders_account ON orders(account, created_at);
    `);
  }

  insert(o: Omit<StoredOrder, 'status' | 'fillTx' | 'received' | 'lastError' | 'retryAt' | 'failures'>): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO orders
      (id, account, sell, sell_amount, buy, min_buy_amount, order_key, expires_at, created_at, status, spt_hex)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(o.id, o.account, o.sell, o.sellAmount, o.buy, o.minBuyAmount, o.orderKeyHex, o.expiresAt, o.createdAt, o.signedPartialTransactionHex);
    return Number(r.changes) === 1;
  }

  get(id: string): StoredOrder | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE id = ?`).get(id) as StoredOrder | undefined;
  }

  open(): StoredOrder[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE status = 'open' ORDER BY created_at`).all() as unknown as StoredOrder[];
  }

  openCount(account: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'open' AND account = ?`).get(account) as any).n);
  }

  byAccount(account: string, limit = 200): StoredOrder[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE account = ? ORDER BY created_at DESC LIMIT ?`).all(account, limit) as unknown as StoredOrder[];
  }

  recentFills(sell: string, buy: string, limit = 50): StoredOrder[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE status = 'filled' AND ((sell = ? AND buy = ?) OR (sell = ? AND buy = ?)) ORDER BY created_at DESC LIMIT ?`)
      .all(sell, buy, buy, sell, limit) as unknown as StoredOrder[];
  }

  /** Only an open order can change state, so a filled order can never be re-opened or re-labelled. */
  private close(id: string, status: OrderStatus, fillTx: string | null, received: string | null, note: string | null = null): boolean {
    const r = this.db.prepare(`UPDATE orders SET status = ?, fill_tx = ?, received = ?, last_error = ? WHERE id = ? AND status = 'open'`).run(status, fillTx, received, note, id);
    return Number(r.changes) === 1;
  }
  markFilled(id: string, fillTx: string, received: string | null) { return this.close(id, 'filled', fillTx, received); }
  markCancelled(id: string, note: string | null = null) { return this.close(id, 'cancelled', null, null, note?.slice(0, 500) ?? null); }

  expire(nowSec: number): number {
    return Number(this.db.prepare(`UPDATE orders SET status = 'expired' WHERE status = 'open' AND expires_at <= ?`).run(nowSec).changes);
  }

  /** Returns the order's failure count after this one. */
  noteFailure(id: string, error: string, retryAt: number): number {
    this.db.prepare(`UPDATE orders SET last_error = ?, retry_at = ?, failures = failures + 1 WHERE id = ? AND status = 'open'`).run(error.slice(0, 500), retryAt, id);
    return this.get(id)?.failures ?? 0;
  }
}
