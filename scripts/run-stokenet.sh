#!/bin/sh
# Start the Stokenet test instance (needs scripts/stokenet-setup.ts to have run and apps/web built).
# Listens on all interfaces so a phone or another PC on the LAN can reach it.
set -eu
cd "$(dirname "$0")/.."
val() { node -e "console.log(JSON.parse(require('fs').readFileSync('data/stokenet-keys.json','utf8'))['$1'])"; }
export DEX_NETWORK=stokenet DEX_HOST=0.0.0.0 DEX_PORT="${DEX_PORT:-8788}" DEX_WEB_DIR=apps/web/dist
export DEX_SOLVER_KEY_FILE=data/stokenet-solver.key DEX_MARKETS_FILE=data/stokenet-markets.json
export DEX_SOLVER_BADGE="$(val badge)" DEX_REGISTRY="$(val registry)" DEX_DAPP_DEFINITION="$(val dappDefinition)"
# https as well, when a certificate exists: the Radix Connector extension only runs on https or localhost.
if [ -f data/tls/cert.pem ]; then export DEX_TLS_KEY_FILE=data/tls/key.pem DEX_TLS_CERT_FILE=data/tls/cert.pem DEX_TLS_PORT="${DEX_TLS_PORT:-8789}"; fi
exec npx tsx apps/server/src/main.ts
