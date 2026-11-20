import { readFileSync, statSync } from 'node:fs';
import {
  type DecodedOrder, type Ed25519Key, type Gateway, type SolverIdentity, Decimal,
  accountOf, buildTransaction, crossFillManifest, decodeSignedPartialTransaction, findCrosses, keyFromHex,
  planPoolFill, poolFillManifest, submitAndWait,
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
const GAS_XRD = '1';

/** Fills open orders: against each other when they cross, otherwise through pools when the price is there. */
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
    const [d] = await this.gateway.entityDetails([account]);
    const item = d?.fungible_resources?.items?.find((i: any) => i.resource_address === resource);
    return new Decimal(item?.amount ?? 0);
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

  private fail(orders: StoredOrder[], error: string): void {
    const retryAt = Math.floor(Date.now() / 1000) + 60;
    for (const o of orders) this.store.noteFailure(o.id, error, retryAt);
    console.warn(`[solver] ${orders.map((o) => o.id.slice(-8)).join('+')}: ${error.slice(0, 200)}`);
  }

  /** One pass over the open orders. Safe to call on a timer; overlapping calls are skipped. */
  async tick(): Promise<{ crossed: number; poolFilled: number }> {
    const result = { crossed: 0, poolFilled: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      this.store.expire(now + 15); // leave time for the fill to commit
      let open = this.store.open().filter((o) => o.retryAt <= now);
      if (!open.length) return result;
      await this.account();
      const solver = this.identity!;
      await this.loadDivisibility(open.flatMap((o) => [o.sell, o.buy]));

      // 1. Orders that cross each other.
      for (const plan of findCrosses(open, this.config.feeBps, this.divisibility)) {
        const a = plan.a as StoredOrder, b = plan.b as StoredOrder;
        try {
          if (!(await this.funded(a)) || !(await this.funded(b))) { this.fail([a, b], 'account no longer holds the sell amount'); continue; }
          const res = await this.submit(
            crossFillManifest({ solver, feeLockXrd: FEE_LOCK_XRD, x: a.sell, y: a.buy, payA: plan.payA, payB: plan.payB }),
            { order_a: await this.decode(a), order_b: await this.decode(b) });
          if (!res.ok) { this.fail([a, b], res.error); continue; }
          this.store.markFilled(a.id, res.txid, plan.payA);
          this.store.markFilled(b.id, res.txid, plan.payB);
          result.crossed += 2;
          console.log(`[solver] crossed ${a.id.slice(-8)} with ${b.id.slice(-8)} in ${res.txid}`);
        } catch (e) { this.fail([a, b], String((e as Error).message ?? e)); }
      }

      // 2. Everything still open: try the pools.
      open = this.store.open().filter((o) => o.retryAt <= now);
      for (const o of open) {
        try {
          const quote = await this.data.quoter.best(this.data.pools, o.sell, o.buy, o.sellAmount, this.config.network.xrd);
          if (!quote) continue;
          const out = new Decimal(quote.buyAmount);
          if (out.lt(o.minBuyAmount)) continue; // price not there yet: not an error
          const xrd = this.config.network.xrd;
          const gasInBuyToken = o.buy === xrd ? GAS_XRD : o.sell === xrd ? out.div(o.sellAmount).mul(GAS_XRD).toFixed(18) : '0';
          const plan = planPoolFill({ quotedOut: quote.buyAmount, minBuyAmount: o.minBuyAmount, feeBps: this.config.feeBps, gasInBuyToken, divisibility: this.divisibility(o.buy) });
          if (!plan) continue;
          if (!(await this.funded(o))) { this.fail([o], 'account no longer holds the sell amount'); continue; }
          const res = await this.submit(
            poolFillManifest({ solver, feeLockXrd: FEE_LOCK_XRD, sell: o.sell, route: quote.route, solverTake: plan.solverTake }),
            { order: await this.decode(o) });
          if (!res.ok) { this.fail([o], res.error); continue; }
          this.store.markFilled(o.id, res.txid, plan.userReceives);
          result.poolFilled += 1;
          console.log(`[solver] filled ${o.id.slice(-8)} through ${quote.route.map((p) => p.venue).join('>')} in ${res.txid}`);
        } catch (e) { this.fail([o], String((e as Error).message ?? e)); }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
