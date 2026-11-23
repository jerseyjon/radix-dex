// The Pools page's pure logic: prices, activity, fees, the bot's files, and the owner's actions built
// with the shared builders and the same guards as scripts/mainnet-owner-pool.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markRecord, parseOwnerPoolTransaction, tradeFromSwap, tradeRecord } from '@radix-dex/core';
import {
  NO_FEES, OwnerActionError, addFees, botRules, botView, cleanWant, ownerAnchorView, venueViews, curvePrice, describePoolTx, gapBps, heartbeatView, isOwnerAction, markoutView, planOwnerAction, previewView,
} from '../src/poolview.ts';
import { OPERATOR, OP_BADGE, OWNER, OWNER_BADGE, POOL, TEUR, XRD, callLine, configEvent, poolState, proofLine, rebalanceEvent, streamTx, swapEvent } from './pool-fixture.ts';

const sym = (r: string) => (r === XRD ? 'XRD' : r === TEUR ? 'TEUR' : r.slice(0, 10));
const owner = { account: OWNER, badge: OWNER_BADGE };

test('curve price and the gap to the market, signed', () => {
  assert.equal(curvePrice({ reserveA: '20000', reserveB: '16' }), 0.0008);
  assert.equal(curvePrice({ reserveA: '0', reserveB: '16' }), undefined);
  assert.ok(Math.abs(gapBps(0.000763, 0.0007958)! - -412.3) < 1, 'pool cheaper than the market: negative');
  assert.ok(gapBps(0.00081, 0.0008)! > 0);
  assert.equal(gapBps(0.0008, undefined), undefined);
});

test('activity: owner by the owner badge proof, operator by its methods, swaps by their event', () => {
  const ctx = { ownerBadge: OWNER_BADGE, resourceA: XRD, resourceB: TEUR, symbol: sym };
  const parse = (t: ReturnType<typeof streamTx>) => parseOwnerPoolTransaction(t, POOL)!;
  const own = describePoolTx(parse(streamTx({ txid: 'txid_a', sv: 3, at: '2026-11-23T10:00:00Z', manifest: [proofLine(OWNER, OWNER_BADGE), callLine('set_fee', '31u16')].join('\n'), events: [configEvent(31, false)] })), ctx);
  assert.equal(own.kind, 'owner');
  assert.deepEqual(own.methods, ['set_fee']);
  assert.match(own.lines[0]!, /fee 31 bps, owner pause off/);
  const op = describePoolTx(parse(streamTx({ txid: 'txid_b', sv: 4, at: '2026-11-23T10:01:00Z', manifest: [proofLine(OPERATOR, OP_BADGE), callLine('rebalance')].join('\n'), events: [rebalanceEvent('-8.03', '0', false)] })), ctx);
  assert.equal(op.kind, 'operator');
  assert.match(op.lines[0]!, /operator moved 8\.03 XRD reserves → inventory/, 'a negative amount left the reserves');
  const sw = describePoolTx(parse(streamTx({ txid: 'txid_c', sv: 5, at: '2026-11-23T10:02:00Z', manifest: callLine('swap_with_minimum', 'Bucket("b") Decimal("1")'), events: [swapEvent(TEUR, '0.0186', XRD, '23.2', '0.000056')] })), ctx);
  assert.equal(sw.kind, 'swap');
  assert.deepEqual(sw.swap, { input: TEUR, inputAmount: '0.0186', output: XRD, outputAmount: '23.2', fee: '0.000056' });
  // The owner rebalancing proves the owner badge: it is the owner, not the operator.
  const ownRebalance = describePoolTx(parse(streamTx({ txid: 'txid_d', sv: 6, at: '2026-11-23T10:03:00Z', manifest: [proofLine(OWNER, OWNER_BADGE), callLine('owner_rebalance')].join('\n'), events: [rebalanceEvent('5', '0', true)] })), ctx);
  assert.equal(ownRebalance.kind, 'owner');
  assert.match(ownRebalance.lines[0]!, /owner moved 5 XRD inventory → reserves/);
});

