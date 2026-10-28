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
//! ```rust,no_run
//! use ergatai_error::id::{IdType, init, generate, format, parse};
//!
//! // Initialize with instance ID (call once at startup)
//! init(1);
//!
//! // Generate ID (64-bit integer, for database storage)
//! let id = generate();
//!
//! // Format ID (for logs/API responses)
//! let formatted = format(id, IdType::Message);
//! // Output: "msg_{timestamp}_{instance}_{sequence}"
//!
//! // Extract information from ID
//! let (id_type, timestamp, instance, sequence) = parse(&formatted).unwrap();
//! ```

use snowdon::{ClassicLayout, ClassicLayoutSnowflakeExtension, Epoch, Generator, MachineId};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, RwLock};

/// Snowflake parameters for Ergatai.
struct ErgataiSnowflakeParams;

/// Epoch: Twitter's epoch (2010-11-04 01:42:54.657 UTC)
impl Epoch for ErgataiSnowflakeParams {
    fn millis_since_unix() -> u64 {
        1288834974657
    }
}

/// Machine ID: set once via `init()`. Subsequent calls to `init()` are no-ops.
static MACHINE_ID: AtomicU16 = AtomicU16::new(u16::MAX);

impl MachineId for ErgataiSnowflakeParams {
    fn machine_id() -> u64 {
        let raw = MACHINE_ID.load(Ordering::Relaxed);
        let base: u64 = if raw == u16::MAX {
            0
        } else {
            (raw & 0x3FF) as u64
        };
        // Each generator rebuild bumps this offset so post-rebuild IDs can
        // never collide with IDs issued before the rollback (see
        // `rebuild_generator_after_clock_rollback`).
        let offset = (REBUILD_OFFSET.load(Ordering::Relaxed) & 0x3FF) as u64;
        (base + offset) & 0x3FF
    }
}

/// Type aliases for our snowflake implementation
type ErgataiSnowflake =
    snowdon::Snowflake<ClassicLayout<ErgataiSnowflakeParams>, ErgataiSnowflakeParams>;
type ErgataiGenerator = Generator<ClassicLayout<ErgataiSnowflakeParams>, ErgataiSnowflakeParams>;

/// Global snowflake generator instance.
///
/// Wrapped in `Arc` behind a `RwLock` so it can be swapped out after a severe
/// clock rollback (see `rebuild_generator_after_clock_rollback`). The read
/// path is a short lock + `Arc` clone; the write path only runs on rebuild.
static GENERATOR: RwLock<Option<Arc<ErgataiGenerator>>> = RwLock::new(None);

/// Number of times the generator has been rebuilt after clock rollbacks.
static REBUILD_OFFSET: AtomicU16 = AtomicU16::new(0);

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
    /// Project ID (code repository)
    Project = 13,
    /// DAG orchestration ID
    Dag = 10,
    /// Task ID (DAG node)
    Task = 11,
    /// State checkpoint ID (DAG recovery)
    Checkpoint = 12,
    /// Agent execution turn ID
    Turn = 14,
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
            IdType::Project => "proj",
            IdType::Dag => "dag",
            IdType::Task => "task",
            IdType::Checkpoint => "ckpt",
            IdType::Turn => "turn",
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
            "proj" => Some(IdType::Project),
            "dag" => Some(IdType::Dag),
            "task" => Some(IdType::Task),
            "ckpt" => Some(IdType::Checkpoint),
            "turn" => Some(IdType::Turn),
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
/// use ergatai_error::id::init;
///
/// // Initialize with instance ID 1
/// init(1);
/// ```
pub fn init(instance_id: u16) {
    // Warn if instance_id exceeds 10-bit range (max 1023) and will be truncated
    if instance_id > 0x3FF {
        tracing::warn!(
            instance_id,
            masked_value = instance_id & 0x3FF,
            "instance_id exceeds 10 bits (max 1023), truncating to {} bits",
            (instance_id & 0x3FF)
        );
    }
    // Set-once: compare_exchange succeeds only on the first call (when value is still u16::MAX).
    // Subsequent calls are no-ops, preventing post-init mutation.
    let _ = MACHINE_ID.compare_exchange(
        u16::MAX,
        instance_id & 0x3FF,
        Ordering::SeqCst,
        Ordering::Relaxed,
    );
    generator();
}

