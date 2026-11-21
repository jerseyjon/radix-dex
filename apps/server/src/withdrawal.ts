import { Decimal } from '@radix-dex/core';

/**
 * What to move from the solver to the owner: every token it holds except the solver badge, and of
 * XRD everything above `keep` plus one XRD for the withdrawal's own fee. Uses core's Decimal
 * (60 significant digits, rounding down), so an 18-decimal balance is never rounded up past what is held.
 */
export function planWithdrawal(balances: Record<string, string>, o: { xrd: string; badge: string; keep: string }): [string, Decimal][] {
  const keep = new Decimal(o.keep);
  const moves: [string, Decimal][] = [];
  for (const [resource, amount] of Object.entries(balances)) {
    const have = new Decimal(amount);
    if (!have.gt(0) || resource === o.badge) continue;
    const move = resource === o.xrd ? have.minus(keep).minus(1) : have;
    if (move.gt(0)) moves.push([resource, Decimal.min(move, have)]);
  }
  return moves;
}
