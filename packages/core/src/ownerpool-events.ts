import type { Gateway } from './gateway.ts';

/**
 * An OwnerPool's own events, read from the Gateway transaction stream (scrypto/owner-pool/src/lib.rs).
 * Used by the market-making bot (the owner's last stated anchor) and by the read-only watcher.
 *
 * What the contract emits, and why the owner's anchor can be recovered from it exactly:
 * - `OwnerPoolAnchorEvent { anchor_a, anchor_b }` is emitted ONLY by `state_anchor`, which only the
 *   owner-restricted `set_operator` (appoint/replace, anchor required) and `set_anchor` call.
 * - An operator `rebalance` also moves the anchor stored on ledger (to the new reserves), but emits
 *   no anchor event: it emits `OwnerPoolRebalanceEvent { by_owner: false, ... }`. Revoking the
 *   operator (`set_operator(None, None)`) leaves the anchor alone and emits no anchor event.
 * So the owner's last stated anchor is the payload of the most recent `OwnerPoolAnchorEvent` whose
 * emitter is the pool component's Main module, in a committed-success transaction. The anchor on
 * ledger (`operator_status`) is NOT that: after any operator move it is the operator's last price.
 *
 * Events are trusted only when the emitter is the pool component itself (Main module): an event's
 * name alone can be copied by any other component in the same transaction.
 */

export type OwnerPoolEvent =
  | { name: 'OwnerPoolAnchorEvent'; anchorA: string; anchorB: string }
  | { name: 'OwnerPoolRebalanceEvent'; amountA: string; amountB: string; reserveA: string; reserveB: string; inventoryA: string; inventoryB: string; cost: string; allowance: string; byOwner: boolean }
  | { name: 'OwnerPoolConfigEvent'; feeBps: number; paused: boolean; operatorPaused: boolean }
  /** `fee` is in the INPUT resource, kept by the pool; amounts as the contract emits them; reserves after the swap. */
  | { name: 'OwnerPoolSwapEvent'; reserveA: string; reserveB: string; inputResource?: string; inputAmount?: string; outputResource?: string; outputAmount?: string; fee?: string }
  /** `limits`: the operator limits in force after the call (field name -> value as text), when the event carries them. */
  | { name: 'OwnerPoolOperatorEvent'; operator: string | null; limits?: Record<string, string> }
  | { name: 'OwnerPoolLiquidityEvent'; reserveA: string; reserveB: string }
  | { name: 'OwnerPoolInventoryEvent'; inventoryA: string; inventoryB: string };

export interface OwnerPoolTx {
  txid: string;
  stateVersion: number;
  /** ms since epoch (confirmed_at, else round_timestamp). */
  at: number;
  /** Methods the root manifest calls on the pool, in order (empty when the manifest was not requested). */
  methods: string[];
  /** Every resource address the root manifest names (e.g. the badge it proves). */
  resources: string[];
  /** The pool's own events, in emission order. */
  events: OwnerPoolEvent[];
}

const fieldOf = (fields: any[], name: string): any => fields.find((x) => x?.field_name === name);
const str = (fields: any[], name: string): string => {
  const v = fieldOf(fields, name)?.value;
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`event field ${name} is not a decimal`);
  return v;
};
const bool = (fields: any[], name: string): boolean => {
  const v = fieldOf(fields, name)?.value;
  if (typeof v !== 'boolean') throw new Error(`event field ${name} is not a bool`);
  return v;
};

