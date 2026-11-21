# Security audit, 21 November 2026

Scope: commit `c13042b` on `main`. Read-only review of `scrypto/dex-contracts` (order book and
registry; the unused `Pool` only skimmed), `packages/core`, `apps/server`, `apps/web`, the mainnet
scripts and the deployment as it runs today (`radix-dex-mainnet` user service). Tests (`npm test`,
34 pass), `tsc --noEmit` (clean) and `npm audit --omit=dev` were run. Nothing was sent to mainnet;
the only live probes were read-only requests to the Stokenet instance on 127.0.0.1:8789.

## Summary

| # | Severity | Where | Finding |
|---|---|---|---|
| H1 | High | `apps/server/src/solver.ts:124`, `packages/core/src/validate.ts:59` | Free, unlimited orders that are certain to fail on ledger: the solver never previews, and a cancelled order key can be reused on any number of orders. Drains the XRD float |
| H2 | High | `apps/server/src/solver.ts:264`, `:318-339`, `:218`, `:242` | Book orders in a token the attacker controls (freeze, recall or withdraw rule) make the solver's book-cross and arbitrage transactions fail every 60 s, for ever |
| H3 | High | `apps/server/src/app.ts:221`, `apps/server/src/marketdata.ts:101` | Orders may be for any token with a listed pool, and the network fee is charged in the bought token at that pool's price. An attacker's own token and pool make the solver pay real XRD for worthless fees, as often as it likes |
| M1 | Medium | `apps/server/src/solver.ts:289-290`, `:135-140` | When a fill that used other users' signed orders fails, those users are blamed. An attacker can get any resting signed order dropped after three failures |
| M2 | Medium | `apps/server/src/solver.ts:318-347`, `apps/server/src/book.ts:243`, `app.ts:149` | Cheap denial of service: book spam makes every 5-second pass do O(n²) work and several Gateway previews per order; `/api/quote` lets anyone multiply Gateway load |
| M3 | Medium | `apps/web/src/Orders.tsx:63`, `apps/web/src/OrderForm.tsx:15-18` | A signed limit order (up to 30 days) can only be cancelled from the browser that made it, and only on the server. The on-ledger hard cancel exists but the site never offers it |
| M4 | Medium | `scripts/run-mainnet.sh:9`, systemd user unit | The mainnet solver runs as `jon` from the working tree, without the sandbox in `deploy/radix-dex.service`. Any process running as `jon` (npm install scripts, dev tools, agents) can read the key |
| L1 | Low | `packages/core/src/orders.ts:179-183` | Input a pool hands back unswapped is swept to the solver, not the user |
| L2 | Low | `apps/server/src/solver.ts:264`, `packages/core/src/orderbook.ts:270` | Book arbitrage and book cross use no expiry margin, so an order about to expire costs a failed transaction |
| L3 | Low | `packages/core/src/tx.ts:266-277`, `solver.ts:135` | A fill that commits after the 60 s wait is recorded as a failure; the order can end up "cancelled" though it filled |
| L4 | Low | `apps/server/src/http.ts:44-50`, `:61`, `:73-82` | Rate limiter is wiped for everyone once 10,000 addresses are seen (easy with IPv6); no CSP, frame-ancestors or HSTS from the origin |
| L5 | Low | `apps/web/src/OrderForm.tsx:161`, `format.ts:52-58` | Buy prices for book orders are inverted in floating point and cut to 12 decimals: the signed price can differ from the price typed |
| L6 | Low | `apps/web/src/OrderForm.tsx:153-156`, `packages/core/src/orders.ts:60-70` | The direct-to-pool fallback signs whatever route the server returns and asserts the route's last token, not the token the user chose |
| L7 | Low | `scrypto/dex-contracts/src/order_book.rs:170`, `:292` | Order book: the owner can raise the maker fee (up to 1%) between page load and a maker's `place`; anyone can name any account as `maker` |
| I1 | Info | `scrypto/dex-contracts/src/order_book.rs:119` | Shared per-token vaults: a token issuer's recall or freeze is spread over every order in that token, first come first served |
| I2 | Info | `scrypto/dex-contracts/src/order_book.rs:127` | Anyone can instantiate an identical-looking `OrderBook` or `Pool` from the published package |
| I3 | Info | `packages/core/src/solver.ts:82-91` | A user can all but avoid the service fee by signing a minimum equal to their trigger |
| I4 | Info | `npm audit` | 2 high, 1 moderate, 3 low; none reachable in a way that matters today |
| I5 | Info | `docs/DESIGN.md:77` | The design says the solver previews every fill before submitting. It does not |

