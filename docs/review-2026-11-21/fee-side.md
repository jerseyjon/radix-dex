# H3 fixed: the solver's charges are always XRD

Branch `fee-side`, from `overnight-all` (65f38cc). Not pushed, not deployed. 22 November 2026.

## The rule, and why

Audit H3: the solver paid the network fee in XRD and recovered it, with the 0.10% service fee, in
whatever token the order bought, valued at that token's best pool. Anyone can create a token and a
small pool, get it listed, and sign buys of it: each fill cost the solver 1 to 1.4 XRD and paid it in
a token only the attacker's pool would take.

The brief first asked for a "trusted fee-token list" (option A). The owner then changed the rule:
**the solver's charges must always end up as XRD; the exchange earns and holds XRD only.** That is
what is built:

| Pair | Where the charges (network fee + service fee) are taken | Status |
|---|---|---|
| 1. XRD on one side, order **buys** XRD | out of the XRD it receives, after the swap (as before) | built |
| 1. XRD on one side, order **sells** XRD | out of the XRD it sells, set aside before the swap; everything the rest buys goes to the user | built |
| 2(a). No XRD, but a listed pool from each token to XRD | the order goes token → XRD → token; the charges are taken in XRD between the two swaps | built |
| 2(b). No XRD route, one token on the fee-token list | take the charges in that token and swap them to XRD in the same transaction | **not built** (follow-up below) |
| 2(c). Anything else | not filled by the solver; refused at submission (400) with the reason; "In parts" book orders still available | built |

The "both tokens trusted" question of the original brief no longer arises: for XRD/hUSDC and every
other XRD pair the charges are always on the XRD side, whichever way the user trades.

### What enforces it

Every root transaction the solver sends now ends with

    ASSERT_WORKTOP_RESOURCES_ONLY Map<Address, Enum>(Address("<XRD>") => Enum<2u8>(Decimal("0")));
    CALL_METHOD Address("<solver>") "deposit_batch" Expression("ENTIRE_WORKTOP");

so a transaction that would leave the solver any token other than XRD fails, and since every
transaction is previewed first, it fails in preview, for free. Its charges themselves are taken with
`TAKE_FROM_WORKTOP <XRD>` only. This was exercised on Stokenet (fills, a book purchase and a book cross
all committed with it, including fills where no XRD at all is left at the assertion).

The same rule shapes the rest:

- **Maker fee** (`DEX_MAKER_FEE_BPS`, 0 today): charged only when paid in XRD (the taker sells XRD).
  When the taker buys XRD, the maker would be paid its fee in the other token, so it gets its full price.
- **Book orders taken by a taker that buys XRD**: the order book hands back rounding change in the
  token paid. That change now goes into the pool leg (`TAKE_ALL_FROM_WORKTOP` for the pool), so it
  reaches the user; a plan with change and no pool leg is not used.
- **The solver's own book purchases** (pool reaches a book order's price): only for book orders that
  want XRD. It pays XRD, sells what it bought back to XRD, and must end with at least its outlay plus
  the network fee. The old "pool first" variant (for a solver holding the other token) is no longer
  used: the book's change in the paid token would leave it holding that token. **So a book order that
  sells XRD for a token is no longer bought by the solver when a pool reaches its price; it fills when
  a taker comes.**
- **Crossing two book orders**: the solver fronts XRD to the order selling a token for XRD and passes
  all of that token to the order selling XRD for it. Only for amounts where the book's own sums (sold
  rounds down, cost rounds up) leave no change of the token: `planBookCrossExact` replays the
  contract's arithmetic and tries the largest amount and up to 300 smaller ones. Tested at 0, 6, 8
  and 18 places.
- **Pairs without XRD** (2(a)) use pools only: other traders' signed orders and book orders are not
  taken for them, and the solver does not buy book orders in them.
- **Pricing**: the solver no longer prices its charges in any other token. `MarketData.xrdValueIn`
  (the pool-price conversion) is now only used by `/api/quote` for the informational
  `gasInBuyToken` figures, so a manipulated pool can no longer change what the solver collects.
- **Operator check**: `/api/health` reports `solver holds N token(s) other than XRD` (503) when the
  solver account holds any fungible token other than XRD and its badge (checked at most every five
  minutes). Non-fungible tokens are not checked.

