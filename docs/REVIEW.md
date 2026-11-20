# Radix DEX: review of prior art and assessment

Written 20 Nov 2026. Sources: three research passes (web, GitHub, DefiLlama, Radix Gateway)
plus the `radix` skill's guides and the `radixdlt-scrypto` / `radix-web3.js` source in `.repos/`.

Markers: **[V]** fetched or read from source that day · **[W]** from radix.wiki / caper.network
only, not independently checked · **[M]** inference.

## 1. The market you would be building for

| Measure | Value | Source |
|---|---|---|
| All Radix DEX TVL | about $230k | DefiLlama [V] |
| DEX volume 24h / 7d / 30d | $7.5k / $35k / $49k | DefiLlama [V] |
| DEX volume last 12 months / all time | $21.1m / $384.6m | DefiLlama [V] |
| XRD price | about $0.00095 (was ~$0.0004 a week earlier) | DefiLlama [V] |

- Volume was ~$118k/day in July, collapsed to $45–$250/day after the 31 Aug halt, and is
  now $2k–$9k/day.
- A 0.1% front-end fee on *all* Radix DEX volume is about **$5 a day**. This cannot be a
  business at today's volume. It can be a public good, a credible showcase for subintents,
  and a replacement for the CEX-style front end the ecosystem has just lost.
- Three incidents since August [W for the two later ones]:
  - 31 Aug: engine flaw, all Hyperlane-bridged assets drained, including from pools; halt
    until 11 Sep; fixed by the Eagle Ray protocol update (kernel receiver check) [V].
  - 27 Oct: 1.14m XRD taken from Ociswap's ASTRL/XRD Flex Pool with the pool's own flash loan.
  - 14 Nov: 14 more first-version Flex Pools drained, plus bitcoin pools on CaviarNine and
    DefiPlaza through a rounding flaw in the **native TwoResourcePool** (low-decimal assets).
- Infrastructure: Foundation in maintenance mode since May 2026; public Gateway and Connect
  relay funded only to **December 2026** [V]. Wallet (Android 1.22.3, 17 Nov), Sargon,
  Scrypto 1.4.0 and node 1.4.0.0 are still being maintained by a small group [V].

## 2. Venue by venue

| Venue | Type | Status | Code | Liquidity | Usable by a new front end? |
|---|---|---|---|---|---|
| **CaviarNine** | Bin CLMM (Shape), on-ledger order book, LSU pool | **Sunset** announced 19 Aug; site is withdraw-only; API and docs hosts dead; team moved to Canton | `caviarnine/caviarnine-scrypto`, **MIT**, incl. `order_book`, `quantaswap` | $109k, almost all LSU pool; flagship XRD/xUSDC pool holds ~$430 | Contracts live and permissionless, no royalties. But empty, unindexed, and admin badges still held by a departed team who can change the `user` rule |
| **Ociswap** | Basic (x·y=k), Flex, Precision (CLMM) | Live, team quiet (last GitHub push Mar 2025); quote API returned 502 all day | Pools **AGPL-3.0**; `scrypto-math`, `scrypto-avltree`, `scrypto-testenv` MIT; front end and router closed | ~$95k TVL, ~$3k/day; 17 pools above $1k | Yes for Basic and Precision: owner `DenyAll`, no royalties, `swap(bucket)`. Candle API (`/udf/history`) and `/pools` work. Avoid first-version Flex package |
| **DefiPlaza** | CALM single-sided AMM | Live, team still present | `OmegaSyndicate/RadixPlaza`, **MIT**, audited, 15 test files | $39k–$69k, ~$2k/day (currently the most active) | Yes: `PlazaDex.swap(bucket, output)`, `quote`; `/api/pairs` works. No candles |
| **Astrolescent** | Aggregator | Live; router closed | Closed | Routes across all AMMs | Yes: partner API returns a ready manifest; integrator fee supported (they keep 30%, or 0.1% if you set none). Single operator, key by request |
| **AlphaDEX** | On-ledger order book, one component per pair | Contracts and one API host alive; 3 trades/24h | Closed; JS SDK on npm (ISC, 2024) | ~$870 in total | Technically yes, and it pays front ends 0–0.1% via a platform badge. Not worth depending on |
| **DeXter** | Order-book front end on AlphaDEX | Dead (domain expired) | `DeXter-on-Radix/website`, GPL-3.0 with exceptions, Next.js | n/a | UI reference only |
| **Anthic** | Intent/RFQ via subintents + paid market makers | Dead (parked domain, API hosts gone); no evidence it ran on mainnet | `InfluxionLabs/anthic-sdk`, Apache-2.0 | n/a | Design reference for subintent orders |
| **Surge** | Perps | Abandoned | `surge-trade/perp-scrypto`, MIT | 0 | Keeper/trigger-order reference |
| **RSwap (Reddicks)** | x·y=k, 1% fee | Live, tiny | Not found | $6k–$14k | Via Astrolescent |
| **RadixPlanet** | AMM | Effectively dead | No licence | — | No |
| **Atomix** | — | **Not found on Radix.** Nothing by that name in DefiLlama, GitHub or the wikis. If you remember where you saw it, tell me | | | |
| `radixdlt/Ignition` | Liquidity programme (ended) | Apache-2.0 | Adapter blueprints giving one Rust interface to C9, DefiPlaza, Ociswap v1/v2 | | Useful pattern for a router |

### What the history says

1. **Every CEX-style venue died for want of liquidity, not for want of software.**
   CaviarNine's order book, AlphaDEX and DeXter all worked. An order book with no market
   makers is an empty screen; Anthic tried to buy market makers and stopped when the money did.
