import { useEffect } from "react"

interface PendingAuthRetryMessage {
  conversationId: string
  provider: "claude-code" | "codex"
  prompt: string
  images?: Array<{
    base64Data: string
    mediaType: string
    filename?: string
  }>
  readyToRetry: boolean
}

interface UsePendingAuthRetryProps {
  pendingAuthRetry: PendingAuthRetryMessage | null
  conversationId: string
  provider: string
  isStreaming: boolean
  sendMessage: (message: any) => void
  setPendingAuthRetry: (val: PendingAuthRetryMessage | null) => void
}

/**
 * Hook to retry sending a pending message after OAuth authentication succeeds
 */
export function usePendingAuthRetry({
  pendingAuthRetry,
  conversationId,
  provider,
  isStreaming,
  sendMessage,
  setPendingAuthRetry,
}: UsePendingAuthRetryProps) {
  useEffect(() => {
    // Only retry when:
    // 1. There's a pending message
    // 2. readyToRetry is true (set by modal on OAuth success)
    // 3. We're in the correct chat
    // 4. Not currently streaming
    if (
      pendingAuthRetry &&
      pendingAuthRetry.readyToRetry &&
      pendingAuthRetry.conversationId === conversationId &&
      pendingAuthRetry.provider === provider &&
      !isStreaming
    ) {
      // Clear the pending message immediately to prevent double-sending
      setPendingAuthRetry(null)

      // Build message parts
      const parts: Array<
        { type: "text"; text: string } | { type: "data-image"; data: any }
      > = [{ type: "text", text: pendingAuthRetry.prompt }]

      // Add images if present
      if (pendingAuthRetry.images && pendingAuthRetry.images.length > 0) {
        for (const img of pendingAuthRetry.images) {
          parts.push({
            type: "data-image",
            data: {
              base64Data: img.base64Data,
              mediaType: img.mediaType,
              filename: img.filename,
            },
          })
        }
      }

      // Send the message to Claude
      sendMessage({
        role: "user",
        parts,
      })
    }
  }, [
    pendingAuthRetry,
    provider,
    isStreaming,
    sendMessage,
    setPendingAuthRetry,
    conversationId,
  ])
}
