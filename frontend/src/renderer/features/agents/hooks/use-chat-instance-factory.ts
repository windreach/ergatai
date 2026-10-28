import { useCallback, useRef } from "react"
import { toast } from "sonner"
import { appStore } from "../../../lib/jotai-store"
import { selectedAgentChatIdAtom, soundNotificationsEnabledAtom } from "../../../lib/atoms"
import { trpcClient } from "../../../lib/trpc"
import { Chat } from "@ai-sdk/react"
import { ErgataiChatTransport } from "../lib/ergatai-chat-transport"
import { GroupChatTransport } from "../lib/group-chat-transport"
import { MockChatTransport, isMockChatEnabled } from "../lib/mock-chat-transport"
import { agentChatStore } from "../stores/agent-chat-store"
import { useAgentConversationStore } from "../stores/conversation-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { useMessageQueueStore } from "../stores/message-queue-store"
import { clearConversationRuntimeCaches } from "../stores/conversation-runtime-cleanup"
import { loadGroupAgents } from "../collaboration/group-agent-storage"
import { conversationAgentStorage } from "../lib/conversation-agent-storage"

interface UseChatInstanceFactoryProps {
  // 聊天实例信息
  // `any` used here because agentChat shape varies across call sites and is not centrally typed
  chat: {
    agentChat: any
    chatWorkingDir: string | null
    worktreePath: string | null
    chatId: string
    currentMode: "plan" | "agent"
  }

  // Provider 配置
  provider: {
    inferProviderFromMessages: (conversationId?: string) => "claude-code" | "codex"
    conversationProviderOverrides: Record<string, "claude-code" | "codex">
  }

  // 状态管理
  state: {
    setConversationUnseenChanges: React.Dispatch<React.SetStateAction<Set<string>>>
    setUnseenChanges: React.Dispatch<React.SetStateAction<Set<string>>>
    setLoadingConversations: (fn: (prev: Map<string, string>) => Map<string, string>) => void
    selectedChatId: string | null
    agentConversations: any[]
    isGroupMode: boolean
  }

  // 工具函数
  // `utils` and `trpcUtils` are typed as `any` because they are injected trpc helper
  // objects whose concrete type is generated per-router and not easy to thread here.
  utils: {
    utils: any
    trpcUtils: any
    fetchDiffStatsRef: React.MutableRefObject<() => void>
    forceUpdate: (val: {}) => void
  }
}

/**
 * Hook to create Chat instances with proper transport selection and lifecycle callbacks
 * Also includes helper functions for syncing messages and pruning detached chats
 */
