use scrypto::prelude::*;

/// Emitted once per cancelled order key.
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OrderCancelledEvent {
    pub order_key: Hash,
}

#[blueprint]
#[events(OrderCancelledEvent)]
mod order_registry {
    /// A set of cancelled order keys.
    ///
    /// A limit order's manifest calls `assert_live(key)` before it hands anything over, where
    /// `key = hash(secret)` and the secret was made up by the user's browser. Calling
    /// `cancel(secret)` adds the key to the set for ever, so the signed order can never execute
    /// again, whoever holds a copy of it.
    ///
    /// Knowing a secret lets you cancel that one order and nothing else, so no access control is
    /// needed. The component has no owner, no roles and no vaults.
    struct OrderRegistry {
        cancelled: KeyValueStore<Hash, ()>,
    }

    impl OrderRegistry {
        pub fn instantiate() -> Global<OrderRegistry> {
            Self {
                cancelled: KeyValueStore::new(),
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::None)
            .metadata(metadata! {
                init {
                    "name" => "radix-dex order registry", locked;
                    "description" => "Cancellation registry for signed limit orders. Holds no funds.", locked;
                }
            })
            .globalize()
        }

        /// Panics (failing the whole transaction) if this order key has been cancelled.
        pub fn assert_live(&self, order_key: Vec<u8>) {
            let key = Self::key(order_key);
            assert!(self.cancelled.get(&key).is_none(), "Order has been cancelled");
        }

        pub fn is_cancelled(&self, order_key: Vec<u8>) -> bool {
            self.cancelled.get(&Self::key(order_key)).is_some()
        }

        /// Cancel the order whose key is `hash(secret)`. Idempotent.
        pub fn cancel(&mut self, secret: Vec<u8>) {
            assert!(secret.len() == 32, "Secret must be 32 bytes");
            let key = hash(&secret);
            if self.cancelled.get(&key).is_none() {
                self.cancelled.insert(key, ());
                Runtime::emit_event(OrderCancelledEvent { order_key: key });
            }
        }

        fn key(bytes: Vec<u8>) -> Hash {
            let array: [u8; 32] = bytes.try_into().expect("Order key must be 32 bytes");
            Hash(array)
        }
    }
}
