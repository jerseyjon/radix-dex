//! On-ledger contracts for radix-dex.
//!
//! * `OrderRegistry` — lets a user make a signed limit order (a subintent) permanently
//!   unfillable. It stores hashes and holds no resources.
//! * `Pool` — a constant-product pool written so that no sequence of calls can take out
//!   more than was put in: every amount is rounded against the caller.
//!
//! NOT AUDITED. Do not deploy `Pool` to mainnet with real funds before an independent review.

pub mod order_registry;
pub mod pool;
