import { blake2b } from '@noble/hashes/blake2b';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** A fresh 32-byte cancel secret, hex. Whoever holds it can cancel the order, and nothing else. */
export function newCancelSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** The order key is the hash the on-ledger registry uses (Scrypto `hash` = Blake2b-256) of the cancel secret. */
export function orderKeyFromSecret(secretHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('Cancel secret must be 32 bytes of lowercase hex');
  return hex(blake2b(bytes(secretHex), { dkLen: 32 }));
}
