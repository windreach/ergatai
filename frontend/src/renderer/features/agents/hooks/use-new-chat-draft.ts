import { useAtom } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { activeNewChatDraftIdAtomFamily } from "../atoms"
import {
  deleteNewChatDraft,
  generateDraftId,
  getNewChatDraftFull,
  markDraftVisible,
  saveNewChatDraftWithAttachments,
  type DraftProject,
} from "../lib/drafts"
import type { AgentsMentionsEditorHandle } from "../mentions"
import type { UploadedFile, UploadedImage } from "./use-agents-file-upload"
import type { PastedTextFile } from "./use-pasted-text-files"

interface UseNewChatDraftOptions {
  scopeKey: string
  selectedDraftId: string | null
  project?: DraftProject
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>
  images: UploadedImage[]
  files: UploadedFile[]
  pastedTexts: PastedTextFile[]
  fileContentsRef: React.RefObject<Map<string, string>>
  setHasContent: (hasContent: boolean) => void
  setImagesFromDraft: (images: UploadedImage[]) => void
  setFilesFromDraft: (files: UploadedFile[]) => void
  setPastedTextsFromDraft: (texts: PastedTextFile[]) => void
}

/**
 * Persist and restore the NewChat composer. The active draft is scoped to a
 * workspace, and pending debounced writes are flushed on blur or unmount so a
 * quick page switch cannot discard the latest input.
 */
