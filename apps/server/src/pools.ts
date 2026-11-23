// The Pools page's data: the OwnerPools this server lists (DEX_OWNER_POOLS, and on Stokenet the markets
// file), read from the ledger, with the market reference under the bot's rules, the pool's own events,
// and the bot's and watcher's files. READ ONLY: nothing here signs or sends anything. Owner actions are
// built with the shared builders and previewed on the Gateway; the owner's wallet signs them.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Decimal, OWNER_POOL_BOT_DEFAULTS as BD, OWNER_POOL_PACKAGES, aggregateVenues, ownerPoolAllowanceNow, ownerPoolStepMismatches, readOwnerPoolTransactions,
  readOwnerPools, readRecentOwnerPoolTransactions, type Gateway, type OwnerPoolState, type VenueReference,
} from '@radix-dex/core';
import { VENUE_NAMES, hasReferenceVenues, makeVenues, readVenueSource, type VenueSource } from '@radix-dex/core/sources';
import type { Config } from './config.ts';
import { HttpError } from './http.ts';
import { TtlCache, type MarketData } from './marketdata.ts';
import {
  NO_FEES, OwnerActionError, addFees, botView, cleanWant, curvePrice, describePoolTx, gapBps, heartbeatView, isOwnerAction, markoutView, planOwnerAction, previewView,
  type BotView, type FeeTotals, type PoolActivity, type ProcessHealth,
} from './poolview.ts';

export interface MarketRef {
  price: number;
  source: string;
  status: 'ok' | 'disagree' | 'none' | 'bot';
  reason: string;
  at: number;
  venues: { venue: string; used: boolean; mid: number | null; dropped: string | null }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `p`'s value if it settles within `ms`, else undefined (it keeps running and fills its cache). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), sleep(ms).then(() => undefined)]);
}

export class PoolsService {
  private readonly config: Config;
  /** Long-timeout client: venue previews, the event stream, owner-action previews. */
  private readonly gateway: Gateway;
  /** Short-timeout client for plain reads behind a page load. */
  private readonly read: Gateway;
  private readonly data: MarketData;
  private readonly states = new TtlCache<OwnerPoolState>(8_000);
  private readonly statusCache = new TtlCache<{ epoch: number; stateVersion: number }>(10_000);
  private readonly activityCache = new TtlCache<PoolActivity[]>(15_000);
  private readonly ownerCache = new TtlCache<boolean>(15_000);
  private readonly balanceCache = new TtlCache<string>(30_000);
  private readonly usdCache = new TtlCache<number | undefined>(120_000);
  private readonly refs = new Map<string, { value?: MarketRef; at: number; running?: Promise<MarketRef | undefined> }>();
  private readonly fees = new Map<string, { totals: FeeTotals; next: number; at: number; running?: Promise<void>; complete: boolean }>();
  private readonly markouts = new Map<string, { mtimeMs: number; size: number; value: ReturnType<typeof markoutView> }>();
  private venues: VenueSource[] | undefined;

  constructor(o: { config: Config; gateway: Gateway; readGateway: Gateway; data: MarketData }) {
    this.config = o.config; this.gateway = o.gateway; this.read = o.readGateway; this.data = o.data;
  }

  /** The OwnerPools listed here, by component address: DEX_OWNER_POOLS and those the market list holds (markets file). */
  addresses(): string[] {
    return [...new Set([...this.config.ownerPools, ...this.data.pools.filter((p) => p.venue === 'ownerpool').map((p) => p.address)])];
  }

  private listed(component: string): string {
    if (!this.addresses().includes(component)) throw new HttpError(404, 'Not a pool listed here');
    return component;
  }

  private allowed(): string[] { return OWNER_POOL_PACKAGES[this.config.network.name] ?? []; }

  state(component: string, fresh = false): Promise<OwnerPoolState> {
    const read = () => readOwnerPools(this.read, [component], this.allowed()).then((s) => s[0]!);
    return fresh ? read() : this.states.get(component, read);
  }

  private status() { return this.statusCache.get('s', () => this.read.status()); }

  private symbol = (r: string): string => {
    const s = this.data.symbol(r);
    return s.endsWith('…') ? `${r.slice(0, 14)}…${r.slice(-4)}` : s;
  };

  // ---------------------------------------------------------------- market reference

