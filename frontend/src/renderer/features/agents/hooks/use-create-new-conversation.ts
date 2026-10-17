import { useCallback } from "react"

interface UseCreateNewConversationOptions {
  worktreePath: string | null
  chatId: string | null
  defaultAgentMode: "plan" | "agent"
  activeConversationId: string | null
  inferProviderFromMessages: (conversationId?: string) => "claude-code" | "codex"
  utils: any
  setConversationUnseenChanges: (updater: (prev: Set<string>) => Set<string>) => void
  selectedChatId: string | null
  setUnseenChanges: (updater: (prev: Set<string>) => Set<string>) => void
  notifyAgentComplete: (name: string) => void
  syncFinishedMessagesToChatCache: (conversationId: string, chat: any) => void
  pruneIfDetachedAndIdle: (conversationId: string, parentChatId: string) => void
  agentChat?: { name?: string }
  isGroupMode: boolean
  setJustCreatedIds: (updater: (prev: Set<string>) => Set<string>) => void
  setConversationProviderOverrides: React.Dispatch<React.SetStateAction<Record<string, "claude-code" | "codex">>>
  agentChatStore: any
  forceUpdate: (value: any) => void
  setLoadingConversations: any
  fetchDiffStatsRef: React.RefObject<() => void>
}

export function useCreateNewConversation({
  worktreePath,
  chatId,
  defaultAgentMode,
  activeConversationId,
  inferProviderFromMessages,
  utils,
  setConversationUnseenChanges,
  selectedChatId,
  setUnseenChanges,
  notifyAgentComplete,
  syncFinishedMessagesToChatCache,
  pruneIfDetachedAndIdle,
  agentChat,
  isGroupMode,
  setJustCreatedIds,
  setConversationProviderOverrides,
  agentChatStore,
  forceUpdate,
  setLoadingConversations,
  fetchDiffStatsRef,
}: UseCreateNewConversationOptions) {
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
