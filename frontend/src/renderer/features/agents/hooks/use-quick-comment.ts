import { useCallback, useState } from "react"
import { toast } from "sonner"
import { MENTION_PREFIXES } from "../../mentions/types"
import { utf8ToBase64 } from "../utils/base64"
import { createQueueItem, generateQueueId, type AgentQueueItem } from "../lib/queue-utils"
import type { TextSelectionSource } from "../types"

interface UserMessage {
  role: string
  parts: Array<{ type: string; text: string }>
}

interface UseQuickCommentOptions {
  conversationId: string
  isStreamingRef: React.RefObject<boolean>
  addToQueue: (conversationId: string, item: AgentQueueItem) => void
  sendMessageRef: React.RefObject<(message: UserMessage) => Promise<void>>
}

export function useQuickComment({
  conversationId,
  isStreamingRef,
  addToQueue,
  sendMessageRef,
}: UseQuickCommentOptions) {
  const [quickCommentState, setQuickCommentState] = useState<{
    selectedText: string
    source: TextSelectionSource
    rect: DOMRect
  } | null>(null)

  // Handler for quick comment trigger from popover
  const handleQuickComment = useCallback((text: string, source: TextSelectionSource, rect: DOMRect) => {
    setQuickCommentState({ selectedText: text, source, rect })
  }, [])

  // Handler for quick comment submission
  const handleQuickCommentSubmit = useCallback((comment: string, selectedText: string, source: TextSelectionSource) => {
    // Format message with mention token + comment
    const MAX_PREVIEW_LENGTH = 50
    const preview = selectedText.slice(0, MAX_PREVIEW_LENGTH).replace(/[:\[\]]/g, "")
    const encodedText = utf8ToBase64(selectedText)

    let mentionToken: string
    if (source.type === "diff" || source.type === "tool-edit") {
      const lineNum = source.type === "diff" ? (source.lineNumber || 0) : 0
      mentionToken = `@[${MENTION_PREFIXES.DIFF}${source.filePath}:${lineNum}:${preview}:${encodedText}]`
    } else {
      mentionToken = `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`
    }

    const message = `${mentionToken} ${comment}`

    // If streaming, add to queue
    if (isStreamingRef.current) {
      const item = createQueueItem(generateQueueId(), message)
      addToQueue(conversationId, item)
      toast.success("Reply queued", { description: "Will be sent when current response completes" })
    } else {
      // Send directly with proper error handling
      ;(async () => {
        try {
          await sendMessageRef.current?.({
            role: "user",
            parts: [{ type: "text", text: message }],
          })
          toast.success("Reply sent")
        } catch (error) {
          console.error("[useQuickComment] Failed to send reply:", error)
          toast.error("Failed to send reply", { description: "Please try again" })
        }
      })()
    }

    // Clear state and selection
    setQuickCommentState(null)
    window.getSelection()?.removeAllRanges()
  }, [addToQueue, conversationId, isStreamingRef, sendMessageRef])

  // Handler for quick comment cancel
  const handleQuickCommentCancel = useCallback(() => {
    setQuickCommentState(null)
  }, [])

  return {
    quickCommentState,
    setQuickCommentState,
    handleQuickComment,
    handleQuickCommentSubmit,
    handleQuickCommentCancel,
  }
}
