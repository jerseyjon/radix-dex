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
- Gateway URL is configuration, so it can point at Jon's own node / thin gateway.

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
