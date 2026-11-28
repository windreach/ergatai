 
import { useEffect } from "react"
import { useSetAtom } from "jotai"

import { agentChatStore } from "../stores/agent-chat-store"
import { setLoading, clearLoading } from "../atoms"
import { pendingPlanApprovalsAtom } from "../atoms"

export function useActiveChatEffects({
  conversationId,
  isStreaming,
  isRuntimeStreaming,
  isActive,
  messages,
  pendingInitialPrompt,
  setPendingInitialPrompt,
  conversationRuntime,
  setLoadingConversations,
}: {
  conversationId: string
  isStreaming: boolean
  isRuntimeStreaming: boolean
  isActive: boolean
  messages: any[]
  pendingInitialPrompt: any
  setPendingInitialPrompt: (v: any) => void
  conversationRuntime: any
  setLoadingConversations: any
}) {
  useEffect(() => {
    if (
      !pendingInitialPrompt ||
      pendingInitialPrompt.status === "completed" ||
      pendingInitialPrompt.status === "failed"
    ) {
      return
    }

    if (
      isRuntimeStreaming ||
      conversationRuntime?.status === "completed" ||
      conversationRuntime?.status === "error" ||
      messages.length > 0
    ) {
      // A failed initial prompt has no assistant message to wait for. The
      // backend publishes a terminal runtime error, so clear the local
      // "Generating" handle instead of leaving it pending forever.
      setPendingInitialPrompt(null)
    }
  }, [
    isRuntimeStreaming,
    messages,
    pendingInitialPrompt,
    setPendingInitialPrompt,
    conversationRuntime?.status,
  ])

  useEffect(() => {
    const storedParentChatId = agentChatStore.getParentChatId(conversationId)
    if (!storedParentChatId) return

    const isBackendStreaming = conversationRuntime?.status === "streaming"

    if (isStreaming || isBackendStreaming) {
      setLoading(setLoadingConversations, conversationId, storedParentChatId)
    } else if (isActive) {
      // Only the active conversation owns the clear path here. A background
      // tab can briefly report a non-streaming status while switching panes,
      // which used to wipe the sidebar marker for a still-running turn.
      // Background completion is cleared globally by the turn orchestrator.
      clearLoading(setLoadingConversations, conversationId)
    }
  }, [isStreaming, conversationRuntime?.status, conversationId, isActive, setLoadingConversations])

  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom)

  useEffect(() => {
    return () => {
      setPendingPlanApprovals((prev: Map<string, string>) => {
        if (prev.has(conversationId)) {
          const newMap = new Map(prev)
          newMap.delete(conversationId)
          return newMap
        }
        return prev
      })
    }
  }, [conversationId, setPendingPlanApprovals])
}
