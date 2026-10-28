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
import { generateTicketId, generateQueueItemId } from "./id-generators"
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
   * Set of conversation IDs currently being stopped.
   * Used to deduplicate concurrent stop() calls and prevent race conditions.
   */
  private stoppingSet = new Set<string>()

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
   * Fixed: Added stoppingSet to deduplicate concurrent stop() calls and prevent
   * race conditions where multiple calls proceed in parallel.
   */
  async stop(input: ConversationStopInput): Promise<void> {
    const { conversationId, agentId, agentIds } = input

    // Deduplication: if already stopping this conversation, return early
    if (this.stoppingSet.has(conversationId)) {
      return
    }

    // Mark as stopping to prevent concurrent duplicate calls
    this.stoppingSet.add(conversationId)

    try {
      const sessionStore = getRuntimeSessionStore()

      // Check if already stopped or not started
      const session = sessionStore.getSession(conversationId)
      if (!session || session.status === "idle" || session.status === "ready") {
        // Already stopped or not started - nothing to do
        return
      }

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

      // Clear current turn ID AFTER adapter.stop() completes
      // This ensures the adapter can read turnId during cleanup if needed
      sessionStore.setCurrentTurnId(conversationId, null)

      // Call backend cancel API to stop agent processing
      // This is the unified entry point - transport layer should NOT call this
      // Support both single agentId (backward compat) and multiple agentIds (group chat)
      const agentsToCancel = agentIds ?? (agentId ? [agentId] : [])
      if (agentsToCancel.length > 0) {
        // Set up timeout to prevent hanging
        let timeoutId: NodeJS.Timeout | undefined

        try {
          // Await cancel with timeout to prevent hanging
          await Promise.race([
            Promise.all(
              agentsToCancel.map((id) =>
                trpcClient.ergatai.cancelPrompt
                  .mutate({ agentId: id })
                  .catch((error) => {
                    console.warn(`[ConversationInvocationService] Error calling cancel API for agent ${id}:`, error)
                  })
              )
            ),
            new Promise<void>((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error('Cancel timeout after 5000ms'))
              }, 5000)
            })
          ])
        } catch (error) {
          console.warn("[ConversationInvocationService] Cancel API timeout or error:", error)
          // Continue anyway - don't block on cancel failure
        } finally {
          // Always clear the timeout to prevent memory leak and unhandled rejection
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId)
          }
        }
      }

      // Now safe to set status to ready - cancel API has resolved or timed out
      // Update streaming status (legacy compatibility)
      useStreamingStatusStore.getState().setStatus(conversationId, "ready")

      // Update session state
      sessionStore.setStatus(conversationId, "ready")
      sessionStore.setStreamingMessageId(conversationId, null)
    } finally {
      // Always remove from stopping set, even if an error occurred
      this.stoppingSet.delete(conversationId)
    }
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
    const queueItemId = generateQueueItemId()
    const queueItem = {
      id: queueItemId,
      originalInput: input,
      status: "pending" as const,
      queuedAt: new Date(),
    }

    // Add to queue unconditionally
    sessionStore.addQueueItem(conversationId, queueItem)

    return {
      ticketId: generateTicketId(),
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
