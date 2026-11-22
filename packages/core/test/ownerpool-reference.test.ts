// The OwnerPool bot's on-ledger venue reference and the rules added with it (packages/core/src/ownerpool-bot.ts):
// fee-free midpoints, depth weighting, dropped venues, the 4% hold-and-widen, a lasting disagreement
// pausing, CoinGecko as watch only, the rolling spend cap, fee clamping, and the failure paths the bot
// script builds on (halt after 3 failed sends, a failing tick, the owner restating the anchor, "behind").
// Venue figures are the mainnet XRD/hUSDC quotes measured on 22 Nov 2026 at 1,000 XRD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertSink, Decimal, NETWORKS, OWNER_POOL_BOT_DEFAULTS as D, aggregateVenues, behindUpdate, calibrateScale, decideRebalance, feeDecision, feeTargetDetail,
  pauseDecision, readVenue, recordSendOutcome, resolveOwnerAnchor, sendHalted, tickOutcome, watchPriceCheck, windowSpendRoom,
  type OwnerPoolState, type PauseState, type RebalanceConfig, type VenueQuote,
} from '../src/index.ts';

const NOW = Date.parse('2026-11-22T20:10:00Z');
// The 1% venue-fee rule is OFF in this file (maxVenueFee 1) so these tests keep exercising the weighting with
// all three live venues; the fee rule has its own tests in ownerpool-venue-rules.test.ts.
const o = { minVenues: D.minVenues, maxAgeMs: D.maxSourceAgeSec * 1000, maxDisagreement: D.maxDisagreement, maxRoundTrip: D.maxRoundTrip, minImpactBps: D.minImpactBps, maxVenueFee: 1 };
const near = (a: number, b: number, tol: number, m = '') => assert.ok(Math.abs(a - b) <= tol, `${m} ${a} not within ${tol} of ${b}`);

/** Real quotes, 22 Nov 2026 20:09 UTC, 1,000 XRD (small = 100 XRD). */
const OCI: VenueQuote = { venue: 'ociswap', at: NOW, sizeA: 1000, smallA: 100, bid: 0.00077638, ask: 0.000827085, bidSmall: 0.00077721, askSmall: 0.000826226 };
const OCIP: VenueQuote = { venue: 'ociswap-precision', at: NOW, sizeA: 1000, smallA: 100, bid: 0.000820563, ask: 0.000832241, bidSmall: 0.00082544, askSmall: 0.000827376 };
const C9: VenueQuote = { venue: 'caviarnine', at: NOW, sizeA: 1000, smallA: 100, bid: 0.000824637, ask: 0.000826222, bidSmall: 0.00082475, askSmall: 0.000826113 };
const DFP: VenueQuote = { venue: 'defiplaza', at: NOW, sizeA: 1000, smallA: 100, bid: 0.000769007, ask: 0.000963665, bidSmall: 0.0007694, askSmall: 0.000962896 };
/** A synthetic constant-product venue: reserve R of A at mid price p, proportional fee f. */
function cp(venue: string, p: number, R: number, f: number, size = 1000, small = 100, at = NOW): VenueQuote {
  const bidAt = (q: number) => p * (1 - f) * R / (R + q * (1 - f)); // B out per A in
  const askAt = (q: number) => p / (1 - f) * R / (R - q); // B in per A out
  return { venue, at, sizeA: size, smallA: small, bid: bidAt(size), ask: askAt(size), bidSmall: bidAt(small), askSmall: askAt(small) };
}

