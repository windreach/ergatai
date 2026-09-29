//! Unified ID generation module for Ergatai.
//!
//! This module provides a centralized ID generation system using the Snowflake algorithm
//! (via `snowdon` crate) combined with type prefixes for readability and debuggability.
//!
//! # ID Format
//!
//! **Storage format**: 64-bit integer (optimal for SQLite indexing)
//! ```text
//! | 1 bit sign | 41 bit timestamp | 10 bit instance | 12 bit sequence |
//! |     0      |   milliseconds   |    0-1023       |   0-4095/ms     |
//! ```
//!
//! **Display format**: Type-prefixed string (for logs and API responses)
//! ```text
//! msg_1727568000000_001_0001
//! conv_1727568000001_001_0002
//! lock_1727568000002_001_0003
//! ```
//!
//! # Advantages
//!
//! - ✅ **Ordered**: Timestamp-prefixed, optimal for B-tree indexing
//! - ✅ **Compact**: 64-bit integer (8 bytes vs 36 bytes for UUID)
//! - ✅ **Informative**: Contains type, timestamp, instance ID, and sequence
//! - ✅ **Sortable**: Can be sorted by creation time
//! - ✅ **Readable**: Formatted version includes type prefix for debugging
//!
//! # Example
//!
//! ```rust
//! use ergatai_core::id::{IdType, init, generate, format};
//!
//! // Initialize with instance ID (call once at startup)
//! init(1);
//!
//! // Generate ID (64-bit integer, for database storage)
//! let id = generate();
//!
//! // Format ID (for logs/API responses)
//! let formatted = format(id, IdType::Message);
//! // Output: "msg_1727568000000_001_0001"
//!
//! // Extract information from ID
//! let (id_type, timestamp, instance, sequence) = parse(&formatted).unwrap();
//! ```

use snowdon::{ClassicLayout, ClassicLayoutSnowflakeExtension, Epoch, Generator, MachineId};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;

/// Snowflake parameters for Ergatai.
struct ErgataiSnowflakeParams;

/// Epoch: Twitter's epoch (2010-11-04 01:42:54.657 UTC)
impl Epoch for ErgataiSnowflakeParams {
    fn millis_since_unix() -> u64 {
        1288834974657
    }
}

/// Machine ID: dynamically set via `init()`
static MACHINE_ID: AtomicU16 = AtomicU16::new(0);

impl MachineId for ErgataiSnowflakeParams {
    fn machine_id() -> u64 {
        MACHINE_ID.load(Ordering::Relaxed) as u64
    }
}

/// Type aliases for our snowflake implementation
type ErgataiSnowflake =
    snowdon::Snowflake<ClassicLayout<ErgataiSnowflakeParams>, ErgataiSnowflakeParams>;
type ErgataiGenerator = Generator<ClassicLayout<ErgataiSnowflakeParams>, ErgataiSnowflakeParams>;

/// Global snowflake generator instance.
static GENERATOR: OnceLock<ErgataiGenerator> = OnceLock::new();

/// ID type enumeration.
///
/// Each ID type has a unique prefix for formatted output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum IdType {
    /// Message ID (agent-to-agent communication)
    Message = 1,
    /// Conversation ID (auto-conversation tracking)
    Conversation = 2,
    /// Chat ID (user chat sessions)
    Chat = 3,
    /// File lock ID
    Lock = 4,
    /// Snapshot ID (Git COW snapshots)
    Snapshot = 5,
    /// Permission request ID
    Permission = 6,
    /// Session ID
    Session = 7,
    /// Agent ID (runtime)
    Agent = 8,
    /// Workspace ID
    Workspace = 9,
    /// DAG orchestration ID
    Dag = 10,
    /// Task ID (DAG node)
    Task = 11,
    /// State checkpoint ID (DAG recovery)
    Checkpoint = 12,
}

