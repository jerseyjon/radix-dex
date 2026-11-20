#!/bin/sh
# Run a cargo command for the Scrypto package inside the build image, e.g. ./run.sh test
# Cargo's registry and the build output are kept in named Docker volumes so reruns are fast.
set -eu
cd "$(dirname "$0")"
docker image inspect radix-dex-scrypto:1.92 >/dev/null 2>&1 || docker build -t radix-dex-scrypto:1.92 .
exec docker run --rm -v "$PWD/dex-contracts:/app" -v radix-dex-cargo:/usr/local/cargo/registry -v radix-dex-target:/target \
  -e CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback radix-dex-scrypto:1.92 cargo "$@"
