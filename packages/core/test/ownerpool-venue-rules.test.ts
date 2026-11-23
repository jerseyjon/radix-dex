// The owner's venue rules of 22 Nov 2026 (packages/core/src/ownerpool-bot.ts, docs/owner-pool-bot.md):
// (1) a venue whose own swap fee, estimated from its quotes, is over 1% is excluded; (2) when the set of
// live venues changes the bot holds its position for 15 minutes (restarting on another change, persisted
// across restarts; the fee may widen but not narrow meanwhile); and the start-up guard that the
// reference never contains the operated pool or any OwnerPool component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_POOL_BOT_DEFAULTS as D, aggregateVenues, feeDecision, referenceVenueProblems, venueFee, venueSetHold, venueHoldAlert, AlertLimiter,
  type VenueHoldState, type VenueQuote,
} from '../src/index.ts';

const NOW = Date.parse('2026-11-22T20:10:00Z');
const o = { minVenues: D.minVenues, maxAgeMs: D.maxSourceAgeSec * 1000, maxDisagreement: D.maxDisagreement, maxRoundTrip: D.maxRoundTrip, minImpactBps: D.minImpactBps };
const near = (a: number, b: number, tol: number, m = '') => assert.ok(Math.abs(a - b) <= tol, `${m} ${a} not within ${tol} of ${b}`);

/** Real quotes, 22 Nov 2026 20:09 UTC, 1,000 XRD (small = 100 XRD), as in ownerpool-reference.test.ts. */
const OCI: VenueQuote = { venue: 'ociswap', at: NOW, sizeA: 1000, smallA: 100, bid: 0.00077638, ask: 0.000827085, bidSmall: 0.00077721, askSmall: 0.000826226 };
const OCIP: VenueQuote = { venue: 'ociswap-precision', at: NOW, sizeA: 1000, smallA: 100, bid: 0.000820563, ask: 0.000832241, bidSmall: 0.00082544, askSmall: 0.000827376 };
const C9: VenueQuote = { venue: 'caviarnine', at: NOW, sizeA: 1000, smallA: 100, bid: 0.000824637, ask: 0.000826222, bidSmall: 0.00082475, askSmall: 0.000826113 };
const DFP: VenueQuote = { venue: 'defiplaza', at: NOW, sizeA: 1000, smallA: 100, bid: 0.000769007, ask: 0.000963665, bidSmall: 0.0007694, askSmall: 0.000962896 };
/** Constant product: reserve R of A at mid p, proportional input fee f. */
function cp(venue: string, p: number, R: number, f: number, size = 1000, small = 100): VenueQuote {
  const bidAt = (q: number) => p * (1 - f) * R / (R + q * (1 - f));
  const askAt = (q: number) => p / (1 - f) * R / (R - q);
  return { venue, at: NOW, sizeA: size, smallA: small, bid: bidAt(size), ask: askAt(size), bidSmall: bidAt(small), askSmall: askAt(small) };
}
/** A pure proportional fee f around mid p, no impact at all. */
const pure = (venue: string, p: number, f: number): VenueQuote => ({ venue, at: NOW, sizeA: 1000, smallA: 100, bid: p * (1 - f), ask: p / (1 - f), bidSmall: p * (1 - f), askSmall: p / (1 - f) });

test('venue fee from the quotes: exact for a pure fee, impact removed for a curve, the real venues', () => {
  for (const f of [0, 0.0005, 0.003, 0.01, 0.03]) {
    near(venueFee(pure('x', 0.0008, f)), f, 1e-12, `pure ${f}`);
    // Constant product, 800k and 100k XRD deep: the impact is extrapolated away (to well under 1 bps).
    near(venueFee(cp('x', 0.0008, 800_000, f)), f, 2e-6, `cp 800k ${f}`);
    near(venueFee(cp('x', 0.0008, 100_000, f)), f, 1e-5, `cp 100k ${f}`);
  }
  // 22 Nov 2026: Ociswap basic 3.00% (input_fee_rate 0.03), precision 0.05%, CaviarNine 0.08%, DefiPlaza 10.6%.
  near(venueFee(OCI), 0.03, 0.0001);
  near(venueFee(OCIP), 0.0005, 0.0001);
  near(venueFee(C9), 0.0008, 0.0001);
  near(venueFee(DFP), 0.106, 0.001);
  assert.equal(venueFee({ ...C9, bidSmall: C9.bid, askSmall: C9.ask, bid: C9.bid * 0.999, ask: C9.ask * 1.02 }), 0, 'never negative');
  assert.equal(D.maxVenueFee, 0.01);
});

