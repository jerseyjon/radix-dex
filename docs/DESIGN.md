# Design

Working name: **radix-dex** (to be named). Background and reasons: [REVIEW.md](REVIEW.md).

## Principles

1. **Hold no user funds.** No pool, no escrow, no order-book vault. The only on-ledger code
   we publish (the order registry) stores hashes and nothing else.
2. **The user's price floor is enforced by the Radix Engine**, in the manifest they sign,
   not by trusting our backend.
3. **Depend on the ledger, not on other people's APIs.** Quotes are transaction previews
   against the real pools. Third-party APIs are used only for discovery and history, behind
   an interface, with fallbacks.
4. **Small, readable, tested.** Plain TypeScript, few dependencies.

## Components

```
apps/web        Trading terminal (React + Vite). Talks to the wallet and to apps/server.
apps/server     HTTP API: markets, candles, quotes, depth, orders. Runs the solver loop.
packages/core   Shared library: Gateway client, venue adapters, manifest builders,
                order (subintent) construction and validation, quoting.
scrypto/order-registry   Cancellation registry blueprint. Holds no resources.
```

### Venues (liquidity sources)

A venue adapter knows how to list pools, and how to write the manifest lines that swap a
bucket through one pool. It does **not** re-implement pool maths.

| Venue | Swap call | Notes |
|---|---|---|
| Ociswap Basic / Precision | `pool.swap(bucket)` | allow-listed packages only |
| DefiPlaza | `dex.swap(bucket, output_resource)` | |
| CaviarNine Shape | `pool.swap(bucket)` | later; team gone, admin badge live |

### Quoting by preview

To quote "sell X of A for B on pool P" the server previews a real manifest on the Gateway
(`/transaction/preview`, free credit, signatures assumed) that withdraws A from a large
holder, swaps through P and reads how much B comes out. This is exact for every pool type,
including fees and tick crossings, and needs no pool maths of our own. Results are cached
per ledger state for a few seconds.

**Depth ladder**: the same preview at a ladder of sizes on each side gives marginal prices,
shown as order-book levels and merged with resting limit orders.

**Best route**: v1 picks the single best pool, plus two-hop routes through XRD. Splitting
across pools comes later.

### Market orders

An ordinary wallet transaction: withdraw, swap through the chosen pool(s), assert the
minimum received (`ASSERT_WORKTOP_CONTAINS`), deposit. The user pays the network fee.

### Limit orders (subintents)

The wallet signs a pre-authorization with this manifest:

```
VERIFY_PARENT <require solver badge>;          # only our solver may wrap it
ASSERT_WORKTOP_IS_EMPTY;
CALL_METHOD <registry> "assert_live" <order_key>;   # fails if the user has cancelled
CALL_METHOD <account> "withdraw" <sell_resource> <sell_amount>;
TAKE_ALL_FROM_WORKTOP <sell_resource> Bucket("sell");
ASSERT_NEXT_CALL_RETURNS_ONLY { <buy_resource> => at least <min_buy_amount> };
YIELD_TO_PARENT Bucket("sell");
CALL_METHOD <account> "deposit_batch" Expression("ENTIRE_WORKTOP");
YIELD_TO_PARENT;
```

- Expiry is in the subintent header (seconds granularity, up to ~30 days).
- The server validates every order it receives by decompiling it and comparing it
  instruction by instruction with this template. Anything else is rejected.
- **Fill**: the solver builds a root transaction that yields to the order, receives the
  sell bucket, swaps it through pools (or hands it to a crossing order), returns the buy
  resource, and keeps the fee. It previews first and submits only if the preview succeeds.
- **Price improvement**: the solver returns *everything* the route produced, less the
  configured fee and the network cost, not merely the user's minimum.
- **Order vs order**: two crossing orders are settled in one transaction; each receives the
  other's bucket (up to 32 orders per transaction).
- **All or nothing**: a subintent fills whole or not at all. The UI says so. Large orders
  can be placed as several slices (one signature each).

### Cancelling

- **Soft cancel**: the server deletes the order. Instant, free, relies on the server.
- **Hard cancel**: the order manifest calls `registry.assert_live(key)` where
  `key = hash(secret)`. The secret is generated in the browser when the order is made.
  Calling `registry.cancel(secret)` marks the key dead for ever, so the signed order can
  never execute, whoever holds it. Costs one small transaction. Knowing the secret only
  lets you cancel, so there is nothing to steal.
- **Expiry**: short default expiries (24 h) limit exposure for users who do neither.

### Solver key

One Ed25519 key on the server: it notarises fill transactions, holds the solver badge and a
small XRD float for fees and the collected fees. If stolen, the thief can take that float
and can fill open orders at the users' own limit prices instead of better ones. They
cannot take anything a user has not signed for. Float is swept regularly.

### Data

- Markets: union of venue pool lists, filtered by allow-listed packages and minimum depth.
- Candles: Ociswap UDF history to begin with; our own indexer (ledger swap events →
  trades → candles, SQLite) replaces it.
- Gateway URL is configuration, so it can point at a self-hosted node or gateway.

## Pool safety (drain risks) and what we do about them

Three distinct flaws have been used since August 2026:

| Flaw | Where | Still live? | Our exposure |
|---|---|---|---|
| Engine vault-access bug (31 Aug) | Radix Engine | Fixed by Eagle Ray | None now |
| Flash loan + vault-ratio pricing | Ociswap **first-version Flex pools only** | Old package only | None: that package is not allow-listed |
| Rounding on contribution | **Native TwoResourcePool**, so any "simple" pool built on it (Ociswap Basic, CaviarNine Simple, others) | **Yes** — see below | Traders: none. LPs in affected pairs: yes |

