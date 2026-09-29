# UUID to ID Module Migration - ergatai-runtime

## Summary

Successfully migrated all UUID generation calls in `ergatai-runtime` crate from `uuid::Uuid::new_v4()` to the new centralized ID generation module using Snowflake algorithm.

## Changes Made

### 1. Module Relocation

**Problem**: The `id` module was initially in `ergatai-core`, which depends on `ergatai-runtime`, creating a cyclic dependency when `ergatai-runtime` needed to use it.

**Solution**: Moved the `id` module from `ergatai-core` to `ergatai-error` (a lower-level crate with no internal dependencies).

**Files Modified**:
- `crates/ergatai-error/Cargo.toml` - Added `snowdon = "0.2"` dependency
- `crates/ergatai-error/src/id.rs` - New location for ID module
- `crates/ergatai-error/src/lib.rs` - Added `pub mod id;`
- `crates/ergatai-core/Cargo.toml` - Removed `snowdon` dependency
- `crates/ergatai-core/src/lib.rs` - Changed to re-export: `pub use ergatai_error::id;`

### 2. UUID Replacements (11 total)

#### runtime.rs (3 calls)
- Line 212: Agent UUID generation in `launch_agent()`
- Line 356: Agent UUID in `register_discovered_agent()`
- Line 477: Agent UUID in `discover_and_register_agents()`

**IdType**: `IdType::Agent`
**Format**: `agent_{timestamp}_{instance}_{sequence}`

#### profile_registry.rs (3 calls)
- Line 66: Profile ID in `AgentRegistration::new()`
- Line 84: Profile ID in `AgentRegistration::with_package_name()`
- Line 103: Profile ID in `AgentRegistration::with_avatar_url()`

**IdType**: `IdType::Agent`
**Format**: `agent_{timestamp}_{instance}_{sequence}`

#### mcp_over_acp.rs (2 calls)
- Line 57: MCP server ID in `AcpMcpBridge::new()`
- Line 90: MCP connection ID in `handle_connect_request()`

**IdType**: `IdType::Session`
**Format**: `sess_{timestamp}_{instance}_{sequence}`

#### permission_service.rs (2 calls)
- Line 139: Permission request ID in `register()`
- Line 165: Permission request ID in `register_with_waiter()`

**IdType**: `IdType::Permission`
**Format**: `perm_{timestamp}_{instance}_{sequence}`

#### backends/acp.rs (1 call)
- Line 2288: Elicitation tracking ID

**IdType**: `IdType::Session`
**Format**: `sess_{timestamp}_{instance}_{sequence}`

### 3. Import Updates

All modified files now import from `ergatai_error::id`:
```rust
use ergatai_error::id::{format as format_id, generate, IdType};
```

### 4. Test Updates

Updated test assertion in `permission_service.rs`:
- Changed `assert!(request_id.starts_with("perm-"))` to `assert!(request_id.starts_with("perm_"))`
- Reflects new ID format using underscores instead of hyphens

## Benefits

1. **Ordered IDs**: Snowflake IDs are timestamp-ordered, optimal for B-tree indexing
2. **Compact**: 64-bit integer (8 bytes) vs UUID (36 bytes string)
3. **Informative**: Contains type prefix, timestamp, instance ID, and sequence
4. **Sortable**: Can be sorted by creation time
5. **Readable**: Type prefix aids debugging (e.g., `agent_`, `perm_`, `sess_`)

## Verification

✅ All UUID calls replaced (11 total)
✅ ergatai-error builds successfully
✅ ergatai-runtime builds successfully
✅ All tests pass (276 tests)
✅ No cyclic dependencies

## ID Format Examples

- Agent ID: `agent_1727568000000_001_0001`
- Permission ID: `perm_1727568000001_001_0002`
- Session ID: `sess_1727568000002_001_0003`

## Migration Pattern

**Before**:
```rust
let id = uuid::Uuid::new_v4().to_string();
// or
let id = format!("perm-{}", uuid::Uuid::new_v4());
```

**After**:
```rust
let id = format_id(generate(), IdType::Permission);
```

## Future Work

Consider migrating other crates in the workspace:
- ergatai-api
- ergatai-collab
- ergatai-dag
- ergatai-lock
- ergatai-nats
