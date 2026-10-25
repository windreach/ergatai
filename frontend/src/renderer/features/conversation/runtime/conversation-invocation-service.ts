/**
 * Conversation Invocation Service
 *
 * This is the main facade for conversation invocation. It provides a unified
 * interface for sending messages, stopping streams, and managing queues across
 * different conversation contexts (main chat, side chat, split view, group chat).
 *
 * Phase 7+: Updated to use Turn Orchestrator and Runtime Session Store.
 * The service now delegates to dedicated resolvers and stores.
 *
 * Phase 15: Fixed stop() to actually abort the transport stream.
 * - Retrieves AbortController from session store
 * - Calls abort() to cancel the transport stream
 * - Clears abort controller after stopping
 */

import type {
  ConversationSendMessageInput,
  ConversationStopInput,
  ConversationRuntimeState,
  ConversationSendTicket,
} from "./contracts"

import { getTurnOrchestrator } from "./turn-orchestrator"
import { getRuntimeSessionStore } from "./runtime-session-store"
import { getAdapterRegistry } from "./runtime-adapter"
import { useStreamingStatusStore } from "../../agents/stores/streaming-status-store"
import { trpcClient } from "../../../lib/trpc"

// ============================================================================
// SERVICE INTERFACE - Public API
// ============================================================================

/**
 * Conversation Invocation Service interface.
 * This is the public API that UI components will use.
 */
export interface ConversationInvocationService {
  /**
   * Send a message in a conversation.
   *
   * This will:
   * 1. Resolve the conversation context
   * 2. Resolve the agent runtime
   * 3. Resolve the transport
   * 4. Check if agent is ready
   * 5. Either send immediately or enqueue
   *
   * @param input - Send input
   * @returns Send ticket for tracking
   */
  send(input: ConversationSendMessageInput): Promise<ConversationSendTicket>

  /**
   * Stop message streaming in a conversation.
   *
   * @param input - Stop input
   */
  stop(input: ConversationStopInput): Promise<void>

  /**
   * Enqueue a message for later sending.
   *
   * @param input - Send input
   * @returns Send ticket for tracking
   */
  enqueue(input: ConversationSendMessageInput): Promise<ConversationSendTicket>

  /**
   * Remove a queued item.
   *
   * @param conversationId - Conversation ID
   * @param itemId - Queue item ID
   */
  removeQueuedItem(conversationId: string, itemId: string): Promise<void>

  /**
   * Send a queued item immediately.
   *
   * @param conversationId - Conversation ID
   * @param itemId - Queue item ID
   */
  sendQueuedItem(conversationId: string, itemId: string): Promise<void>

  /**
   * Get the current runtime state of a conversation.
   *
   * @param conversationId - Conversation ID
   * @returns Runtime state or null if not found
   */
  getSessionState(conversationId: string): ConversationRuntimeState | null

  /**
   * Subscribe to runtime state changes.
   *
   * @param conversationId - Conversation ID
   * @param listener - State change listener
   * @returns Unsubscribe function
   */
  subscribeSessionState(
    conversationId: string,
    listener: (state: ConversationRuntimeState) => void,
  ): () => void

  /**
   * Release a session (cleanup when conversation is closed).
   *
   * @param conversationId - Conversation ID
   */
  releaseSession(conversationId: string): void
}

// ============================================================================
// SERVICE IMPLEMENTATION
// ============================================================================

/**
 * Conversation Invocation Service implementation.
 *
 * This service delegates to:
 * - Turn Orchestrator for send/sendQueuedItem operations
 * - Runtime Session Store for state management
 * - Streaming Status Store for streaming status (legacy compatibility)
 */
class ConversationInvocationServiceImpl implements ConversationInvocationService {
  /**
   * Send a message in a conversation.
   * Delegates to Turn Orchestrator.
   */
  async send(input: ConversationSendMessageInput): Promise<ConversationSendTicket> {
    return await getTurnOrchestrator().send(input)
  }

