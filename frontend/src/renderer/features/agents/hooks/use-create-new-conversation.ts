import { useCallback } from "react"
import type { TRPCUtils } from "@trpc/react-query"
import type { Chat } from "@ai-sdk/react"
import type { AgentChatStore } from "../stores/agent-chat-store"

interface UseCreateNewConversationOptions {
  worktreePath: string | null
  chatId: string | null
  defaultAgentMode: "plan" | "agent"
  activeConversationId: string | null
  inferProviderFromMessages: (conversationId?: string) => "claude-code" | "codex"
  utils: TRPCUtils
  setConversationUnseenChanges: (updater: (prev: Set<string>) => Set<string>) => void
  selectedChatId: string | null
  setUnseenChanges: (updater: (prev: Set<string>) => Set<string>) => void
  notifyAgentComplete: (name: string) => void
  syncFinishedMessagesToChatCache: (conversationId: string, chat: Chat<any>) => void
  pruneIfDetachedAndIdle: (conversationId: string, parentChatId: string) => void
  agentChat?: { name?: string }
  isGroupMode: boolean
  setJustCreatedIds: (updater: (prev: Set<string>) => Set<string>) => void
  setConversationProviderOverrides: React.Dispatch<React.SetStateAction<Record<string, "claude-code" | "codex">>>
  agentChatStore: AgentChatStore
  forceUpdate: (value: string) => void
  setLoadingConversations: React.Dispatch<React.SetStateAction<Map<string, string>>>
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
