import { useCallback, useEffect, useRef } from "react"
import { appStore } from "../../../lib/jotai-store"
import { pendingChatHistoryAtom } from "../atoms"

import { useAgentsFileUpload } from "../hooks/use-agents-file-upload"
import { useTextContextSelection } from "../hooks/use-text-context-selection"
import { usePastedTextFiles } from "../hooks/use-pasted-text-files"

export function useActiveChatAttachments({
  conversationId,
}: {
  conversationId: string
}) {
  const {
    images,
    files,
    handleAddAttachments,
    handleAddFolder,
    removeImage,
    removeFile,
    clearAll,
    isUploading,
    setImagesFromDraft,
    setFilesFromDraft,
  } = useAgentsFileUpload()

  const {
    textContexts,
    diffTextContexts,
    addTextContext: addTextContextOriginal,
    addDiffTextContext,
    removeTextContext,
    removeDiffTextContext,
    clearTextContexts,
    clearDiffTextContexts,
    textContextsRef,
    diffTextContextsRef,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
  } = useTextContextSelection()

  const {
    pastedTexts,
    addPastedText,
    addChatHistoryFile,
    removePastedText,
    clearPastedTexts,
    pastedTextsRef,
    setPastedTextsFromDraft,
  } = usePastedTextFiles(conversationId)

  useEffect(() => {
    const pending = appStore.get(pendingChatHistoryAtom)
    if (pending && pending.conversationId === conversationId) {
      addChatHistoryFile(pending.file)
      appStore.set(pendingChatHistoryAtom, null)
    }
  }, [conversationId, addChatHistoryFile])

  const fileContentsRef = useRef<Map<string, string>>(new Map())

  const cacheFileContent = useCallback((mentionId: string, content: string) => {
    fileContentsRef.current.set(mentionId, content)
  }, [])

  const clearFileContents = useCallback(() => {
    fileContentsRef.current.clear()
  }, [])

  useEffect(() => {
    fileContentsRef.current.clear()
  }, [conversationId])

  return {
    images,
    files,
    handleAddAttachments,
    handleAddFolder,
    removeImage,
    removeFile,
    clearAll,
    isUploading,
    setImagesFromDraft,
    setFilesFromDraft,
    textContexts,
    diffTextContexts,
    addTextContextOriginal,
    addDiffTextContext,
    removeTextContext,
    removeDiffTextContext,
    clearTextContexts,
    clearDiffTextContexts,
    textContextsRef,
    diffTextContextsRef,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
    pastedTexts,
    addPastedText,
    addChatHistoryFile,
    removePastedText,
    clearPastedTexts,
    pastedTextsRef,
    setPastedTextsFromDraft,
    fileContentsRef,
    cacheFileContent,
    clearFileContents,
  }
}
