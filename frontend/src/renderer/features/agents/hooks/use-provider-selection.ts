import { useCallback, useRef } from "react"
import { toast } from "sonner"
import { trpcClient } from "../../../lib/trpc"
import { appStore } from "../../../lib/jotai-store"
import {
  conversationModelIdAtomFamily,
  conversationCodexModelIdAtomFamily,
  conversationCodexThinkingAtomFamily,
  conversationModeAtomFamily,
  pendingChatHistoryAtom,
} from "../atoms"
import { useAgentConversationStore } from "../stores/conversation-store"
import { formatHistoryForContext } from "../lib/export-chat"
import type { PendingChatHistory } from "../atoms"

interface UseProviderSelectionOptions {
  conversationId: string
  parentChatId: string | null
  conversationMode: "plan" | "agent"
  isStreaming: boolean
  messages: any[]
  onProviderChange?: (conversationId: string, provider: "claude-code" | "codex") => void
  utils: any
  conversationNameRef: React.RefObject<string>
}

export function useProviderSelection({
  conversationId,
  parentChatId,
  conversationMode,
  isStreaming,
  messages,
  onProviderChange,
  utils,
  conversationNameRef,
}: UseProviderSelectionOptions) {
  const handleInputProviderChange = useCallback(
    (nextProvider: "claude-code" | "codex") => {
      onProviderChange?.(conversationId, nextProvider)
    },
    [onProviderChange, conversationId],
  )

  // Continue conversation with a different provider - creates new conversation with history attachment
  const isContinuingRef = useRef(false)
  const handleContinueWithProvider = useCallback(
    async (targetProvider: "claude-code" | "codex") => {
      if (isStreaming || isContinuingRef.current) return
      if (!messages || messages.length === 0) return
      isContinuingRef.current = true

      try {
        // Backend no longer supports creating child conversations
        // This feature has been removed
        console.warn("[use-provider-selection] createChildConversation is no longer supported")
        throw new Error("Creating new conversations from history is no longer supported")
      } catch (error) {
        console.error("[handleContinueWithProvider] Error:", error)
        toast.error("Failed to continue with provider")
      } finally {
        isContinuingRef.current = false
      }
    },
    [isStreaming, messages, conversationId],
  )

  return {
    handleInputProviderChange,
    handleContinueWithProvider,
    isContinuingRef,
  }
}