test('fees are summed per input token from swap events only', () => {
  const txs = [
    parseOwnerPoolTransaction(streamTx({ txid: 'txid_1', sv: 1, at: '2026-11-23T10:00:00Z', manifest: '', events: [swapEvent(XRD, '100', TEUR, '0.079', '0.3')] }), POOL)!,
    parseOwnerPoolTransaction(streamTx({ txid: 'txid_2', sv: 2, at: '2026-11-23T11:00:00Z', manifest: '', events: [swapEvent(TEUR, '0.01', XRD, '12.4', '0.00003'), configEvent(30, false)] }), POOL)!,
    parseOwnerPoolTransaction(streamTx({ txid: 'txid_3', sv: 3, at: '2026-11-23T12:00:00Z', manifest: '', events: [configEvent(40, false)] }), POOL)!,
  ];
  const once = addFees(NO_FEES, txs.slice(0, 2), XRD, TEUR);
  assert.deepEqual(once, { swaps: 2, feeA: '0.3', feeB: '0.00003', volumeA: '100', volumeB: '0.01', firstAt: Date.parse('2026-11-23T10:00:00Z'), lastAt: Date.parse('2026-11-23T11:00:00Z') });
  const more = addFees(once, txs.slice(2), XRD, TEUR);
  assert.deepEqual(more, once, 'a transaction without a swap adds nothing');
});

test('heartbeats: alive, stale, missing, another pool; never the pid', () => {
  const now = 1_000_000_000;
  const beat = (at: number, pool = POOL, ok = true) => JSON.stringify({ program: 'owner-pool-bot', network: 'stokenet', pool, pid: 4242, at, tick: 7, ok });
  assert.deepEqual(heartbeatView(beat(now - 30_000), POOL, now, 600_000), { status: 'alive', lastSeen: now - 30_000, tick: 7, ok: true, note: null });
  const stale = heartbeatView(beat(now - 700_000), POOL, now, 600_000);
  assert.equal(stale.status, 'stale');
  assert.equal(heartbeatView(undefined, POOL, now, 600_000).status, 'missing');
  assert.equal(heartbeatView('{not json', POOL, now, 600_000).status, 'missing');
  assert.equal(heartbeatView(beat(now, 'component_tdx_2_1other'), POOL, now, 600_000).status, 'other-pool');
  for (const v of [stale, heartbeatView(beat(now), POOL, now, 1)]) assert.ok(!JSON.stringify(v).includes('4242'), 'no pid');
});

test("the bot's state: only its own pool, the scale applied, nothing else carried", () => {
  const j = {
    identity: { network: 'stokenet', pool: POOL, badge: OP_BADGE, operatorAccount: OPERATOR },
    history: [{ at: 1, price: 0.0007 }, { at: 2, price: 0.00079 }], calibration: { scale: 2, reference: 1, at: 'x', anchor: ['1', '1'] },
    lastTx: { at: '2026-11-23T16:50:48Z', type: 'operator_set_fee(123)', txid: 'txid_x', status: 'CommittedSuccess' },
    pause: { pausedByBot: true, pauseReason: 'no reference' }, consecutiveFailures: 1, behindTicks: 24,
    venueConfirm: { confirmed: ['ociswap-precision'] }, singleVenue: { since: 5 }, spends: [{ at: 1, cost: 0.01, txid: 'txid_s' }], secretish: 'x',
  };
  const v = botView(j, POOL)!;
  assert.equal(v.reference!.price, 0.00158, 'reference in pool units');
  assert.equal(v.operatorAccount, OPERATOR);
  assert.equal(v.pausedByBot, true);
  assert.equal(v.behindTicks, 24);
  assert.deepEqual(v.confirmedVenues, ['ociswap-precision']);
  assert.ok(!('spends' in v) && !JSON.stringify(v).includes('secretish'));
  assert.equal(botView({ ...j, identity: { ...j.identity, pool: 'component_tdx_2_1other' } }, POOL), undefined);
  assert.equal(botView(null, POOL), undefined);
});

