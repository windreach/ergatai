import type { Chat } from "@ai-sdk/react"

/**
 * Simple module-level storage for Chat objects.
 * Lives outside React lifecycle so chats persist across component mount/unmount.
 */

// `Chat<any>` is required because @ai-sdk/react's Chat class has a generic constraint
// `UI_MESSAGE extends UIMessage`, where UIMessage.role is strictly 'system' | 'user' | 'assistant'.
// Ergatai extends this with an 'agent' role for agent-initiated messages, and uses a different
// MessagePart structure. We cannot satisfy the UIMessage constraint without forking the Chat class.
// The Chat class is a runtime container that doesn't validate message types, so `any` is safe here.
const chats = new Map<string, Chat<any>>()
const parentChatIds = new Map<string, string>() // conversationId → parentChatId (stored at creation time)
const manuallyAborted = new Map<string, boolean>() // Track if chat was manually stopped

export const agentChatStore = {
  get: (id: string) => chats.get(id),

  keys: () => Array.from(chats.keys()),

  set: (id: string, chat: Chat<any>, parentChatId: string) => {
    chats.set(id, chat)
    parentChatIds.set(id, parentChatId)
  },

  has: (id: string) => chats.has(id),

  delete: (id: string) => {
    const chat = chats.get(id)
    try {
      // `transport` is a private field on Chat, but we need to call cleanup on deletion
      ;(chat as unknown as { transport?: { cleanup?: () => void } })?.transport?.cleanup?.()
    } finally {
      chats.delete(id)
      parentChatIds.delete(id)
      manuallyAborted.delete(id)
    }
  },

  // Get the ORIGINAL parentChatId that was set when the Chat was created
  getParentChatId: (conversationId: string) => parentChatIds.get(conversationId),

  // Track manual abort to prevent completion sound
  setManuallyAborted: (id: string, aborted: boolean) => {
    manuallyAborted.set(id, aborted)
  },
  wasManuallyAborted: (id: string) => manuallyAborted.get(id) ?? false,
  clearManuallyAborted: (id: string) => {
    manuallyAborted.delete(id)
  },

  clear: () => {
    for (const chat of chats.values()) {
      try {
        // `transport` is a private field on Chat, but we need to call cleanup on clear
        ;(chat as unknown as { transport?: { cleanup?: () => void } })?.transport?.cleanup?.()
      } catch (e) {
        console.error('[AgentChatStore] Cleanup failed:', e)
      }
    }
    chats.clear()
    parentChatIds.clear()
    manuallyAborted.clear()
  },
}
