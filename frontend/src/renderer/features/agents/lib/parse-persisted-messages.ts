/**
 * Pure helpers for parsing durable conversation snapshots.
 *
 * Kept framework-free so they can be unit-tested without React/tRPC.
 */

export type PersistedConversationLike = {
  id: string
  messages?: unknown
}

/**
 * Parse the `messages` field of each conversation into an array.
 *
 * The backend may store messages either as a JSON array or as a JSON string.
 * This normalizes both shapes into a Map<conversationId, messages[]>.
 *
 * Note: External agent response filtering is now handled by role-based
 * rendering (role="respagent"), not by filtering messageType here.
 */
export function parsePersistedMessagesByConversation(
  conversations: readonly PersistedConversationLike[],
): Map<string, unknown[]> {
  const messagesById = new Map<string, unknown[]>()

  for (const conversation of conversations) {
    const rawMessages = conversation.messages
    let parsedMessages: unknown[] = []

    if (Array.isArray(rawMessages)) {
      parsedMessages = rawMessages
    } else if (typeof rawMessages === "string") {
      try {
        const parsed = JSON.parse(rawMessages)
        parsedMessages = Array.isArray(parsed) ? parsed : []
      } catch {
        parsedMessages = []
      }
    }

    messagesById.set(conversation.id, parsedMessages)
  }

  return messagesById
}