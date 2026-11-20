import { verifyAsync } from '@noble/ed25519';
import { PublicKey, RadixEngineToolkit } from '@steleaio/radix-engine-toolkit';
import { Decimal, isAccount, isResource } from './manifest.ts';
import { type LimitOrderParams, limitOrderManifest } from './orders.ts';
import { type DecodedOrder, decodeSignedPartialTransaction, fromHex, normaliseSubintentManifest } from './tx.ts';

export class OrderRejected extends Error {}

export interface OrderRules {
  networkId: number;
  solverBadge: string;
  /** If set, orders must call this registry with their order key. */
  registry?: string;
  nowSec: number;
  maxLifetimeSec: number;
  minLifetimeSec: number;
}

export interface OrderSubmission {
  account: string;
  sell: string;
  sellAmount: string;
  buy: string;
  minBuyAmount: string;
  /** Blake2b-256 of the user's cancel secret, hex. */
  orderKeyHex: string;
  signedPartialTransactionHex: string;
}

export interface ValidatedOrder extends DecodedOrder {
  params: LimitOrderParams;
  expiresAt: number;
}

const amount = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !/^\d{1,30}(\.\d{1,18})?$/.test(v)) throw new OrderRejected(`${name} is not a plain decimal amount`);
  if (!new Decimal(v).isPositive()) throw new OrderRejected(`${name} must be positive`);
  return v;
};

/**
 * Accept an order only if the signed bytes are exactly our limit-order template for the stated
 * parameters, signed by the key that controls the account, and expiring within the allowed window.
 * Nothing the client says is trusted beyond what the signed bytes prove.
 */
export async function validateLimitOrder(s: OrderSubmission, rules: OrderRules): Promise<ValidatedOrder> {
  if (!s || typeof s !== 'object') throw new OrderRejected('Bad submission');
  if (typeof s.account !== 'string' || !isAccount(s.account)) throw new OrderRejected('Bad account address');
  if (typeof s.sell !== 'string' || typeof s.buy !== 'string' || !isResource(s.sell) || !isResource(s.buy) || s.sell === s.buy) throw new OrderRejected('Bad token addresses');
  if (typeof s.orderKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(s.orderKeyHex)) throw new OrderRejected('Bad order key');
  if (typeof s.signedPartialTransactionHex !== 'string' || s.signedPartialTransactionHex.length > 20_000 || !/^[0-9a-f]+$/i.test(s.signedPartialTransactionHex)) {
    throw new OrderRejected('Bad signed order');
  }
  const params: LimitOrderParams = {
    account: s.account, sell: s.sell, sellAmount: amount(s.sellAmount, 'sellAmount'), buy: s.buy, minBuyAmount: amount(s.minBuyAmount, 'minBuyAmount'),
    solverBadge: rules.solverBadge,
    registry: rules.registry ? { component: rules.registry, orderKeyHex: s.orderKeyHex } : undefined,
  };

  let decoded: DecodedOrder;
  try {
    decoded = await decodeSignedPartialTransaction(s.signedPartialTransactionHex, rules.networkId);
  } catch (e) {
    throw new OrderRejected(`Signed order could not be read: ${(e as Error).message}`);
  }

  const expected = await normaliseSubintentManifest(limitOrderManifest(params), rules.networkId);
  if (decoded.manifest !== expected) throw new OrderRejected('Signed manifest does not match the limit-order template for these parameters');

  const h = decoded.subintent.intentCore.header;
  const expiresAt = h.maxProposerTimestampExclusive;
  if (typeof expiresAt !== 'number') throw new OrderRejected('Order has no expiry time');
  if (expiresAt < rules.nowSec + rules.minLifetimeSec) throw new OrderRejected('Order expires too soon');
  if (expiresAt > rules.nowSec + rules.maxLifetimeSec) throw new OrderRejected('Order expires too far in the future');
  if (typeof h.minProposerTimestampInclusive === 'number' && h.minProposerTimestampInclusive > rules.nowSec) throw new OrderRejected('Order is not valid yet');

  // Exactly one Ed25519 signature, valid over the subintent hash, from the key the account address is derived from.
  if (decoded.signatures.length !== 1) throw new OrderRejected('Order must carry exactly one signature');
  const sig = decoded.signatures[0] as { curve?: string; signature?: Uint8Array; publicKey?: Uint8Array };
  if (sig.curve !== 'Ed25519' || !(sig.signature instanceof Uint8Array) || !(sig.publicKey instanceof Uint8Array)) {
    throw new OrderRejected('Only Ed25519-signed orders are supported');
  }
  if (!(await verifyAsync(sig.signature, fromHex(decoded.hashHex), sig.publicKey))) throw new OrderRejected('Signature is not valid');
  const derived = await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(new PublicKey.Ed25519(sig.publicKey), rules.networkId);
  if (derived !== s.account) throw new OrderRejected('Order is not signed by the key that controls this account');

  return { ...decoded, params, expiresAt };
}
