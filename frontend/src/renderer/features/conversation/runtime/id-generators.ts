/**
 * ID Generators
 *
 * Shared utility functions for generating unique IDs across the conversation runtime.
 * These helpers eliminate duplication and ensure consistent ID format.
 *
 * Pattern: `{prefix}_{timestamp}_{randomString}`
 * - prefix: Identifies the ID type (ticket, queue)
 * - timestamp: Date.now() for rough ordering
 * - randomString: 9-character random suffix for uniqueness
 */

/**
 * Generate a unique ticket ID.
 * Used to identify send tickets for tracking conversation turns.
 */
export function generateTicketId(): string {
  return `ticket_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Generate a unique queue item ID.
 * Used to identify items in the conversation queue.
 */
export function generateQueueItemId(): string {
  return `queue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}
