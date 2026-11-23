# The owner's own pools on mainnet ("DIFD pools")

Runbook for putting the owner's own split OwnerPools on mainnet: a cold owner badge in the owner's
wallet, a hot operator badge held by the market-making bot, and the read-only watcher beside it.

**Nothing in this repository sends a mainnet transaction for this.** `scripts/mainnet-owner-pool.ts`
builds each owner transaction, previews it against mainnet, and writes it to
`data/mainnet-pool/mainnet/` for the owner to sign in his own Radix Wallet. `--send` with
`--network mainnet` is refused before anything else runs. The same builders were run end to end on
Stokenet with the throwaway test keys (below), so every manifest shape here has committed on a ledger.

Background: the contract and its audits, `scrypto/owner-pool/src/lib.rs` and
`docs/review-2026-11-21/owner-pool-split-design.md`; the bot, `docs/owner-pool-bot.md`; the first
Stokenet run, `docs/review-2026-11-21/owner-pool-split-stokenet.md`.

## Contents

1. Decisions the owner makes first
2. Prerequisites
3. How the script works
4. The steps, in order
5. Starting the bot: dry run, then sending
6. Emergency stop
7. Reading the markout summary
8. Unwinding everything
9. Costs
10. What was proven on Stokenet (23 Nov 2026)
11. What could not be previewed on mainnet, and why
12. Changes needed in files outside this work
13. The Pools page on the site

## 1. Decisions the owner makes first

