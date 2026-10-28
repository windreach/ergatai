import { useEffect } from "react"
import type { AgentsMentionsEditorHandle } from "../mentions"

interface UseScrollToBottomShortcutProps {
  isActive: boolean
  scrollToBottom: () => void
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>
}

/**
 * Hook to handle Cmd/Ctrl + Arrow Down shortcut to scroll to bottom
 * Only triggers when input is empty (allows native cursor navigation when input has content)
 */
export function useScrollToBottomShortcut({
  isActive,
  scrollToBottom,
  editorRef,
}: UseScrollToBottomShortcutProps) {
  useEffect(() => {
    if (!isActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "ArrowDown" &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        // Only trigger when editor or a contenteditable element is focused
        // This prevents interference with other focused elements (inputs, modals, etc.)
        const activeElement = document.activeElement
        const isEditorFocused =
          activeElement &&
          (activeElement.getAttribute("contenteditable") === "true" ||
            activeElement.tagName === "TEXTAREA" ||
            activeElement.tagName === "INPUT")

        if (!isEditorFocused) {
          return
        }

        // Don't intercept if input has content - let native cursor navigation work
        const inputValue = editorRef.current?.getValue() || ""
        if (inputValue.trim().length > 0) {
          return
        }

        e.preventDefault()
        scrollToBottom()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isActive, scrollToBottom, editorRef])
}
