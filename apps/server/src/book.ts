import { type BookFill, type BookInfo, type BookOrder, type Gateway, bookOrderLive, readBook, readBookEvents, readBookOrders } from '@radix-dex/core';

/** Keeps a copy of the on-ledger order book. The ledger is the only source of truth: nothing here is trusted from clients. */
export class BookWatcher {
  private readonly gateway: Gateway;
  readonly component: string;
  info: BookInfo | undefined;
  readonly orders = new Map<number, BookOrder>();
  /** Every purchase from the book, oldest first, and when each order was placed: from the component's events. */
  readonly fills: BookFill[] = [];
  readonly placedAt = new Map<number, number>();
  private eventsFrom = 1;
  /** When the book was last read successfully (ms), and when a read last failed. */
  refreshedAt = 0;
  failedAt = 0;
  lastError: string | undefined;
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
        // History is for display only: if it cannot be read, the book itself is still current.
        try {
          const ev = await readBookEvents(this.gateway, this.component, this.eventsFrom);
          for (const p of ev.placed) this.placedAt.set(p.id, p.time);
          this.fills.push(...ev.fills);
          // History is for display; keep it bounded.
          if (this.fills.length > 5000) this.fills.splice(0, this.fills.length - 5000);
          this.eventsFrom = ev.next;
        } catch (e) { console.warn('[book] events not read:', String((e as Error).message ?? e).slice(0, 200)); }
      } catch (e) {
        this.failedAt = Date.now();
        this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        throw e;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /**
   * For request handlers: never wait. Start a read in the background if the copy is older than
   * `maxAgeMs` (and the last failed read was not in the last 30 s), and answer from the copy held now.
   */
  refreshInBackground(maxAgeMs: number): void {
    if (Date.now() - this.refreshedAt < maxAgeMs || this.running || Date.now() - this.failedAt < 30_000) return;
    this.refresh().catch((e) => console.warn('[book] not read:', String((e as Error)?.message ?? e).slice(0, 200)));
  }

  /** Orders that can be bought from now. */
  live(nowSec = Math.floor(Date.now() / 1000)): BookOrder[] {
    return [...this.orders.values()].filter((o) => bookOrderLive(o, nowSec));
  }

  byMaker(account: string): BookOrder[] {
    return [...this.orders.values()].filter((o) => o.maker === account).sort((a, b) => b.id - a.id);
  }
}
