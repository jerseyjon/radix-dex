import { readFileSync, statSync } from 'node:fs';
import {
  type DecodedOrder, type Ed25519Key, type Gateway, type SolverIdentity, Decimal,
  type BookOrder, type LiquidityItem, type Pool,
  accountOf, bookArbManifest, bookArbPoolFirstManifest, bookCrossManifest, buildTransaction, decodeSignedPartialTransaction, grossNeeded, keyFromHex, limitOf, payout,
  pickLiquidity, planBookCross, planPoolFill, submitAndWait, takeFillManifest,
} from '@radix-dex/core';
import type { BookWatcher } from './book.ts';
import type { Config } from './config.ts';
import type { MarketData } from './marketdata.ts';
import type { OrderStore, StoredOrder } from './store.ts';

/** Read the solver key from a file that only its owner can read. Never from an environment variable. */
export function loadSolverKey(path: string): Ed25519Key {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`Solver key file ${path} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  return keyFromHex(readFileSync(path, 'utf8').trim());
}

const FEE_LOCK_XRD = '10';
/** Network cost of a plain pool fill, which the site quotes before an order is signed. */
export const GAS_XRD = '1';
const MAX_FILL_FAILURES = 3;

/**
 * Network cost of a fill in XRD, from Stokenet measurements: the taker's order alone, a pool leg,
 * and each resting order taken (pool only 0.96; one order and a pool 1.34 to 1.40; one order alone 1.08).
 */
const fillGasXrd = (items: number, poolLeg: boolean): Decimal => new Decimal('0.7').plus(poolLeg ? '0.3' : 0).plus(new Decimal('0.38').mul(items));
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

/**
 * Fills open orders. Each order is tried as a taker: it takes the resting orders that give it a
 * better price than the pools, and the pools for the rest, all in one transaction.
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
  /** Book orders a purchase just failed on: left alone until this time (ms). */
  private readonly bookRetryAt = new Map<number, number>();
  private running = false;
  /** Per open order: what the pools would pay it right now after the network fee, and what it needs. */
  readonly outlook = new Map<string, { available: string; needed: string; at: number }>();

  constructor(o: { config: Config; gateway: Gateway; store: OrderStore; data: MarketData; key: Ed25519Key; badge: string; book?: BookWatcher }) {
    this.book = o.book;
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

  private async window() {
    const { epoch } = await this.gateway.status();
    return { networkId: this.config.network.networkId, startEpoch: epoch, endEpoch: epoch + 10, expiresAt: Math.floor(Date.now() / 1000) + 120 };
  }

  private decode(o: StoredOrder): Promise<DecodedOrder> {
    return decodeSignedPartialTransaction(o.signedPartialTransactionHex, this.config.network.networkId);
  }

  /** Has the account still got what the order sells? If not, the fill would fail and waste a fee. */
  private async funded(o: StoredOrder): Promise<boolean> {
    return (await this.balance(o.account, o.sell)).gte(o.sellAmount);
  }

  private async submit(manifest: string, children: Record<string, DecodedOrder>): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
    const tx = await buildTransaction({ manifest, window: await this.window(), notary: this.key, children });
    const out = await submitAndWait(this.gateway, tx);
    return out.status === 'CommittedSuccess' ? { ok: true, txid: tx.intentHashId } : { ok: false, error: `${out.status}: ${out.error}` };
  }

  /**
   * Record a failed fill. Each failure costs the solver a network fee, so retries back off
   * (1, 4, 16 minutes) and the order is dropped after the third: otherwise anyone could bleed
   * the solver's float with orders built to fail.
   */
  private fail(orders: StoredOrder[], error: string): void {
    const now = Math.floor(Date.now() / 1000);
    for (const o of orders) {
      const failures = this.store.noteFailure(o.id, error, now + 60 * 4 ** Math.min(o.failures, 5));
      if (failures >= MAX_FILL_FAILURES) this.store.markCancelled(o.id, `Dropped after ${failures} failed fills: ${error}`);
    }
    console.warn(`[solver] ${orders.map((o) => o.id.slice(-8)).join('+')}: ${error.slice(0, 200)}`);
  }

  /** The network fee, which the solver pays in XRD, valued in `resource`. Undefined if no pool prices that token. */
  private gasIn(resource: string, gasXrd: Decimal): Promise<string | undefined> {
    return this.data.xrdValueIn(resource, gasXrd);
  }

  /**
   * Best execution for `taker`: with nothing taken from other traders (pools only), then with the
   * cheapest one, two… of their orders, keeping whichever leaves the taker most after the network fee.
   */
  private async bestExecution(taker: StoredOrder, resting: StoredOrder[], book: BookOrder[], nowSec: number): Promise<Execution | undefined> {
    const xrd = this.config.network.xrd;
    const candidates = pickLiquidity(taker, resting, book, this.config.makerFeeBps, this.divisibility, nowSec);
    let best: Execution | undefined;
    for (let k = 0; k <= candidates.length; k++) {
      let items = candidates.slice(0, k);
      const fromOthers = items.reduce((sum, m) => sum.plus(m.gives), new Decimal(0));
      const left = items.reduce((rest, m) => rest.minus(m.cost), new Decimal(taker.sellAmount));
      let total = fromOthers, route: Pool[] = [], poolIn = '0';
      if (left.gt(0)) {
        const quote = await this.data.quoter.best(this.data.pools, taker.sell, taker.buy, left.toFixed(), xrd).catch(() => undefined);
        if (quote) { total = total.plus(quote.buyAmount); route = quote.route; poolIn = left.toFixed(); }
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
      const gasXrd = fillGasXrd(items.length, route.length > 0);
      const gasInBuyToken = await this.gasIn(taker.buy, gasXrd);
      if (gasInBuyToken === undefined) continue; // the fee cannot be charged in this token: do not fill for nothing
      if (!best || total.minus(gasInBuyToken).gt(best.total.minus(best.gasInBuyToken))) best = { items, poolIn, route, total, gasInBuyToken };
    }
    return best;
  }

  /**
   * A book order is paid its price and nothing more, so when a pool pays more than it asks the
   * solver buys from it with its own funds and sells through the pool, keeping the difference.
   * That is what fills a resting order when the market reaches its price.
   */
  private async arbitrage(b: BookOrder, solver: { account: string; badge: string }): Promise<boolean> {
    const xrd = this.config.network.xrd;
    const sellDiv = this.divisibility(b.sell), buyDiv = this.divisibility(b.buy);
    const attempt = async (share: number, mustCoverGas: boolean) => {
      const q = new Decimal(b.remaining).mul(share).toDecimalPlaces(sellDiv, Decimal.ROUND_DOWN);
      if (!q.gt(0)) return undefined;
      const quote = await this.data.quoter.best(this.data.pools, b.sell, b.buy, q.toFixed(), xrd).catch(() => undefined);
      if (!quote) return undefined;
      const cost = q.mul(b.price).toDecimalPlaces(buyDiv, Decimal.ROUND_UP);
      const priced = mustCoverGas ? await this.gasIn(b.buy, new Decimal(GAS_XRD)) : '0';
      if (priced === undefined) return undefined;
      const gas = new Decimal(priced);
      return new Decimal(quote.buyAmount).minus(cost).minus(gas).gt(0) ? { q, cost, route: quote.route } : undefined;
    };
    // One cheap look first: if even a small part does not sell for more than it costs, nothing will.
    if (!(await attempt(ARB_SHARES[ARB_SHARES.length - 1]!, false))) return false;
    const float = await this.balance(solver.account, b.buy);
    for (const share of ARB_SHARES) {
      const plan = await attempt(share, true);
      if (!plan || plan.cost.gt(float)) continue;
      const res = await this.submit(bookArbManifest({
        solver, feeLockXrd: FEE_LOCK_XRD, book: this.book!.component, id: b.id, payResource: b.buy, pay: plan.cost.toFixed(),
        boughtResource: b.sell, route: plan.route, minBack: plan.cost.toFixed(),
      }), {});
      if (!res.ok) { this.bookRetryAt.set(b.id, Date.now() + 60_000); console.warn(`[solver] book order ${b.id}: ${res.error.slice(0, 200)}`); return false; }
      console.log(`[solver] bought ${plan.q.toFixed()} from book order ${b.id} and sold it through ${plan.route.map((p) => p.venue).join('>')} in ${res.txid}`);
      return true;
    }

    // Not enough of the token the order wants (a solver that holds only XRD, say). Do it the other
    // way round with the token the order sells: sell some through the pool, pay the proceeds into
    // the order, and end with more of that token than it started with.
    const start = await this.balance(solver.account, b.sell);
    const gasPriced = await this.gasIn(b.sell, new Decimal(GAS_XRD));
    if (gasPriced === undefined) return false;
    for (const share of ARB_SHARES) {
      const x = new Decimal(b.remaining).mul(share).toDecimalPlaces(sellDiv, Decimal.ROUND_DOWN);
      if (!x.gt(0) || x.gt(start)) continue;
      const quote = await this.data.quoter.best(this.data.pools, b.sell, b.buy, x.toFixed(), xrd).catch(() => undefined);
      if (!quote) continue;
      // What the pool's proceeds buy from the order, by the component's own sum.
      const back = Decimal.min(new Decimal(quote.buyAmount).div(b.price).toDecimalPlaces(sellDiv, Decimal.ROUND_DOWN), b.remaining);
      if (!back.minus(x).minus(gasPriced).gt(0)) continue;
      const res = await this.submit(bookArbPoolFirstManifest({
        solver, feeLockXrd: FEE_LOCK_XRD, book: this.book!.component, id: b.id, startResource: b.sell, sellIn: x.toFixed(),
        payResource: b.buy, route: quote.route, minBack: x.toFixed(),
      }), {});
      if (!res.ok) { this.bookRetryAt.set(b.id, Date.now() + 60_000); console.warn(`[solver] book order ${b.id}: ${res.error.slice(0, 200)}`); return false; }
      console.log(`[solver] sold ${x.toFixed()} through ${quote.route.map((p) => p.venue).join('>')} and bought ${back.toFixed()} from book order ${b.id} in ${res.txid}`);
      return true;
    }
    return false;
  }

  /** One pass over the open orders. Safe to call on a timer; overlapping calls are skipped. */
  async tick(): Promise<{ crossed: number; poolFilled: number; bookBought: number; bookCrossed: number }> {
    const result = { crossed: 0, poolFilled: 0, bookBought: 0, bookCrossed: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      this.store.expire(now + 15); // leave time for the fill to commit
      const all = this.store.open();
      const openIds = new Set(all.map((o) => o.id));
      for (const id of this.outlook.keys()) if (!openIds.has(id)) this.outlook.delete(id);
      // Market orders first, then the newest: the order that arrives is the one that takes.
      const open = all.filter((o) => o.retryAt <= now).reverse()
        .sort((a, b) => Number(b.kind === 'market') - Number(a.kind === 'market'));
      await this.book?.refresh().catch((e) => console.warn('[solver] order book not read:', String((e as Error).message ?? e).slice(0, 200)));
      const liveBook = () => (this.book?.live(now) ?? []).filter((b) => (this.bookRetryAt.get(b.id) ?? 0) <= Date.now());
      if (!open.length && !liveBook().length) return result;
      await this.account();
      const solver = this.identity!;
      await this.loadDivisibility([...open, ...liveBook()].flatMap((o) => [o.sell, o.buy]));
      const done = new Set<string>();

      for (const o of open) {
        if (done.has(o.id)) continue;
        let involved: StoredOrder[] = [o];
        // When a fill that used resting orders fails, hold those back and let the taker try again
        // at once without them: a resting order cancelled on the ledger must not strand a market order.
        let blame: StoredOrder[] = [o];
        try {
          const exec = await this.bestExecution(o, open.filter((m) => m.kind !== 'market' && !done.has(m.id)), liveBook(), now);
          if (!exec) { this.outlook.delete(o.id); continue; }
          const { gasInBuyToken } = exec;
          // With no pool leg the outcome is exact, so no margin is needed.
          const terms = { minBuyAmount: o.minBuyAmount, limitBuyAmount: limitOf(o).toFixed(), gasInBuyToken, bufferBps: exec.route.length ? undefined : 0 };
          this.outlook.set(o.id, { available: exec.total.toFixed(), needed: grossNeeded(terms).toFixed(), at: now });
          const plan = planPoolFill({ ...terms, quotedOut: exec.total.toFixed(), feeBps: this.config.feeBps, divisibility: this.divisibility(o.buy) });
          if (!plan) continue;
          const makerItems = exec.items.filter((m) => m.kind === 'order');
          const bookItems = exec.items.filter((m) => m.kind === 'book');
          const makers = makerItems.map((m) => m.order as StoredOrder);
          involved = [o, ...makers];
          if (makers.length) blame = makers;
          let unfunded = false;
          for (const x of involved) if (!(await this.funded(x))) { this.fail([x], 'account no longer holds the sell amount'); unfunded = true; }
          if (unfunded) continue;
          const children: Record<string, DecodedOrder> = { taker: await this.decode(o) };
          for (const [i, m] of makers.entries()) children[`maker_${i}`] = await this.decode(m);
          const res = await this.submit(
            takeFillManifest({
              solver, feeLockXrd: FEE_LOCK_XRD, sell: o.sell, buy: o.buy, makerPays: makerItems.map((m) => m.pay), poolIn: exec.poolIn, route: exec.route, solverTake: plan.solverTake,
              bookFills: bookItems.map((m) => ({ book: this.book!.component, id: m.order.id, pay: m.cost })),
              assertBought: bookItems.length ? exec.items.reduce((sum, m) => sum.plus(m.gives), new Decimal(0)).toFixed() : undefined,
            }),
            children);
          // Whatever happened, the book is no longer as it was read.
          if (bookItems.length) await this.book?.refresh().catch(() => undefined);
          if (!res.ok) { this.fail(blame, res.error); continue; }
          this.store.markFilled(o.id, res.txid, plan.userReceives);
          makerItems.forEach((m) => this.store.markFilled((m.order as StoredOrder).id, res.txid, m.pay));
          involved.forEach((x) => done.add(x.id));
          if (exec.items.length) result.crossed += involved.length; else result.poolFilled += 1;
          const took = [...makers.map((m) => m.id.slice(-8)), ...bookItems.map((m) => `book order ${m.order.id}`)];
          console.log(`[solver] filled ${o.kind} ${o.id.slice(-8)}${took.length ? ' against ' + took.join('+') : ''}${exec.route.length ? ' through ' + exec.route.map((p) => p.venue).join('>') : ''} in ${res.txid}`);
        } catch (e) { this.fail(blame, String((e as Error).message ?? e)); }
      }

      // Book orders that cross each other: a buyer bidding at or above what a seller asks.
      // The solver passes the tokens from one to the other with its own funds and keeps the difference.
      const crossed = new Set<number>();
      for (const first of liveBook()) {
        for (const second of liveBook()) {
          if (crossed.has(first.id) || crossed.has(second.id)) continue;
          try {
            // A free look first: most pairs do not cross, and that needs no balance from the ledger.
            if (!planBookCross(first, second, '1e30', '0', this.divisibility)) continue;
            const float = await this.balance(solver.account, first.buy);
            const gas = await this.gasIn(first.buy, new Decimal(GAS_XRD));
            if (gas === undefined) continue;
            const plan = planBookCross(first, second, float.toFixed(), gas, this.divisibility);
            if (!plan) continue;
            const res = await this.submit(bookCrossManifest({
              solver, feeLockXrd: FEE_LOCK_XRD, book: this.book!.component, first: first.id, second: second.id,
              payResource: first.buy, pay: plan.pay, middleResource: first.sell, minBack: plan.pay,
            }), {});
            crossed.add(first.id); crossed.add(second.id);
            if (!res.ok) { this.bookRetryAt.set(first.id, Date.now() + 60_000); this.bookRetryAt.set(second.id, Date.now() + 60_000); console.warn(`[solver] book orders ${first.id}+${second.id}: ${res.error.slice(0, 200)}`); continue; }
            result.bookCrossed += 1;
            console.log(`[solver] crossed book orders ${first.id} and ${second.id} (${plan.middle} through) in ${res.txid}`);
          } catch (e) { console.warn(`[solver] book orders ${first.id}+${second.id}: ${String((e as Error).message ?? e).slice(0, 200)}`); }
        }
      }
      if (crossed.size) await this.book?.refresh().catch(() => undefined);

      // Book orders the market has reached.
      for (const b of liveBook()) {
        try {
          if (await this.arbitrage(b, solver)) { result.bookBought += 1; await this.book?.refresh().catch(() => undefined); }
        } catch (e) { console.warn(`[solver] book order ${b.id}: ${String((e as Error).message ?? e).slice(0, 200)}`); }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