test('fee rule: above 1% excluded (with the reason), below kept, exactly 1% kept; configurable', () => {
  const r = aggregateVenues([OCI, OCIP, C9, DFP], NOW, o);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.venues.filter((v) => v.used).map((v) => v.venue), ['ociswap-precision', 'caviarnine']);
  assert.match(r.venues[0]!.dropped!, /^fee 3\.00\d% > 1\.00% \(estimated from its quotes\)$/);
  assert.match(r.venues[3]!.dropped!, /round trip/, 'DefiPlaza still fails the round-trip rule first');
  // The reference without Ociswap basic: the two that agree (0.12% apart on 22 Nov).
  near(r.disagreement!, 0.00119, 0.0001);
  near(r.price!, 0.000826, 0.000001);
  // Below, exactly at, just above 1%.
  const at = (f: number) => aggregateVenues([pure('v', 0.0008, f)], NOW, o).venues[0]!;
  assert.equal(at(0.0099).used, true);
  assert.equal(at(0.01).used, true, 'exactly 1% is kept');
  assert.equal(at(0.0101).used, false);
  assert.match(at(0.0101).dropped!, /fee 1\.010% > 1\.00%/);
  // Configurable: at 5% Ociswap basic is back.
  assert.equal(aggregateVenues([OCI, OCIP, C9], NOW, { ...o, maxVenueFee: 0.05 }).live, 3);
});

test('fee rule: no venue left = no reference (unhealthy: no trade)', () => {
  const r = aggregateVenues([OCI, DFP, pure('dear', 0.0008, 0.02)], NOW, o);
  assert.equal(r.status, 'none');
  assert.equal(r.price, undefined);
  assert.equal(r.live, 0);
  assert.match(r.reason, /only 0 live venue/);
});

test('test exclusion (--exclude-venues): the named venue is dropped and labelled TEST', () => {
  const r = aggregateVenues([OCIP, C9], NOW, { ...o, exclude: ['caviarnine'] });
  assert.equal(r.live, 1);
  assert.match(r.venues[1]!.dropped!, /excluded by --exclude-venues \(TEST\)/);
});

const HOLD = D.venueHoldSec * 1000;
test('venue-set hold: the first tick only records; a change starts a 15-minute hold; no change, no hold', () => {
  assert.equal(D.venueHoldSec, 900);
  const first = venueSetHold({}, ['caviarnine', 'ociswap-precision'], NOW, HOLD);
  assert.equal(first.changed, false);
  assert.equal(first.holding, false);
  assert.deepEqual(first.state.liveSet, ['caviarnine', 'ociswap-precision']);
  const same = venueSetHold(first.state, ['ociswap-precision', 'caviarnine'], NOW + 60_000, HOLD);
  assert.equal(same.changed, false, 'order does not matter');
  assert.equal(same.holding, false);
  // CaviarNine runs out of hUSDC (21:09 on 22 Nov): dropped.
  const drop = venueSetHold(same.state, ['ociswap-precision'], NOW + 120_000, HOLD);
  assert.equal(drop.changed, true);
  assert.equal(drop.started, true);
  assert.equal(drop.holding, true);
  assert.deepEqual(drop.removed, ['caviarnine']);
  assert.equal(drop.state.holdUntil, NOW + 120_000 + HOLD);
  assert.equal(drop.state.holdReason, 'dropped caviarnine');
  assert.equal(drop.remainingMs, HOLD);
  // A venue lost to the fee rule or the round-trip rule is simply not live: same thing. All gone counts too.
  assert.equal(venueSetHold(same.state, [], NOW + 120_000, HOLD).changed, true);
});

