import { useEffect, useState, useCallback, useRef } from "react"
import {
  type SelectedTextContext,
  type DiffTextContext,
  createTextPreview,
} from "../lib/queue-utils"
import { createLocalId } from "../../../../shared/id"

/**
 * Generate a unique local ID for context selections.
 */
function generateUniqueId(prefix: string): string {
  return createLocalId(prefix)
}

export interface UseTextContextSelectionReturn {
  textContexts: SelectedTextContext[]
  diffTextContexts: DiffTextContext[]
  addTextContext: (text: string, sourceMessageId: string) => void
  addDiffTextContext: (text: string, filePath: string, lineNumber?: number, lineType?: "old" | "new") => void
  removeTextContext: (id: string) => void
  removeDiffTextContext: (id: string) => void
  clearTextContexts: () => void
  clearDiffTextContexts: () => void
  // Ref for accessing current value in callbacks without re-renders
  textContextsRef: React.RefObject<SelectedTextContext[]>
  diffTextContextsRef: React.RefObject<DiffTextContext[]>
  // Direct state setter for restoring from draft
  setTextContextsFromDraft: (contexts: SelectedTextContext[]) => void
  setDiffTextContextsFromDraft: (contexts: DiffTextContext[]) => void
}

export function useTextContextSelection(): UseTextContextSelectionReturn {
  const [textContexts, setTextContexts] = useState<SelectedTextContext[]>([])
  const [diffTextContexts, setDiffTextContexts] = useState<DiffTextContext[]>([])
  const textContextsRef = useRef<SelectedTextContext[]>([])
  const diffTextContextsRef = useRef<DiffTextContext[]>([])

  // Keep refs in sync with state
  // react-doctor-disable-next-line no-ref-current-in-render
  textContextsRef.current = textContexts
  // react-doctor-disable-next-line no-ref-current-in-render
  diffTextContextsRef.current = diffTextContexts

  const addTextContext = useCallback(
    (text: string, sourceMessageId: string) => {
      const trimmedText = text.trim()
      if (!trimmedText) return

      // Perform duplicate check against the latest ref value so we always see
      // pending state, even across synchronous calls, without impure updater side effects.
      const current = textContextsRef.current
      const isDuplicate = current.some(
        (ctx) => ctx.text === trimmedText && ctx.sourceMessageId === sourceMessageId,
      )
      if (isDuplicate) return

      const newContext: SelectedTextContext = {
        id: generateUniqueId("tc"),
        text: trimmedText,
        sourceMessageId,
        preview: createTextPreview(trimmedText),
        createdAt: new Date(),
      }

      const next = [...current, newContext]
      textContextsRef.current = next
      setTextContexts(next)
    },
    []
  )

  const addDiffTextContext = useCallback(
    (text: string, filePath: string, lineNumber?: number, lineType?: "old" | "new") => {
      const trimmedText = text.trim()
      if (!trimmedText) return

      // Perform duplicate check AND state update inside the updater function.
      // Include lineNumber and lineType in uniqueness check so the same text
      // from different locations in the same file can be selected independently.
      const currentDiff = diffTextContextsRef.current
      const isDuplicate = currentDiff.some(
        (ctx) =>
          ctx.text === trimmedText &&
          ctx.filePath === filePath &&
          ctx.lineNumber === lineNumber &&
          ctx.lineType === lineType,
      )
      if (isDuplicate) return

      const newContext: DiffTextContext = {
        id: generateUniqueId("dtc"),
        text: trimmedText,
        filePath,
        lineNumber,
        lineType,
        preview: createTextPreview(trimmedText),
        createdAt: new Date(),
      }

      const next = [...currentDiff, newContext]
      diffTextContextsRef.current = next
      setDiffTextContexts(next)
    },
    []
  )

  const removeTextContext = useCallback((id: string) => {
    setTextContexts((prev) => prev.filter((ctx) => ctx.id !== id))
  }, [])

  const removeDiffTextContext = useCallback((id: string) => {
    setDiffTextContexts((prev) => prev.filter((ctx) => ctx.id !== id))
  }, [])

  const clearTextContexts = useCallback(() => {
    setTextContexts([])
  }, [])

  const clearDiffTextContexts = useCallback(() => {
    setDiffTextContexts([])
  }, [])

  // Direct state setter for restoring from draft
  const setTextContextsFromDraft = useCallback(
    (contexts: SelectedTextContext[]) => {
      setTextContexts(contexts)
      textContextsRef.current = contexts
    },
    []
  )

  const setDiffTextContextsFromDraft = useCallback(
    (contexts: DiffTextContext[]) => {
      setDiffTextContexts(contexts)
      diffTextContextsRef.current = contexts
    },
    []
  )

  return {
    textContexts,
    diffTextContexts,
    addTextContext,
    addDiffTextContext,
    removeTextContext,
    removeDiffTextContext,
    clearTextContexts,
    clearDiffTextContexts,
    textContextsRef,
    diffTextContextsRef,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
  }
}
