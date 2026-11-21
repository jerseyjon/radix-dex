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
| Subintent limit orders | Live on mainnet since 21 Nov 2026 | first tested by `scripts/stokenet-e2e.ts` (first-version manifests) |
| Order service and solver | Live on mainnet; previews every transaction (V2, with the signed orders) before sending | `scripts/stokenet-server-e2e.ts`, `stokenet-pool-e2e.ts`, `apps/server/test/solver.test.ts` |
| On-ledger order book with partial fills | Live on mainnet since 21 Nov 2026 (unaudited, owner's decision) | `scripts/stokenet-book-e2e.ts` |
| dApp definition, mainnet set-up | Done | `scripts/mainnet-setup.ts`, `docs/MAINNET.md` |
| Order validation | Signed bytes must equal the template; signer must control the account | `packages/core/test/orders.test.ts` |
| Trading terminal | Working read-only against mainnet data, desktop and phone | `apps/web` |
| `OrderRegistry` and `Pool` blueprints | Written, with tests that try to drain the pool | `scrypto/dex-contracts` |

## Not done yet, in order

### Needs the owner

1. **Fees in thin tokens** (audit H3): a vetted fee-token list, or taking the fee from the sell
   side when that is XRD. Options in `docs/review-2026-11-21/fixes.md`.
2. **Running under a separate user** (audit M4), away from the development checkout.
3. **A view on regulation** of running an order-matching service, before announcing it.
4. **An independent audit of `OrderBook`** (live) and of `Pool` (Stokenet only).

### Can proceed without the owner

(Done since this list was written: contracts on Stokenet with the hard-cancel path tested end
to end, and pool fills through our own Stokenet pool, both in `scripts/stokenet-pool-e2e.ts`.)

1. Own indexer: trades and candles from ledger events, replacing the Ociswap chart feed.
2. Split routing across pools; CaviarNine Shape pools as a venue while they last.
3. Move test-key creation into `stokenet-setup.ts` and delete the first-version `stokenet-e2e.ts`.
4. Wallet balance of the whole account in the UI (portfolio view), order history export.

## Known limitations

- Signed ("Whole only") limit orders fill whole or not at all; "In parts" orders in the order book fill in parts.
- Only accounts controlled by a single Ed25519 key can place limit orders (the server checks the
  signer against the account address). Multi-factor accounts are refused for now.
- Chart data comes from Ociswap's feed. Pairs not priced in XRD show open/close-only candles.
- The solver recovers the network fee in the bought token at what an XRD route prices it, and does not
  fill an order whose bought token no pool route prices; such orders wait until they expire.
- Rate limiting is per connecting IP; behind a proxy it needs the proxy's client address.
- `Pool` and `OrderBook` are unaudited.
