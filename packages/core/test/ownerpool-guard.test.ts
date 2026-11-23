// Guards from the 23 Nov 2026 review (docs/review-2026-11-23-bot-review.md): one test per finding where
// the fix is pure logic, plus the lock and durable-state file helpers on a temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NETWORKS, OWNER_POOL_REFERENCE_PAIRS, MAINNET_SEND_POOLS, OWNER_POOL_PACKAGES, pairProblem, resolveScale, stateIdentityProblem, lockFileName, lockVerdict, flagRangeProblems, optValue,
  sendGuardProblems, medianReference, anchorStrike, NO_REFERENCE_VETO, isReserveRace, isProtectiveSend, recordSendOutcomeV2, txWindow, pendingGate, stampLedgerTime, heartbeatVerdict,
  targetDepthUpdate, spend24hBudgets, botFeeBounds, moveAwayFromReference, type SendGuardInput,
} from '../src/index.ts';
import { acquireLock, loadJsonWithBackup, saveJsonDurable } from '../src/ownerpool-files.ts';

const MAIN = OWNER_POOL_REFERENCE_PAIRS.mainnet!;

test('C-1: mainnet allows only scale 1 (default 1); auto stays for Stokenet', () => {
  assert.deepEqual(resolveScale('mainnet', undefined), { ok: true, scale: 1 });
  assert.deepEqual(resolveScale('mainnet', '1'), { ok: true, scale: 1 });
  assert.equal(resolveScale('mainnet', 'auto').ok, false);
  assert.equal(resolveScale('mainnet', '0.98').ok, false);
  assert.deepEqual(resolveScale('stokenet', undefined), { ok: true, scale: 'auto' });
  assert.deepEqual(resolveScale('stokenet', '1.02'), { ok: true, scale: 1.02 });
  assert.equal(resolveScale('stokenet', '-1').ok, false);
});

test('H-1: the pool must be the reference pair in its orientation', () => {
  assert.equal(pairProblem({ resourceA: NETWORKS.mainnet.xrd, resourceB: MAIN.b }, MAIN), undefined);
  assert.match(pairProblem({ resourceA: MAIN.b, resourceB: NETWORKS.mainnet.xrd }, MAIN)!, /INVERTED/);
  assert.match(pairProblem({ resourceA: NETWORKS.mainnet.xrd, resourceB: 'resource_rdx1_xusdc' }, MAIN)!, /not the reference pair/);
  const sto = OWNER_POOL_REFERENCE_PAIRS.stokenet!;
  assert.equal(pairProblem({ resourceA: NETWORKS.stokenet.xrd, resourceB: sto.b }, sto), undefined);
});

test('H-3: a state file is tied to network, pool, badge and operator account', () => {
  const want = { network: 'mainnet', pool: 'component_rdx1p', badge: 'resource_rdx1b', operatorAccount: 'account_rdx1a' };
  assert.equal(stateIdentityProblem(want, want), undefined);
  assert.match(stateIdentityProblem(undefined, want)!, /no identity/);
  assert.match(stateIdentityProblem({}, want)!, /no identity/);
  assert.match(stateIdentityProblem({ ...want, network: 'stokenet' }, want)!, /network stokenet != mainnet/);
  assert.match(stateIdentityProblem({ ...want, pool: 'component_tdx_x' }, want)!, /pool/);
  assert.match(stateIdentityProblem({ ...want, badge: 'resource_other' }, want)!, /badge/);
  // The operator account is checked when known (the watcher has none).
  assert.equal(stateIdentityProblem({ network: 'mainnet', pool: 'component_rdx1p' }, { network: 'mainnet', pool: 'component_rdx1p' }), undefined);
});

