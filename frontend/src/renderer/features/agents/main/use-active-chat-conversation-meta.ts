import { useCallback, useEffect, useRef, useState } from "react"
import { useAtom } from "jotai"
import { toast } from "sonner"

import { api } from "../../../lib/api-adapter"
import { appStore } from "../../../lib/jotai-store"
import { useAgentConversationStore } from "../stores/conversation-store"
import { conversationModeAtomFamily } from "../atoms"
import type { AgentMode } from "../atoms"

export function useActiveChatConversationMeta({
  conversationId,
  parentChatId,
  utils,
}: {
  conversationId: string
  parentChatId: string
  utils: any
}) {
  const conversationName = useAgentConversationStore(
    (state) => state.allConversations.find((sc) => sc.id === conversationId)?.name || "",
  )

  const renameConversationMutation = api.agents.renameConversation.useMutation({
    onError: (error: any) => {
      if (error.data?.code === "NOT_FOUND") {
        toast.error("Send a message first before renaming this chat")
      } else {
        toast.error("Failed to rename chat")
      }
    },
  })

  const renameConversationMutationRef = useRef(renameConversationMutation)
  renameConversationMutationRef.current = renameConversationMutation

  const conversationNameRef = useRef(conversationName)
  conversationNameRef.current = conversationName

  const handleRenameConversation = useCallback(
    async (newName: string) => {
      useAgentConversationStore.getState().updateConversationName(conversationId, newName)
      try {
        await renameConversationMutationRef.current.mutateAsync({
          conversationId: conversationId,
          title: newName,
        })
      } catch {
        useAgentConversationStore
          .getState()
          .updateConversationName(conversationId, conversationNameRef.current || "New Chat")
      }
    },
    [conversationId],
  )

  const [conversationMode, setConversationMode] = useAtom(conversationModeAtomFamily(conversationId))

  const updateConversationModeMutation = api.agents.updateConversationMode.useMutation({
    onSuccess: () => {
      utils.agents.getAgentChat.invalidate({ chatId: parentChatId })
    },
    onError: (error: any, variables: any) => {
      if (error.message === "Conversation not found") {
        console.warn("Conversation not found in DB, keeping local mode state")
        return
      }
      const revertedMode: AgentMode = variables.mode === "plan" ? "agent" : "plan"
      setConversationMode(revertedMode)
      useAgentConversationStore.getState().updateConversationMode(variables.conversationId, revertedMode)
      console.error("Failed to update conversation mode:", error.message)
    },
  })

  useEffect(() => {
    if (conversationId) {
      const mode = appStore.get(conversationModeAtomFamily(conversationId))
      useAgentConversationStore.getState().updateConversationMode(conversationId, mode)
    }
  }, [conversationId])

  const handleModeChange = useCallback((newMode: AgentMode) => {
    setConversationMode(newMode)
    useAgentConversationStore.getState().updateConversationMode(conversationId, newMode)
    if (!conversationId.startsWith("temp-")) {
      updateConversationModeMutation.mutate({ conversationId, mode: newMode })
    }
  }, [conversationId, setConversationMode, updateConversationModeMutation])

  return {
    conversationName,
    conversationNameRef,
    renameConversationMutation,
    renameConversationMutationRef,
    handleRenameConversation,
    conversationMode,
    setConversationMode,
    updateConversationModeMutation,
    handleModeChange,
  }
}
