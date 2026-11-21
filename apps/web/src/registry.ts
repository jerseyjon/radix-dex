import { addr } from '@radix-dex/core/browser';

/**
 * Wallet transaction that cancels a signed order on the ledger: the registry records hash(secret),
 * and every signed order with that key then fails its `assert_live` check, so no one can fill it,
 * whatever the server does. The wallet adds the fee lock. The secret is revealed on the ledger by
 * this, which is harmless: it can cancel that one order and nothing else.
 */
export function registryCancelManifest(registry: string, secretHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('Cancel secret must be 32 bytes of lowercase hex');
  return `CALL_METHOD ${addr(registry)} "cancel" Bytes("${secretHex}");`;
}