test('L-1: the lock is keyed on network and pool; a dead or reused pid is stale', () => {
  assert.equal(lockFileName('owner-pool-bot', 'mainnet', 'component_rdx1abc'), 'owner-pool-bot-mainnet-component_rdx1abc.lock');
  const alive = (pid: number, prog: string) => pid === 42 && prog === 'owner-pool-bot';
  assert.equal(lockVerdict('42\nowner-pool-bot\nx', alive, 7).stale, false);
  assert.equal(lockVerdict('43\nowner-pool-bot\nx', alive, 7).stale, true);
  assert.equal(lockVerdict('42\nsomething-else\nx', alive, 7).stale, true, 'pid reused by another program');
  assert.equal(lockVerdict('garbage', alive, 7).stale, true);
  assert.equal(lockVerdict(undefined, alive, 7).stale, true);
});

test('L-1: acquireLock is exclusive, replaces a stale lock, and releases only its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-'));
  const p = join(dir, 'locks', 'a.lock');
  const a = acquireLock(p, 'prog', () => true);
  assert.ok(readFileSync(p, 'utf8').startsWith(`${process.pid}\nprog\n`));
  // Another live holder: refused.
  const mine = readFileSync(p, 'utf8');
  writeFileSync(p, '42\nprog\nnow\n');
  assert.throws(() => acquireLock(p, 'prog', (pid) => pid === 42), /pid 42 \(prog\) holds/);
  writeFileSync(p, mine);
  // A holder that is gone: stale, replaced.
  writeFileSync(p, '999999\nprog\nold\n');
  const b = acquireLock(p, 'prog', () => false);
  assert.match(b.replacedStale!, /gone/);
  a.release(); // not ours any more: left alone
  assert.ok(existsSync(p));
  b.release();
  assert.ok(!existsSync(p));
});

test('L-6: durable saves keep a .bak; a corrupt state falls back to it, else refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-'));
  const p = join(dir, 's.json');
  assert.deepEqual(loadJsonWithBackup(p), {});
  saveJsonDurable(p, { v: 1 });
  saveJsonDurable(p, { v: 2 });
  assert.deepEqual(JSON.parse(readFileSync(`${p}.bak`, 'utf8')), { v: 1 });
  writeFileSync(p, '{"v": 3, trunc');
  const r = loadJsonWithBackup<{ v: number }>(p);
  assert.deepEqual(r.data, { v: 1 });
  assert.match(r.recovered!, /corrupt/);
  writeFileSync(`${p}.bak`, 'also bad');
  assert.throws(() => loadJsonWithBackup(p), /corrupt .* no usable \.bak/);
});

test('L-2: numeric flags are range-checked (tighter on mainnet); a flag cannot swallow the next one', () => {
  assert.deepEqual(flagRangeProblems({ maxAnchorDistance: 0.05, minVenues: 1, confirmTicks: 2 }, 'mainnet'), []);
  assert.match(flagRangeProblems({ maxAnchorDistance: 5 }, 'stokenet')[0]!, /maxAnchorDistance = 5 is outside/);
  assert.match(flagRangeProblems({ maxAnchorDistance: 0.2 }, 'mainnet')[0]!, /\(mainnet\)/);
  assert.deepEqual(flagRangeProblems({ maxAnchorDistance: 0.2 }, 'stokenet'), []);
  assert.match(flagRangeProblems({ minVenues: 1.5 }, 'stokenet')[0]!, /whole number/);
  assert.match(flagRangeProblems({ maxTxPerHour: NaN }, 'stokenet')[0]!, /outside/);
  assert.match(flagRangeProblems({ referenceMedianN: 1 }, 'mainnet')[0]!, /outside 3\.\.15/);
  assert.equal(optValue(['--scale', '1'], 'scale'), '1');
  assert.equal(optValue(['--x'], 'scale'), undefined);
  assert.throws(() => optValue(['--scale', '--send'], 'scale'), /needs a value/);
  assert.throws(() => optValue(['--scale'], 'scale'), /needs a value/);
  assert.equal(optValue(['--dead-band', '-1'], 'dead-band'), '-1', 'a negative number is a value');
});

