// An in-memory stand-in for the Gateway endpoints the quoter and the market data use, for venue tests.
// Pools are pricing functions; a swap that a pool cannot do either fails (panics) or hands input back.
import { Decimal, Gateway, NETWORKS, type FetchLike } from '../src/index.ts';

export const net = NETWORKS.mainnet;
export const XRD = net.xrd;
export const HUSDC = 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv';
export const LSULP = 'resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf';
export const C9_PACKAGE = 'package_rdx1p4r9rkp0cq67wmlve544zgy0l45mswn6h798qdqm47x4762h383wa3';
export const OCI_BASIC_PACKAGE = 'package_rdx1p5l6dp3slnh9ycd7gk700czwlck9tujn0zpdnd0efw09n2zdnn0lzx';
export const C9_HUSDC = 'component_rdx1cqelumvmmgwths34k9pp0htd2ykwq7d70m0r389etwh39ul3j5tyj5';
export const C9_LSULP = 'component_rdx1crdhl7gel57erzgpdz3l3vr64scslq4z7vd0xgna6vh5fq5fnn9xas';
export const fakeAddress = (kind: string, c: string) => `${kind}_rdx1${c.repeat(54)}`;
export const FUNDER = fakeAddress('account', 'f');

/** What a swap of `amount` of `sell` does: the output, the part of the input used, or a panic. */
export type SwapFn = (sell: string, amount: Decimal) => { out: Decimal; used?: Decimal; resource: string; fee?: string } | { panic: string };

export interface FakeLedger {
  /** Swap behaviour per component. */
  swaps: Map<string, SwapFn>;
  /** Entity details per address, as the Gateway returns them. */
  details: Map<string, any>;
  /** Paths (or `path#vault` for vault-aggregated details) that answer HTTP 500. */
  down: Set<string>;
  /** Components whose previews throw (HTTP 500). */
  previewDown: Set<string>;
  /** Every amount of each resource previewed as a sale through each pool: `${pool}|${resource}` → amounts. */
  probes: Map<string, Decimal[]>;
  /** Stream items per component. */
  streams: Map<string, any[]>;
  gateway: Gateway;
  fetch: FetchLike;
}

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

export function fakeLedger(): FakeLedger {
  const ledger: FakeLedger = {
    swaps: new Map(), details: new Map(), down: new Set(), previewDown: new Set(), probes: new Map(), streams: new Map(),
  } as any;
  const fetchFn: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init?.body ?? '{}');
    const key = path + (body.aggregation_level === 'Vault' ? '#vault' : '');
    if (ledger.down.has(key) || ledger.down.has(path)) return reply(500, { message: 'down' });
    switch (path) {
      case '/status/gateway-status':
        return reply(200, { ledger_state: { network: net.name, epoch: 1000, state_version: 1, proposer_round_timestamp: '' } });
      case '/state/entity/details':
        return reply(200, { items: (body.addresses as string[]).map((a) => ledger.details.get(a)).filter(Boolean) });
      case '/extensions/resource-holders/page':
        return reply(200, { items: [{ holder_address: FUNDER, amount: '1000000000' }] });
      case '/stream/transactions':
        return reply(200, { items: ledger.streams.get(body.affected_global_entities_filter?.[0]) ?? [] });
      case '/transaction/preview':
        return preview(body.manifest as string);
    }
    return reply(404, { message: `no fake for ${path}` });
  };
  const preview = (manifest: string) => {
    const w = /"withdraw" Address\("([^"]+)"\) Decimal\("([^"]+)"\)/.exec(manifest)!;
    let resource = w[1]!, amount = new Decimal(w[2]!);
    const changes: Record<string, Decimal> = { [resource]: amount.neg() };
    let fee = new Decimal('0.5');
    for (const [, pool] of manifest.matchAll(/CALL_METHOD Address\("([^"]+)"\) "swap"/g)) {
      if (ledger.previewDown.has(pool!)) return reply(500, { message: 'preview down' });
      const k = `${pool}|${resource}`;
      ledger.probes.set(k, [...(ledger.probes.get(k) ?? []), amount]);
      const fn = ledger.swaps.get(pool!);
      const r = fn ? fn(resource, amount) : { panic: 'no such pool' };
      if ('panic' in r) return reply(200, { receipt: { status: 'Failed', error_message: r.panic, fee_summary: {} }, resource_changes: [] });
      const used = r.used ?? amount;
      // Input handed back stays with the funder.
      changes[resource] = (changes[resource] ?? new Decimal(0)).plus(amount.minus(used));
      changes[r.resource] = (changes[r.resource] ?? new Decimal(0)).plus(r.out);
      resource = r.resource; amount = r.out;
      fee = fee.plus(r.fee ?? '0.4');
    }
    return reply(200, {
      receipt: { status: 'Succeeded', fee_summary: { xrd_total_execution_cost: fee.toFixed() } },
      resource_changes: [{ resource_changes: Object.entries(changes).filter(([, v]) => !v.eq(0)).map(([res, v]) => ({ component_entity: { entity_address: FUNDER }, resource_address: res, amount: v.toFixed() })) }],
    });
  };
  ledger.fetch = fetchFn;
  ledger.gateway = new Gateway(net, { fetch: fetchFn, attempts: 1 });
  for (const [r, div] of [[XRD, 18], [HUSDC, 6], [LSULP, 18]] as const) ledger.details.set(r, { address: r, details: { divisibility: div }, metadata: { items: [] } });
  return ledger;
}

