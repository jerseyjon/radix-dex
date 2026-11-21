import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired';

export interface StoredOrder {
  id: string;
  account: string;
  sell: string;
  sellAmount: string;
  buy: string;
  minBuyAmount: string;
  /** Gross amount at which the order fills; equals the minimum on older orders. */
  limitBuyAmount: string;
  kind: 'limit' | 'market';
  orderKeyHex: string;
  expiresAt: number;
  createdAt: number;
  status: OrderStatus;
  signedPartialTransactionHex: string;
  fillTx: string | null;
  /** What the user was paid, after fees. */
  received: string | null;
  /** What the trade produced for this order before our fees and the network fee: the trade price is gross / sellAmount. */
  gross: string | null;
  /** When the fill was recorded (unix seconds). Null on fills recorded before this column existed. */
  filledAt: number | null;
  lastError: string | null;
  retryAt: number;
  failures: number;
  /** Intent hash of a transaction sent with this order whose outcome is not known yet. Never re-sent while set. */
  pendingTx: string | null;
}

/** A transaction the solver sent, kept until its outcome is known, and afterwards for the loss limit. */
export interface SentTransaction {
  intentHash: string;
  kind: 'fill' | 'book';
  /** For fills: what each order is to be recorded as receiving if it commits. */
  orders: { id: string; received: string; gross: string }[];
  /** Book order ids the transaction bought from. */
  bookIds: number[];
  status: 'pending' | 'success' | 'failure' | 'rejected';
  createdAt: number;
  /** After this (unix seconds) the transaction can no longer commit. */
  expiresAt: number;
  feeXrd: string | null;
  error: string | null;
}

const COLUMNS = `id, account, sell, sell_amount AS sellAmount, buy, min_buy_amount AS minBuyAmount,
  COALESCE(limit_buy_amount, min_buy_amount) AS limitBuyAmount, kind, order_key AS orderKeyHex,
  expires_at AS expiresAt, created_at AS createdAt, status, spt_hex AS signedPartialTransactionHex,
  fill_tx AS fillTx, received, gross, filled_at AS filledAt, last_error AS lastError, retry_at AS retryAt, failures, pending_tx AS pendingTx`;

/**
 * Orders in SQLite. All statements are parameterised. The file holds every signed order and
 * cancel-key hash, so it and its WAL are created readable by the owner only.
 */
