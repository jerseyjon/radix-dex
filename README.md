# radix-dex

A CEX-style spot trading terminal for Radix that holds no user funds.

**Status: live on mainnet (https://dex.difd.net) since 21 November 2026. Not audited.** The
`OrderBook` and `OrderRegistry` contracts are deployed on mainnet and hold real funds; they have
not had an independent audit, and the owner has accepted that risk. An internal security audit,
code review and bug test were done on 21 November 2026 (`docs/review-2026-11-21/`).

- Market orders are short-lived pre-authorizations filled within seconds at the best price from
  resting limit orders and existing pools (Ociswap, DefiPlaza, and two CaviarNine pools on a
  best-effort basis) in one transaction. Where no
  solver runs they fall back to an ordinary wallet transaction through the pools.
- Limit orders come in two kinds. **"In parts"** (the form's default) places the tokens in the
  on-ledger `OrderBook` contract, which anyone can fill a part at a time at the order's price.
  **"Whole only"** orders are **subintents** (wallet "pre-authorizations"): free to place, funds
  stay in the user's account until the fill, and the network fee is paid by the solver. Either
  fills when the market reaches its price; for subintents the fees are taken in XRD (from the XRD
  the order buys or sells, or between two swaps through XRD), down to a minimum enforced by the
  Radix Engine. A pair with no XRD and no route through XRD is not filled by the solver. A small backend holds the signed orders and fills them
  against pools, against each other and against the order book.
- The order book shows pool depth and resting limit orders together.

Why it is built this way: [docs/REVIEW.md](docs/REVIEW.md). How it works:
[docs/DESIGN.md](docs/DESIGN.md). What is done and what is next: [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Gateway client, venue adapters, quoting by preview, manifest builders, order validation, matching logic |
| `apps/server` | HTTP API (markets, candles, depth, quotes, orders) and the solver loop |
| `apps/web` | The trading terminal (React + Vite) |
| `scrypto/dex-contracts` | `OrderRegistry` (hard cancel), `Pool` (rounding-safe constant-product pool) and `OrderBook` (resting orders with partial fills) |
| `scrypto/owner-pool` | `OwnerPool`: a constant-product pool only the owner badge can fund or withdraw from, for a market-making bot. Its own crate and package (published on Stokenet only, `scripts/stokenet-owner-pool.ts`; not on mainnet), so `dex-contracts` still rebuilds to the published wasm. Before instantiating: the badge must be a non-fungible, or a 0-divisibility fungible with supply 1, with no minter and every role locked (a proof of any amount of the badge is full, permanent ownership); both pooled tokens must have recall, freeze and mint denied and locked. See `docs/review-2026-11-21/owner-pool-audit.md`. Since the cold/hot split (`docs/review-2026-11-21/owner-pool-split-design.md`) an optional operator badge can move funds between the pool's inventory and its reserves within owner-set limits; manifests for every owner and operator call, and the operator's budget arithmetic, are in `packages/core/src/ownerpool-ops.ts`. |
| `scripts` | Live checks and Stokenet end-to-end tests |

## Run it

Needs Node 22.18 or later (`node:sqlite`) and, for the contracts, Docker.

```bash
npm install
npm test                      # unit tests (offline)
npm run build -w apps/web     # build the terminal
DEX_WEB_DIR=apps/web/dist npm run server   # http://127.0.0.1:8787, live mainnet data, read-only
```

Without a dApp definition and a solver the server is read-only: it shows markets, charts,
depth and quotes but cannot trade.

| Variable | Meaning | Default |
|---|---|---|
| `DEX_NETWORK` | `mainnet` or `stokenet` | `mainnet` |
| `DEX_GATEWAY_URL` | Gateway to use (for example your own) | the public one |
| `DEX_PORT`, `DEX_HOST` | Where to listen | `8787`, `127.0.0.1` |
| `DEX_TAKER_FEE_BPS` | Fee on an order that takes liquidity, from a pool or a resting order (`DEX_FEE_BPS` also works) | `10` (0.10%) |
| `DEX_MAKER_FEE_BPS` | Fee on a resting order when another order takes it (only charged when it is paid in XRD) | `0` |
| `DEX_FEE_TOKENS` | Comma-separated resource addresses that may later be converted to XRD for fees in pairs with no route through XRD (published in `/api/config`; not used for filling yet) | hUSDC, DFP2 on mainnet; TUSD on Stokenet |
| `DEX_SOLVER_BADGE` | Fungible badge limit orders are pinned to; enables limit orders | unset |
| `DEX_SOLVER_KEY_FILE` | File (mode 600) with the solver's Ed25519 key in hex; enables filling | unset |
| `DEX_ORDER_BOOK` | `OrderBook` component, to enable resting orders with partial fills | unset |
| `DEX_REGISTRY` | `OrderRegistry` component, to enable hard cancels | unset |
| `DEX_MARKETS_FILE` | JSON of tokens and pools, for networks with no venue API | unset |
| `DEX_OWNER_POOLS` | Comma-separated OwnerPool component addresses to route through, beside the discovered ones (`DEX_POOL_OWNER_BADGES`). Each must be an `OwnerPool` of a package in `OWNER_POOL_PACKAGES` (packages/core/src/ownerpool.ts), checked on the ledger. A Stokenet markets file may list them too (venue `ownerpool`) | unset |
| `DEX_POOL_OWNER_BADGES` | Owner badges whose OwnerPools are found on the ledger and listed (their own state must name the badge; see docs/MAINNET-POOLS.md section 13), and whose holder may create pools from the Pools page. Empty turns both off | mainnet: the DIFD pools owner badge; Stokenet: none |
| `DEX_DAPP_DEFINITION` | dApp definition account, so the wallet will connect | unset |
| `DEX_CLIENT_IP_HEADER` | Header with the visitor's address when behind a proxy, for the rate limit (`cf-connecting-ip` behind Cloudflare) | unset |
| `DEX_RATE_PER_MINUTE` | API requests allowed per visitor per minute | `240` |
| `DEX_TLS_KEY_FILE`, `DEX_TLS_CERT_FILE`, `DEX_TLS_PORT` | Also listen over https with this key and certificate | unset, unset, `8443` |
| `DEX_DATA_DIR` | Where the order database (`orders-<network>.sqlite`) lives | `data` |
| `DEX_MIN_POOL_TVL_USD` | Pools below this TVL (venue figure) are not listed | `300` |
| `DEX_MAX_ORDER_LIFETIME_SEC` | Longest lifetime accepted for a signed limit order | `2592000` (30 days) |
| `DEX_MAX_OPEN_ORDERS` | Open signed orders allowed per account | `50` |
| `DEX_FAILED_FEE_LIMIT_XRD` | Loss limit: the solver stops sending when network fees paid on failed transactions in the last hour reach this | `3` |
| `DEX_ACCOUNT_FAILURE_LIMIT` | Failed fills in 24 hours after which an account may not post orders and its orders are skipped | `6` |
| `DEX_MAX_RESTING_PER_TICK`, `DEX_MAX_BOOK_PER_TICK` | Resting signed orders, and book orders, looked at per solver pass (market orders are not limited) | `20`, `20` |
| `DEX_MIN_BOOK_ORDER_XRD` | Smallest “In parts” (order-book) order, valued in XRD, the order form lets a user place; book orders worth less are also not bought by the solver with its own funds. Value = the XRD sold, or for an order buying XRD the XRD asked for; pairs without XRD are not restricted. Enforced by the site only: the contract has no minimum. Published as `orderBook.minOrderXrd` in `/api/config` | `100` on mainnet, `5` on Stokenet |
| `DEX_LOW_XRD` | `/api/health` reports the solver as low on funds below this XRD balance | `30` |

Numbers are checked at start-up: a value that is not a number in range stops the server rather
than being ignored. `GET /api/health` answers 200 when all is well and 503 with a list of problems
(markets not loaded, solver pass overdue, loss limit reached, solver XRD low, solver holding a token
other than XRD) for an uptime monitor.

## Tests

```bash
npm test                               # unit tests: order validation, matching, solver, store, API
npm run typecheck                      # the server, core and scripts
npx tsx scripts/live-check.ts          # read-only check against mainnet pools
npx tsx scripts/stokenet-e2e.ts        # first-version test; still the script that creates data/stokenet-keys.json
npx tsx scripts/stokenet-server-e2e.ts # two signed orders crossed through the HTTP API and solver
npx tsx scripts/stokenet-setup.ts      # publish contracts, pool, registry and dApp definition on Stokenet
npx tsx scripts/stokenet-pool-e2e.ts   # pool fill and on-ledger cancel against that deployment
npx tsx scripts/stokenet-owner-pool.ts setup|exercise|operator|revoke|restore|quotes|gas|status [--send] [--data DIR]   # split OwnerPool on Stokenet (preview unless --send)
npx tsx scripts/stokenet-owner-pool-e2e.ts [--data DIR]   # market orders both ways through it, separate in-process server
npx tsx scripts/stokenet-book-e2e.ts   # on-ledger order book: partial fills, cancel, fill when a pool reaches the price
scripts/run-stokenet.sh                # run the Stokenet test site with wallet connect on port 8788
scrypto/run.sh test                    # contract tests, including attempts to drain the pool
CRATE=owner-pool scrypto/run.sh test   # OwnerPool tests (slow: about 10 minutes)
```

The Radix Connector browser extension only runs on `https://` pages and on `http://localhost` or
`http://127.0.0.1`. Opened by LAN address over plain http, the site reports the extension as
missing. From another machine use the https listener (a self-signed
certificate in `data/tls/` is enough for testing), or forward the port and open `http://localhost:8788`.

## Safety notes

- The solver key can never move a user's funds beyond what a signed order allows. If it leaks,
  the holder can take the solver's own float and can fill open orders at the users' limit
  prices rather than better ones.
- Pools are routed only if their on-ledger package is on the allow-list in
  `packages/core/src/venues.ts`.
- The solver previews every transaction in full before sending it and sends nothing whose preview
  fails, and it stops sending when fees lost on failed transactions pass a limit (see
  `DEX_FAILED_FEE_LIMIT_XRD`). It only fills orders between the tokens of a listed market.
- `OrderBook` and `OrderRegistry` are live on mainnet and hold other people's money. They have
  tests that try to drain them and an internal review, but no independent audit; the owner chose
  to deploy them on that basis. `Pool` is not deployed on mainnet.

## Licence

MIT.