/** Constant-product pool: fee 0.3%. */
export function constantProduct(a: string, ra: number, b: string, rb: number): SwapFn {
  return (sell, amount) => {
    const [rin, rout, outRes] = sell === a ? [ra, rb, b] : sell === b ? [rb, ra, a] : [0, 0, ''];
    if (!outRes) return { panic: 'wrong token' };
    const x = amount.mul(0.997);
    return { out: x.mul(rout).div(x.plus(rin)).toDecimalPlaces(18, Decimal.ROUND_DOWN), resource: outRes };
  };
}

/**
 * One-sided pool at a flat price (`priceYperX`, fee 0.3%) holding `x` of X and `y` of Y.
 * A swap that would take out more than the pool holds panics, as the survey found CaviarNine's do.
 */
export function oneSided(X: string, x: number, Y: string, y: number, priceYperX: number, fee = '1.0'): SwapFn {
  return (sell, amount) => {
    const out = sell === X ? amount.mul(priceYperX).mul(0.997) : amount.div(priceYperX).mul(0.997);
    const holds = sell === X ? y : x;
    if (out.gt(holds)) return { panic: 'PANIC: not enough liquidity' };
    return { out: out.toDecimalPlaces(18, Decimal.ROUND_DOWN), resource: sell === X ? Y : X, fee };
  };
}

/** Entity details of a QuantaSwap pool as the Gateway returns them with vault aggregation. */
export function quantaSwapDetails(address: string, x: { resource: string; amount: string }, y: { resource: string; amount: string }, priceYperX: number, pkg = C9_PACKAGE) {
  const vx = fakeAddress('internal_vault', 'x'), vy = fakeAddress('internal_vault', 'y');
  // The state holds the active bin's bounds as square roots of prices.
  const lower = Math.sqrt(priceYperX * 0.999), upper = Math.sqrt(priceYperX / 0.999);
  return {
    address,
    details: {
      package_address: pkg, blueprint_name: 'QuantaSwap',
      state: { kind: 'Tuple', type_name: 'QuantaSwap', fields: [
        { kind: 'U32', field_name: 'bin_span', value: '50' },
        { kind: 'Decimal', field_name: 'lower_limit', value: String(lower) },
        { kind: 'Decimal', field_name: 'upper_limit', value: String(upper) },
        { kind: 'Own', type_name: 'Vault', field_name: 'tokens_x', value: vx },
        { kind: 'Own', type_name: 'Vault', field_name: 'tokens_y', value: vy },
      ] },
    },
    fungible_resources: { items: [
      { resource_address: x.resource, vaults: { items: [{ vault_address: vx, amount: x.amount }] } },
      { resource_address: y.resource, vaults: { items: [{ vault_address: vy, amount: y.amount }] } },
    ] },
  };
}

/** The two real pools' shapes: about 11M XRD against 5 hUSDC, and 1.2M XRD against 53 LSULP. */
export function addCaviarNinePools(ledger: FakeLedger): void {
  ledger.details.set(C9_HUSDC, quantaSwapDetails(C9_HUSDC, { resource: XRD, amount: '11000000' }, { resource: HUSDC, amount: '5' }, 0.00085));
  ledger.details.set(C9_LSULP, quantaSwapDetails(C9_LSULP, { resource: LSULP, amount: '53' }, { resource: XRD, amount: '1200000' }, 1.22));
  ledger.swaps.set(C9_HUSDC, oneSided(XRD, 11_000_000, HUSDC, 5, 0.00085));
  ledger.swaps.set(C9_LSULP, oneSided(LSULP, 53, XRD, 1_200_000, 1.22));
}