/** One event payload (Gateway programmatic JSON) as a typed record, or undefined for names we do not read. Throws on a malformed payload. */
export function parseOwnerPoolEvent(name: string, fields: any[]): OwnerPoolEvent | undefined {
  switch (name) {
    case 'OwnerPoolAnchorEvent':
      return { name, anchorA: str(fields, 'anchor_a'), anchorB: str(fields, 'anchor_b') };
    case 'OwnerPoolRebalanceEvent':
      return {
        name, amountA: str(fields, 'amount_a'), amountB: str(fields, 'amount_b'), reserveA: str(fields, 'reserve_a'), reserveB: str(fields, 'reserve_b'),
        inventoryA: str(fields, 'inventory_a'), inventoryB: str(fields, 'inventory_b'), cost: str(fields, 'cost'), allowance: str(fields, 'allowance'), byOwner: bool(fields, 'by_owner'),
      };
    case 'OwnerPoolConfigEvent': {
      const fee = Number(fieldOf(fields, 'fee_bps')?.value);
      if (!Number.isInteger(fee) || fee < 0) throw new Error('event field fee_bps is not a u16');
      return { name, feeBps: fee, paused: bool(fields, 'paused'), operatorPaused: bool(fields, 'operator_paused') };
    }
    case 'OwnerPoolSwapEvent': {
      const res = (n: string) => { const v = fieldOf(fields, n)?.value; return typeof v === 'string' && v.startsWith('resource_') ? v : undefined; };
      const opt = (n: string) => (fieldOf(fields, n) ? str(fields, n) : undefined);
      return {
        name, reserveA: str(fields, 'reserve_a'), reserveB: str(fields, 'reserve_b'),
        inputResource: res('input_resource'), inputAmount: opt('input_amount'), outputResource: res('output_resource'), outputAmount: opt('output_amount'), fee: opt('fee'),
      };
    }
    case 'OwnerPoolLiquidityEvent':
      return { name, reserveA: str(fields, 'reserve_a'), reserveB: str(fields, 'reserve_b') };
    case 'OwnerPoolInventoryEvent':
      return { name, inventoryA: str(fields, 'inventory_a'), inventoryB: str(fields, 'inventory_b') };
    case 'OwnerPoolOperatorEvent': {
      const f = fieldOf(fields, 'operator');
      // Option<ResourceAddress>: Some has one field holding the address.
      const v = f?.fields?.[0]?.value;
      const lf = fieldOf(fields, 'limits')?.fields;
      const limits = Array.isArray(lf) ? Object.fromEntries(lf.filter((x: any) => typeof x?.field_name === 'string').map((x: any) => [x.field_name, String(x.value)])) : undefined;
      return { name, operator: typeof v === 'string' ? v : null, ...(limits ? { limits } : {}) };
    }
    default:
      return undefined;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One transaction from `/stream/transactions` (opt-ins `receipt_events`, and `manifest_instructions`
 * for `methods`/`resources`) reduced to the pool's own events. Undefined for anything that is not a
 * committed success. A malformed event from the pool itself throws (the caller must not guess).
 */
export function parseOwnerPoolTransaction(t: any, pool: string): OwnerPoolTx | undefined {
  if (t?.transaction_status !== 'CommittedSuccess' || typeof t.intent_hash !== 'string' || typeof t.state_version !== 'number') return undefined;
  const events: OwnerPoolEvent[] = [];
  for (const e of t.receipt?.events ?? []) {
    if (e?.emitter?.entity?.entity_address !== pool || !Array.isArray(e.data?.fields)) continue;
    if (e.emitter.object_module_id && e.emitter.object_module_id !== 'Main') continue;
    const ev = parseOwnerPoolEvent(String(e.name), e.data.fields);
    if (ev) events.push(ev);
  }
  const manifest = typeof t.manifest_instructions === 'string' ? t.manifest_instructions : '';
  const methods = [...manifest.matchAll(new RegExp(`CALL_METHOD\\s+Address\\("${escapeRe(pool)}"\\)\\s+"(\\w+)"`, 'g'))].map((m) => m[1]!);
  const resources = [...new Set([...manifest.matchAll(/Address\("(resource_[a-z0-9_]+)"\)/g)].map((m) => m[1]!))];
  const at = Date.parse(t.confirmed_at ?? t.round_timestamp ?? '');
  return { txid: t.intent_hash, stateVersion: t.state_version, at: Number.isFinite(at) ? at : 0, methods, resources, events };
}

export interface OwnerAnchorStatement {
  anchor: [string, string];
  txid: string;
  stateVersion: number;
  at: number;
}

/** The owner's most recent anchor statement in `txs` (any order): the last `OwnerPoolAnchorEvent` of the highest state version. */
export function lastOwnerAnchor(txs: OwnerPoolTx[]): OwnerAnchorStatement | undefined {
  let best: OwnerAnchorStatement | undefined;
  for (const t of txs) {
    const evs = t.events.filter((e): e is Extract<OwnerPoolEvent, { name: 'OwnerPoolAnchorEvent' }> => e.name === 'OwnerPoolAnchorEvent');
    const last = evs[evs.length - 1];
    if (!last) continue;
    if (!(Number(last.anchorA) > 0 && Number(last.anchorB) > 0)) continue; // the contract refuses these; never trust one
    if (!best || t.stateVersion > best.stateVersion) best = { anchor: [last.anchorA, last.anchorB], txid: t.txid, stateVersion: t.stateVersion, at: t.at };
  }
  return best;
}

/** One page of the pool's transactions (only those in which the pool emitted an event), parsed. */
async function streamPage(gateway: Gateway, pool: string, o: { order: 'asc' | 'desc'; cursor?: string; fromStateVersion?: number; manifest: boolean; limit?: number }): Promise<{ txs: OwnerPoolTx[]; raw: any[]; next?: string; beyondEnd?: boolean }> {
  let j: any;
  try {
    j = await gateway.post('/stream/transactions', {
      event_global_emitters_filter: [pool], order: o.order, limit_per_page: o.limit ?? 100, cursor: o.cursor,
      ...(o.fromStateVersion !== undefined && !o.cursor ? { from_ledger_state: { state_version: o.fromStateVersion } } : {}),
      opt_ins: { receipt_events: true, manifest_instructions: o.manifest },
    });
  } catch (e) {
    // Asking from just past the newest transaction is refused rather than answered with nothing.
    if (String((e as { body?: string }).body ?? '').includes('beyond the end of the known ledger')) return { txs: [], raw: [], beyondEnd: true };
    throw e;
  }
  const raw: any[] = Array.isArray(j?.items) ? j.items : [];
  const txs = raw.map((t) => parseOwnerPoolTransaction(t, pool)).filter((t): t is OwnerPoolTx => !!t);
  return { txs, raw, next: j?.next_cursor ?? undefined };
}

/**
 * The pool's transactions from `fromStateVersion` on, oldest first, at most `maxPages` pages of 100.
 * `next` is where to resume (one past the newest state version seen); `complete` is false when
 * `maxPages` ran out before the stream did.
 */
export async function readOwnerPoolTransactions(gateway: Gateway, pool: string, fromStateVersion: number, o: { maxPages?: number; manifest?: boolean } = {}): Promise<{ txs: OwnerPoolTx[]; next: number; complete: boolean }> {
  const txs: OwnerPoolTx[] = [];
  let cursor: string | undefined, next = fromStateVersion;
  for (let page = 0; page < (o.maxPages ?? 50); page++) {
    const r = await streamPage(gateway, pool, { order: 'asc', cursor, fromStateVersion, manifest: o.manifest ?? true });
    for (const t of r.raw) if (typeof t?.state_version === 'number') next = Math.max(next, t.state_version + 1);
    txs.push(...r.txs);
    cursor = r.next;
    if (!cursor) return { txs, next, complete: true };
  }
  return { txs, next, complete: false };
}

/**
 * The owner's last stated anchor, searching the pool's event stream newest first until an anchor
 * statement is found. `found: false, complete: true`: the pool has never had one (the bot must not
 * rebalance). `complete: false`: the search stopped at `maxPages` without finding one (undetermined).
 * `newest` is the newest state version seen (resume an incremental check from `newest + 1`).
 */
export async function findOwnerAnchor(gateway: Gateway, pool: string, o: { maxPages?: number } = {}): Promise<{ statement?: OwnerAnchorStatement; complete: boolean; newest: number; scanned: number }> {
  let cursor: string | undefined, newest = 0, scanned = 0;
  for (let page = 0; page < (o.maxPages ?? 50); page++) {
    const r = await streamPage(gateway, pool, { order: 'desc', cursor, manifest: false });
    for (const t of r.raw) if (typeof t?.state_version === 'number') newest = Math.max(newest, t.state_version);
    scanned += r.raw.length;
    const statement = lastOwnerAnchor(r.txs);
    if (statement) return { statement, complete: true, newest, scanned };
    cursor = r.next;
    if (!cursor) return { complete: true, newest, scanned };
  }
  return { complete: false, newest, scanned };
}

/**
 * Bring a known owner anchor up to date: read only what came after `scannedTo` (the newest state
 * version already searched). A newer statement replaces `known`.
 */
export async function refreshOwnerAnchor(gateway: Gateway, pool: string, known: OwnerAnchorStatement | undefined, scannedTo: number, o: { maxPages?: number } = {}): Promise<{ statement?: OwnerAnchorStatement; complete: boolean; newest: number }> {
  const r = await readOwnerPoolTransactions(gateway, pool, scannedTo + 1, { maxPages: o.maxPages ?? 20, manifest: false });
  const newer = lastOwnerAnchor(r.txs);
  const statement = newer && (!known || newer.stateVersion > known.stateVersion) ? newer : known;
  return { statement, complete: r.complete, newest: Math.max(scannedTo, r.next - 1) };
}
