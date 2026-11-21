import { type BookInfo, type BookOrder, type Gateway, bookOrderLive, readBook, readBookOrders } from '@radix-dex/core';

/** Keeps a copy of the on-ledger order book. The ledger is the only source of truth: nothing here is trusted from clients. */
export class BookWatcher {
  private readonly gateway: Gateway;
  readonly component: string;
  info: BookInfo | undefined;
  readonly orders = new Map<number, BookOrder>();
  private refreshedAt = 0;
  private running: Promise<void> | undefined;

  constructor(gateway: Gateway, component: string) {
    this.gateway = gateway;
    this.component = component;
  }

  /** Re-read the book unless it was read within `maxAgeMs`. Closed orders never change again, so only new and open ones are fetched. */
  refresh(maxAgeMs = 0): Promise<void> {
    if (Date.now() - this.refreshedAt < maxAgeMs) return Promise.resolve();
    this.running ??= (async () => {
      try {
        const info = await readBook(this.gateway, this.component);
        const ids: number[] = [];
        for (let id = 1; id < info.nextId; id++) {
          const known = this.orders.get(id);
          if (!known || known.open || Number(known.unclaimed) > 0) ids.push(id);
        }
        for (const o of await readBookOrders(this.gateway, info.ordersStore, ids)) this.orders.set(o.id, o);
        this.info = info;
        this.refreshedAt = Date.now();
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Orders that can be bought from now. */
  live(nowSec = Math.floor(Date.now() / 1000)): BookOrder[] {
    return [...this.orders.values()].filter((o) => bookOrderLive(o, nowSec));
  }

  byMaker(account: string): BookOrder[] {
    return [...this.orders.values()].filter((o) => o.maker === account).sort((a, b) => b.id - a.id);
  }
}
