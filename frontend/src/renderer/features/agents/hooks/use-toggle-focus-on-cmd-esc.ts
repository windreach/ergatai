import { useEffect, type RefObject } from "react"

/**
 * Hook to toggle focus when Cmd+Esc (or Ctrl+Esc) is pressed.
 * - If the editor itself has focus → blur
 * - If the editor does not have focus → focus
 * Does not interfere with stop generation (Esc without modifiers).
 *
 * @param editorRef - Ref to the editor handle (must expose focus, blur, and contains)
 */
export function useToggleFocusOnCmdEsc(
  editorRef: RefObject<{ focus: () => void; blur: () => void; contains: (node: Node) => boolean } | null>,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Cmd+Esc (or Ctrl+Esc on Windows/Linux)
      if (
        e.key !== "Escape" ||
        !(e.metaKey || e.ctrlKey) ||
        e.shiftKey ||
        e.altKey
      ) {
        return
      }

      e.preventDefault()
      // Note: we intentionally do NOT call stopPropagation() here.
      // The shortcut is scoped to the editor focus toggle and should not
      // block other Cmd+Esc handlers that may be registered elsewhere.

      const editor = editorRef.current
      if (!editor) return

      // Check whether focus is inside the editor (not just "any input on the page").
      // This correctly handles the case where an unrelated search box, settings field,
      // or other contenteditable element has focus.
      const activeElement = document.activeElement
      const isEditorFocused =
        activeElement instanceof Node && editor.contains(activeElement)

      if (isEditorFocused) {
        // Blur if the editor itself is focused
        editor.blur()
      } else {
        // Focus if anything else (or nothing) is focused
        editor.focus()
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [editorRef, enabled])
}
