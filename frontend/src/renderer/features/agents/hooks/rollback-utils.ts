import { toast } from "sonner"
import { trpcClient } from "../../../lib/trpc"
import { findRollbackTargetSdkUuidForUserIndex } from "../stores/message-store"
import { parseMentionTokensFromText } from "../lib/mention-token-parser"
import { createLocalId } from "../../../../shared/id"
import type {
  SelectedTextContext,
  DiffTextContext,
  PastedTextFile,
  UploadedImage,
} from "../types"

interface RollbackParams {
  isRollingBack: boolean
  isStreaming: boolean
  // any[] justified: Message structure comes from tRPC backend without strict TypeScript types
  messages: any[]
  conversationId: string
  // any justified: User message has dynamic structure with optional parts array
  userMsg: any
}

interface RollbackCallbacks {
  setIsRollingBack: (value: boolean) => void
  // any[] justified: Matches the dynamic message structure from backend
  setMessages: (messages: any[] | ((current: any[]) => any[])) => void
  recomputeChangedFiles: () => void
  refreshDiff?: () => void
  setImagesFromDraft: (images: UploadedImage[]) => void
  setTextContextsFromDraft: (contexts: SelectedTextContext[]) => void
  setDiffTextContextsFromDraft: (contexts: DiffTextContext[]) => void
  setPastedTextsFromDraft: (texts: PastedTextFile[]) => void
  // any justified: Editor ref type depends on the specific editor component used
  editorRef: React.RefObject<any>
}

/**
 * Shared rollback logic extracted from use-rollback.ts and use-conversation-actions.ts
 * Handles validation, message parsing, SDK UUID lookup, state restoration, and API calls
 */
export async function executeRollback(
  { isRollingBack, isStreaming, messages, conversationId, userMsg }: RollbackParams,
  callbacks: RollbackCallbacks,
): Promise<void> {
  const {
    setIsRollingBack,
    setMessages,
    recomputeChangedFiles,
    refreshDiff,
    setImagesFromDraft,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
    setPastedTextsFromDraft,
    editorRef,
  } = callbacks

  if (isRollingBack) {
    toast.error("Rollback already in progress")
    return
  }
  if (isStreaming) {
    toast.error("Cannot rollback while streaming")
    return
  }

  // Validate userMsg before accessing its properties
  if (!userMsg) {
    console.error('[Rollback] userMsg is null/undefined')
    toast.error('Cannot rollback: message not found')
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
    (index) => messages[index],
  )

  if (!sdkUuid) {
    toast.error("Cannot rollback: this turn is not rollbackable")
    return
  }

  // Extract raw text from user message (includes mention tokens)
  // any justified: Message parts have dynamic structure (text, data-image, etc.) without strict types
  const rawText =
    userMsg.parts
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
      id: createLocalId("local-image"),
      filename: p.data.filename || "image",
      url: p.data.url || (p.data.base64Data && p.data.mediaType
        ? `data:${p.data.mediaType};base64,${p.data.base64Data}`
        : ""),
      base64Data: p.data.base64Data,
      mediaType: p.data.mediaType,
      isLoading: false,
    }))
    .filter((img: UploadedImage) => img.url && img.url.length > 0)

  setIsRollingBack(true)

  // Phase 1: API call - handle rollback on server
  let result
  try {
    result = await trpcClient.chats.rollbackToMessage.mutate({
      conversationId,
      sdkMessageUuid: sdkUuid,
    })
  } catch (error) {
    console.error("[executeRollback] API call failed:", error)
    toast.error("Failed to rollback")
    setIsRollingBack(false)
    return
  }

  if (!result.success) {
    toast.error(`Failed to rollback: ${result.error}`)
    setIsRollingBack(false)
    return
  }

  // Validate response shape before updating state
  if (!Array.isArray(result.messages)) {
    console.error('[Rollback] Invalid response: messages is not an array', result)
    toast.error('Rollback failed: invalid response from server')
    setIsRollingBack(false)
    return
  }

  // Phase 2: UI restoration - update local state (errors here are non-fatal)
  try {
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
    console.error("[executeRollback] UI restoration failed (rollback succeeded):", error)
    setIsRollingBack(false)
    return
  }
}
