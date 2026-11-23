import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreparedAction } from '../src/api.ts';
import { ago, canSign, fmtGap, gapTone, healthLabel, poolStatus, shortId } from '../src/pools.ts';

test('pool status in words', () => {
  assert.deepEqual(poolStatus({ paused: false, ownerPaused: false, operatorPaused: false }), { label: 'Open', tone: 'up' });
  assert.equal(poolStatus({ paused: true, ownerPaused: true, operatorPaused: false }).label, 'Paused by owner');
  assert.equal(poolStatus({ paused: true, ownerPaused: false, operatorPaused: true }).tone, 'warn');
  assert.equal(poolStatus({ paused: true, ownerPaused: true, operatorPaused: true }).label, 'Paused (owner and operator)');
});

test('gaps: bps when small, percent from 100 bps, tone by size', () => {
  assert.equal(fmtGap(-412.5), '-4.13%');
  assert.equal(fmtGap(38.2), '+38 bps');
  assert.equal(fmtGap(4.25), '+4.3 bps');
  assert.equal(fmtGap(0), '0.0 bps');
  assert.equal(fmtGap(null), '—');
  assert.equal(gapTone(-412), 'down');
  assert.equal(gapTone(60), 'warn');
  assert.equal(gapTone(10), '');
});

test('times ago and heartbeats', () => {
  const now = 10_000_000;
  assert.equal(ago(now - 12_000, now), '12 s ago');
  assert.equal(ago(now - 4 * 60_000, now), '4 min ago');
  assert.equal(ago(null, now), 'never');
  assert.deepEqual(healthLabel({ status: 'alive', lastSeen: now - 5_000, tick: 1, ok: true, note: null }, now), { label: 'alive, 5 s ago', tone: 'up' });
  assert.equal(healthLabel({ status: 'alive', lastSeen: now, tick: 1, ok: false, note: null }, now).tone, 'warn');
  assert.equal(healthLabel({ status: 'stale', lastSeen: now - 900_000, tick: 1, ok: true, note: null }, now).label, 'stale, last seen 15 min ago');
  assert.equal(healthLabel(undefined, now).tone, 'down');
  assert.equal(shortId('component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk'), 'component_tdx_…0a24qk');
});

test('a prepared action goes to the wallet only when it previewed, for the connected account, and is fresh', () => {
  const prepared = (ok: boolean) => ({ preview: { ok } } as PreparedAction);
  const base = { walletAccount: 'account_a', preparedFor: 'account_a', preparedAt: 1_000, now: 2_000 };
  assert.deepEqual(canSign({ ...base, prepared: prepared(true) }), { ok: true });
  assert.equal(canSign({ ...base, prepared: undefined }).ok, false);
  assert.match(canSign({ ...base, prepared: prepared(false) }).why!, /preview failed/);
  assert.match(canSign({ ...base, prepared: prepared(true), walletAccount: undefined }).why!, /Connect/);
  assert.match(canSign({ ...base, prepared: prepared(true), walletAccount: 'account_b' }).why!, /another account/);
  assert.match(canSign({ ...base, prepared: prepared(true), now: 200_000 }).why!, /two minutes/);
});