test('the mainnet --send guard: every condition, each with its own message', () => {
  const ok: SendGuardInput = {
    network: 'mainnet', send: true, scaleFlag: '1', explicit: { pool: true, badge: true, key: true, state: true, sentLog: true }, venues: ['ociswap-precision'],
    excludeVenues: false, ownerAnchorFlag: false, alertUrl: 'http://127.0.0.1:1/x', ack: true, pool: 'component_rdx1p', mainnetPackages: ['package_rdx1x'], sendPools: ['component_rdx1p'], coingecko: true,
  };
  assert.deepEqual(sendGuardProblems(ok), []);
  assert.deepEqual(sendGuardProblems({ ...ok, send: false, alertUrl: undefined, ack: false }), [], 'dry run: no send guard');
  const one = (o: Partial<SendGuardInput>, re: RegExp) => { const p = sendGuardProblems({ ...ok, ...o }); assert.equal(p.length, 1, p.join(' | ')); assert.match(p[0]!, re); };
  one({ scaleFlag: 'auto' }, /only --scale 1/);
  one({ explicit: { ...ok.explicit, key: false, sentLog: false } }, /--key, --sent-log must be given explicitly/);
  one({ venues: ['fixed:0.0008'] }, /synthetic venues/);
  one({ excludeVenues: true }, /--exclude-venues/);
  one({ ownerAnchorFlag: true }, /--owner-anchor/);
  one({ alertUrl: undefined }, /alert URL/);
  one({ mainnetPackages: [] }, /OWNER_POOL_PACKAGES\.mainnet is empty/);
  one({ sendPools: [] }, /not in MAINNET_SEND_POOLS/);
  one({ ack: false }, /--mainnet-live/);
  one({ coingecko: false }, /CoinGecko brake/);
  // Stokenet: only the alert URL.
  assert.deepEqual(sendGuardProblems({ ...ok, network: 'stokenet', scaleFlag: 'auto', ack: false, sendPools: [], mainnetPackages: [] }), []);
  assert.equal(sendGuardProblems({ ...ok, network: 'stokenet', alertUrl: undefined }).length, 1);
  // As committed today: mainnet --send is impossible.
  // The package is published and the owner's XRD/hUSDC pool approved for sending (23 Nov 2026).
  assert.deepEqual([MAINNET_SEND_POOLS, OWNER_POOL_PACKAGES.mainnet?.length ?? 0], [['component_rdx1cz6ga0dfz3vqefku0vvgyu0fsv9q6u09vtkpew5ysa8qdsz3ha6zyr'], 1]);
});

test('H-2: the target is the median of the last 3 healthy readings; one spike is not the target', () => {
  const t = 1_000_000;
  const o = { n: 3, maxAgeMs: 600_000 };
  assert.equal(medianReference([{ at: t, price: 1 }], t, o).price, undefined, 'warming up');
  const rs = [{ at: t - 120_000, price: 1.0 }, { at: t - 60_000, price: 1.001 }, { at: t, price: 1.05 }];
  assert.equal(medianReference(rs, t, o).price, 1.001, 'a one-tick 5% spike does not move the target');
  assert.equal(medianReference([...rs, { at: t + 60_000, price: 1.05 }], t + 60_000, o).price, 1.05, 'held for 2 of 3 ticks: it does');
  assert.equal(medianReference(rs, t + 1_000_000, o).price, undefined, 'too old');
  // The anchor stop pauses only on the second tick in a row.
  let s = anchorStrike(undefined, false, 2);
  assert.deepEqual(s, { strikes: 1, confirmed: false });
  s = anchorStrike(s.strikes, false, 2);
  assert.deepEqual(s, { strikes: 2, confirmed: true });
  assert.deepEqual(anchorStrike(s.strikes, true, 2), { strikes: 0, confirmed: false });
  assert.equal(NO_REFERENCE_VETO({ reference: 1, watch: [], now: t }), undefined, 'no veto is wired in');
});