  /**
   * Stop message streaming.
   * Phase 16: Delegates to adapter to stop the stream.
   * Phase 18: Also calls backend cancel API to stop agent processing.
   * This is the unified entry point for stopping, ensuring the backend
   * is always notified regardless of transport implementation.
   * Also clears currentTurnId to prevent stale callbacks from updating state.
   *
   * Fixed: Use top-level import for trpcClient to avoid SSR issues.
   * Added: Debounce mechanism to prevent duplicate stop() calls.
   */
  async stop(input: ConversationStopInput): Promise<void> {
    const { conversationId, agentId } = input
    const sessionStore = getRuntimeSessionStore()

    // Check if already stopping (debounce)
    const session = sessionStore.getSession(conversationId)
    if (session?.status === "idle" || session?.status === "ready") {
      // Already stopped or not started
      return
    }

    // Clear current turn ID to prevent stale callbacks
    sessionStore.setCurrentTurnId(conversationId, null)

    // Get adapter for this conversation
    const adapter = getAdapterRegistry().get(conversationId)
    if (adapter) {
      try {
        await adapter.stop()
      } catch (error) {
        console.warn("[ConversationInvocationService] Error stopping adapter:", error)
        // Continue with backend cancel even if adapter.stop() fails
        // The backend needs to know to stop processing
      }
    }

    // Call backend cancel API to stop agent processing
    // This is the unified entry point - transport layer should NOT call this
    if (agentId) {
      try {
        void trpcClient.ergatai.cancelPrompt.mutate({ agentId }).catch((error) => {
          console.warn("[ConversationInvocationService] Error calling cancel API:", error)
        })
      } catch (error) {
        console.warn("[ConversationInvocationService] Failed to call cancel API:", error)
      }
    }

    // Update streaming status (legacy compatibility)
    useStreamingStatusStore.getState().setStatus(conversationId, "ready")

    // Update session state
    sessionStore.setStatus(conversationId, "ready")
    sessionStore.setStreamingMessageId(conversationId, null)
  }

  /**
   * Enqueue a message for later sending.
   * Phase 16: Fixed to unconditionally queue the message.
   * Unlike send(), this should never send immediately.
   */
  async enqueue(input: ConversationSendMessageInput): Promise<ConversationSendTicket> {
    const sessionStore = getRuntimeSessionStore()
    const conversationId = input.conversation.conversationId

    // Validate conversationId
    if (!conversationId || conversationId.trim() === "") {
      throw new Error("Invalid conversationId: cannot enqueue message without a valid conversation ID")
    }

    // Ensure session exists
    sessionStore.ensureSession(conversationId)

    // Create queue item
    const queueItemId = `queue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const queueItem = {
      id: queueItemId,
      originalInput: input,
      status: "pending" as const,
      queuedAt: new Date(),
    }

    // Add to queue unconditionally
    sessionStore.addQueueItem(conversationId, queueItem)

    return {
      ticketId: `ticket_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      conversationId,
      queued: true,
      queueItemId,
    }
  }

  /**
   * Remove a queued item.
   * Delegates to Runtime Session Store.
   */
  async removeQueuedItem(conversationId: string, itemId: string): Promise<void> {
    getRuntimeSessionStore().removeQueueItem(conversationId, itemId)
  }

  /**
   * Send a queued item immediately.
   * Delegates to Turn Orchestrator.
   */
  async sendQueuedItem(conversationId: string, itemId: string): Promise<void> {
    await getTurnOrchestrator().sendQueuedItem(conversationId, itemId)
  }

  /**
   * Get the current runtime state.
   * Delegates to Runtime Session Store.
   */
  getSessionState(conversationId: string): ConversationRuntimeState | null {
    return getRuntimeSessionStore().getRuntimeState(conversationId)
  }

  /**
   * Subscribe to runtime state changes.
   * Delegates to Runtime Session Store.
   */
  subscribeSessionState(
    conversationId: string,
    listener: (state: ConversationRuntimeState) => void,
  ): () => void {
    return getRuntimeSessionStore().subscribe(conversationId, listener)
  }

  /**
   * Release a session.
   * Delegates to Runtime Session Store.
   */
  releaseSession(conversationId: string): void {
    // Cleanup session state
    getRuntimeSessionStore().releaseSession(conversationId)

    // Cleanup streaming status (legacy compatibility)
    useStreamingStatusStore.getState().clearStatus(conversationId)
  }
}

// ============================================================================
// SERVICE INSTANCE - Singleton
// ============================================================================

/**
 * Global service instance.
 */
let serviceInstance: ConversationInvocationService | null = null

/**
 * Get the Conversation Invocation Service instance.
 */
export function getConversationInvocationService(): ConversationInvocationService {
  if (!serviceInstance) {
    serviceInstance = new ConversationInvocationServiceImpl()
  }
  return serviceInstance
}

/**
 * Reset the service instance (for testing).
 */
export function resetConversationInvocationService(): void {
  serviceInstance = null
}
