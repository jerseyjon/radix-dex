// The read-only watcher's rules (packages/core/src/ownerpool-watch.ts) on transactions shaped like
// the Stokenet pool's real history (22 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_POOL_WATCH_DEFAULTS as W, driftFindings, limitsRecord, parseOwnerPoolEvent, operatorActions, watchTransaction, type OwnerPoolEvent, type OwnerPoolTx, type WatchContext, type WatchState } from '../src/index.ts';

const OWNER = 'resource_owner_badge';
const OP = 'resource_operator_badge';
const H = 3_600_000;
const t0 = Date.parse('2026-11-22T15:00:00Z');

let sv = 100;
const tx = (events: OwnerPoolEvent[], o: { methods?: string[]; resources?: string[]; at?: number; txid?: string } = {}): OwnerPoolTx =>
  ({ txid: o.txid ?? `tx${++sv}`, stateVersion: sv, at: o.at ?? t0, methods: o.methods ?? [], resources: o.resources ?? [], events });
const reb = (cost: string, allowance: string, byOwner = false): OwnerPoolEvent =>
  ({ name: 'OwnerPoolRebalanceEvent', amountA: '-10', amountB: '0', reserveA: '1', reserveB: '1', inventoryA: '1', inventoryB: '1', cost, allowance, byOwner });
const cfgEv = (feeBps: number, paused = false, operatorPaused = false): OwnerPoolEvent => ({ name: 'OwnerPoolConfigEvent', feeBps, paused, operatorPaused });
const ctx = (o: Partial<WatchContext> = {}): WatchContext => ({ operatorBadge: OP, ownerBadge: OWNER, budget: 0.03, maxSpendShare: W.maxSpendShare, maxSpend24hBudgets: W.maxSpend24hBudgets, ...o });
const fresh = (): WatchState => ({ spends: [], config: { feeBps: 30, paused: false, operatorPaused: false }, operator: OP });
const rules = (fs: { rule: string; severity: string }[]) => fs.map((f) => `${f.severity}:${f.rule}`);

test('watch: an operator move above 60% of the available allowance is the theft pattern; the bot\'s half is not', () => {
  const st = fresh();
  // Real e2e move: cost 0.001001 with 0.000249 left = 80% of what was available.
  assert.deepEqual(rules(watchTransaction(tx([reb('0.001001001001001002', '0.000248998998998998')], { methods: ['rebalance'], resources: [OP] }), st, ctx())), ['alert:large-spend']);
  // The bot's move: 0.0018 with 0.005283 left = 25%.
  assert.deepEqual(watchTransaction(tx([reb('0.001800000000000145', '0.005283333333333188')], { methods: ['rebalance'], resources: [OP] }), st, ctx()), []);
  // Exactly half (the bot's ceiling) passes; owner moves and free moves never count.
  assert.deepEqual(watchTransaction(tx([reb('0.005', '0.005')]), st, ctx()), []);
  assert.deepEqual(watchTransaction(tx([reb('0', '0', true)], { methods: ['owner_rebalance'] }), st, ctx()), []);
  assert.deepEqual(watchTransaction(tx([reb('0', '0.01')]), st, ctx()), []);
  assert.deepEqual(rules(watchTransaction(tx([reb('0.0031', '0.0019')]), st, ctx({ maxSpendShare: 0.7 }))), [], 'configurable');
});

test('watch: cumulative operator spend over 24 h above one budget; old spends drop out', () => {
  const st = fresh();
  const c = ctx({ maxSpend24hBudgets: 1 }); // 0.03
  for (let i = 0; i < 6; i++) assert.deepEqual(watchTransaction(tx([reb('0.005', '0.01')], { at: t0 + i * H }), st, c), [], `move ${i}`);
  // 0.03 exactly is not above; the next one is.
  assert.deepEqual(rules(watchTransaction(tx([reb('0.005', '0.01')], { at: t0 + 6 * H }), st, c)), ['alert:spend-24h']);
  // 25 h after the first: the first two have dropped out (0.025 + 0.005 = 0.03, not above).
  assert.deepEqual(watchTransaction(tx([reb('0.005', '0.01')], { at: t0 + 25.5 * H }), st, c), []);
  assert.equal(st.spends.length, 6);
});