test('the markout summary is the script\'s, from the JSONL text', () => {
  const tx = parseOwnerPoolTransaction(streamTx({ txid: 'txid_m', sv: 1, at: '2026-11-23T10:00:00Z', manifest: '', events: [swapEvent(XRD, '100', TEUR, '0.079', '0.3')] }), POOL)!;
  const t = tradeFromSwap(tx, tx.events[0] as any, XRD, TEUR)!;
  const rec = tradeRecord(t, { price: 0.0008, raw: 0.0008, scale: 1, at: t.at });
  const mark = markRecord(rec, 5, t.at + 300_000, { price: 0.00081, raw: 0.00081, scale: 1, at: t.at + 300_000 }, 0.0008);
  const v = markoutView([rec, mark].map((r) => JSON.stringify(r)).join('\n') + '\n{torn');
  assert.equal(v.trades, 1);
  assert.equal(v.pending, 1, 'the +30 min mark is still due');
  assert.equal(v.all.horizons['5']!.marked, 1);
  assert.ok(Math.abs(v.all.feesA - 0.3) < 1e-12);
});

// ------------------------------------------------------------------ owner actions

const plan = (action: string, params: Record<string, unknown> = {}, o: { market?: number; state?: Parameters<typeof poolState>[0] } = {}) => planOwnerAction({
  action: action as any, state: poolState(o.state), owner, params, market: o.market ? { price: o.market, source: 'test venues' } : undefined, symbol: sym,
});

test('every owner action is built with the owner badge proof and no fee lock (the wallet adds it)', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['deposit', { amountA: '10', amountB: '0.008' }], ['withdraw', { amountA: '100' }], ['pause', {}], ['unpause', {}], ['fee', { feeBps: 40 }],
    ['anchor', {}], ['limits-fee', { limits: { maxFeeBps: 90 }, feeBps: 40 }], ['revoke', { confirm: 'REVOKE' }],
  ];
  for (const [action, params] of cases) {
    assert.ok(isOwnerAction(action));
    const p = plan(action, params, { market: 0.0008 });
    const lines = p.manifest.split('\n');
    assert.equal(lines[0], proofLine(OWNER, OWNER_BADGE), `${action}: proves the owner badge first`);
    assert.ok(!p.manifest.includes('lock_fee'), `${action}: no fee lock`);
    assert.ok(p.manifest.includes(`Address("${POOL}")`), `${action}: calls the pool`);
    assert.equal(p.scriptStep, action === 'limits-fee' ? 'limits-fee' : action);
  }
  assert.ok(!isOwnerAction('withdraw_all') && !isOwnerAction('__proto__'));
});

test('deposit: guarded by the reserves, refused off the market unless confirmed, and without a market unless confirmed', () => {
  const p = plan('deposit', { amountA: '10', amountB: '0.008' }, { market: 0.0008 });
  assert.match(p.manifest, /"deposit" Some\(Bucket\("a"\)\) Some\(Bucket\("b"\)\) Some\(Tuple\(Decimal\("20000"\), Decimal\("16"\)\)\);$/);
  assert.deepEqual(p.want, { reserves: ['20010', '16.008'] });
  assert.throws(() => plan('deposit', { amountA: '10', amountB: '0.008' }, { market: 0.00085 }), (e: Error) => e instanceof OwnerActionError && /gap 6\.250%.*Refused/.test(e.message));
  assert.ok(plan('deposit', { amountA: '10', amountB: '0.008', force: true }, { market: 0.00085 }).notes[0]!.includes('6.250%'));
  assert.throws(() => plan('deposit', { amountA: '10', amountB: '0.008' }), /No market price/);
  assert.match(plan('deposit', { amountA: '10', amountB: '0.008', force: true }).notes[0]!, /was not checked/);
  assert.throws(() => plan('deposit', { amountA: '10', amountB: '0.0000001' }, { market: 0.0008 }), /more than 6 decimal places/);
  assert.throws(() => plan('deposit', { amountA: '1e3' }, { market: 0.0008 }), /plain decimal/);
  assert.throws(() => plan('deposit', {}, { market: 0.0008 }), /at least one token/);
  assert.throws(() => plan('deposit', { amountA: '10' }, { market: 0.0008, state: { ra: '0', rb: '0' } }), /empty: deposit both/);
});

