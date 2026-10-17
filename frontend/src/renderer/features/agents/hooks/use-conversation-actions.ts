import { useCallback, useRef } from "react"
import { trpcClient } from "../../../lib/trpc"
import { toast } from "sonner"
import { useAgentConversationStore } from "../stores/conversation-store"
import { appStore } from "../../../lib/jotai-store"
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
import { findRollbackTargetSdkUuidForUserIndex } from "../stores/message-store"
import { parseMentionTokensFromText } from "../lib/mention-token-parser"

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
      if (isRollingBack) {
        toast.error("Rollback already in progress")
        return
      }
      if (isStreaming) {
        toast.error("Cannot rollback while streaming")
        return
      }

      // Find the index of this user message
      const userMsgIndex = messages.findIndex((m) => m.id === userMsg.id)
      if (userMsgIndex === -1) {
        toast.error("Cannot rollback: message not found")
        return
      }

      const sdkUuid = findRollbackTargetSdkUuidForUserIndex(
        userMsgIndex,
        messages.length,
        (index) => messages[index] as any,
      )

      if (!sdkUuid) {
        toast.error("Cannot rollback: this turn is not rollbackable")
        return
      }

      // Extract raw text from user message (includes mention tokens)
      const rawText = userMsg.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n") || ""

      // Parse mention tokens from text to restore text contexts, diff contexts, and pasted texts
      const parsed = parseMentionTokensFromText(rawText)
      const restoredTextContexts = parsed.textContexts
      const restoredDiffTextContexts = parsed.diffTextContexts
      const restoredPastedTexts = parsed.pastedTexts
      const cleanedText = parsed.cleanedText

      // Extract images from user message for restoring into input
      const userMsgImages: UploadedImage[] = (userMsg.parts || [])
        .filter((p: any) => p.type === "data-image" && p.data)
        .map((p: any) => ({
          id: crypto.randomUUID(),
          filename: p.data.filename || "image",
          url: p.data.url || (p.data.base64Data && p.data.mediaType
            ? `data:${p.data.mediaType};base64,${p.data.base64Data}`
            : ""),
          base64Data: p.data.base64Data,
          mediaType: p.data.mediaType,
          isLoading: false,
        }))

      setIsRollingBack(true)

      try {
        // Single call handles both message truncation and git rollback
        const result = await trpcClient.chats.rollbackToMessage.mutate({
          conversationId,
          sdkMessageUuid: sdkUuid,
        })

        if (!result.success) {
          toast.error(`Failed to rollback: ${result.error}`)
          setIsRollingBack(false)
          return
        }

        // Update local state with truncated messages from server
        setMessages(result.messages)
        recomputeChangedFiles()
        refreshDiff?.()

        // Restore all user message content into input
        if (cleanedText) {
          editorRef.current?.setValue(cleanedText)
        }
        if (userMsgImages.length > 0) {
          setImagesFromDraft(userMsgImages)
        }
        if (restoredTextContexts.length > 0) {
          setTextContextsFromDraft(restoredTextContexts)
        }
        if (restoredDiffTextContexts.length > 0) {
          setDiffTextContextsFromDraft(restoredDiffTextContexts)
        }
        if (restoredPastedTexts.length > 0) {
          setPastedTextsFromDraft(restoredPastedTexts)
        }
        editorRef.current?.focus()
      } catch (error) {
        console.error("[handleRollback] Error:", error)
        toast.error("Failed to rollback")
      } finally {
        setIsRollingBack(false)
      }
    },
    [
      isRollingBack,
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
