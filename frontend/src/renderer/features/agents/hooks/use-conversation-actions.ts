import { useCallback } from "react"
import { toast } from "sonner"
import type { UIMessage } from "@ai-sdk/react"
import type {
  SelectedTextContext,
  DiffTextContext,
  PastedTextFile,
  UploadedImage,
} from "../types"
import type { AgentsMentionsEditorHandle } from "../mentions"
import { executeRollback } from "./rollback-utils"
import type { RollbackMessageLike } from "./rollback-utils"

interface UseConversationActionsOptions {
  conversationId: string
  isStreaming: boolean
  isRollingBack: boolean
  setIsRollingBack: (value: boolean) => void
  messages: UIMessage[]
  setMessages: (messages: UIMessage[] | ((current: UIMessage[]) => UIMessage[])) => void
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>
  recomputeChangedFiles: () => void
  refreshDiff?: () => void
  setImagesFromDraft: (images: UploadedImage[]) => void
  setTextContextsFromDraft: (contexts: SelectedTextContext[]) => void
  setDiffTextContextsFromDraft: (contexts: DiffTextContext[]) => void
  setPastedTextsFromDraft: (texts: PastedTextFile[]) => void
}

export function useConversationActions({
  conversationId,
  isStreaming,
  isRollingBack,
  setIsRollingBack,
  messages,
  setMessages,
  editorRef,
  recomputeChangedFiles,
  refreshDiff,
  setImagesFromDraft,
  setTextContextsFromDraft,
  setDiffTextContextsFromDraft,
  setPastedTextsFromDraft,
}: UseConversationActionsOptions) {
  const handleRollback = useCallback(
    async (userMsg: (typeof messages)[0]) => {
      try {
        await executeRollback(
          // Both UIMessage (AI SDK) and Message (local) share the minimal shape
          // (id, role, parts, metadata) that rollback operations require.
          { isRollingBack, isStreaming, messages: messages as unknown as RollbackMessageLike[], conversationId, userMsg: userMsg as unknown as RollbackMessageLike },
          {
            setIsRollingBack,
            // Type assertion safe: executeRollback coerces to Message[] before calling setMessages,
            // and the underlying UIMessage[] setter accepts structurally compatible objects.
            setMessages: setMessages as (messages: RollbackMessageLike[] | ((current: RollbackMessageLike[]) => RollbackMessageLike[])) => void,
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
        console.error("[use-conversation-actions] Rollback failed:", error)
        toast.error("Failed to rollback conversation. Please try again.")
      }
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
