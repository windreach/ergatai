import { useEffect, useRef } from "react"
import { getMessageCorrelationService } from "@/features/conversation/runtime/message-correlation-service"

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

interface ImageData {
  base64Data: string
  mediaType: string
  filename?: string
}

interface MessageParts {
  role: "user" | "agent"
  parts: Array<{
    type: "text" | "data-image"
    text?: string
    data?: ImageData
  }>
}

interface UsePendingAuthRetryProps {
  pendingAuthRetry: PendingAuthRetryMessage | null
  conversationId: string
  provider: "claude-code" | "codex"
  isStreaming: boolean
  sendMessage: (message: MessageParts) => void | Promise<void>
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
  // Ref to prevent re-entry during async send (race condition guard)
  const isRetryingRef = useRef(false)

  useEffect(() => {
    // Only retry when:
    // 1. There's a pending message
    // 2. readyToRetry is true (set by modal on OAuth success)
    // 3. We're in the correct chat
    // 4. Not currently streaming
    // 5. Not already retrying (race condition guard)
    if (
      pendingAuthRetry &&
      pendingAuthRetry.readyToRetry &&
      pendingAuthRetry.conversationId === conversationId &&
      pendingAuthRetry.provider === provider &&
      !isStreaming &&
      !isRetryingRef.current
    ) {
      // Set retrying flag to prevent re-entry
      isRetryingRef.current = true

      // Clear the pending message immediately to prevent double-sending
      setPendingAuthRetry(null)

      // Build message parts
      const parts: MessageParts["parts"] = [{ type: "text", text: pendingAuthRetry.prompt }]

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

      // Send the message to Claude with proper error handling
      ;(async () => {
        try {
          const message = await getMessageCorrelationService().createOptimisticMessage({
            role: "user",
            parts: parts as any,
          })
          await sendMessage(message as MessageParts)
        } catch (error) {
          // Restore the pending retry so the user can try again
          setPendingAuthRetry(pendingAuthRetry)
          console.error("Failed to retry pending message after auth:", error)
        } finally {
          // Clear the retrying flag
          isRetryingRef.current = false
        }
      })()
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