test('venue: the midpoint is fee-free; the impact (small vs quote size) is fee-free; depth = size / impact', () => {
  // Constant product, 3% fee, 800k XRD at 0.0008: the geometric mean of bid and ask is the curve mid whatever the fee.
  for (const f of [0, 0.0005, 0.03]) {
    const r = readVenue(cp('x', 0.0008, 800_000, f), D.minImpactBps / 10_000);
    // (to within the fee x impact cross term: 0.2 bps here)
    near(r.mid, 0.0008, 0.0008 * 3e-5, `fee ${f}`);
    // Impact of 900 more XRD against 800k: ~0.1125%, whatever the fee (an input fee only shrinks what reaches
    // the curve, by its own share: 1.5% less impact at 3%); depth ~ the reserve.
    near(r.impact, 900 / 800_000, (900 / 800_000) * 0.02, `fee ${f}`);
    near(r.depth, 1000 / (900 / 800_000), 20_000, `fee ${f}`);
    assert.ok(r.roundTrip >= 2 * f, 'the round trip includes both fees');
  }
  // The real Ociswap basic pool (3% fee): mid 0.000801, round trip 6.5%, depth ~950k XRD.
  const r = readVenue(OCI, 0.001);
  near(r.mid, 0.000801332, 1e-9);
  near(r.roundTrip, 0.0653, 0.0001);
  near(r.depth, 948_457, 1000);
  // CaviarNine: 1.3 bps impact, floored at 10 bps: depth = 1,000 / 0.001 = 1,000,000 (one quote cannot show more).
  assert.equal(readVenue(C9, 0.001).depth, 1_000_000);
});

test('reference: depth-weighted geometric mean of live venues; DefiPlaza (25% round trip) dropped', () => {
  const r = aggregateVenues([OCI, OCIP, C9, DFP], NOW, o);
  assert.equal(r.status, 'ok');
  assert.equal(r.live, 3);
  const w = Object.fromEntries(r.venues.map((v) => [v.venue, v.weight]));
  near(w.ociswap!, 0.4479, 0.0005);
  near(w['ociswap-precision']!, 0.0799, 0.0005);
  near(w.caviarnine!, 0.4722, 0.0005);
  assert.equal(w.defiplaza, undefined);
  assert.match(r.venues.find((v) => v.venue === 'defiplaza')!.dropped!, /round trip 25\.\d+% > 10\.0%/);
  near(r.price!, 0.000814623, 2e-9);
  near(r.disagreement!, 0.03126, 0.0001);
  // Weights: a venue twice as deep counts twice as much (geometric mean of the mids).
  const two = aggregateVenues([cp('a', 0.0008, 400_000, 0.003), cp('b', 0.00082, 800_000, 0.003)], NOW, o);
  near(Math.log(two.price! / 0.0008) / Math.log(0.00082 / 0.0008), 2 / 3, 0.002);
});

test('reference: failed, stale, future and unusable quotes are dropped; none live = no reference; one live is flagged', () => {
  const bad: VenueQuote = { ...C9, error: 'preview failed selling 1000 XRD: InsufficientBalance' };
  const stale: VenueQuote = { ...OCIP, at: NOW - 301_000 };
  const future: VenueQuote = { ...OCIP, venue: 'f', at: NOW + 61_000 };
  const nan: VenueQuote = { ...OCIP, venue: 'n', bid: NaN };
  const r = aggregateVenues([OCI, bad, stale, future, nan], NOW, o);
  assert.equal(r.status, 'ok');
  assert.equal(r.live, 1);
  assert.match(r.reason, /ONLY ONE live venue/);
  near(r.price!, 0.000801332, 1e-9);
  assert.deepEqual(r.venues.map((v) => v.dropped && v.dropped.split(' ')[0]), [undefined, 'preview', 'stale', 'stale', 'quotes']);
  const none = aggregateVenues([bad, stale], NOW, o);
  assert.equal(none.status, 'none');
  assert.equal(none.price, undefined);
  assert.equal(aggregateVenues([OCI], NOW, { ...o, minVenues: 2 }).status, 'none', 'minVenues is configurable');
  // Ask below bid is nonsense, not a reference.
  assert.match(aggregateVenues([{ ...OCI, ask: OCI.bid * 0.99 }], NOW, o).venues[0]!.dropped!, /ask below bid/);
});

