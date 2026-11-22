//! On-ledger contracts for radix-dex.
//!
//! * `OrderRegistry` — lets a user make a signed limit order (a subintent) permanently
//!   unfillable. It stores hashes and holds no resources.
//! * `Pool` — a constant-product pool written so that no sequence of calls can take out
//!   more than was put in: every amount is rounded against the caller.
//!
//! * `OrderBook` — resting limit orders that can be filled a part at a time, at a price the
//!   ledger enforces. It holds the tokens makers are selling.
//!
//! NOT AUDITED. Do not deploy `Pool` to mainnet with real funds before an independent review.

pub mod order_registry;
pub mod order_book;
pub mod pool;
pub mod owner_pool; // PROPOSAL from the pool audit; not in the published package