export function useNewChatDraft({
  scopeKey,
  selectedDraftId,
  project,
  editorRef,
  images,
  files,
  pastedTexts,
  fileContentsRef,
  setHasContent,
  setImagesFromDraft,
  setFilesFromDraft,
  setPastedTextsFromDraft,
}: UseNewChatDraftOptions) {
  const activeDraftAtom = useMemo(
    () => activeNewChatDraftIdAtomFamily(scopeKey),
    [scopeKey],
  )
  const [activeDraftId, setActiveDraftId] = useAtom(activeDraftAtom)
  const currentDraftIdRef = useRef<string | null>(selectedDraftId ?? activeDraftId)
  const isClearedRef = useRef(false)
  const textRef = useRef("")
  const lastObservedTextRef = useRef("")
  const imagesRef = useRef(images)
  const filesRef = useRef(files)
  const pastedTextsRef = useRef(pastedTexts)
  const projectRef = useRef(project)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isDraftReady, setIsDraftReady] = useState(false)
  const initializedRef = useRef(false)
  const previousSelectedDraftIdRef = useRef(selectedDraftId)
  const previousScopeKeyRef = useRef(scopeKey)

  useEffect(() => {
    imagesRef.current = images
    filesRef.current = files
    pastedTextsRef.current = pastedTexts
    if (project) projectRef.current = project
  }, [images, files, pastedTexts, project])

  const restoreDraft = useCallback(
    (draftId: string | null) => {
      const draft = draftId ? getNewChatDraftFull(draftId) : null
      const restoredDraftId = draft ? draftId : null

      currentDraftIdRef.current = restoredDraftId
      isClearedRef.current = false
      textRef.current = draft?.text ?? ""
      lastObservedTextRef.current = draft?.text ?? ""
      setActiveDraftId(restoredDraftId)

      // setValue also notifies the parent content callback. The observed text is
      // primed above so restoring never schedules a redundant write.
      editorRef.current?.setValue(draft?.text ?? "")
      setImagesFromDraft(draft?.images ?? [])
      setFilesFromDraft(draft?.files ?? [])
      setPastedTextsFromDraft(draft?.pastedTexts ?? [])
      fileContentsRef.current.clear()
      for (const [mentionId, content] of Object.entries(draft?.fileContents ?? {})) {
        fileContentsRef.current.set(mentionId, content)
      }
      setHasContent(Boolean(draft?.text))
      setIsDraftReady(true)
    },
    [
      editorRef,
      fileContentsRef,
      setActiveDraftId,
      setFilesFromDraft,
      setHasContent,
      setImagesFromDraft,
      setPastedTextsFromDraft,
    ],
  )

  useEffect(() => {
    const isInitialRender = !initializedRef.current
    const selectedDraftChanged =
      previousSelectedDraftIdRef.current !== selectedDraftId
    const scopeChanged = previousScopeKeyRef.current !== scopeKey

    previousSelectedDraftIdRef.current = selectedDraftId
    previousScopeKeyRef.current = scopeKey

    if (!isInitialRender && !selectedDraftChanged && !scopeChanged) return

    initializedRef.current = true
    const draftId =
      scopeChanged && !isInitialRender
        ? activeDraftId
        : selectedDraftId ?? activeDraftId
    restoreDraft(draftId)
  }, [activeDraftId, restoreDraft, scopeKey, selectedDraftId])

  const persistDraft = useCallback(() => {
    if (isClearedRef.current) return
    const text = textRef.current
    const currentImages = imagesRef.current
    const currentFiles = filesRef.current
    const currentPastedTexts = pastedTextsRef.current
    const hasContent =
      text.trim() ||
      currentImages.length > 0 ||
      currentFiles.length > 0 ||
      currentPastedTexts.length > 0

    if (!hasContent) {
      if (currentDraftIdRef.current) {
        deleteNewChatDraft(currentDraftIdRef.current)
      }
      currentDraftIdRef.current = null
      lastObservedTextRef.current = ""
      setActiveDraftId(null)
      return
    }

    const currentProject = projectRef.current
    if (!currentProject) return

    if (!currentDraftIdRef.current) {
      currentDraftIdRef.current = generateDraftId()
    }
    const draftId = currentDraftIdRef.current
    lastObservedTextRef.current = text
    setActiveDraftId(draftId)
    saveNewChatDraftWithAttachments(draftId, text, currentProject, {
      images: currentImages,
      files: currentFiles,
      pastedTexts: currentPastedTexts,
      fileContents: Object.fromEntries(fileContentsRef.current),
    })
  }, [fileContentsRef, setActiveDraftId])

  const flushDraft = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current)
      draftSaveTimerRef.current = null
    }
    persistDraft()
  }, [persistDraft])

  const scheduleSave = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current)
    }
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null
      persistDraft()
    }, 300)
  }, [persistDraft])

  const handleContentChange = useCallback(
    (hasContent: boolean) => {
      setHasContent(hasContent)
      const text = editorRef.current?.getValue() ?? textRef.current
      textRef.current = text
      if (text) isClearedRef.current = false
      if (text === lastObservedTextRef.current) return
      lastObservedTextRef.current = text
      scheduleSave()
    },
    [editorRef, scheduleSave, setHasContent],
  )

  useEffect(() => {
    if (!isDraftReady) return
    scheduleSave()
  }, [isDraftReady, images, files, pastedTexts, project, scheduleSave])

  const clearDraft = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current)
      draftSaveTimerRef.current = null
    }
    if (currentDraftIdRef.current) {
      deleteNewChatDraft(currentDraftIdRef.current)
    }
    currentDraftIdRef.current = null
    isClearedRef.current = true
    textRef.current = ""
    lastObservedTextRef.current = ""
    imagesRef.current = []
    filesRef.current = []
    pastedTextsRef.current = []
    fileContentsRef.current.clear()
    setActiveDraftId(null)
  }, [fileContentsRef, setActiveDraftId])

  const flushDraftRef = useRef(flushDraft)
  useEffect(() => {
    flushDraftRef.current = flushDraft
  }, [flushDraft])

  useEffect(() => {
    const handlePageHide = () => flushDraftRef.current()
    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pagehide", handlePageHide)
      flushDraftRef.current()
      if (currentDraftIdRef.current) {
        markDraftVisible(currentDraftIdRef.current)
      }
    }
  }, [])

  return { handleContentChange, clearDraft, flushDraft }
}