impl IdType {
    /// Get the string prefix for this ID type.
    pub fn prefix(&self) -> &'static str {
        match self {
            IdType::Message => "msg",
            IdType::Conversation => "conv",
            IdType::Chat => "chat",
            IdType::Lock => "lock",
            IdType::Snapshot => "snap",
            IdType::Permission => "perm",
            IdType::Session => "sess",
            IdType::Agent => "agent",
            IdType::Workspace => "ws",
            IdType::Dag => "dag",
            IdType::Task => "task",
            IdType::Checkpoint => "ckpt",
        }
    }

    /// Parse ID type from string prefix.
    pub fn from_prefix(prefix: &str) -> Option<Self> {
        match prefix {
            "msg" => Some(IdType::Message),
            "conv" => Some(IdType::Conversation),
            "chat" => Some(IdType::Chat),
            "lock" => Some(IdType::Lock),
            "snap" => Some(IdType::Snapshot),
            "perm" => Some(IdType::Permission),
            "sess" => Some(IdType::Session),
            "agent" => Some(IdType::Agent),
            "ws" => Some(IdType::Workspace),
            "dag" => Some(IdType::Dag),
            "task" => Some(IdType::Task),
            "ckpt" => Some(IdType::Checkpoint),
            _ => None,
        }
    }
}

/// Initialize the ID generator with instance ID.
///
/// Call this once at application startup before generating IDs.
///
/// # Arguments
///
/// * `instance_id` - Instance identifier (0-1023). Use different values for different processes.
///
/// # Example
///
/// ```rust
/// use ergatai_core::id::init;
///
/// // Initialize with instance ID 1
/// init(1);
/// ```
pub fn init(instance_id: u16) {
    MACHINE_ID.store(instance_id & 0x3FF, Ordering::Relaxed);
    GENERATOR.get_or_init(ErgataiGenerator::default);
}

/// Get or initialize the global generator.
///
/// # Panics
///
/// This function does NOT panic. If called before `init()`, it initializes with
/// default instance_id=0. Call `init(instance_id)` at startup to set a specific value.
fn generator() -> &'static ErgataiGenerator {
    GENERATOR.get_or_init(|| {
        // Only set MACHINE_ID if not already initialized
        // This allows init() to be called before or after first generate()
        let _ = MACHINE_ID.compare_exchange(0, 0, Ordering::Relaxed, Ordering::Relaxed);
        ErgataiGenerator::default()
    })
}

/// Generate a new ID using the global generator.
///
/// Returns a 64-bit integer that can be stored directly in the database.
///
/// # Example
///
/// ```rust
/// use ergatai_core::id::generate;
///
/// let message_id = generate();
/// let conversation_id = generate();
/// ```
pub fn generate() -> i64 {
    generator()
        .generate()
        .expect("Failed to generate snowflake ID")
        .into_i64()
}

/// Format an ID with type prefix for display/logging.
///
/// # Arguments
///
/// * `id` - The 64-bit ID to format
/// * `id_type` - The ID type (determines prefix)
///
/// # Returns
///
/// Formatted string: `{type}_{timestamp}_{instance}_{sequence}`
///
/// # Example
///
/// ```rust
/// use ergatai_core::id::{generate, format, IdType};
///
/// let id = generate();
/// let formatted = format(id, IdType::Message);
/// // Output: "msg_1727568000000_000_0001"
/// ```
pub fn format(id: i64, id_type: IdType) -> String {
    let snowflake = ErgataiSnowflake::from_raw(id as u64).expect("Invalid snowflake ID");
    let timestamp = snowflake.timestamp_raw();
    let instance = snowflake.machine_id();
    let sequence = snowflake.sequence_number();

    format!(
        "{}_{}_{}_{:04}",
        id_type.prefix(),
        timestamp,
        instance,
        sequence
    )
}

/// Parse a formatted ID string back to components.
///
/// # Arguments
///
/// * `formatted` - Formatted ID string (e.g., "msg_1727568000000_001_0001")
///
/// # Returns
///
/// `Some((IdType, timestamp, instance, sequence))` if parsing succeeds, `None` otherwise.
///
/// # Example
///
/// ```rust
/// use ergatai_core::id::{generate, format, parse, IdType};
///
/// let id = generate();
/// let formatted = format(id, IdType::Message);
/// let (id_type, timestamp, instance, sequence) = parse(&formatted).unwrap();
/// ```
pub fn parse(formatted: &str) -> Option<(IdType, u64, u64, u64)> {
    let parts: Vec<&str> = formatted.split('_').collect();
    if parts.len() != 4 {
        return None;
    }

    let id_type = IdType::from_prefix(parts[0])?;
    let timestamp: u64 = parts[1].parse().ok()?;
    let instance: u64 = parts[2].parse().ok()?;
    let sequence: u64 = parts[3].parse().ok()?;

    Some((id_type, timestamp, instance, sequence))
}

