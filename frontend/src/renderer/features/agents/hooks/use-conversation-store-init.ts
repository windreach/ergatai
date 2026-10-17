import { useEffect } from "react"
import { appStore } from "../../../lib/jotai-store"
import { conversationModeAtomFamily } from "../../../lib/atoms"
import { useAgentConversationStore } from "../stores/conversation-store"

interface ConversationMeta {
  id: string
  name: string
  created_at: string
  updated_at?: string
  mode?: "plan" | "agent"
}

interface AgentConversationsItem {
  id: string
  name: string | null
  created_at: string | Date | null
  updated_at: string | Date | null
  mode: "plan" | "agent" | null
}

interface UseConversationStoreInitProps {
  agentChat: any
  chatId: string
}

/**
 * Hook to initialize conversation store from DB data when chat loads
 * Handles race conditions between local and DB state
 */
export function useConversationStoreInit({
  agentChat,
  chatId,
}: UseConversationStoreInitProps) {
  useEffect(() => {
    if (!agentChat) return

    const store = useAgentConversationStore.getState()

    // Only initialize if chatId changed
    if (store.chatId !== chatId) {
      store.setChatId(chatId)
    }

    // Re-get fresh state after setChatId may have loaded from localStorage
    const freshState = useAgentConversationStore.getState()

    // Get conversations from DB (like Canvas - no isPersistedInDb flag)
    // Build a map of existing local conversations to preserve their created_at if DB doesn't have it
    const existingConversationsMap = new Map(
      freshState.allConversations.map((sc) => [sc.id, sc]),
    )

    const agentConversations = (agentChat.conversations ?? []) as AgentConversationsItem[]

    const dbConversations: ConversationMeta[] = agentConversations.map((sc) => {
      const existingLocal = existingConversationsMap.get(sc.id)
      const createdAt =
        typeof sc.created_at === "string"
          ? sc.created_at
          : sc.created_at?.toISOString()
      const updatedAt =
        typeof sc.updated_at === "string"
          ? sc.updated_at
          : sc.updated_at?.toISOString()
      return {
        id: sc.id,
        name: sc.name || "New Chat",
        // Prefer DB timestamp, fall back to local timestamp, then current time
        created_at:
          createdAt ?? existingLocal?.created_at ?? new Date().toISOString(),
        updated_at: updatedAt ?? existingLocal?.updated_at,
        mode:
          (sc.mode as "plan" | "agent" | undefined) ||
          existingLocal?.mode ||
          "agent",
      }
    })
    const dbConversationIds = new Set(dbConversations.map((sc) => sc.id))

    // Start with DB conversations
    const allConversations: ConversationMeta[] = [...dbConversations]

    // For each open tab ID that's NOT in DB, add placeholder (like Canvas)
    // This prevents losing tabs during race conditions
    const currentOpenIds = freshState.openConversationIds
    currentOpenIds.forEach((id) => {
      if (!dbConversationIds.has(id)) {
        allConversations.push({
          id,
          name: "New Chat",
          created_at: new Date().toISOString(),
        })
      }
    })

    freshState.setAllConversations(allConversations)

    // Initialize atomFamily mode for each conversation from database
    // This ensures new chats with mode="plan" use the correct mode
    for (const sc of dbConversations) {
      if (sc.mode) {
        appStore.set(conversationModeAtomFamily(sc.id), sc.mode)
      }
    }

    // All open tabs are now valid (we created placeholders for non-DB ones)
    const validOpenIds = currentOpenIds

    if (validOpenIds.length === 0 && allConversations.length > 0) {
      // No valid open tabs, open the first conversation
      freshState.addToOpenConversations(allConversations[0].id)
      freshState.setActiveConversation(allConversations[0].id)
    } else if (validOpenIds.length > 0) {
      // Validate active tab is in open tabs
      const currentActive = freshState.activeConversationId
      if (!currentActive || !validOpenIds.includes(currentActive)) {
        freshState.setActiveConversation(validOpenIds[0])
      }
    }
  }, [agentChat, chatId])
}