2. **An on-ledger order book taxes the maker.** Placing and cancelling each cost a
   transaction, and funds are locked in the book. That is a poor deal next to a CEX.
3. **Closed code and single operators die with their teams.** CaviarNine's front end and
   aggregator, AlphaDEX's contracts and Astrolescent's router are all closed. When the team
   leaves, the product leaves.
4. **New pool contracts are where the money gets stolen.** Flash loans, vault-ratio pricing
   and native-pool rounding all bit in the last four weeks. Holding other people's funds in
   new Scrypto is the single largest risk a new DEX could take on.
5. **Nobody on Radix has shipped subintents for trading.** Code search finds
   `sendPreAuthorizationRequest` only in the toolkit and xstelea's multisig/x402 work.

## 3. What subintents make possible

Verified against `radixdlt-scrypto` source (`transaction_validation_configuration.rs`,
`basic_subintents` scenarios) and the wallet schema in `radix-web3.js/packages/connect`.

A subintent ("pre-authorization" in the wallet) is a signed fragment of a transaction:
*"withdraw 1,000 XRD from my account, hand it to whoever wraps this, and fail unless I get
back at least 0.95 xUSDC."* It cannot be submitted alone. Someone else builds the root
transaction around it and pays the fee.

| Property | Fact | Consequence for a DEX |
|---|---|---|
| Signed off-ledger, returned to the dApp as hex | Wallet returns `signedPartialTransaction` + `subintentHash` [V] | **Placing a limit order is free and instant.** No transaction, no fee |
| Funds stay in the user's account until the fill | Withdraw happens inside the fill transaction | **Nothing is escrowed.** No order-book contract holds user money, so there is nothing to drain |
| User protection is in the manifest | `ASSERT_NEXT_CALL_RETURNS_ONLY` / worktop assertions [V] | The user's minimum price is enforced by the engine, not by trusting us |
| Root pays fees | Subintent cannot lock uncontingent fees [V] | **Gasless trading.** A user with only xUSDC can trade; the fee comes out of the proceeds |
| Up to 32 subintents and 64 signatures per transaction, depth 3 | [V] | Two users' crossing orders can settle against each other atomically, with pools filling the remainder |
| All-or-nothing, succeeds at most once | Finalised only on success; a failed wrap can be retried [V] | **No native partial fills.** An order fills whole or not at all |
| Expiry up to ~30 days, second granularity | Epoch range max 8,640; wallet clamps to it [V] | Good-till-date orders are possible |
| **No cancel instruction** | Header has no revocation field [V] | Cancellation must be designed in (below) |
| `VERIFY_PARENT <rule>` | Pins who may wrap it [V] | Stops a stranger who obtains the hex from filling it at the worst allowed price |
| Status API is thin | Gateway `subintent-status` returns only `Unknown` / `CommittedSuccess` [V] | The service must track order state itself |

Honest limits: the filler chooses the moment and keeps any surplus above the user's floor
unless the design gives it back; Ledger-device signing of pre-authorizations is unconfirmed;
the TypeScript Engine Toolkit may lack V2 builders (xstelea's `tx-tool` covers the gap).

## 4. Recommended design

**A CEX-style spot terminal that owns no liquidity and holds no user funds.**

- **Front end**: pair list, candle chart, depth/order book, recent trades, market and limit
  order entry, open orders, order history, balances. Open source.
- **Liquidity**: existing pools (Ociswap Basic + Precision, DefiPlaza, C9 Shape while it
  lasts), called directly from manifests through our own small router. AMM depth is
  rendered as order-book levels and merged with real resting limit orders, so the book is
  never empty.
- **Market orders**: an ordinary wallet transaction routed across pools, quoted by Gateway
  preview (not by anyone's quote API).
- **Limit orders**: subintents held by an off-chain order service. A solver fills an order
  when (a) a pool price reaches it, or (b) another user's order crosses it. Free to place,
  funds never leave the account, gasless.
- **Cancel**: instant "soft" cancel (the service drops it) plus a "hard" cancel that makes
  the signed order unfillable on ledger. This needs one very small Scrypto component (a
  cancellation registry the order checks before yielding). It holds **no funds**.
- **Data**: our own indexer builds trades and candles from the ledger, so nothing depends on
  Ociswap's or Astrolescent's APIs staying up. It can read your own node / thin gateway,
  which also covers the Gateway-funding risk.
- **Not in the first version**: our own pools, an escrow order-book contract, partial fills,
  stop orders, margin.

What makes it better than what came before: placing and cancelling orders costs nothing,
capital is not locked, the book shows real executable depth from day one, users need no XRD
for fees, and the only new on-ledger code holds no value.

What it costs: a backend (order store + solver) has to run somewhere, with a hot key holding
a small XRD float for fees. That key can never move user funds beyond what each signed order
permits.

## 5. Open risks

- **Viability**: revenue is negligible at current volume (section 1).
- **Regulatory**: operating an order-matching service may be a regulated activity where
  you are. Not assessed here; worth a view before a public mainnet launch.
- **Wallet behaviour**: how the wallet presents a pre-authorization that carries a
  registry call and `VERIFY_PARENT` is untested until we try it on Stokenet.
- **Pool safety**: the router must allow-list pool packages (no first-version Flex pools,
  care with native-pool pairs holding low-decimal assets).
- **CaviarNine**: its admin badges can still close the pools to callers.
- **Source of two incident reports** is a single community wiki.