| Decision | Recommended | Why |
|---|---|---|
| **Pairs** | XRD/hUSDC only, to start | The bot's reference reads only XRD/hUSDC venues (`scripts/owner-pool-sources.ts`). An XRD/LSULP pool can be set up with this script, but no bot can run it until LSULP venues are added (section 12) |
| **Amounts** | Owner's call. A curve the size he would be content to see traded against; the rest in the inventory or, better, in the cold account | The loss bound for a stolen operator key scales with the curve's size: sqrt(cap A x cap B) |
| **Owner badge** | A NEW badge just for the pools (`badge`), not the DEX order book's owner badge | The DEX badge passes the badge rules and could be adopted (`badge --use resource_rdx1t4jaj92l…`), but one badge would then control both the order book and every pool. The pool owner badge is permanent: `OwnerRole::Fixed`, it can never be rotated |
| **Launch fee** | 50 bps | The owner's choice |
| **Operator fee range** | 50-150 bps (`--min-fee 50 --max-fee 150`) | The bot's single-venue caution adds 50 bps. On 23 Nov only Ociswap precision qualified as a venue (CaviarNine's hUSDC side empty, Ociswap basic and DefiPlaza above the 1% venue-fee limit), so the bot will be in single-venue caution from the start: its target is base 50 + 50 = 100 bps (seen in the Stokenet dry run). A top of 100 leaves it no room to widen for volatility or for being behind; 150 does |
| **Budget** | 3% (300 bps) per window | The owner's choice |
| **Window** | 144 epochs (12 h) | Mainnet epochs measured 5.02 minutes on 23 Nov 2026 (Stokenet 5.03). The design's 72 epochs assumed ~10-minute epochs; 144 keeps the same 12 h. A shorter window refills the budget faster, which helps the bot and a thief equally |
| **Caps / floors** | Caps = reserves +10%, floors = 50% of reserves (the script's defaults, computed from the pool when `limits` runs) | Design Q2/Q3: the operator cannot grow the curve past what the owner put there, nor shrink it below half |
| **Sweep the fees?** | Not at first | Swap fees stay in the reserves and deepen the curve. Taking them out is an owner `withdraw` of a proportional amount (`withdraw --a <XRD>`, B computed so the price does not move). The bot's `--side balanced` steers back towards the depth at its first start, so frequent sweeps are not needed |
| **Alerts** | The existing valwatch ntfy topic (owner's choice) | Its URL is not in this repository (section 2). REQUIRED: the bot refuses `--send` without one and without a delivered start alert, and the mainnet watcher refuses to start without one. Note the review's warning: anyone who knows an ntfy.sh topic name can read and post to it |
| **CoinGecko brake** | On (the owner's decision, 23 Nov 2026) | Never a price: when the ratio on-ledger reference / CoinGecko moves more than 2% from its 24 h median, the bot does not rebalance; it never pauses the pool for it. Mainnet `--send` refuses to run without CoinGecko watched. `docs/owner-pool-bot.md`, "CoinGecko brake" |
| **Where the bot runs** | Owner's call (the DEX server box is the obvious place) | The operator key lives there. The watcher and the heartbeat check should ideally run elsewhere; the watcher then needs the bot's sent log shipped to it, or `--no-sent-log` (its `not-bot` rule off, said at start). A sent log on the bot's host can be forged by a thief on that host; the watcher's behavioural rules do not depend on it |

## 2. Prerequisites

- **The owner badge in cold storage.** After `badge` commits, the badge sits in the owner account
  `account_rdx12xknv0…5f6mnz`. Every owner step below proves it from that account, so that account
  must be one the owner can sign with in the wallet (a Ledger-backed account is ideal). Never send
  the badge to a hot machine.
- **hUSDC.** The owner holds 0.002122 hUSDC (23 Nov 2026). The pool's B side has to be bought first.
- **An operator account with ~20 XRD for network fees.** The bot's transactions cost 0.37-0.51 XRD
  each and it sends at most 12 an hour (`--max-tx-per-hour`). `appoint --fund 20` sends the 20 XRD
  with the badge. The operator account is a key file on the bot's machine:
  `tsx scripts/mainnet-owner-pool.ts operator-key --create` writes `data/mainnet-owner-pool-operator.key`
  (mode 600, refuses to overwrite) and prints the account. **Not run: it creates a mainnet key, which
  needs the owner's approval.** Without it, `appoint` previews with a stand-in account and says so.
- **The alert URL.** The valwatch topic's URL is the `ntfy_url` line of `/etc/valwatch.conf` on the
  valwatch host (DIFD5). Copy it into `~/.config/radix-dex/owner-pool.env` (from
  `deploy/owner-pool.env.example`, mode 600) as `OWNER_POOL_BOT_ALERT_URL`. Nothing has been posted to it.
- The checkout with `npm ci`; `data/contracts/owner_pool.wasm` and `.rpd` present (the script checks
  they are the build proven on Stokenet: wasm sha256 `16aed69e…f6acb0dd`, rpd `d84ab4b6…ef54b8d5`,
  code hash `0b460d5f…446a7872`).

## 3. How the script works

```
npx tsx scripts/mainnet-owner-pool.ts <step> [options]            # mainnet: write + preview, never send
npx tsx scripts/mainnet-owner-pool.ts <step> --network stokenet [--send]   # the same builders on Stokenet
```

Each step:

1. reads what it needs from the ledger (the pool's reserves, limits, the market price);
2. builds the manifest with the shared builders (`packages/core/src/ownerpool-ops.ts`,
   `ownerpool-setup.ts`), with **no `lock_fee`** on mainnet (the wallet adds its own);
3. previews it on mainnet (Gateway `/transaction/preview`, the owner's real account, signatures
   assumed): a step whose preview fails exits 1;
4. writes `data/mainnet-pool/mainnet/<pool>/<NN>-<step>.rtm` (what to sign) and `.json` (the
   preview: success, fee, every account's withdrawals and deposits, what the ledger must show after);
5. prints the manifest, the fee and **what the wallet will ask the owner to approve** (the badges
   proved, the tokens leaving and arriving), then the command to run once it has committed.

The owner signs the `.rtm` at <https://console.radixdlt.com/transaction-manifest> with the owner
account connected, then:

```
npx tsx scripts/mainnet-owner-pool.ts record <txid> --step <step>
```

`record` reads the committed transaction, records what it created (badge, package, pool, operator
badge), and compares the pool on ledger with what the step set (reserves, inventory, fee, pauses,
operator, anchor, limits). A mismatch is printed and exits 1. Reserves can also differ because a swap
landed after the transaction: look at the pool's history before acting on that.

**Sign soon after staging.** Steps guarded by the reserves (`deposit`, `withdraw`, `anchor`,
`owner-rebalance`) fail on ledger with "Reserves moved" if anyone trades in between: that costs only
the fee. Run the step again and sign the new file.

State (no secrets) is `data/mainnet-pool/mainnet.json`; `status` prints it with the pool on ledger and
the operator's allowance now. `--name <pool>` picks the pool (default `xrd-husdc`).

## 4. The steps, in order

Check after each step, on the ledger (`status`, or the dashboard for the pool component) and, once the
bot is installed, in its dry run (`journalctl --user -u owner-pool-bot`).

| # | Command | The owner signs | Check afterwards |
|---|---|---|---|
| 0 | `check` | nothing | files match the Stokenet build; balances; hUSDC has no recaller/freezer (its minter/burner belong to the bridge: issuer risk the owner accepts); the market price |
| 1 | `simulate` | nothing (preview only) | badge + publish + instantiate in ONE mainnet preview joined by allocated addresses: succeeds |
| 2 | `badge` | `_setup/NN-badge.rtm` | `record <txid> --step badge`: one new resource, divisibility 0, supply 1, nobody can mint, freeze or recall it |
| 3 | `publish` | publish `data/contracts/owner_pool.wasm` + `.rpd` at <https://console.radixdlt.com/deploy-package>, owner role **None** (as for the DEX package) | `record <txid> --step publish`. Then add the package to `OWNER_POOL_PACKAGES.mainnet` in `packages/core/src/ownerpool.ts` and commit (the bot, the watcher and the router refuse any pool whose package is not listed) |
| 4 | `instantiate --a <XRD> --b <hUSDC> --fee 50` | `xrd-husdc/NN-instantiate.rtm` | the seed price is checked against the market first (refused beyond `--max-gap`, 1%); `record`: reserves exactly the seed, fee 50, no operator, the owner badge as owner. **Swaps are open from this moment** |
| 5 | `pause` | `NN-pause.rtm` | owner pause on. Recommended straight after step 4 unless the bot starts within minutes: an unattended curve at a fixed price is free money for arbitrage if the market moves |
| 6 | `inventory --a <XRD> --b <hUSDC>` (optional) | `NN-inventory.rtm` | inventory as given; reserves unchanged |
| 7 | `operator-badge` | `NN-operator-badge.rtm` | a second badge in the owner account, same rules |
| 8 | `limits --window 144 --min-fee 50 --max-fee 150` (any field as `key=value`) | `NN-limits.rtm` | limits as printed; caps/floors from the reserves at that moment |
| 9 | `appoint --anchor market` (or `--anchor 1:<hUSDC per XRD>`) `--operator-account <acct> --fund 20` | `NN-appoint.rtm` | operator = the new badge, anchor as stated (the allowance starts at 0 and refills over the window); the badge and 20 XRD in the operator account |
| 10 | install and start the bot and the watcher in DRY RUN (section 5) | nothing | the bot's start line `venue-guard` ok; each tick reads the owner's anchor from the ledger, the reference, a decision; previews succeed |
| 11 | `unpause` | `NN-unpause.rtm` | owner pause off; the router quotes the pool once it is listed |
| 12 | going live: the committed allow-list change in section 5, then `OWNER_POOL_BOT_FLAGS=--send --mainnet-live` | nothing | the bot's start alert arrives (it refuses otherwise); its first rebalance and fee change on ledger; the watcher shows them as the bot's (no `not-bot`, `move-away` or `fee-outside-rule`) |

Later, as needed: `deposit`, `withdraw`, `withdraw-inventory`, `anchor` (restate when the market moved
more than 5% and the bot paused itself; zeroes its allowance), `fee`, and

```
npx tsx scripts/mainnet-owner-pool.ts limits-fee --fee <bps> [key=value ...] [--keep]
```

which changes the limits AND the fee in one transaction. On Stokenet, lowering the operator's maximum
fee did not clamp the fee already in force, so a narrower range must carry a fee inside it; the
builder refuses a fee outside the new range. `--keep` starts from the limits on ledger instead of the
defaults, so only the named fields change.

## 5. Starting the bot: dry run, then sending

Units (not installed): `deploy/owner-pool-bot.service`, `deploy/owner-pool-watch.service`, environment
`deploy/owner-pool.env.example`.

```
install -d -m 700 ~/.config/radix-dex
install -m 600 deploy/owner-pool.env.example ~/.config/radix-dex/owner-pool.env   # fill in: alert URL, pool, operator badge
cp deploy/owner-pool-bot.service deploy/owner-pool-watch.service deploy/owner-pool-heartbeat.service deploy/owner-pool-heartbeat.timer ~/.config/systemd/user/   # adjust WorkingDirectory
systemctl --user daemon-reload
systemctl --user enable --now owner-pool-bot owner-pool-watch owner-pool-heartbeat.timer   # the bot first: it creates the sent log the watcher requires
journalctl --user -u owner-pool-bot -f
```

The bot runs `--network mainnet --scale 1 --base-fee 50` with the operator key (the watcher with
`--bot-base-fee 50`, so its `fee-outside-rule` bounds match), and **in dry run**
while `OWNER_POOL_BOT_FLAGS` is empty: it reads, decides, previews every transaction it would send,
logs one JSON line per tick, and sends nothing. Before going live, check in its log:

- `venue-guard` ok, and the venues used (`reference.venues[].used`); `single-venue` caution if only one;
- `ownerAnchor` = the anchor stated at step 9, `distance` small;
- `decision` reasonable for the gap between the pool and the reference, and its previews succeeding;
- `fee.target` within the range (expect 100 with one venue);
- `referenceMedian` warmed up (3 readings) and `brake.mode` going from `warmup` to `normal` after an
  hour, `brake.ratio` steady (about 0.97 on 23 Nov), `mainnetGateway.lagSec` well under 120;
- the heartbeat files in `data/heartbeat/` refreshed every minute, and `journalctl --user -u
  owner-pool-heartbeat` showing `alive: true`;
- no `refused` or tick errors.

A one-off check by hand, same flags: `npx tsx scripts/owner-pool-bot.ts --once --network mainnet
--pool <pool> --badge <operator badge> --key data/mainnet-owner-pool-operator.key --scale 1 --base-fee 50
--state data/owner-pool-bot-mainnet-state.json --sent-log data/owner-pool-bot-mainnet-sent.jsonl`.

**The guard** (since 23 Nov 2026, the review's conditions; `sendGuardProblems` in
`packages/core/src/ownerpool-guard.ts`). `--send` with `--network mainnet` is refused, before any key is
read, unless ALL of these hold; every unmet one is listed in the `refused` line and in a `start-refused`
alert:

1. scale 1 (`--scale` absent or 1; `auto` is refused on mainnet even in a dry run);
2. `--pool`, `--badge`, `--key`, `--state` and `--sent-log` given explicitly (no mainnet defaults; also
   required for a mainnet dry run);
3. no test inputs: no `fixed:`/`file:` venues, no `--exclude-venues(-file)`, no `--owner-anchor`;
4. CoinGecko among the watch sources (the brake);
5. an alert URL, and then a delivered start alert;
6. `OWNER_POOL_PACKAGES.mainnet` lists the audited package (empty today);
7. the pool is in `MAINNET_SEND_POOLS` in `packages/core/src/ownerpool-guard.ts` (empty today), a committed
   allow-list, so a flag alone can never make it send for another pool;
8. `--mainnet-live`, a separate acknowledgement, so a copied Stokenet command line cannot reach mainnet by
   changing `--network` alone.

At start it then reads the pool: it must be an `OwnerPool` of an allow-listed package, with resource_a XRD
and resource_b hUSDC (the venues' orientation), and the state file must carry this network, pool, badge
and operator account (a state file from Stokenet, or from before this change, is refused). Numeric flags
are range-checked, tighter on mainnet.

Going live, on the owner's explicit go-ahead: add the pool's address to `MAINNET_SEND_POOLS` and the
package to `OWNER_POOL_PACKAGES.mainnet` (step 3) in one reviewed commit, deploy it, set
`OWNER_POOL_BOT_FLAGS=--send --mainnet-live` in the env file and `systemctl --user restart owner-pool-bot`.
The refusals were run on 23 Nov 2026 with no mainnet key (`data/soak/guard9.log`; see section 10).

## 6. Emergency stop

Fastest first:

1. **The bot stops itself**: on `--max-anchor-distance` (5%, two ticks in a row), an unhealthy
   reference for 10 minutes, or 3 failed sends, it sets the operator pause or halts (alerts `anchor-stop`,
   `reference-unhealthy`, `halt`); the pause is never blocked by the halt or the hourly cap. The CoinGecko
   brake only stops rebalancing (`coingecko-brake`), it does not pause.
2. **Stop the bot**: `systemctl --user stop owner-pool-bot`. The curve stays where it is and keeps
   trading at its fee.
3. **Pause swaps (owner)**: `pause`, sign. Nothing trades; the bot can do nothing while the owner's
   pause is on; withdrawals still work.
4. **Revoke (owner) if the operator key may be stolen or the bot misbehaves**: `revoke`, sign. The old
   badge loses every right in that transaction and the owner's pause goes on. Then (design, emergency
   procedure): check the curve against the market; restore it with `owner-rebalance --a <±XRD> --b
   <±hUSDC>` (inventory <-> reserves, no limits, guarded, checked against the market) or
   `deposit`/`withdraw`; if re-appointing, `operator-badge --replace` and `appoint --anchor <market>
   --operator-account <a NEW account> --reopen` (steps 3-4 in one transaction). All of this was run on
   Stokenet on 23 Nov 2026 (section 10).

The watcher alerts (never rate-limited) on every operator change and limits change and on the
behavioural theft rules (`move-away`: an operator move away from the reference; `fee-outside-rule`: an
operator fee the bot's rule cannot produce), and (rate-limited) on the spend pattern (`large-spend`,
`window-spend`, `spend-24h`) and `not-bot`. The heartbeat check alerts `NO HEARTBEAT` when the bot or the
watcher stops writing its heartbeat (a kill, an OOM, a lost host).

## 7. Reading the markout summary

```
npx tsx scripts/owner-pool-markout.ts --file data/owner-pool-markout-mainnet.jsonl
npx tsx scripts/owner-pool-markout.ts --file data/owner-pool-markout-mainnet.jsonl --trades
```

One row for all trades, then by size and by fee level. For each horizon (5 and 30 minutes):
`mkNm` is the markout (NEGATIVE = the traders were right: the price moved their way after they
traded), `profitNm` = fees + markout, `beNm` the break-even fee in bps.

- **`profit30m` positive over many trades**: the fee earns more than traders take. Only then consider
  lowering the fee, and never below `be30m` at that fee level.
- **`profit30m` negative**: traders are picking the pool off: widen the fee (raise `--base-fee` or
  the range) or look at the bot's speed.
- Losses concentrated in the largest size bucket mean informed flow; a wider fee alone does not cure it.
- A handful of trades says nothing; the markout of one trade is mostly noise.

Details: `docs/owner-pool-bot.md`, "Markout".

## 8. Unwinding everything

1. `systemctl --user stop owner-pool-bot`.
2. `revoke`, sign (operator out, swaps stop).
3. `unwind`, sign: `withdraw_all` returns reserves and inventory to the owner account. (If a token
   issuer has frozen a vault, take the rest vault by vault: `withdraw --a <x> --b 0` and so on.)
4. The operator account's XRD: `operator-return [--xrd <n>]` builds the transfer back to the owner,
   previewed. It is signed by the OPERATOR key, which only the bot's machine holds, and this script never
   sends on mainnet; with ~20 XRD at stake, leaving it there is acceptable. Moving it needs a send
   path the owner approves (like `scripts/mainnet-withdraw.ts --send` for the solver).
5. Remove the pool from `OWNER_POOL_PACKAGES`/the listing; disable the units:
   `systemctl --user disable --now owner-pool-bot owner-pool-watch`.

The pool component and the package stay on ledger (empty, owner-paused); nothing more is owed.

## 9. Costs (mainnet previews, 23 Nov 2026)

| Step | Network fee (XRD) | Source |
|---|---|---|
| owner badge | 0.51 | mainnet preview, owner account |
| publish the package | **95.34** | mainnet preview with the wasm blob (279,511 bytes) |
| badge + publish + instantiate together | 96.45 | mainnet `simulate` (so instantiate ~0.6) |
| instantiate | 0.86 | Stokenet, same builder |
| pause / unpause / fee | 0.37 | Stokenet |
| limits / anchor / revoke | 0.42-0.44 | Stokenet |
| deposit / withdraw / inventory / owner-rebalance / unwind | 0.52-0.59 | Stokenet |
| limits + fee together | 0.57 | Stokenet |
| operator badge | 0.55 | Stokenet |
| appoint (+ badge and XRD to the operator) | 0.78 | Stokenet |
| each bot transaction | 0.37-0.51 | `docs/owner-pool-bot.md` |

Set-up total about 100 XRD (publishing is 95 of it), plus the operator's 20 XRD float. Fees on
Stokenet and mainnet follow the same cost tables; the mainnet badge (0.51) and Stokenet badge (0.55)
differ only by the Stokenet fee lock instruction.

## 10. What was proven on Stokenet (23 Nov 2026)

Every step above, with `--network stokenet --send`, the throwaway owner and operator keys, and a fresh
XRD/TEUR pool (`teur-dry`, 2,000 XRD / 1.6 TEUR, fee 50): exact notarised previews, then committed.
New owner badge `resource_tdx_2_1t4e0yq0a0yzxzfyap5feen3lcu4ajn6vf0kheh9h9fsk8pwl73ww35`; pool
`component_tdx_2_1czageep5dckrewazzkt4za3gc5tvzak6ehl20x349fuhl7u58krsh0` on the existing allow-listed
package (publishing was previewed exactly, 95.41 XRD, and not sent, so the bot's allow-list still covers
the pool). After each, `record`'s check found the ledger as the step set it.

| Step | Transaction |
|---|---|
| badge | `txid_tdx_2_1qj7glw3eukr77fpk4y285wr8cxralswmj0fv42wr92r8faysel0smukvdm` |
| instantiate 2,000 XRD / 1.6 TEUR, fee 50 | `txid_tdx_2_1pvzvdsmdr8vh75whpfglwjrklhgwhlz9848mj2y768c7exz75cmsqeejw5` |
| pause | `txid_tdx_2_1rtt326qmkrazts0rzfar0a3vcln7tz90dqqdcs4symvprtf7eejs9aan92` |
| inventory 200 / 0.16 | `txid_tdx_2_1xcgs3zcen3v98n7t6rj82d9els48d8qxcswyff0jy8alj6g5t0msyktrcp` |
| deposit 100 / 0.08 (guarded) | `txid_tdx_2_1mt6md8glmwy5lzzdsr4vchq76gyzcujn70x04e5xjehrye3vzqvs9wyxkc` |
| withdraw 50 XRD, proportional (guarded) | `txid_tdx_2_1d6kjlql76938nvkl373vfq6shygx7j3tedylxy209lch2ugq2m4qu0jggm` |
| operator badge | `txid_tdx_2_1h09sgzn9a4x4mr36m0y7wkqwc5svzwacaxhg86dd28nm90gk6rzsclej9y` |
| limits (300 bps / 72 epochs, caps +10%, floors 50%, fee 50-150) | `txid_tdx_2_1rpl08yhua033yyyw8urs4r0wza7my77fvjl8uzk0ytlgw8smetlqkc989r` |
| appoint (anchor 1250:1) + badge and 20 XRD to the operator | `txid_tdx_2_1443kszu29caxtmqf9rsy9lq66v830lcxkyxnjcxuvnmh89x3arnqe08umk` |
| anchor restated (guarded) | `txid_tdx_2_1shl4rhjp4znrzawzufkcr6quxu9f54lspypfw30fd0etaus040aq5whfup` |
| fee 60 | `txid_tdx_2_1mmzme8km3mhsw94ympdxnp2ttan8vjm09ruztwmf74v4xyxkzsasf8xhg7` |
| limits (max fee 150 -> 100) and fee 50 in one transaction | `txid_tdx_2_1v3u7xk4e9py6xt3quzlkn5lvff2nnvwvvydpl9c5p5tlewwgvezqec5z7w` |
| unpause | `txid_tdx_2_1rtzxusswgrkp7n67wz7vssjgmy4mzx7sptd5eayp3jw7s33uun5quwmqf3` |
| revoke | `txid_tdx_2_1nfvrvcqy0swnmvqxyaqm0g9pga6eq9cp2jmapa5kw6ys77q2qxpq96ypmz` |
| unwind (withdraw_all: 2,250 XRD / 1.8 TEUR back) | `txid_tdx_2_1hxjwppevy4s9ec3hm3dpzt022dhfxt3vdntf7y77w4p2huq09r6qraup67` |
| operator returns 20 XRD and the badge | `txid_tdx_2_1wej83mkt45drt5uf0ka0r0dxhq66xwjjyjgmme2nfxk3e5avg42qvhs5fg` |
| emergency drill: re-seed the emptied pool 1,000 / 0.8 | `txid_tdx_2_1kjry0m0jcwzr3wutthdrwcercg7nkdnjz07h0jyz0flreegny7nq3arerp` |
| inventory 100 / 0.08 | `txid_tdx_2_1fqadmhrn32exsam5fz4df69j2xs9lhv0c6lf6knewzkk64hn3fjs0m6vt3` |
| new operator badge (`--replace`) | `txid_tdx_2_1qa747fn8sut6fa9jz9sy75dhcan62cud6mqrns430y0009gw3phqr8nxcc` |
| appoint the new badge + reopen in one transaction | `txid_tdx_2_1ypj6g8vpueqcv03l0qe4xr0esjy9ey0pkhcsjlcx9hd864wl7zzst2ddm3` |
| owner-rebalance 20 XRD / 0.016 TEUR inventory -> reserves (guarded) | `txid_tdx_2_1xma53sqxwgjet886auv2fg4v5lh92cn20l0redh5gdpaqp4qhuuqgywcwd` |
| revoke | `txid_tdx_2_19uf4mhcmzastav36wh4t683c8sajsvcyts9cqgdy88w7zw9rrjxqygc920` |
| unwind (1,100 XRD / 0.88 TEUR back) | `txid_tdx_2_1aw7dk2gu6czntp7sgplu6ydfs7sxj2n047cpqemgkk7p785jnx4qzz6rgh` |
| operator returns the second badge | `txid_tdx_2_1zgu3g48dqlp0cxlx00pdlhr2rlrj7mgawkdrzekmrczca7qx9pjsv76e0q` |

Mainnet `--send` guard refusals (23 Nov 2026, after the review fixes; no mainnet key exists, so nothing
could be signed): `data/soak/guard9.sh` ran the bot with `--network mainnet --send --once`, adding one
condition per run: every run exited 2 with each unmet condition named (explicit flags; alert URL; the
empty `OWNER_POOL_PACKAGES.mainnet`; the pool not in `MAINNET_SEND_POOLS`; `--mainnet-live`; `--scale auto`;
synthetic venues, `--exclude-venues`, `--owner-anchor`; `--no-watch`; out-of-range flags; a flag
swallowing the next). A mainnet DRY RUN with every flag is refused at the missing key. On Stokenet: a
state file without identity or of another network refused; `--send` with no alert URL, or with one whose
start alert is not delivered, refused. Logs `data/soak/guard9.log`, `guard9b.log`.

Also run: `simulate` (allocated addresses, one preview) succeeded on Stokenet and on mainnet; the
refusals fired as they should (deposit when the curve was 6.25% from the stated market price; a seed
12.5% off; a one-sided owner-rebalance that would move the price 2%; limits-fee with the fee outside
the new range). The bot ran once in dry run against the new pool (`--base-fee 50`): it read the owner's
anchor 1250:1 from the ledger, priced from the one qualifying mainnet venue (Ociswap precision,
single-venue caution +50) and previewed `operator_set_fee(100)` successfully. The watcher replayed the
pool's history (`--once --replay`) and reported the appointment, both anchor statements, the fee and
limits changes and the unpause. All test funds went back to the throwaway owner account (it spent about
12 XRD in fees, the operator account 0.6). Logs: `data/mainnet-pool/stokenet/teur-dry/` (`bot-dry-once.log`, `watch-replay.log`).

## 11. What could not be previewed on mainnet, and why

- **Every step after instantiate** (pause, inventory, deposit, withdraw, operator badge, limits,
  appoint, anchor, fee, limits-fee, revoke, unwind, owner-rebalance): they call the pool component,
  which does not exist until the owner signs `instantiate`, and a manifest cannot call a component
  created in the same manifest. Each is previewed against mainnet when it is staged; they were proven on
  Stokenet with the same builders (section 10).
- **instantiate** on its own: needs the published package. Covered by `simulate`, which allocates the
  badge and package addresses and runs badge + publish + instantiate in one mainnet preview, once with
  the owner's account (2 XRD / 0.0016 hUSDC, all he holds) and once with an account holding 10,000 XRD
  and 7.5 hUSDC as a stand-in for realistic size.
- **appoint** before the operator key exists: previews with an existing account as a stand-in and says
  the file must not be signed.
- **The bot on mainnet**: no mainnet pool yet; dry-run on Stokenet against the new pool instead.

## 12. Changes needed in files outside this work

Not made (another review was reading these files):

1. ~~`scripts/owner-pool-bot.ts`: the `--send` guard (section 5), and requiring `--key`, `--badge`,
   `--pool` on mainnet.~~ Done 23 Nov 2026 (review fixes, section 5); the allow-list
   `MAINNET_SEND_POOLS` stays empty until the owner's go-ahead.
2. `scripts/owner-pool-sources.ts` (since 23 Nov 2026 `packages/core/src/ownerpool-sources.ts`, re-exported from the old path): the reference venues are XRD/hUSDC only (`VENUE_POOLS`, the quote
   code sells XRD and hUSDC). An XRD/LSULP pool needs LSULP venues and quoting before any bot can run it.
3. `packages/core/src/ownerpool.ts`: `OWNER_POOL_PACKAGES.mainnet` must list the package once published
   (step 3); until then the bot, watcher and router refuse the pool.
4. ~~Watcher replay (observation): on `--replay` the pool's first `OwnerPoolConfigEvent` is the baseline,
   so the owner's first pause after instantiation was not reported as a `pause-change`.~~ Fixed 23 Nov
   2026: a replay from the first transaction starts from a fresh pool's configuration (instantiate emits
   no config event), so that pause, and the first appointment, are reported; tested.

## 13. The Pools page on the site

`https://dex.difd.net/#/pools` (a **Pools** link appears in the trading page's header when the server
lists any OwnerPool). It reads; the owner's wallet signs. Nothing on the server holds or needs the owner's
key, and the server never submits an owner transaction.

**The table** lists every OwnerPool in `DEX_OWNER_POOLS` (and on Stokenet the markets file): pair, the
curve's price, the gap to the market, TVL, fee, open or paused, and whether the bot and the watcher are
alive. **Open** shows one pool:

| Card | What it shows | From |
|---|---|---|
| Price | the curve (B per A), the market reference and the gap; each venue used or left out, and why | the ledger; the bot's venues and its own rules (`aggregateVenues`, the bot's defaults), by free previews, cached a minute. Pairs with no venues (Stokenet) use the bot's last reference from its state file if fresh |
| Liquidity | reserves, TVL, inventory, fee, owner pause, operator pause | the ledger |
| Operator | operator badge, anchor, the allowance now (of the budget), limits, the operator account's XRD | the ledger; the operator account from the bot's state file |
| Bot and watcher | alive or stale, last seen; the bot's last transaction, its reference, the venues it trusts, ticks behind, failures, halt, its pause | the heartbeat files and the bot's state file (`DEX_OWNER_POOL_FILES`, default the data directory; read only, never written) |
| Fees earned | swaps, fees kept per token and their value, volume | the pool's swap events since it was created (read incrementally, in memory) |
| Markout | trades, fees + markout at +5 and +30 minutes, break-even fee | the watcher's `owner-pool-markout-<network>.jsonl` (the same summary as section 7) |
| Recent activity | the last 50 transactions with pool events: swap, owner (it proved the owner badge) or operator, and what each did | the pool's events |

A heartbeat is stale after 600 s (`DEX_HEARTBEAT_MAX_AGE_SEC`), as the heartbeat timer judges it. Nothing
on the page shows a key, a file path, a process id or the alert URL.

**Owner actions** appear only for an account that holds the pool's owner badge, read on the ledger (the
contract checks the badge again on every call anyway). Connect the owner account with the Radix Wallet;
without a wallet, an account can be typed in to preview (nothing can be signed then). Each action is
built on the server with the same builders and guards as the script step named on the card, previewed
against the Gateway, and shown: succeeds or fails, the network fee, the badge proved, every balance
change, the notes and the manifest. **Sign in wallet** then sends exactly that manifest to the wallet
(no fee lock: the wallet adds its own). After the commit the page checks the pool shows what the action
set, like `record`.

| Action | Script step | Guard |
|---|---|---|
| Deposit | `deposit` | reserves read now (`expected`); refused when the curve is more than 1% from the market, or when there is no market price, unless you tick the box |
| Withdraw | `withdraw` | reserves read now; token B defaults to the proportional amount; never more than the reserves |
| Pause / Unpause | `pause` / `unpause` | none (the owner's pause) |
| Fee | `fee` | 0-500 bps; notes a fee outside the operator's range |
| Anchor | `anchor` | at the market (rounded to 12 places) or a price you give; reserves read now; zeroes the allowance |
| Limits + fee | `limits-fee` | one transaction; empty fields keep their value; a fee outside the new range is refused |
| Revoke | `revoke` | type REVOKE; the emergency stop of section 6 step 4 |

Not on the page (use the script): `inventory`, `withdraw-inventory`, `owner-rebalance`, `operator-badge`,
`appoint`, `unwind`, and the set-up steps.

A preview is good for two minutes; prepare again if a swap moved the reserves ("Reserves moved").

To look at mainnet without touching the live site, run a second, read-only server (no solver is made,
no order taken, whatever else is set):

```
DEX_NETWORK=mainnet DEX_READ_ONLY=1 DEX_PORT=8790 DEX_DATA_DIR=/tmp/dex-ro DEX_OWNER_POOL_FILES=data \
DEX_WEB_DIR=apps/web/dist DEX_OWNER_POOLS=component_rdx1cz6ga0dfz3vqefku0vvgyu0fsv9q6u09vtkpew5ysa8qdsz3ha6zyr \
npx tsx apps/server/src/main.ts
```
