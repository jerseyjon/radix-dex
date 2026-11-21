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
- **The solver's float.** Each fill costs the solver a network fee (1.0 to 1.4 XRD measured on
  mainnet), recovered from the order in the bought token. A fill that fails on ledger still costs
  its fee. Every transaction is previewed in full first and not sent if the preview fails, and the
  solver stops sending once fees lost on failed transactions in the last hour reach
  `DEX_FAILED_FEE_LIMIT_XRD` (3 XRD by default). Buying book orders needs the float plus 10 XRD
  for the fee lock, which the solver never spends.
- **Fees in thin tokens (audit H3, not fixed).** The network fee is recovered in whatever token
  the order buys, valued at its best pool's price. An attacker's own token with its own small pool
  can make that worthless. See `docs/review-2026-11-21/fixes.md` for the options.
- Liquidity on Radix is thin (most markets hold a few thousand dollars), so large orders move prices.

## Steps

| # | Step | Who |
|---|---|---|
| 1 | Choose the server and the address (for example `dex.example.com` on a domain in Cloudflare) | Owner |
| 2 | In the Radix Wallet, pick the owner account and create a new account to be the dApp definition | Owner |
| 3 | On the server: clone, `npm ci`, `npm run build -w apps/web`, then `npx tsx scripts/mainnet-setup.ts init <owner> <dapp account> https://<address>`. This creates the solver key (`data/mainnet-solver.key`, mode 600) and prints the solver account | Claude |
| 4 | `npx tsx scripts/mainnet-setup.ts next`, sign the printed manifest at console.radixdlt.com/transaction-manifest, then `record <txid>`. Repeat: owner badge, solver badge, publish package (console.radixdlt.com/deploy-package, files in `data/contracts/`, owner role None), registry and order book, dApp definition. (`data/contracts/v1/` is an older build referenced by nothing; the files used are the ones directly in `data/contracts/`. How they were built is not recorded: see quality review item 20.) | Owner signs, Claude prepares and records |
| 5 | Send XRD to the solver account: network fees (1.0 to 1.4 XRD per fill), plus 10 XRD that a book purchase locks for its fee, plus the float it uses to fill book orders itself | Owner |
| 6 | Install the user service `deploy/radix-dex-mainnet.service` (see "How it runs" below) | Claude |
| 7 | Cloudflare Tunnel from the address to `http://127.0.0.1:8787`; confirm `https://<address>/.well-known/radix.json` names the dApp definition | Owner logs in to Cloudflare, Claude configures |
| 8 | Trial with small amounts: connect, market buy and sell, a signed limit order, an "In parts" order, a partial fill, a cancel. Check each against the ledger | Owner trades, Claude checks |
| 9 | Decide whether to announce it | Owner |

## How it runs

The site and solver run as the **systemd user service `radix-dex-mainnet`** of the account that
owns the checkout, with the Cloudflare tunnel as a second user service, `radix-dex-tunnel`:

| | |
|---|---|
| Unit | `~/.config/systemd/user/radix-dex-mainnet.service` (copy in `deploy/radix-dex-mainnet.service`) |
| Starts | `scripts/run-mainnet.sh`, which reads `data/mainnet-setup.json` and runs `npx tsx apps/server/src/main.ts` |
| Working directory | the repository checkout |
| Data | `data/` in the checkout (`DEX_DATA_DIR` default): `orders-mainnet.sqlite` with its `-wal` and `-shm` files, and `mainnet-solver.key` (mode 600) |
| Listens | `127.0.0.1:8787` only; `radix-dex-tunnel` (cloudflared) is the only way in |
| Logs | `journalctl --user -u radix-dex-mainnet` |

    systemctl --user status radix-dex-mainnet
    systemctl --user restart radix-dex-mainnet     # SIGTERM: the server finishes its pass and closes the database
    systemctl --user stop radix-dex-mainnet

For a user service to run while nobody is logged in, lingering must be on (`loginctl enable-linger <user>`).

`deploy/radix-dex.service` is **not in use**: it is a template for running the server as a separate
system user with a sandbox (audit M4). Moving to it means a separate checkout, `DEX_DATA_DIR` set
to its data directory, and the three database files and the key file moved there with the
service stopped. Until then the key is readable by anything that runs as the same user.

Health: `curl -s http://127.0.0.1:8787/api/health` answers 200, or 503 with a list of problems
(markets not loaded, solver pass overdue, loss limit reached, solver XRD low). Point an uptime
monitor at `https://<address>/api/health`.

## Backups

`orders-mainnet.sqlite` holds every open signed order (losing it loses those orders, not funds).
Copying the `.sqlite` file alone is not a backup: recent changes live in the `-wal` file. Use

    npx tsx scripts/backup-db.ts data/orders-mainnet.sqlite data/backups

which takes one consistent copy (SQLite `VACUUM INTO`, WAL included) while the server runs,
checks it, writes it mode 600 and keeps the newest 30. `deploy/radix-dex-backup.service` and
`.timer` run it nightly as user units. Copy `data/backups/` off the machine as well.

## Stopping it

- Stop the service: nothing can be filled, signed orders simply expire, book orders stay
  cancellable by their owners directly on the ledger (the site is not needed: the receipt NFT
  and the `cancel` method are enough).
- `npx tsx scripts/mainnet-setup.ts recall` prints the manifest that takes the solver badge back.
  Every signed order then becomes unfillable for good.

## Still to do after the first release

Split routing across several pools; splitting signed limit orders; an independent review of
`OrderBook`; a decision on fees in thin tokens (audit H3); running under a separate user (audit M4).

## Taking out the solver's earnings

The solver account's key is only on the server, so its funds are moved from there:

    npx tsx scripts/mainnet-withdraw.ts            # balances and what would move; previewed, sends nothing
    npx tsx scripts/mainnet-withdraw.ts --send     # send it to the owner account from the set-up

It keeps 250 XRD in the solver (`--keep <n>` to change) as its float for network fees and for buying
book orders, and sends the rest, with every other token collected as fees, to the owner account. The
solver badge never moves. The balance can be watched at
`https://dashboard.radixdlt.com/account/<solver account>`.
