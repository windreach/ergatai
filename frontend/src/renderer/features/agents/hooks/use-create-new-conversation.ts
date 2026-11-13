import { useCallback } from "react"
import type { Chat, UIMessage } from "@ai-sdk/react"
import type { agentChatStore } from "../stores/agent-chat-store"

interface UseCreateNewConversationOptions {
  worktreePath: string | null
  chatId: string | null
  defaultAgentMode: "plan" | "agent"
  activeConversationId: string | null
  inferProviderFromMessages: (conversationId?: string) => "claude-code" | "codex" | "opencode"
  setConversationUnseenChanges: (updater: (prev: Set<string>) => Set<string>) => void
  selectedChatId: string | null
  setUnseenChanges: (updater: (prev: Set<string>) => Set<string>) => void
  notifyAgentComplete: (name: string) => void
  syncFinishedMessagesToChatCache: (conversationId: string, chat: Chat<UIMessage>) => void
  pruneIfDetachedAndIdle: (conversationId: string, parentChatId: string) => void
  agentChat?: { name?: string }
  isGroupMode: boolean
  setJustCreatedIds: (updater: (prev: Set<string>) => Set<string>) => void
  setConversationProviderOverrides: React.Dispatch<React.SetStateAction<Record<string, "claude-code" | "codex">>>
  agentChatStore: typeof agentChatStore
  forceUpdate: (value: string) => void
  setLoadingConversations: React.Dispatch<React.SetStateAction<Map<string, string>>>
  fetchDiffStatsRef: React.RefObject<() => void>
}

export function useCreateNewConversation(_options: UseCreateNewConversationOptions) {
  const handleCreateNewConversation = useCallback(async () => {
    // Backend no longer supports creating child conversations
    // This feature has been removed
    console.warn("[use-create-new-conversation] createChildConversation is no longer supported")
    throw new Error("Creating new child conversations is no longer supported")
  }, [])

  return {
    handleCreateNewConversation,
  }
}
