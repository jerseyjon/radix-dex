import type { NetworkConfig } from './types.ts';

export class GatewayError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(path: string, status: number, body: string) {
    super(`Gateway ${path} failed: HTTP ${status} ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export interface PreviewResult {
  ok: boolean;
  error?: string;
  feeXrd: string;
  /** Net balance change per global entity per resource, as decimal strings. */
  changes: { entity: string; resource: string; amount: string }[];
  raw: any;
}

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Minimal Gateway API client: only the calls this project needs, each validated at the boundary. */
export class Gateway {
  readonly network: NetworkConfig;
  private readonly fetchFn: FetchLike;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  /** Calls that failed after every retry, and the most recent such failure: for the operator's health view. */
  failures = 0;
  lastFailure: { at: number; path: string; message: string } | undefined;

  /**
   * `timeoutMs` and `attempts` bound how long one call can take: about attempts × timeoutMs plus
   * short back-offs. Request handlers should use a client with small values, so a slow Gateway
   * cannot hold a visitor's request for a minute.
   */
  constructor(network: NetworkConfig, opts: { url?: string; fetch?: FetchLike; timeoutMs?: number; attempts?: number } = {}) {
    this.network = network;
    this.url = (opts.url ?? network.gatewayUrl).replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.attempts = Math.max(1, opts.attempts ?? 3);
  }

  async post(path: string, body: unknown): Promise<any> {
    try {
      return await this.postOnce(path, body);
    } catch (e) {
      // A 4xx is the caller's mistake (or a normal "not found"), not the Gateway failing.
      if (!(e instanceof GatewayError && e.status < 500 && e.status !== 429)) {
        this.failures++;
        this.lastFailure = { at: Date.now(), path, message: String((e as Error)?.message ?? e).slice(0, 300) };
      }
      throw e;
    }
  }

  private async postOnce(path: string, body: unknown): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        const res = await this.fetchFn(this.url + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          // 4xx other than 429 will not get better on retry.
          if (res.status < 500 && res.status !== 429) throw new GatewayError(path, res.status, text);
          lastErr = new GatewayError(path, res.status, text);
        } else {
          return JSON.parse(text);
        }
      } catch (e) {
        if (e instanceof GatewayError && e.status < 500 && e.status !== 429) throw e;
        lastErr = e;
      }
      if (attempt + 1 < this.attempts) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
    throw lastErr;
  }

  async status(): Promise<{ epoch: number; stateVersion: number; timestamp: string }> {
    const j = await this.post('/status/gateway-status', {});
    const ls = j?.ledger_state;
    if (!ls || typeof ls.epoch !== 'number') throw new Error('Unexpected gateway-status response');
    if (ls.network !== this.network.name) {
      throw new Error(`Gateway is on network "${ls.network}", expected "${this.network.name}"`);
    }
    return { epoch: ls.epoch, stateVersion: ls.state_version, timestamp: ls.proposer_round_timestamp };
  }

  /**
   * Recent swaps between `base` and `quote` in transactions that touched `component` (a pool), newest first.
   * Only movements of `holders` count as the pool's side of a trade (see `swapsInTransaction`).
   */
  async swapsAt(component: string, base: string, quote: string, limit = 30, holders: string[] = [component]): Promise<LedgerSwap[]> {
    const j = await this.post('/stream/transactions', {
      affected_global_entities_filter: [component], order: 'desc', limit_per_page: Math.min(limit, 100), opt_ins: { balance_changes: true, receipt_events: true },
    });
    return (j?.items ?? []).flatMap((t: any) => swapsInTransaction(t, base, quote, new Set(holders)));
  }

  /**
   * The account's most recent committed transactions with its own net balance change per
   * resource (network fees reported separately, in XRD).
   */
  async accountActivity(account: string, limit = 40): Promise<{ txid: string; time: number; changes: Record<string, string>; feeXrd: string }[]> {
    const j = await this.post('/stream/transactions', {
      affected_global_entities_filter: [account], order: 'desc', limit_per_page: Math.min(limit, 100), opt_ins: { balance_changes: true },
    });
    const out: { txid: string; time: number; changes: Record<string, string>; feeXrd: string }[] = [];
    for (const t of j?.items ?? []) {
      if (t?.transaction_status !== 'CommittedSuccess' || typeof t.intent_hash !== 'string') continue;
      const changes: Record<string, string> = {};
      for (const c of t.balance_changes?.fungible_balance_changes ?? []) {
        if (c?.entity_address === account && typeof c.resource_address === 'string') changes[c.resource_address] = String(c.balance_change);
      }
      let fee = 0;
      for (const c of t.balance_changes?.fungible_fee_balance_changes ?? []) {
        if (c?.entity_address === account && c.type === 'FeePayment') fee += Math.abs(Number(c.balance_change));
      }
      out.push({ txid: t.intent_hash, time: Math.floor(Date.parse(t.confirmed_at ?? t.round_timestamp) / 1000), changes, feeXrd: String(fee) });
    }
    return out;
  }

  /**
   * Preview a V1 manifest with free fee credit and all signatures assumed.
   * Nothing is submitted. Used for quoting against real pools.
   */
  async preview(manifest: string, epoch: number): Promise<PreviewResult> {
    const j = await this.post('/transaction/preview', {
      manifest,
      start_epoch_inclusive: epoch,
      end_epoch_exclusive: epoch + 10,
      tip_percentage: 0,
      nonce: Math.floor(Math.random() * 2 ** 31),
      signer_public_keys: [],
      flags: { use_free_credit: true, assume_all_signature_proofs: true, skip_epoch_check: true },
    });
    const receipt = j?.receipt;
    if (!receipt) throw new Error('Preview response has no receipt');
    const ok = receipt.status === 'Succeeded';
    const fs = receipt.fee_summary ?? {};
    const fee = ['xrd_total_execution_cost', 'xrd_total_finalization_cost', 'xrd_total_royalty_cost', 'xrd_total_storage_cost', 'xrd_total_tipping_cost']
      .reduce((a, k) => a + Number(fs[k] ?? 0), 0);
    const changes: PreviewResult['changes'] = [];
    for (const group of j.resource_changes ?? []) {
      for (const c of group.resource_changes ?? []) {
        changes.push({ entity: c.component_entity?.entity_address, resource: c.resource_address, amount: String(c.amount) });
      }
    }
    return { ok, error: ok ? undefined : String(receipt.error_message ?? receipt.status), feeXrd: fee.toFixed(6), changes, raw: j };
  }

  /**
   * Preview a whole V2 transaction exactly as it would be submitted (a compiled PreviewTransactionV2,
   * see `BuiltTransaction.previewHex`): the same root intent, the same signed children, signers given
   * by public key. No free credit and no assumed signatures, so the fee lock and every withdrawal
   * are checked as they would be on ledger. Nothing is submitted.
   */
  async previewV2(previewHex: string): Promise<{ ok: boolean; status: string; error?: string; feeXrd: string }> {
    const j = await this.post('/transaction/preview-v2', {
      preview_transaction: { type: 'Compiled', preview_transaction_hex: previewHex },
      flags: { use_free_credit: false, assume_all_signature_proofs: false, skip_epoch_check: false, disable_auth_checks: false },
      opt_ins: { core_api_receipt: true },
    });
    const receipt = j?.receipt;
    if (!receipt || typeof receipt.status !== 'string') throw new Error('Preview response has no receipt');
    const fs = receipt.fee_summary ?? {};
    const fee = ['xrd_total_execution_cost', 'xrd_total_finalization_cost', 'xrd_total_royalty_cost', 'xrd_total_storage_cost', 'xrd_total_tipping_cost']
      .reduce((a, k) => a + Number(fs[k] ?? 0), 0);
    const ok = receipt.status === 'Succeeded';
    return { ok, status: receipt.status, error: ok ? undefined : String(receipt.error_message ?? receipt.status), feeXrd: fee.toFixed(6) };
  }

  /** Hand a notarised transaction to the network. Throws if the Gateway refuses it or cannot be reached. */
  async submitTransaction(hex: string): Promise<void> {
    await this.post('/transaction/submit', { notarized_transaction_hex: hex });
  }

  /**
   * Where a transaction stands. `Pending` covers everything not yet final, including "not seen":
   * only the intent's expiry turns that into a certain "never committed".
   */
  async transactionStatus(intentHashId: string): Promise<{ status: 'CommittedSuccess' | 'CommittedFailure' | 'Rejected' | 'Pending'; error?: string }> {
    const s = await this.post('/transaction/status', { intent_hash: intentHashId });
    const error = String(s?.error_message ?? s?.intent_status_description ?? '');
    if (s?.intent_status === 'CommittedSuccess') return { status: 'CommittedSuccess' };
    if (s?.intent_status === 'CommittedFailure') return { status: 'CommittedFailure', error };
    if (s?.intent_status === 'PermanentlyRejected') return { status: 'Rejected', error };
    return { status: 'Pending', error };
  }

  /** The network fee a committed transaction paid, in XRD, or undefined if the Gateway does not say. */
  async committedFee(intentHashId: string): Promise<string | undefined> {
    const j = await this.post('/transaction/committed-details', { intent_hash: intentHashId, opt_ins: {} });
    const fee = j?.transaction?.fee_paid;
    return typeof fee === 'string' && /^\d+(\.\d+)?$/.test(fee) ? fee : undefined;
  }

  async entityDetails(addresses: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < addresses.length; i += 20) {
      const j = await this.post('/state/entity/details', { addresses: addresses.slice(i, i + 20) });
      out.push(...(j.items ?? []));
    }
    return out;
  }

  /**
   * Every fungible balance of an account, by resource address. Follows the pages: the entity-details
   * call alone returns only the first hundred tokens, which for a busy account may not include XRD.
   */
  async fungibleBalances(account: string, maxPages = 20): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const add = (items: any[]) => { for (const i of items ?? []) if (typeof i?.amount === 'string' && typeof i.resource_address === 'string') out[i.resource_address] = i.amount; };
    const first = await this.post('/state/entity/details', { addresses: [account] });
    const page = first.items?.[0]?.fungible_resources;
    add(page?.items);
    let cursor: string | undefined = page?.next_cursor ?? undefined;
    const at = first.ledger_state?.state_version;
    for (let n = 1; cursor && n < maxPages; n++) {
      // Later pages must be read at the same ledger state as the first, or the cursor is refused.
      const j = await this.post('/state/entity/page/fungibles/', { address: account, cursor, at_ledger_state: { state_version: at } });
      add(j.items);
      cursor = j.next_cursor ?? undefined;
    }
    if (cursor) throw new Error('Account holds more tokens than can be listed');
    return out;
  }

  /**
   * An account's balance of one fungible resource, as a decimal string.
   * Asks for that resource's vaults directly, so it is right even for accounts holding hundreds of tokens
   * (the entity-details call only returns the first page of them).
   */
  async fungibleBalance(account: string, resource: string): Promise<string> {
    const j = await this.post('/state/entity/page/fungible-vaults/', { address: account, resource_address: resource });
    let total = 0n;
    for (const v of j.items ?? []) {
      const [whole, frac = ''] = String(v.amount).split('.');
      total += BigInt(whole!) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
    }
    const s = total.toString().padStart(19, '0');
    return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '') || '0';
  }

  /** Largest holders of a fungible resource (Gateway extension endpoint). */
  async resourceHolders(resource: string, limit = 20): Promise<{ address: string; amount: string }[]> {
    const j = await this.post('/extensions/resource-holders/page', { resource_address: resource, limit_per_page: limit });
    return (j.items ?? []).map((i: any) => ({ address: String(i.holder_address), amount: String(i.amount) }));
  }
}

/** One swap against a pool, read from a committed transaction. `side` is what the trader did with the base token. */
export interface LedgerSwap { txid: string; time: number; side: 'buy' | 'sell'; price: number; size: number; entity: string }

/**
 * The swaps between `base` and `quote` inside one transaction of the Gateway's stream (with
 * balance changes): an entity in `holders` (a pool's own component, or the native pool that holds
 * its funds) whose holdings of the two moved in opposite directions took one side of a trade.
 * Any other component is ignored: an aggregator or arbitrage contract passing both tokens through
 * on a longer route is not a trade in this market. Adding or removing liquidity moves both the
 * same way and is ignored. Without `holders`, every non-account entity counts (old behaviour).
 *
 * A transaction in which a holder's liquidity changed (its receipt events, when present, include a
 * liquidity event from a holder) is left out whole: liquidity taken out and put back at another
 * ratio or range in one transaction (a concentrated position moved, a zap, a pool repriced) nets
 * to opposite moves that are not a trade, and any real swap inside it cannot be told apart from
 * the net figures. Missing such a swap on the tape is better than showing one that never happened.
 */
export function swapsInTransaction(t: any, base: string, quote: string, holders?: Set<string>): LedgerSwap[] {
  if (t?.transaction_status !== 'CommittedSuccess' || typeof t.intent_hash !== 'string') return [];
  if (changesLiquidity(t, holders)) return [];
  const time = Math.floor(Date.parse(t.confirmed_at ?? t.round_timestamp) / 1000);
  const net = new Map<string, { b: number; q: number }>();
  for (const c of t.balance_changes?.fungible_balance_changes ?? []) {
    const entity = c?.entity_address, resource = c?.resource_address, change = Number(c?.balance_change);
    if (typeof entity !== 'string' || entity.startsWith('account_') || !Number.isFinite(change) || (resource !== base && resource !== quote)) continue;
    if (holders && !holders.has(entity)) continue;
    const n = net.get(entity) ?? { b: 0, q: 0 };
    if (resource === base) n.b += change; else n.q += change;
    net.set(entity, n);
  }
  const out: LedgerSwap[] = [];
  for (const [entity, { b, q }] of net) {
    if (!(b * q < 0) || !Number.isFinite(time)) continue;
    // The pool gained base: a trader sold it. The pool lost base: a trader bought it.
    out.push({ txid: t.intent_hash, time, side: b > 0 ? 'sell' : 'buy', price: Math.abs(q / b), size: Math.abs(b), entity });
  }
  return out;
}

/**
 * Liquidity events of the pools we read: Ociswap precision pools and DefiPlaza pairs (Add/RemoveLiquidityEvent),
 * native pools behind Ociswap basic pools and DefiPlaza pairs (Contribution/RedemptionEvent), the
 * test pool used on Stokenet (LiquidityEvent), and OwnerPools (OwnerPoolLiquidityEvent: the owner's deposits and withdrawals).
 */
const LIQUIDITY_EVENT = /^(AddLiquidity|RemoveLiquidity|Liquidity|OwnerPoolLiquidity|Contribution|Redemption)Event$/;

/** Whether one of `holders` (any non-account entity without them) emitted a liquidity event in the transaction. */
function changesLiquidity(t: any, holders?: Set<string>): boolean {
  for (const e of t?.receipt?.events ?? []) {
    const emitter = e?.emitter?.entity?.entity_address;
    if (typeof e?.name !== 'string' || typeof emitter !== 'string' || !LIQUIDITY_EVENT.test(e.name)) continue;
    if (holders ? holders.has(emitter) : !emitter.startsWith('account_')) return true;
  }
  return false;
}

