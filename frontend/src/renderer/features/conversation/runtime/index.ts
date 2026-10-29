/**
 * Conversation Runtime
 *
 * Unified abstraction layer for conversation invocation across different
 * conversation contexts (main chat, side chat, split view, group chat).
 *
 * This module provides:
 * - Type definitions (contracts)
 * - Service layer (ConversationInvocationService)
 * - Resolvers (Conversation, AgentRuntime, Transport)
 * - State management (RuntimeSessionStore)
 * - React hooks (useConversationInvocation)
 *
 * @module conversation/runtime
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type {
  ConversationSource,
  ConversationRole,
  ConversationInvocationSource,
  ConversationSendMessageInput,
  ConversationStopInput,
  ConversationStatus,
  ConversationQueueItem,
  ConversationRuntimeError,
  ConversationRuntimeState,
  ConversationSendTicket,
  ResolvedConversation,
  ResolvedAgentRuntime,
} from "./contracts"

// ============================================================================
// SERVICE
// ============================================================================

export {
  getConversationInvocationService,
  resetConversationInvocationService,
  type ConversationInvocationService,
} from "./conversation-invocation-service"

// ============================================================================
// RESOLVERS
// ============================================================================

export {
  getConversationResolver,
  resetConversationResolver,
  type ConversationResolver,
} from "./conversation-resolver"

export {
  getAgentRuntimeResolver,
  resetAgentRuntimeResolver,
  type AgentRuntimeResolver,
} from "./agent-runtime-resolver"

export {
  getTransportResolver,
  resetTransportResolver,
  type TransportResolver,
  type TransportResolverContext,
  type ChatTransport,
} from "./transport-resolver"

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export {
  getRuntimeSessionStore,
  resetRuntimeSessionStore,
  type RuntimeSessionStore,
  type RuntimeSessionState,
} from "./runtime-session-store"

// ============================================================================
// ORCHESTRATOR
// ============================================================================

export {
  getTurnOrchestrator,
  resetTurnOrchestrator,
  type TurnOrchestrator,
} from "./turn-orchestrator"

// ============================================================================
// REACT HOOKS
// ============================================================================

export {
  useConversationInvocation,
  useSessionState,
  type UseConversationInvocationReturn,
} from "./use-conversation-invocation"

export {
  useRuntimeSessionSources,
  type RuntimeSessionSources,
} from "./use-runtime-session-sources"
