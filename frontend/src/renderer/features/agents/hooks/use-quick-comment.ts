import { useCallback, useState } from "react"
import { toast } from "sonner"
import { MENTION_PREFIXES } from "../../mentions/types"
import { utf8ToBase64 } from "../utils/base64"
import { createQueueItem, generateQueueId } from "../lib/queue-utils"
import type { TextSelectionSource } from "../types"

interface UseQuickCommentOptions {
  conversationId: string
  isStreamingRef: React.RefObject<boolean>
  addToQueue: (conversationId: string, item: any) => void
  sendMessageRef: React.RefObject<(message: any) => Promise<void>>
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
    const preview = selectedText.slice(0, 50).replace(/[:\[\]]/g, "")
    const encodedText = utf8ToBase64(selectedText)

    let mentionToken: string
    if (source.type === "diff") {
      const lineNum = source.lineNumber || 0
      mentionToken = `@[${MENTION_PREFIXES.DIFF}${source.filePath}:${lineNum}:${preview}:${encodedText}]`
    } else if (source.type === "tool-edit") {
      // Tool edit is treated as code/diff context
      mentionToken = `@[${MENTION_PREFIXES.DIFF}${source.filePath}:0:${preview}:${encodedText}]`
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
      // Send directly
      sendMessageRef.current({
        role: "user",
        parts: [{ type: "text", text: message }],
      })
      toast.success("Reply sent")
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