Counts: Critical 0, High 3, Medium 4, Low 7, Info 5.

**The order book contract.** I found no way to take escrowed tokens without paying the maker's
price, no rounding that favours the taker, no path for the owner to reach makers' tokens, and no
way to cancel or claim someone else's order. The re-entrancy concern does not apply: the only
outgoing call is `try_deposit_or_refund` on a native `Account`, which cannot call back. The
findings against it are L7 and I1, which need user-facing warnings, not a new contract.

**The solver float is the money at risk.** H1 to H3 each let an outsider spend it on network
fees at little or no cost to themselves. They share two causes: the solver submits without
previewing, and it fills orders in tokens nobody has vetted. Fix those two and most of H1 to M2
goes with them.

---

## High

### H1. Orders built to fail cost the attacker nothing and the solver a network fee each, without limit

**Where:** `apps/server/src/solver.ts:124-128` (submit, no preview), `:135-142` (three strikes per
*order*), `packages/core/src/validate.ts:59` and `:66` (any 32-byte order key accepted),
`apps/server/src/app.ts:241` (50 open orders per *account*).

**What is wrong.** `Solver.submit` builds, notarises and submits; there is no preview. A root
transaction locks its fee first, so anything that fails after that is committed as a failure and
the solver pays for it. The server has three ways in which a signed order passes every check and
then fails on ledger:

1. **A dead order key, reused.** The order key is chosen by the client and is not checked for
   uniqueness or against the registry. An attacker calls `registry.cancel(secret)` once, then
   signs any number of orders using `hash(secret)` as their key. Each one fails at `assert_live`.
2. **An account the key no longer controls.** Validation proves the signature comes from the key
   the account address was derived from. If the account has since been securified (owner role
   moved to an access controller), `withdraw` fails on ledger. `funded()` only checks the balance.
3. **Funds moved away** between the balance check and commit (a race, less reliable).

The three-strike rule is per order. Signing is free, so the attacker simply submits new orders.
`maxOpenOrdersPerAccount` (50) caps concurrency per account, not the total, and a fresh
account needs only enough balance for `funded()` to pass, which all its 50 orders can share.

**Scenario.** One cancel transaction (well under 1 XRD). Then, from each of a handful of accounts
holding about 10 XRD, 50 "market" orders selling 10 XRD with a tiny minimum, so each is fillable
at once; market orders also start a solver pass immediately (`app.ts:249`). Each order costs
the solver three failed transactions over about 21 minutes (back-off 1, 4, 16 min). At an
estimated 0.1 to 0.3 XRD per failure (not measured; failure happens early in the transaction),
five accounts burn about 75 to 225 XRD in 21 minutes and repeat. The 250 XRD float is gone
within the hour and the site stops filling.

