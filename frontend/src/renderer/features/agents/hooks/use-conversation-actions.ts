import { useCallback, useRef } from "react"
import { trpcClient } from "../../../lib/trpc"
import { useAgentConversationStore } from "../stores/conversation-store"
import { appStore } from "../../../lib/jotai-store"
import { toast } from "sonner"
import {
  conversationModeAtomFamily,
  conversationModelIdAtomFamily,
  conversationCodexModelIdAtomFamily,
  conversationCodexThinkingAtomFamily,
} from "../atoms"
import type { UIMessage } from "@ai-sdk/react"
import type {
  SelectedTextContext,
  DiffTextContext,
  PastedTextFile,
  UploadedImage,
} from "../types"
import { executeRollback } from "./rollback-utils"

interface UseConversationActionsOptions {
  conversationId: string
  parentChatId: string | null
  isStreaming: boolean
  isRollingBack: boolean
  setIsRollingBack: (value: boolean) => void
  messages: UIMessage[]
  setMessages: (messages: any[] | ((current: any[]) => any[])) => void
  editorRef: React.RefObject<any>
  recomputeChangedFiles: () => void
  refreshDiff?: () => void
  setImagesFromDraft: (images: UploadedImage[]) => void
  setTextContextsFromDraft: (contexts: SelectedTextContext[]) => void
  setDiffTextContextsFromDraft: (contexts: DiffTextContext[]) => void
  setPastedTextsFromDraft: (texts: PastedTextFile[]) => void
  utils: any
}

export function useConversationActions({
  conversationId,
  parentChatId,
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
  utils,
}: UseConversationActionsOptions) {
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

  // Fork handler - creates a new conversation with messages up to this point
  // Preserves SDK session context by copying .jsonl session files
  const isForkingRef = useRef(false)
  // Keep a ref to messages so the fork callback always has the latest
  // without adding `messages` to the dependency array (which would cause
  // frequent re-creations during streaming)
  const messagesForForkRef = useRef(messages)
  messagesForForkRef.current = messages

  const handleForkFromMessage = useCallback(
    async (messageId: string) => {
      // Backend no longer supports forking conversations
      console.warn("[use-conversation-actions] forkConversation is no longer supported")
      toast.error("Forking conversations is no longer supported")
    },
    [],
  )

  return {
    handleRollback,
    handleForkFromMessage,
    isForkingRef,
  }
}
