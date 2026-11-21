import { readFileSync, statSync } from 'node:fs';
import {
  type DecodedOrder, type Ed25519Key, type Gateway, type SolverIdentity, Decimal,
  type MakerFill, type Pool,
  accountOf, buildTransaction, decodeSignedPartialTransaction, grossNeeded, keyFromHex, limitOf, payout,
  pickMakers, planPoolFill, submitAndWait, takeFillManifest,
} from '@radix-dex/core';
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
/** Rough network cost of a fill, charged to the order in the bought token. */
export const GAS_XRD = '1';
const MAX_FILL_FAILURES = 3;

/** Extra network cost of each resting order settled in the same transaction, as a share of GAS_XRD. */
const GAS_PER_MAKER = 0.35;

/** The best way found to fill one order now. */
interface Execution {
  makers: MakerFill[];
  /** Amount of the taker's sell token sent through pools, and the route it takes. */
  poolIn: string;
  route: Pool[];
  /** Everything the taker's sale produces, before the network fee and our fee. */
  total: Decimal;
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
  private running = false;
  /** Per open order: what the pools would pay it right now after the network fee, and what it needs. */
  readonly outlook = new Map<string, { available: string; needed: string; at: number }>();

  constructor(o: { config: Config; gateway: Gateway; store: OrderStore; data: MarketData; key: Ed25519Key; badge: string }) {
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

  /**
   * Best execution for `taker`: with no resting orders (pools only), then with the best one, two…
   * of them, keeping whichever produces the most.
   */
  private async bestExecution(taker: StoredOrder, resting: StoredOrder[]): Promise<Execution | undefined> {
    const xrd = this.config.network.xrd;
    const candidates = pickMakers(taker, resting, this.config.feeBps, this.divisibility);
    let best: Execution | undefined;
    for (let k = 0; k <= candidates.length; k++) {
      let makers = candidates.slice(0, k);
      const fromMakers = makers.reduce((sum, m) => sum.plus(m.order.sellAmount), new Decimal(0));
      const left = makers.reduce((rest, m) => rest.minus(m.cost), new Decimal(taker.sellAmount));
      let total = fromMakers, route: Pool[] = [], poolIn = '0';
      if (left.isPositive()) {
        const quote = await this.data.quoter.best(this.data.pools, taker.sell, taker.buy, left.toFixed(), xrd).catch(() => undefined);
        if (quote) { total = total.plus(quote.buyAmount); route = quote.route; poolIn = left.toFixed(); }
        else if (k === 0) continue;
        else {
          // No pool for the remainder: the first maker gets it as a better price.
          const first = makers[0]!, cost = new Decimal(first.cost).plus(left);
          const pay = payout(cost, new Decimal(first.order.minBuyAmount), this.config.feeBps, this.divisibility(taker.sell))!;
          makers = [{ order: first.order, cost: cost.toFixed(), pay: pay.toFixed() }, ...makers.slice(1)];
        }
      }
      if (!best || total.gt(best.total)) best = { makers, poolIn, route, total };
    }
    return best;
  }

  /** One pass over the open orders. Safe to call on a timer; overlapping calls are skipped. */
  async tick(): Promise<{ crossed: number; poolFilled: number }> {
    const result = { crossed: 0, poolFilled: 0 };
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
      if (!open.length) return result;
      await this.account();
      const solver = this.identity!;
      await this.loadDivisibility(open.flatMap((o) => [o.sell, o.buy]));
      const xrd = this.config.network.xrd;
      const done = new Set<string>();

      for (const o of open) {
        if (done.has(o.id)) continue;
        let involved: StoredOrder[] = [o];
        try {
          const exec = await this.bestExecution(o, open.filter((m) => m.kind !== 'market' && !done.has(m.id)));
          if (!exec) { this.outlook.delete(o.id); continue; }
          const gasXrd = new Decimal(GAS_XRD).mul(1 + GAS_PER_MAKER * exec.makers.length);
          const gasInBuyToken = o.buy === xrd ? gasXrd.toFixed() : o.sell === xrd ? exec.total.div(o.sellAmount).mul(gasXrd).toFixed(18) : '0';
          // With no pool leg the outcome is exact, so no margin is needed.
          const terms = { minBuyAmount: o.minBuyAmount, limitBuyAmount: limitOf(o).toFixed(), gasInBuyToken, bufferBps: exec.route.length ? undefined : 0 };
          this.outlook.set(o.id, { available: exec.total.toFixed(), needed: grossNeeded(terms).toFixed(), at: now });
          const plan = planPoolFill({ ...terms, quotedOut: exec.total.toFixed(), feeBps: this.config.feeBps, divisibility: this.divisibility(o.buy) });
          if (!plan) continue;
          const makers = exec.makers.map((m) => m.order as StoredOrder);
          involved = [o, ...makers];
          let unfunded = false;
          for (const x of involved) if (!(await this.funded(x))) { this.fail([x], 'account no longer holds the sell amount'); unfunded = true; }
          if (unfunded) continue;
          const children: Record<string, DecodedOrder> = { taker: await this.decode(o) };
          for (const [i, m] of makers.entries()) children[`maker_${i}`] = await this.decode(m);
          const res = await this.submit(
            takeFillManifest({ solver, feeLockXrd: FEE_LOCK_XRD, sell: o.sell, buy: o.buy, makerPays: exec.makers.map((m) => m.pay), poolIn: exec.poolIn, route: exec.route, solverTake: plan.solverTake }),
            children);
          if (!res.ok) { this.fail(involved, res.error); continue; }
          this.store.markFilled(o.id, res.txid, plan.userReceives);
          exec.makers.forEach((m) => this.store.markFilled(m.order.id, res.txid, m.pay));
          involved.forEach((x) => done.add(x.id));
          if (makers.length) result.crossed += involved.length; else result.poolFilled += 1;
          console.log(`[solver] filled ${o.kind} ${o.id.slice(-8)}${makers.length ? ' against ' + makers.map((m) => m.id.slice(-8)).join('+') : ''}${exec.route.length ? ' through ' + exec.route.map((p) => p.venue).join('>') : ''} in ${res.txid}`);
        } catch (e) { this.fail(involved, String((e as Error).message ?? e)); }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
