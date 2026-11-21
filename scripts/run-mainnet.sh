#!/bin/sh
# Start the mainnet site and solver (needs scripts/mainnet-setup.ts to be complete and apps/web built).
# Listens on 127.0.0.1 only: Cloudflare Tunnel is the only way in from outside.
set -eu
cd "$(dirname "$0")/.."
val() { node -e "const v=JSON.parse(require('fs').readFileSync('data/mainnet-setup.json','utf8'))['$1']; if(!v){console.error('mainnet set-up is missing $1');process.exit(1)} console.log(v)"; }
[ "$(val dappDone)" = yes ]
export DEX_NETWORK=mainnet DEX_HOST=127.0.0.1 DEX_PORT="${DEX_PORT:-8787}" DEX_WEB_DIR=apps/web/dist
export DEX_SOLVER_KEY_FILE=data/mainnet-solver.key DEX_CLIENT_IP_HEADER=cf-connecting-ip
export DEX_TAKER_FEE_BPS="${DEX_TAKER_FEE_BPS:-10}" DEX_MAKER_FEE_BPS="${DEX_MAKER_FEE_BPS:-0}"
export DEX_SOLVER_BADGE="$(val solverBadge)" DEX_REGISTRY="$(val registry)" DEX_ORDER_BOOK="$(val orderBook)" DEX_DAPP_DEFINITION="$(val dapp)"
exec npx tsx apps/server/src/main.ts
