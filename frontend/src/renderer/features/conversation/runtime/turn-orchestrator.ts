/**
 * Turn Orchestrator
 *
 * Orchestrates a complete conversation turn. This is the core of the
 * ConversationInvocationService, responsible for:
 * - Coordinating conversation resolution
 * - Coordinating agent runtime resolution
 * - Coordinating transport resolution
 * - Managing the send/queue decision
 * - Managing session state transitions
 *
 * Phase 7: Initial implementation.
 * Phase 14+: Updated to use new ChatTransport interface (sendMessages instead of send).
 * Phase 15: Fixed streaming status check and abort controller management.
 * - Check session.status === "streaming" before sending (enqueue if streaming)
 * - Create and store AbortController for each turn
 * - Pass abort signal to transport for proper stop() support
 * This orchestrator will be used by ConversationInvocationService to execute send operations.
 */

import type {
  ConversationSendMessageInput,
  ConversationSendTicket,
  ConversationQueueItem,
  ResolvedConversation,
  ResolvedAgentRuntime,
} from "./contracts"

import { getConversationResolver } from "./conversation-resolver"
import { getAgentRuntimeResolver } from "./agent-runtime-resolver"
import { getRuntimeSessionStore } from "./runtime-session-store"
import { getAdapterRegistry } from "./runtime-adapter"
import { generateTicketId, generateQueueItemId } from "./id-generators"
import { getMessageCorrelationService } from "./message-correlation-service"

// ============================================================================
// ORCHESTRATOR INTERFACE - Public API
// ============================================================================

/**
 * Turn Orchestrator interface.
 */
export interface TurnOrchestrator {
  /**
   * Execute a send operation.
   *
   * @param input - Send input
   * @returns Send ticket
   */
  send(input: ConversationSendMessageInput): Promise<ConversationSendTicket>

  /**
   * Execute a send operation for a queued item.
   *
   * @param conversationId - Conversation ID
   * @param itemId - Queue item ID
   * @returns Send ticket
   */
  sendQueuedItem(conversationId: string, itemId: string): Promise<ConversationSendTicket>
}

// ============================================================================
// ORCHESTRATOR IMPLEMENTATION
// ============================================================================

/**
 * Turn Orchestrator implementation.
 *
 * Phase 7: This orchestrator coordinates the complete send flow:
 * 1. Resolve conversation
 * 2. Resolve agent runtime
 * 3. Check if can send or should queue
 * 4. Resolve transport
 * 5. Ensure session exists
 * 6. Send message or enqueue
 * 7. Update session state
 */
class TurnOrchestratorImpl implements TurnOrchestrator {
  /**
   * Handle send errors by updating session state.
   * Extracted to avoid duplication between .catch() and outer catch blocks.
   *
   * @param conversationId - Conversation ID
   * @param error - Error that occurred
   * @param turnId - Optional turn ID to clear if it matches current turn
   */
  private handleSendError(
    conversationId: string,
    error: unknown,
    turnId?: string,
  ): void {
    const sessionStore = getRuntimeSessionStore()
    sessionStore.setError(conversationId, {
      code: "SEND_FAILED",
      message: error instanceof Error ? error.message : "Unknown error",
      details: error,
      timestamp: new Date(),
    })
    sessionStore.setStatus(conversationId, "error")
    if (turnId && sessionStore.getCurrentTurnId(conversationId) === turnId) {
      sessionStore.setCurrentTurnId(conversationId, null)
    }
  }

