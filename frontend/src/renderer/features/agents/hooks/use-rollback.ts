import { useCallback } from "react"
import { toast } from "sonner"
import { trpcClient } from "../../../lib/trpc"
import { findRollbackTargetSdkUuidForUserIndex } from "../stores/message-store"
import { parseMentionTokensFromText } from "../lib/mention-token-parser"
import type { SelectedTextContext, DiffTextContext, PastedTextFile, UploadedImage } from "../types"

interface UseRollbackOptions {
  isRollingBack: boolean
  setIsRollingBack: (value: boolean) => void
  isStreaming: boolean
  messages: any[]
  setMessages: (messages: any[]) => void
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
      setIsRollingBack,
      editorRef,
    ],
  )

  return {
    handleRollback,
  }
}
