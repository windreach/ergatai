/**
 * Text part store for external store subscriptions.
 * Separated from isolated-text-part.tsx to maintain Fast Refresh compatibility.
 */

// Cache for text content per part
export const textPartStore = new Map<string, string>()

// Subscribers per part key
export const textPartSubscribers = new Map<string, Set<() => void>>()

/**
 * Clear cached text parts for specific message IDs.
 * Used when messages are deleted or updated.
 */
export function clearTextPartStoreByMessageIds(conversationId: string, messageIds: string[]) {
  if (messageIds.length === 0) return
  const conversationPrefix = `${conversationId}:`
  const messageIdSet = new Set(messageIds)

  for (const key of Array.from(textPartStore.keys())) {
    if (!key.startsWith(conversationPrefix)) continue
    const suffix = key.slice(conversationPrefix.length)
    const separatorIndex = suffix.lastIndexOf(":")
    if (separatorIndex === -1) continue
    const messageId = suffix.slice(0, separatorIndex)
    if (messageIdSet.has(messageId)) {
      textPartStore.delete(key)
    }
  }

  for (const key of Array.from(textPartSubscribers.keys())) {
    if (!key.startsWith(conversationPrefix)) continue
    const suffix = key.slice(conversationPrefix.length)
    const separatorIndex = suffix.lastIndexOf(":")
    if (separatorIndex === -1) continue
    const messageId = suffix.slice(0, separatorIndex)
    if (messageIdSet.has(messageId)) {
      textPartSubscribers.delete(key)
    }
  }
}
