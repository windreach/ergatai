import { useEffect } from "react"

interface UseScrollToBottomShortcutProps {
  isActive: boolean
  scrollToBottom: () => void
  editorRef: React.RefObject<any>
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
