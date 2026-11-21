import {
  PrivateKey, RadixEngineToolkit, TransactionV2Builder, rawRadixEngineToolkit,
  type IntentCoreV2, type SignatureWithPublicKey, type SubintentV2,
} from '@steleaio/radix-engine-toolkit';
import type { Gateway } from './gateway.ts';

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (h: string): Uint8Array => {
  if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error('Not hex');
  return Uint8Array.from(Buffer.from(h, 'hex'));
};

export type Ed25519Key = InstanceType<typeof PrivateKey.Ed25519>;

export function keyFromHex(hex: string): Ed25519Key {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Private key must be 32 bytes of hex');
  return new PrivateKey.Ed25519(fromHex(hex));
}

export function accountOf(key: Ed25519Key, networkId: number): Promise<string> {
  return RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(key.publicKey(), networkId);
}

const NO_MESSAGE = { kind: 'None' } as IntentCoreV2['message'];

export interface IntentWindow {
  networkId: number;
  startEpoch: number;
  /** Exclusive. At most ~30 days of epochs after start. */
  endEpoch: number;
  /** Unix seconds; the intent cannot commit at or after this time. */
  expiresAt?: number;
}

function core(manifest: string, w: IntentWindow, children: Uint8Array[] = [], blobs: Uint8Array[] = []): IntentCoreV2 {
  return {
    header: {
      networkId: w.networkId,
      startEpochInclusive: w.startEpoch,
      endEpochExclusive: w.endEpoch,
      maxProposerTimestampExclusive: w.expiresAt,
      // Random discriminator so two otherwise identical intents get different hashes.
      intentDiscriminator: Number(BigInt.asUintN(53, BigInt('0x' + toHex(crypto.getRandomValues(new Uint8Array(8)))))),
    },
    instructions: manifest,
    blobs,
    message: NO_MESSAGE,
    children,
  };
}

export interface DecodedOrder {
  subintent: SubintentV2;
  signatures: SignatureWithPublicKey[];
  /** Raw 32-byte subintent hash, hex. */
  hashHex: string;
  /** Bech32m subtxid_… */
  hashId: string;
  /** Normalised manifest text as the toolkit prints it. */
  manifest: string;
  signedPartialTransactionHex: string;
  /**
   * The subintent exactly as signed, in the toolkit's raw form (64-bit numbers as text).
   * `subintent` above goes through JavaScript numbers and loses precision on the intent
   * discriminator, so it must never be hashed or re-encoded.
   */
  exactSubintent: unknown;
  exactSignatures: unknown[];
}

/** Build and sign a subintent with a local key (tests, bots). Wallet users sign in the wallet instead. */
export async function signSubintent(manifest: string, w: IntentWindow, key: Ed25519Key): Promise<DecodedOrder> {
  const raw = await rawRadixEngineToolkit;
  const draft = await RadixEngineToolkit.SubintentV2.compile({ intentCore: core(manifest, w) });
  const exact = raw.subintentV2Decompile({ compiled: toHex(draft), network_id: String(w.networkId) });
  // A full 64-bit discriminator, as wallets produce.
  exact.intent_core.header.intent_discriminator = BigInt('0x' + toHex(crypto.getRandomValues(new Uint8Array(8)))).toString();
  const hash = raw.subintentV2Hash(exact);
  const sig = key.signToSignatureWithPublicKey(fromHex(hash.hash)) as unknown as { signature: Uint8Array; publicKey: Uint8Array };
  const compiled = raw.signedPartialTransactionV2Compile({
    partial_transaction: { root_subintent: exact, non_root_subintents: [] },
    root_subintent_signatures: [{ kind: 'Ed25519', value: { signature: toHex(sig.signature), public_key: toHex(sig.publicKey) } } as never],
    non_root_subintent_signatures: [],
  });
  return decodeSignedPartialTransaction(compiled, w.networkId);
}

/** Decompile what a wallet (or `signSubintent`) returned. Rejects anything with nested subintents. */
export async function decodeSignedPartialTransaction(hex: string, networkId: number): Promise<DecodedOrder> {
  const spt = await RadixEngineToolkit.SignedPartialTransactionV2.decompile(fromHex(hex), networkId);
  if (spt.partialTransaction.nonRootSubintents.length !== 0) throw new Error('Orders must not contain nested subintents');
  const subintent = spt.partialTransaction.rootSubintent;
  if (subintent.intentCore.header.networkId !== networkId) throw new Error('Order is for a different network');
  if (subintent.intentCore.children.length !== 0) throw new Error('Orders must not declare children');
  if (subintent.intentCore.blobs.length !== 0) throw new Error('Orders must not carry blobs');
  // Hash the exact signed form, and insist the bytes are the canonical encoding of it.
  const raw = await rawRadixEngineToolkit;
  const exact = raw.signedPartialTransactionV2Decompile({ compiled: hex.toLowerCase(), network_id: String(networkId) });
  if (raw.signedPartialTransactionV2Compile(exact).toLowerCase() !== hex.toLowerCase()) throw new Error('Order is not canonically encoded');
  const hash = raw.subintentV2Hash(exact.partial_transaction.root_subintent);
  return {
    subintent,
    signatures: spt.rootSubintentSignatures,
    hashHex: hash.hash.toLowerCase(),
    hashId: hash.id,
    manifest: subintent.intentCore.instructions,
    signedPartialTransactionHex: hex.toLowerCase(),
    exactSubintent: exact.partial_transaction.root_subintent,
    exactSignatures: exact.root_subintent_signatures,
  };
}