  /**
   * Execute a send operation.
   * Phase 16: Refactored to use adapter instead of directly calling transport.
   * This allows leveraging existing Chat implementations for stream handling.
   * Phase 19: Added interrupt support - when interrupt=true and streaming,
   * send immediately at safe point instead of enqueuing.
   *
   * @param input - Send input
   * @returns Send ticket
   */
  async send(input: ConversationSendMessageInput): Promise<ConversationSendTicket> {
    const conversationId = input.conversation.conversationId
    const sessionStore = getRuntimeSessionStore()

    // Fix: Declare unsubscribeFromAdapter outside try block so it's accessible in catch
    // This prevents subscription leaks when exceptions occur between subscribe and sendMessage
    let unsubscribeFromAdapter: (() => void) | undefined

    try {
      // Step 1: Resolve conversation
      const conversation = await getConversationResolver().resolve(input.conversation)

      // Step 2: Resolve agent runtime
      const runtime = await getAgentRuntimeResolver().resolve(conversation)

      // Step 3: Ensure session exists and check streaming status
      const session = sessionStore.ensureSession(conversationId)

      // Every locally submitted message gets one correlation identity before it
      // can be queued or streamed. Adapters use this same ID for the optimistic
      // UI copy; the backend stores it as externalMessageId on the canonical copy.
      const messageCorrelation = await getMessageCorrelationService().createCorrelation()
      input = {
        ...input,
        transportOverrides: {
          ...input.transportOverrides,
          ...messageCorrelation.transportOverrides,
        },
      }

      // CRITICAL: Check if already streaming
      let interruptQueueItemId: string | undefined
      if (session.status === "streaming") {
        // Phase 19: Interrupt support - if interrupt=true, enqueue AND send immediately at safe point
        // The backend will handle inserting at the next safe point and notify via message_inserted event
        if (input.interrupt) {
          // Generate clientRequestId for queue matching
          const clientRequestId = `interrupt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

          // Add clientRequestId to transportOverrides for queue item matching
          input = {
            ...input,
            transportOverrides: {
              ...input.transportOverrides,
              correlationId: clientRequestId,
            },
          }

          // Enqueue first (for UI display and tracking)
          const queueTicket = await this.enqueue(input, conversation)
          interruptQueueItemId = queueTicket.queueItemId

          // Continue to send immediately (don't return)
          // The adapter will pass interrupt=true to backend
          // When backend inserts the message, it will publish message_inserted event
          // Frontend will receive the event and remove the queue item
        } else {
          // Default behavior: enqueue and wait
          return await this.enqueue(input, conversation)
        }
      }

      // Step 4: Check if can send or should queue
      if (!runtime.canStart) {
        if (input.forceSend || runtime.shouldQueue) {
          return await this.enqueue(input, conversation)
        }

        throw new Error(`Cannot send message: ${runtime.reason ?? "agent not ready"}`)
      }

      // Step 5: Get adapter for this conversation
      const adapter = getAdapterRegistry().get(conversationId)
      if (!adapter) {
        throw new Error(
          `No runtime adapter registered for conversation: ${conversationId}. ` +
          `Please ensure the chat component has registered an adapter.`
        )
      }

      // Step 6: Subscribe to adapter state changes (if supported)
      // This allows service to track external turns (e.g., agent-to-agent messages)
      if (adapter.subscribe) {
        unsubscribeFromAdapter = adapter.subscribe((state) => {
          // Synchronize adapter state with session store
          const currentTurnId = sessionStore.getCurrentTurnId(conversationId)

          // Only update if status changed
          if (session.status !== state.status) {
            sessionStore.setStatus(conversationId, state.status)

            // Update streaming message ID if available
            if (state.streamingMessageId !== undefined) {
              sessionStore.setStreamingMessageId(conversationId, state.streamingMessageId)
            }

            // If status changed to ready/completed and we have a pending turn, process queue
            if ((state.status === "ready" || state.status === "completed") && currentTurnId) {
              sessionStore.setCurrentTurnId(conversationId, null)
              this.processQueue(conversationId)
            }
          }
        })
      }

      // Step 7: Create ticket and update state
      const ticketId = generateTicketId()
      const turnId = `turn_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

      sessionStore.setStatus(conversationId, "streaming")
      sessionStore.setCurrentTurnId(conversationId, turnId)

      // Step 8: Send message via adapter (fire and forget)
      // The adapter will handle the stream and update UI state
      // We don't await this - the ticket is returned immediately
      // Phase 19: Pass interrupt flag and correlationId to adapter
      const externalMessageId = input.transportOverrides?.externalMessageId
      void adapter
        .sendMessage({
          role: input.role,
          parts: input.parts,
          interrupt: input.interrupt,
          correlationId: input.transportOverrides?.correlationId,
          externalMessageId,
        })
        .then(() => {
          // Only update state if this is still the current turn
          // (stop() may have cleared it or started a new turn)
          if (sessionStore.getCurrentTurnId(conversationId) === turnId) {
            // Stream completed successfully
            sessionStore.setStatus(conversationId, "completed")
            sessionStore.setCurrentTurnId(conversationId, null)
            // Remove interrupt queue item if present (defense-in-depth: message_inserted
            // event should have removed it, but this handles lost events)
            if (interruptQueueItemId) {
              sessionStore.removeQueueItem(conversationId, interruptQueueItemId)
            }
            // Process next queue item
            this.processQueue(conversationId)
          }
        })
        .catch((error) => {
          // Use shared error handler
          this.handleSendError(conversationId, error, turnId)
          // Remove interrupt queue item if present (failed send should not leave stale queue item)
          if (interruptQueueItemId) {
            sessionStore.removeQueueItem(conversationId, interruptQueueItemId)
          }
        })
        .finally(() => {
          // Fix: Always unsubscribe from adapter state changes to prevent memory leaks
          // This ensures cleanup even if sendMessage() hangs or has unexpected behavior
          try {
            unsubscribeFromAdapter?.()
          } catch (error) {
            console.warn("[TurnOrchestrator] Failed to unsubscribe from adapter:", error)
          }
        })

      // Step 9: Return ticket immediately (don't wait for stream to complete)
      return {
        ticketId,
        conversationId,
        queued: false,
      }
    } catch (error) {
      // Fix: Clean up subscription on early error (before sendMessage started)
      // This prevents subscription leaks when exceptions occur between subscribe and sendMessage
      try {
        unsubscribeFromAdapter?.()
      } catch (unsubscribeError) {
        console.warn("[TurnOrchestrator] Failed to unsubscribe:", unsubscribeError)
      }

      // Use shared error handler
      this.handleSendError(conversationId, error)

      throw error
    }
  }

  /**
   * Execute a send operation for a queued item.
   *
   * @param conversationId - Conversation ID
   * @param itemId - Queue item ID
   * @returns Send ticket
   */
  async sendQueuedItem(conversationId: string, itemId: string): Promise<ConversationSendTicket> {
    const sessionStore = getRuntimeSessionStore()
    const session = sessionStore.getSession(conversationId)

    if (!session) {
      throw new Error(`Session not found for conversation: ${conversationId}`)
    }

    const queueItem = session.queue.find((item) => item.id === itemId)
    if (!queueItem) {
      throw new Error(`Queue item not found: ${itemId}`)
    }

    // Fix: Try to send first, only remove from queue if successful
    // This prevents data loss if send() fails
    try {
      const ticket = await this.send(queueItem.originalInput)
      // Only remove from queue after successful send
      sessionStore.removeQueueItem(conversationId, itemId)
      return ticket
    } catch (error) {
      // Update queue item status to failed instead of losing it
      sessionStore.updateQueueItem(conversationId, itemId, (item) => ({
        ...item,
        status: "pending" as const, // Keep in queue for retry
        error: error instanceof Error ? error.message : "Unknown error",
      }))
      throw error
    }
  }

  /**
   * Enqueue a message for later sending.
   *
   * @param input - Send input
   * @param conversation - Resolved conversation
   * @returns Send ticket
   */
  private async enqueue(
    input: ConversationSendMessageInput,
    conversation: ResolvedConversation,
  ): Promise<ConversationSendTicket> {
    const conversationId = conversation.conversationId
    const sessionStore = getRuntimeSessionStore()

    // Ensure session exists
    sessionStore.ensureSession(conversationId)

    // Create queue item
    const queueItemId = generateQueueItemId()
    const queueItem: ConversationQueueItem = {
      id: queueItemId,
      originalInput: input,
      status: "pending",
      queuedAt: new Date(),
    }

    // Add to queue
    sessionStore.addQueueItem(conversationId, queueItem)

    // Create send ticket
    const ticketId = generateTicketId()

    return {
      ticketId,
      conversationId,
      queued: true,
      queueItemId,
    }
  }

  /**
   * Process the queue after a turn completes.
   * Sends the next pending item if any.
   * If send fails, the item remains in queue for retry.
   * If send re-enqueues (e.g., session still streaming), the old item is removed
   * to avoid duplicates (send() creates a new item with a new ID).
   *
   * @param conversationId - Conversation ID
   */
  private async processQueue(conversationId: string): Promise<void> {
    const sessionStore = getRuntimeSessionStore()
    const session = sessionStore.getSession(conversationId)

    if (!session || session.queue.length === 0) {
      return
    }

    // Get the first pending item
    const nextItem = session.queue.find((item) => item.status === "pending")
    if (!nextItem) {
      return
    }

    // Fix: Don't remove from queue before sending.
    // send() can internally call enqueue() which creates a NEW item with a NEW ID.
    // If we remove first, the original item is lost and we can't track it.
    // Instead, send first, then remove based on the result.
    try {
      const ticket = await this.send(nextItem.originalInput)

      // Remove the old item from queue in all success cases:
      // - If ticket.queued === true: send() re-enqueued with a new ID, so remove old item to avoid duplicates
      // - If ticket.queued === false: send succeeded, so we're done with this item
      sessionStore.removeQueueItem(conversationId, nextItem.id)
    } catch (error) {
      console.error("[TurnOrchestrator] Failed to send queued item:", error)

      // Fix: Item is still in queue (we didn't remove it before sending).
      // Update its status to indicate the failure, but keep it in queue for retry.
      sessionStore.updateQueueItem(conversationId, nextItem.id, (item) => ({
        ...item,
        status: "pending" as const,
        error: error instanceof Error ? error.message : "Unknown error",
      }))
    }
  }
}

// ============================================================================
// ORCHESTRATOR INSTANCE - Singleton
// ============================================================================

/**
 * Global orchestrator instance.
 */
let orchestratorInstance: TurnOrchestrator | null = null

/**
 * Get the Turn Orchestrator instance.
 */
export function getTurnOrchestrator(): TurnOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new TurnOrchestratorImpl()
  }
  return orchestratorInstance
}

/**
 * Reset the orchestrator instance (for testing).
 */
export function resetTurnOrchestrator(): void {
  orchestratorInstance = null
}