test('M-2: the protective pause and fee widens pass the halt and cap; swap races do not halt', () => {
  assert.equal(isProtectiveSend('set_operator_paused(true)'), true);
  assert.equal(isProtectiveSend('set_operator_paused(false)'), false);
  assert.equal(isProtectiveSend('operator_set_fee(120)', { feeFrom: 100, feeTo: 120 }), true);
  assert.equal(isProtectiveSend('operator_set_fee(80)', { feeFrom: 100, feeTo: 80 }), false);
  assert.equal(isProtectiveSend('rebalance'), false);
  assert.equal(isReserveRace('ApplicationError(Panic("Reserves moved"))'), true);
  const o = { maxFailures: 3, maxRaces: 10, haltMs: 3_600_000 };
  let st = { consecutiveFailures: 2, consecutiveRaces: 0 } as { consecutiveFailures: number; consecutiveRaces?: number; haltedUntil?: number };
  const r = recordSendOutcomeV2(st, { ok: false, error: 'Reserves moved' }, 0, o);
  assert.deepEqual([r.halted, r.race, r.consecutiveFailures, r.consecutiveRaces], [false, true, 2, 1], 'a race never counts toward the 3-failure halt');
  const f = recordSendOutcomeV2(st, { ok: false, error: 'Timeout' }, 0, o);
  assert.deepEqual([f.halted, f.consecutiveFailures], [true, 3]);
  st = { consecutiveFailures: 0, consecutiveRaces: 9 };
  assert.equal(recordSendOutcomeV2(st, { ok: false, error: 'Reserves moved' }, 0, o).halted, true, 'its own, higher limit');
  assert.deepEqual(recordSendOutcomeV2({ consecutiveFailures: 0, consecutiveRaces: 10 }, { ok: true }, 0, o).recovered, true);
});

test('M-3: two epochs and 120 s on the ledger clock; nothing new while a send is unresolved', () => {
  assert.deepEqual(txWindow(100, '2026-11-23T12:00:00.000Z', 120), { startEpoch: 100, endEpoch: 102, expiresAt: Date.parse('2026-11-23T12:00:00Z') / 1000 + 120 });
  assert.throws(() => txWindow(1, 'nope', 120));
  const p = { txid: 't', type: 'set_operator_paused(true)', at: 0, expiresAt: 1000 };
  assert.equal(pendingGate(undefined, 5000), 'none');
  assert.equal(pendingGate(p, 1000), 'wait');
  assert.equal(pendingGate(p, 1029), 'wait');
  assert.equal(pendingGate(p, 1030), 'expired');
});

test('M-4: quotes take the Gateway ledger time; a lagging Gateway fails every quote', () => {
  const q = [{ venue: 'a', at: 5, error: undefined as string | undefined }, { venue: 'b', at: 5, error: 'x' }];
  const ok = stampLedgerTime(q, 990_000, 1_000_000, 120_000);
  assert.deepEqual([ok.lagging, ok.quotes[0]!.at, ok.quotes[1]!.error], [false, 990_000, 'x']);
  const lag = stampLedgerTime(q, 800_000, 1_000_000, 120_000);
  assert.equal(lag.lagging, true);
  assert.match(lag.quotes[0]!.error!, /lagging: ledger 200 s behind/);
});

test('M-5: heartbeat verdicts', () => {
  const b = { program: 'owner-pool-bot', network: 'stokenet', pool: 'p', pid: 1, at: 1_000_000, tick: 3, ok: true };
  assert.equal(heartbeatVerdict(JSON.stringify(b), 1_100_000, 300_000).alive, true);
  assert.match(heartbeatVerdict(JSON.stringify(b), 1_400_001, 300_000).reason, /last beat 400 s ago/);
  assert.equal(heartbeatVerdict(undefined, 0, 1).alive, false);
  assert.equal(heartbeatVerdict('{bad', 0, 1).alive, false);
});

