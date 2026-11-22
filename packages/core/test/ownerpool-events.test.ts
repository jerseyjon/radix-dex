// The OwnerPool's own events from the Gateway stream (packages/core/src/ownerpool-events.ts), the
// owner's anchor selection (resolveOwnerAnchor in ownerpool-bot.ts) and the alert sink (alerts.ts).
// Transaction shapes follow the Stokenet pool's real history (22 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertLimiter, AlertSink, Gateway, NETWORKS, findOwnerAnchor, lastOwnerAnchor, parseAnchorFlag, parseOwnerPoolEvent, parseOwnerPoolTransaction,
  readOwnerPoolTransactions, refreshOwnerAnchor, resolveOwnerAnchor, type OwnerPoolTx,
} from '../src/index.ts';

const POOL = 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk';
const OTHER = 'component_tdx_2_1cqelumvmmgwths34k9pp0htd2ykwq7d70m0r389etwh39ul3j5tyj5';
const OWNER_BADGE = 'resource_tdx_2_1tkzuvmezcle34heuuzleuuhu3p4g90ncst257llxuh5qrv2nfp9wc6';
const OP_BADGE = 'resource_tdx_2_1tkfvg8qudhzmp4fj8z5jlw3wnlsm6cghhwvcfmekwyz73xnwl2c24q';

const dec = (field_name: string, value: string) => ({ kind: 'Decimal', field_name, value });
const ev = (name: string, fields: any[], emitter = POOL, module = 'Main') => ({ name, emitter: { type: 'Method', entity: { entity_address: emitter }, object_module_id: module }, data: { kind: 'Tuple', fields } });
const anchorEv = (a: string, b: string, emitter = POOL, module = 'Main') => ev('OwnerPoolAnchorEvent', [dec('anchor_a', a), dec('anchor_b', b)], emitter, module);
const rebalanceEv = (o: { amountA: string; cost: string; allowance: string; byOwner: boolean }) => ev('OwnerPoolRebalanceEvent', [
  dec('amount_a', o.amountA), dec('amount_b', '0'), dec('reserve_a', '19985.42875'), dec('reserve_b', '15.988343'), dec('inventory_a', '1067.38'), dec('inventory_b', '0.8'),
  dec('cost', o.cost), dec('allowance', o.allowance), { kind: 'Bool', field_name: 'by_owner', value: o.byOwner },
]);
const configEv = (fee: number, paused: boolean, operatorPaused: boolean) => ev('OwnerPoolConfigEvent', [{ kind: 'U16', field_name: 'fee_bps', value: String(fee) }, { kind: 'Bool', field_name: 'paused', value: paused }, { kind: 'Bool', field_name: 'operator_paused', value: operatorPaused }]);
const tx = (sv: number, events: any[], o: { status?: string; manifest?: string; txid?: string } = {}) => ({
  state_version: sv, intent_hash: o.txid ?? `txid_${sv}`, transaction_status: o.status ?? 'CommittedSuccess', confirmed_at: '2026-11-22T15:14:54.425Z',
  receipt: { events }, manifest_instructions: o.manifest,
});

test('events: only the pool\'s own Main-module events are read; malformed pool events throw', () => {
  const t = parseOwnerPoolTransaction(tx(10, [
    anchorEv('1250', '1'),
    anchorEv('1', '1', OTHER), // a copycat event from another component
    anchorEv('2', '1', POOL, 'Metadata'), // another module of the pool
    ev('SetRoleEvent', []),
    configEv(30, true, false),
  ], { manifest: `CALL_METHOD Address("account_x") "create_proof_of_amount" Address("${OWNER_BADGE}") Decimal("1");\nCALL_METHOD Address("${POOL}") "set_operator" Enum<1u8>(Address("${OP_BADGE}")) Enum<1u8>(Tuple(Decimal("1250"), Decimal("1")));` }), POOL)!;
  assert.deepEqual(t.events, [{ name: 'OwnerPoolAnchorEvent', anchorA: '1250', anchorB: '1' }, { name: 'OwnerPoolConfigEvent', feeBps: 30, paused: true, operatorPaused: false }]);
  assert.deepEqual(t.methods, ['set_operator']);
  assert.deepEqual(t.resources, [OWNER_BADGE, OP_BADGE]);
  assert.equal(t.at, Date.parse('2026-11-22T15:14:54.425Z'));
  assert.equal(parseOwnerPoolTransaction(tx(11, [anchorEv('9', '9')], { status: 'CommittedFailure' }), POOL), undefined);
  assert.throws(() => parseOwnerPoolTransaction(tx(12, [ev('OwnerPoolAnchorEvent', [dec('anchor_a', 'x'), dec('anchor_b', '1')])]), POOL), /not a decimal/);
  const r = parseOwnerPoolEvent('OwnerPoolRebalanceEvent', rebalanceEv({ amountA: '-36.03', cost: '0.0018', allowance: '0.005283', byOwner: false }).data.fields);
  assert.deepEqual(r && r.name === 'OwnerPoolRebalanceEvent' ? [r.amountA, r.cost, r.allowance, r.byOwner] : null, ['-36.03', '0.0018', '0.005283', false]);
  assert.equal(parseOwnerPoolEvent('OwnerPoolSomethingNew', []), undefined);
});

