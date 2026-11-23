// Pure helpers of the Pools page (tested in test/pools.test.ts).
import type { PoolRow, PreparedAction, ProcessHealth } from './api';

/** The pool's trading state in a word or three, and how loudly to show it. */
export function poolStatus(p: Pick<PoolRow, 'paused' | 'ownerPaused' | 'operatorPaused'>): { label: string; tone: 'up' | 'warn' | 'down' } {
  if (p.ownerPaused && p.operatorPaused) return { label: 'Paused (owner and operator)', tone: 'down' };
  if (p.ownerPaused) return { label: 'Paused by owner', tone: 'down' };
  if (p.operatorPaused) return { label: 'Paused by operator', tone: 'warn' };
  return p.paused ? { label: 'Paused', tone: 'down' } : { label: 'Open', tone: 'up' };
}

/** A gap in basis points: "+38 bps" when small, "-4.13%" from 100 bps on. */
export function fmtGap(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—';
  const sign = bps > 0 ? '+' : bps < 0 ? '-' : '';
  const a = Math.abs(bps);
  return a >= 100 ? `${sign}${(a / 100).toFixed(2)}%` : `${sign}${a.toFixed(a >= 10 ? 0 : 1)} bps`;
}

/** How far a gap is from the market, as the bot sees it: within its dead band, notable, or large. */
export function gapTone(bps: number | null | undefined): '' | 'warn' | 'down' {
  if (bps == null || !Number.isFinite(bps)) return '';
  const a = Math.abs(bps);
  return a >= 200 ? 'down' : a >= 50 ? 'warn' : '';
}

/** "12 s ago", "4 min ago", "3 h ago", "2 d ago". */
export function ago(at: number | null | undefined, now: number): string {
  if (at == null || !Number.isFinite(at) || at <= 0) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** A heartbeat for people: what it says and how loudly. */
export function healthLabel(h: ProcessHealth | undefined, now: number): { label: string; tone: 'up' | 'warn' | 'down' } {
  if (!h || h.status === 'missing') return { label: 'no heartbeat', tone: 'down' };
  if (h.status === 'other-pool') return { label: 'runs another pool', tone: 'warn' };
  if (h.status === 'stale') return { label: `stale, last seen ${ago(h.lastSeen, now)}`, tone: 'down' };
  return { label: `alive, ${ago(h.lastSeen, now)}${h.ok === false ? ' (last tick not ok)' : ''}`, tone: h.ok === false ? 'warn' : 'up' };
}

/**
 * Whether the prepared action may go to the wallet: it previewed successfully, it was prepared for
 * the account the wallet has connected (a manifest proves the badge from the account it names), and
 * it is fresh (the reserves guard was read at most `maxAgeMs` ago).
 */
export function canSign(o: { walletAccount: string | undefined; prepared: PreparedAction | undefined; preparedFor: string | undefined; preparedAt: number; now: number; maxAgeMs?: number }): { ok: boolean; why?: string } {
  if (!o.prepared) return { ok: false, why: 'Preview first' };
  if (!o.prepared.preview.ok) return { ok: false, why: 'The preview failed: this would fail on the ledger' };
  if (!o.walletAccount) return { ok: false, why: 'Connect the owner account in the Radix Wallet to sign' };
  if (o.walletAccount !== o.preparedFor) return { ok: false, why: 'Prepared for another account than the one connected' };
  if (o.now - o.preparedAt > (o.maxAgeMs ?? 120_000)) return { ok: false, why: 'The preview is more than two minutes old: preview again' };
  return { ok: true };
}

/** A component or resource address, shortened for a table. */
export function shortId(a: string | null | undefined): string {
  if (!a) return '—';
  return a.length > 24 ? `${a.slice(0, 14)}…${a.slice(-6)}` : a;
}