test('L-4: the target depth is re-read after the owner changes the reserves', () => {
  const first = targetDepthUpdate({ reserveA: 100, reserveB: 1, stateVersion: 10 });
  assert.deepEqual(first, { depth: 10, afterStateVersion: 10, reset: true });
  assert.deepEqual(targetDepthUpdate({ saved: first, ownerChangeStateVersion: 9, reserveA: 400, reserveB: 1, stateVersion: 20 }).depth, 10, 'older owner change: kept');
  assert.deepEqual(targetDepthUpdate({ saved: first, ownerChangeStateVersion: 15, reserveA: 400, reserveB: 1, stateVersion: 20 }), { depth: 20, afterStateVersion: 20, reset: true });
  assert.equal(targetDepthUpdate({ configured: 7, saved: first, reserveA: 400, reserveB: 1, stateVersion: 20 }).depth, 7);
});

test('L-5: the 24 h spend limit follows the window', () => {
  assert.equal(spend24hBudgets(144, 300), 3);
  assert.equal(spend24hBudgets(72, 600), 3);
  assert.equal(spend24hBudgets(72, 300), 5);
  assert.equal(spend24hBudgets(0, 300), 1);
});

test('H-4: the bot fee rule bounds, and a move away from the reference', () => {
  const base = { baseFeeBps: 50, volMultiplier: 2, volBps: 5, behindFeeBps: 10, singleVenueAddBps: 50, disagreeing: false, minFeeBps: 50, maxFeeBps: 150, marginBps: 10 };
  assert.deepEqual(botFeeBounds(base), { lo: 50, hi: 140 }, '50 + 2 x 5 x 2 + 10 + 50 + 10');
  assert.deepEqual(botFeeBounds({ ...base, disagreeing: true }), { lo: 50, hi: 150 });
  assert.deepEqual(botFeeBounds({ ...base, minFeeBps: 10, baseFeeBps: 100, volBps: 0, maxFeeBps: 400 }), { lo: 90, hi: 170 });
  // Pool 1.00, reference 1.02: toward is fine, away is flagged; within tolerance is not.
  assert.equal(moveAwayFromReference(1.0, 1.01, [1.02], 10)!.away, false);
  assert.equal(moveAwayFromReference(1.0, 0.99, [1.02], 10)!.away, true);
  assert.equal(moveAwayFromReference(1.0, 0.9995, [1.02], 10)!.away, false, 'inside the tolerance');
  // Away from the current reading but toward the median the bot may be following: not flagged.
  assert.equal(moveAwayFromReference(1.0, 0.995, [1.02, 0.99], 10)!.away, false);
  assert.equal(moveAwayFromReference(1.0, 1.01, [], 10), undefined);
});

test('L-4: the owner\'s reserve changes are found in the event stream (liquidity, owner rebalance; not operator moves)', async () => {
  const { lastOwnerReserveChange } = await import('../src/index.ts');
  const t = (sv: number, events: any[]) => ({ txid: `t${sv}`, stateVersion: sv, at: 0, methods: [], resources: [], events });
  const reb = (byOwner: boolean) => ({ name: 'OwnerPoolRebalanceEvent', amountA: '1', amountB: '0', reserveA: '1', reserveB: '1', inventoryA: '0', inventoryB: '0', cost: '0', allowance: '0', byOwner });
  assert.equal(lastOwnerReserveChange([t(1, [reb(false)])]), undefined);
  assert.equal(lastOwnerReserveChange([t(1, [{ name: 'OwnerPoolLiquidityEvent', reserveA: '1', reserveB: '1' }]), t(5, [reb(true)]), t(7, [reb(false)])]), 5);
});

