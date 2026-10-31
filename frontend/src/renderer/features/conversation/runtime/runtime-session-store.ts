/**
 * Runtime Session Store
 *
 * Manages runtime state for each conversation session. This store is responsible
 * for:
 * - Ingesting persisted, runtime, and local message sources
 * - Delegating render-model projection to ConversationProjectionService
 * - Maintaining visible messages (deduplicated)
 * - Tracking streaming status
 * - Handling runtime turn completion and reconciliation
 *
 * Phase 3: Initial implementation.
 * Phase 15: Fixed snapshot stability and message sorting.
 * - Cached public state to ensure stable snapshots for useSyncExternalStore
 * - Use sequence-based sorting instead of createdAt
 * - Store transport handle for proper stop() implementation
 *
 * Phase 19: Added localStorage persistence for runtime sequence numbers.
 * - Enables stream resumption after UI reload by persisting lastRuntimeSequence
 * - On ensureSession(), restores sequence from localStorage
 * - On setLastRuntimeSequence() and incrementLocalSequence(), persists to localStorage
 * - On releaseSession(), cleans up localStorage
 * - Uses safe try-catch wrappers to handle localStorage errors gracefully
 */

import type {
  ConversationRuntimeState,
  ConversationStatus,
  ConversationQueueItem,
  ConversationRuntimeError,
} from "./contracts"

import type { Message } from "../../agents/stores/message-store"

import {
  readPersistedSequence,
  persistSequence,
  removePersistedSequence,
} from "./runtime-sequence-persistence"
import { getConversationProjectionService } from "./conversation-projection-service"

// ============================================================================
// SESSION STATE - Internal state structure
// ============================================================================

/**
 * Internal session state structure.
 */
export type RuntimeSessionState = {
  /** Conversation ID */
  conversationId: string

  /** Runtime status */
  status: ConversationStatus

  /** Persisted messages (from backend/database) */
  persistedMessages: Message[]

  /** Runtime messages (from streaming/session) */
  runtimeMessages: Message[]

  /** Messages owned by the local AI SDK Chat transport. */
  localMessages: Message[]

  /** Stable sequence assigned to each ingested message ID. */
  sequenceByMessageId: Map<string, number>

  /** Visible messages (merged persisted + runtime, deduplicated) */
  visibleMessages: Message[]

  /** Streaming message ID (if streaming) */
  streamingMessageId: string | null

  /** Last runtime sequence number (for sync) */
  lastRuntimeSequence: number

  /** Local sequence counter for stable message ordering */
  localSequence: number

  /** Queued messages */
  queue: ConversationQueueItem[]

  /** Current error (if any) */
  error: ConversationRuntimeError | null

  /** Creation timestamp */
  createdAt: Date

  /** Last update timestamp */
  updatedAt: Date

  /** Cached public state (for stable snapshots) */
  cachedPublicState: ConversationRuntimeState | null

  /** Current turn ID (for preventing stale callbacks from updating state) */
  currentTurnId: string | null

  /** ACP context window usage snapshot (from SSE UsageUpdate events) */
  contextUsed: number
  contextWindow: number
}

// ============================================================================
// SESSION STORE - State management
// ============================================================================

/**
 * Runtime Session Store.
 * Manages runtime state for all active conversation sessions.
 */
class RuntimeSessionStoreImpl {
  // Session state cache
  private sessions = new Map<string, RuntimeSessionState>()

  // State change listeners
  private listeners = new Map<string, Set<(state: ConversationRuntimeState) => void>>()

  // Re-entrancy guard for notifyListeners
  private notifying = new Set<string>()

  /**
   * Source snapshots can be recreated on every render. This check makes the
   * external-store contract stable: no semantic change means no new snapshot
   * and no notification.
   */
  private messageSignature(message: Message): string {
    return JSON.stringify([
      message.id,
      message.role,
      message.parts ?? null,
      message.metadata ?? null,
      message.createdAt?.getTime() ?? null,
    ])
  }

  private messagesChanged(previous: Message[], next: Message[]): boolean {
    if (previous === next) return false
    if (previous.length !== next.length) return true

    return next.some((message, index) => {
      const oldMessage = previous[index]
      if (!oldMessage) return true
      if (oldMessage === message) return false
      return this.messageSignature(oldMessage) !== this.messageSignature(message)
    })
  }