export function useChatInstanceFactory({
  chat,
  provider,
  state,
  utils,
}: UseChatInstanceFactoryProps) {
  // Refs to avoid stale closures in callbacks that persist (e.g. Chat constructor's onError/onFinish)
  const chatRef = useRef(chat)
  const providerRef = useRef(provider)
  const stateRef = useRef(state)
  const utilsRef = useRef(utils)

  // Sync refs on every render (not in useEffect) so callbacks always have latest values
  chatRef.current = chat
  providerRef.current = provider
  stateRef.current = state
  utilsRef.current = utils

  // Sync finished messages to cache and backend
  const syncFinishedMessagesToChatCache = useCallback(
    (conversationId: string, chatInstance: Chat<any>) => {
      const latestMessages = (chatInstance as any)?.messages
      if (!Array.isArray(latestMessages)) return
      if (latestMessages.length === 0) return

      // Backend no longer supports replacing messages
      if ((chatInstance as any)?.transport instanceof ErgataiChatTransport) {
        console.debug("[AgentChat] Backend owns message persistence; skipping client-side replace")
      }

      const latestMessagesJson = JSON.stringify(latestMessages)

      utilsRef.current.utils.agents.getAgentChat.setData({ chatId: chatRef.current.chatId }, (old: any) => {
        if (!old?.conversations || !Array.isArray(old.conversations)) return old

        let found = false
        const conversations = old.conversations.map((sc: any) => {
          if (sc.id !== conversationId) return sc
          found = true
          return { ...sc, messages: latestMessagesJson }
        })

        return found ? { ...old, conversations } : old
      })
    },
    [],
  )

  // Prune chat if user has switched to another workspace
  const pruneIfDetachedAndIdle = useCallback((conversationId: string, parentChatId: string) => {
    const currentSelectedChatId = appStore.get(selectedAgentChatIdAtom)
    if (!currentSelectedChatId || currentSelectedChatId === parentChatId) return
    if (useStreamingStatusStore.getState().isStreaming(conversationId)) return
    if ((useMessageQueueStore.getState().queues[conversationId]?.length ?? 0) > 0) return

    agentChatStore.delete(conversationId)
    clearConversationRuntimeCaches(conversationId)
  }, [])

  // Clear loading state helper
  const clearLoading = (setter: (fn: (prev: Map<string, string>) => Map<string, string>) => void, conversationId: string) => {
    setter((prev) => {
      if (!prev.has(conversationId)) return prev
      const next = new Map(prev)
      next.delete(conversationId)
      return next
    })
  }

  // Common teardown logic shared by onError and onFinish callbacks
  const finalizeConversation = useCallback(
    (conversationId: string, chatInstance: Chat<any>) => {
      useStreamingStatusStore.getState().setStatus(conversationId, "ready")
      syncFinishedMessagesToChatCache(conversationId, chatInstance)
      pruneIfDetachedAndIdle(conversationId, chatRef.current.chatId)
    },
    [syncFinishedMessagesToChatCache, pruneIfDetachedAndIdle],
  )

  // Factory function to create or retrieve Chat instances
  const getOrCreateChat = useCallback(
    (conversationId: string): Chat<any> | null => {
      // Desktop uses chat.worktreePath, web uses sandboxUrl
      if (!chatRef.current.chatWorkingDir || !chatRef.current.agentChat) {
        return null
      }

      // Create transport based on chat type (local worktree vs remote sandbox)
      // Note: Extended thinking setting is read dynamically inside the transport
      // projectPath: original project path for MCP config lookup (chat.worktreePath is the cwd)
      const projectPath = (chatRef.current.agentChat as any)?.project?.path as string | undefined
      // Fast path for existing chats. Only inspect messages when a local empty-chat provider override
      // might require transport recreation.
      const existing = agentChatStore.get(conversationId)
      if (existing) {
        const existingTransport = (existing as any)?.transport
        const existingIsMock = existingTransport instanceof MockChatTransport
        if (existingIsMock !== isMockChatEnabled()) {
          agentChatStore.delete(conversationId)
        } else {
          return existing
        }
      }

      // Find conversation data
      const conversation = stateRef.current.agentConversations.find((sc) => sc.id === conversationId)
      const rawMessages = conversation?.messages
      let messages: any[] = []
      if (Array.isArray(rawMessages)) {
        messages = rawMessages
      } else if (typeof rawMessages === "string") {
        try {
          const parsed = JSON.parse(rawMessages)
          messages = Array.isArray(parsed) ? parsed : []
        } catch {
          messages = []
        }
      }

      // Get mode from store metadata (falls back to chat.currentMode)
      const conversationMeta = useAgentConversationStore
        .getState()
        .allConversations.find((sc) => sc.id === conversationId)
      const conversationMode = conversationMeta?.mode || chatRef.current.currentMode

      console.log("[getOrCreateChat] Transport selection", {
        conversationId: conversationId.slice(-8),
        worktreePath: chatRef.current.worktreePath ? "exists" : "none",
      })

      const transport = stateRef.current.isGroupMode
        ? new GroupChatTransport()
        : isMockChatEnabled()
          ? new MockChatTransport({
            chatId: chatRef.current.chatId,
            conversationId,
            mode: conversationMode,
            groupAgents: stateRef.current.isGroupMode ? loadGroupAgents(chatRef.current.chatId) : [],
          })
          : new ErgataiChatTransport({
            chatId: chatRef.current.chatId,
            conversationId: conversationId,
            workspaceId: chatRef.current.worktreePath || undefined,
            command:
              conversationAgentStorage.get(conversationId) ||
              providerRef.current.conversationProviderOverrides[conversationId] ||
              providerRef.current.inferProviderFromMessages(conversationId),
            mode: conversationMode,
          })

      if (!transport) {
        console.error("[getOrCreateChat] No transport available")
        return null
      }

      const newChat = new Chat<any>({
        id: conversationId,
        messages,
        transport,
        onError: (error) => {
          console.error("[ChatSend] Failed", error)
          toast.error("Message failed", {
            description: error?.message || "Unknown error",
          })
          finalizeConversation(conversationId, newChat)
        },
        // Clear loading when streaming completes (works even if component unmounted)
        onFinish: () => {
          clearLoading(stateRef.current.setLoadingConversations, conversationId)

          // Check if this was a manual abort (ESC/Ctrl+C) - skip sound if so
          const wasManuallyAborted =
            agentChatStore.wasManuallyAborted(conversationId)
          agentChatStore.clearManuallyAborted(conversationId)

          // Get CURRENT values at runtime (not stale closure values)
          const currentActiveConversationId =
            useAgentConversationStore.getState().activeConversationId
          const currentSelectedChatId = appStore.get(selectedAgentChatIdAtom)

          const isViewingThisConversation = currentActiveConversationId === conversationId
          const isViewingThisChat = currentSelectedChatId === chatRef.current.chatId

          if (!isViewingThisConversation) {
            stateRef.current.setConversationUnseenChanges((prev: Set<string>) => {
              const next = new Set(prev)
              next.add(conversationId)
              return next
            })
          }

          // Also mark parent chat as unseen if user is not viewing it
          if (!isViewingThisChat) {
            stateRef.current.setUnseenChanges((prev: Set<string>) => {
              const next = new Set(prev)
              next.add(chatRef.current.chatId)
              return next
            })

            // Play completion sound only if NOT manually aborted and sound is enabled
            if (!wasManuallyAborted) {
              const isSoundEnabled = appStore.get(soundNotificationsEnabledAtom)
              if (isSoundEnabled) {
                try {
                  const audio = new Audio("/sound.mp3")
                  audio.volume = 1.0
                  audio.play().catch(() => {})
                } catch {
                  // Ignore audio errors
                }
              }
            }
          }

          // Refresh diff stats after agent finishes making changes
          utilsRef.current.fetchDiffStatsRef.current()

          finalizeConversation(conversationId, newChat)
        },
      })

      agentChatStore.set(conversationId, newChat, chatRef.current.chatId)
      utilsRef.current.forceUpdate({}) // Trigger re-render to use new chat
      return newChat
    },
    [],
  )

  return {
    getOrCreateChat,
    syncFinishedMessagesToChatCache,
    pruneIfDetachedAndIdle,
  }
}
