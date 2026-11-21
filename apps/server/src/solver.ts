import { readFileSync, statSync } from 'node:fs';
import {
  type DecodedOrder, type Ed25519Key, type Gateway, type SolverIdentity, Decimal,
  type BookOrder, type LiquidityItem, type Pool,
  GAS_SHORTFALL_TOLERANCE, accountOf, bookArbManifest, bookArbPoolFirstManifest, bookCrossManifest, buildTransaction,
  decodeSignedPartialTransaction, grossNeeded, keyFromHex, limitOf, orderKeyCancelled, payout,
  POOL_FILL_BUFFER_BPS, pickLiquidity, planBookCross, planPoolFill, takeFillManifest,
} from '@radix-dex/core';
import type { BookWatcher } from './book.ts';
import type { Config } from './config.ts';
import type { MarketData } from './marketdata.ts';
import type { OrderStore, SentTransaction, StoredOrder } from './store.ts';

/** Read the solver key from a file that only its owner can read. Never from an environment variable. */
export function loadSolverKey(path: string): Ed25519Key {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`Solver key file ${path} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  return keyFromHex(readFileSync(path, 'utf8').trim());
}

export const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

export const FEE_LOCK_XRD = '10';
/**
 * Network cost the site assumes for a fill when it has no route-specific figure (a fallback for
 * the order form only). Fills are charged what `fillGasXrd` estimates for their route, which on
 * mainnet is 1.0 to 1.4 XRD, so this errs high: a larger allowance only lowers the signed minimum.
 */
export const GAS_XRD = '1.5';
/** Margin added to a route's estimated network fee when the site works out an order's allowance (see /api/quote). */
export const GAS_ALLOWANCE_MARGIN = 1.25;
const MAX_FILL_FAILURES = 3;
/** Retries of a book purchase that failed, and of a pair that failed to cross: 1, 4, 16 minutes, then not until the order changes. */
const MAX_BOOK_FAILURES = 3;
/** A resting order whose last look found the pools paying less than this share of what it needs is looked at again only after `SKIP_FAR_MS`. */
const FAR_RATIO = 0.97, SKIP_FAR_MS = 60_000;
/** A signed order the solver could not fill because others' orders failed with it is held back this long, without counting against it. */
const HOLD_SEC = 120;
/** An order whose account no longer holds what it sells is looked at again after this long. It is not dropped: funds may come back. */
const UNFUNDED_HOLD_SEC = 600;
/** How long to wait for a sent transaction's outcome before leaving it to later passes. */
const WAIT_MS = 60_000;
/** A failed transaction whose fee the Gateway does not report is counted at this much XRD against the loss limit. */
const UNKNOWN_FAILED_FEE_XRD = '1';

/**
 * Network cost of a fill in XRD: the taker's order alone 0.7, each resting order taken 0.38, and
 * for a pool leg what that swap costs on its own (measured when it was quoted) plus 0.5 for running
 * it inside the fill. Pool kinds differ widely: on mainnet an Ociswap basic pool swap costs about
 * 0.5 and a precision pool about 0.9, and their fills cost 1.0 and 1.4.
 */
export const fillGasXrd = (items: number, poolSwapFeeXrd?: string): Decimal => {
  const taken = new Decimal('0.38').mul(items);
  if (poolSwapFeeXrd === undefined) return taken.plus('0.7');
  const n = Number(poolSwapFeeXrd);
  return taken.plus(Number.isFinite(n) && n > 0 ? poolSwapFeeXrd : '0.5').plus('0.5');
};
/**
 * Network cost in XRD of buying from a book order and selling through a pool with the solver's own
 * funds: the pool swap as measured when quoted, plus the rest. On mainnet through an Ociswap
 * precision pool (swap 0.92) these cost 1.19 and 1.30.
 */
export const arbGasXrd = (poolSwapFeeXrd: string): Decimal => {
  const n = Number(poolSwapFeeXrd);
  return new Decimal(Number.isFinite(n) && n > 0 ? poolSwapFeeXrd : '0.6').plus('0.45');
};
/** Network cost in XRD of crossing two book orders with the solver's own funds. */
export const CROSS_GAS_XRD = '1';
/** Shares of a book order the solver tries to buy with its own funds when a pool pays more than the order asks, largest first. */
const ARB_SHARES = [1, 0.5, 0.25, 0.1];

/** The best way found to fill one order now. */
interface Execution {
  /** What is taken from other traders: signed orders whole, book orders in part. */
  items: LiquidityItem[];
  /** Amount of the taker's sell token sent through pools, and the route it takes. */
  poolIn: string;
  route: Pool[];
  /** Everything the taker's sale produces, before the network fee and our fee. */
  total: Decimal;
  /** The network fee for this execution, in the token the taker buys. */
  gasInBuyToken: string;
}

/** What became of a transaction the solver tried to send. */
export type SendResult =
  /** Committed and succeeded. */
  | { kind: 'committed'; txid: string }
  /** The preview failed: nothing was sent and nothing was spent. */
  | { kind: 'previewFailed'; error: string }
  /** Committed as a failure: the network fee was paid. */
  | { kind: 'failed'; txid: string; error: string; feeXrd: string }
  /** Refused by the network: nothing was spent. */
  | { kind: 'rejected'; txid: string; error: string }
  /** Sent, outcome not known yet. Its orders stay tied to it until a later pass reads the outcome. */
  | { kind: 'pending'; txid: string }
  /** Not sent: the loss limit is reached, the solver is stopping, or the preview could not be run. */
  | { kind: 'blocked'; error: string };

interface Backoff { failures: number; retryAt: number; state: string }

/**
 * Fills open orders. Each order is tried as a taker: it takes the resting orders that give it a
 * better price than the pools, and the pools for the rest, all in one transaction.
 *
 * Every transaction is previewed in full (the exact intent and signed children) before it is sent,
 * and is not sent if the preview fails, so a fill that is bound to fail costs nothing. Network fees
 * paid on transactions that fail anyway (the ledger moved between preview and commit) are counted,
 * and past `failedFeeLimitXrd` in an hour the solver stops sending until the hour has passed.
 */
export class Solver {
  private readonly config: Config;
  private readonly gateway: Gateway;
  private readonly store: OrderStore;
  private readonly data: MarketData;
  private readonly key: Ed25519Key;
  private readonly badge: string;
  private identity: SolverIdentity | undefined;
  private readonly divisibilities = new Map<string, number>();
  private readonly book: BookWatcher | undefined;
  /** Book orders and crossing pairs that failed: left alone until `retryAt`, and for good after a few failures until the order changes. */
  private readonly bookBackoff = new Map<string, Backoff>();
  /** Order keys seen cancelled or live in the registry, and when. */
  private readonly keyChecks = new Map<string, { at: number; cancelled: boolean | undefined }>();
  private running: Promise<TickResult> | undefined;
  private marketQueued = false;
  private stopped = false;
  private restingCursor = 0;
  /** Per open order: what the pools would pay it right now after the network fee, and what it needs. */
  readonly outlook = new Map<string, { available: string; needed: string; at: number }>();

  // For /api/health and the logs. A new solver counts as having just finished a pass.
  lastTickAt = Date.now();
  lastTickMs = 0;
  lastXrd: { at: number; amount: string } | undefined;
  breaker = { open: false, failedFeesXrd: '0', since: 0 };
  private gatewayFailuresLogged = 0;
  private gatewayLogAt = 0;
  private quoteErrorsSeen = 0;

  private readonly pollMs: number;
  private readonly waitMs: number;

  /** `timing` is for tests: how often to ask for a sent transaction's status, and for how long. */
  constructor(o: { config: Config; gateway: Gateway; store: OrderStore; data: MarketData; key: Ed25519Key; badge: string; book?: BookWatcher; timing?: { pollMs?: number; waitMs?: number } }) {
    this.book = o.book;
    this.pollMs = o.timing?.pollMs ?? 1500;
    this.waitMs = o.timing?.waitMs ?? WAIT_MS;
    this.config = o.config; this.gateway = o.gateway; this.store = o.store; this.data = o.data; this.key = o.key; this.badge = o.badge;
  }

  async account(): Promise<string> {
    this.identity ??= { account: await accountOf(this.key, this.config.network.networkId), badge: this.badge };
    return this.identity.account;
  }

  private async loadDivisibility(resources: string[]): Promise<void> {
    const missing = [...new Set(resources)].filter((r) => !this.divisibilities.has(r));
    if (!missing.length) return;
    for (const d of await this.gateway.entityDetails(missing)) {
      const div = d?.details?.divisibility;
      if (typeof div === 'number') this.divisibilities.set(d.address, div);
    }
  }
  private divisibility = (resource: string): number => {
    const d = this.divisibilities.get(resource);
    if (d === undefined) throw new Error(`Divisibility of ${resource} unknown`);
    return d;
  };

  private async balance(account: string, resource: string): Promise<Decimal> {
    return new Decimal(await this.gateway.fungibleBalance(account, resource));
  }

  /** What the solver may spend of `resource`: all of it, except that XRD needed for the fee lock and its margin stays put. */
  private async spendable(resource: string): Promise<Decimal> {
    const have = await this.balance(this.identity!.account, resource);
    if (resource !== this.config.network.xrd) return have;
    this.lastXrd = { at: Date.now(), amount: have.toFixed() };
    return Decimal.max(0, have.minus(FEE_LOCK_XRD).minus(1));
  }

  private async window() {
    const { epoch } = await this.gateway.status();
    return { networkId: this.config.network.networkId, startEpoch: epoch, endEpoch: epoch + 10, expiresAt: Math.floor(Date.now() / 1000) + 120 };
  }

  private decode(o: StoredOrder): Promise<DecodedOrder> {
    return decodeSignedPartialTransaction(o.signedPartialTransactionHex, this.config.network.networkId);
  }

  /** Has the account still got what the order sells? If not, the fill would fail. */
  private async funded(o: StoredOrder): Promise<boolean> {
    return (await this.balance(o.account, o.sell)).gte(o.sellAmount);
  }

  /** Is this order's key cancelled in the registry? Asked at most once a minute per key. */
  private async keyCancelled(o: StoredOrder): Promise<boolean | undefined> {
    if (!this.config.registry) return false;
    const hit = this.keyChecks.get(o.orderKeyHex);
    // A cancelled key stays cancelled for good.
    if (hit && (hit.cancelled === true || Date.now() - hit.at < 60_000)) return hit.cancelled;
    const cancelled = await orderKeyCancelled(this.gateway, this.config.registry, o.orderKeyHex);
    this.keyChecks.set(o.orderKeyHex, { at: Date.now(), cancelled });
    if (this.keyChecks.size > 5000) for (const [k, v] of this.keyChecks) if (Date.now() - v.at > 600_000) this.keyChecks.delete(k);
    return cancelled;
  }

  // ------------------------------------------------------------ loss limit

  /** Sum the fees of failed transactions in the last hour and open or close the breaker. Logs loudly on each change. */
  private updateBreaker(nowSec = Math.floor(Date.now() / 1000)): boolean {
    const fees = this.store.failedFeesSince(nowSec - 3600).reduce((a, f) => a.plus(f), new Decimal(0));
    const open = fees.gte(this.config.failedFeeLimitXrd);
    if (open && !this.breaker.open) {
      console.error(`[solver] !!! LOSS LIMIT REACHED: ${fees.toFixed(4)} XRD paid on failed transactions in the last hour (limit ${this.config.failedFeeLimitXrd}). NOT SENDING ANY TRANSACTION until it falls below the limit. Check the log above for what failed.`);
      this.breaker.since = Date.now();
    } else if (!open && this.breaker.open) {
      console.warn(`[solver] loss limit cleared: ${fees.toFixed(4)} XRD of failed fees in the last hour; sending again`);
    }
    this.breaker.open = open;
    this.breaker.failedFeesXrd = fees.toFixed();
    return open;
  }

  // ------------------------------------------------------------ sending

  /**
   * Build, preview, record, submit and wait. Only a successful preview of the exact transaction
   * leads to a submission. The transaction is recorded (with what its orders will receive) before
   * it is sent, so its outcome is never lost: a timeout, a status error or a restart leaves it
   * pending, and `reconcile` settles it from the ledger later.
   */
  private async send(manifest: string, children: Record<string, DecodedOrder>, record: { kind: 'fill' | 'book'; orders: { id: string; received: string; gross: string }[]; bookIds: number[] }): Promise<SendResult> {
    if (this.stopped) return { kind: 'blocked', error: 'solver is stopping' };
    if (this.breaker.open || this.updateBreaker()) return { kind: 'blocked', error: 'loss limit reached' };
    const window = await this.window();
    const tx = await buildTransaction({ manifest, window, notary: this.key, children });
    let preview;
    try {
      preview = await this.gateway.previewV2(tx.previewHex);
    } catch (e) {
      return { kind: 'blocked', error: `preview could not be run: ${errText(e)}` };
    }
    if (!preview.ok) return { kind: 'previewFailed', error: `preview ${preview.status}: ${preview.error ?? ''}` };
    this.store.recordSent({ intentHash: tx.intentHashId, kind: record.kind, orders: record.orders, bookIds: record.bookIds, createdAt: Math.floor(Date.now() / 1000), expiresAt: window.expiresAt });
    try {
      await this.gateway.submitTransaction(tx.hex);
    } catch (e) {
      // It may have reached the network all the same: leave it pending, and let the ledger say.
      console.warn(`[solver] submit of ${tx.intentHashId} gave an error; outcome left to the ledger: ${errText(e)}`);
      return { kind: 'pending', txid: tx.intentHashId };
    }
    const started = Date.now();
    while (Date.now() - started < this.waitMs) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      let s;
      try { s = await this.gateway.transactionStatus(tx.intentHashId); } catch { continue; }
      if (s.status === 'Pending') continue;
      return this.settle(this.store.getTransaction(tx.intentHashId)!, s.status, s.error ?? '');
    }
    console.warn(`[solver] ${tx.intentHashId}: no outcome after ${this.waitMs / 1000} s; left pending`);
    return { kind: 'pending', txid: tx.intentHashId };
  }

  /** Record a known outcome: fills from the ledger, the fee of a failure, and free the orders. */
  private async settle(t: SentTransaction, status: 'CommittedSuccess' | 'CommittedFailure' | 'Rejected', error: string): Promise<SendResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (status === 'CommittedSuccess') {
      for (const o of t.orders) {
        if (!this.store.markFilledFromLedger(o.id, t.intentHash, o.received, { gross: o.gross, filledAt: nowSec })) continue;
      }
      this.store.settle(t.intentHash, 'success', null, null, nowSec);
      return { kind: 'committed', txid: t.intentHash };
    }
    if (status === 'Rejected') {
      this.store.settle(t.intentHash, 'rejected', '0', error, nowSec);
      return { kind: 'rejected', txid: t.intentHash, error };
    }
    const fee = (await this.gateway.committedFee(t.intentHash).catch(() => undefined)) ?? UNKNOWN_FAILED_FEE_XRD;
    this.store.settle(t.intentHash, 'failure', fee, error, nowSec);
    console.warn(`[solver] ${t.intentHash} FAILED on ledger, ${fee} XRD of network fee lost: ${error.slice(0, 200)}`);
    this.updateBreaker(nowSec);
    return { kind: 'failed', txid: t.intentHash, error, feeXrd: fee };
  }

  /**
   * Settle transactions whose outcome was not known when they were sent. A transaction still
   * unknown after its expiry can no longer commit, so it is settled as never committed.
   */
  async reconcile(): Promise<void> {
    for (const t of this.store.pendingTransactions()) {
      let s;
      try { s = await this.gateway.transactionStatus(t.intentHash); } catch { continue; }
      const nowSec = Math.floor(Date.now() / 1000);
      let status: 'CommittedSuccess' | 'CommittedFailure' | 'Rejected', error = s.error ?? '';
      if (s.status === 'Pending') {
        if (nowSec <= t.expiresAt + 60) continue;
        status = 'Rejected'; error = 'expired without committing';
      } else status = s.status;
      const res = await this.settle(t, status, error);
      console.log(`[solver] settled ${t.intentHash} from the ledger: ${res.kind}${'error' in res ? ' (' + res.error.slice(0, 120) + ')' : ''}`);
      if (res.kind === 'failed' || res.kind === 'rejected') {
        // Without the full picture there is no evidence against the resting orders: only an order filled alone is charged.
        const orders = t.orders.map((o) => this.store.get(o.id)).filter((o): o is StoredOrder => !!o);
        if (orders.length === 1 && t.bookIds.length === 0 && res.kind === 'failed') this.fail(orders, res.error);
        else for (const o of orders) this.store.holdUntil(o.id, nowSec + HOLD_SEC, res.error);
        for (const id of t.bookIds) this.backoff(`book:${id}`, '', res.error);
      }
    }
  }

  // ------------------------------------------------------------ failures

  /**
   * Record a failed fill against these orders. Retries back off (1, 4, 16 minutes) and the order is
   * dropped after the third. The account is charged as well: past `accountFailureLimit` in a day it
   * may not post orders, so fresh orders built to fail do not get round the per-order limit.
   */
  private fail(orders: StoredOrder[], error: string): void {
    const now = Math.floor(Date.now() / 1000);
    for (const o of orders) {
      const failures = this.store.noteFailure(o.id, error, now + 60 * 4 ** Math.min(o.failures, 5));
      this.store.noteAccountFailure(o.account, o.id, error, now);
      if (failures >= MAX_FILL_FAILURES) this.store.markCancelled(o.id, `Dropped after ${failures} failed fills: ${error}`);
    }
    console.warn(`[solver] ${orders.map((o) => o.id.slice(-8)).join('+')}: ${error.slice(0, 200)}`);
  }

  /** Has this account failed too often lately to be served? */
  private accountBarred(account: string, nowSec: number, cache: Map<string, boolean>): boolean {
    let v = cache.get(account);
    if (v === undefined) { v = this.store.accountFailuresSince(account, nowSec - 86400) >= this.config.accountFailureLimit; cache.set(account, v); }
    return v;
  }

  private backoff(key: string, state: string, error: string): void {
    const b = this.bookBackoff.get(key) ?? { failures: 0, retryAt: 0, state };
    b.failures += 1; b.state = state || b.state;
    b.retryAt = b.failures >= MAX_BOOK_FAILURES ? Infinity : Date.now() + 60_000 * 4 ** (b.failures - 1);
    this.bookBackoff.set(key, b);
    console.warn(`[solver] ${key} failed (${b.failures}${b.retryAt === Infinity ? ', left alone until it changes' : ''}): ${error.slice(0, 200)}`);
  }
  /** May this book order, or pair, be tried now? A changed order starts afresh. */
  private mayTry(key: string, state: string): boolean {
    const b = this.bookBackoff.get(key);
    if (!b) return true;
    if (b.state && b.state !== state) { this.bookBackoff.delete(key); return true; }
    return b.retryAt <= Date.now();
  }

  /** The network fee, which the solver pays in XRD, valued in `resource`. Undefined if no pool prices that token. */
  private gasIn(resource: string, gasXrd: Decimal): Promise<string | undefined> {
    return this.data.xrdValueIn(resource, gasXrd);
  }

  /**
   * Best execution for `taker`: with nothing taken from other traders (pools only), then with the
   * cheapest one, two… of their orders, keeping whichever leaves the taker most after the network fee.
   * Returns undefined if no plan can be made, or if a quote failed with an error (the Gateway, not
   * the market, is the problem: better to wait than to fill on a partial picture).
   */
  private async bestExecution(taker: StoredOrder, resting: StoredOrder[], book: BookOrder[], nowSec: number): Promise<Execution | undefined> {
    const xrd = this.config.network.xrd;
    const candidates = pickLiquidity(taker, resting, book, this.config.makerFeeBps, this.divisibility, nowSec);
    let best: Execution | undefined;
    for (let k = 0; k <= candidates.length; k++) {
      let items = candidates.slice(0, k);
      const fromOthers = items.reduce((sum, m) => sum.plus(m.gives), new Decimal(0));
      const left = items.reduce((rest, m) => rest.minus(m.cost), new Decimal(taker.sellAmount));
      let total = fromOthers, route: Pool[] = [], poolIn = '0', swapFee: string | undefined;
      if (left.gt(0)) {
        const errorsBefore = this.data.quoter.errors;
        const quote = await this.data.quoter.best(this.data.pools, taker.sell, taker.buy, left.toFixed(), xrd).catch(() => undefined);
        if (!quote && this.data.quoter.errors > errorsBefore) return undefined;
        // A pool that would hand back part of the input (out of liquidity) is no route: the unswapped part would be lost to the user.
        if (quote && new Decimal(quote.sellAmount).gte(left)) { total = total.plus(quote.buyAmount); route = quote.route; poolIn = left.toFixed(); swapFee = quote.networkFeeXrd; }
        else {
          // No pool for the remainder. A signed order can be given it as a better price;
          // a book order cannot, and the taker cannot be handed it back, so that plan is out.
          const i = items.findIndex((m) => m.kind === 'order');
          const first = items[i];
          if (!first || first.kind !== 'order') { if (left.gt(new Decimal(taker.sellAmount).mul('1e-9'))) continue; }
          else {
            const cost = new Decimal(first.cost).plus(left);
            const pay = payout(cost, new Decimal(first.order.minBuyAmount), this.config.makerFeeBps, this.divisibility(taker.sell))!;
            items = items.map((m, j) => (j === i ? { ...first, cost: cost.toFixed(), pay: pay.toFixed() } : m));
          }
        }
      }
      // Each order taken adds to the network fee the taker pays, so compare what is left after it.
      const gasXrd = fillGasXrd(items.length, route.length > 0 ? swapFee ?? '0.5' : undefined);
      const gasInBuyToken = await this.gasIn(taker.buy, gasXrd);
      if (gasInBuyToken === undefined) continue; // the fee cannot be charged in this token: do not fill for nothing
      if (!best || total.minus(gasInBuyToken).gt(best.total.minus(best.gasInBuyToken))) best = { items, poolIn, route, total, gasInBuyToken };
    }
    return best;
  }

  /**
   * One attempt to fill `o` as a taker, leaving out the given resting orders and book orders.
   * `noPlan`: nothing to do now. `dead`: an order involved was cancelled on ledger and has been closed.
   */
  private async fillOnce(o: StoredOrder, open: StoredOrder[], liveBook: BookOrder[], now: number, done: Set<string>, skip: { orders: Set<string>; book: Set<number> }):
    Promise<{ kind: 'noPlan' } | { kind: 'dead' } | { kind: 'unfunded' } | { kind: 'sent'; res: SendResult; makers: StoredOrder[]; bookIds: number[]; exec: Execution }> {
    const resting = open.filter((m) => m.kind !== 'market' && !done.has(m.id) && !skip.orders.has(m.id) && m.pendingTx === null && m.retryAt <= now);
    const book = liveBook.filter((b) => !skip.book.has(b.id));
    // Orders can arrive during a pass: make sure every token in play is known (cached after the first time).
    await this.loadDivisibility([o, ...resting, ...book].flatMap((x) => [x.sell, x.buy]));
    const exec = await this.bestExecution(o, resting, book, now);
    if (!exec) { this.outlook.delete(o.id); return { kind: 'noPlan' }; }
    const { gasInBuyToken } = exec;
    // With no pool leg the outcome is exact, so no margin is needed.
    const terms = { minBuyAmount: o.minBuyAmount, limitBuyAmount: limitOf(o).toFixed(), gasInBuyToken, bufferBps: exec.route.length ? undefined : 0, gasShortfall: GAS_SHORTFALL_TOLERANCE };
    this.outlook.set(o.id, { available: exec.total.toFixed(), needed: grossNeeded(terms).toFixed(), at: Date.now() });
    const plan = planPoolFill({ ...terms, quotedOut: exec.total.toFixed(), feeBps: this.config.feeBps, divisibility: this.divisibility(o.buy) });
    if (!plan) return { kind: 'noPlan' };
    const makerItems = exec.items.filter((m) => m.kind === 'order');
    const bookItems = exec.items.filter((m) => m.kind === 'book');
    const makers = makerItems.map((m) => m.order as StoredOrder);
    const involved = [o, ...makers];
    // A key cancelled on ledger will never fill: close the order now, whoever it belongs to.
    let dead = false;
    for (const x of involved) {
      if ((await this.keyCancelled(x)) === true) { this.store.markCancelled(x.id, 'Cancelled on ledger (its order key was revoked in the registry)'); console.log(`[solver] ${x.id.slice(-8)}: order key cancelled on ledger; order closed`); dead = true; }
    }
    if (dead) return { kind: 'dead' };
    let unfunded = false;
    for (const x of involved) {
      if (!(await this.funded(x))) { this.store.holdUntil(x.id, now + UNFUNDED_HOLD_SEC, 'account does not hold the sell amount at the moment'); unfunded = true; }
    }
    if (unfunded) return { kind: 'unfunded' };
    const children: Record<string, DecodedOrder> = { taker: await this.decode(o) };
    for (const [i, m] of makers.entries()) children[`maker_${i}`] = await this.decode(m);
    const res = await this.send(
      takeFillManifest({
        solver: this.identity!, feeLockXrd: FEE_LOCK_XRD, sell: o.sell, buy: o.buy, makerPays: makerItems.map((m) => m.pay), poolIn: exec.poolIn, route: exec.route, solverTake: plan.solverTake,
        bookFills: bookItems.map((m) => ({ book: this.book!.component, id: m.order.id, pay: m.cost })),
        assertBought: bookItems.length ? exec.items.reduce((sum, m) => sum.plus(m.gives), new Decimal(0)).toFixed() : undefined,
      }),
      children,
      {
        kind: 'fill', bookIds: bookItems.map((m) => m.order.id),
        // The taker's trade produced `total` before fees; a maker's produced its cost (its price, before the maker fee).
        orders: [{ id: o.id, received: plan.userReceives, gross: exec.total.toFixed() }, ...makerItems.map((m) => ({ id: (m.order as StoredOrder).id, received: m.pay, gross: m.cost }))],
      });
    return { kind: 'sent', res, makers, bookIds: bookItems.map((m) => m.order.id), exec };
  }

  /**
   * Fill one taker. When a fill that used other traders' orders fails (in preview or on ledger),
   * the cause may lie with any of them, and most often with the taker, so the resting orders are
   * not charged with it on that evidence alone. They are held back briefly and the taker is tried
   * again at once without them. Only if the taker then fills is a lone resting order charged with
   * the failure; if the taker fails again, the failure is the taker's.
   */
  private async fillTaker(o: StoredOrder, open: StoredOrder[], liveBook: BookOrder[], now: number, done: Set<string>, result: TickResult): Promise<void> {
    const skip = { orders: new Set<string>(), book: new Set<number>() };
    const first = await this.fillOnce(o, open, liveBook, now, done, skip);
    if (first.kind !== 'sent') return;
    const settled = (a: typeof first) => this.afterSend(o, a, done, result);
    if (await settled(first)) return;
    const err = 'error' in first.res ? first.res.error : '';
    if (first.res.kind !== 'previewFailed' && first.res.kind !== 'failed') return;
    if (!first.makers.length && !first.bookIds.length) { this.fail([o], err); return; }
    for (const m of first.makers) { this.store.holdUntil(m.id, now + HOLD_SEC, null); skip.orders.add(m.id); }
    for (const id of first.bookIds) skip.book.add(id);
    const second = await this.fillOnce(o, open, liveBook, now, done, skip);
    if (second.kind !== 'sent') {
      // The taker cannot be filled without them: no evidence either way. Hold the taker too, without charging anyone.
      if (second.kind === 'noPlan') this.store.holdUntil(o.id, now + HOLD_SEC, `fill with other orders failed: ${err}`);
      return;
    }
    if (await settled(second)) {
      // The taker filled without them, so the failure lay with what was left out. Charge it only where it is certain.
      if (first.makers.length === 1 && first.bookIds.length === 0) this.fail(first.makers, err);
      else if (first.makers.length === 0 && first.bookIds.length === 1) {
        const b = liveBook.find((x) => x.id === first.bookIds[0]);
        this.backoff(`book:${first.bookIds[0]}`, b?.remaining ?? '', err);
      }
      return;
    }
    // Failing again without them puts the fault with the taker. The resting orders were only held back briefly, uncharged.
    if (second.res.kind === 'previewFailed' || second.res.kind === 'failed') this.fail([o], second.res.error);
  }

  /** Book-keeping after a fill was sent. True if it committed. */
  private async afterSend(o: StoredOrder, a: { res: SendResult; makers: StoredOrder[]; bookIds: number[]; exec: Execution }, done: Set<string>, result: TickResult): Promise<boolean> {
    const involved = [o, ...a.makers];
    // Whatever happened, the book is no longer as it was read.
    if (a.bookIds.length && a.res.kind !== 'previewFailed' && a.res.kind !== 'blocked') await this.book?.refresh().catch(() => undefined);
    if (a.res.kind === 'pending') { involved.forEach((x) => done.add(x.id)); return false; }
    if (a.res.kind === 'rejected') { for (const x of involved) this.store.holdUntil(x.id, Math.floor(Date.now() / 1000) + HOLD_SEC, a.res.error); involved.forEach((x) => done.add(x.id)); return false; }
    if (a.res.kind !== 'committed') return false;
    involved.forEach((x) => done.add(x.id));
    if (a.exec.items.length) result.crossed += involved.length; else result.poolFilled += 1;
    const took = [...a.makers.map((m) => m.id.slice(-8)), ...a.bookIds.map((id) => `book order ${id}`)];
    console.log(`[solver] filled ${o.kind} ${o.id.slice(-8)} (${o.sellAmount} ${this.symbol(o.sell)} for at least ${o.minBuyAmount} ${this.symbol(o.buy)})${took.length ? ' against ' + took.join('+') : ''}${a.exec.route.length ? ' through ' + a.exec.route.map((p) => p.venue).join('>') : ''} in ${a.res.txid}`);
    return true;
  }

  private symbol(resource: string): string {
    return this.data.symbol?.(resource) ?? resource.slice(0, 14) + '…';
  }

  /**
   * A book order is paid its price and nothing more, so when a pool pays more than it asks the
   * solver buys from it with its own funds and sells through the pool, keeping the difference.
   * That is what fills a resting order when the market reaches its price.
   */
  private async arbitrage(b: BookOrder): Promise<SendResult | undefined> {
    const xrd = this.config.network.xrd;
    const solver = this.identity!;
    const sellDiv = this.divisibility(b.sell), buyDiv = this.divisibility(b.buy);
    const record = { kind: 'book' as const, orders: [], bookIds: [b.id] };
    const attempt = async (share: number, mustCoverGas: boolean) => {
      const q = new Decimal(b.remaining).mul(share).toDecimalPlaces(sellDiv, Decimal.ROUND_DOWN);
      if (!q.gt(0)) return undefined;
      const quote = await this.data.quoter.best(this.data.pools, b.sell, b.buy, q.toFixed(), xrd).catch(() => undefined);
      if (!quote || new Decimal(quote.sellAmount).lt(q)) return undefined;
      const cost = q.mul(b.price).toDecimalPlaces(buyDiv, Decimal.ROUND_UP);
      const priced = mustCoverGas ? await this.gasIn(b.buy, arbGasXrd(quote.networkFeeXrd)) : '0';
      if (priced === undefined) return undefined;
      const gas = new Decimal(priced);
      // The pool can move before the transaction runs, so it must also bring back the network fee or fail.
      const minBack = cost.plus(gas).toDecimalPlaces(buyDiv, Decimal.ROUND_UP);
      return new Decimal(quote.buyAmount).mul(10_000 - POOL_FILL_BUFFER_BPS).div(10_000).gt(minBack) ? { q, cost, minBack, route: quote.route } : undefined;
    };
    // One cheap look first: if even a small part does not sell for more than it costs, nothing will.
    if (!(await attempt(ARB_SHARES[ARB_SHARES.length - 1]!, false))) return undefined;
    const float = await this.spendable(b.buy);
    for (const share of ARB_SHARES) {
      const plan = await attempt(share, true);
      if (!plan || plan.cost.gt(float)) continue;
      const res = await this.send(bookArbManifest({
        solver, feeLockXrd: FEE_LOCK_XRD, book: this.book!.component, id: b.id, payResource: b.buy, pay: plan.cost.toFixed(),
        boughtResource: b.sell, route: plan.route, minBack: plan.minBack.toFixed(),
      }), {}, record);
      if (res.kind === 'committed') console.log(`[solver] bought ${plan.q.toFixed()} ${this.symbol(b.sell)} from book order ${b.id} and sold it through ${plan.route.map((p) => p.venue).join('>')} in ${res.txid}`);
      return res;
    }

    // Not enough of the token the order wants (a solver that holds only XRD, say). Do it the other
    // way round with the token the order sells: sell some through the pool, pay the proceeds into
    // the order, and end with more of that token than it started with.
    const start = await this.spendable(b.sell);
    for (const share of ARB_SHARES) {
      const x = new Decimal(b.remaining).mul(share).toDecimalPlaces(sellDiv, Decimal.ROUND_DOWN);
      if (!x.gt(0) || x.gt(start)) continue;
      const quote = await this.data.quoter.best(this.data.pools, b.sell, b.buy, x.toFixed(), xrd).catch(() => undefined);
      if (!quote || new Decimal(quote.sellAmount).lt(x)) continue;
      // What the pool's proceeds buy from the order, by the component's own sum.
      const back = Decimal.min(new Decimal(quote.buyAmount).div(b.price).toDecimalPlaces(sellDiv, Decimal.ROUND_DOWN), b.remaining);
      const gasPriced = await this.gasIn(b.sell, arbGasXrd(quote.networkFeeXrd));
      if (gasPriced === undefined) return undefined;
      const minBack = x.plus(gasPriced).toDecimalPlaces(sellDiv, Decimal.ROUND_UP);
      if (!back.mul(10_000 - POOL_FILL_BUFFER_BPS).div(10_000).gt(minBack)) continue;
      const res = await this.send(bookArbPoolFirstManifest({
        solver, feeLockXrd: FEE_LOCK_XRD, book: this.book!.component, id: b.id, startResource: b.sell, sellIn: x.toFixed(),
        payResource: b.buy, route: quote.route, minBack: minBack.toFixed(),
      }), {}, record);
      if (res.kind === 'committed') console.log(`[solver] sold ${x.toFixed()} ${this.symbol(b.sell)} through ${quote.route.map((p) => p.venue).join('>')} and bought ${back.toFixed()} from book order ${b.id} in ${res.txid}`);
      return res;
    }
    return undefined;
  }

  /** Book orders worth too little to pay for a purchase's network fee are not bought with the solver's own funds. */
  private bookWorthBuying(b: BookOrder): boolean {
    const xrd = this.config.network.xrd;
    if (b.sell === xrd) return new Decimal(b.remaining).gte(this.config.minBookOrderXrd);
    if (b.buy === xrd) return new Decimal(b.remaining).mul(b.price).gte(this.config.minBookOrderXrd);
    return true;
  }

  /**
   * Ask the running pass to serve market orders at its next opportunity, or start one. Market
   * orders never wait behind resting orders for more than one fill.
   */
  kick(): void {
    if (this.running) { this.marketQueued = true; return; }
    void this.tick().catch((e) => console.error('[solver] tick failed:', e));
  }

  /** Stop sending, and wait for the pass in progress (if any) to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
  }

  /** One pass over the open orders. Safe to call on a timer; overlapping calls are skipped. */
  tick(): Promise<TickResult> {
    if (this.running) { this.marketQueued = true; return Promise.resolve({ crossed: 0, poolFilled: 0, bookBought: 0, bookCrossed: 0 }); }
    const started = Date.now();
    this.running = this.pass().finally(() => {
      this.running = undefined;
      this.lastTickAt = Date.now();
      this.lastTickMs = this.lastTickAt - started;
      this.logGatewayTrouble();
    });
    return this.running;
  }

  /** Gateway trouble is logged at most once every five minutes, with a count, rather than per call or not at all. */
  private logGatewayTrouble(): void {
    const g = this.gateway.failures, q = this.data.quoter.errors;
    if ((g === this.gatewayFailuresLogged && q === this.quoteErrorsSeen) || Date.now() - this.gatewayLogAt < 300_000) return;
    console.warn(`[gateway] ${g - this.gatewayFailuresLogged} failed call(s) and ${q - this.quoteErrorsSeen} failed quote(s) since the last report; last: ${this.gateway.lastFailure?.path ?? ''} ${this.gateway.lastFailure?.message ?? this.data.quoter.lastFailure ?? ''}`);
    this.gatewayFailuresLogged = g; this.quoteErrorsSeen = q; this.gatewayLogAt = Date.now();
  }

  private async pass(): Promise<TickResult> {
    const result: TickResult = { crossed: 0, poolFilled: 0, bookBought: 0, bookCrossed: 0 };
    if (this.stopped) return result;
    await this.reconcile();
    const now = Math.floor(Date.now() / 1000);
    this.store.expire(now + 15); // leave time for the fill to commit
    this.updateBreaker(now);
    if (this.breaker.open) return result;
    const all = this.store.open();
    const openIds = new Set(all.map((o) => o.id));
    for (const id of this.outlook.keys()) if (!openIds.has(id)) this.outlook.delete(id);
    const barred = new Map<string, boolean>();
    // Only orders between the tokens of a listed market, from accounts not failing too often, with nothing in flight.
    const eligible = (o: StoredOrder) => o.pendingTx === null && this.data.isListedPair(o.sell, o.buy) && !this.accountBarred(o.account, now, barred);
    const usable = all.filter(eligible);
    await this.book?.refresh().catch((e) => console.warn('[solver] order book not read:', errText(e)));
    const pendingBook = new Set(this.store.pendingTransactions().flatMap((t) => t.bookIds));
    // Book orders in listed markets only, not in a transaction in flight, and with a margin before expiry
    // so a purchase does not arrive a moment too late.
    const liveBook = () => (this.book?.live(now + 30) ?? [])
      .filter((b) => this.data.isListedPair(b.sell, b.buy) && !pendingBook.has(b.id) && this.mayTry(`book:${b.id}`, b.remaining));
    const markets = () => this.store.open().filter((o) => o.kind === 'market' && o.retryAt <= Math.floor(Date.now() / 1000) && eligible(o)).reverse();
    if (!usable.length && !liveBook().length) return result;
    await this.account();
    if (!this.lastXrd || Date.now() - this.lastXrd.at > 60_000) await this.spendable(this.config.network.xrd).catch(() => undefined);
    await this.loadDivisibility([...usable, ...liveBook()].flatMap((o) => [o.sell, o.buy]));
    const done = new Set<string>();

    // Market orders first, newest first: they are short-lived and the user is waiting.
    const serveMarket = async () => {
      this.marketQueued = false;
      for (const o of markets()) {
        if (done.has(o.id) || this.stopped) continue;
        try { await this.fillTaker(o, this.store.open().filter(eligible), liveBook(), Math.floor(Date.now() / 1000), done, result); } catch (e) { console.warn(`[solver] ${o.id.slice(-8)}: ${errText(e)}`); }
      }
    };
    await this.loadDivisibility(markets().flatMap((o) => [o.sell, o.buy]));
    await serveMarket();

    // Then resting orders, a bounded number per pass, newest first, taking turns across passes.
    // One whose last look found the market well short of its price is left until that look is a minute old.
    const resting = usable.filter((o) => o.kind !== 'market' && o.retryAt <= now).reverse()
      .filter((o) => { const l = this.outlook.get(o.id); return !l || Date.now() - l.at > SKIP_FAR_MS || new Decimal(l.available).gte(new Decimal(l.needed).mul(FAR_RATIO)); });
    const turn = resting.length > this.config.maxRestingPerTick
      ? [...resting, ...resting].slice(this.restingCursor % resting.length, (this.restingCursor % resting.length) + this.config.maxRestingPerTick)
      : resting;
    this.restingCursor += turn.length;
    for (const o of turn) {
      if (this.stopped) return result;
      if (this.marketQueued) { await this.loadDivisibility(markets().flatMap((m) => [m.sell, m.buy])); await serveMarket(); }
      if (done.has(o.id)) continue;
      try { await this.fillTaker(o, this.store.open().filter(eligible), liveBook(), now, done, result); } catch (e) { console.warn(`[solver] ${o.id.slice(-8)}: ${errText(e)}`); }
    }

    // Book orders that cross each other: a buyer bidding at or above what a seller asks.
    // The solver passes the tokens from one to the other with its own funds and keeps the difference.
    await this.crossBook(liveBook, result);
    if (this.marketQueued) await serveMarket();

    // Book orders the market has reached: a bounded number per pass, taking turns.
    const candidates = liveBook().filter((b) => this.bookWorthBuying(b));
    const slice = candidates.length > this.config.maxBookPerTick
      ? [...candidates, ...candidates].slice(this.bookCursor % candidates.length, (this.bookCursor % candidates.length) + this.config.maxBookPerTick)
      : candidates;
    this.bookCursor += slice.length;
    for (const b of slice) {
      if (this.stopped) break;
      if (this.marketQueued) await serveMarket();
      if (!liveBook().some((x) => x.id === b.id)) continue;
      try {
        const res = await this.arbitrage(b);
        if (!res) continue;
        if (res.kind === 'committed') { result.bookBought += 1; await this.book?.refresh().catch(() => undefined); }
        else if (res.kind === 'pending') pendingBook.add(b.id);
        else if (res.kind !== 'blocked') this.backoff(`book:${b.id}`, b.remaining, res.error);
      } catch (e) { console.warn(`[solver] book order ${b.id}: ${errText(e)}`); }
    }
    if (this.marketQueued) await serveMarket();
    if (Date.now() - now * 1000 > 15_000) console.log(`[solver] slow pass: ${((Date.now() - now * 1000) / 1000).toFixed(1)} s, ${usable.length} open signed orders, ${this.book?.live(now).length ?? 0} live book orders`);
    return result;
  }
  private bookCursor = 0;

  /**
   * Pairs of book orders that cross. Orders are grouped by what they sell and buy, each group
   * sorted by price, so each pairing is found without comparing every order with every other.
   */
  private async crossBook(liveBook: () => BookOrder[], result: TickResult): Promise<void> {
    const groups = new Map<string, BookOrder[]>();
    for (const b of liveBook().filter((x) => this.bookWorthBuying(x))) {
      const k = `${b.sell}|${b.buy}`;
      groups.set(k, [...(groups.get(k) ?? []), b]);
    }
    const crossed = new Set<number>();
    let changed = false;
    for (const [k, firsts] of groups) {
      const [sell, buy] = k.split('|') as [string, string];
      const seconds = groups.get(`${buy}|${sell}`);
      if (!seconds) continue;
      // Cheapest first on both sides: a pair crosses when p1 × p2 < 1, so once the cheapest second fails to cross a first, no later second will.
      const byPrice = (a: BookOrder, b: BookOrder) => new Decimal(a.price).cmp(b.price);
      firsts.sort(byPrice); seconds.sort(byPrice);
      for (const first of firsts) {
        for (const second of seconds) {
          if (this.stopped) return;
          if (crossed.has(first.id) || crossed.has(second.id)) continue;
          // Prices that do not cross now will not cross for any dearer second order.
          if (!new Decimal(first.price).mul(second.price).lt(1)) break;
          if (!planBookCross(first, second, '1e30', '0', this.divisibility)) continue;
          const pairKey = `cross:${first.id}:${second.id}`;
          if (!this.mayTry(pairKey, `${first.remaining}|${second.remaining}`)) continue;
          try {
            const float = await this.spendable(first.buy);
            const gas = await this.gasIn(first.buy, new Decimal(CROSS_GAS_XRD));
            if (gas === undefined) continue;
            const plan = planBookCross(first, second, float.toFixed(), gas, this.divisibility);
            if (!plan) continue;
            const res = await this.send(bookCrossManifest({
              solver: this.identity!, feeLockXrd: FEE_LOCK_XRD, book: this.book!.component, first: first.id, second: second.id,
              payResource: first.buy, pay: plan.pay, middleResource: first.sell, minBack: plan.pay,
            }), {}, { kind: 'book', orders: [], bookIds: [first.id, second.id] });
            if (res.kind === 'blocked') return;
            crossed.add(first.id); crossed.add(second.id);
            if (res.kind === 'committed') {
              result.bookCrossed += 1; changed = true;
              console.log(`[solver] crossed book orders ${first.id} and ${second.id} (${plan.middle} through) in ${res.txid}`);
            } else if (res.kind !== 'pending') this.backoff(pairKey, `${first.remaining}|${second.remaining}`, res.error);
          } catch (e) { console.warn(`[solver] book orders ${first.id}+${second.id}: ${errText(e)}`); }
        }
      }
    }
    if (changed) await this.book?.refresh().catch(() => undefined);
  }

  /** What /api/health may show: nothing that helps anyone but the operator beyond whether it works. */
  health(): { lastTickAt: number; lastTickMs: number; xrd: 'ok' | 'low' | 'unknown'; lossLimit: { reached: boolean; failedFeesXrdLastHour: string; limitXrd: number }; pendingTransactions: number } {
    const xrd = !this.lastXrd ? 'unknown' : new Decimal(this.lastXrd.amount).gte(this.config.lowXrd) ? 'ok' : 'low';
    return {
      lastTickAt: this.lastTickAt, lastTickMs: this.lastTickMs, xrd,
      lossLimit: { reached: this.breaker.open, failedFeesXrdLastHour: this.breaker.failedFeesXrd, limitXrd: this.config.failedFeeLimitXrd },
      pendingTransactions: this.store.pendingTransactions().length,
    };
  }
}

export interface TickResult { crossed: number; poolFilled: number; bookBought: number; bookCrossed: number }