  /**
   * Ensure a session exists for the given conversation ID.
   * Creates a new session if it doesn't exist.
   *
   * @param conversationId - Conversation ID
   * @returns Session state
   */
  ensureSession(conversationId: string): RuntimeSessionState {
    let session = this.sessions.get(conversationId)
    if (!session) {
      session = this.createSession(conversationId)
      // Restore lastRuntimeSequence from localStorage to enable stream resumption after UI reload
      const persistedSequence = readPersistedSequence(conversationId)
      if (persistedSequence !== null) {
        session.lastRuntimeSequence = persistedSequence
        session.localSequence = persistedSequence
      }
      this.sessions.set(conversationId, session)
    }
    return session
  }

  /**
   * Get a session by conversation ID.
   *
   * @param conversationId - Conversation ID
   * @returns Session state or null if not found
   */
  getSession(conversationId: string): RuntimeSessionState | null {
    return this.sessions.get(conversationId) ?? null
  }

  /**
   * Get the public runtime state for a conversation.
   * Returns cached state for stable snapshots (useSyncExternalStore compatibility).
   *
   * @param conversationId - Conversation ID
   * @returns Runtime state or null if not found
   */
  getRuntimeState(conversationId: string): ConversationRuntimeState | null {
    const session = this.getSession(conversationId)
    if (!session) return null

    // Return cached state if available (stable snapshot)
    if (session.cachedPublicState) {
      return session.cachedPublicState
    }

    // Build and cache new state
    const state = this.toRuntimeState(session)
    session.cachedPublicState = state
    return state
  }