/** Round-trip RTM text through the toolkit so two manifests can be compared for exact equality. */
export async function normaliseSubintentManifest(manifest: string, networkId: number): Promise<string> {
  const sub: SubintentV2 = { intentCore: core(manifest, { networkId, startEpoch: 1, endEpoch: 2 }) };
  const back = await RadixEngineToolkit.SubintentV2.decompile(await RadixEngineToolkit.SubintentV2.compile(sub), networkId);
  return back.intentCore.instructions;
}

export interface BuiltTransaction {
  hex: string;
  /** txid_… */
  intentHashId: string;
}

/**
 * Build, sign and notarise a V2 transaction whose root manifest yields to the given orders.
 * `children` maps the NamedIntent used in the manifest to the decoded order.
 */
export async function buildTransaction(o: {
  manifest: string; window: IntentWindow; notary: Ed25519Key; children?: Record<string, DecodedOrder>; tipBasisPoints?: number;
  /** Binary attachments referenced from the manifest as Blob("<blake2b-256 hash>"), e.g. package code. */
  blobs?: Uint8Array[];
}): Promise<BuiltTransaction> {
  const children = Object.entries(o.children ?? {});
  const useChild = children.map(([name, c]) => `USE_CHILD NamedIntent("${name}") Intent("${c.hashId}");`);
  const rootManifest = [...useChild, o.manifest].join('\n');
  const rootCore = core(rootManifest, o.window, children.map(([, c]) => fromHex(c.hashHex)), o.blobs ?? []);
  const builder = await TransactionV2Builder.new();
  let step = builder
    .header({ notaryPublicKey: o.notary.publicKey(), notaryIsSignatory: true, tipBasisPoints: o.tipBasisPoints ?? 0 })
    .rootIntentCore(rootCore);
  for (const [, c] of children) step = step.addSignedSubintent(c.subintent, c.signatures);
  const draft = await RadixEngineToolkit.NotarizedTransactionV2.compile(await step.notarize(o.notary));
  // The builder re-encodes the orders through JavaScript numbers. Put the exact signed orders
  // back, then hash and notarise the result.
  const raw = await rawRadixEngineToolkit;
  const tx = raw.notarizedTransactionV2Decompile({ compiled: toHex(draft), network_id: String(o.window.networkId) });
  const signed = tx.signed_transaction_intent;
  // Decompiled text drops the USE_CHILD lines, so it would not compile again: use ours.
  signed.transaction_intent.root_intent_core.instructions = rootManifest;
  signed.transaction_intent.non_root_subintents = children.map(([, c]) => c.exactSubintent) as never;
  signed.non_root_subintent_signatures = children.map(([, c]) => c.exactSignatures) as never;
  const intentHash = raw.transactionIntentV2Hash(signed.transaction_intent);
  const notarySig = o.notary.signToSignature(fromHex(raw.signedTransactionIntentV2Hash(signed).hash)) as unknown as { signature?: Uint8Array; bytes?: Uint8Array };
  tx.notary_signature = { kind: 'Ed25519', value: toHex((notarySig.signature ?? notarySig.bytes)!) };
  return { hex: raw.notarizedTransactionV2Compile(tx), intentHashId: intentHash.id };
}

export type TxOutcome = { status: 'CommittedSuccess' } | { status: 'CommittedFailure' | 'Rejected' | 'Timeout'; error: string };

/** Submit and wait for a final status. */
export async function submitAndWait(gateway: Gateway, tx: BuiltTransaction, timeoutMs = 60_000): Promise<TxOutcome> {
  await gateway.post('/transaction/submit', { notarized_transaction_hex: tx.hex });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await gateway.post('/transaction/status', { intent_hash: tx.intentHashId });
    if (s.intent_status === 'CommittedSuccess') return { status: 'CommittedSuccess' };
    if (s.intent_status === 'CommittedFailure') return { status: 'CommittedFailure', error: String(s.error_message ?? s.intent_status_description ?? '') };
    if (s.intent_status === 'PermanentlyRejected') return { status: 'Rejected', error: String(s.error_message ?? s.intent_status_description ?? '') };
  }
  return { status: 'Timeout', error: `No final status after ${timeoutMs} ms` };
}
