# radix-dex

A CEX-style spot trading terminal for Radix that holds no user funds.

**Status: working prototype. Not audited. Nothing here has been run on mainnet with real money.**

- Market orders are ordinary wallet transactions routed through existing pools (Ociswap,
  DefiPlaza), quoted by previewing the real swap on the ledger.
- Limit orders are **subintents** (wallet "pre-authorizations"): free to place, funds stay in
  the user's account until the fill, the network fee is paid by the solver, and the user's
  minimum price is enforced by the Radix Engine. A small backend holds the signed orders and
  fills them against pools or against each other.
- The order book shows pool depth and resting limit orders together.

Why it is built this way: [docs/REVIEW.md](docs/REVIEW.md). How it works:
[docs/DESIGN.md](docs/DESIGN.md). What is done and what is next: [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Gateway client, venue adapters, quoting by preview, manifest builders, order validation, matching logic |
| `apps/server` | HTTP API (markets, candles, depth, quotes, orders) and the solver loop |
| `apps/web` | The trading terminal (React + Vite) |
| `scrypto/dex-contracts` | `OrderRegistry` (hard cancel) and `Pool` (rounding-safe constant-product pool) |
| `scripts` | Live checks and Stokenet end-to-end tests |

## Run it

Needs Node 22+ and, for the contracts, Docker.

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
| `DEX_FEE_BPS` | Fee the solver takes from limit-order fills | `10` (0.10%) |
| `DEX_SOLVER_BADGE` | Fungible badge limit orders are pinned to; enables limit orders | unset |
| `DEX_SOLVER_KEY_FILE` | File (mode 600) with the solver's Ed25519 key in hex; enables filling | unset |
| `DEX_REGISTRY` | `OrderRegistry` component, to enable hard cancels | unset |
| `DEX_MARKETS_FILE` | JSON of tokens and pools, for networks with no venue API | unset |
| `DEX_DAPP_DEFINITION` | dApp definition account, so the wallet will connect | unset |

## Tests

```bash
npm test                               # unit tests: order validation, matching, API
npx tsx scripts/live-check.ts          # read-only check against mainnet pools
npx tsx scripts/stokenet-e2e.ts        # signs and fills real orders on Stokenet with throwaway keys
npx tsx scripts/stokenet-server-e2e.ts # same, through the HTTP API and solver
npx tsx scripts/stokenet-setup.ts      # publish contracts, pool, registry and dApp definition on Stokenet
npx tsx scripts/stokenet-pool-e2e.ts   # pool fill and on-ledger cancel against that deployment
scripts/run-stokenet.sh                # run the Stokenet test site with wallet connect on port 8788
scrypto/run.sh test                    # contract tests, including attempts to drain the pool
```

The Radix Connector browser extension only runs on `https://` pages and on `http://localhost` or
`http://127.0.0.1`. Opened by LAN address over plain http, the site reports the extension as
missing. From another machine, forward the port (`ssh -L 8788:localhost:8788 user@host`) and
open `http://localhost:8788`.

## Safety notes

- The solver key can never move a user's funds beyond what a signed order allows. If it leaks,
  the holder can take the solver's own float and can fill open orders at the users' limit
  prices rather than better ones.
- Pools are routed only if their on-ledger package is on the allow-list in
  `packages/core/src/venues.ts`.
- `Pool` in `scrypto/` is new code that would hold other people's money. It has tests that try
  to drain it, but it has not been audited. Do not deploy it to mainnet without a review.

## Licence

MIT.
