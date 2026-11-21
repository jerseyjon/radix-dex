// Diagnostic: decode a refused order kept in data/rejected/ and show why its signature check fails.
// Usage: tsx scripts/inspect-rejected.ts data/rejected/<file>.json
import { readFileSync } from 'node:fs';
import { verifyAsync } from '@noble/ed25519';
import { PublicKey, RadixEngineToolkit } from '@steleaio/radix-engine-toolkit';
import { fromHex, toHex } from '../packages/core/src/index.ts';

const { reason, submission } = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const networkId = 2;
const raw = fromHex(submission.signedPartialTransactionHex);
const spt = await RadixEngineToolkit.SignedPartialTransactionV2.decompile(raw, networkId);
const sub = spt.partialTransaction.rootSubintent;
console.log('reason:', reason);
console.log('header:', JSON.stringify(sub.intentCore.header, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
console.log('message:', JSON.stringify(sub.intentCore.message, (_, v) => (v instanceof Uint8Array ? toHex(v) : typeof v === 'bigint' ? v.toString() : v)));
console.log('children:', sub.intentCore.children.length, 'blobs:', sub.intentCore.blobs.length);
console.log('instructions:\n' + sub.intentCore.instructions);
const recompiled = await RadixEngineToolkit.SignedPartialTransactionV2.compile(spt);
console.log('round trip identical:', toHex(recompiled) === submission.signedPartialTransactionHex.toLowerCase(), raw.length, recompiled.length);
const hash = await RadixEngineToolkit.SubintentV2.hash(sub);
console.log('hash:', hash.id);
for (const s of spt.rootSubintentSignatures as any[]) {
  console.log('signature:', s.curve, 'sig', s.signature?.length, 'pk', s.publicKey ? toHex(s.publicKey) : undefined);
  if (s.curve === 'Ed25519') {
    console.log('  verifies over hash:', await verifyAsync(s.signature, hash.hash, s.publicKey));
    console.log('  account of key:', await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(new PublicKey.Ed25519(s.publicKey), networkId));
  }
}
console.log('stated account:', submission.account);
