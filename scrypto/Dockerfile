# Build and test image for the Scrypto package. Rust version follows radixdlt-scrypto's rust-toolchain.toml.
FROM rust:1.92-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends build-essential clang libclang-dev cmake pkg-config git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt clippy rust-src && rustup target add wasm32-unknown-unknown
ENV CARGO_TARGET_DIR=/target
WORKDIR /app
