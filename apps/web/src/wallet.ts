import { DataRequestBuilder, RadixDappToolkit, SubintentRequestBuilder } from '@radixdlt/radix-dapp-toolkit';

export interface WalletAccount { address: string; label: string }

export interface Wallet {
  onAccounts(cb: (accounts: WalletAccount[]) => void): () => void;
  /** Ask the wallet to sign and submit an ordinary transaction. Resolves to the transaction id. */
  sendTransaction(manifest: string, message?: string): Promise<string>;
  /** Ask the wallet to sign a pre-authorization (subintent). Resolves to the signed partial transaction hex. */
  signOrder(manifest: string, expiresInSec: number, message?: string): Promise<{ signedPartialTransactionHex: string; subintentHash: string }>;
}

let wallet: Wallet | undefined;

/** The wallet connects only if the server names a dApp definition account for this site. */
export function getWallet(networkId: number, dAppDefinition: string | null | undefined): Wallet | undefined {
  if (!dAppDefinition) return undefined;
  if (wallet) return wallet;
  const rdt = RadixDappToolkit({ dAppDefinitionAddress: dAppDefinition, networkId, applicationName: 'Radix DEX', applicationVersion: '0.1.0' });
  rdt.walletApi.setRequestData(DataRequestBuilder.accounts().atLeast(1));
  // The button's look matches difd.net's (its 'black' theme sits well on the glass).
  rdt.buttonApi.setTheme('black');
  wallet = {
    onAccounts(cb) {
      const sub = rdt.walletApi.walletData$.subscribe((d) => cb((d.accounts ?? []).map((a) => ({ address: a.address, label: a.label }))));
      return () => sub.unsubscribe();
    },
    async sendTransaction(manifest, message) {
      const r = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1, message });
      if (r.isErr()) throw new Error(r.error.message || r.error.error || 'The wallet did not complete the transaction');
      return r.value.transactionIntentHash;
    },
    async signOrder(manifest, expiresInSec, message) {
      let builder = SubintentRequestBuilder().manifest(manifest).setExpiration('afterDelay', expiresInSec);
      if (message) builder = builder.message(message);
      const r = await rdt.walletApi.sendPreAuthorizationRequest(builder);
      if (r.isErr()) throw new Error(r.error.message || r.error.error || 'The wallet did not sign the order');
      return { signedPartialTransactionHex: r.value.signedPartialTransaction, subintentHash: r.value.subintentHash };
    },
  };
  return wallet;
}
