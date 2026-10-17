import { useEffect, useRef } from "react"
import type { AgentsMentionsEditorHandle } from "../mentions"
import type { UploadedImage, UploadedFile } from "./use-agents-file-upload"
import type { SelectedTextContext } from "../lib/queue-utils"
import { getConversationDraftFull } from "../lib/drafts"

/**
 * Options for the useDraftRecovery hook
 */
interface UseDraftRecoveryOptions {
  conversationId: string
  parentChatId: string | null
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>
  setImagesFromDraft: (images: UploadedImage[]) => void
  setFilesFromDraft: (files: UploadedFile[]) => void
  setTextContextsFromDraft: (contexts: SelectedTextContext[]) => void
  clearAll: () => void
  clearTextContexts: () => void
}

/**
 * Hook to restore draft content when switching conversations
 *
 * Handles restoration of text, images, files, and text contexts from localStorage
 * when navigating between conversations. Clears the editor when switching to a
 * conversation with no draft.
 *
 * @param options - Hook options containing all dependencies
 */
export function useDraftRecovery(options: UseDraftRecoveryOptions): void {
  const {
    conversationId,
    parentChatId,
    editorRef,
    setImagesFromDraft,
    setFilesFromDraft,
    setTextContextsFromDraft,
    clearAll,
    clearTextContexts,
  } = options

  const prevConversationIdRef = useRef<string | null>(null)

  useEffect(() => {
    // Restore full draft (text + attachments + text contexts) for new conversation
    const savedDraft = parentChatId
      ? getConversationDraftFull(parentChatId, conversationId)
      : null

    if (savedDraft) {
      // Restore text
      if (savedDraft.text) {
        editorRef.current?.setValue(savedDraft.text)
      } else {
        editorRef.current?.clear()
      }
      // Restore images
      if (savedDraft.images.length > 0) {
        setImagesFromDraft(savedDraft.images)
      } else {
        clearAll()
      }
      // Restore files
      if (savedDraft.files.length > 0) {
        setFilesFromDraft(savedDraft.files)
      }
      // Restore text contexts
      if (savedDraft.textContexts.length > 0) {
        setTextContextsFromDraft(savedDraft.textContexts)
      } else {
        clearTextContexts()
      }
    } else if (
      prevConversationIdRef.current &&
      prevConversationIdRef.current !== conversationId
    ) {
      // Clear everything when switching to a conversation with no draft
      editorRef.current?.clear()
      clearAll()
      clearTextContexts()
    }

    prevConversationIdRef.current = conversationId
  }, [
    conversationId,
    parentChatId,
    editorRef,
    setImagesFromDraft,
    setFilesFromDraft,
    setTextContextsFromDraft,
    clearAll,
    clearTextContexts,
  ])
}
