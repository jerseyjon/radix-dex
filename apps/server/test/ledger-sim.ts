// A small stand-in for the Radix Engine, for tests: runs the solver's root manifests (the lines
// core writes, nothing else) against linear pools, signed orders and book orders, and reports where
// every token went. It is what lets the tests check the rule that matters: after any fill, the
// solver holds nothing but XRD, and the users got at least what they signed for.
import { Decimal, bookFillOutcome, type BookOrder } from '@radix-dex/core';

export interface SimChild { sell: string; sellAmount: string; buy: string; minBuyAmount: string }
export interface SimWorld {
  solver: string;
  xrd: string;
  /** Pool component → (sell token, amount) → what comes out, in which token. */
  pools: Record<string, (sell: string, amount: Decimal) => { token: string; amount: Decimal }>;
  /** Named subintents (taker, maker_0…), each a signed order. */
  children: Record<string, SimChild>;
  /** Book orders by id, and the divisibility of each token. */
  book?: Map<number, BookOrder>;
  divisibility?: (r: string) => number;
}
export interface SimResult {
  /** What the solver's account gained (or lost, negative) of each token, the fee lock aside. */
  solver: Record<string, Decimal>;
  /** What each child received. */
  received: Record<string, Record<string, Decimal>>;
}

const A = /Address\("([^"]+)"\)/g;
const addrs = (l: string) => [...l.matchAll(A)].map((m) => m[1]!);
const decOf = (l: string) => new Decimal(/Decimal\("([^"]+)"\)/.exec(l)![1]!);
const bucketOf = (l: string) => /Bucket\("([^"]+)"\)/.exec(l)?.[1];

export function simulate(manifest: string, w: SimWorld): SimResult {
  const worktop = new Map<string, Decimal>();
  const buckets = new Map<string, { token: string; amount: Decimal }>();
  const solver: Record<string, Decimal> = {};
  const received: Record<string, Record<string, Decimal>> = {};
  const yielded = new Set<string>();
  const put = (token: string, amount: Decimal) => { if (amount.gt(0)) worktop.set(token, (worktop.get(token) ?? new Decimal(0)).plus(amount)); };
  const take = (token: string, amount: Decimal) => {
    const have = worktop.get(token) ?? new Decimal(0);
    if (have.lt(amount)) throw new Error(`worktop has ${have} of ${token}, not ${amount}`);
    worktop.set(token, have.minus(amount));
    return { token, amount };
  };
  const credit = (token: string, amount: Decimal) => { solver[token] = (solver[token] ?? new Decimal(0)).plus(amount); };
  const useBucket = (name: string) => { const b = buckets.get(name); if (!b) throw new Error(`no bucket ${name}`); buckets.delete(name); return b; };
  for (const raw of manifest.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const [a0, a1] = addrs(l);
    if (l.startsWith('CALL_METHOD') && /"(lock_fee|create_proof_of_amount)"/.test(l)) continue;
    if (l.startsWith('YIELD_TO_CHILD')) {
      const name = /NamedIntent\("([^"]+)"\)/.exec(l)![1]!;
      const c = w.children[name]!;
      const b = bucketOf(l);
      if (!yielded.has(name)) {
        if (b) throw new Error(`${name} handed a bucket before it yielded its sale`);
        yielded.add(name); put(c.sell, new Decimal(c.sellAmount)); continue;
      }
      // ASSERT_NEXT_CALL_RETURNS_ONLY { buy => at least min }
      const got = b ? useBucket(b) : { token: c.buy, amount: new Decimal(0) };
      if (got.token !== c.buy) throw new Error(`${name} was handed ${got.token}, which its order refuses`);
      if (got.amount.lt(c.minBuyAmount)) throw new Error(`${name} got ${got.amount}, below its signed minimum ${c.minBuyAmount}`);
      received[name] = { ...(received[name] ?? {}), [got.token]: got.amount };
      continue;
    }
    if (l.startsWith('TAKE_FROM_WORKTOP')) { buckets.set(bucketOf(l)!, take(a0!, decOf(l))); continue; }
    if (l.startsWith('TAKE_ALL_FROM_WORKTOP')) { buckets.set(bucketOf(l)!, take(a0!, worktop.get(a0!) ?? new Decimal(0))); continue; }
    if (l.startsWith('ASSERT_WORKTOP_CONTAINS')) {
      if ((worktop.get(a0!) ?? new Decimal(0)).lt(decOf(l))) throw new Error(`assert: worktop holds less than ${decOf(l)} of ${a0}`);
      continue;
    }
    if (l.startsWith('ASSERT_WORKTOP_RESOURCES_ONLY')) {
      const allowed = new Set(addrs(l));
      for (const [t, v] of worktop) if (v.gt(0) && !allowed.has(t)) throw new Error(`assert: worktop holds ${v} of ${t}, which is not allowed`);
      continue;
    }
    if (l.startsWith('CALL_METHOD')) {
      const method = /"([a-z_]+)"/.exec(l)![1]!;
      if (a0 === w.solver && method === 'deposit') { const b = useBucket(bucketOf(l)!); credit(b.token, b.amount); continue; }
      if (a0 === w.solver && method === 'deposit_batch') { for (const [t, v] of worktop) if (v.gt(0)) credit(t, v); worktop.clear(); continue; }
      if (a0 === w.solver && method === 'withdraw') { const v = decOf(l); credit(a1!, v.neg()); put(a1!, v); continue; }
      if (method === 'swap') {
        const b = useBucket(bucketOf(l)!);
        const r = w.pools[a0!]!(b.token, b.amount);
        put(r.token, r.amount); continue;
      }
      if (method === 'fill') {
        const id = Number(/(\d+)u64/.exec(l)![1]);
        const o = w.book!.get(id)!;
        const b = useBucket(bucketOf(l)!);
        if (b.token !== o.buy) throw new Error('wrong payment token');
        const r = bookFillOutcome(o, b.amount, w.divisibility!(o.sell), w.divisibility!(o.buy));
        if (!r) throw new Error('Payment too small');
        o.remaining = new Decimal(o.remaining).minus(r.sold).toFixed();
        put(o.sell, r.sold); put(o.buy, r.change); continue;
      }
    }
    throw new Error(`simulator does not know: ${l}`);
  }
  for (const [name] of Object.entries(w.children)) if (!yielded.has(name)) throw new Error(`${name} never ran`);
  for (const [t, v] of worktop) if (v.gt(0)) throw new Error(`transaction ends with ${v} of ${t} on the worktop`);
  return { solver, received };
}