test('reference: venues more than 4% apart = disagree (price reported, never a target); 4% exactly is fine', () => {
  const flat = (venue: string, p: number): VenueQuote => ({ venue, at: NOW, sizeA: 1, smallA: 0.1, bid: p, ask: p, bidSmall: p, askSmall: p });
  const a = flat('a', 0.0008), b = flat('b', 0.0008 * 1.04), c = flat('c', 0.0008 * 1.0401);
  assert.equal(aggregateVenues([a, b], NOW, o).status, 'ok');
  const d = aggregateVenues([a, c], NOW, o);
  assert.equal(d.status, 'disagree');
  assert.ok(d.price! > 0);
  assert.match(d.reason, /disagree by 4\.01% \(bound 4\.0%\): hold and widen/);
  // A disagreeing venue dropped for its round trip no longer counts toward the disagreement.
  assert.equal(aggregateVenues([OCIP, C9, DFP], NOW, o).status, 'ok');
  assert.equal(aggregateVenues([OCIP, C9, DFP], NOW, { ...o, maxRoundTrip: 0.3 }).status, 'disagree');
});

test('hold and widen: while the venues disagree the fee rises by half the disagreement, clamped to the operator range', () => {
  const c = { baseFeeBps: 100, volMultiplier: 2, behindFeeBps: 10, disagreeFeeFactor: 0.5 };
  // Mainnet-like range 50-200: 5% disagreement adds 250 bps: clamped at 200.
  assert.deepEqual(feeTargetDetail({ volBps: 0, behind: false, disagreement: 0.05, minFeeBps: 50, maxFeeBps: 200, cfg: c }), { feeBps: 200, rawBps: 350, clamped: 'max' });
  assert.deepEqual(feeTargetDetail({ volBps: 0, behind: false, disagreement: 0.01, minFeeBps: 50, maxFeeBps: 200, cfg: c }), { feeBps: 150, rawBps: 150, clamped: null });
  // No disagreement: base 100 (+ volatility, + behind).
  assert.deepEqual(feeTargetDetail({ volBps: 5, behind: true, minFeeBps: 50, maxFeeBps: 200, cfg: c }), { feeBps: 120, rawBps: 120, clamped: null });
  // Stokenet range 10-100: base 100 already sits at the top.
  assert.deepEqual(feeTargetDetail({ volBps: 0, behind: false, minFeeBps: 10, maxFeeBps: 100, cfg: c }), { feeBps: 100, rawBps: 100, clamped: null });
  assert.equal(feeTargetDetail({ volBps: 10, behind: true, disagreement: 0.05, minFeeBps: 10, maxFeeBps: 100, cfg: c }).clamped, 'max');
  // Disagreement only counts when given (the bot passes it only while holding).
  assert.equal(D.baseFeeBps, 100);
  assert.equal(D.maxDisagreement, 0.04);
});

test('fee clamp: once at the clamped target nothing more is attempted; a failed change is not retried at once', () => {
  const cfg = { minFeeChangeBps: 5, widenIntervalMs: 120_000, narrowIntervalMs: 900_000 };
  const rng = { minFeeBps: 10, maxFeeBps: 100 };
  // 30 -> 100 (clamped) once; then the fee IS the target, on every later tick.
  const first = feeDecision({ currentFeeBps: 30, targetFeeBps: 100, now: NOW, ...rng, cfg });
  assert.deepEqual(first.action, 'set');
  for (let i = 1; i < 30; i++) assert.equal(feeDecision({ currentFeeBps: 100, targetFeeBps: 100, lastChangeAt: NOW, now: NOW + i * 60_000, ...rng, cfg }).action, 'none');
  // A failed attempt (preview refused, or a failed send) at fee 100 waits narrowIntervalMs before the same target again.
  const lastFailure = { feeBps: 100, at: NOW };
  const held = feeDecision({ currentFeeBps: 30, targetFeeBps: 100, now: NOW + 60_000, ...rng, cfg, lastFailure });
  assert.equal(held.action, 'none');
  assert.match(held.reason, /failed 60 s ago: not retried/);
  assert.equal(feeDecision({ currentFeeBps: 30, targetFeeBps: 100, now: NOW + 900_000, ...rng, cfg, lastFailure }).action, 'set');
  assert.equal(feeDecision({ currentFeeBps: 30, targetFeeBps: 90, now: NOW + 60_000, ...rng, cfg, lastFailure }).action, 'set', 'another target is tried');
});