test('CoinGecko brake: warm-up uses the 15% alarm; then 2% from the 24 h median ratio; episodes; outages', async () => {
  const { coingeckoBrake } = await import('../src/index.ts');
  const M = 60_000;
  let st: any;
  // Warm-up: 10% apart does not brake, 16% does.
  let r = coingeckoBrake(undefined, { reference: 1.10, coingecko: { price: 1, at: 0 }, now: 0 });
  assert.deepEqual([r.mode, r.braking, r.threshold], ['warmup', false, 0.15]);
  r = coingeckoBrake(r.state, { reference: 1.16, coingecko: { price: 1, at: 1 }, now: 1 });
  assert.deepEqual([r.braking, r.started, r.state.ratios.length], [true, true, 1], 'sampled at most once per 5 min');
  // Fill the normal: 12 readings at ratio 1.04 (a steady 4% premium is learned, not braked).
  st = { ratios: [] };
  for (let i = 0; i < 12; i++) st = coingeckoBrake(st, { reference: 1.04, coingecko: { price: 1, at: i * 5 * M }, now: i * 5 * M }).state;
  const t = 60 * M;
  r = coingeckoBrake(st, { reference: 1.05, coingecko: { price: 1, at: t }, now: t });
  assert.deepEqual([r.mode, r.braking, Number(r.normal!.toFixed(4))], ['normal', false, 1.04], '1% from the normal');
  r = coingeckoBrake(st, { reference: 1.07, coingecko: { price: 1, at: t }, now: t });
  assert.deepEqual([r.braking, r.started], [true, true], '2.9% from the normal');
  const r2 = coingeckoBrake(r.state, { reference: 1.07, coingecko: { price: 1, at: t + M }, now: t + M });
  assert.deepEqual([r2.braking, r2.started], [true, false], 'one alert per episode');
  const r3 = coingeckoBrake(r2.state, { reference: 1.041, coingecko: { price: 1, at: t + 2 * M }, now: t + 2 * M });
  assert.deepEqual([r3.braking, r3.ended], [false, true]);
  // CoinGecko down or stale: no brake, an episode ends, alert only after an hour.
  const u = coingeckoBrake(r2.state, { reference: 1.2, coingecko: { price: NaN, at: 0, error: 'HTTP 429' }, now: t + 3 * M });
  assert.deepEqual([u.mode, u.braking, u.ended, u.unavailableLong], ['unavailable', false, true, false]);
  const stale = coingeckoBrake(u.state, { reference: 1.2, coingecko: { price: 1, at: t }, now: t + 3 * M + 61 * M });
  assert.deepEqual([stale.mode, stale.unavailableLong], ['unavailable', true]);
  // No healthy reference: nothing recorded.
  const n = coingeckoBrake(st, { coingecko: { price: 1, at: t }, now: t });
  assert.deepEqual([n.mode, n.braking, n.state.ratios.length], ['no-reference', false, 12]);
});