test('withdraw: proportional by default, guarded, never more than the reserves', () => {
  const p = plan('withdraw', { amountA: '100' });
  assert.match(p.manifest, /"withdraw" Decimal\("100"\) Decimal\("0\.08"\) Some\(Tuple\(Decimal\("20000"\), Decimal\("16"\)\)\);/);
  assert.match(p.manifest, /"deposit_batch" Expression\("ENTIRE_WORKTOP"\);$/);
  assert.deepEqual(p.want, { reserves: ['19900', '15.92'] });
  assert.throws(() => plan('withdraw', { amountA: '20001' }), /More than the reserves/);
  assert.throws(() => plan('withdraw', { amountA: '1', amountB: '17' }), /More than the reserves/);
});

test('fee, pause, anchor, limits and revoke: ranges, confirmations and notes', () => {
  assert.match(plan('fee', { feeBps: 150 }).notes[0]!, /outside the operator's range 10-100/);
  assert.throws(() => plan('fee', { feeBps: 501 }), /from 0 to 500/);
  assert.throws(() => plan('fee', { feeBps: '3.5' }), /whole number/);
  assert.match(plan('unpause', {}, { state: { operatorPaused: true } }).notes.join(' '), /operator's own pause is also on/);
  // The anchor from the market, rounded to 12 places as the script does; or a stated price; never neither.
  const a = plan('anchor', {}, { market: 0.000795829310975529 });
  assert.deepEqual(a.want, { anchor: ['1', '0.000795829311'] });
  assert.match(a.manifest, /"set_anchor" Decimal\("1"\) Decimal\("0\.000795829311"\) Some\(Tuple/);
  assert.deepEqual(plan('anchor', { price: '0.0008' }).want, { anchor: ['1', '0.0008'] });
  assert.throws(() => plan('anchor', {}), /state the anchor price yourself/);
  assert.throws(() => plan('anchor', { price: '-1' }), /positive/);
  // Limits merge onto the current ones; a fee outside the new range is refused (the builder's own check).
  const l = plan('limits-fee', { limits: { maxFeeBps: 90, windowEpochs: 144 }, feeBps: 40 });
  assert.deepEqual(l.want, { limits: { moveBudgetBps: 300, windowEpochs: 144, maxReserveA: '22000', maxReserveB: '17.6', minReserveA: '10000', minReserveB: '8', minFeeBps: 10, maxFeeBps: 90 }, feeBps: 40 });
  assert.match(l.manifest, /"set_operator_limits" 300u16 144u64 .* 10u16 90u16;\n.*"set_fee" 40u16;$/);
  assert.equal(l.manifest.match(/create_proof_of_amount/g)!.length, 1, 'one proof serves both calls');
  assert.throws(() => plan('limits-fee', { limits: { maxFeeBps: 20 }, feeBps: 40 }), /outside the new operator range/);
  assert.throws(() => plan('limits-fee', { limits: { bogus: 1 } }), /Unknown limit/);
  assert.throws(() => plan('limits-fee', { limits: { minReserveA: '30000' } }), /Floor above cap/);
  // Revoke needs the typed word.
  assert.throws(() => plan('revoke', {}), /Type REVOKE/);
  assert.throws(() => plan('revoke', { confirm: 'revoke' }), /Type REVOKE/);
  const r = plan('revoke', { confirm: 'REVOKE' });
  assert.match(r.manifest, /"set_operator" None None;$/);
  assert.deepEqual(r.want, { operator: null, ownerPaused: true, operatorPaused: false });
});

test('the preview in the owner\'s terms; a `want` sent back is cleaned to known fields', () => {
  const m = plan('withdraw', { amountA: '100' }).manifest;
  const v = previewView(m, { ok: true, feeXrd: '0.51', changes: [{ entity: POOL, resource: XRD, amount: '-100' }, { entity: OWNER, resource: XRD, amount: '100' }] }, { owner: OWNER, pool: POOL, ownerBadge: OWNER_BADGE, symbol: sym });
  assert.deepEqual(v.proofs, [{ account: OWNER, badge: OWNER_BADGE, label: 'pool owner badge' }]);
  assert.deepEqual(v.changes.map((c) => [c.label, c.items.map((i) => `${i.amount} ${i.symbol}`)]), [['the pool', ['-100 XRD']], ['your account', ['100 XRD']]]);
  assert.equal(previewView(m, { ok: false, error: 'Reserves moved', feeXrd: '0', changes: [] }, { owner: OWNER, pool: POOL, ownerBadge: OWNER_BADGE, symbol: sym }).error, 'Reserves moved');
  assert.deepEqual(cleanWant({ feeBps: 31, reserves: ['1', '2'], operator: null, junk: 1, anchor: ['x', '1'] }), { feeBps: 31, reserves: ['1', '2'], operator: null });
  assert.deepEqual(cleanWant('nope'), {});
});

test("the graphics' rules come from the bot's defaults: 5% anchor stop, dead band half the fee", () => {
  const r = botRules(110);
  assert.equal(r.anchorStop, 0.05);
  assert.ok(Math.abs(r.anchorResume - 0.04) < 1e-12);
  assert.equal(r.deadBandBps, 55);
  assert.equal(r.feeBandBps, 110);
  assert.equal(r.reserveFraction, 0.1);
  assert.equal(r.spendFraction, 0.5);
  // An explicit dead band wins over half the fee.
  assert.equal(botRules(110, { maxAnchorDistance: 0.03, anchorResumeFactor: 0.5, deadBandBps: 20, reserveFraction: 0, spendFraction: 1 }).deadBandBps, 20);
});

test("the owner's anchor: the bot's reading of the owner's statement first, else the ledger anchor", () => {
  const st = { anchor: ['1', '0.00079187319'] as [string, string], txid: 'txid_x', at: 123 };
  assert.deepEqual(ownerAnchorView({ ownerAnchor: st }, ['1', '0.0008']), { anchor: st.anchor, source: 'owner-statement', at: 123, price: 0.00079187319 });
  assert.deepEqual(ownerAnchorView({ ownerAnchor: null }, ['2', '0.0016']), { anchor: ['2', '0.0016'], source: 'ledger', at: null, price: 0.0008 });
  assert.equal(ownerAnchorView(undefined, undefined), null);
  assert.equal(ownerAnchorView(undefined, ['0', '1']), null);
});

test('venues carry their depth and own fee for the depth overlay; nothing undefined or NaN', () => {
  const v = venueViews([
    { venue: 'ociswap-precision', used: true, mid: 0.000796, depth: 250_000, fee: 0.0005 },
    { venue: 'caviarnine', used: false, dropped: 'preview failed', mid: undefined, depth: NaN, fee: undefined },
  ]);
  assert.deepEqual(v[0], { venue: 'ociswap-precision', used: true, mid: 0.000796, dropped: null, depth: 250_000, fee: 0.0005 });
  assert.deepEqual(v[1], { venue: 'caviarnine', used: false, mid: null, dropped: 'preview failed', depth: null, fee: null });
});