test('owner anchor: the last anchor event wins; operator rebalances and revokes do not count', () => {
  const txs = [
    tx(34759001, [anchorEv('1250', '1'), configEv(30, false, false)]), // first appointment
    tx(34762243, [rebalanceEv({ amountA: '-20.01', cost: '0.001', allowance: '0.0002', byOwner: false })]), // operator move: anchor on ledger moves, no event
    tx(34762459, [configEv(30, true, false)]), // revoke: no anchor event
    tx(34762594, [rebalanceEv({ amountA: '20.01', cost: '0', allowance: '0', byOwner: true }), anchorEv('1250', '1')], { txid: 'reappoint' }),
    tx(34784483, [rebalanceEv({ amountA: '-36.03', cost: '0.0018', allowance: '0.0052', byOwner: false })]),
  ].map((t) => parseOwnerPoolTransaction(t, POOL)!);
  assert.deepEqual(lastOwnerAnchor(txs), { anchor: ['1250', '1'], txid: 'reappoint', stateVersion: 34762594, at: Date.parse('2026-11-22T15:14:54.425Z') });
  // Order of the input does not matter; two statements in one transaction: the later one.
  const two = parseOwnerPoolTransaction(tx(40000000, [anchorEv('1000', '1'), anchorEv('1100', '1')]), POOL)!;
  assert.deepEqual(lastOwnerAnchor([two, ...txs.reverse()])?.anchor, ['1100', '1']);
  assert.equal(lastOwnerAnchor(txs.filter((t) => !t.events.some((e) => e.name === 'OwnerPoolAnchorEvent'))), undefined);
  // A zero anchor is impossible on ledger (the contract refuses it): never trusted.
  assert.equal(lastOwnerAnchor([{ ...two, events: [{ name: 'OwnerPoolAnchorEvent', anchorA: '0', anchorB: '1' }] } as OwnerPoolTx]), undefined);
});

/** A fake Gateway serving `/stream/transactions` from `items` (state versions ascending), pages of `page`. */
function streamGateway(items: any[], page = 2): { gw: Gateway; calls: any[] } {
  const calls: any[] = [];
  const fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.ok(url.endsWith('/stream/transactions'));
    assert.deepEqual(body.event_global_emitters_filter, [POOL]);
    let list = body.order === 'desc' ? [...items].reverse() : [...items];
    if (body.from_ledger_state) {
      const sv = body.from_ledger_state.state_version;
      if (items.length && sv > items[items.length - 1].state_version) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'from_ledger_state is beyond the end of the known ledger' }) };
      }
      list = list.filter((t) => t.state_version >= sv);
    }
    const start = body.cursor ? Number(body.cursor) : 0;
    const slice = list.slice(start, start + page);
    const next = start + page < list.length ? String(start + page) : undefined;
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: slice, next_cursor: next }) };
  };
  return { gw: new Gateway(NETWORKS.stokenet, { fetch, attempts: 1 }), calls };
}

test('owner anchor from the stream: newest first until found; incremental refresh; never found; incomplete', async () => {
  const history = [
    tx(100, [anchorEv('1250', '1')]), tx(200, [configEv(30, false, false)]), tx(300, [anchorEv('1300', '1')], { txid: 'second' }),
    tx(400, [ev('OwnerPoolSwapEvent', [dec('reserve_a', '1'), dec('reserve_b', '1')])]), tx(500, [configEv(40, false, false)]),
  ];
  const { gw, calls } = streamGateway(history);
  const f = await findOwnerAnchor(gw, POOL);
  assert.equal(f.statement?.txid, 'second');
  assert.equal(f.complete, true);
  assert.equal(f.newest, 500);
  assert.equal(calls.length, 2, 'stops at the page that holds the statement');
  assert.equal(calls[0].order, 'desc');

  // Refresh from 500: a new statement at 600 replaces it; nothing new keeps it.
  const later = streamGateway([...history, tx(600, [anchorEv('1400', '1')], { txid: 'third' })]);
  const r = await refreshOwnerAnchor(later.gw, POOL, f.statement, 500);
  assert.deepEqual([r.statement?.txid, r.newest, r.complete], ['third', 600, true]);
  const same = await refreshOwnerAnchor(later.gw, POOL, r.statement, 600); // beyond the end: nothing new
  assert.deepEqual([same.statement?.txid, same.newest, same.complete], ['third', 600, true]);

  const never = streamGateway([tx(1, [configEv(30, false, false)]), tx(2, [configEv(30, false, false)]), tx(3, [configEv(30, false, false)])]);
  const n = await findOwnerAnchor(never.gw, POOL);
  assert.deepEqual([n.statement, n.complete], [undefined, true]);
  const cut = await findOwnerAnchor(never.gw, POOL, { maxPages: 1 });
  assert.deepEqual([cut.statement, cut.complete], [undefined, false]);

  const all = await readOwnerPoolTransactions(gw, POOL, 1);
  assert.deepEqual([all.txs.map((t) => t.stateVersion), all.next, all.complete], [[100, 200, 300, 400, 500], 501, true]);
});