test('lasting disagreement pauses after 10 min; resume only after 15 min healthy, only a pause the bot set', () => {
  const base = { pauseAfterMs: D.pauseAfterSec * 1000, resumeAfterMs: D.resumeAfterSec * 1000, ownerPaused: false, anchorOk: true };
  // healthy = (status === 'ok'); a disagreement is unhealthy.
  const healthy = (q: VenueQuote[]) => aggregateVenues(q, NOW, o).status === 'ok';
  const apart = [cp('a', 0.0008, 8e5, 0.003), cp('b', 0.00085, 8e5, 0.003)];
  const together = [cp('a', 0.0008, 8e5, 0.003), cp('b', 0.00081, 8e5, 0.003)];
  let st: PauseState = { pausedByBot: false };
  let r = pauseDecision({ ...base, now: 0, healthy: healthy(apart), operatorPaused: false, state: st });
  assert.equal(r.action, 'none');
  r = pauseDecision({ ...base, now: 540_000, healthy: healthy(apart), operatorPaused: false, state: r.state });
  assert.equal(r.action, 'none', 'nine minutes: hold, no pause');
  r = pauseDecision({ ...base, now: 600_000, healthy: healthy(apart), operatorPaused: false, state: r.state });
  assert.equal(r.action, 'pause');
  st = r.state;
  r = pauseDecision({ ...base, now: 700_000, healthy: healthy(together), operatorPaused: true, state: st });
  assert.equal(r.action, 'none');
  r = pauseDecision({ ...base, now: 1_600_000, healthy: healthy(together), operatorPaused: true, state: r.state });
  assert.equal(r.action, 'unpause');
  // A disagreement that clears inside the ten minutes never pauses.
  let s2 = pauseDecision({ ...base, now: 0, healthy: false, operatorPaused: false, state: { pausedByBot: false } }).state;
  s2 = pauseDecision({ ...base, now: 300_000, healthy: true, operatorPaused: false, state: s2 }).state;
  assert.equal(pauseDecision({ ...base, now: 700_000, healthy: false, operatorPaused: false, state: s2 }).action, 'none');
  // Someone else's pause is left alone.
  assert.equal(pauseDecision({ ...base, resumeAfterMs: 0, now: 0, healthy: true, operatorPaused: true, state: { pausedByBot: false } }).action, 'none');
});

test('CoinGecko is watch only: it alarms beyond 15% and never enters the reference', () => {
  assert.deepEqual(watchPriceCheck(0.000815, 0.000802, 0.15).alarm, false);
  const far = watchPriceCheck(0.000815, 0.000690, 0.15);
  assert.equal(far.alarm, true);
  near(far.deviation!, 0.181, 0.001);
  assert.equal(watchPriceCheck(undefined, 0.0008, 0.15).alarm, false, 'no reference, nothing to compare');
  assert.equal(watchPriceCheck(0.0008, NaN, 0.15).alarm, false);
  // The reference is a function of the venue quotes only: there is no way to pass it a watch price.
  assert.equal(aggregateVenues.length, 3);
  const r1 = aggregateVenues([OCI, OCIP, C9], NOW, o);
  const r2 = aggregateVenues([OCI, OCIP, C9], NOW, o);
  assert.deepEqual(r1.price, r2.price);
  assert.equal(D.coingeckoMaxDeviation, 0.15);
});