test('venue-set hold: blocks until it expires, restarts on another change, then trading resumes', () => {
  let st: VenueHoldState = venueSetHold({}, ['a', 'b'], NOW, HOLD).state;
  let h = venueSetHold(st, ['a'], NOW + 60_000, HOLD);
  st = h.state;
  const t0 = NOW + 60_000;
  // Ten minutes in: still holding.
  h = venueSetHold(st, ['a'], t0 + 600_000, HOLD);
  assert.equal(h.holding, true);
  assert.equal(h.started, false);
  st = h.state;
  // b comes back at 10 minutes: the hold restarts from then (not a NEW hold for the alert).
  h = venueSetHold(st, ['a', 'b'], t0 + 600_000 + 1, HOLD);
  assert.equal(h.changed, true);
  assert.equal(h.started, false, 'a restart is not a new hold start (one alert)');
  assert.deepEqual(h.added, ['b']);
  assert.equal(h.state.holdUntil, t0 + 600_001 + HOLD);
  st = h.state;
  // 15 minutes after the first change: still holding (it restarted).
  h = venueSetHold(st, ['a', 'b'], t0 + HOLD + 1000, HOLD);
  assert.equal(h.holding, true);
  st = h.state;
  // 15 minutes after the restart: expired, trading resumes; the hold fields are cleared.
  h = venueSetHold(st, ['a', 'b'], t0 + 600_001 + HOLD, HOLD);
  assert.equal(h.holding, false);
  assert.equal(h.expired, true);
  assert.equal(h.state.holdUntil, undefined);
  const after = venueSetHold(h.state, ['a', 'b'], t0 + 600_001 + HOLD + 60_000, HOLD);
  assert.equal(after.holding, false);
  assert.equal(after.expired, false);
});

test('venue-set hold: survives a state reload (JSON round trip), and a change while the bot was down starts one', () => {
  const st = venueSetHold(venueSetHold({}, ['a', 'b'], NOW, HOLD).state, ['b'], NOW + 60_000, HOLD).state;
  const reloaded: VenueHoldState = JSON.parse(JSON.stringify({ venueHold: st })).venueHold;
  const h = venueSetHold(reloaded, ['b'], NOW + 300_000, HOLD);
  assert.equal(h.holding, true, 'a restart does not skip the hold');
  assert.equal(h.remainingMs, NOW + 60_000 + HOLD - (NOW + 300_000));
  // Stopped with {a, b}; started again with only {a} live: that is a change.
  const down: VenueHoldState = JSON.parse(JSON.stringify(venueSetHold({}, ['a', 'b'], NOW, HOLD).state));
  const back = venueSetHold(down, ['a'], NOW + 3_600_000, HOLD);
  assert.equal(back.started, true);
  assert.equal(back.holding, true);
});

test('venue-set hold: the fee may widen but not narrow', () => {
  const cfg = { minFeeChangeBps: 5, widenIntervalMs: 120_000, narrowIntervalMs: 900_000 };
  const rng = { minFeeBps: 10, maxFeeBps: 200 };
  const noNarrow = 'venue-set hold (dropped caviarnine)';
  const n = feeDecision({ currentFeeBps: 150, targetFeeBps: 100, now: NOW, ...rng, cfg, noNarrow });
  assert.equal(n.action, 'none');
  assert.match(n.reason, /narrow to 100 bps held: venue-set hold/);
  assert.deepEqual(feeDecision({ currentFeeBps: 100, targetFeeBps: 150, now: NOW, ...rng, cfg, noNarrow }).action, 'set');
  assert.equal(feeDecision({ currentFeeBps: 150, targetFeeBps: 100, now: NOW, ...rng, cfg }).action, 'set', 'outside a hold it narrows');
});

