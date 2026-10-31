/**
 * Conversation Runtime Contracts
 *
 * This file defines the core types for the conversation invocation abstraction.
 * These types provide a unified interface for sending messages across different
 * conversation contexts (main chat, side chat, split view, group chat).
 *
 * Phase 1: Type definitions only - no behavior changes.
 */

import type { Message, MessagePart } from "../../agents/stores/message-store"

// ============================================================================
// CONVERSATION PROVIDER - Provider type aliases
// ============================================================================

/**
 * Supported conversation providers.
 */
export type ConversationProvider = "claude-code" | "codex"

/**
 * Conversation mode types.
 */
export type ConversationMode = "normal" | "group" | "agent"

// ============================================================================
// CONVERSATION SOURCE - Where the conversation is being initiated
// ============================================================================

/**
 * The source/pane type where the conversation is initiated.
 * - main: Primary chat view
 * - side: Sidebar/diff view
 * - split: Split pane view
 * - group: Group chat with multiple agents
 */
export type ConversationSource = "main" | "side" | "split" | "group"

// ============================================================================
// CONVERSATION ROLE - Message initiator type
// ============================================================================

/**
 * Simplified role for conversation invocation.
 * - user: Human user input
 * - agent: Agent-initiated messages (request to other agents)
 *
 * Note: This is different from MessageRole which includes "assistant" and "system".
 * ConversationRole is for invocation intent, not message rendering.
 */
export type ConversationRole = "user" | "agent"

// ============================================================================
// CONVERSATION INVOCATION SOURCE - Identifies the conversation context
// ============================================================================

/**
 * Identifies a specific conversation context for message invocation.
 * This is the input to the conversation resolver.
 */
export type ConversationInvocationSource = {
  /** Local chat instance ID (frontend state) */
  chatId: string

  /** Frontend conversation ID */
  conversationId: string

  /** Backend conversation ID (if exists in database) */
  backendConversationId?: string | null

  /** Target agent ID (for agent-specific conversations) */
  agentId?: string | null

  /** Provider type (claude-code or codex) */
  provider?: ConversationProvider

  /** Source pane type */
  source: ConversationSource
}

// ============================================================================
// CONVERSATION SEND INPUT - Message sending request
// ============================================================================

/**
 * Input for sending a message in a conversation.
 * This is the primary input to ConversationInvocationService.send().
 */
export type ConversationSendMessageInput = {
  /** Conversation context */
  conversation: ConversationInvocationSource

  /** Message role (user or agent) */
  role: ConversationRole

  /** Message parts (text, tool calls, etc.) */
  parts: MessagePart[]

  /** Source agent ID (for agent-to-agent messages) */
  fromAgentId?: string

  /** Target agent ID (for agent-to-agent messages) */
  targetAgentId?: string

  /** Force send even if agent is not ready (enqueue if necessary) */
  forceSend?: boolean

  /** Insert at safe point instead of FIFO queue (interrupt current task) */
  interrupt?: boolean

  /** Transport overrides */
  transportOverrides?: {
    /** Conversation mode */
    mode?: ConversationMode

    /** Workspace ID (for workspace-specific transports) */
    workspaceId?: string

    /** Command to execute (for CLI transports) */
    command?: string

    /** Force new session (don't reuse existing session) */
    forceNewSession?: boolean

    /** Correlation ID (for request tracking) */
    correlationId?: string

    /** Backend-issued message ID used for optimistic/durable correlation */
    externalMessageId?: string
  }
}

// ============================================================================
// CONVERSATION STOP INPUT - Stop streaming request
// ============================================================================

/**
 * Input for stopping message streaming in a conversation.
 */
export type ConversationStopInput = {
  /** Conversation ID to stop */
  conversationId: string

  /** Chat instance ID */
  chatId: string

  /** Agent ID (for calling backend cancel API) - single agent case */
  agentId?: string | null

  /** Agent IDs (for calling backend cancel API) - multiple agents case (group chat) */
  agentIds?: string[]
}

// ============================================================================
// CONVERSATION STATUS - Runtime state
// ============================================================================

/**
 * Conversation runtime status.
 * - idle: No active session
 * - loading: Session is being initialized
 * - ready: Session is ready to send messages
 * - streaming: Message is being streamed
 * - completed: Turn completed successfully
 * - error: Error occurred
 */
export type ConversationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "streaming"
  | "completed"
  | "error"