/** The split pool at 20,000 XRD / 16 TEUR (budget 0.03 per 72 epochs), as in ownerpool-bot.test.ts. */
const EPOCH = 25_000;
function pool(o2: { allowance?: string; allowanceEpoch?: number } = {}): OwnerPoolState {
  return {
    address: 'component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk', packageAddress: 'package_tdx_2_1x', resourceA: NETWORKS.stokenet.xrd, resourceB: 'resource_teur',
    divisibilityA: 18, divisibilityB: 6, reserveA: '20000', reserveB: '16', feeBps: 100, paused: false,
    split: {
      ownerPaused: false, operatorPaused: false, inventoryA: '1000', inventoryB: '0.8', ownerBadge: 'resource_owner', operator: 'resource_op',
      limits: { moveBudgetBps: 300, windowEpochs: 72, maxReserveA: '22000', maxReserveB: '17.6', minReserveA: '10000', minReserveB: '8', minFeeBps: 10, maxFeeBps: 100 },
      allowance: o2.allowance ?? '0.03', allowanceEpoch: o2.allowanceEpoch ?? EPOCH, anchor: ['1250', '1'],
    },
  };
}
const rcfg = (x: Partial<RebalanceConfig> = {}): RebalanceConfig => ({ deadBandBps: D.deadBandBps, spendFraction: D.spendFraction, reserveFraction: D.reserveFraction, minMoveBps: D.minMoveBps, side: 'remove', ...x });

test('rolling spend cap: at most 60% of the allowance in any 10 minutes; the soak\'s "half, then half" is capped', () => {
  const w = { windowMs: 600_000, maxShare: 0.6 };
  // Nothing spent: 60% of what is there.
  near(windowSpendRoom([], 0.014964, NOW, w).room, 0.6 * 0.014964, 1e-12);
  // The soak: 0.007482 spent at 18:58 (half of 0.014964), 0.007482 left. Next move at most 0.6 * 0.014964 - 0.007482 = 0.0014964 (was 0.003949).
  const after = windowSpendRoom([{ at: NOW - 60_000, cost: 0.007482 }], 0.007482, NOW, w);
  near(after.room, 0.0014964, 1e-9);
  assert.equal(after.spentInWindow, 0.007482);
  // Once the window has passed, the old spend no longer counts.
  near(windowSpendRoom([{ at: NOW - 600_000, cost: 0.007482 }], 0.007482, NOW, w).room, 0.6 * 0.007482, 1e-12);
  // Spent past the cap: zero room, never negative.
  assert.equal(windowSpendRoom([{ at: NOW - 1000, cost: 0.01 }], 0.001, NOW, w).room, 0);
  // decideRebalance obeys it: a 2% gap with the full 0.03 allowance would spend 0.015; capped at 0.004 it spends <= 0.004.
  const d = decideRebalance(pool(), EPOCH, 0.0008 * 1.02, rcfg({ spendCap: 0.004 }));
  assert.ok(d.action === 'rebalance' && d.clipped && new Decimal(d.plan.cost).lte('0.004') && new Decimal(d.plan.cost).gt('0.0039'));
  const z = decideRebalance(pool(), EPOCH, 0.0008 * 1.02, rcfg({ spendCap: 0 }));
  assert.ok(z.action === 'none' && z.behind && /rolling spend cap reached/.test(z.reason));
  // A cap above the half-allowance changes nothing.
  const u = decideRebalance(pool(), EPOCH, 0.0008 * 1.02, rcfg({ spendCap: 1 }));
  assert.ok(u.action === 'rebalance' && u.spendable === '0.015');
  assert.equal(D.maxWindowSpendShare, 0.6);
  assert.equal(D.spendWindowSec, 600);
});

test('failure path: three failed sends in a row halt sending for an hour; a success in between resets', () => {
  const oo = { maxFailures: 3, haltMs: 3_600_000 };
  let st: { consecutiveFailures: number; haltedUntil?: number } = { consecutiveFailures: 0 };
  st = recordSendOutcome(st, false, NOW, oo);
  st = recordSendOutcome(st, false, NOW, oo);
  assert.equal(sendHalted(st, NOW), false);
  st = recordSendOutcome(st, true, NOW, oo);
  assert.equal(st.consecutiveFailures, 0);
  st = recordSendOutcome(st, false, NOW, oo);
  st = recordSendOutcome(st, false, NOW, oo);
  const h = recordSendOutcome(st, false, NOW, oo);
  assert.equal(h.halted, true);
  assert.equal(h.haltedUntil, NOW + 3_600_000);
  assert.equal(sendHalted(h, NOW + 3_599_999), true);
  assert.equal(sendHalted(h, NOW + 3_600_000), false);
});

