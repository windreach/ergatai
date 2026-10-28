import { useCallback, useRef } from "react"
import { toast } from "sonner"
import { executeRollback } from "./rollback-utils"
import type { SelectedTextContext, DiffTextContext, PastedTextFile, UploadedImage } from "../types"

// any justified: messages have a complex union type from the conversation system
// that varies by role and content type. Using a generic array type is simpler
// than importing and maintaining the full Message union here.
type MessagesArray = any[]
type SetMessagesFn = (messages: MessagesArray | ((current: MessagesArray) => MessagesArray)) => void

interface UseRollbackOptions {
  isRollingBack: boolean
  setIsRollingBack: (value: boolean) => void
  isStreaming: boolean
  messages: MessagesArray
  setMessages: SetMessagesFn
  conversationId: string
  recomputeChangedFiles: () => void
  refreshDiff?: () => void
  setImagesFromDraft: (images: UploadedImage[]) => void
  setTextContextsFromDraft: (contexts: SelectedTextContext[]) => void
  setDiffTextContextsFromDraft: (contexts: DiffTextContext[]) => void
  setPastedTextsFromDraft: (texts: PastedTextFile[]) => void
  editorRef: React.RefObject<any> // any justified: editor ref type is complex and varies by editor implementation
}

export function useRollback({
  isRollingBack,
  setIsRollingBack,
  isStreaming,
  messages,
  setMessages,
  conversationId,
  recomputeChangedFiles,
  refreshDiff,
  setImagesFromDraft,
  setTextContextsFromDraft,
  setDiffTextContextsFromDraft,
  setPastedTextsFromDraft,
  editorRef,
}: UseRollbackOptions) {
  // Use refs for volatile state to stabilize callback identity
  const isRollingBackRef = useRef(isRollingBack)
  const isStreamingRef = useRef(isStreaming)
  const messagesRef = useRef(messages)

  // Keep refs in sync with current values
  isRollingBackRef.current = isRollingBack
  isStreamingRef.current = isStreaming
  messagesRef.current = messages

  // Rollback handler - triggered from user message bubble
  // Finds the last assistant message BEFORE this user message, rolls back to it,
  // and inserts the user message text into the input for easy re-sending
  const handleRollback = useCallback(
    async (userMsg: MessagesArray[0]) => {
      try {
        await executeRollback(
          {
            isRollingBack: isRollingBackRef.current,
            isStreaming: isStreamingRef.current,
            messages: messagesRef.current,
            conversationId,
            userMsg,
          },
          {
            setIsRollingBack,
            setMessages,
            recomputeChangedFiles,
            refreshDiff,
            setImagesFromDraft,
            setTextContextsFromDraft,
            setDiffTextContextsFromDraft,
            setPastedTextsFromDraft,
            editorRef,
          },
        )
      } catch (error) {
        console.error("[useRollback] Unexpected error during rollback:", error)
        toast.error("An unexpected error occurred during rollback")
      }
    },
    [
      conversationId,
      setIsRollingBack,
      setMessages,
      recomputeChangedFiles,
      refreshDiff,
      setImagesFromDraft,
      setTextContextsFromDraft,
      setDiffTextContextsFromDraft,
      setPastedTextsFromDraft,
      editorRef,
    ],
  )

  return {
    handleRollback,
  }
}
