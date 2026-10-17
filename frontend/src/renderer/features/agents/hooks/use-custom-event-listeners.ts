import { useEffect } from "react"
import type { TextSelectionSource } from "../context/text-selection-context"
import type { AgentsMentionsEditorHandle } from "../mentions"

interface UseCustomEventListenersProps {
  isActive: boolean
  addTextContext: (text: string, source: TextSelectionSource) => void
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>
}

/**
 * Hook to handle custom event listeners for file-viewer and file-tree interactions
 */
export function useCustomEventListeners({
  isActive,
  addTextContext,
  editorRef,
}: UseCustomEventListenersProps) {
  // Listen for file-viewer "Add to Context" from the custom context menu
  useEffect(() => {
    if (!isActive) return

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        text: string
        source: TextSelectionSource
      }
      if (detail.text && detail.source) {
        addTextContext(detail.text, detail.source)
        editorRef.current?.focus()
      }
    }
    window.addEventListener("file-viewer-add-to-context", handler)
    return () => window.removeEventListener("file-viewer-add-to-context", handler)
  }, [addTextContext, isActive, editorRef])

  // Listen for file-tree "Add to Chat Context" — inserts file mention chip
  useEffect(() => {
    if (!isActive) return

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        id: string
        label: string
        path: string
        repository: string
        type: string
      }
      if (detail.id && detail.label) {
        editorRef.current?.insertMention({
          id: detail.id,
          label: detail.label,
          path: detail.path,
          repository: detail.repository,
          type: detail.type as "file" | "folder",
        })
        editorRef.current?.focus()
      }
    }
    window.addEventListener("file-tree-mention", handler)
    return () => window.removeEventListener("file-tree-mention", handler)
  }, [isActive, editorRef])
}