**The rounding flaw, read from source**
(`radix-engine/src/blueprints/pool/v1/v1_1/two_resource_pool_blueprint.rs`): on
`contribute`, pool units are minted for the mathematically exact contribution, but the
amount actually taken from each bucket is rounded **down** to the resource's divisibility.
For an 18-decimal token the shortfall is 1e-18 and worthless. For a token with few
decimals and a high unit value (BTC wrappers: 8 decimals, one unit ≈ $0.001) the
contributor can underpay by up to one unit per call and redeem at full value. It becomes
profitable when one unit is worth more than the transaction fee, which is the case now
that XRD is ~$0.001. Scrypto 1.4.0 still has this code. (Not tested by us; this is a
reading of the source that matches the reported incident.)

**Why this design is not exposed**: resting orders live in users' own accounts until the
instant of the fill. There is no shared vault, no pool unit, no contribution maths, no
flash loan. A trader routed through a damaged pool is protected by the minimum-received
assertion: the trade either meets their price or does not happen.

**What we still do**
- Route only through allow-listed pool packages.
- Flag pairs that sit on a native pool and include a token where
  `10^-divisibility × price > typical fee`; show a warning to anyone adding liquidity
  elsewhere and deprioritise those pools in routing if their reserves look drained.
- Never price from a vault ratio alone; always from an executed preview.

**If we later add our own liquidity (not in v1)**, the rules are: round every amount
against the caller; enforce a minimum trade/contribution size so rounding gain is always
below the fee; keep reserves in internal accounting, never infer price from vault
balances; no flash loans that can touch pricing state; independent audit before mainnet.

## Out of scope for v1

Own pools, escrow order book, partial fills, stop/trigger orders, margin, fiat.

## How orders are matched (since 21 Nov 2026)

Every order, market or limit, is a signed subintent filled by the solver. Each one carries two amounts:

- **the trigger** (`limitBuyAmount`): its price times its size. The solver fills the order once the
  market pays that much for the whole order. It is the price shown in the book. It is not signed:
  it is the user's instruction to the solver, and the server refuses a trigger below the signed minimum.
- **the signed minimum** (`minBuyAmount`): the trigger less the fee allowance (the network fee, about
  1 XRD, plus the service fee). The Radix Engine enforces it, and it is the figure the wallet shows.

So an order fills when the market reaches its price and the fees come out of the proceeds, as on an
exchange. "Fill only at my price" is the solver's promise; "never less than the minimum" is the ledger's.

On each pass the solver treats every open order as a taker, market orders first, then the newest.
For a taker it compares filling through pools alone with taking the best one, two or three resting
orders on the other side (whole orders only, each paid its own price less the service fee) and
sending the rest through pools, and uses whichever gives the taker most. It settles in one
transaction (`takeFillManifest`). The taker pays the network fee: 1 XRD, plus 0.35 XRD per resting
order taken (measured on Stokenet: 0.96 and 1.34 XRD).

A market order is the same subintent with a slippage floor as its minimum, a lifetime of three
minutes and `kind: "market"`. It never shows in the book and is never taken by another order.
Where no solver runs, the site falls back to an ordinary wallet transaction straight into the pools.

Known limits: orders still fill whole or not at all, so a taker smaller than a resting order cannot
take part of it; and a resting order is only taken when doing so beats the pools for the taker.

## Partial fills: the on-ledger order book (since 21 Nov 2026)

A signed order (subintent) can execute once only, so it can never be filled a part at a time.
Resting orders that fill in parts therefore live in a contract, `OrderBook`
(`scrypto/dex-contracts/src/order_book.rs`). This is a deliberate exception to "hold no user
funds": the tokens a maker is selling sit in the contract until sold or cancelled.

- **Placing** is a wallet transaction: the tokens go in, a receipt NFT comes back. The maker pays
  the network fee (about 0.8 XRD).
- **Filling** is open to anyone: `fill(id, payment)` hands over as many tokens as the payment
  covers at the order's price, rounding against the buyer, and pays the maker's account in the
  same transaction. The price is enforced by the ledger, not by our solver.
- **Cancelling** needs the receipt: it is burnt and the unsold tokens come back (about 0.6 XRD).
- The owner badge can set the maker fee for future orders (capped at 1%) and collect fees.
  It has no path to anyone's tokens.

The server reads the book from the ledger (component state and its key-value store) and trusts
nothing else about it. Book orders appear in the depth and in the maker's order list.

How they get filled:

1. **By takers.** When the solver fills a market order or a signed limit order it may buy from
   book orders as well as take signed orders whole and use pools, whichever leaves the taker
   most after the network fee. The taker itself still fills whole.
2. **By the solver, when a pool reaches the price.** A book order is paid its price and no
   more. When a pool pays more than the order asks, the solver buys from the order with its own
   funds, sells through the pool and keeps the difference, which is what pays the network fee.

Fees: `DEX_TAKER_FEE_BPS` (default 10) is charged to the order that takes liquidity;
`DEX_MAKER_FEE_BPS` (default 0) to a signed order when another order takes it. A book order's
maker fee is set in the contract and fixed for each order when it is placed.

3. **By the solver, when two book orders cross.** A buyer bidding at or above what a seller
   asks: the solver pays the seller with its own funds, passes the tokens to the buyer, and
   keeps the difference. Each order gets exactly its own price.

A book order's sales are read from the component's own events (`OrderFilledEvent`, accepted only
when the order book itself emitted them) and listed in the maker's trade history.

The automated tests use a second order book (`orderBookTest` in the keys file) that the test
site's solver does not watch, so they neither race that solver nor trade against orders placed
on the site. They still share the test pool; `scripts/stokenet-set-price.ts` puts its price back.

Not done: a signed limit order is not split across fills.
