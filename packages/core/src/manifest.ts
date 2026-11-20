import { Decimal } from 'decimal.js';

Decimal.set({ precision: 60, rounding: Decimal.ROUND_DOWN });
export { Decimal };

const ADDRESS_RE = /^(account|component|resource|package|pool|validator|locker|consensusmanager|identity|accesscontroller|internal_vault)_(rdx|tdx_2_|sim)1[a-z0-9]{20,80}$/;

/** Reject anything that is not a plain bech32m Radix address, so it is safe to splice into RTM. */
export function addr(a: string): string {
  if (!ADDRESS_RE.test(a)) throw new Error(`Not a Radix address: ${JSON.stringify(a)}`);
  return `Address("${a}")`;
}

/** Format a non-negative amount as an RTM Decimal with at most 18 decimal places (rounded down). */
export function dec(v: string | number | Decimal): string {
  const d = new Decimal(v);
  if (!d.isFinite() || d.isNegative()) throw new Error(`Not a valid amount: ${String(v)}`);
  return `Decimal("${d.toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed()}")`;
}

export function bucket(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) throw new Error(`Bad bucket name: ${name}`);
  return `Bucket("${name}")`;
}

export function isAccount(a: string): boolean {
  return ADDRESS_RE.test(a) && a.startsWith('account_');
}

export function isResource(a: string): boolean {
  return ADDRESS_RE.test(a) && a.startsWith('resource_');
}
