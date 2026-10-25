import { useCallback } from "react"
import { executeRollback } from "./rollback-utils"
import type { SelectedTextContext, DiffTextContext, PastedTextFile, UploadedImage } from "../types"

interface UseRollbackOptions {
  isRollingBack: boolean
  setIsRollingBack: (value: boolean) => void
  isStreaming: boolean
  messages: any[]
  setMessages: (messages: any[] | ((current: any[]) => any[])) => void
  conversationId: string
  recomputeChangedFiles: () => void
  refreshDiff?: () => void
  setImagesFromDraft: (images: UploadedImage[]) => void
  setTextContextsFromDraft: (contexts: SelectedTextContext[]) => void
  setDiffTextContextsFromDraft: (contexts: DiffTextContext[]) => void
  setPastedTextsFromDraft: (texts: PastedTextFile[]) => void
  editorRef: React.RefObject<any>
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
  // Rollback handler - triggered from user message bubble
  // Finds the last assistant message BEFORE this user message, rolls back to it,
  // and inserts the user message text into the input for easy re-sending
  const handleRollback = useCallback(
    async (userMsg: (typeof messages)[0]) => {
      await executeRollback(
        { isRollingBack, isStreaming, messages, conversationId, userMsg },
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
    },
    [
      isRollingBack,
      isStreaming,
      messages,
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
