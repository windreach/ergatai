/**
 * Conversation Runtime Adapter
 *
 * Adapter interface that bridges the ConversationInvocationService with the actual
 * message transport. This allows the service to remain transport-agnostic while
 * delegating stream handling to proven implementations (like AI SDK Chat).
 *
 * Phase 16: Introduced to avoid reimplementing stream consumption logic.
 * Instead of having the service directly consume transport streams, we delegate
 * to adapters that can leverage existing, tested implementations.
 */

import type { ConversationRole, ConversationStatus } from "./contracts"
import type { MessagePart } from "../../agents/stores/message-store"

// ============================================================================
// ADAPTER INTERFACE
// ============================================================================

/**
 * Input for sending a message via adapter.
 */
export type AdapterSendMessageInput = {
  /** Message role (user or agent) */
  role: ConversationRole

  /** Message parts (text, images, files, etc.) */
  parts: MessagePart[]

  /** Insert at safe point instead of FIFO queue (interrupt current task) */
  interrupt?: boolean

  /** Correlation ID for queue matching (used by interrupt events) */
  correlationId?: string
}

/**
 * Adapter state for status synchronization.
 * This allows the service to track external turns (e.g., agent-to-agent messages).
 */
export type AdapterState = {
  /** Current runtime status */
  status: ConversationStatus

  /** Whether currently streaming */
  isStreaming: boolean

  /** ID of the streaming message (if streaming) */
  streamingMessageId?: string | null
}

/**
 * Listener for adapter state changes.
 */
export type AdapterStateListener = (state: AdapterState) => void

/**
 * Listener for safe point events (thinking ended, tool call completed).
 * This allows the orchestrator to automatically process queue at safe points.
 */
export type AdapterSafePointListener = () => void

/**
 * Conversation Runtime Adapter interface.
 *
 * This abstraction allows different transport implementations to be plugged into
 * the ConversationInvocationService. The service handles queue management, state
 * coordination, and lifecycle, while adapters handle the actual message sending
 * and stream consumption.
 */
export interface ConversationRuntimeAdapter {
  /**
   * Send a message and handle the response stream.
   *
   * The adapter is responsible for:
   * - Sending the message to the backend
   * - Consuming the response stream
   * - Updating the UI state (messages, status, etc.)
   *
   * @param input - Message to send
   */
  sendMessage(input: AdapterSendMessageInput): Promise<void>

  /**
   * Stop the current streaming response.
   *
   * The adapter should abort any in-progress stream and update state accordingly.
   */
  stop(): Promise<void>

  /**
   * Subscribe to adapter state changes (optional).
   *
   * This allows the service to synchronize its internal state with the adapter's
   * actual state, especially for external turns (e.g., agent-to-agent messages,
   * runtime cache turns) that bypass the service's send() method.
   *
   * @param listener - Callback invoked when adapter state changes
   * @returns Unsubscribe function
   */
  subscribe?(listener: AdapterStateListener): () => void

  /**
   * Subscribe to safe point events (optional).
   *
   * Safe points are moments when it's safe to inject new messages:
   * - Thinking ended (agent finished reasoning)
   * - Tool call completed (agent finished a tool)
   *
   * This allows the orchestrator to automatically process queue at safe points,
   * enabling "interrupt-like" behavior without explicit user action.
   *
   * @param listener - Callback invoked when a safe point is reached
   * @returns Unsubscribe function
   */
  subscribeSafePoint?(listener: AdapterSafePointListener): () => void
}

// ============================================================================
// ADAPTER REGISTRY
// ============================================================================

/**
 * Registry for conversation runtime adapters.
 * Maps conversation IDs to their corresponding adapters.
 */
class AdapterRegistry {
  private adapters = new Map<string, ConversationRuntimeAdapter>()

  /**
   * Register an adapter for a conversation.
   *
   * @param conversationId - Conversation ID
   * @param adapter - Adapter instance
   * @returns Unregister function
   */
  register(conversationId: string, adapter: ConversationRuntimeAdapter): () => void {
    this.adapters.set(conversationId, adapter)

    return () => {
      // Only delete if the current adapter is the one we registered
      // This prevents deleting a newer adapter if cleanup runs late
      if (this.adapters.get(conversationId) === adapter) {
        this.adapters.delete(conversationId)
      }
    }
  }

  /**
   * Get the adapter for a conversation.
   *
   * @param conversationId - Conversation ID
   * @returns Adapter or null if not found
   */
  get(conversationId: string): ConversationRuntimeAdapter | null {
    return this.adapters.get(conversationId) ?? null
  }

  /**
   * Check if an adapter exists for a conversation.
   *
   * @param conversationId - Conversation ID
   * @returns Whether adapter exists
   */
  has(conversationId: string): boolean {
    return this.adapters.has(conversationId)
  }
}

// ============================================================================
// GLOBAL REGISTRY INSTANCE
// ============================================================================

/**
 * Global adapter registry instance.
 */
let registryInstance: AdapterRegistry | null = null

/**
 * Get the global adapter registry.
 */
export function getAdapterRegistry(): AdapterRegistry {
  if (!registryInstance) {
    registryInstance = new AdapterRegistry()
  }
  return registryInstance
}

/**
 * Reset the registry (for testing).
 */
export function resetAdapterRegistry(): void {
  registryInstance = null
}
