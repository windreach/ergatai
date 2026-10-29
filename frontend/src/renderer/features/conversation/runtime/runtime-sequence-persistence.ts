/**
 * Runtime Sequence Persistence
 *
 * Shared utility for persisting runtime sequence numbers to localStorage.
 * Enables stream resumption after UI reload.
 *
 * Phase 19: Extracted from runtime-session-store.ts and conversation-runtime-gateway.ts
 * to eliminate code duplication.
 */

// ============================================================================
// CONSTANTS - Storage keys for persistence
// ============================================================================

/**
 * localStorage key prefix for persisting runtime sequence numbers.
 * Enables stream resumption after UI reload.
 */
const RUNTIME_SEQUENCE_STORAGE_PREFIX = "ergatai:runtime:sequence:"

/**
 * Get localStorage key for a conversation's runtime sequence.
 */
function getSequenceStorageKey(conversationId: string): string {
  return `${RUNTIME_SEQUENCE_STORAGE_PREFIX}${conversationId}`
}

// ============================================================================
// PERSISTENCE FUNCTIONS
// ============================================================================

/**
 * Safely read runtime sequence from localStorage.
 * Returns null if not found or on error.
 */
export function readPersistedSequence(conversationId: string): number | null {
  try {
    // Null guard for conversationId
    if (!conversationId || typeof conversationId !== "string") {
      console.warn("[RuntimeSequencePersistence] Invalid conversationId")
      return null
    }

    const key = getSequenceStorageKey(conversationId)
    const value = localStorage.getItem(key)
    if (value === null || value.trim() === "") return null

    // Use Number() to validate numeric input; sequence numbers must be
    // non-negative integers.
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
  } catch (error) {
    console.warn("[RuntimeSequencePersistence] Failed to read persisted sequence:", error)
    return null
  }
}

/**
 * Safely write runtime sequence to localStorage.
 */
export function persistSequence(conversationId: string, sequence: number): void {
  try {
    // Null guard for conversationId
    if (!conversationId || typeof conversationId !== "string") {
      console.warn("[RuntimeSequencePersistence] Invalid conversationId")
      return
    }

    // Integer validation for sequence
    if (!Number.isInteger(sequence) || sequence < 0) {
      console.warn("[RuntimeSequencePersistence] Invalid sequence number:", sequence)
      return
    }

    const key = getSequenceStorageKey(conversationId)
    localStorage.setItem(key, String(sequence))
  } catch (error) {
    console.warn("[RuntimeSequencePersistence] Failed to persist sequence:", error)
  }
}

/**
 * Safely remove runtime sequence from localStorage.
 */
export function removePersistedSequence(conversationId: string): void {
  try {
    const key = getSequenceStorageKey(conversationId)
    localStorage.removeItem(key)
  } catch (error) {
    console.warn("[RuntimeSequencePersistence] Failed to remove persisted sequence:", error)
  }
}
