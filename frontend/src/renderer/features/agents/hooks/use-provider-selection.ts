import { useCallback, useRef } from "react"
import type { Message } from "../stores/message-store"

interface UseProviderSelectionOptions {
  conversationId: string
  parentChatId: string | null
  conversationMode: "plan" | "agent"
  isStreaming: boolean
  messages: Message[]
  onProviderChange?: (conversationId: string, provider: "claude-code" | "codex") => void
  utils?: unknown
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
        // This feature has been removed - log warning for debugging
        console.warn(
          `[use-provider-selection] Continuing with ${targetProvider} is no longer supported`,
        )
      } finally {
        isContinuingRef.current = false
      }
    },
    [isStreaming, messages],
  )

  return {
    handleInputProviderChange,
    handleContinueWithProvider,
    isContinuingRef,
  }
}