  /**
   * The market price of the pool's pair (B per A). Mainnet XRD/hUSDC: the bot's reference venues,
   * quoted by free previews and aggregated with the bot's own rules (`aggregateVenues`, the bot's
   * defaults; the bot also waits for a venue to be confirmed over two ticks, which this does not).
   * Otherwise the bot's own last reference from its state file, when it is fresh. Cached for a minute;
   * a page load waits at most `waitMs` for a fresh reading and otherwise shows the last one.
   */
  async reference(state: OwnerPoolState, waitMs = 12_000, maxAgeMs = 60_000): Promise<MarketRef | undefined> {
    const key = state.address;
    let e = this.refs.get(key);
    if (!e) { e = { at: 0 }; this.refs.set(key, e); }
    if (Date.now() - e.at > maxAgeMs && !e.running) {
      const entry = e;
      entry.running = this.readReference(state).then((v) => { entry.value = v; entry.at = Date.now(); return v; }).finally(() => { entry.running = undefined; });
    }
    if (e.running && (!e.value || Date.now() - e.at > maxAgeMs)) await within(e.running, waitMs);
    return e.value;
  }

  private async readReference(state: OwnerPoolState): Promise<MarketRef | undefined> {
    if (hasReferenceVenues(this.config.network.name, state.resourceA, state.resourceB)) {
      this.venues ??= makeVenues(VENUE_NAMES, this.gateway, { sizeXrd: BD.quoteSizeXrd, smallFraction: BD.smallQuoteFraction });
      const quotes = await Promise.all(this.venues.map(readVenueSource));
      const ref: VenueReference = aggregateVenues(quotes, Date.now(), {
        minVenues: BD.minVenues, maxAgeMs: BD.maxSourceAgeSec * 1000, maxDisagreement: BD.maxDisagreement, maxRoundTrip: BD.maxRoundTrip, minImpactBps: BD.minImpactBps, maxVenueFee: BD.maxVenueFee,
      });
      const venues = ref.venues.map((v) => ({ venue: v.venue, used: v.used, mid: v.mid ?? null, dropped: v.dropped ?? null }));
      const used = venues.filter((v) => v.used).map((v) => v.venue).join(', ');
      if (ref.price === undefined) return { price: NaN, source: 'on-ledger venues, the bot\'s rules', status: 'none', reason: ref.reason, at: Date.now(), venues };
      return { price: ref.price, source: `on-ledger venues, the bot's rules: ${used}`, status: ref.status === 'ok' ? 'ok' : 'disagree', reason: ref.reason, at: Date.now(), venues };
    }
    const bot = this.files(state.address).bot;
    if (bot?.reference && Date.now() - bot.reference.at < 600_000) {
      return { price: bot.reference.price, source: 'the bot\'s last reference (its state file)', status: 'bot', reason: `read ${Math.round((Date.now() - bot.reference.at) / 1000)} s ago`, at: bot.reference.at, venues: [] };
    }
    return undefined;
  }

  /** A reference usable as a price: a number, and not a "none". */
  private static usable(r: MarketRef | undefined): { price: number; source: string } | undefined {
    return r && r.status !== 'none' && r.price > 0 ? { price: r.price, source: r.status === 'disagree' ? `${r.source} (VENUES DISAGREE: ${r.reason})` : r.source } : undefined;
  }

  // ---------------------------------------------------------------- files (bot, watcher, markout)