**Fix.**
- Preview every root transaction (the Gateway's V2 preview takes subintents) and submit only if
  it succeeds. A failed preview costs nothing. This alone closes H1, H2 and most of L2.
- Refuse a submission whose order key is already in the store or already cancelled on ledger
  (`is_cancelled`), and refuse duplicate keys outright: a fresh key per order is what the site
  does anyway.
- Count failures per account (and per signing key), not per order: after N failed fills, stop
  accepting orders from it for a day.
- Add a circuit breaker: if failed-transaction fees in the last hour exceed, say, 10 XRD, stop
  submitting and alert.

### H2. Book orders in an attacker's token make book arbitrage and book crossing fail every minute, for ever

**Where:** `apps/server/src/solver.ts:264` (`liveBook` takes every order in the component, any
token), `:318-339` (book cross), `:192-247` (arbitrage), retry after 60 s at `:218`, `:242`,
`:334`, with no limit on the number of retries.

**What is wrong.** The solver will buy from any order in the on-ledger book, whatever tokens it
trades. A token's creator can stop withdrawals from the order book's vault of that token after
placing the order: by freezing the vault, by recalling from it, or by changing the token's
withdraw rule. The server's copy of the book still shows the order as open with tokens
remaining, so each new attempt looks profitable. Failed book purchases are retried after 60
seconds, without end, and never previewed.

**Scenario (no pool needed).** The attacker creates token T with a freezer role, and places two
book orders: sell T for XRD at price p1, and sell XRD for T at price p2, with p1 × p2 well below 1,
so the solver's off-ledger planning (`planBookCross`) sees more than 1 XRD of profit. Then the
attacker freezes the order book's T vault. Every 60 s the solver submits a cross: it withdraws
XRD, pays into the first order, and fails taking T out of the frozen vault. Each failure costs a
network fee. One pair is about 1,440 attempts a day; several pairs multiply that. The attacker
pays two `place` transactions and one freeze. The same works through `arbitrage` if the attacker
also lists a pool for T (see H3 for how cheap that is).

**Fix.**
- Only consider book orders whose two tokens are on an allow-list (the tokens of the markets the
  site lists), and refuse tokens whose recall, freeze, withdraw or deposit roles are not locked
  to deny-all. Read the roles from the ledger once per token and cache them.
- Preview before submitting (as H1).
- After two failures on a book order or pair, skip it until the order changes on ledger; after
  more, skip it for good.

### H3. Fees are charged in any token, priced by any listed pool, including the attacker's own

**Where:** `apps/server/src/app.ts:221-251` (no check that `sell` and `buy` belong to a listed
market), `apps/server/src/marketdata.ts:101-112` (`xrdValueIn` prices the network fee through
any pool), `:69-86` and `packages/core/src/venues.ts:226-265` (a pool is listed if its venue API
says its TVL is at least $300).

**What is wrong.** The solver pays the network fee in XRD and recovers it, with the 0.10% fee,
in whatever token the order buys, valued at the best pool's current price. Creating an Ociswap
pool is permissionless; for a new token the venue's TVL figure comes from that pool's own price,
so about $150 of XRD plus some of the attacker's token lists it.

**Scenario.** The attacker creates token T and an Ociswap XRD/T pool with about $300 of
"TVL". They sign market orders selling a few XRD for T. Each fill routes the XRD into the
attacker's own pool (which the attacker can withdraw again as the only liquidity provider),
hands them T, and pays the solver its fee and about 1 XRD of network cost in T. The solver
spends real XRD each time and collects a token that only the attacker's pool will buy, and
which the attacker can drain by pulling liquidity. Orders are free to sign and fill in seconds,
so about 250 fills empty the float. The same pricing feeds `arbitrage` (`solver.ts:201`),
where a book order buying T lets the attacker repeat it through the book.

**Fix.**
- Accept orders only between tokens of the markets the site lists, and build those markets from
  a reviewed allow-list of tokens, not from venue TVL alone.
- Charge the network fee only in XRD or an allow-listed liquid token. If the bought token is
  anything else, swap the solver's cut to XRD inside the same transaction and assert a minimum,
  or refuse the order.
- Measure pool depth on ledger (XRD side) rather than trusting the venue's USD TVL.

---

## Medium

### M1. A failed fill blames the resting orders it used, so an attacker can get anyone's signed order dropped

**Where:** `apps/server/src/solver.ts:276-290` (`if (makers.length) blame = makers;`),
`:135-140` (three failures and the order is marked cancelled), `:292`.

**What is wrong.** When a fill that took other users' signed orders fails, only those makers get
a failure and a back-off; the taker is free to try again. The reasoning (a maker may have been
cancelled on ledger) is sound, but most causes of failure lie with the taker.

**Scenario.** A victim has a signed order selling 1,000 XRD for hUSDC. The attacker signs a
taker order buying exactly that, with a dead order key (H1), from an account that holds the
hUSDC. The best execution uses the victim's order; the transaction fails at the taker's
`assert_live`; the victim is blamed. Repeat three times, a few minutes apart, and the victim's
order is marked "Dropped after 3 failed fills". The victim's funds are safe, but their order
silently stops working, and the solver paid three fees.

**Fix.** Find out which order failed from the error (the child intent that failed is named in
the receipt) and blame only that one; with previews (H1) this can be done for free before
submitting. Do not count a failure against a maker unless the cause is theirs.

### M2. Book spam and open endpoints make denial of service cheap

**Where:** `apps/server/src/solver.ts:318-320` (`for first of liveBook()` / `for second of
liveBook()`, rebuilt for each `first`), `:343-347` (at least one Gateway quote per live book
order on every 5-second pass), `apps/server/src/book.ts:243-247` (every open order re-read on
each refresh), `apps/server/src/app.ts:149-161` (`/api/quote`, cache keyed on the exact
amount), `:180` (`/api/history`, one Gateway stream call per account).

**What is wrong.** Anyone may place book orders. A few hundred tiny orders in a listed market
(about 0.8 XRD each to place) make every solver pass run hundreds of Gateway previews and an
O(n²) planning loop on the Node event loop, which also serves the site. The public Gateway will
rate-limit the server's address, and quotes, depth and fills all stop. Separately, `/api/quote`
with a different amount each time runs up to four previews per request at 240 requests a
minute per client address.

**Fix.** Ignore book orders below a minimum value (say 5 XRD) for solving and display; cap the
number considered per pass; quote each market once per pass, not each order; compute the cross
loop over a price-sorted list per market. Round `/api/quote` amounts to a few significant figures
before caching, and give it a lower rate limit than the cheap endpoints. Consider running your
own Gateway (the config already allows it).

### M3. Signed limit orders can only be cancelled from the browser that made them, and only on the server

**Where:** `apps/web/src/OrderForm.tsx:15-18` (secret kept only in `localStorage`),
`apps/web/src/Orders.tsx:62-64` ("It will expire on its own"), no use of the registry's
`cancel` anywhere in `apps/web`.

**What is wrong.** A "Whole only" order can live 30 days. Its cancel secret exists only in one
browser's storage. A user who clears site data, changes browser or uses another device cannot
cancel it at all, and the cancel that does exist is a server-side delete, so it depends on the
server being honest and its database intact. The on-ledger hard cancel that the design relies on
(`registry.cancel(secret)`) is never offered.

**Scenario.** A user signs an order to sell at today's price for 30 days, the market rises, they
want out, and their browser has been reset. Their only option is to empty the account the order
draws on. A user who did cancel is still exposed if the server or its database were compromised.

**Fix.** Offer the on-ledger cancel (a wallet transaction calling `registry.cancel` with the
secret) alongside the soft cancel. Derive the secret deterministically so it can be recovered,
for example from a wallet-signed message and the order's parameters, or let users export their
secrets. Shorten the default and maximum lifetimes until this is done.

### M4. The mainnet solver key is exposed to everything that runs as `jon`

**Where:** `scripts/run-mainnet.sh:9` (`DEX_SOLVER_KEY_FILE=data/mainnet-solver.key`), the
`radix-dex-mainnet` user unit (`WorkingDirectory=/home/jon/Radix/dex`, no sandboxing),
`data/orders-mainnet.sqlite*` (mode 644 in a 775 directory).

**What is wrong.** The key file is correctly mode 600, is never logged, never served and is
git-ignored. But the service runs as `jon`, from the development working tree, with none of the
hardening in `deploy/radix-dex.service` (separate user, `ProtectHome`, `ProtectSystem`). Every
process `jon` runs can read the key: `npm install` lifecycle scripts of any dependency, editor
plugins, AI agents working in `~/Radix`. A leaked key lets the holder take the float and the
collected fees and fill every open signed order at its minimum instead of the market price.

**Fix.** Run mainnet from a separate checkout under the dedicated `radixdex` user with the unit
in `deploy/`, keeping the key in `/var/lib/radix-dex` (mode 600, owned by that user), and do
development elsewhere. Keep the float small and sweep fees often (`mainnet-withdraw.ts`).
Make the order database 600 as well: it holds every signed order.

---

## Low

### L1. Input a pool hands back is kept by the solver
`packages/core/src/orders.ts:179-183` ends every fill with `deposit_batch` of the whole worktop
to the solver. The quoter already allows for pools (DefiPlaza) returning part of the input
(`quote.ts:107-110`), but `poolIn` is still the full remainder, so the unswapped part of the
user's tokens goes to the solver. The user still receives at least their minimum and their
trigger, so this is an undisclosed extra charge, not a breach. **Fix:** send through the pool
only what the quote actually sold, or return leftover sell tokens through the taker's yield (that
needs the subintent template to accept two resources, so the simpler fix is the first).