### The maths (packages/core/src/solver.ts)

- `chargeAt(sell, buy, xrd)`: `proceeds`, `input` or `hop`.
- `xrdCharges(base, gasXrd, feeBps)`: network fee + service fee on the XRD moved, **rounded down** to
  XRD's 18 places, so the solver never takes more than it states.
- Charges from the proceeds: unchanged (`planPoolFill`), now with the network fee in XRD directly.
- Charges set aside before the last swap (`input`, `hop`): the user receives the whole swap output.
  The fill must give at least `max(minimum × 1.0005, trigger × (base − charges) / base)`
  (`xrdLegNeeded`; the margin is dropped when there is no pool leg). The second term is the order's
  own price applied to what is actually swapped, rounded down to the bought token's places as a pool's
  output is. At the order's price that is the same figure the old rule needed.
- If the full charges do not fit (the signed allowance is short of today's estimate), the solver
  tries once with less, down to the network fee less 25% and no service fee, re-quoting the pool leg
  (`retryXrdTake`). This mirrors what `planPoolFill` always did on the proceeds side.
- Divisibility: the take is XRD (18 places); the bought token is never rounded by the solver at all
  on the `input`/`hop` side, since the user gets the pool's output as it is. Tested at 0, 6, 8 and 18.

The invariant every new solver test checks (with a small engine stand-in, `apps/server/test/ledger-sim.ts`,
that runs the solver's actual manifests): after any successful solver transaction the solver's balance
of every non-XRD token is unchanged, its XRD has risen by at least its network fee estimate (less the
25% tolerance), and by the estimate plus the service fee wherever the order's allowance covers them
(always for orders the form signs, except that the 5 bp safety margin above the minimum can eat into
the service fee on very large orders, exactly as before).

## The fee-token list (role changed)

It is no longer "tokens the solver may hold". It is "tokens that may be converted to XRD for fees"
under 2(b), which is not built, so today it is configuration and documentation only: committed
per-network default in `apps/server/src/config.ts`, overridable by `DEX_FEE_TOKENS`, published in
`/api/config` as `fees.feeTokens`.

**Default, mainnet: hUSDC and DFP2. Left out: xUSDC, xUSDT, hUSDT.** Stokenet: TUSD.

Evidence, read from the mainnet Gateway (`/state/entity/details`, `/extensions/resource-holders/page`)
and the live server's `/api/markets` and `/api/quote` on 22 Nov 2026:

| Token | Address | Evidence | In the list? |
|---|---|---|---|
| hUSDC | `resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv` | metadata "Hyperlane USD Coin", 6 places; dApp definition `account_rdx12ycz0wsuygqa5slye9du6e7wz7fr4pzx39l5r5cznqc6yudpks20cw` named "Hyperlane dapp definition", which claims this resource back (two-way link); supply 257,140; 543 holders; mint/burn Protected, freeze and recall DenyAll; listed on Ociswap and DefiPlaza against XRD; 10 hUSDC → 11,270 XRD (≈ $1 at XRD ≈ $0.00089). Already the repo's quote-priority stablecoin. | **Yes** |
| DFP2 | `resource_rdx1t5ywq4c6nd2lxkemkv4uzt8v7x7smjcguzq5sgafwtasa6luq7fclq` | metadata "DefiPlaza", 18 places; dApp definition `account_rdx12x2a5dft0gszufcce98ersqvsd8qr5kzku968jd50n8w4qyl9awecr` "DefiPlaza dapp definition", claims it back, websites defiplaza.net; supply 67,941,915, **minting DenyAll** (fixed supply), freeze/recall DenyAll; 2,384 holders; the hub of DefiPlaza (13 of the 50 listed markets are priced in it); DFP2/XRD is the second-deepest listed market (~$15k). **But DFP2 is DefiPlaza's own token, not a dollar token**: 10 DFP2 → 11.9 XRD, about $0.001 each. The brief described it as "DefiPlaza's dollar token"; please confirm you want it on the list as what it is. | **Yes**, flagged |
| xUSDC | `resource_rdx1t4upr78guuapv5ept7d7ptekk9mqhy605zgms33mcszen8l9fac8vf` | metadata "Wrapped USDC", 6 places, Instabridge dApp definition (`account_rdx1cxamqz2f03s8g6smfz32q2gr3prhwh3gqdkdk93d8q8srp8d38cs7e`, "Instabridge dapp definition", claims it back); supply 121,785; 1,821 holders; **freeze role Protected** (the issuer can freeze vaults). Only a DefiPlaza pool is listed: 10 xUSDC → 11,113 XRD, but 11,113 XRD → only 8.43 xUSDC (about 16% lost on a round trip), so the pool is thin and lopsided. The repo already excluded it ("its bridge is gone and it no longer trades near a dollar"). | **No** |
| xUSDT | `resource_rdx1thrvr3xfs2tarm2dl9emvs26vjqxu6mqvfgvqjne940jv0lnrrg7rw` | "Wrapped USDT", Instabridge-claimed as above; supply 25,064; 590 holders; freeze role Protected; only a ~$340 DefiPlaza pool, and it prices xUSDT about 15% above a dollar (10 xUSDT → 12,925 XRD). | **No** |
| hUSDT | `resource_rdx1th4v03gezwgzkuma6p38lnum8ww8t4ds9nvcrkr2p9ft6kxx3kxvhe` | "Hyperlane Tether USD", Hyperlane-claimed; **total supply 0.036292**, 30 holders; no listed market. Genuine but not in use. | **No** |

## Mainnet markets by case (live list of 50, read 22 Nov 2026)

| Case | Markets | Which |
|---|---|---|
| 1. XRD on one side | **37** | all the XRD-quoted markets, plus XRD/hUSDC |
| 2(a). Through XRD | **8** | ASTRL/DFP2, DFP2/WEFT, HIT/DFP2, EARLY/DFP2, REDDICKS/DFP2, HUG/DFP2, WOWO/DFP2, OCI/DFP2 |
| 2(b). Would need conversion (DFP2 on one side, the other token has no XRD pool) | **5** | DFP2/AND, FLOOP/DFP2, foton/DFP2, DFP2/RANTS, dgc/DFP2 |
| 2(c). Neither | **0** | |

As 2(b) is not built, the 5 markets in 2(b) behave as 2(c) on this branch: signed and market orders
refused, "In parts" available. The classification is worked out live from the listed pools (`solverFills`
in `/api/markets`), so it follows the market list as pools come and go.

## What differs for a user

At the same pool prices a user gets the same amount as before, give or take price impact (taking the
charges before the swap makes the swap slightly smaller, which slightly favours the user). What
changes is the token the fees are counted in, what the solver ends up holding, and which pairs are
filled. Figures below: network fee estimate 1.2 XRD (allowance 1.5 XRD for a limit order), service fee
0.10%, pools treated as a fixed rate.

**Buy 100 XRD worth of a small token** (pool pays 20 TOKEN per XRD).

| | Before | Now |
|---|---|---|
| Fees | 1.2 XRD valued in TOKEN at its pool (24 TOKEN) + 0.10% of 2,000 (2 TOKEN), taken from the TOKEN bought | 1.2 + 0.1 = 1.3 XRD, set aside from the 100 XRD; 98.7 XRD swapped |
| Market order: user receives | 2,000 − 26 = 1,974 TOKEN | 98.7 × 20 = 1,974 TOKEN (a little more in a real pool) |
| Signed minimum at 1% slippage | 1,954.26 | 1,954.26 |
| Whole-only limit at 0.05 XRD each (2,000 TOKEN for 100 XRD), signed minimum | 2,000 − 30 − 2 = 1,968 | 2,000 × (100 − 1.6)/100 = 1,968 |
| Solver ends holding | 26 TOKEN, which only the attacker's pool will buy (H3) | 1.3 XRD |
| Form shows | "Fees, taken from that: 26 TOKEN" | "Fees (taken from the XRD you spend): 1.3 XRD (≈ 26 TOKEN)", "Swapped: 98.7 XRD" |

**Sell a small token for XRD** (5,000 TOKEN, pool pays 250 XRD): unchanged. 250 − 1.2 − 0.25 =
248.55 XRD to the user; 1.45 XRD to the solver. The form now says "Fees (taken from the XRD you
receive)". If a resting signed order is taken and the maker fee were set above 0, the maker would no
longer pay it (it would be in TOKEN).

**XRD/hUSDC, selling 10,000 XRD** (pool pays 0.000887 hUSDC per XRD, 8.87 hUSDC in all).

| | Before | Now |
|---|---|---|
| Fees | 1.2 XRD ≈ 0.001064 hUSDC + 0.10% (0.00887 hUSDC), from the hUSDC bought | 1.2 + 10 = 11.2 XRD, from the XRD sold |
| User receives | 8.860066 hUSDC | 9,988.8 × 0.000887 = 8.860066 hUSDC |
| Solver ends holding | 0.009934 hUSDC | 11.2 XRD |

**XRD/hUSDC, buying XRD with 10 hUSDC** (pool pays 11,274 XRD): unchanged. 11,274 − 1.2 − 11.274 =
11,261.526 XRD to the user, 12.474 XRD to the solver.

**A DFP2-priced market without an XRD pool of its own, e.g. ASTRL/DFP2** (case 2(a)): an order now goes
ASTRL → XRD → DFP2 through the deepest XRD pool on each side, instead of the direct ASTRL/DFP2 pool,
with the charges taken in XRD between the swaps (network fee for two swaps, about 1.5 XRD, + 0.10% of
the XRD). If the direct pool is the better price the user now gets a little less; resting orders and
book orders in that market are not used to fill it. **DFP2/AND and the other 2(b) markets**: market
orders and "Whole only" limit orders are refused with "use Limit, In parts".

## Existing open orders

Nothing a user signed changes. The signed subintent yields its whole sell amount to the solver's
transaction and asserts only "this token, at least the minimum" on what comes back, so it works with
the charges taken on either side (checked by reading `limitOrderManifest`, and by test).

- **Orders selling a token for XRD**: exactly as before.
- **Orders selling XRD** (signed with an allowance worked out in the bought token): charged in XRD
  now; at the order's price the requirement is the same figure, so they fill when the market reaches
  their price, and never below their minimum. Tests: `apps/server/test/solver-xrd.test.ts` ("an order
  signed under the old rule…"), `apps/web/test/agreement.test.ts` (last test).
- **Orders in a pair with neither XRD nor a route through XRD**: left open, not filled, not
  dropped; the order list shows "Not filled by the exchange: its fees are taken in XRD, and this pair
  has no route through XRD. Cancel it, or use an 'In parts' order in the order book." They expire on
  their own. To see whether any exist on mainnet (read-only, as the owner, with the service running or
  not): `sqlite3 -readonly data/orders-mainnet.sqlite "SELECT sell, buy, count(*) FROM orders WHERE status='open' GROUP BY sell, buy;"`
  and compare with `solverFills` in `/api/markets`. I did not read the mainnet database.
- **Book orders that sell XRD for a token**: no longer bought by the solver when a pool reaches their
  price; they fill when a taker's market or limit order takes them. Book orders that want XRD are
  bought as before.

## New settings and API fields (all additive)

| Where | What |
|---|---|
| `DEX_FEE_TOKENS` | Comma-separated resource addresses for 2(b). Default per network in `config.ts`. Bad address or wrong network: start-up error. |
| `/api/config` | `fees: { token: <XRD>, takenIn: "XRD", feeTokens: [...], convertsFeeTokens: false }` |
| `/api/quote` | `feeAt`: `"buy"` (from XRD bought), `"sell"` (from XRD sold), `"hop"` (between swaps through XRD) or `null` (solver will not fill); `feeToken` (XRD or null); `gasXrd` (network fee estimate, XRD); `gasAllowanceXrd` (×1.25, what a signed order allows); `xrdBase` (the XRD the service fee is charged on). For a pair without XRD the quote is now along the route through XRD. `gasInBuyToken` and `gasAllowanceInBuyToken` are kept, still the same fee valued in the bought token, for older pages; they are no longer what is charged. |
| `/api/markets` | `solverFills` per market |
| `/api/orders` | open orders' `outlook` may carry `reason` |
| `/api/health` | `solver.otherTokens` (count) and the problem "solver holds N token(s) other than XRD" |
| `POST /api/orders` | 400 "This pair cannot be filled by the exchange: its fees are taken in XRD, and neither token is XRD nor is there a route through XRD. Use an “In parts” order in the order book instead." |

## Rule 2(b): the follow-up, if wanted

It would serve the 5 DFP2 markets whose other token has no XRD pool (and any similar future market).
What it needs:

1. In the fill: take the charges in the fee token (the side of the pair on the list: from the sale if
   that is the fee token, from the proceeds otherwise), then `swap` that bucket through the fee
   token's deepest listed XRD pool, and `ASSERT_WORKTOP_CONTAINS <XRD> <network fee + service fee>`
   before the final `ASSERT_WORKTOP_RESOURCES_ONLY`.
2. The amount to take: the XRD needed (fee estimate including the extra swap, about +0.5 to 0.9 XRD,
   plus the service fee), converted at a fresh quote of the fee token → XRD for that amount, plus a
   margin; any XRD above the need stays with the solver, so the margin must be small and stated, or the
   surplus returned through the pool to the user (which needs a second conversion and more cost).
3. The form needs the conversion quote too (`/api/quote` would return it), and the minimum maths for
   a fourth case. Tests as for the other cases, with the engine stand-in.
4. The extra swap costs the user about as much as the network fee itself on small orders; for the 5
   markets in question (TVL $316 to $759) most orders would be small.

It was left out because it adds a second price risk inside every such fill for 5 small markets, and
the brief allowed shipping 2(a) and 2(c) first.

## Deploy notes

The live site runs `main` at `c13042b`; `fee-side` is built on `overnight-all`, so deploying it also
deploys the overnight fixes (see `README.md` in this folder for that procedure).

1. **First, empty the solver of non-XRD tokens** collected under the old rule, or `/api/health` will
   report a problem from the first pass: `npx tsx scripts/mainnet-withdraw.ts` (preview, sends
   nothing), then the owner runs it with `--send`. It moves every token except XRD (above the 250 XRD
   float) and the badge to the owner account. Not run by me.
2. Back up the database (`npx tsx scripts/backup-db.ts data/orders-mainnet.sqlite data/backups`).
3. In the checkout: merge `fee-side`, `npm ci`, `npm test`, `npm run typecheck`, `npm run build -w apps/web`,
   then restart `radix-dex-mainnet`.
4. Check: `/api/config` has `fees.takenIn: "XRD"`; `/api/health` is `ok` with `solver.otherTokens: 0`;
   a quote for an XRD → token pair says `feeAt: "sell"`.
5. No database change. No new setting is needed (`DEX_FEE_TOKENS` defaults per network).
6. Roll back by checking out the previous commit, rebuilding and restarting; nothing on ledger or in
   the database depends on this branch.

## Verification done

- `npm test` (123 tests), `npm run typecheck`, `npm run build -w apps/web`: pass at every commit.
- Stokenet end to end, from this branch, one at a time, pool price restored to 0.095 afterwards:
  `stokenet-server-e2e.ts` (charges from XRD bought and from XRD sold, no maker fee in TUSD, solver
  TUSD unchanged, a pair with no XRD route refused), `stokenet-pool-e2e.ts` (a buy of TUSD with XRD
  charged on the XRD sold; the solver kept 1.15 XRD of the order, 0.19 XRD net of its fee),
  `stokenet-book-e2e.ts` (solver buys a TUSD-selling book order with XRD and leaves an XRD-selling one,
  crosses two book orders with XRD alone, solver TUSD unchanged). All passed.
- The order form, in a browser, against a scratch Stokenet server: market buy and sell, whole-only
  limit buy and sell; fee rows match `/api/quote`.

## Not tested, or worth a second look

- No wallet: nothing was signed through the form. The form's sums are covered by the agreement tests.
- A real pair through XRD (2(a)) and a refused pair in the browser: Stokenet lists only XRD/TUSD.
  Covered by unit and API tests, and the refusal by the server e2e.
- 2(a) fills use three previews per attempt (whole route, each leg); fine for 8 small markets.
- The solver's retry with a smaller take estimates from one quote; the preview is what stops a wrong
  estimate, so the worst case is a skipped fill, not a loss.
- Market orders in a 2(c) pair are refused rather than falling back to a direct wallet swap (no
  solver fee there), which would be a kinder follow-up.
- The Stokenet test site shares the e2e solver account, so the TUSD-unchanged checks there could trip
  if that site filled something during a run. It held two non-XRD tokens from earlier fills (that is
  expected for Stokenet and would show in its `/api/health`).
