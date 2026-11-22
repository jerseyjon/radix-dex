# Split OwnerPool on Stokenet (22 Nov 2026)

Branch `pool-split-stokenet` (owner-pool-routing + pool-split). Stokenet only; throwaway keys in
`data/` (not tracked). Scripts: `scripts/stokenet-owner-pool.ts` (setup, exercise, operator, revoke,
restore, quotes, gas) and `scripts/stokenet-owner-pool-e2e.ts` (fills through the real solver).

## Addresses

| What | Address |
|---|---|
| Package (scrypto/owner-pool at 934c904) | `package_tdx_2_1pklhl0ma6mepuxakg0pk2tgf4ej05uwgwu8gm0ajv5xa9acsjd4fll` |
| wasm | blake2b-256 `0b460d5f3ba527f36ce3efa316de4200774e227b778f98efb4a3c058446a7872`, sha256 `16aed69ed2bad9bcb70ccde0dfdd22cd596d2655d003456cfa8f4d6cf6acb0dd` (rpd: below) |
| Pool XRD/TEUR (30 bps, 0.0008 TEUR per XRD) | `component_tdx_2_1cz95qapuv8wtewsjv7zdlvf2nuffjvqntt6yy8ynsva7xsfw0a24qk` |
| TEUR (test token, 6 places, fixed supply 1000) | `resource_tdx_2_1tknxk37t6tvqce4ce0jqv7ymydjfgjej4mw0wkdzep4wjfz8trvpj3` |
| Owner badge (cold) | `resource_tdx_2_1tkzuvmezcle34heuuzleuuhu3p4g90ncst257llxuh5qrv2nfp9wc6` |
| Operator badge 1 (revoked) | `resource_tdx_2_1tkaa0etdc2q42skhlrm223a9yrk34ff3876gzndrgnjhcj2yr7wvff` |
| Operator badge 2 (current) | `resource_tdx_2_1tkfvg8qudhzmp4fj8z5jlw3wnlsm6cghhwvcfmekwyz73xnwl2c24q` |
| Owner account | `account_tdx_2_129q4ucv5v9j7ukhg5f3nxyle979ek0eyj6j45fxlpargmrcg2qhuaf` |
| Operator account (holds badge 2) | `account_tdx_2_128x3s0xqj8nj55st5s38mjfsfcc2ddyejcq2vjwuctwugy3ukwcj22` |

rpd sha256 `d84ab4b6e1caa39f299e225c9ea22f40f64f171bac21e4dc7c567e67ef54b8d5`. Built in the
`radix-dex-scrypto:1.92` image by scrypto-test's compiler (target volume `radix-dex-target-audit3`).

Limits set (suggested defaults): budget 300 bps per 72 epochs; caps 22,000 XRD / 17.6 TEUR (reserves
+10%); floors 10,000 XRD / 8 TEUR (50%); operator fee range 10-100 bps. Anchor stated 1250 XRD : 1 TEUR.
Inventory 1,000 XRD / 0.8 TEUR.

## Transactions