test('guard: the reference may never contain the operated pool or any OwnerPool component', () => {
  const POOL = 'component_rdx1cqownpool0000000000000000000000000000000000000000000000';
  const OTHER_OP = 'component_rdx1cqdifd0000000000000000000000000000000000000000000000000';
  const OCI_ADDR = 'component_rdx1cpqg9y55tv8652k32cznhmu8rz3jgtw57vdg460ld2sy650zpfh5fr';
  const PKG = 'package_rdx1ownerpoolpkg';
  const details = [
    { address: OCI_ADDR, blueprint_name: 'BasicPool', package_address: 'package_rdx1oci' },
    { address: POOL, blueprint_name: 'OwnerPool', package_address: PKG },
    { address: OTHER_OP, blueprint_name: 'OwnerPool', package_address: PKG },
    { address: 'component_rdx1renamed', blueprint_name: 'Renamed', package_address: PKG },
  ];
  const run = (venues: { name: string; address: string }[]) => referenceVenueProblems({ operatedPool: POOL, venues, details, ownerPoolPackages: [PKG] });
  assert.deepEqual(run([{ name: 'ociswap', address: OCI_ADDR }]), []);
  assert.match(run([{ name: 'x', address: POOL }])[0]!, /IS the operated pool/);
  assert.match(run([{ name: 'difd', address: OTHER_OP }])[0]!, /is an OwnerPool component/);
  assert.match(run([{ name: 'y', address: 'component_rdx1renamed' }])[0]!, /component of OwnerPool package/);
  assert.match(run([{ name: 'z', address: 'component_rdx1unknown' }])[0]!, /no entity details/);
  assert.equal(run([{ name: 'ociswap', address: OCI_ADDR }, { name: 'difd', address: OTHER_OP }]).length, 1);
});

test('venue-set hold alerts: a drop starts the hold (venue-hold), the venue coming back restarts it and alerts too (venue-hold-restart), not suppressed by the drop alert', () => {
  const lim = new AlertLimiter(3600_000);
  const fire = (h: ReturnType<typeof venueSetHold>, at: number) => { const a = venueHoldAlert(h, D.venueHoldSec); return a && lim.allow(a.key, at) ? a : undefined; };
  const st0 = venueSetHold({}, ['a', 'b'], NOW, HOLD).state;
  const drop = venueSetHold(st0, ['a'], NOW + 60_000, HOLD);
  assert.equal(drop.started, true); assert.equal(drop.restarted, false);
  const a1 = fire(drop, NOW + 60_000);
  assert.equal(a1?.key, 'venue-hold');
  assert.match(a1!.text, /dropped b/);
  // Still holding, nothing changed: no alert.
  const same = venueSetHold(drop.state, ['a'], NOW + 120_000, HOLD);
  assert.equal(venueHoldAlert(same, D.venueHoldSec), undefined);
  // b comes back 2 min later: the hold restarts, and that is alerted under its own key.
  const back = venueSetHold(same.state, ['a', 'b'], NOW + 180_000, HOLD);
  assert.equal(back.started, false); assert.equal(back.restarted, true); assert.equal(back.holding, true);
  const a2 = fire(back, NOW + 180_000);
  assert.equal(a2?.key, 'venue-hold-restart');
  assert.match(a2!.text, /AGAIN \(back b\)/);
  // A second restart inside the alert interval is rate-limited like any other key.
  const again = venueSetHold(back.state, ['a'], NOW + 240_000, HOLD);
  assert.equal(again.restarted, true);
  assert.equal(fire(again, NOW + 240_000), undefined);
  // The hold ends; the caller clears both keys, so the next hold and its restart alert at once.
  const end = venueSetHold(again.state, ['a'], NOW + 240_000 + HOLD, HOLD);
  assert.equal(end.expired, true);
  lim.clear('venue-hold'); lim.clear('venue-hold-restart');
  const drop2 = venueSetHold(end.state, [], NOW + 300_000 + HOLD, HOLD);
  assert.equal(fire(drop2, NOW + 300_000 + HOLD)?.key, 'venue-hold');
  const back2 = venueSetHold(drop2.state, ['a'], NOW + 360_000 + HOLD, HOLD);
  assert.equal(fire(back2, NOW + 360_000 + HOLD)?.key, 'venue-hold-restart');
});
