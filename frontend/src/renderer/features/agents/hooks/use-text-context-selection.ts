import { useState, useCallback, useRef } from "react"
import {
  type SelectedTextContext,
  type DiffTextContext,
  createTextPreview,
} from "../lib/queue-utils"

/**
 * Generate a unique ID using crypto.randomUUID() when available,
 * falling back to Date.now() + random for older browsers.
 */
function generateUniqueId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`
  }
  // Fallback: timestamp + random suffix
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
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
  textContextsRef.current = textContexts
  diffTextContextsRef.current = diffTextContexts

  const addTextContext = useCallback(
    (text: string, sourceMessageId: string) => {
      const trimmedText = text.trim()
      if (!trimmedText) return

      // Perform duplicate check AND state update inside the updater function
      // so we always see the latest pending state, even across synchronous calls.
      setTextContexts((prev) => {
        const isDuplicate = prev.some(
          (ctx) =>
            ctx.text === trimmedText && ctx.sourceMessageId === sourceMessageId
        )
        if (isDuplicate) return prev

        const newContext: SelectedTextContext = {
          id: generateUniqueId("tc"),
          text: trimmedText,
          sourceMessageId,
          preview: createTextPreview(trimmedText),
          createdAt: new Date(),
        }

        // Keep ref in sync so subsequent calls in the same batch see the addition
        textContextsRef.current = [...prev, newContext]
        return textContextsRef.current
      })
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
      setDiffTextContexts((prev) => {
        const isDuplicate = prev.some(
          (ctx) =>
            ctx.text === trimmedText &&
            ctx.filePath === filePath &&
            ctx.lineNumber === lineNumber &&
            ctx.lineType === lineType
        )
        if (isDuplicate) return prev

        const newContext: DiffTextContext = {
          id: generateUniqueId("dtc"),
          text: trimmedText,
          filePath,
          lineNumber,
          lineType,
          preview: createTextPreview(trimmedText),
          createdAt: new Date(),
        }

        // Keep ref in sync so subsequent calls in the same batch see the addition
        diffTextContextsRef.current = [...prev, newContext]
        return diffTextContextsRef.current
      })
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
