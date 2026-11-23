// trySubmitAndWait: a failed submission or status poll must come back as an outcome the bot counts
// toward its halt (recordSendOutcome), never as a thrown error (found on ledger in run7, 23 Nov 2026:
// a submit refused with HTTP 503 escaped as a tick error, so three failed sends never halted the bot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, NETWORKS, recordSendOutcome, sendHalted, trySubmitAndWait, type FetchLike } from '../src/index.ts';

const tx = { hex: 'aa', intentHashId: 'txid_tdx_2_1test' };
function fakeGateway(handler: (path: string, n: number) => { status: number; body: unknown } | Error): { gw: Gateway; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push(path);
    const r = handler(path, calls.filter((c) => c === path).length);
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { gw: new Gateway(NETWORKS.stokenet, { fetch, attempts: 1 }), calls };
}

test('trySubmitAndWait: a submit refused with HTTP 503 is SubmitFailed, not a throw, and nothing is polled', async () => {
  const { gw, calls } = fakeGateway(() => ({ status: 503, body: { message: 'down' } }));
  const out = await trySubmitAndWait(gw, tx, 1000, 1);
  assert.equal(out.status, 'SubmitFailed');
  assert.match((out as { error: string }).error, /503/);
  assert.deepEqual(calls, ['/transaction/submit']);
});

test('trySubmitAndWait: a connection error on submit is SubmitFailed', async () => {
  const { gw } = fakeGateway(() => new Error('ECONNRESET'));
  const out = await trySubmitAndWait(gw, tx, 1000, 1);
  assert.equal(out.status, 'SubmitFailed');
});

test('trySubmitAndWait: failed status polls are retried; the commit is still seen', async () => {
  const { gw } = fakeGateway((path, n) => path === '/transaction/submit' ? { status: 200, body: { duplicate: false } }
    : n <= 2 ? { status: 503, body: {} } : { status: 200, body: { intent_status: 'CommittedSuccess' } });
  assert.deepEqual(await trySubmitAndWait(gw, tx, 5000, 1), { status: 'CommittedSuccess' });
});

test('trySubmitAndWait: PermanentlyRejected is Rejected; polls failing to the end are a Timeout with the last error', async () => {
  const rej = fakeGateway((path) => path === '/transaction/submit' ? { status: 200, body: {} } : { status: 200, body: { intent_status: 'PermanentlyRejected', error_message: 'nope' } });
  assert.deepEqual(await trySubmitAndWait(rej.gw, tx, 5000, 1), { status: 'Rejected', error: 'nope' });
  const to = fakeGateway((path) => path === '/transaction/submit' ? { status: 200, body: {} } : { status: 503, body: {} });
  const out = await trySubmitAndWait(to.gw, tx, 30, 5);
  assert.equal(out.status, 'Timeout');
  assert.match((out as { error: string }).error, /last status error: .*503/);
});

test('three failed submissions in a row halt sending (the bot path: trySubmitAndWait -> recordSendOutcome)', async () => {
  const { gw } = fakeGateway(() => ({ status: 503, body: {} }));
  let st: { consecutiveFailures: number; haltedUntil?: number } = { consecutiveFailures: 0 };
  let halted = false;
  for (let i = 0; i < 3; i++) {
    const out = await trySubmitAndWait(gw, tx, 1000, 1);
    const so = recordSendOutcome(st, out.status === 'CommittedSuccess', 1_000 + i, { maxFailures: 3, haltMs: 3_600_000 });
    st = { consecutiveFailures: so.consecutiveFailures, haltedUntil: so.haltedUntil };
    halted = so.halted;
  }
  assert.equal(halted, true);
  assert.equal(st.consecutiveFailures, 3);
  assert.equal(sendHalted(st, 2_000), true);
  assert.equal(sendHalted(st, 1_002 + 3_600_000), false);
});

test('recordSendOutcome: one more failure after a halt runs out halts again; the success that ends a halted run says recovered', () => {
  const o = { maxFailures: 3, haltMs: 150_000 };
  let st: { consecutiveFailures: number; haltedUntil?: number } = { consecutiveFailures: 0 };
  for (let i = 0; i < 3; i++) st = recordSendOutcome(st, false, 0, o);
  assert.equal(sendHalted(st, 149_999), true);
  const again = recordSendOutcome(st, false, 160_000, o);
  assert.equal(again.halted, true);
  assert.equal(again.consecutiveFailures, 4);
  assert.equal(again.haltedUntil, 310_000);
  const ok = recordSendOutcome(again, true, 320_000, o);
  assert.equal(ok.recovered, true);
  assert.equal(ok.consecutiveFailures, 0);
  assert.equal(recordSendOutcome({ consecutiveFailures: 2 }, true, 0, o).recovered, false);
  assert.equal(recordSendOutcome({ consecutiveFailures: 0 }, true, 0, o).recovered, false);
});