  /** The bot's and watcher's heartbeats, the bot's state and the markout summary, for this pool only. Never a path, pid or key. */
  files(pool: string): { botHealth: ProcessHealth; watchHealth: ProcessHealth; bot?: BotView; markout?: ReturnType<typeof markoutView> } {
    const dir = this.config.ownerPoolFilesDir, net = this.config.network.name;
    const text = (name: string): string | undefined => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return undefined; } };
    const now = Date.now(), maxAge = this.config.heartbeatMaxAgeSec * 1000;
    const botHealth = heartbeatView(text(`heartbeat/owner-pool-bot-${net}.json`), pool, now, maxAge);
    const watchHealth = heartbeatView(text(`heartbeat/owner-pool-watch-${net}.json`), pool, now, maxAge);
    let bot: BotView | undefined;
    try { const t = text(`owner-pool-bot-${net}-state.json`); bot = t === undefined ? undefined : botView(JSON.parse(t), pool); } catch { bot = undefined; }
    // The markout record names no pool: it is the watcher's, so it is this pool's only when the watcher's heartbeat is.
    let markout: ReturnType<typeof markoutView> | undefined;
    if (watchHealth.status === 'alive' || watchHealth.status === 'stale') {
      const path = join(dir, `owner-pool-markout-${net}.jsonl`);
      try {
        const st = statSync(path);
        const hit = this.markouts.get(pool);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) markout = hit.value;
        else if (st.size < 50_000_000) { markout = markoutView(readFileSync(path, 'utf8')); this.markouts.set(pool, { mtimeMs: st.mtimeMs, size: st.size, value: markout }); }
      } catch { markout = undefined; }
    }
    return { botHealth, watchHealth, bot, markout };
  }

  // ---------------------------------------------------------------- events

  private activity(state: OwnerPoolState): Promise<PoolActivity[]> {
    return this.activityCache.get(state.address, async () => {
      const txs = await readRecentOwnerPoolTransactions(this.gateway, state.address, 50);
      return txs.map((t) => describePoolTx(t, { ownerBadge: state.split?.ownerBadge, resourceA: state.resourceA, resourceB: state.resourceB, symbol: this.symbol }));
    });
  }

  /** Fees kept since the pool was created, summed from its swap events; read incrementally, at most once a minute. */
  private async feeTotals(state: OwnerPoolState): Promise<{ totals: FeeTotals; complete: boolean }> {
    let e = this.fees.get(state.address);
    if (!e) { e = { totals: NO_FEES, next: 1, at: 0, complete: false }; this.fees.set(state.address, e); }
    const entry = e;
    if (Date.now() - entry.at > 60_000 && !entry.running) {
      entry.running = (async () => {
        const r = await readOwnerPoolTransactions(this.gateway, state.address, entry.next, { maxPages: 20, manifest: false });
        entry.totals = addFees(entry.totals, r.txs, state.resourceA, state.resourceB);
        entry.next = r.next; entry.complete = r.complete; entry.at = Date.now();
      })().catch(() => { /* kept as it was; retried on the next view */ }).finally(() => { entry.running = undefined; });
    }
    if (entry.running && entry.at === 0) await within(entry.running, 10_000);
    return { totals: entry.totals, complete: entry.complete };
  }

  // ---------------------------------------------------------------- values

  /** USD per unit of token A: from a dollar token on side B (at the market, else the curve), or XRD's dollar rate on mainnet. */
  private async usdPerA(state: OwnerPoolState, market: number | undefined): Promise<number | undefined> {
    const xrd = this.config.network.xrd;
    const stables = this.config.quotePriority.filter((r) => r !== xrd);
    if (stables.includes(state.resourceB)) return market ?? curvePrice(state);
    if (state.resourceA === xrd && stables[0]) {
      return this.usdCache.get('xrd', async () => { const v = await this.data.xrdValueIn(stables[0]!, '1'); return v ? Number(v) : undefined; }).catch(() => undefined);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- views

  private async view(component: string, detail: boolean) {
    const state = await this.state(component);
    const s = state.split;
    const errors: string[] = [];
    const price = curvePrice(state);
    const [ref, status] = await Promise.all([
      this.reference(state, detail ? 12_000 : 8_000).catch((e) => { errors.push(`market reference: ${String((e as Error).message).slice(0, 200)}`); return undefined; }),
      this.status().catch(() => undefined),
    ]);
    const market = PoolsService.usable(ref);
    const usd = await this.usdPerA(state, market?.price);
    const valueA = (a: string, b: string) => (price ? Number(a) + Number(b) / price : undefined);
    const tvlA = valueA(state.reserveA, state.reserveB);
    const files = this.files(component);
    const botHealthy = files.botHealth.status === 'alive' && files.botHealth.ok !== false && files.watchHealth.status === 'alive';
    const row = {
      address: component,
      pair: {
        a: { address: state.resourceA, symbol: this.symbol(state.resourceA), divisibility: state.divisibilityA },
        b: { address: state.resourceB, symbol: this.symbol(state.resourceB), divisibility: state.divisibilityB },
      },
      reserves: { a: state.reserveA, b: state.reserveB },
      price: price ?? null,
      market: ref ? { price: ref.price > 0 ? ref.price : null, source: ref.source, status: ref.status, reason: ref.reason, at: ref.at, ...(detail ? { venues: ref.venues } : {}) } : null,
      gapBps: gapBps(price, market?.price) ?? null,
      tvl: { a: tvlA ?? null, usd: tvlA !== undefined && usd ? tvlA * usd : null },
      feeBps: state.feeBps,
      paused: state.paused,
      ownerPaused: s ? s.ownerPaused : state.paused,
      operatorPaused: s?.operatorPaused ?? false,
      bot: { healthy: botHealthy, bot: files.botHealth, watcher: files.watchHealth },
      stateVersion: state.stateVersion ?? null,
      readAt: Date.now(),
    };
    if (!detail) return row;

    const [activity, fees, opXrd] = await Promise.all([
      this.activity(state).catch((e) => { errors.push(`events: ${String((e as Error).message).slice(0, 200)}`); return [] as PoolActivity[]; }),
      this.feeTotals(state),
      files.bot?.operatorAccount
        ? this.balanceCache.get(files.bot.operatorAccount, () => this.read.fungibleBalance(files.bot!.operatorAccount!, this.config.network.xrd)).catch(() => null)
        : Promise.resolve(null),
    ]);
    const feeValueA = valueA(fees.totals.feeA, fees.totals.feeB);
    return {
      ...row,
      packageAddress: state.packageAddress,
      usdPerA: usd ?? null,
      inventory: s ? { a: s.inventoryA, b: s.inventoryB, valueA: valueA(s.inventoryA, s.inventoryB) ?? null } : null,
      ownerBadge: s?.ownerBadge ?? null,
      operator: s ? {
        badge: s.operator, limits: s.limits, anchor: s.anchor,
        allowance: status ? { now: ownerPoolAllowanceNow(state, status.epoch), budget: new Decimal(s.limits.moveBudgetBps).div(10_000).toFixed(), epoch: status.epoch, windowEpochs: s.limits.windowEpochs } : null,
        account: files.bot?.operatorAccount ?? null, accountXrd: opXrd,
      } : null,
      botState: files.bot ?? null,
      fees: { ...fees.totals, complete: fees.complete, valueA: feeValueA ?? null, valueUsd: feeValueA !== undefined && usd ? feeValueA * usd : null },
      markout: files.markout ?? null,
      activity,
      errors,
    };
  }

  /** One row per listed pool. A pool that cannot be read is listed with the reason. */
  async list() {
    return Promise.all(this.addresses().map((c) => this.view(c, false).catch((e) => ({ address: c, error: String((e as Error)?.message ?? e).slice(0, 300) }))));
  }

  detail(component: string) {
    return this.view(this.listed(component), true);
  }

  // ---------------------------------------------------------------- the owner

  private checkAccount(account: unknown): string {
    const hrp = this.config.network.name === 'mainnet' ? 'rdx' : 'tdx_2_';
    if (typeof account !== 'string' || !new RegExp(`^account_${hrp}1[02-9ac-hj-np-z]{50,70}$`).test(account)) throw new HttpError(400, 'Bad account address for this network');
    return account;
  }

  /** Whether `account` holds the pool's owner badge NOW, read on the ledger (never taken from the page). */
  async isOwner(component: string, account: unknown, fresh = false): Promise<{ owner: boolean; ownerBadge: string | null }> {
    const acct = this.checkAccount(account);
    const state = await this.state(this.listed(component));
    const badge = state.split?.ownerBadge;
    if (!badge) return { owner: false, ownerBadge: null };
    const read = () => this.read.fungibleBalance(acct, badge).then((b) => new Decimal(b).gte(1));
    const owner = fresh ? await read() : await this.ownerCache.get(`${component}|${acct}`, read);
    return { owner, ownerBadge: badge };
  }

  /**
   * Build an owner action's manifest and preview it on this network's Gateway. Refused unless the
   * account holds the owner badge on the ledger now. Nothing is signed or sent here: the page hands
   * the manifest to the owner's wallet, and the contract checks the badge again.
   */
  async prepare(component: string, body: any) {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be a JSON object');
    const account = this.checkAccount(body.account);
    if (!isOwnerAction(body.action)) throw new HttpError(400, 'Unknown action');
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
    this.listed(component);
    // Fresh reads: the guards (expected reserves) and the owner check must be what the ledger says now.
    const state = await this.state(component, true);
    if (!state.split) throw new HttpError(400, 'This pool has no owner badge to act with');
    const { owner } = await this.isOwner(component, account, true);
    if (!owner) throw new HttpError(403, 'This account does not hold the pool\'s owner badge');
    const needsMarket = body.action === 'deposit' || (body.action === 'anchor' && (params.price === undefined || params.price === ''));
    const market = needsMarket ? PoolsService.usable(await this.reference(state, 30_000, 30_000)) : undefined;
    let plan;
    try {
      plan = planOwnerAction({ action: body.action, state, owner: { account, badge: state.split.ownerBadge }, params, market, symbol: this.symbol });
    } catch (e) {
      if (e instanceof OwnerActionError) throw new HttpError(400, e.message);
      throw new HttpError(400, String((e as Error)?.message ?? e).slice(0, 300));
    }
    const { epoch } = await this.gateway.status();
    const pv = await this.gateway.preview(plan.manifest, epoch);
    return {
      ...plan,
      network: this.config.network.name,
      readAt: { stateVersion: state.stateVersion ?? null, reserves: [state.reserveA, state.reserveB] },
      preview: previewView(plan.manifest, pv, { owner: account, pool: component, ownerBadge: state.split.ownerBadge, symbol: this.symbol }),
    };
  }

  /** After the wallet sent an action: the transaction's status and whether the pool now shows what the action set. */
  async verify(component: string, body: any) {
    if (!body || typeof body !== 'object' || typeof body.txid !== 'string' || !/^txid_[a-z0-9_]{20,100}$/.test(body.txid)) throw new HttpError(400, 'Bad transaction id');
    this.listed(component);
    const st = await this.read.transactionStatus(body.txid);
    if (st.status !== 'CommittedSuccess') return { status: st.status, error: st.error ?? null, mismatches: null };
    const state = await this.state(component, true);
    return { status: st.status, error: null, mismatches: ownerPoolStepMismatches(state, cleanWant(body.want)) };
  }
}
