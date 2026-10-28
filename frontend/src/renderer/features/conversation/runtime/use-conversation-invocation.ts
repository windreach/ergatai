/**
 * useConversationInvocation Hook
 *
 * React hook for conversation invocation. This hook provides a unified interface
 * for sending messages, stopping streams, and managing queues in React components.
 *
 * Phase 8: React adaptation layer.
 * This hook wraps ConversationInvocationService for use in React components.
 */

import { useCallback, useMemo } from "react"
import { useSyncExternalStore } from "react"

import type {
  ConversationSendMessageInput,
  ConversationStopInput,
  ConversationRuntimeState,
  ConversationSendTicket,
} from "./contracts"

import {
  getConversationInvocationService,
  type ConversationInvocationService,
} from "./conversation-invocation-service"

import { getRuntimeSessionStore } from "./runtime-session-store"

// ============================================================================
// HOOK INTERFACE - Public API
// ============================================================================

/**
 * useConversationInvocation hook return type.
 */
export type UseConversationInvocationReturn = {
  /**
   * Send a message in a conversation.
   */
  send: (input: ConversationSendMessageInput) => Promise<ConversationSendTicket>

  /**
   * Stop message streaming in a conversation.
   */
  stop: (input: ConversationStopInput) => Promise<void>

  /**
   * Enqueue a message for later sending.
   * Returns a ticket with the queue item ID for tracking.
   */
  enqueue: (input: ConversationSendMessageInput) => Promise<ConversationSendTicket>

  /**
   * Remove a queued item.
   */
  removeQueuedItem: (conversationId: string, itemId: string) => Promise<void>

  /**
   * Send a queued item immediately.
   */
  sendQueuedItem: (conversationId: string, itemId: string) => Promise<void>

  /**
   * Get the current runtime state of a conversation.
   */
  getSessionState: (conversationId: string) => ConversationRuntimeState | null

  /**
   * Release a session (cleanup when conversation is closed).
   */
  releaseSession: (conversationId: string) => void
}

// ============================================================================
// MODULE-LEVEL HOOKS
// ============================================================================

/**
 * Subscribe to runtime state changes for a conversation.
 *
 * This is a standalone hook that should be called at the top level of a
 * React component or custom hook. It uses useSyncExternalStore to subscribe
 * to state changes from the RuntimeSessionStore.
 *
 * @param conversationId - The conversation ID to subscribe to
 * @returns The current runtime state, or null if not initialized
 *
 * @example
 * ```tsx
 * function ChatInput({ conversationId }) {
 *   const sessionState = useSessionState(conversationId)
 *
 *   return (
 *     <div>
 *       {sessionState?.isStreaming && <span>Streaming...</span>}
 *     </div>
 *   )
 * }
 * ```
 */
export function useSessionState(conversationId: string): ConversationRuntimeState | null {
  const sessionStore = getRuntimeSessionStore()

  // Subscribe function for useSyncExternalStore
  const subscribe = useCallback(
    (callback: () => void) => {
      return sessionStore.subscribe(conversationId, () => {
        callback()
      })
    },
    [sessionStore, conversationId],
  )

  // Get snapshot function for useSyncExternalStore
  const getSnapshot = useCallback(() => {
    return sessionStore.getRuntimeState(conversationId)
  }, [sessionStore, conversationId])

  // Use useSyncExternalStore for reactive state
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

/**
 * React hook for conversation invocation.
 *
 * This hook provides a unified interface for sending messages and managing
 * conversation state in React components.
 *
 * @returns Conversation invocation API
 *
 * @example
 * ```tsx
 * function ChatInput({ conversationId }) {
 *   const invocation = useConversationInvocation()
 *   const sessionState = useSessionState(conversationId)
 *
 *   const handleSend = async (message: string) => {
 *     await invocation.send({
 *       conversation: {
 *         chatId: "main",
 *         conversationId,
 *         source: "main",
 *       },
 *       role: "user",
 *       parts: [{ type: "text", text: message }],
 *     })
 *   }
 *
 *   return (
 *     <div>
 *       <input onKeyDown={(e) => {
 *         if (e.key === "Enter") {
 *           handleSend(e.currentTarget.value)
 *         }
 *       }} />
 *       {sessionState?.isStreaming && (
 *         <button onClick={() => invocation.stop({ conversationId, chatId: "main" })}>
 *           Stop
 *         </button>
 *       )}
 *     </div>
 *   )
 * }
 * ```
 */
export function useConversationInvocation(): UseConversationInvocationReturn {
  // Get service instance
  const service = useMemo(() => getConversationInvocationService(), [])

  // Wrap service methods with useCallback for stable references
  const send = useCallback(
    (input: ConversationSendMessageInput) => service.send(input),
    [service],
  )

  const stop = useCallback(
    (input: ConversationStopInput) => service.stop(input),
    [service],
  )

  const enqueue = useCallback(
    (input: ConversationSendMessageInput) => service.enqueue(input),
    [service],
  )

  const removeQueuedItem = useCallback(
    (conversationId: string, itemId: string) => service.removeQueuedItem(conversationId, itemId),
    [service],
  )

  const sendQueuedItem = useCallback(
    (conversationId: string, itemId: string) => service.sendQueuedItem(conversationId, itemId),
    [service],
  )

  const getSessionState = useCallback(
    (conversationId: string) => service.getSessionState(conversationId),
    [service],
  )

  const releaseSession = useCallback(
    (conversationId: string) => service.releaseSession(conversationId),
    [service],
  )

  // Return hook API
  return useMemo(
    () => ({
      send,
      stop,
      enqueue,
      removeQueuedItem,
      sendQueuedItem,
      getSessionState,
      releaseSession,
    }),
    [
      send,
      stop,
      enqueue,
      removeQueuedItem,
      sendQueuedItem,
      getSessionState,
      releaseSession,
    ],
  )
}