test('failure path: a Gateway outage fails the tick (nothing sent), alerts at the third in a row, backs off to 15 min', () => {
  const oo = { intervalMs: 60_000, alertTicks: 3 };
  let e = 0;
  const seen: { alert: boolean; delayMs: number }[] = [];
  for (let i = 0; i < 6; i++) { const r = tickOutcome(e, true, oo); e = r.errors; seen.push({ alert: r.alert, delayMs: r.delayMs }); }
  assert.deepEqual(seen.map((x) => x.alert), [false, false, true, true, true, true]);
  assert.deepEqual(seen.map((x) => x.delayMs / 1000), [120, 240, 480, 900, 900, 900]);
  const ok = tickOutcome(e, false, oo);
  assert.deepEqual(ok, { errors: 0, alert: false, delayMs: 60_000 });
});

test('failure path: the owner restates the anchor mid-run: allowance zeroed, new anchor picked up at the recheck, scale recalibrated', () => {
  // Before: the ledger's statement 1250:1, calibrated against a reference of 0.000815.
  const before = resolveOwnerAnchor({ ledger: { anchor: ['1250', '1'], txid: 'tx1', stateVersion: 10, at: NOW }, ledgerComplete: true });
  assert.ok(before.source === 'ledger');
  const scale1 = calibrateScale(0.000815, before.anchor);
  // The owner restates 1200:1 (state_anchor zeroes the allowance at that epoch). The bot's next recheck reads it.
  const after = resolveOwnerAnchor({ ledger: { anchor: ['1200', '1'], txid: 'tx2', stateVersion: 20, at: NOW + 1 }, ledgerComplete: true, flag: ['1250', '1'] });
  assert.ok(after.source === 'ledger' && after.anchor[0] === '1200' && after.flagMismatch?.[0] === '1250', 'the ledger wins over a stale flag');
  const scale2 = calibrateScale(0.000815, after.anchor);
  near(scale2 / scale1, 1250 / 1200, 1e-12);
  // Zeroed allowance: no move (and "behind") until it refills; 36 epochs later half a budget is back.
  const z = decideRebalance(pool({ allowance: '0', allowanceEpoch: EPOCH }), EPOCH, 0.0008 * 1.01, rcfg());
  assert.ok(z.action === 'none' && z.behind && /allowance spent/.test(z.reason));
  assert.equal(decideRebalance(pool({ allowance: '0', allowanceEpoch: EPOCH }), EPOCH + 36, 0.0008 * 1.01, rcfg()).action, 'rebalance');
});

test('failure path: the "behind" alert fires at 10 ticks in a row and clears when caught up', () => {
  let t: number | undefined;
  const alerts: boolean[] = [];
  for (let i = 0; i < 11; i++) { const r = behindUpdate(t, true, 10); t = r.ticks; alerts.push(r.alert); }
  assert.deepEqual(alerts.map((a, i) => (a ? i + 1 : 0)).filter(Boolean), [10, 11]);
  const c = behindUpdate(t, false, 10);
  assert.deepEqual(c, { ticks: 0, alert: false, cleared: true });
});

test('alerts: start/stop (force) are never rate-limited; others still are', async () => {
  const bodies: string[] = [];
  const sink = new AlertSink('http://127.0.0.1:1/topic', { intervalMs: 3_600_000, fetch: async (_u, init) => { bodies.push(init.body); return { ok: true, status: 200 }; } });
  for (let i = 0; i < 3; i++) assert.equal((await sink.alert('start', `start ${i}`, NOW + i * 1000, { force: true })).sent, true);
  assert.equal((await sink.alert('behind', 'b1', NOW)).sent, true);
  assert.equal((await sink.alert('behind', 'b2', NOW + 1000)).suppressed, true);
  assert.deepEqual(bodies, ['start 0', 'start 1', 'start 2', 'b1']);
});
