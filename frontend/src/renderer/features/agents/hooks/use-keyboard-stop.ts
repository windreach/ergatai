import { useEffect } from "react"
import { agentChatStore } from "../stores/agent-chat-store"

interface UseKeyboardStopProps {
  isActive: boolean
  isStreaming: boolean
  conversationId: string
  stop: () => Promise<void>
  displayQuestions: any
  handleQuestionsSkip: () => Promise<void>
}

/**
 * Hook to handle keyboard shortcuts for stopping streaming
 * Supports ESC, Ctrl+C, and Cmd+Shift+Backspace
 */
export function useKeyboardStop({
  isActive,
  isStreaming,
  conversationId,
  stop,
  displayQuestions,
  handleQuestionsSkip,
}: UseKeyboardStopProps) {
  useEffect(() => {
    // Skip keyboard handlers for inactive tabs (keep-alive)
    if (!isActive) return

    const handleKeyDown = async (e: KeyboardEvent) => {
      let shouldStop = false
      let shouldSkipQuestions = false

      // Check for Escape key without modifiers (works even from input fields, like terminal Ctrl+C)
      // Ignore if Cmd/Ctrl is pressed (reserved for Cmd+Esc to focus input)
      if (
        e.key === "Escape" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        isStreaming
      ) {
        const target = e.target as HTMLElement

        // Allow ESC to propagate if it originated from a modal/dialog/dropdown
        const isInsideOverlay = target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-state="open"]',
        )

        // Also check if any dialog/modal is open anywhere in the document (not just at event target)
        // This prevents stopping stream when settings dialog is open but not focused
        const hasOpenDialog = document.querySelector(
          '[role="dialog"][aria-modal="true"], [data-modal="agents-settings"]',
        )

        if (!isInsideOverlay && !hasOpenDialog) {
          // If there are pending/expired questions for this chat, skip/dismiss them instead of stopping stream
          if (displayQuestions) {
            shouldSkipQuestions = true
          } else {
            shouldStop = true
          }
        }
      }

      // Check for Ctrl+C (only Ctrl, not Cmd on Mac)
      if (e.ctrlKey && !e.metaKey && e.code === "KeyC") {
        if (!isStreaming) return

        const selection = window.getSelection()
        const hasSelection = selection && selection.toString().length > 0

        // If there's a text selection, let browser handle copy
        if (hasSelection) return

        shouldStop = true
      }

      // Check for Cmd+Shift+Backspace (Mac) or Ctrl+Shift+Backspace (Windows/Linux)
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key === "Backspace" &&
        isStreaming
      ) {
        shouldStop = true
      }

      if (shouldSkipQuestions) {
        e.preventDefault()
        await handleQuestionsSkip()
      } else if (shouldStop) {
        e.preventDefault()
        // Mark as manually aborted to prevent completion sound
        agentChatStore.setManuallyAborted(conversationId, true)
        await stop()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isActive, isStreaming, stop, conversationId, displayQuestions, handleQuestionsSkip])
}