test('resolveOwnerAnchor: ledger first; the flag only when the ledger cannot say; otherwise none', () => {
  const ledger = { anchor: ['1250', '1'] as [string, string], txid: 't', stateVersion: 5, at: 0 };
  assert.deepEqual(resolveOwnerAnchor({ ledger, ledgerComplete: true }), { source: 'ledger', ...ledger });
  // Same price written differently is no mismatch; a different price is reported and NOT used.
  assert.equal((resolveOwnerAnchor({ ledger, ledgerComplete: true, flag: ['2500', '2'] }) as any).flagMismatch, undefined);
  const m = resolveOwnerAnchor({ ledger, ledgerComplete: true, flag: ['1300', '1'] });
  assert.deepEqual([m.source, m.source === 'ledger' && m.anchor, (m as any).flagMismatch], ['ledger', ['1250', '1'], ['1300', '1']]);
  assert.deepEqual(resolveOwnerAnchor({ ledgerComplete: true, flag: ['1300', '1'] }).source, 'flag');
  assert.deepEqual(resolveOwnerAnchor({ ledgerComplete: false, ledgerError: 'HTTP 503', flag: ['1300', '1'] }).source, 'flag');
  const none = resolveOwnerAnchor({ ledgerComplete: true });
  assert.equal(none.source, 'none');
  assert.match(none.source === 'none' ? none.reason : '', /no owner anchor statement.*will not rebalance/);
  assert.match((resolveOwnerAnchor({ ledgerComplete: false, ledgerError: 'HTTP 503' }) as any).reason, /ledger lookup failed: HTTP 503/);
  assert.equal(resolveOwnerAnchor({ ledger, ledgerComplete: false }).source, 'none', 'an incomplete search is not an answer');
  assert.deepEqual(parseAnchorFlag('1250:1'), ['1250', '1']);
  assert.throws(() => parseAnchorFlag('1250'), /A:B/);
  assert.throws(() => parseAnchorFlag('0:1'), /A:B/);
});

test('alerts: rate-limited per condition, nothing sent without a URL, failures retried, never thrown', async () => {
  const l = new AlertLimiter(60_000);
  assert.equal(l.allow('a', 0), true);
  assert.equal(l.allow('a', 59_999), false);
  assert.equal(l.allow('b', 1), true, 'other conditions are independent');
  assert.equal(l.allow('a', 60_000), true);
  l.clear('a');
  assert.equal(l.allow('a', 60_001), true, 'cleared: alerts at once');
  assert.equal(new AlertLimiter(60_000, { a: 100_000 }).allow('a', 50_000), true, 'a clock that went back does not silence');

  const posts: { url: string; body: string; ct: string }[] = [];
  let fail = false;
  const fetch = async (url: string, init: any) => {
    if (fail) throw new Error('connection refused');
    posts.push({ url, body: init.body, ct: init.headers['content-type'] });
    return { ok: true, status: 200 };
  };
  const sink = new AlertSink('http://127.0.0.1:1/topic', { intervalMs: 3_600_000, fetch, prefix: '[bot] ' });
  assert.deepEqual(await sink.alert('pause', 'paused', 0), { key: 'pause', sent: true, text: '[bot] paused' });
  assert.equal((await sink.alert('pause', 'paused again', 1000)).suppressed, true);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { url: 'http://127.0.0.1:1/topic', body: '[bot] paused', ct: 'text/plain; charset=utf-8' });
  fail = true;
  const r = await sink.alert('halt', 'halted', 2000);
  assert.equal(r.sent, false);
  assert.match(r.error ?? '', /connection refused/);
  fail = false;
  assert.equal((await sink.alert('halt', 'halted', 3000)).sent, true, 'an undelivered alert is retried next time');
  assert.equal((await sink.alert('long', 'x'.repeat(5000), 4000)).text.length, 1000);

  const off = new AlertSink(undefined, { intervalMs: 1000, fetch: async () => { throw new Error('must not be called'); } });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.alert('k', 'hello', 0), { key: 'k', sent: false, text: 'hello' });
  assert.equal(new AlertSink('', { intervalMs: 1 }).enabled, false, 'an empty URL is no URL');
});
