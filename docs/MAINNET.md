# Going to mainnet

First release: market orders and signed ("Whole only") limit orders filled through existing
pools, plus the on-ledger order book ("In parts" orders). Our own `Pool` is not deployed.

**Nothing in this repository sends a mainnet transaction during set-up.** Each one is printed,
previewed, and signed by the owner in their own wallet. After go-live the solver submits fills
from its own account, paying fees from the XRD sent to it.

## What is at risk

- **`OrderBook` holds makers' tokens and has had no independent review.** A bug could lose them.
  It has no admin path to funds and cannot be paused or upgraded; a fault means deploying a new one.
- **The solver key** sits on the server. If it leaks, the holder can take the solver's own funds
  and fill open signed orders at their limit price instead of better. It cannot take users' funds
  beyond what their orders allow. The owner can recall the solver badge to stop all filling.
- **Untested on mainnet:** real fills through Ociswap and DefiPlaza pools have only been
  previewed, never committed. The first small trades below are that test.
- Liquidity on Radix is thin (most markets hold a few thousand dollars), so large orders move prices.

## Steps

| # | Step | Who |
|---|---|---|
| 1 | Choose the server and the address (for example `dex.example.com` on a domain in Cloudflare) | Owner |
| 2 | In the Radix Wallet, pick the owner account and create a new account to be the dApp definition | Owner |
| 3 | On the server: clone, `npm ci`, `npm run build -w apps/web`, then `npx tsx scripts/mainnet-setup.ts init <owner> <dapp account> https://<address>`. This creates the solver key (`data/mainnet-solver.key`, mode 600) and prints the solver account | Claude |
| 4 | `npx tsx scripts/mainnet-setup.ts next`, sign the printed manifest at console.radixdlt.com/transaction-manifest, then `record <txid>`. Repeat: owner badge, solver badge, publish package (console.radixdlt.com/deploy-package, files in `data/contracts/`, owner role None), registry and order book, dApp definition | Owner signs, Claude prepares and records |
| 5 | Send XRD to the solver account: network fees (about 1 XRD per fill) plus the float it uses to fill book orders itself | Owner |
| 6 | Install `deploy/radix-dex.service` with the settings from `mainnet-setup.ts status` | Claude |
| 7 | Cloudflare Tunnel from the address to `http://127.0.0.1:8787`; confirm `https://<address>/.well-known/radix.json` names the dApp definition | Owner logs in to Cloudflare, Claude configures |
| 8 | Trial with small amounts: connect, market buy and sell, a signed limit order, an "In parts" order, a partial fill, a cancel. Check each against the ledger | Owner trades, Claude checks |
| 9 | Decide whether to announce it | Owner |

## Stopping it

- Stop the service: nothing can be filled, signed orders simply expire, book orders stay
  cancellable by their owners directly on the ledger (the site is not needed: the receipt NFT
  and the `cancel` method are enough).
- `npx tsx scripts/mainnet-setup.ts recall` prints the manifest that takes the solver badge back.
  Every signed order then becomes unfillable for good.

## Still to do after the first release

Split routing across several pools; splitting signed limit orders; an independent review of
`OrderBook`; backups of the order database (`orders-mainnet.sqlite`: losing it loses open signed
orders, not funds).

## Taking out the solver's earnings

The solver account's key is only on the server, so its funds are moved from there:

    npx tsx scripts/mainnet-withdraw.ts            # balances and what would move; previewed, sends nothing
    npx tsx scripts/mainnet-withdraw.ts --send     # send it to the owner account from the set-up

It keeps 250 XRD in the solver (`--keep <n>` to change) as its float for network fees and for buying
book orders, and sends the rest, with every other token collected as fees, to the owner account. The
solver badge never moves. The balance can be watched at
`https://dashboard.radixdlt.com/account/<solver account>`.