test('watch: fee and pause changes, by whom; operator appointments and revokes; anchor statements', () => {
  const st = fresh();
  assert.deepEqual(rules(watchTransaction(tx([cfgEv(40)], { methods: ['operator_set_fee'], resources: [OP] }), st, ctx())), ['warn:fee-change']);
  const f = watchTransaction(tx([cfgEv(50)], { methods: ['set_fee'], resources: [OWNER] }), st, ctx());
  assert.deepEqual([rules(f), f[0]!.text], [['info:fee-change'], 'Fee 40 -> 50 bps by owner/other (set_fee).']);
  const p = watchTransaction(tx([cfgEv(50, false, true)], { methods: ['set_operator_paused'], resources: [OP] }), st, ctx());
  assert.deepEqual([rules(p), p[0]!.text], [['warn:pause-change'], 'Operator pause ON (by operator).']);
  const q = watchTransaction(tx([cfgEv(50, true, true)], { methods: ['set_paused'], resources: [OWNER] }), st, ctx());
  assert.deepEqual([rules(q), q[0]!.text], [['warn:pause-change'], 'OWNER pause ON (by owner/other (set_paused)).']);
  assert.deepEqual(watchTransaction(tx([cfgEv(50, true, true)]), st, ctx()), [], 'no change, no finding');
  // Revoke, then re-appoint with an anchor.
  assert.deepEqual(rules(watchTransaction(tx([{ name: 'OwnerPoolOperatorEvent', operator: null }]), st, ctx())), ['alert:operator-change']);
  assert.deepEqual(rules(watchTransaction(tx([{ name: 'OwnerPoolAnchorEvent', anchorA: '1250', anchorB: '1' }, { name: 'OwnerPoolOperatorEvent', operator: OP }], { methods: ['set_operator'], resources: [OWNER, OP] }), st, ctx())),
    ['info:anchor-restated', 'alert:operator-change']);
  assert.deepEqual(watchTransaction(tx([{ name: 'OwnerPoolOperatorEvent', operator: OP }], { methods: ['set_operator_limits'] }), st, ctx()), [], 'limits change, same operator');
  // The first config seen only sets the baseline.
  const empty: WatchState = { spends: [] };
  assert.deepEqual(watchTransaction(tx([cfgEv(30)]), empty, ctx()), []);
  assert.deepEqual(empty.config, { feeBps: 30, paused: false, operatorPaused: false });
});

test('watch: operator actions the bot did not send; who called set_operator_paused', () => {
  const st = fresh();
  const bot = new Set(['bot1']);
  const c = ctx({ botTxids: bot, botLogSince: t0 });
  assert.deepEqual(watchTransaction(tx([reb('0.001', '0.01')], { txid: 'bot1', methods: ['rebalance'], resources: [OP] }), st, c), []);
  assert.deepEqual(rules(watchTransaction(tx([reb('0.001', '0.01')], { txid: 'stranger', methods: ['rebalance'], resources: [OP] }), st, c)), ['alert:not-bot']);
  assert.deepEqual(rules(watchTransaction(tx([reb('0.001', '0.01')], { txid: 'old', at: t0 - H }), st, c)), ['info:not-bot'], 'before the log starts: cannot tell');
  // The owner pausing the operator is not an operator action.
  assert.deepEqual(operatorActions(tx([], { methods: ['set_operator_paused'], resources: [OWNER] }), { ownerBadge: OWNER, operatorBadge: OP }), []);
  assert.deepEqual(operatorActions(tx([], { methods: ['set_operator_paused'], resources: [OP] }), { ownerBadge: OWNER, operatorBadge: OP }), ['set_operator_paused']);
  assert.deepEqual(operatorActions(tx([cfgEv(40)], { methods: ['operator_set_fee'] }), {}), ['operator_set_fee']);
  // Without a bot log nothing is compared.
  assert.deepEqual(watchTransaction(tx([reb('0.001', '0.01')], { txid: 'x' }), fresh(), ctx()), []);
});

test('watch: drift of the owner anchor and of the pool against the reference', () => {
  assert.deepEqual(driftFindings({ reference: 0.0008, poolPrice: 0.0008, ownerAnchor: ['1250', '1'], maxAnchorDrift: 0.05, maxPoolDrift: 0.03 }), []);
  assert.deepEqual(rules(driftFindings({ reference: 0.00085, poolPrice: 0.00084, ownerAnchor: ['1250', '1'], maxAnchorDrift: 0.05, maxPoolDrift: 0.03 })), ['warn:anchor-drift']);
  assert.deepEqual(rules(driftFindings({ reference: 0.0008, poolPrice: 0.00083, ownerAnchor: ['1250', '1'], maxAnchorDrift: 0.05, maxPoolDrift: 0.03 })), ['warn:pool-drift']);
  assert.deepEqual(rules(driftFindings({ reference: 0.0008, poolPrice: 0.00083, maxAnchorDrift: 0.05, maxPoolDrift: 0.03 })), ['warn:pool-drift'], 'no anchor known: pool check only');
});