// ============================================================================
// CONVERSATION QUEUE ITEM - Queued message
// ============================================================================

/**
 * A queued message waiting to be sent.
 * This wraps AgentQueueItem with additional conversation context.
 */
export type ConversationQueueItem = {
  /** Queue item ID */
  id: string

  /** Original send input (for retry/resend) */
  originalInput: ConversationSendMessageInput

  /** Queue status */
  status: "pending" | "processing" | "completed" | "failed"

  /** Queue timestamp */
  queuedAt: Date

  /** Error message (if failed) */
  error?: string
}

// ============================================================================
// CONVERSATION RUNTIME ERROR - Error information
// ============================================================================

/**
 * Error information for conversation invocation.
 */
export type ConversationRuntimeError = {
  /** Error code */
  code: string

  /** Error message */
  message: string

  /** Error details (for debugging) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Error details vary by source; typed as any for flexibility
  details?: any

  /** Timestamp */
  timestamp: Date
}

// ============================================================================
// CONVERSATION RUNTIME STATE - Complete runtime state
// ============================================================================

/**
 * Complete runtime state for a conversation.
 * This is the output of ConversationInvocationService.getSessionState().
 */
export type ConversationRuntimeState = {
  /** Conversation ID */
  conversationId: string

  /** Runtime status */
  status: ConversationStatus

  /** Persisted messages (from backend/database) */
  persistedMessages: Message[]

  /** Runtime messages (from streaming/session) */
  runtimeMessages: Message[]

  /** Raw messages owned by the local AI SDK Chat transport. */
  localMessages: Message[]

  /** Visible messages (merged persisted + runtime, deduplicated) */
  visibleMessages: Message[]

  /**
   * Whether currently streaming.
   * INVARIANT: MUST equal `status === 'streaming'`.
   * Kept for convenience but must stay in sync with status field.
   */
  isStreaming: boolean

  /** Queued messages */
  queue: ConversationQueueItem[]

  /** Current error (if any) */
  error?: ConversationRuntimeError

  /** Streaming message ID (if streaming) */
  streamingMessageId?: string | null

  /** Last runtime sequence number (for sync) */
  lastRuntimeSequence?: number

  /** ACP context window: tokens currently used (real-time from SSE) */
  contextUsed?: number

  /** ACP context window: total size (real-time from SSE) */
  contextWindow?: number
}

// ============================================================================
// CONVERSATION SEND TICKET - Send operation result
// ============================================================================

/**
 * Result of a send operation.
 * This provides a handle to track the send operation.
 */
export type ConversationSendTicket = {
  /** Ticket ID (for tracking) */
  ticketId: string

  /** Conversation ID */
  conversationId: string

  /** Whether the message was queued */
  queued: boolean

  /** Queue item ID (if queued) */
  queueItemId?: string

  /** Message ID (if sent immediately) */
  messageId?: string
}

// ============================================================================
// RESOLVED CONVERSATION - Output of ConversationResolver
// ============================================================================

/**
 * Fully resolved conversation context.
 * This is the output of ConversationResolver.resolve().
 */
export type ResolvedConversation = {
  /** Conversation ID */
  conversationId: string

  /** Backend conversation ID */
  backendConversationId: string

  /** Chat instance ID */
  chatId: string

  /** Agent ID (if agent-specific) */
  agentId?: string | null

  /** Provider type */
  provider: ConversationProvider

  /** Conversation mode */
  mode: ConversationMode

  /** Workspace ID (if workspace-specific) */
  workspaceId?: string

  /** Source pane type */
  source: ConversationSource
}

// ============================================================================
// RESOLVED AGENT RUNTIME - Output of AgentRuntimeResolver
// ============================================================================

/**
 * Resolved agent runtime state.
 * This is the output of AgentRuntimeResolver.resolve().
 */
export type ResolvedAgentRuntime = {
  /** Agent ID */
  agentId?: string | null

  /** Target agent ID (for agent-to-agent) */
  targetAgentId?: string | null

  /** Source agent ID (for agent-to-agent) */
  fromAgentId?: string | null

  /** Provider type */
  provider: ConversationProvider

  /** Whether agent is alive and ready */
  isAlive: boolean

  /** Whether agent can be started */
  canStart: boolean

  /** Reason if cannot start */
  reason?: "agent-missing" | "agent-stopped" | "not-bound" | "invalid-mode"

  /** Whether message should be queued (agent not ready but can wait) */
  shouldQueue?: boolean
}
