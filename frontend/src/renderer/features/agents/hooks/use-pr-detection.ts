import { useEffect, useRef } from "react"
import { trpcClient } from "../../../lib/trpc"
import type { UIMessage } from "@ai-sdk/react"

interface UsePrDetectionOptions {
  messages: UIMessage[]
  isStreaming: boolean
  parentChatId: string | null
  existingPrUrl: string | null | undefined
  utils: any
}

export function usePrDetection({
  messages,
  isStreaming,
  parentChatId,
  existingPrUrl,
  utils,
}: UsePrDetectionOptions) {
  // Detect PR URLs in assistant messages and store them
  // Initialize with existing PR URL to prevent duplicate toast on re-mount
  const detectedPrUrlRef = useRef<string | null>(existingPrUrl ?? null)

  useEffect(() => {
    // Only check after streaming ends
    if (isStreaming) return

    // Don't run until agentChat has loaded so we know the real existingPrUrl
    if (existingPrUrl === undefined) return

    // Sync ref when existingPrUrl loads (prevents re-detection on remount)
    if (existingPrUrl && !detectedPrUrlRef.current) {
      detectedPrUrlRef.current = existingPrUrl
    }

    // Look through messages for PR URLs
    for (const msg of messages) {
      if (msg.role !== "assistant") continue

      // Extract text content from message
      const textContent =
        msg.parts
          ?.filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(" ") || ""

      // Match GitHub PR URL pattern
      const prUrlMatch = textContent.match(
        /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/,
      )

      if (prUrlMatch && prUrlMatch[0] !== detectedPrUrlRef.current && parentChatId) {
        const prUrl = prUrlMatch[0]
        const prNumber = parseInt(prUrlMatch[1], 10)

        // Store to prevent duplicate calls
        detectedPrUrlRef.current = prUrl

        // Update database
        trpcClient.chats.updatePrInfo
          .mutate({ chatId: parentChatId, prUrl, prNumber })
          .then(() => {
            // Invalidate the agentChat query to refetch with new PR info
            utils.agents.getAgentChat.invalidate({ chatId: parentChatId })
          })

        break // Only process first PR URL found
      }
    }
  }, [messages, isStreaming, parentChatId, existingPrUrl, utils])

  return {
    detectedPrUrlRef,
  }
}
