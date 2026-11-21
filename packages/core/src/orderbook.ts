// The on-ledger order book (scrypto/dex-contracts/src/order_book.rs): resting orders that can be
// filled a part at a time. Manifests, reading its state through the Gateway, and choosing what a
// taker should take from it. Runs in a browser as well as on the server.
import type { Gateway } from './gateway.ts';
import { Decimal, addr, bucket, dec, isAccount, isResource } from './manifest.ts';
import type { Pool } from './types.ts';
import { routeInstructions, routePath } from './quote.ts';
import type { SolverIdentity } from './orders.ts';
import { type OpenOrder, limitOf, payout } from './solver.ts';

/** One order as the component holds it. Amounts are decimal strings. */
export interface BookOrder {
  id: number;
  /** Account paid as the order fills. */
  maker: string;
  sell: string;
  buy: string;
  /** Buy tokens owed for each one sell token. */
  price: string;
  /** What the order was placed with, what is still for sale, and what was handed back on cancel. */
  sellAmount: string;
  remaining: string;
  returned: string;
  /** Payment the maker's account refused, waiting to be claimed. */
  unclaimed: string;
  makerFeeBps: number;
  /** Unix seconds; zero means the order never expires. */
  expiresAt: number;
  open: boolean;
}

const u64 = (id: number): string => {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Bad order id: ${id}`);
  return `${id}u64`;
};

/**
 * Wallet transaction that places a resting order: the tokens move into the order book and a
 * receipt NFT comes back. `price` is buy tokens per sell token. The wallet adds the fee lock.
 */
export function bookPlaceManifest(o: { account: string; book: string; sell: string; sellAmount: string; buy: string; price: string; expiresAt: number }): string {
  if (o.sell === o.buy) throw new Error('sell and buy must differ');
  if (!new Decimal(o.sellAmount).gt(0) || !new Decimal(o.price).gt(0)) throw new Error('amount and price must be positive');
  if (!Number.isSafeInteger(o.expiresAt) || o.expiresAt < 0) throw new Error('bad expiry');
  return [
    `CALL_METHOD ${addr(o.account)} "withdraw" ${addr(o.sell)} ${dec(o.sellAmount)};`,
    `TAKE_ALL_FROM_WORKTOP ${addr(o.sell)} ${bucket('sell')};`,
    `CALL_METHOD ${addr(o.book)} "place" ${bucket('sell')} ${addr(o.buy)} ${dec(o.price)} ${addr(o.account)} ${o.expiresAt}i64;`,
    `CALL_METHOD ${addr(o.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
}

/** Wallet transaction that cancels a resting order: the receipt is burnt and the unsold tokens come back. */
export function bookCancelManifest(o: { account: string; book: string; receipts: string; id: number }): string {
  u64(o.id);
  return [
    `CALL_METHOD ${addr(o.account)} "withdraw_non_fungibles" ${addr(o.receipts)} Array<NonFungibleLocalId>(NonFungibleLocalId("#${o.id}#"));`,
    `TAKE_ALL_FROM_WORKTOP ${addr(o.receipts)} ${bucket('receipt')};`,
    `CALL_METHOD ${addr(o.book)} "cancel" ${bucket('receipt')};`,
    `CALL_METHOD ${addr(o.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
}

/** Manifest lines that pay `pay` of `payResource` from the worktop into order `id`, leaving what it bought on the worktop. */
export function bookFillInstructions(book: string, id: number, payResource: string, pay: string, name: string): string[] {
  return [
    `TAKE_FROM_WORKTOP ${addr(payResource)} ${dec(pay)} ${bucket(name)};`,
    `CALL_METHOD ${addr(book)} "fill" ${u64(id)} ${bucket(name)};`,
  ];
}

/**
 * Root manifest with which the solver buys from a resting order using its own funds and sells
 * what it bought through pools. It fails unless at least `minBack` of the payment token comes
 * back, so the solver can lose the network fee but never the money it put in.
 */
export function bookArbManifest(o: { solver: SolverIdentity; feeLockXrd: string; book: string; id: number; payResource: string; pay: string; boughtResource: string; route: Pool[]; minBack: string }): string {
  const path = routePath(o.route, o.boughtResource);
  if (path[path.length - 1] !== o.payResource) throw new Error('route does not return the payment token');
  return [
    `CALL_METHOD ${addr(o.solver.account)} "lock_fee" ${dec(o.feeLockXrd)};`,
    `CALL_METHOD ${addr(o.solver.account)} "withdraw" ${addr(o.payResource)} ${dec(o.pay)};`,
    ...bookFillInstructions(o.book, o.id, o.payResource, o.pay, 'pay'),
    `TAKE_ALL_FROM_WORKTOP ${addr(o.boughtResource)} ${bucket('in0')};`,
    ...routeInstructions(o.route, o.boughtResource),
    `ASSERT_WORKTOP_CONTAINS ${addr(o.payResource)} ${dec(o.minBack)};`,
    `CALL_METHOD ${addr(o.solver.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
}

// ---------------------------------------------------------------- reading

const field = (fields: any[], name: string): any => {
  const f = fields.find((x) => x?.field_name === name);
  if (!f) throw new Error(`Order book state has no field "${name}"`);
  return f.value;
};

export interface BookInfo { component: string; ordersStore: string; nextId: number; receipts: string; makerFeeBps: number }

/** The component's own fields: where its orders are kept, how many there have been, the receipt resource, the current maker fee. */
export async function readBook(gateway: Gateway, component: string): Promise<BookInfo> {
  const [d] = await gateway.entityDetails([component]);
  const fields = d?.details?.state?.fields;
  if (!Array.isArray(fields) || d?.details?.blueprint_name !== 'OrderBook') throw new Error(`${component} is not an order book`);
  const info = { component, ordersStore: String(field(fields, 'orders')), nextId: Number(field(fields, 'next_id')), receipts: String(field(fields, 'receipts')), makerFeeBps: Number(field(fields, 'maker_fee_bps')) };
  if (!Number.isSafeInteger(info.nextId) || !isResource(info.receipts) || !(info.makerFeeBps >= 0 && info.makerFeeBps <= 100)) throw new Error('Unexpected order book state');
  return info;
}

/** Read orders by id. Ids that do not exist are left out. */
export async function readBookOrders(gateway: Gateway, ordersStore: string, ids: number[]): Promise<BookOrder[]> {
  const out: BookOrder[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await gateway.post('/state/key-value-store/data', {
      key_value_store_address: ordersStore,
      keys: ids.slice(i, i + 50).map((id) => ({ key_json: { kind: 'U64', value: String(id) } })),
    });
    for (const e of j?.entries ?? []) {
      const fields = e?.value?.programmatic_json?.fields;
      const id = Number(e?.key?.programmatic_json?.value);
      if (!Array.isArray(fields) || !Number.isSafeInteger(id)) continue;
      const amount = (name: string): string => {
        const v = String(field(fields, name));
        if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`Order ${id}: bad ${name}`);
        return v;
      };
      const order: BookOrder = {
        id, maker: String(field(fields, 'maker')), sell: String(field(fields, 'sell_resource')), buy: String(field(fields, 'buy_resource')),
        price: amount('price'), sellAmount: amount('sell_amount'), remaining: amount('remaining'), returned: amount('returned'), unclaimed: amount('unclaimed'),
        makerFeeBps: Number(field(fields, 'maker_fee_bps')), expiresAt: Number(field(fields, 'expires_at')), open: field(fields, 'open') === true,
      };
      if (!isAccount(order.maker) || !isResource(order.sell) || !isResource(order.buy) || !Number.isSafeInteger(order.expiresAt)) throw new Error(`Order ${id}: unexpected state`);
      out.push(order);
    }
  }
  return out;
}

/** Can this order be bought from right now? */
export const bookOrderLive = (o: BookOrder, nowSec: number): boolean =>
  o.open && new Decimal(o.remaining).gt(0) && (o.expiresAt === 0 || o.expiresAt > nowSec);

// ---------------------------------------------------------------- choosing what to take

/** One thing a taker takes, costing `cost` of the token it sells and giving `gives` of the token it buys. */
export type LiquidityItem =
  /** A signed order held by the server: taken whole, paid `pay` (its price less the maker fee). */
  | { kind: 'order'; order: OpenOrder; cost: string; pay: string; gives: string }
  /** An order in the on-ledger book: as much of it as the taker can pay for. */
  | { kind: 'book'; order: BookOrder; cost: string; gives: string };

/**
 * What a taker could take from other traders, cheapest first, spending no more than it sells.
 * Signed orders fill whole or not at all; book orders fill in part. Any prefix of the result is
 * a valid plan, and the caller sends whatever the taker has left through pools.
 */
export function pickLiquidity(
  taker: OpenOrder, resting: OpenOrder[], book: BookOrder[], makerFeeBps: number,
  divisibility: (resource: string) => number, nowSec: number, max = 4,
): LiquidityItem[] {
  const sellDiv = divisibility(taker.sell), buyDiv = divisibility(taker.buy);
  type Candidate = { unit: Decimal; order?: OpenOrder; book?: BookOrder };
  const candidates: Candidate[] = [
    ...resting.filter((m) => m.id !== taker.id && m.sell === taker.buy && m.buy === taker.sell)
      .map((m) => ({ unit: limitOf(m).div(m.sellAmount), order: m })),
    // Leave a margin before expiry so the fill does not arrive a moment too late.
    ...book.filter((b) => b.sell === taker.buy && b.buy === taker.sell && bookOrderLive(b, nowSec + 30))
      .map((b) => ({ unit: new Decimal(b.price), book: b })),
  ].sort((x, y) => x.unit.cmp(y.unit));

  const out: LiquidityItem[] = [];
  let left = new Decimal(taker.sellAmount);
  for (const c of candidates) {
    if (out.length >= max || !left.gt(0)) break;
    if (c.order) {
      const cost = limitOf(c.order).toDecimalPlaces(sellDiv, Decimal.ROUND_UP);
      const pay = payout(cost, new Decimal(c.order.minBuyAmount), makerFeeBps, sellDiv);
      if (!pay || cost.gt(left)) continue;
      left = left.minus(cost);
      out.push({ kind: 'order', order: c.order, cost: cost.toFixed(), pay: pay.toFixed(), gives: c.order.sellAmount });
    } else if (c.book) {
      // The same sums the component does: tokens bought round down, the cost rounds up.
      const affordable = left.div(c.unit).toDecimalPlaces(buyDiv, Decimal.ROUND_DOWN);
      const gives = Decimal.min(affordable, c.book.remaining);
      if (!gives.gt(0)) continue;
      const cost = gives.mul(c.unit).toDecimalPlaces(sellDiv, Decimal.ROUND_UP);
      if (cost.gt(left)) continue;
      left = left.minus(cost);
      out.push({ kind: 'book', order: c.book, cost: cost.toFixed(), gives: gives.toFixed() });
    }
  }
  return out;
}

// ---------------------------------------------------------------- events

/** One purchase from a book order, as the component reported it. */
export interface BookFill { id: number; txid: string; time: number; sold: string; paid: string; fee: string }

/**
 * The order book's own events, oldest first, from `fromStateVersion` on: when each order was
 * placed and every purchase from it. Returns where to resume from next time.
 */
export async function readBookEvents(gateway: Gateway, component: string, fromStateVersion = 1, maxPages = 30): Promise<{ placed: { id: number; txid: string; time: number }[]; fills: BookFill[]; next: number }> {
  const placed: { id: number; txid: string; time: number }[] = [], fills: BookFill[] = [];
  let cursor: string | undefined, next = fromStateVersion;
  for (let page = 0; page < maxPages; page++) {
    let j: any;
    try {
      j = await gateway.post('/stream/transactions', {
        affected_global_entities_filter: [component], order: 'asc', limit_per_page: 100, cursor,
        from_ledger_state: { state_version: fromStateVersion }, opt_ins: { receipt_events: true },
      });
    } catch (e) {
      // Asking from just past the newest transaction is refused rather than answered with nothing.
      if (String((e as { body?: string }).body ?? '').includes('beyond the end of the known ledger')) break;
      throw e;
    }
    for (const t of j?.items ?? []) {
      if (typeof t?.state_version === 'number') next = Math.max(next, t.state_version + 1);
      if (t?.transaction_status !== 'CommittedSuccess' || typeof t.intent_hash !== 'string') continue;
      const time = Math.floor(Date.parse(t.confirmed_at ?? t.round_timestamp) / 1000);
      for (const e of t.receipt?.events ?? []) {
        // Only what the order book itself emitted: an event's name alone can be copied by any component.
        if (e?.emitter?.entity?.entity_address !== component || !Array.isArray(e.data?.fields)) continue;
        const f = (name: string) => String(field(e.data.fields, name));
        const id = Number(f('id'));
        if (!Number.isSafeInteger(id)) continue;
        if (e.name === 'OrderPlacedEvent') placed.push({ id, txid: t.intent_hash, time });
        else if (e.name === 'OrderFilledEvent') fills.push({ id, txid: t.intent_hash, time, sold: f('sold'), paid: f('paid'), fee: f('fee') });
      }
    }
    cursor = j?.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return { placed, fills, next };
}

/**
 * Root manifest with which the solver settles two book orders that cross: it pays `pay` into
 * `first`, passes everything that buys into `second`, and must get at least `minBack` of the
 * token it started with, or the transaction fails.
 */
export function bookCrossManifest(o: { solver: SolverIdentity; feeLockXrd: string; book: string; first: number; second: number; payResource: string; pay: string; middleResource: string; minBack: string }): string {
  return [
    `CALL_METHOD ${addr(o.solver.account)} "lock_fee" ${dec(o.feeLockXrd)};`,
    `CALL_METHOD ${addr(o.solver.account)} "withdraw" ${addr(o.payResource)} ${dec(o.pay)};`,
    ...bookFillInstructions(o.book, o.first, o.payResource, o.pay, 'pay'),
    `TAKE_ALL_FROM_WORKTOP ${addr(o.middleResource)} ${bucket('middle')};`,
    `CALL_METHOD ${addr(o.book)} "fill" ${u64(o.second)} ${bucket('middle')};`,
    `ASSERT_WORKTOP_CONTAINS ${addr(o.payResource)} ${dec(o.minBack)};`,
    `CALL_METHOD ${addr(o.solver.account)} "deposit_batch" Expression("ENTIRE_WORKTOP");`,
  ].join('\n');
}

/**
 * How much the solver should put through two book orders that cross, or undefined if they do
 * not cross by enough to pay `gas` (in the token it fronts). `first` sells what `second` buys.
 * The solver pays `pay` of first.buy, receives `middle` of first.sell, and gets `back` of first.buy.
 */
export function planBookCross(first: BookOrder, second: BookOrder, float: string, gas: string, divisibility: (resource: string) => number): { pay: string; middle: string; back: string } | undefined {
  if (first.id === second.id || first.sell !== second.buy || first.buy !== second.sell) return undefined;
  const p1 = new Decimal(first.price), p2 = new Decimal(second.price);
  if (!p1.mul(p2).lt(1)) return undefined; // prices do not cross
  const midDiv = divisibility(first.sell), payDiv = divisibility(first.buy);
  // The most of the middle token that both orders and the solver's funds allow.
  const middle = Decimal.min(first.remaining, new Decimal(second.remaining).mul(p2), new Decimal(float).div(p1)).toDecimalPlaces(midDiv, Decimal.ROUND_DOWN);
  if (!middle.gt(0)) return undefined;
  const pay = middle.mul(p1).toDecimalPlaces(payDiv, Decimal.ROUND_UP);
  const back = Decimal.min(middle.div(p2).toDecimalPlaces(payDiv, Decimal.ROUND_DOWN), second.remaining);
  if (pay.gt(float) || !back.minus(pay).minus(gas).gt(0)) return undefined;
  return { pay: pay.toFixed(), middle: middle.toFixed(), back: back.toFixed() };
}