| Step | Transaction | Result |
|---|---|---|
| publish | `txid_tdx_2_1s9hkv8j4rml4v722epz4q6ycnn0gdca4fy30mzjxmx0rlvsukngsgce0je` | success |
| instantiate with liquidity (20,000 XRD / 16 TEUR) | `txid_tdx_2_1u6jxz27c5cc4m3caceqpj9gch4rglpxjd0wsx2khwgs2ts337rss9vdvww` | success |
| deposit_inventory | `txid_tdx_2_12xwpu5ktkng3j2v9eghudegvq5daf06qm668w9um8rfsv7hgzrrschx9u7` | success |
| create operator badge 1 | `txid_tdx_2_1mtld3qphdsksgkmdku8ul558ah99wm63p4mummune39zl74ze4pqf2lajc` | success |
| set_operator_limits | `txid_tdx_2_1xln7saqysjzwpfpqqescg844da09k05epr9nlhlxjeqh6vr2y60sffdw8y` | success |
| set_operator (appoint, anchor 1250:1) | `txid_tdx_2_1utnaxyy04ffg42mq8f4zjp0300lr03he8j9gk4mjesvtu69fl59qwwau9a` | success |
| badge 1 + 200 XRD to the operator account | `txid_tdx_2_12d9wgqvqjedde2jr0fm87vuhwaxrpnyy0c4l6g38lz4t2w7c8wuqhn5wcs` | success |
| solver fill, market order 40 XRD -> TEUR | `txid_tdx_2_1tz7fm22n526zzz8m5n5w4u0v32e60rqv70v3xdhguan7h02es3zsu74dvf` | success, pool paid exactly its quote |
| solver fill, market order 0.02 TEUR -> XRD | `txid_tdx_2_1cg7hvfs5y3kwv5yzc4nl3k5t7xujf06g2wvrlpwp4c6yqzxrlafs35r9aq` | success, pool paid exactly its quote |
| operator rebalance within budget (-20.013969… XRD to inventory) | `txid_tdx_2_1seac4ptgwwrawhgvxrscsg6js247yh4m882xsn6h0hurcl4daknqt9pwgr` | success; event cost 0.001001001001001002 = TypeScript plan |
| operator rebalance over budget (-999.69… XRD, ~5%) | `txid_tdx_2_14te86c7ky9eafa0prk5ygwp4gqhmpyysrngfuzwps63twj7c0feq97elrj` | CommittedFailure "Operator price-move limit" |
| set_operator(None, None): revoke | `txid_tdx_2_1ws6agvysj9qpkkp0jwa3jqyjaqfysqkh37zzu0hnlxvkx6tq8npsutfm5s` | success; owner pause on, quotes "Swaps are paused", Quoter: no route |
| create operator badge 2 | `txid_tdx_2_1qu38v3yfm2x36g2nc9skete9hwuzfkmayulh69962y6d4jpu7j8sl4ckua` | success |
| restore: owner_rebalance back + set_operator(badge 2, 1250:1) + set_paused(false) + badge 2 to the operator | `txid_tdx_2_1698akhqs3d3y8g5mhrkcldj9fydkavzdyade7e86dah76dhe3wvssxxvjy` | success; reserves back to before the move, pool open, quotes equal |
| solver fill after the restore, 40 XRD -> TEUR | `txid_tdx_2_1ud9f9zqj9s5jurlm5htthuqqepmgsftpnp8se2zuqhfznzuyje7q8zkc8u` | success |
| solver fill after the restore, 0.02 TEUR -> XRD | `txid_tdx_2_1a7fxnsvqkeq9wql4tkf8nd3z0x2wf5062v35yh0c5rrpmul5t8qq08thf4` | success |
| exercise: deposit (guarded) / mismatched guard / swaps / set_fee 50, 30 / pause / unpause / withdraw | `txid_tdx_2_1gfwy67gau26gms4j4jy2j6tfjpzg2yamfd0camr9zd53j0qzydqs978wel`, `txid_tdx_2_1vp3ttuejv5kv3pl7ja72l26pxlfz6qzqlywe982c54jrwkm5zt3skhj60h` (fails "Reserves moved"), `txid_tdx_2_19kek0mrcmvzw4rrf7d8294z5lwmlwes0wtnckflxl2nxlcmpzg4q9pdedk`, `txid_tdx_2_1t00hsm55mp36txade0uge4krwmj4u0xg87d64vvq2ylrmm5a9v8ss24jdf`, `txid_tdx_2_15hl2cj3u58n9dla6hjj6s7r7quzhvl0r28g4p0d5rxvygs382gsqstn25r`, `txid_tdx_2_18gkzfeynj33ftyxrrg99lz0sh4zewd639yh68ngeueanax38tshqynxand`, `txid_tdx_2_1jhdeeve9apme45fvzd662wz7jlt6l5eltjuga22c3jmeggucsphqzkuulv`, `txid_tdx_2_134f3h4gheg4wfg3k6azd7y9ny5jav93rlvddhjpk8xgmh40wcs6qwukh2f`, `txid_tdx_2_1p4nccp376cwl3erdmf9jjap2d2qxtnm8xqm8du3g63zh2ty52k9qjwngpe` | as expected |

Preview-only refusals, each matched by message: set_operator without an anchor ("State the anchor
price"); operator rebalance above the cap / below the floor; operator badge calling `withdraw` and
`set_paused` (owner role); the revoked badge's rebalance (role `operator` = DenyAll) and badge 1's
after the restore; non-owner deposit; swap_with_minimum above the quote; set_fee 501.

## Measured

- Ledger `quote` vs the TypeScript copy, with 1,000 XRD / 0.8 TEUR in the inventory: 23 of 23 agree
  (results and refusals); the inventory is not in the reserves.
- Swap network fee (withdraw + swap_with_minimum + deposit_batch preview): 0.49082-0.49157 XRD, up
  from 0.456 on the first package; `OWNER_POOL_SWAP_FEE_XRD` is now 0.5.
- Stokenet epochs were about 10 minutes during the run (24806 -> 24809 in ~30 min): the operator's
  allowance refills 0.000417 per epoch at the defaults, so a fresh appointment waited 3 epochs for
  the first 0.1% move.

Operator builders proven later (operator_set_fee, set_operator_paused; set_anchor and withdraw_inventory
previewed) and the market-making bot: `docs/owner-pool-bot.md`.
