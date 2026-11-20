# Plan and status

Updated 21 Nov 2026. Decisions taken by the project owner on 20 Nov 2026:

- Scope: terminal over existing pools **and** subintent limit orders **and** our own on-ledger
  liquidity contracts.
- Backend (order store and solver): build it, run it locally for now; hosting decided later.
- Open source (MIT), with a small configurable fee (default 0.10% on limit-order fills).
- Development may proceed unattended: build, test, commit, push and publish a read-only preview. Mainnet is read-only:
  no mainnet transactions, keys or deployments without the owner.

## Done

| Area | State | Evidence |
|---|---|---|
| Prior-art review | Written | `docs/REVIEW.md` |
| Quoting against live pools by ledger preview | Working on mainnet (read-only) | `scripts/live-check.ts` |
| Markets, candles, merged depth, quotes API | Working | `apps/server`, 55 markets |
| Subintent limit orders | Working on Stokenet | `scripts/stokenet-e2e.ts`: fill, replay refused, underpay refused, stranger refused, expiry, two orders crossed |
| Order service and solver | Working on Stokenet through HTTP | `scripts/stokenet-server-e2e.ts` |
| Order validation | Signed bytes must equal the template; signer must control the account | `packages/core/test/orders.test.ts` |
| Trading terminal | Working read-only against mainnet data, desktop and phone | `apps/web` |
| `OrderRegistry` and `Pool` blueprints | Written, with tests that try to drain the pool | `scrypto/dex-contracts` |

## Not done yet, in order

### Needs the owner

1. **dApp definition account** (Stokenet first, mainnet later) so the Radix Wallet will connect
   to the site. Then one manual test: sign a limit order in the real wallet on Stokenet. This
   is the main untested link: how the wallet presents a pre-authorization that carries
   `VERIFY_PARENT` and a registry call.
2. **Where the backend runs** and who holds the solver key.
3. **A view on regulation** of running an order-matching service, before any public mainnet launch.
4. **An independent audit of `Pool`** before it holds real funds. Until then it stays on Stokenet.

### Can proceed without the owner

1. Publish the contracts to Stokenet and run the hard-cancel path end to end (needs the
   `scrypto` CLI in the build image to produce the package definition).
2. Add our own pool as a venue and test a pool fill on Stokenet (so far only inventory and
   order-against-order fills have run on a ledger; pool fills are exercised by mainnet previews).
3. Own indexer: trades and candles from ledger events, replacing the Ociswap chart feed, and
   a recent-trades panel.
4. Escrow order-book blueprint with partial fills (the second of "our own" liquidity contracts).
5. Pre-check fills with the Gateway's V2 preview instead of a V1 quote (needs a preview
   transaction encoder the TypeScript toolkit does not have).
6. Split routing across pools; CaviarNine Shape pools as a venue while they last.
7. Wallet balance of the whole account in the UI (portfolio view), order history export.

## Known limitations

- Limit orders fill whole or not at all.
- Only accounts controlled by a single Ed25519 key can place limit orders (the server checks the
  signer against the account address). Multi-factor accounts are refused for now.
- Chart data comes from Ociswap's feed. Pairs not priced in XRD show open/close-only candles.
- The solver charges no network-fee recovery on pairs where neither side is XRD.
- Rate limiting is per connecting IP; behind a proxy it needs the proxy's client address.
- `Pool` is unaudited.