test('watch: "half, then half" within 10 minutes is caught by the window rule though no single move is large', () => {
  const st = fresh();
  const c = ctx({ maxWindowSpendShare: W.maxWindowSpendShare, spendWindowMs: W.spendWindowSec * 1000 });
  // The soak's 18:58-18:59 moves: 0.007482 of 0.014964 (50%), then 0.003949 of 0.007899 (50%): together 74% of 0.014964.
  assert.deepEqual(watchTransaction(tx([reb('0.007482', '0.007482')], { at: t0 }), st, c), []);
  const f = watchTransaction(tx([reb('0.003949', '0.00395')], { at: t0 + 60_000 }), st, c);
  assert.deepEqual(rules(f), ['alert:window-spend']);
  assert.match(f[0]!.text, /74\.3% of the allowance available in 2 moves within 10 min/);
  // The same two moves 10 minutes apart: each judged alone (50%), no window finding.
  const st2 = fresh();
  watchTransaction(tx([reb('0.007482', '0.007482')], { at: t0 }), st2, c);
  assert.deepEqual(watchTransaction(tx([reb('0.003949', '0.00395')], { at: t0 + 600_000 }), st2, c), []);
  // The bot under its own cap: 50%, then the room left (60% - 50% = 10% of the start): exactly 60%, not above.
  const st3 = fresh();
  watchTransaction(tx([reb('0.005', '0.005')], { at: t0 }), st3, c);
  assert.deepEqual(watchTransaction(tx([reb('0.001', '0.004')], { at: t0 + 60_000 }), st3, c), []);
  // Not configured: not checked.
  const st4 = fresh();
  watchTransaction(tx([reb('0.007482', '0.007482')], { at: t0 }), st4, ctx());
  assert.deepEqual(watchTransaction(tx([reb('0.003949', '0.00395')], { at: t0 + 60_000 }), st4, ctx()), []);
});

test('watch: an operator limits change is flagged; the same limits re-announced are not', () => {
  const L = { move_budget_bps: '300', window_epochs: '72', max_reserve_a: '22000', max_reserve_b: '17.6', min_reserve_a: '10000', min_reserve_b: '8', min_fee_bps: '10', max_fee_bps: '100' };
  const st = { ...fresh(), limits: L };
  const ev = (limits: Record<string, string>): OwnerPoolEvent => ({ name: 'OwnerPoolOperatorEvent', operator: OP, limits });
  assert.deepEqual(watchTransaction(tx([ev(L)], { methods: ['set_operator_limits'] }), st, ctx()), []);
  const f = watchTransaction(tx([ev({ ...L, move_budget_bps: '3000', max_fee_bps: '200' })], { methods: ['set_operator_limits'], resources: [OWNER] }), st, ctx());
  assert.deepEqual(rules(f), ['alert:limits-change']);
  assert.equal(f[0]!.text, 'Operator limits changed (set_operator_limits): move_budget_bps 300 -> 3000, max_fee_bps 100 -> 200.');
  assert.equal(st.limits!.move_budget_bps, '3000');
  // The baseline taken from the pool's state has the event's shape.
  assert.deepEqual(limitsRecord({ moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '22000', maxReserveB: '17.6', minReserveA: '10000', minReserveB: '8', minFeeBps: 10, maxFeeBps: 100 }), L);
  // The event payload is parsed with its limits.
  const parsed = parseOwnerPoolEvent('OwnerPoolOperatorEvent', [
    { field_name: 'operator', kind: 'Enum', variant_id: '1', fields: [{ kind: 'Reference', value: OP }] },
    { field_name: 'limits', kind: 'Tuple', fields: Object.entries(L).map(([k, v]) => ({ field_name: k, kind: 'Decimal', value: v })) },
  ]);
  assert.deepEqual(parsed, { name: 'OwnerPoolOperatorEvent', operator: OP, limits: L });
});