/// Get or initialize the global generator.
///
/// This function does NOT panic. If called before `init()`, it initializes with
/// default instance_id=0. Call `init(instance_id)` at startup to set a specific value.
fn generator() -> Arc<ErgataiGenerator> {
    if let Some(generator) = GENERATOR.read().unwrap().as_ref() {
        return generator.clone();
    }
    let mut generator_slot = GENERATOR.write().unwrap();
    generator_slot
        .get_or_insert_with(|| Arc::new(ErgataiGenerator::default()))
        .clone()
}

/// Rebuild the global generator after a persistent clock rollback.
///
/// A large backwards clock adjustment (e.g. an NTP step correction after the
/// machine booted with a fast clock, a VM resume, or hibernate) leaves the
/// generator's in-memory "last timestamp" far ahead of the wall clock. Short
/// retries can never outlast that, so the generator is replaced with a fresh
/// one whose timestamps restart from the current (corrected) clock.
///
/// To keep IDs unique across the rollback, the machine-id offset is bumped:
/// previously issued IDs — including "future" timestamps generated while the
/// clock was fast, which the corrected wall clock will eventually re-traverse
/// — can then never collide with newly issued ones.
fn rebuild_generator_after_clock_rollback() {
    REBUILD_OFFSET.fetch_add(1, Ordering::SeqCst);
    let mut generator_slot = GENERATOR.write().unwrap();
    *generator_slot = Some(Arc::new(ErgataiGenerator::default()));
    tracing::error!(
        machine_id = ErgataiSnowflakeParams::machine_id(),
        "Snowflake generator rebuilt after persistent clock rollback; \
         IDs issued while the clock was wrong will sort before newer IDs"
    );
}

/// Maximum retry attempts for transient ID generation failures.
const MAX_GENERATE_RETRIES: u32 = 100;