/// Extract timestamp from ID.
///
/// # Arguments
///
/// * `id` - The 64-bit ID
///
/// # Returns
///
/// Timestamp in milliseconds since Twitter epoch
pub fn extract_timestamp(id: i64) -> u64 {
    let snowflake = ErgataiSnowflake::from_raw(id as u64).expect("Invalid snowflake ID");
    snowflake.timestamp_raw()
}

/// Extract instance ID from ID.
///
/// # Arguments
///
/// * `id` - The 64-bit ID
///
/// # Returns
///
/// Instance ID (0-1023)
pub fn extract_instance(id: i64) -> u64 {
    let snowflake = ErgataiSnowflake::from_raw(id as u64).expect("Invalid snowflake ID");
    snowflake.machine_id()
}

/// Extract sequence number from ID.
///
/// # Arguments
///
/// * `id` - The 64-bit ID
///
/// # Returns
///
/// Sequence number (0-4095)
pub fn extract_sequence(id: i64) -> u64 {
    let snowflake = ErgataiSnowflake::from_raw(id as u64).expect("Invalid snowflake ID");
    snowflake.sequence_number()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_id_type_prefix() {
        assert_eq!(IdType::Message.prefix(), "msg");
        assert_eq!(IdType::Conversation.prefix(), "conv");
        assert_eq!(IdType::Lock.prefix(), "lock");
    }

    #[test]
    fn test_id_type_from_prefix() {
        assert_eq!(IdType::from_prefix("msg"), Some(IdType::Message));
        assert_eq!(IdType::from_prefix("conv"), Some(IdType::Conversation));
        assert_eq!(IdType::from_prefix("unknown"), None);
    }

    #[test]
    fn test_init() {
        init(42);
        // Should not panic
    }

    #[test]
    fn test_generate_uniqueness() {
        init(1);
        let id1 = generate();
        let id2 = generate();
        let id3 = generate();

        assert_ne!(id1, id2);
        assert_ne!(id2, id3);
        assert_ne!(id1, id3);
    }

    #[test]
    fn test_generate_ordering() {
        init(1);
        let id1 = generate();
        std::thread::sleep(std::time::Duration::from_millis(1));
        let id2 = generate();

        assert!(id2 > id1);
    }

    #[test]
    fn test_format() {
        init(1);
        let id = generate();
        let formatted = format(id, IdType::Message);

        assert!(formatted.starts_with("msg_"));
        assert!(formatted.len() > 10);
    }

    #[test]
    fn test_parse() {
        init(42);
        let id = generate();
        let formatted = format(id, IdType::Conversation);

        let parsed = parse(&formatted);
        assert!(parsed.is_some());

        let (id_type, _timestamp, instance, _sequence) = parsed.unwrap();
        assert_eq!(id_type, IdType::Conversation);
        assert_eq!(instance, 42);
    }

    #[test]
    fn test_extract_components() {
        init(100);
        let id = generate();

        let timestamp = extract_timestamp(id);
        let instance = extract_instance(id);
        let _sequence = extract_sequence(id);

        assert_eq!(instance, 100);
        assert!(timestamp > 0);
    }

    #[test]
    fn test_thread_safety() {
        use std::thread;

        init(1);
        let mut handles = vec![];

        // Generate IDs in multiple threads
        for _ in 0..10 {
            handles.push(thread::spawn(move || {
                let mut ids = vec![];
                for _ in 0..100 {
                    ids.push(generate());
                }
                ids
            }));
        }

        let mut all_ids = vec![];
        for handle in handles {
            all_ids.extend(handle.join().unwrap());
        }

        // Check that we got 1000 IDs total
        assert_eq!(all_ids.len(), 1000);

        // Check uniqueness - snowdon is thread-safe
        let unique_count = all_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len();
        assert_eq!(unique_count, all_ids.len(), "All IDs should be unique");
    }
}