  /**
   * Set the current turn ID.
   * Used to prevent stale callbacks from updating state after stop().
   *
   * @param conversationId - Conversation ID
   * @param turnId - Turn ID or null to clear
   */
  setCurrentTurnId(conversationId: string, turnId: string | null): void {
    const session = this.ensureSession(conversationId)
    session.currentTurnId = turnId
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Get the current turn ID.
   *
   * @param conversationId - Conversation ID
   * @returns Turn ID or null
   */
  getCurrentTurnId(conversationId: string): string | null {
    const session = this.getSession(conversationId)
    return session?.currentTurnId ?? null
  }

  /**
   * Increment and return the local sequence number.
   * Used for stable message ordering when createdAt is not available.
   *
   * @param conversationId - Conversation ID
   * @returns New sequence number
   */
  incrementLocalSequence(conversationId: string): number {
    const session = this.ensureSession(conversationId)
    session.localSequence += 1
    session.cachedPublicState = null // Invalidate cache

    // Persist sequence to localStorage for stream resumption after UI reload
    persistSequence(conversationId, session.localSequence)

    return session.localSequence
  }

  /**
   * Update session status.
   *
   * @param conversationId - Conversation ID
   * @param status - New status
   */
  setStatus(conversationId: string, status: ConversationStatus): void {
    const session = this.ensureSession(conversationId)
    session.status = status
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Update persisted messages.
   *
   * @param conversationId - Conversation ID
   * @param messages - Persisted messages
   */
  setPersistedMessages(conversationId: string, messages: Message[]): void {
    const session = this.ensureSession(conversationId)
    if (!this.messagesChanged(session.persistedMessages, messages)) return

    session.persistedMessages = this.normalizeMessages(session, messages)
    session.visibleMessages = this.mergeMessages(session)
    session.cachedPublicState = null
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Ingest raw messages from the local AI SDK Chat transport. This is a source
   * write, not a write-back of the store's merged view.
   */
  setLocalMessages(conversationId: string, messages: Message[]): void {
    const session = this.ensureSession(conversationId)
    if (!this.messagesChanged(session.localMessages, messages)) return

    session.localMessages = this.normalizeMessages(session, messages)
    session.visibleMessages = this.mergeMessages(session)
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Update runtime messages.
   *
   * @param conversationId - Conversation ID
   * @param messages - Runtime messages
   */
  setRuntimeMessages(conversationId: string, messages: Message[]): void {
    const session = this.ensureSession(conversationId)
    if (!this.messagesChanged(session.runtimeMessages, messages)) return

    session.runtimeMessages = this.normalizeMessages(session, messages)
    session.visibleMessages = this.mergeMessages(session)
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Add a runtime message.
   *
   * @param conversationId - Conversation ID
   * @param message - Runtime message
   */
  addRuntimeMessage(conversationId: string, message: Message): void {
    const session = this.ensureSession(conversationId)
    // Assign sequence number for stable ordering
    // Note: incrementLocalSequence already invalidates cachedPublicState
    const sequence = this.incrementLocalSequence(conversationId)
    const runtimeMessage = { ...message, sequence }
    session.runtimeMessages.push(runtimeMessage)
    session.sequenceByMessageId.set(message.id, sequence)
    session.visibleMessages = this.mergeMessages(session)
    // Cache invalidation already handled by incrementLocalSequence() above
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Update a runtime message.
   *
   * @param conversationId - Conversation ID
   * @param messageId - Message ID
   * @param updater - Update function
   */
  updateRuntimeMessage(
    conversationId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ): void {
    const session = this.ensureSession(conversationId)
    const index = session.runtimeMessages.findIndex((m) => m.id === messageId)
    if (index !== -1) {
      session.runtimeMessages[index] = updater(session.runtimeMessages[index]!)
      session.visibleMessages = this.mergeMessages(session)
      session.cachedPublicState = null // Invalidate cache
      session.updatedAt = new Date()

      this.notifyListeners(conversationId)
    }
  }

  /**
   * Set streaming message ID.
   *
   * @param conversationId - Conversation ID
   * @param messageId - Streaming message ID or null
   */
  setStreamingMessageId(conversationId: string, messageId: string | null): void {
    const session = this.ensureSession(conversationId)
    session.streamingMessageId = messageId
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Update runtime sequence number.
   *
   * @param conversationId - Conversation ID
   * @param sequence - Sequence number
   */
  setLastRuntimeSequence(conversationId: string, sequence: number): void {
    const session = this.ensureSession(conversationId)
    session.lastRuntimeSequence = sequence
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    // Persist sequence to localStorage for stream resumption after UI reload
    persistSequence(conversationId, sequence)

    this.notifyListeners(conversationId)
  }

  /**
   * Add a queue item.
   *
   * @param conversationId - Conversation ID
   * @param item - Queue item
   */
  addQueueItem(conversationId: string, item: ConversationQueueItem): void {
    const session = this.ensureSession(conversationId)
    session.queue.push(item)
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Remove a queue item.
   *
   * @param conversationId - Conversation ID
   * @param itemId - Queue item ID
   */
  removeQueueItem(conversationId: string, itemId: string): void {
    const session = this.ensureSession(conversationId)
    session.queue = session.queue.filter((item) => item.id !== itemId)
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Update ACP context window usage snapshot.
   * Called when SSE emits a context_usage event.
   *
   * @param conversationId - Conversation ID
   * @param used - Tokens currently used in context
   * @param size - Total context window size
   */
  updateContextUsage(conversationId: string, used: number, size: number): void {
    const session = this.ensureSession(conversationId)
    // Only update if values changed (prevent unnecessary re-renders)
    if (session.contextUsed === used && session.contextWindow === size) {
      return
    }
    session.contextUsed = used
    session.contextWindow = size
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Update a queue item.
   *
   * @param conversationId - Conversation ID
   * @param itemId - Queue item ID
   * @param updater - Update function
   */
  updateQueueItem(
    conversationId: string,
    itemId: string,
    updater: (item: ConversationQueueItem) => ConversationQueueItem,
  ): void {
    const session = this.ensureSession(conversationId)
    const index = session.queue.findIndex((item) => item.id === itemId)
    if (index !== -1) {
      session.queue[index] = updater(session.queue[index]!)
      session.cachedPublicState = null // Invalidate cache
      session.updatedAt = new Date()

      this.notifyListeners(conversationId)
    }
  }

  /**
   * Set error.
   *
   * @param conversationId - Conversation ID
   * @param error - Error or null to clear
   */
  setError(conversationId: string, error: ConversationRuntimeError | null): void {
    const session = this.ensureSession(conversationId)
    session.error = error
    session.cachedPublicState = null // Invalidate cache
    session.updatedAt = new Date()

    this.notifyListeners(conversationId)
  }

  /**
   * Release a session (cleanup).
   *
   * @param conversationId - Conversation ID
   */
  releaseSession(conversationId: string): void {
    this.sessions.delete(conversationId)
    this.listeners.delete(conversationId)
    // Clean up persisted sequence from localStorage
    removePersistedSequence(conversationId)
  }

  /**
   * Subscribe to session state changes.
   *
   * @param conversationId - Conversation ID
   * @param listener - State change listener
   * @returns Unsubscribe function
   */
  subscribe(
    conversationId: string,
    listener: (state: ConversationRuntimeState) => void,
  ): () => void {
    let listeners = this.listeners.get(conversationId)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(conversationId, listeners)
    }

    listeners.add(listener)

    return () => {
      const listeners = this.listeners.get(conversationId)
      if (listeners) {
        listeners.delete(listener)
        if (listeners.size === 0) {
          this.listeners.delete(conversationId)
        }
      }
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Create a new session.
   *
   * @param conversationId - Conversation ID
   * @returns Session state
   */
  private createSession(conversationId: string): RuntimeSessionState {
    const now = new Date()
    return {
      conversationId,
      status: "idle",
      persistedMessages: [],
      runtimeMessages: [],
      localMessages: [],
      sequenceByMessageId: new Map(),
      visibleMessages: [],
      streamingMessageId: null,
      lastRuntimeSequence: 0,
      localSequence: 0,
      queue: [],
      error: null,
      createdAt: now,
      updatedAt: now,
      cachedPublicState: null,
      currentTurnId: null,
      contextUsed: 0,
      contextWindow: 0,
    }
  }

  /**
   * Delegate projection to the shared service. The store owns session state and
   * source lifecycle; the projection service owns the render model rules.
   */
  private mergeMessages(session: RuntimeSessionState): Message[] {
    return getConversationProjectionService().project({
      persistedMessages: session.persistedMessages,
      runtimeMessages: session.runtimeMessages,
      localMessages: session.localMessages,
    }).visibleMessages
  }

  /**
   * Assign a stable sequence to messages that did not arrive from durable
   * history. Existing IDs retain their sequence as streaming snapshots replace
   * one another.
   */
  private normalizeMessages(
    session: RuntimeSessionState,
    messages: Message[],
  ): Message[] {
    return messages.map((message) => {
      if (typeof message.sequence === "number") {
        session.sequenceByMessageId.set(message.id, message.sequence)
        if (session.localSequence < message.sequence) {
          session.localSequence = message.sequence
        }
        return message
      }

      const existingSequence = session.sequenceByMessageId.get(message.id)
      if (existingSequence !== undefined) {
        return { ...message, sequence: existingSequence }
      }

      session.localSequence += 1
      const sequence = session.localSequence
      session.sequenceByMessageId.set(message.id, sequence)
      return { ...message, sequence }
    })
  }

  /**
   * Convert internal session state to public runtime state.
   *
   * @param session - Internal session state
   * @returns Public runtime state
   */
  private toRuntimeState(session: RuntimeSessionState): ConversationRuntimeState {
    return {
      conversationId: session.conversationId,
      status: session.status,
      persistedMessages: session.persistedMessages,
      runtimeMessages: session.runtimeMessages,
      localMessages: session.localMessages,
      visibleMessages: session.visibleMessages,
      isStreaming: session.status === "streaming",
      queue: session.queue,
      error: session.error ?? undefined,
      streamingMessageId: session.streamingMessageId,
      lastRuntimeSequence: session.lastRuntimeSequence,
      contextUsed: session.contextUsed || undefined,
      contextWindow: session.contextWindow || undefined,
    }
  }

  /**
   * Notify listeners of state changes.
   * Uses a re-entrancy guard to prevent recursive notifications when a listener
   * triggers state changes.
   *
   * @param conversationId - Conversation ID
   */
  private notifyListeners(conversationId: string): void {
    // Prevent re-entrant notifications
    if (this.notifying.has(conversationId)) return
    this.notifying.add(conversationId)

    try {
      const listeners = this.listeners.get(conversationId)
      if (!listeners) return

      const state = this.getRuntimeState(conversationId)
      if (!state) return

      for (const listener of listeners) {
        try {
          listener(state)
        } catch (error) {
          console.error("Error in session state listener:", error)
        }
      }
    } finally {
      this.notifying.delete(conversationId)
    }
  }
}

// ============================================================================
// STORE INSTANCE - Singleton
// ============================================================================

/**
 * Global store instance.
 */
let storeInstance: RuntimeSessionStoreImpl | null = null

/**
 * Get the Runtime Session Store instance.
 */
export function getRuntimeSessionStore(): RuntimeSessionStoreImpl {
  if (!storeInstance) {
    storeInstance = new RuntimeSessionStoreImpl()
  }
  return storeInstance
}

/**
 * Reset the store instance (for testing).
 */
export function resetRuntimeSessionStore(): void {
  storeInstance = null
}

/**
 * Runtime Session Store type.
 */
export type RuntimeSessionStore = RuntimeSessionStoreImpl
