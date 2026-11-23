import type { Gateway } from './gateway.ts';
import { parseOwnerPoolDetails, type OwnerPoolState } from './ownerpool.ts';

/**
 * Finding the owner's OwnerPools on the ledger instead of listing each one by hand.
 *
 * Anyone can instantiate the public OwnerPool package, under any name and with any badge of their own
 * as its owner, so nothing a transaction SAYS is trusted. Discovery has two steps:
 *
 * 1. Candidates: components created by a committed transaction that presented one of the configured
 *    owner badges (`/stream/transactions` with `manifest_badges_presented_filter`, opt-in
 *    `receipt_state_changes` for `new_global_entities`). This only narrows the search: a candidate is a
 *    hint, not a listing.
 * 2. Acceptance, from the component's own state on the ledger: it must be an `OwnerPool` component of an
 *    allow-listed package (`OWNER_POOL_PACKAGES`), a split pool, and its `owner_badge` field must be one
 *    of the configured badges. The blueprint asserts a proof of `owner_badge` at instantiation
 *    (lib.rs `build`) and has no method that changes it, so a pool that names our badge was made by
 *    whoever holds the badge, and stays ours.
 *
 * A pool someone else instantiates with their OWN badge fails step 2 whatever else it looks like.
 */

/** Why a candidate component is not listed (one line, for logs and tests). */
export type DiscoveryVerdict = { accepted: true; state: OwnerPoolState } | { accepted: false; reason: string };

/**
 * Step 2, on one `/state/entity/details` item (read with `aggregation_level: "Vault"`): is this a pool
 * the configured owner badges own? Pure: no I/O.
 */
export function judgeDiscoveredPool(item: any, o: { packages: string[]; badges: string[]; stateVersion?: number }): DiscoveryVerdict {
  if (!o.packages.length) return { accepted: false, reason: 'no allow-listed OwnerPool package on this network' };
  let state: OwnerPoolState;
  try {
    state = parseOwnerPoolDetails(item, o.packages, o.stateVersion);
  } catch (e) {
    return { accepted: false, reason: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  if (!state.split) return { accepted: false, reason: `${state.address} has no owner badge (not a split OwnerPool)` };
  if (!o.badges.includes(state.split.ownerBadge)) return { accepted: false, reason: `${state.address} is owned by ${state.split.ownerBadge}, not a configured owner badge` };
  return { accepted: true, state };
}

/** Component addresses created by the transactions of one `/stream/transactions` page (committed successes only). */
export function createdComponents(items: any[]): string[] {
  const out: string[] = [];
  for (const t of items ?? []) {
    if (t?.transaction_status !== 'CommittedSuccess') continue;
    for (const e of t?.receipt?.state_updates?.new_global_entities ?? []) {
      const a = String(e?.entity_address ?? '');
      if (/^component_[a-z0-9_]+$/.test(a)) out.push(a);
    }
  }
  return out;
}

export interface OwnerPoolDiscoveryOptions {
  /** Owner badges whose pools count (`DEX_POOL_OWNER_BADGES`). Empty: discovery is off. */
  badges: string[];
  /** Allow-listed OwnerPool packages for this network (`OWNER_POOL_PACKAGES`). */
  packages: string[];
  /** Most stream pages read per refresh (100 transactions each). */
  maxPages?: number;
  /** Most candidates ever judged: a bound on Gateway reads, whatever the stream returns. */
  maxCandidates?: number;
}

/**
 * The owner's pools found on the ledger, kept up to date incrementally: each `refresh()` reads the
 * owner-badge transactions committed since the last one, judges the components they created, and
 * remembers every verdict (the owner badge of a pool cannot change, so neither can the verdict).
 */
export class OwnerPoolDiscovery {
  private readonly gateway: Gateway;
  private readonly o: Required<OwnerPoolDiscoveryOptions>;
  private readonly accepted = new Map<string, { ownerBadge: string; resources: [string, string]; at: number }>();
  private readonly rejected = new Map<string, string>();
  /** The last state version the stream was read up to (inclusive). */
  private through = 0;
  /** Candidates the Gateway returned nothing for: judged again next time. */
  private retry: string[] = [];
  private running: Promise<void> | undefined;
  refreshedAt = 0;
  lastError: string | undefined;

  constructor(gateway: Gateway, o: OwnerPoolDiscoveryOptions) {
    this.gateway = gateway;
    this.o = { maxPages: 20, maxCandidates: 500, ...o };
  }

  get enabled(): boolean { return this.o.badges.length > 0 && this.o.packages.length > 0; }

  /** Accepted pools by component address, oldest first. */
  addresses(): string[] { return [...this.accepted.keys()]; }

  /** What was accepted and refused, for the health view and tests. */
  verdicts(): { accepted: { address: string; ownerBadge: string; resources: [string, string] }[]; rejected: { address: string; reason: string }[] } {
    return {
      accepted: [...this.accepted].map(([address, v]) => ({ address, ownerBadge: v.ownerBadge, resources: v.resources })),
      rejected: [...this.rejected].map(([address, reason]) => ({ address, reason })),
    };
  }

  /** Read what is new on the ledger. Concurrent callers share one read. Never throws: the error is kept in `lastError`. */
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.running ??= this.readNew().then(() => { this.lastError = undefined; this.refreshedAt = Date.now(); }, (e) => { this.lastError = String((e as Error)?.message ?? e).slice(0, 300); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async readNew(): Promise<void> {
    const candidates: string[] = [];
    let cursor: string | undefined;
    let top = this.through;
    const from = this.through > 0 ? { from_ledger_state: { state_version: this.through + 1 } } : {};
    for (let page = 0; page < this.o.maxPages; page++) {
      const j = await this.gateway.post('/stream/transactions', {
        manifest_badges_presented_filter: this.o.badges,
        kind_filter: 'User',
        order: 'Asc',
        limit_per_page: 100,
        ...from,
        ...(cursor ? { cursor } : {}),
        opt_ins: { receipt_state_changes: true },
      });
      const items: any[] = j?.items ?? [];
      candidates.push(...createdComponents(items));
      for (const t of items) if (Number.isSafeInteger(t?.state_version)) top = Math.max(top, t.state_version);
      cursor = j?.next_cursor ?? undefined;
      if (!cursor) break;
    }
    const fresh = [...new Set(candidates)].filter((a) => !this.accepted.has(a) && !this.rejected.has(a));
    const room = Math.max(0, this.o.maxCandidates - this.accepted.size - this.rejected.size);
    const todo = [...new Set([...this.retry, ...fresh])].slice(0, room);
    const candidatesLeft: string[] = [];
    for (let i = 0; i < todo.length; i += 20) {
      const chunk = todo.slice(i, i + 20);
      const j = await this.gateway.post('/state/entity/details', { addresses: chunk, aggregation_level: 'Vault' });
      for (const a of chunk) {
        const item = (j?.items ?? []).find((x: any) => x?.address === a);
        // Nothing returned (a Gateway hiccup): judged again on the next refresh, not remembered.
        if (!item) { candidatesLeft.push(a); continue; }
        const v = judgeDiscoveredPool(item, { packages: this.o.packages, badges: this.o.badges, stateVersion: j?.ledger_state?.state_version });
        if (v.accepted) this.accepted.set(a, { ownerBadge: v.state.split!.ownerBadge, resources: [v.state.resourceA, v.state.resourceB], at: Date.now() });
        else this.rejected.set(a, v.reason);
      }
    }
    this.retry = candidatesLeft;
    // The stream is read oldest first, so the next refresh starts after the newest transaction read
    // (a page limit reached leaves the rest for then).
    this.through = top;
  }
}