/// Generate a new ID using the global generator.
///
/// Returns a 64-bit integer that can be stored directly in the database.
///
/// # Retry behavior
///
/// Transient failures (clock rollback, sequence exhaustion) are handled with
/// microsecond sleeps. The function retries up to `MAX_GENERATE_RETRIES` times
/// before escalating. In practice, transient failures resolve within 1-2 retries.
///
/// # Panics
///
/// This function will panic if ID generation fails `MAX_GENERATE_RETRIES` (100)
/// times in succession. This indicates a severe system issue such as:
/// - Persistent clock rollback (NTP sync problems)
/// - Extreme contention (millions of IDs per millisecond)
/// - Generator corruption
///
/// Persistent `NonMonotonicClock` failures no longer panic: instead, the
/// generator is rebuilt (machine-id offset bumped) and generation continues,
/// so a large clock rollback degrades ID ordering instead of taking requests
/// down. Panics remain the last-resort path for non-recoverable errors; run
/// request handlers behind a panic-catching layer so a panic surfaces as an
/// HTTP 500 instead of a dropped connection.
///
/// **Why panic instead of returning Result?** This function is called throughout
/// the codebase (50+ call sites) for critical operations like message IDs,
/// conversation IDs, and session IDs. Changing the return type to `Result` would
/// be a breaking change requiring updates to all call sites. The panic is a
/// last-resort safety net for catastrophic failures that should never occur in
/// normal operation.
///
/// # Async safety
///
/// This function is safe to call from async contexts when wrapped in `spawn_blocking`.
/// It uses `std::thread::sleep` for backoff, which blocks the current thread but
/// not the async executor (when called from spawn_blocking). Direct calls from
/// async code will block the executor thread.
///
/// # Example
///
/// ```rust
/// use ergatai_error::id::generate;
///
/// let message_id = generate();
/// let conversation_id = generate();
/// ```
pub fn generate() -> i64 {
    let mut last_error: Option<snowdon::Error> = None;
    for attempt in 0..MAX_GENERATE_RETRIES {
        match generator().generate() {
            Ok(snowflake) => return snowflake.into_i64(),
            Err(err) => {
                // Transient errors: clock rollback or sequence exhaustion.
                // Use sleep for backoff (safe when called from spawn_blocking).
                if attempt < MAX_GENERATE_RETRIES - 1 {
                    tracing::warn!(
                        attempt = attempt + 1,
                        max_retries = MAX_GENERATE_RETRIES,
                        error = %err,
                        "Snowflake ID generation failed, retrying"
                    );
                    // Small sleep to back off (100 microseconds, exponential backoff could be added)
                    std::thread::sleep(std::time::Duration::from_micros(100));
                }
                last_error = Some(err);
            }
        }
    }
    let last_error = last_error.expect("generator must return an error after exhausting retries");

    // Persistent clock rollback: no amount of short retrying can outlast it
    // (e.g. an 8-hour NTP step correction). Rebuild the generator and try once
    // more instead of panicking — panicking here aborts the request handler
    // and closes the HTTP connection without a response, which clients see as
    // `UND_ERR_SOCKET` "other side closed" with zero bytes read.
    if matches!(last_error, snowdon::Error::NonMonotonicClock) {
        rebuild_generator_after_clock_rollback();
        match generator().generate() {
            Ok(snowflake) => return snowflake.into_i64(),
            Err(err) => {
                tracing::error!(
                    error = %err,
                    "Critical: snowflake generation failed even after generator rebuild"
                );
                panic!("Failed to generate snowflake ID after generator rebuild: {err}");
            }
        }
    }

    // Log at ERROR level before panicking for better observability
    tracing::error!(
        retries = MAX_GENERATE_RETRIES,
        error = %last_error,
        "Critical: failed to generate snowflake ID after retries"
    );
    panic!(
        "Failed to generate snowflake ID after {} retries: {}",
        MAX_GENERATE_RETRIES, last_error
    )
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
/// Formatted string: `{type}_{timestamp}_{instance}_{sequence}`.
/// Returns fallback format if ID is invalid (negative/sign bit set).
///
/// # Example
///
/// ```rust
/// use ergatai_error::id::{generate, format, IdType};
///
/// let id = generate();
/// let formatted = format(id, IdType::Message);
/// // Output: "msg_1727568000000_000_0001"
/// ```
pub fn format(id: i64, id_type: IdType) -> String {
    match ErgataiSnowflake::from_raw(id as u64) {
        Ok(snowflake) => {
            let timestamp = snowflake.timestamp_raw();
            let instance = snowflake.machine_id();
            let sequence = snowflake.sequence_number();

            format!(
                "{}_{}_{:03}_{:04}",
                id_type.prefix(),
                timestamp,
                instance,
                sequence
            )
        }
        Err(_) => {
            // Invalid ID (sign bit set) - return fallback format
            tracing::warn!(id, id_type = ?id_type, "Invalid snowflake ID, using fallback format");
            format!("{}_invalid_0_0", id_type.prefix())
        }
    }
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
/// use ergatai_error::id::{generate, format, parse, IdType};
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

/// Parse a formatted ID string back to raw i64.
///
/// This is the reverse of `format()`. It extracts the timestamp, instance, and sequence
/// from the formatted string and reconstructs the original 64-bit snowflake ID.
///
/// # Arguments
///
/// * `formatted` - Formatted ID string (e.g., "msg_1727568000000_001_0001")
///
/// # Returns
///
/// `Some(i64)` if parsing succeeds, `None` otherwise.
///
/// # Example
///
/// ```rust
/// use ergatai_error::id::{generate, format, parse_to_i64, IdType};
///
/// let original_id = generate();
/// let formatted = format(original_id, IdType::Workspace);
/// let parsed_id = parse_to_i64(&formatted).expect("Failed to parse");
/// assert_eq!(original_id, parsed_id);
/// ```
pub fn parse_to_i64(formatted: &str) -> Option<i64> {
    let (_id_type, timestamp, instance, sequence) = parse(formatted)?;

    // Validate ranges
    if timestamp > 0x1FF_FFFF_FFFF {
        return None; // 41 bits max
    }
    if instance > 0x3FF {
        return None; // 10 bits max
    }
    if sequence > 0xFFF {
        return None; // 12 bits max
    }

    // Reconstruct the raw 64-bit snowflake ID using checked arithmetic for consistency
    // Layout: | 1 bit sign (0) | 41 bit timestamp | 10 bit instance | 12 bit sequence |
    let raw = (timestamp << 22)
        .checked_add(instance << 12)
        .and_then(|v| v.checked_add(sequence))?;

    // Ensure the result fits in i64 (positive values only)
    if raw > i64::MAX as u64 {
        return None;
    }

    Some(raw as i64)
}

/// Parse a formatted ID string back to raw i64 with type validation.
///
/// This is a type-safe variant of `parse_to_i64()` that validates the ID type prefix
/// matches the expected type. Use this when you need to ensure type safety at parse time.
///
/// # Arguments
///
/// * `formatted` - Formatted ID string (e.g., "msg_1727568000000_001_0001")
/// * `expected_type` - The expected ID type
///
/// # Returns
///
/// `Some(i64)` if parsing succeeds AND the type matches, `None` otherwise.
///
/// # Example
///
/// ```rust
/// use ergatai_error::id::{generate, format, parse_to_i64_with_type, IdType};
///
/// let original_id = generate();
/// let formatted = format(original_id, IdType::Workspace);
/// let parsed_id = parse_to_i64_with_type(&formatted, IdType::Workspace).expect("Failed to parse");
/// assert_eq!(original_id, parsed_id);
///
/// // Type mismatch returns None
/// assert!(parse_to_i64_with_type(&formatted, IdType::Message).is_none());
/// ```
pub fn parse_to_i64_with_type(formatted: &str, expected_type: IdType) -> Option<i64> {
    let (id_type, timestamp, instance, sequence) = parse(formatted)?;

    // Validate type matches
    if id_type != expected_type {
        return None;
    }

    // Validate ranges
    if timestamp > 0x1FF_FFFF_FFFF {
        return None; // 41 bits max
    }
    if instance > 0x3FF {
        return None; // 10 bits max
    }
    if sequence > 0xFFF {
        return None; // 12 bits max
    }

    // Reconstruct the raw 64-bit snowflake ID using checked arithmetic
    // Bit layout: [timestamp:41][instance:10][sequence:12]
    let raw = (timestamp << 22)
        .checked_add(instance << 12)
        .and_then(|v| v.checked_add(sequence))?;

    // Ensure the result fits in i64 (positive values only)
    if raw > i64::MAX as u64 {
        return None;
    }

    Some(raw as i64)
}

/// Validate that a string is a properly formatted ID.
///
/// # Arguments
///
/// * `formatted` - The string to validate
///
/// # Returns
///
/// `true` if the string is a valid formatted ID, `false` otherwise.
///
/// # Example
///
/// ```rust
/// use ergatai_error::id::{generate, format, is_valid_formatted_id, IdType};
///
/// let id = generate();
/// let formatted = format(id, IdType::Message);
/// assert!(is_valid_formatted_id(&formatted));
/// assert!(!is_valid_formatted_id("invalid"));
/// ```
pub fn is_valid_formatted_id(formatted: &str) -> bool {
    parse(formatted).is_some()
}

/// Extract timestamp from ID.
///
/// # Arguments
///
/// * `id` - The 64-bit ID
///
/// # Returns
///
/// Timestamp in milliseconds since Twitter epoch, or 0 if ID is invalid
pub fn extract_timestamp(id: i64) -> u64 {
    match ErgataiSnowflake::from_raw(id as u64) {
        Ok(snowflake) => snowflake.timestamp_raw(),
        Err(_) => {
            tracing::warn!(id, "Invalid snowflake ID, returning 0 for timestamp");
            0
        }
    }
}

/// Extract instance ID from ID.
///
/// # Arguments
///
/// * `id` - The 64-bit ID
///
/// # Returns
///
/// Instance ID (0-1023), or 0 if ID is invalid
pub fn extract_instance(id: i64) -> u64 {
    match ErgataiSnowflake::from_raw(id as u64) {
        Ok(snowflake) => snowflake.machine_id(),
        Err(_) => {
            tracing::warn!(id, "Invalid snowflake ID, returning 0 for instance");
            0
        }
    }
}

/// Extract sequence number from ID.
///
/// # Arguments
///
/// * `id` - The 64-bit ID
///
/// # Returns
///
/// Sequence number (0-4095), or 0 if ID is invalid
pub fn extract_sequence(id: i64) -> u64 {
    match ErgataiSnowflake::from_raw(id as u64) {
        Ok(snowflake) => snowflake.sequence_number(),
        Err(_) => {
            tracing::warn!(id, "Invalid snowflake ID, returning 0 for sequence");
            0
        }
    }
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
        // init() is set-once; the first test to call it wins.
        // Verify roundtrip consistency rather than a specific instance value.
        let id = generate();
        let formatted = format(id, IdType::Conversation);

        let parsed = parse(&formatted);
        assert!(parsed.is_some());

        let (id_type, _timestamp, instance, _sequence) = parsed.unwrap();
        assert_eq!(id_type, IdType::Conversation);
        // Instance should match the extract_instance() output (roundtrip consistency)
        assert_eq!(instance, extract_instance(id));
    }

    #[test]
    fn test_extract_components() {
        let id = generate();

        let timestamp = extract_timestamp(id);
        let instance = extract_instance(id);
        let _sequence = extract_sequence(id);

        // Instance should be in valid range (0-1023)
        assert!(instance <= 1023);
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

    #[test]
    fn test_parse_to_i64_roundtrip() {
        init(1);
        // Test all ID types
        let test_cases = vec![
            (IdType::Message, "msg"),
            (IdType::Conversation, "conv"),
            (IdType::Chat, "chat"),
            (IdType::Workspace, "ws"),
            (IdType::Session, "sess"),
            (IdType::Agent, "agent"),
            (IdType::Lock, "lock"),
            (IdType::Dag, "dag"),
            (IdType::Task, "task"),
            (IdType::Turn, "turn"),
        ];

        for (id_type, _prefix) in test_cases {
            let original_id = generate();
            let formatted = format(original_id, id_type);
            let parsed = parse_to_i64(&formatted).expect("Failed to parse");
            assert_eq!(original_id, parsed, "Roundtrip failed for {:?}", id_type);
        }
    }

    #[test]
    fn test_parse_to_i64_invalid() {
        assert_eq!(parse_to_i64("invalid"), None);
        assert_eq!(parse_to_i64(""), None);
        assert_eq!(parse_to_i64("ws_invalid_001_0001"), None);
        assert_eq!(parse_to_i64("ws_123_001"), None); // Missing parts
        assert_eq!(parse_to_i64("unknown_123_001_0001"), None); // Unknown type
    }

    #[test]
    fn test_parse_to_i64_out_of_range() {
        // Test timestamp overflow (41 bits max = 0x1FF_FFFF_FFFF)
        assert_eq!(parse_to_i64("ws_99999999999999_001_0001"), None);
        // Test instance overflow (10 bits max = 0x3FF = 1023)
        assert_eq!(parse_to_i64("ws_123_9999_0001"), None);
        // Test sequence overflow (12 bits max = 0xFFF = 4095)
        assert_eq!(parse_to_i64("ws_123_001_99999"), None);
    }

    #[test]
    fn test_is_valid_formatted_id() {
        init(1);
        let id = generate();
        let formatted = format(id, IdType::Message);

        assert!(is_valid_formatted_id(&formatted));
        assert!(!is_valid_formatted_id("invalid"));
        assert!(!is_valid_formatted_id(""));
        assert!(!is_valid_formatted_id("msg_123_001")); // Incomplete
    }

    #[test]
    fn test_parse_to_i64_with_type() {
        init(1);
        let original_id = generate();

        // Test with matching type - should succeed
        let formatted_ws = format(original_id, IdType::Workspace);
        let parsed_ws =
            parse_to_i64_with_type(&formatted_ws, IdType::Workspace).expect("Failed to parse");
        assert_eq!(original_id, parsed_ws);

        // Test with mismatched type - should return None
        assert!(parse_to_i64_with_type(&formatted_ws, IdType::Message).is_none());
        assert!(parse_to_i64_with_type(&formatted_ws, IdType::Conversation).is_none());

        // Test with invalid format - should return None
        assert!(parse_to_i64_with_type("invalid", IdType::Workspace).is_none());
        assert!(parse_to_i64_with_type("ws_123_001", IdType::Workspace).is_none()); // Incomplete

        // Test all ID types
        let test_cases = vec![
            IdType::Message,
            IdType::Conversation,
            IdType::Chat,
            IdType::Workspace,
            IdType::Session,
            IdType::Agent,
            IdType::Lock,
            IdType::Dag,
            IdType::Task,
            IdType::Turn,
        ];

        for id_type in test_cases {
            let id = generate();
            let formatted = format(id, id_type);
            let parsed =
                parse_to_i64_with_type(&formatted, id_type).expect("Failed to parse matching type");
            assert_eq!(id, parsed, "Roundtrip failed for {:?}", id_type);
        }
    }

    #[test]
    fn test_rebuild_after_clock_rollback_keeps_generating() {
        init(1);
        let before_machine_id = ErgataiSnowflakeParams::machine_id();
        let _pre_rollback = generate();

        rebuild_generator_after_clock_rollback();

        let after_machine_id = ErgataiSnowflakeParams::machine_id();
        assert_ne!(
            before_machine_id, after_machine_id,
            "rebuild must bump the machine-id offset so post-rebuild IDs \
             cannot collide with pre-rollback IDs"
        );

        let id = generate();
        assert!(id > 0, "generation must succeed after rebuild");
    }
}
