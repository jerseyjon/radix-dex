// A split OwnerPool as the Gateway returns it (aggregation_level "Vault"), recorded from the Stokenet
// test pool (packages/core/test/ownerpool-split.test.ts has the same shape), for the Pools page tests.
import { NETWORKS, parseOwnerPoolDetails, type OwnerPoolState } from '@radix-dex/core';

export const net = NETWORKS.stokenet;
export const XRD = net.xrd;
export const TEUR = 'resource_tdx_2_1tknxk37t6tvqce4ce0jqv7ymydjfgjej4mw0wkdzep4wjfz8trvpj3';
export const POOL = 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk';
export const PACKAGE = 'package_tdx_2_1pklhl0ma6mepuxakg0pk2tgf4ej05uwgwu8gm0ajv5xa9acsjd4fll';
export const OWNER_BADGE = 'resource_tdx_2_1tkzuvmezcle34heuuzleuuhu3p4g90ncst257llxuh5qrv2nfp9wc6';
export const OP_BADGE = 'resource_tdx_2_1tkaa0etdc2q42skhlrm223a9yrk34ff3876gzndrgnjhcj2yr7wvff';
export const OWNER = 'account_tdx_2_129q4ucv5v9j7ukhg5f3nxyle979ek0eyj6j45fxlpargmrcg2qhuaf';
export const OPERATOR = 'account_tdx_2_128x3s0xqj8nj55st5s38mjfsfcc2ddyejcq2vjwuctwugy3ukwcj22';
const V = {
  a: 'internal_vault_tdx_2_1tz5cf03n9tas976z36q9dglete6x8ymr3fnug45h00pzg5dlwgefmm',
  b: 'internal_vault_tdx_2_1tr273v88sxnwl3xvq0s7tr44a0j8g3cxgxpfw82uup92zlesg9jwf5',
  ia: 'internal_vault_tdx_2_1tqkpyngpeq7j8qgs0kanc4keyp05l5e890wqnekm3glcj9npeu44zf',
  ib: 'internal_vault_tdx_2_1tqhju6gnwzhqmvhma5vh7e76qyt57mu9k3kl8w9wrun7mvgvng09zr',
};

export interface PoolOpts { address?: string; ownerBadge?: string; packageAddress?: string; blueprint?: string; ra?: string; rb?: string; ia?: string; ib?: string; fee?: number; paused?: boolean; operatorPaused?: boolean; operator?: string | null; anchor?: [string, string] }

export function poolItem(o: PoolOpts = {}) {
  const operator = o.operator === undefined ? OP_BADGE : o.operator;
  const anchor = o.anchor ?? ['1250', '1'];
  return {
    address: o.address ?? POOL,
    fungible_resources: { total_count: 2, items: [
      { aggregation_level: 'Vault', resource_address: TEUR, vaults: { total_count: 2, items: [{ vault_address: V.ib, amount: o.ib ?? '0.8' }, { vault_address: V.b, amount: o.rb ?? '16' }] } },
      { aggregation_level: 'Vault', resource_address: XRD, vaults: { total_count: 2, items: [{ vault_address: V.ia, amount: o.ia ?? '1000' }, { vault_address: V.a, amount: o.ra ?? '20000' }] } },
    ] },
    details: { type: 'Component', package_address: o.packageAddress ?? PACKAGE, blueprint_name: o.blueprint ?? 'OwnerPool', state: { kind: 'Tuple', type_name: 'OwnerPool', fields: [
      { field_name: 'resource_a', value: XRD }, { field_name: 'resource_b', value: TEUR },
      { field_name: 'divisibility_a', value: '18' }, { field_name: 'divisibility_b', value: '6' },
      { field_name: 'vault_a', value: V.a }, { field_name: 'vault_b', value: V.b },
      { field_name: 'fee_bps', value: String(o.fee ?? 30) },
      { field_name: 'paused', value: o.paused ?? false }, { field_name: 'operator_paused', value: o.operatorPaused ?? false },
      { field_name: 'inventory_a', value: V.ia }, { field_name: 'inventory_b', value: V.ib },
      { field_name: 'owner_badge', value: o.ownerBadge ?? OWNER_BADGE },
      operator
        ? { kind: 'Enum', field_name: 'operator', variant_id: '1', variant_name: 'Some', fields: [{ kind: 'Reference', value: operator }] }
        : { kind: 'Enum', field_name: 'operator', variant_id: '0', variant_name: 'None', fields: [] },
      { kind: 'Tuple', field_name: 'limits', fields: [
        { field_name: 'move_budget_bps', value: '300' }, { field_name: 'window_epochs', value: '72' },
        { field_name: 'max_reserve_a', value: '22000' }, { field_name: 'max_reserve_b', value: '17.6' },
        { field_name: 'min_reserve_a', value: '10000' }, { field_name: 'min_reserve_b', value: '8' },
        { field_name: 'min_fee_bps', value: '10' }, { field_name: 'max_fee_bps', value: '100' },
      ] },
      { field_name: 'allowance', value: '0' }, { field_name: 'allowance_epoch', value: '24806' },
      { kind: 'Tuple', field_name: 'anchor', fields: [{ value: anchor[0] }, { value: anchor[1] }] },
    ] } },
  };
}

export const poolState = (o: PoolOpts = {}): OwnerPoolState => parseOwnerPoolDetails(poolItem(o), [PACKAGE], 100);

/** One `/stream/transactions` item in which the pool emitted `events` (name, fields), with the manifest text. */
export function streamTx(o: { txid: string; sv: number; at: string; manifest: string; events: { name: string; fields: unknown[] }[] }) {
  return {
    transaction_status: 'CommittedSuccess', intent_hash: o.txid, state_version: o.sv, confirmed_at: o.at, manifest_instructions: o.manifest,
    receipt: { events: o.events.map((e) => ({ name: e.name, emitter: { entity: { entity_address: POOL }, object_module_id: 'Main' }, data: { fields: e.fields } })) },
  };
}
const f = (field_name: string, value: unknown) => ({ field_name, value });
export const swapEvent = (input: string, inAmt: string, output: string, outAmt: string, fee: string) => ({
  name: 'OwnerPoolSwapEvent',
  fields: [f('reserve_a', '20000'), f('reserve_b', '16'), f('input_resource', input), f('input_amount', inAmt), f('output_resource', output), f('output_amount', outAmt), f('fee', fee)],
});
export const configEvent = (fee: number, paused: boolean, operatorPaused = false) => ({ name: 'OwnerPoolConfigEvent', fields: [f('fee_bps', String(fee)), f('paused', paused), f('operator_paused', operatorPaused)] });
export const rebalanceEvent = (amountA: string, amountB: string, byOwner: boolean) => ({
  name: 'OwnerPoolRebalanceEvent',
  fields: [f('amount_a', amountA), f('amount_b', amountB), f('reserve_a', '20000'), f('reserve_b', '16'), f('inventory_a', '1000'), f('inventory_b', '0.8'), f('cost', '0.0004'), f('allowance', '0'), f('by_owner', byOwner)],
});
export const proofLine = (account: string, badge: string) => `CALL_METHOD Address("${account}") "create_proof_of_amount" Address("${badge}") Decimal("1");`;
export const callLine = (method: string, args = '') => `CALL_METHOD Address("${POOL}") "${method}"${args ? ' ' + args : ''};`;
