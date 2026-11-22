# Design

Working name: **radix-dex** (to be named). Background and reasons: [REVIEW.md](REVIEW.md).

## Principles

1. **Hold as little user money as possible.** Signed ("Whole only") orders and market orders
   leave the user's tokens in their own account until the fill, and the order registry stores
   hashes and nothing else. The one exception is the on-ledger `OrderBook`, which holds the tokens
   of "In parts" orders until they sell or are cancelled (see "Partial fills" below). Our own
   `Pool` is not deployed on mainnet.
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
scrypto/dex-contracts    OrderRegistry (hard cancel, holds no resources), OrderBook (resting
                         orders with partial fills, holds makers' tokens), Pool (not deployed
                         on mainnet).
```

### Venues (liquidity sources)

A venue adapter knows how to list pools, and how to write the manifest lines that swap a
bucket through one pool. It does **not** re-implement pool maths.

| Venue | Swap call | Notes |
|---|---|---|
| Ociswap Basic / Precision | `pool.swap(bucket)` | allow-listed packages only |
| DefiPlaza | `pair.swap(bucket)` on the pair component | can hand back part of the input when short of liquidity |
| CaviarNine Shape | `pool.swap(bucket)` | later; team gone, admin badge live |

### Quoting by preview

To quote "sell X of A for B on pool P" the server previews a real manifest on the Gateway
(`/transaction/preview`, free credit, signatures assumed) that withdraws A from a large
holder, swaps through P and reads how much B comes out. This is exact for every pool type,
including fees and tick crossings, and needs no pool maths of our own. Results are cached
for a few seconds by time, not by ledger state (quotes 8 s, depth 20 s).

**Depth ladder**: the same preview at a ladder of sizes on each side gives marginal prices,
shown as order-book levels and merged with resting limit orders.

**Best route**: v1 picks the single best pool, plus two-hop routes through XRD. Splitting
across pools comes later.

### Market orders

With a solver running, a market order is a short-lived signed subintent filled by the solver
(see "How orders are matched" below). Only where no solver runs does the site fall back to an
ordinary wallet transaction: withdraw, swap through the chosen pool(s), assert the minimum
received (`ASSERT_WORKTOP_CONTAINS`), deposit, with the user paying the network fee.

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
  resource, and keeps its charges, in XRD only (see "Fees: always XRD" below). Before sending, it previews that exact transaction, with the
  signed orders as children, on the Gateway's `/transaction/preview-v2` (no free credit, no
  assumed signatures) and sends it only if the preview succeeds. The toolkit cannot build a
  preview payload, so `previewTransactionV2Hex` in `packages/core/src/tx.ts` writes it out.
- **Outcomes**: each sent transaction is recorded before it goes out. If its outcome is not
  known (a timeout, a status error, a restart), its orders are not tried again until a later
  pass reads the outcome from the ledger; a committed fill is recorded even if the order had
  meanwhile been marked expired or cancelled.
- **Loss limit**: network fees paid on transactions that failed on ledger are summed over the
  last hour; past `DEX_FAILED_FEE_LIMIT_XRD` (3 XRD) the solver sends nothing until the hour has
  passed. Failed fills are counted per order (three and it is dropped) and per account (six in
  a day and its orders are refused and skipped).
- **Which orders**: only orders, and book orders, whose two tokens form a market the site lists.
  An order key may be used by one order only, and one cancelled in the registry is refused.
- **Price improvement**: the solver returns *everything* the route produced, less the
  configured fee and the network cost, not merely the user's minimum.
- **Which pairs**: XRD on one side, or a listed pool from each token to XRD. Orders in any other
  pair are refused at submission (400), and such orders already stored stay open with the reason.
- **Order vs order**: a taker takes up to four resting orders (signed or in the book) and
  pools for the rest, in one transaction.
- **All or nothing**: a subintent fills whole or not at all. The UI says so. Large orders
  can be placed as several slices (one signature each).

### Cancelling

- **Soft cancel**: the server marks the order cancelled and stops filling it. Instant, free,
  relies on the server. (A fill already in flight may still commit; the ledger then wins.)
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
cannot take anything a user has not signed for. The float is swept by hand with
`scripts/mainnet-withdraw.ts`.

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

## Out of scope for now

Our own pools on mainnet, stop/trigger orders, margin, fiat. (The escrow order book with partial
fills, once out of scope, is live: see below.)

## How orders are matched (since 21 Nov 2026)

Every order, market or limit, is a signed subintent filled by the solver. Each one carries two amounts:

- **the trigger** (`limitBuyAmount`): its price times its size. The solver fills the order once the
  market pays that much for the whole order. It is the price shown in the book. It is not signed:
  it is the user's instruction to the solver, and the server refuses a trigger below the signed minimum.
- **the signed minimum** (`minBuyAmount`): the trigger less the fee allowance (the network fee
  allowance for the route, which `/api/quote` gives as `gasAllowanceXrd`: the solver's estimate with
  a 25% margin, plus the service fee), as they apply on the side they are taken (below). The Radix
  Engine enforces it, and it is the figure the wallet shows. If the solver's estimate has since risen
  above the allowance, it still fills the order at its trigger as long as the allowance covers 75% of
  the estimate, and bears the rest itself.

So an order fills when the market reaches its price and the fees come out of it, as on an
exchange. "Fill only at my price" is the solver's promise; "never less than the minimum" is the ledger's.

### Fees: always XRD (since 22 Nov 2026)

The solver's charges, the network fee it pays plus the service fee (`DEX_TAKER_FEE_BPS`), are taken
in XRD and nothing else, so the exchange earns and holds XRD only (audit H3: before this, they were
taken in whatever token the order bought, which an attacker's own token made worthless).

| The order | Where the charges come from | What the user gets | Service fee on |
|---|---|---|---|
| buys XRD | the XRD it receives, after the swap (as before) | the proceeds less the charges | the XRD received |
| sells XRD | the XRD it sells, set aside before the swap | everything the rest of the XRD buys | the XRD sold |
| neither is XRD | between two swaps: token → XRD, charges, XRD → token | everything the second swap produces | the XRD from the first swap |

When the charges are set aside before the last swap, the order's trigger is applied to what is
actually swapped: the solver fills when the XRD left after its charges fetches at least the order's
price (`trigger × (base − charges) / base`, rounded down to the bought token's places), and at least
the signed minimum plus the usual 5 bp margin (`xrdLegNeeded`, `planXrdLegFill` in
`packages/core/src/solver.ts`). At the order's own price that is the same figure as before, so orders
signed under the old rule still fill (tested). If the full charges do not fit, the solver tries once
with less (down to its network fee less the 25% tolerance), quoting the pool leg again.

A pair with no XRD goes through a listed pool from each token to XRD, and only through pools:
other traders' orders are not used for it, and the solver does not buy book orders in it. A pair
with no such route is not filled at all.

Every solver transaction ends `ASSERT_WORKTOP_RESOURCES_ONLY { XRD }` before the solver sweeps the
worktop, so a transaction that would leave it any other token (a pool handing back input, change
from the order book) fails, in preview, for free. The same rule shapes the rest:

- A maker fee is charged only when it is paid in XRD (the taker sells XRD); otherwise the maker gets
  its full price.
- A taker buying XRD from book orders needs a pool leg to absorb any change the book hands back in
  the token it sells; without one, that plan is not used.
- The solver buys book orders with its own funds only when they want XRD (it pays XRD and sells what
  it bought back to XRD), and crosses two book orders only with XRD, only where the book's own sums
  leave no change in the other token (`planBookCrossExact`). Book orders that sell XRD for a token
  are left to takers.
- `/api/health` reports a problem when the solver's account holds any token other than XRD and its badge.

On each pass the solver treats every open order as a taker, market orders first, then the newest.
For a taker it compares filling through pools alone with taking the best one to four resting
orders on the other side (signed orders whole, each paid its own price less the maker fee; book
orders in part) and sending the rest through pools, and uses whichever gives the taker most. It
settles in one transaction (`takeFillManifest`). The taker pays the network fee, estimated as
0.7 XRD with no pool leg, or the pool swap's measured cost plus 0.5 XRD, plus 0.38 XRD per resting
order taken (`fillGasXrd`; on mainnet a fill costs 1.0 to 1.4 XRD).

Market orders are served first on each pass, and a new one is taken between resting orders
rather than waiting for the pass to end. Resting orders are capped per pass
(`DEX_MAX_RESTING_PER_TICK`) and taken in turns; one whose last look found the market more than
3% short of its price is looked at again only after a minute.

If a fill that used other traders' orders fails (in preview or on ledger), the solver does not
blame them on that alone: it holds them back for two minutes, uncharged, and tries the taker
again at once without them. A lone resting order is charged with the failure only if the taker
then fills without it; if the taker fails again, the failure is the taker's.

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
   Only for orders that want XRD: the solver spends and earns XRD alone.

Fees: `DEX_TAKER_FEE_BPS` (default 10) is charged to the order that takes liquidity;
`DEX_MAKER_FEE_BPS` (default 0) to a signed order when another order takes it, and paid in XRD (see
"Fees: always XRD"). A book order's
maker fee is set in the contract and fixed for each order when it is placed.

3. **By the solver, when two book orders cross.** A buyer bidding at or above what a seller
   asks: the solver pays the seller with its own funds, passes the tokens to the buyer, and
   keeps the difference. Each order gets exactly its own price. The solver fronts XRD to the order
   that sells a token for XRD, and only for amounts the book's sums settle with no change left.

A book order's sales are read from the component's own events (`OrderFilledEvent`, accepted only
when the order book itself emitted them) and listed in the maker's trade history.

The automated tests use a second order book (`orderBookTest` in the keys file) that the test
site's solver does not watch, so they neither race that solver nor trade against orders placed
on the site. They still share the test pool; `scripts/stokenet-set-price.ts` puts its price back.

Not done: a signed limit order is not split across fills.
