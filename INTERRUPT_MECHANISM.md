# Agent Interrupt Mechanism

## Overview

The Agent Interrupt mechanism allows users to insert new messages at "safe points" in an agent's execution loop, rather than waiting in a FIFO queue. This enables more responsive interaction by pausing the current task and processing urgent messages immediately.

## Safe Points

Interrupts are processed at the following safe points in the agent's execution:

1. **After Thinking Completes**: When the LLM finishes generating a response
2. **After Tool Calls Complete**: When all tool executions in a turn are finished
3. **Before Next Thinking Starts**: At the beginning of a new prompt turn

## API Usage

### Basic Request

```bash
POST /api/v1/agents/:id/prompt
Content-Type: application/json

{
  "message": "Urgent: Stop and review your approach",
  "interrupt": true
}
```

### Request Body

```typescript
{
  message: string,                    // The message content
  interrupt?: boolean,                // Whether to interrupt (default: false)
  conversation_id?: string,           // Optional conversation ID
  images?: AgentImage[],              // Optional image attachments
  // ... other fields
}
```

### Response

```json
{
  "status": "interrupt_queued",
  "prompt_id": "sess_abc123",
  "message": "Interrupt message queued for processing at next safe point"
}
```

## Behavior

### When `interrupt: false` (default)

- Message is added to the FIFO queue
- Processed after all previous messages complete
- Standard queue behavior

### When `interrupt: true`

- Message is queued for immediate processing at the next safe point
- Current task is paused (state preserved)
- Interrupt message is processed
- User can choose to resume the paused task after

## Event Flow

```
User sends interrupt message
  ↓
API receives POST /api/v1/agents/:id/prompt with interrupt: true
  ↓
API calls AcpBackend::inject_interrupt()
  ↓
AcpCommand::InterruptPrompt sent to connection task
  ↓
Connection task processes interrupt at next safe point
  ↓
AgentInterrupted event published to NATS
  ↓
SSE clients receive real-time notification
  ↓
Current task paused, interrupt message processed
```

## Implementation Details

### Core Components

1. **AcpCommand::InterruptPrompt**: New command variant in the ACP command enum
2. **AcpAgentEntry**: Extended with interrupt tracking fields:
   - `pending_interrupts`: Queue of pending interrupt messages
   - `paused_task`: Currently paused task (if any)
   - `current_message_id`: ID of the message being processed
3. **AcpBackend::inject_interrupt()**: Public method to inject interrupt messages
4. **AgentInterrupted Event**: NATS event for real-time notifications

### Thread Safety

All interrupt-related state is protected by appropriate synchronization primitives:
- `pending_interrupts`: `Arc<parking_lot::Mutex<VecDeque<PendingInterrupt>>>`
- `paused_task`: `Arc<RwLock<Option<PausedTask>>>`
- `current_message_id`: `Arc<RwLock<Option<String>>>`

### State Preservation

When an interrupt occurs:
1. The current task's state is saved in `PausedTask`
2. The interrupt message is processed
3. After processing, the paused task can be resumed via `resume_paused_task()`

## Events

### AgentInterrupted

Published to `ergatai.agent.interrupted.{agent_id}` when an interrupt is processed.

```rust
pub struct AgentInterrupted {
    pub agent_id: String,
    pub paused_message_id: Option<String>,
    pub new_message_id: String,
    pub interrupted_at: u64,  // Unix timestamp
    pub conversation_id: Option<String>,
}
```

SSE clients can subscribe to this event for real-time UI updates.

## Testing

Integration tests are available in `crates/ergatai-runtime/tests/interrupt_tests.rs`:

```bash
cargo test --package ergatai-runtime --test interrupt_tests
```

## Limitations

1. **No Preemption**: Interrupts are not preemptive; they wait for the next safe point
2. **No Automatic Resume**: Paused tasks are not automatically resumed; user must explicitly resume
3. **Single Paused Task**: Only one task can be paused at a time (new interrupts overwrite the previous paused task)

## Future Enhancements

- [ ] Multiple paused tasks (stack/queue)
- [ ] Automatic resume after interrupt processing
- [ ] Timeout for interrupt processing (force interrupt if safe point not reached)
- [ ] Persistence of paused tasks across restarts
- [ ] UI indicators for paused state
- [ ] Interrupt priority levels

## Related Files

- `crates/ergatai-runtime/src/backends/acp.rs`: Core implementation
- `crates/ergatai-api/src/api/agents.rs`: API handler
- `crates/ergatai-nats/src/events.rs`: Event definitions
- `crates/ergatai-nats/src/event_bus.rs`: Event publishing
- `crates/ergatai-runtime/tests/interrupt_tests.rs`: Integration tests