### L2. No expiry margin for book arbitrage and book crossing
`solver.ts:264` uses `live(now)`, while taker fills use `nowSec + 30` (`orderbook.ts:297`). An
order expiring in the next few seconds is still bought from, and the transaction fails after
expiry. One failure per order, but an attacker can place many short-lived orders. **Fix:** use
the same 30-second margin.

### L3. A late commit is recorded as a failure
`submitAndWait` gives up after 60 s (`tx.ts:266-277`) while the transaction is valid for 120 s
(`solver.ts:112`). If it commits late, the order gets a failure, is retried, fails the funding
check and is eventually marked cancelled though it was filled; the user sees the wrong status.
No double fill is possible (a subintent commits once). **Fix:** on timeout, keep polling the
intent until its expiry passes before recording anything.

### L4. Rate limiter and response headers
`http.ts:48` clears the whole hit table when it holds 10,000 addresses, which an IPv6 client with
one /64 can trigger at will, resetting everyone's limit. The `cf-connecting-ip` header itself is
safe here because the server listens on 127.0.0.1 only and Cloudflare overwrites the header, but
any local process can bypass the limit. The origin sends no `Content-Security-Policy`,
`frame-ancestors`/`X-Frame-Options` or HSTS (confirmed on the Stokenet instance; Cloudflare may
add some). Static file serving is not open to path traversal (checked with `../` and `%2e%2e`). A
malformed path such as `/%E0` returns 500 and writes an error to the log, outside the rate limit.
**Fix:** evict expired entries instead of clearing; key IPv6 addresses by /64; add a strict CSP
(`default-src 'self'`, plus the wallet connector's origins), `frame-ancestors 'none'` and HSTS;
return 400 for undecodable paths.

### L5. Book buy prices lose precision in the browser
For a buy, the contract price is `1 / price`, computed in floating point and floored to 12
decimals (`OrderForm.tsx:161`, `toPlain`). For a base token priced around 2 × 10⁸ quote units
(wrapped bitcoin in XRD, for example) that leaves four significant figures, so the signed price
can be up to about 0.02% worse than typed; far higher prices are worse still. The wallet shows the
inverted figure, which few users can check. **Fix:** do the arithmetic with `Decimal` at 18
places, rounding in the maker's favour, and show the signed price per base token next to the
typed one.

### L6. The fallback market order trusts the server's route
When no solver runs, `OrderForm.tsx:153-156` signs `marketOrderManifest` with the route from
`/api/quote`, and `orders.ts:62` asserts the minimum on the route's *last* token, not on the
token the user picked. A compromised server, or anything altering the API response, could route
into a look-alike token and the assertion would pass. **Fix:** check in the browser that
`routePath(route, sell)` ends in `buyTok.address` and that every pool is in the market's own pool
list, and assert on `buyTok.address`.

### L7. Order book: fee timing and the free `maker` field
`set_maker_fee_bps` (`order_book.rs:292`) applies to orders placed afterwards, and the place
manifest (`orderbook.ts:177`) cannot pin the fee, so the owner could raise it (to at most 1%)
between a maker reading it and their `place` landing. Only the owner badge can do this, so the
risk is limited to the owner. Separately, `place` pays whatever account the caller names
(`order_book.rs:170`), so anyone can create orders "by" another account; the site then lists
them under that account's orders and history (`app.ts:189-191`, `book.ts:269`), and its cancel
button fails for them. **Mitigation (contract is immutable):** announce fee changes in advance and
keep the fee at 0; in the site, show only book orders whose receipt the connected account holds,
or mark the others as "placed by someone else".

---

## Information

### I1. Shared vaults spread an issuer's recall or freeze over every order in that token
All orders selling, or owed, the same token share one vault (`order_book.rs:119`). If a token's
issuer recalls part of that vault (for example to block one user's funds), the shortfall falls on
whichever orders in that token are last to fill or cancel; a freeze stops them all. Each order's
`remaining` and `unclaimed` are still honoured to the extent the vault holds them, and no other
token is affected. Makers can still use `claim` for unclaimed payments if the vault of the token
they sold is drained. **Mitigation:** in the site, warn before placing a book order in a token
whose recall or freeze role is not locked to deny-all, and say so in the order book's description.

### I2. Copies of the contracts can be made by anyone
`OrderBook::instantiate` and `Pool::instantiate` are public functions of the published package.
Anyone can create an order book with the same name and description and an owner fee of up to 1%.
The dApp definition's `claimed_entities` names the real one, which is right; mention the address
on the site so users can check what their wallet shows.

### I3. The service fee can be almost avoided
`planPoolFill` (`solver.ts:82-91`) cuts the fee to whatever lies above the user's minimum (plus
0.05%). A user who signs a minimum equal to their trigger pays nearly no service fee. That is a
revenue question, not a safety one, but the site could refuse orders whose minimum leaves no room
for the fee.

### I4. Dependencies (`npm audit --omit=dev`)
- `elliptic` (via `secp256k1`, via `@steleaio/radix-engine-toolkit`), high: concerns ECDSA
  signing. The server signs only with Ed25519, so not reachable here.
- `valibot` (via `@radixdlt/radix-dapp-toolkit`), high: a ReDoS in an emoji regex, in the browser
  only, with wallet-supplied data. Not a real exposure; take the toolkit update when it is
  non-breaking.
- `uuid` (moderate), three low: not reachable.

Note also that the transaction toolkit in use is `@steleaio/radix-engine-toolkit`, a third-party
build rather than the `@radixdlt` package. It sees the solver key at run time, so pin its exact
version and lock file hash, and review updates before taking them.

### I5. The design document overstates the solver's checks
`docs/DESIGN.md:77` says the solver "previews first and submits only if the preview succeeds".
It does not (H1). Update the document when previews are added, or now if they are not.

---

## Checked and found sound

- **Order book `fill`:** tokens sold round down at the sold token's divisibility, the cost rounds
  up at the paid token's, the cost is never more than the payment, and change is returned. A
  dust remainder is always sold for at least one smallest unit of payment. Expiry is checked to
  the second, and cancelling still works after expiry.
- **Order book `cancel` and `claim`:** exactly one receipt of the right resource is required; the
  receipt is burnt before state changes, so an order cannot be cancelled twice; `claim` reads the
  order id from a checked proof. A fully filled order's receipt is not burnt, so unclaimed payment
  stays reachable.
- **Owner powers:** `set_maker_fee_bps` (capped at 1%, existing orders keep their fee) and
  `collect_fees` (fee vaults only). The receipt resource's mint and burn are restricted to the
  component and locked; its metadata is locked.
- **Registry:** a key can only be cancelled by revealing its 32-byte preimage; no owner, no vaults.
- **Signed orders:** the server accepts only the exact template (compared after normalising both
  manifests), canonical encoding, one Ed25519 signature from the key the account address derives
  from, no children or blobs, and an expiry inside the window. A signed order can commit only
  once on ledger, and the store's primary key is the subintent hash, so it cannot be stored
  twice. It can never be filled below its signed minimum. The trigger (`limitBuyAmount`) is
  refused below the minimum, and the solver respects it before quoting (slippage after the quote
  is borne by the user, down to the signed minimum).
- **Manifest construction:** every address passes a strict bech32 pattern before being spliced
  in, amounts go through `dec()` (finite, non-negative, at most 18 places), bucket names are
  fixed, order ids are checked integers, and the order key is checked hex. No string from a user,
  a venue API or token metadata reaches a manifest unchecked.
- **Solver's own funds in book trades:** arbitrage and crossing end with
  `ASSERT_WORKTOP_CONTAINS` of at least what was spent (plus the fee, for arbitrage), so a moved
  pool or book can cost the network fee but not the principal.
- **HTTP API:** SQL statements are all parameterised; bodies are capped at 64 KB; public order
  views never include the signed bytes or the order key; soft cancel needs the preimage of the
  stored key; error responses do not leak internals.
- **Front end:** React escapes every token name and symbol; there is no `innerHTML`; token icons
  are not rendered; transaction links are built from ids the server read from the ledger.
- **Key handling in code:** the key is read only from a file, refused if group- or
  world-readable, generated with `randomBytes`, never printed, logged or served, and `data/` and
  `*.key` are git-ignored (nothing key-like is in the history).
- **Solver badge:** supply 1, no mint role, recallable by the owner badge with the recall rule
  locked, so recalling it does stop all signed-order fills for good.
