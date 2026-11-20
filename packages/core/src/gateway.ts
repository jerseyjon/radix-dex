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

  constructor(network: NetworkConfig, opts: { url?: string; fetch?: FetchLike } = {}) {
    this.network = network;
    this.url = (opts.url ?? network.gatewayUrl).replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async post(path: string, body: unknown): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(this.url + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
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
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
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

  async entityDetails(addresses: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < addresses.length; i += 20) {
      const j = await this.post('/state/entity/details', { addresses: addresses.slice(i, i + 20) });
      out.push(...(j.items ?? []));
    }
    return out;
  }

  /** Largest holders of a fungible resource (Gateway extension endpoint). */
  async resourceHolders(resource: string, limit = 20): Promise<{ address: string; amount: string }[]> {
    const j = await this.post('/extensions/resource-holders/page', { resource_address: resource, limit_per_page: limit });
    return (j.items ?? []).map((i: any) => ({ address: String(i.holder_address), amount: String(i.amount) }));
  }
}
