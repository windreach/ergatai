//! Binary locator for Ergatai external dependencies
//!
//! This crate provides a unified mechanism for locating external
//! binary dependencies like the NATS server.
//!
//! # Architecture
//!
//! The `BinaryLocator` implements a multi-layer search strategy:
//! 1. Environment variable override (e.g., `ERGATAI_NATS_BINARY`)
//! 2. Bundled resources directory (downloaded by build.rs at compile time)
//! 3. Sibling directory (next to the executable)
//! 4. System PATH (development fallback)
//!
//! # Example
//!
//! ```no_run
//! use ergatai_binary::find_nats_binary;
//!
//! // Find NATS server binary
//! let nats_path = find_nats_binary().expect("NATS binary not found");
//! ```

mod finder;
mod nats;

pub use finder::BinaryLocator;
pub use nats::find_nats_binary;