test('CoinGecko brake: only a move AWAY from parity brakes (owner, 23 Nov 2026); toward parity never does', async () => {
  const { coingeckoBrake } = await import('../src/index.ts');
  const M = 60_000;
  // A warm state whose normal (median of 12) is `n`, then one tick at ratio `r` (CoinGecko 1, reference r).
  const at = (n: number, r: number, c: any = {}) => {
    let st: any = { ratios: [] };
    for (let i = 0; i < 12; i++) st = coingeckoBrake(st, { reference: n, coingecko: { price: 1, at: i * 5 * M }, now: i * 5 * M }, c).state;
    const t = 60 * M;
    return coingeckoBrake(st, { reference: r, coingecko: { price: 1, at: t }, now: t }, c);
  };
  const f = (x: { braking: boolean; normal?: number; excess?: number; deviation?: number }) => [x.braking, Number(x.normal!.toFixed(6))];
  // The live numbers of 23 Nov: 2.15% from the normal 0.956296, but toward parity: no brake (the old rule braked).
  const live = at(0.956296, 0.976877);
  assert.deepEqual(f(live), [false, 0.956296]);
  assert.ok(live.deviation! > 0.02 && live.excess! < 0, `deviation ${live.deviation} excess ${live.excess}`);
  // Toward parity, from either side, however far: no brake.
  for (const [n, r] of [[0.9, 0.99], [0.9, 1], [1.1, 1.01], [1.1, 1.0], [1.04, 1.0001]] as [number, number][]) assert.equal(at(n, r).braking, false, `${n} -> ${r}`);
  // Away from parity beyond the limit: brake (below and above parity).
  for (const [n, r] of [[0.96, 0.93], [1.04, 1.07], [1, 0.97], [1, 1.03]] as [number, number][]) {
    const x = at(n, r);
    assert.deepEqual([x.braking, x.started], [true, true], `${n} -> ${r}`);
    assert.ok(x.deviation! > 0.02, 'a brake implies the old condition too');
  }
  // Away within the limit: no brake (F(0.94)/F(0.96) = 1.0213 > 1.02 brakes; F(0.945)/F(0.96) = 1.0159 does not).
  assert.equal(at(0.96, 0.945).braking, false);
  assert.equal(at(1.04, 1.055).braking, false);
  assert.equal(at(0.96, 0.94).braking, true);
  // Crossing parity: brakes only if it ends further from parity, on the other side, than the normal by > the limit.
  // Below -> above: normal 0.956 (F 1.046); 1.05 is 0.4% further: no brake; 1.075 is 2.8% further: brake.
  assert.equal(at(0.956, 1.05).braking, false);
  assert.ok(at(0.956, 1.05).deviation! > 0.09, 'far from the normal, yet not braked');
  assert.equal(at(0.956, 1.075).braking, true);
  // Above -> below: normal 1.04; 0.95 (F 1.0526) is 1.2% further: no brake; 0.92 (F 1.087) is 4.5% further: brake.
  assert.equal(at(1.04, 0.95).braking, false);
  assert.equal(at(1.04, 0.92).braking, true);
  // An episode that turns toward parity ends (and one alert per episode still holds).
  const b1 = at(0.96, 0.93);
  const b2 = coingeckoBrake(b1.state, { reference: 0.925, coingecko: { price: 1, at: 61 * M }, now: 61 * M });
  assert.deepEqual([b2.braking, b2.started], [true, false]);
  const b3 = coingeckoBrake(b2.state, { reference: 0.95, coingecko: { price: 1, at: 62 * M }, now: 62 * M });
  assert.deepEqual([b3.braking, b3.ended], [false, true]);
  // Warm-up: the normal is parity, so the rule is the old 15% alarm, both sides.
  assert.equal(coingeckoBrake(undefined, { reference: 0.86, coingecko: { price: 1, at: 0 }, now: 0 }).braking, true);
  assert.equal(coingeckoBrake(undefined, { reference: 0.88, coingecko: { price: 1, at: 0 }, now: 0 }).braking, false);
});

test('CoinGecko is never a price: the brake returns no price, and the bot builds its target and history only from the venues', async () => {
  const { coingeckoBrake } = await import('../src/index.ts');
  const a = coingeckoBrake(undefined, { reference: 1, coingecko: { price: 1.01, at: 0 }, now: 0 });
  const b = coingeckoBrake(undefined, { reference: 1, coingecko: { price: 0.995, at: 0 }, now: 0 });
  // Whatever CoinGecko says, the only outputs that reach a decision are booleans.
  for (const x of [a, b]) assert.deepEqual(Object.keys(x).sort(), ['braking', 'deviation', 'ended', 'excess', 'mode', 'normal', 'ratio', 'readings', 'started', 'state', 'threshold', 'unavailableLong']);
  // The bot's source: the target, the history and the rebalance never take a watch (CoinGecko) value.
  const src = readFileSync(new URL('../../../scripts/owner-pool-bot.ts', import.meta.url), 'utf8');
  const lines = (re: RegExp) => src.split('\n').filter((l) => re.test(l));
  for (const l of [...lines(/poolTargetPrice\(/), ...lines(/history\.push\(/), ...lines(/decideRebalance\(/)]) assert.doesNotMatch(l, /watch|coingecko|cg\b|brake/i, l);
  assert.equal(lines(/history\.push\(/).length, 1);
  assert.match(lines(/history\.push\(/)[0]!, /price: ref\.price/);
});