export class OrderStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, sell TEXT NOT NULL, sell_amount TEXT NOT NULL,
        buy TEXT NOT NULL, min_buy_amount TEXT NOT NULL, order_key TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        spt_hex TEXT NOT NULL, fill_tx TEXT, received TEXT, last_error TEXT, retry_at INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        limit_buy_amount TEXT, kind TEXT NOT NULL DEFAULT 'limit'
      );
      CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);
      CREATE INDEX IF NOT EXISTS orders_account ON orders(account, created_at);
    `);
    // Databases made before a column existed: add it. Every addition is nullable or defaulted,
    // so an older server can still read the file.
    const cols = new Set((this.db.prepare('PRAGMA table_info(orders)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('failures')) this.db.exec('ALTER TABLE orders ADD COLUMN failures INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('limit_buy_amount')) this.db.exec('ALTER TABLE orders ADD COLUMN limit_buy_amount TEXT');
    if (!cols.has('kind')) this.db.exec(`ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'limit'`);
    if (!cols.has('pending_tx')) this.db.exec('ALTER TABLE orders ADD COLUMN pending_tx TEXT');
    if (!cols.has('filled_at')) this.db.exec('ALTER TABLE orders ADD COLUMN filled_at INTEGER');
    if (!cols.has('gross')) this.db.exec('ALTER TABLE orders ADD COLUMN gross TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS orders_key ON orders(order_key);
      CREATE TABLE IF NOT EXISTS transactions (
        intent_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled_at INTEGER, fee_xrd TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS transactions_status ON transactions(status, settled_at);
      CREATE TABLE IF NOT EXISTS account_failures (
        account TEXT NOT NULL, at INTEGER NOT NULL, order_id TEXT NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS account_failures_account ON account_failures(account, at);
    `);
    if (path !== ':memory:') for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  }

  close(): void {
    this.db.close();
  }

  insert(o: Omit<StoredOrder, 'status' | 'fillTx' | 'received' | 'gross' | 'filledAt' | 'lastError' | 'retryAt' | 'failures' | 'pendingTx'>): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO orders
      (id, account, sell, sell_amount, buy, min_buy_amount, order_key, expires_at, created_at, status, spt_hex, limit_buy_amount, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .run(o.id, o.account, o.sell, o.sellAmount, o.buy, o.minBuyAmount, o.orderKeyHex, o.expiresAt, o.createdAt, o.signedPartialTransactionHex, o.limitBuyAmount, o.kind);
    return Number(r.changes) === 1;
  }

  get(id: string): StoredOrder | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE id = ?`).get(id) as StoredOrder | undefined;
  }

  /** Has any stored order, in any state, used this order key? Keys are one per order. */
  orderKeyUsed(orderKeyHex: string): boolean {
    return this.db.prepare('SELECT 1 FROM orders WHERE order_key = ? LIMIT 1').get(orderKeyHex) !== undefined;
  }

  open(): StoredOrder[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE status = 'open' ORDER BY created_at, rowid`).all() as unknown as StoredOrder[];
  }

  openCount(account: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'open' AND account = ?`).get(account) as any).n);
  }

  byAccount(account: string, limit = 200): StoredOrder[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE account = ? ORDER BY created_at DESC LIMIT ?`).all(account, limit) as unknown as StoredOrder[];
  }

  recentFills(sell: string, buy: string, limit = 50): StoredOrder[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE status = 'filled' AND ((sell = ? AND buy = ?) OR (sell = ? AND buy = ?)) ORDER BY COALESCE(filled_at, created_at) DESC LIMIT ?`)
      .all(sell, buy, buy, sell, limit) as unknown as StoredOrder[];
  }

  /** Only an open order can change state, so a filled order can never be re-opened or re-labelled. */
  private close_(id: string, status: OrderStatus, fillTx: string | null, received: string | null, note: string | null = null): boolean {
    const r = this.db.prepare(`UPDATE orders SET status = ?, fill_tx = ?, received = ?, last_error = ? WHERE id = ? AND status = 'open'`).run(status, fillTx, received, note, id);
    return Number(r.changes) === 1;
  }
  markFilled(id: string, fillTx: string, received: string | null, o: { gross?: string; filledAt?: number } = {}): boolean {
    const r = this.db.prepare(`UPDATE orders SET status = 'filled', fill_tx = ?, received = ?, gross = ?, filled_at = ?, last_error = NULL, pending_tx = NULL WHERE id = ? AND status = 'open'`)
      .run(fillTx, received, o.gross ?? null, o.filledAt ?? Math.floor(Date.now() / 1000), id);
    return Number(r.changes) === 1;
  }
  /**
   * The ledger says this order filled in `fillTx`. That is the truth whatever the server thought:
   * it may have marked the order expired or cancelled meanwhile. Only a different recorded fill is kept.
   */
  markFilledFromLedger(id: string, fillTx: string, received: string | null, o: { gross?: string; filledAt?: number } = {}): boolean {
    const r = this.db.prepare(`UPDATE orders SET status = 'filled', fill_tx = ?, received = ?, gross = ?, filled_at = ?, pending_tx = NULL
      WHERE id = ? AND (status != 'filled' OR fill_tx = ?)`)
      .run(fillTx, received, o.gross ?? null, o.filledAt ?? Math.floor(Date.now() / 1000), id, fillTx);
    return Number(r.changes) === 1;
  }
  markCancelled(id: string, note: string | null = null) { return this.close_(id, 'cancelled', null, null, note?.slice(0, 500) ?? null); }

  /** Orders past their expiry. One waiting on a sent transaction is left until that transaction is settled. */
  expire(nowSec: number): number {
    return Number(this.db.prepare(`UPDATE orders SET status = 'expired' WHERE status = 'open' AND expires_at <= ? AND pending_tx IS NULL`).run(nowSec).changes);
  }

  /** Returns the order's failure count after this one. */
  noteFailure(id: string, error: string, retryAt: number): number {
    this.db.prepare(`UPDATE orders SET last_error = ?, retry_at = ?, failures = failures + 1 WHERE id = ? AND status = 'open'`).run(error.slice(0, 500), retryAt, id);
    return this.get(id)?.failures ?? 0;
  }

  /** Hold an order back until `retryAt` without counting a failure against it. */
  holdUntil(id: string, retryAt: number, note: string | null = null): void {
    this.db.prepare(`UPDATE orders SET retry_at = MAX(retry_at, ?), last_error = COALESCE(?, last_error) WHERE id = ? AND status = 'open'`).run(retryAt, note?.slice(0, 500) ?? null, id);
  }

  // ------------------------------------------------------------ sent transactions

  /** Record a transaction before it is sent, and tie its orders to it, so a crash or timeout cannot lose it. */
  recordSent(t: Omit<SentTransaction, 'status' | 'feeXrd' | 'error'>): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO transactions (intent_hash, kind, payload, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
        .run(t.intentHash, t.kind, JSON.stringify({ orders: t.orders, bookIds: t.bookIds }), t.createdAt, t.expiresAt);
      for (const o of t.orders) this.db.prepare(`UPDATE orders SET pending_tx = ? WHERE id = ?`).run(t.intentHash, o.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private rowToTx(r: any): SentTransaction {
    const p = JSON.parse(r.payload);
    return { intentHash: r.intent_hash, kind: r.kind, orders: p.orders ?? [], bookIds: p.bookIds ?? [], status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, feeXrd: r.fee_xrd, error: r.error };
  }

  pendingTransactions(): SentTransaction[] {
    return (this.db.prepare(`SELECT * FROM transactions WHERE status = 'pending' ORDER BY created_at`).all() as any[]).map((r) => this.rowToTx(r));
  }

  getTransaction(intentHash: string): SentTransaction | undefined {
    const r = this.db.prepare('SELECT * FROM transactions WHERE intent_hash = ?').get(intentHash);
    return r ? this.rowToTx(r) : undefined;
  }

  /** The transaction's outcome is known: record it and free its orders. */
  settle(intentHash: string, status: 'success' | 'failure' | 'rejected', feeXrd: string | null, error: string | null, nowSec = Math.floor(Date.now() / 1000)): void {
    this.db.prepare(`UPDATE transactions SET status = ?, fee_xrd = ?, error = ?, settled_at = ? WHERE intent_hash = ?`).run(status, feeXrd, error?.slice(0, 500) ?? null, nowSec, intentHash);
    this.db.prepare(`UPDATE orders SET pending_tx = NULL WHERE pending_tx = ?`).run(intentHash);
  }

  /** Network fees paid by transactions that failed on ledger and were settled since `sinceSec`, as decimal strings. */
  failedFeesSince(sinceSec: number): string[] {
    return (this.db.prepare(`SELECT fee_xrd FROM transactions WHERE status = 'failure' AND settled_at >= ?`).all(sinceSec) as { fee_xrd: string | null }[]).map((r) => r.fee_xrd ?? '0');
  }

  // ------------------------------------------------------------ per-account failures

  noteAccountFailure(account: string, orderId: string, error: string, nowSec = Math.floor(Date.now() / 1000)): void {
    this.db.prepare('INSERT INTO account_failures (account, at, order_id, error) VALUES (?, ?, ?, ?)').run(account, nowSec, orderId, error.slice(0, 300));
    // Old rows are of no use: keep a week.
    this.db.prepare('DELETE FROM account_failures WHERE at < ?').run(nowSec - 7 * 86400);
  }

  accountFailuresSince(account: string, sinceSec: number): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM account_failures WHERE account = ? AND at >= ?').get(account, sinceSec) as any).n);
  }
}
