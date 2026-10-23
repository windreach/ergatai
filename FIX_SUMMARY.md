# Fix Summary: Output Accumulator and Database Initialization

## Issues Fixed

### P1: Database Schema Migration (Development Mode)
**Problem**: Code used `CREATE TABLE IF NOT EXISTS` which preserved old schema with nullable `profile_id` columns. New code expected `NOT NULL DEFAULT ''`, causing old rows with NULL to be unreachable via new queries. Strategy contradiction: "preserve old DB" + "no migrations" = broken schema for existing users.

**Solution**: Reverted to destructive initialization - drop all tables on startup and recreate. This is appropriate for development where data persistence across restarts is not required.

**Files Modified**:
- `crates/ergatai-api/src/user_data_db.rs`: Added `DROP TABLE IF EXISTS` for all tables before `CREATE TABLE`

### P2: Turn Generation to Prevent Cross-Turn Pollution
**Problem**: Output accumulator registry was keyed only by `conversation_id`. Late events from a previous turn could arrive after the next turn started and pollute the new turn's accumulator.

**Solution**: 
1. Introduced `TurnToken` containing `conversation_id`, `generation`, and `accumulator`
2. Registry now uses `(conversation_id, generation)` as composite key
3. Each conversation has a monotonically increasing generation counter
4. `begin_turn()` increments generation and returns a `TurnToken`
5. `send_output_event()` and `flush()` require a `TurnToken`
6. Added `get()` validation to ensure token generation matches current generation
7. Added `get_current_token()` for notification handlers that don't have the token
8. Fixed lock ordering to prevent deadlock (generations → accumulators)

**Files Modified**:
- `crates/ergatai-runtime/src/output_accumulator.rs`: Added `TurnToken`, generation tracking, lock order fix
- `crates/ergatai-runtime/src/backends/acp.rs`: Updated all call sites to use `TurnToken`

### P3: Failed Turns Persist Without Done Metadata
**Problem**: Failure paths (interrupt/queued prompt/normal prompt) called `flush_and_persist_output()` without sending a terminal `Done` event first. Persisted metadata lacked `stop_reason`, making it impossible to distinguish clean termination from failure.

**Solution**: All three failure paths now send `AgentOutputEvent::Done { stop_reason: "error" }` before flushing. Success paths send `Done { stop_reason: "end_turn" }` (or similar) before flushing.

**Files Modified**:
- `crates/ergatai-runtime/src/backends/acp.rs`: Updated failure paths to send Done event before flush

## Implementation Details

### Turn Generation Mechanism

```rust
pub struct TurnToken {
    pub conversation_id: String,
    pub generation: u64,
    pub accumulator: Arc<Mutex<TurnAccumulator>>,
}

pub struct OutputAccumulatorRegistry {
    // Maps (conversation_id, generation) to accumulator
    accumulators: RwLock<HashMap<AccumulatorKey, AccumulatorValue>>,
    // Current generation for each conversation
    generations: RwLock<HashMap<String, u64>>,
}
```

**Lock Order**: `generations` → `accumulators` (consistent across all methods to prevent deadlock)

**Turn Lifecycle**:
1. `begin_turn()` increments generation, creates new accumulator, returns `TurnToken`
2. Prompt handler stores the token in `task_current_turn_token` (shared with notification handlers)
3. Notification handlers clone the shared token via `send_output_event_with_turn_token()`
4. Prompt terminal events (success/failure Done + flush) use the token
5. After flush, prompt handler clears `task_current_turn_token`
6. Notifications arriving after token clearing are rejected (no accumulation or publishing)
7. Prompt terminal events with stale tokens are rejected by `get()` generation validation

### Notification Turn Attribution

Notification handlers use `send_output_event_with_turn_token()` which:
- Reads the shared `task_current_turn_token`
- If token exists: uses it for accumulation (strict turn attribution)
- If token is None: rejects the event (no accumulation, no publishing)
- This ensures notifications are strictly bound to the prompt's turn lifecycle

**Cross-turn pollution prevention**:
- Prompt execution: notifications use turn-scoped token → correct attribution
- After prompt completion: token cleared → late notifications rejected
- Stale tokens (from previous turns): rejected by `get()` generation validation

## Testing

All tests pass:
```bash
cargo build -p ergatai-runtime -p ergatai-api  # ✅ Success
cargo test -p ergatai-runtime -p ergatai-api --lib  # ✅ 574 passed
cargo clippy -p ergatai-runtime -p ergatai-api --all-targets -- -D warnings  # ✅ No issues
cargo fmt --all -- --check  # ✅ Pass
```

## Remaining Considerations

1. **Notification Turn Attribution**: If ACP protocol does not guarantee notification ordering, a strict solution would require binding notifications to their originating turn or adding a drain barrier. Current implementation relies on protocol guarantees.

2. **Production Database Strategy**: Current destructive initialization is appropriate for development. Production deployments would need a proper migration strategy or persistent schema management.

3. **Performance**: Synchronous accumulation in `send_output_event()` adds minimal overhead (lock acquisition). Events are already serialized per conversation, so this does not impact throughput.
