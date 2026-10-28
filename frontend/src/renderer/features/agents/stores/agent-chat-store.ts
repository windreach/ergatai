import type { Chat } from "@ai-sdk/react"

/**
 * Simple module-level storage for Chat objects.
 * Lives outside React lifecycle so chats persist across component mount/unmount.
 */

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
    const chat = chats.get(id) as any
    try {
      chat?.transport?.cleanup?.()
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
        ;(chat as any)?.transport?.cleanup?.()
      } catch (e) {
        console.error('[AgentChatStore] Cleanup failed:', e)
      }
    }
    chats.clear()
    parentChatIds.clear()
    manuallyAborted.clear()
  },
}
