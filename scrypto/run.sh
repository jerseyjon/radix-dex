#!/bin/sh
# Run a cargo command for a Scrypto crate inside the build image, e.g. ./run.sh test
# Crates: dex-contracts (default; the published package) and owner-pool (OwnerPool, its own package):
#   CRATE=owner-pool ./run.sh test
# Cargo's registry and the build output are kept in named Docker volumes so reruns are fast;
# TARGET_VOLUME picks another build-output volume (default radix-dex-target).
set -eu
cd "$(dirname "$0")"
CRATE="${CRATE:-dex-contracts}"
TARGET_VOLUME="${TARGET_VOLUME:-radix-dex-target}"
docker image inspect radix-dex-scrypto:1.92 >/dev/null 2>&1 || docker build -t radix-dex-scrypto:1.92 .
exec docker run --rm -v "$PWD/$CRATE:/app" -v radix-dex-cargo:/usr/local/cargo/registry -v "$TARGET_VOLUME:/target" \
  -e CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback radix-dex-scrypto:1.92 cargo "$@"
