import { useEffect, useRef } from "react"
import { useAtomValue } from "jotai"
import { chatSearchCurrentMatchAtom } from "../search"

interface UseSearchScrollProps {
  chatContainerRef: React.RefObject<HTMLElement | null>
}

// Delay to wait for DOM highlight updates before scrolling
// This heuristic ensures highlights are rendered before attempting to scroll
const SCROLL_HIGHLIGHT_SETTLE_DELAY_MS = 50

/**
 * Hook to handle scrolling to search matches in the chat
 */
export function useSearchScroll({ chatContainerRef }: UseSearchScrollProps) {
  const searchScrollLockRef = useRef<number>(0)
  const currentSearchMatch = useAtomValue(chatSearchCurrentMatchAtom)

  useEffect(() => {
    if (!currentSearchMatch) return

    const container = chatContainerRef.current
    if (!container) return

    // Increment lock to cancel any pending scroll operations
    const currentLock = ++searchScrollLockRef.current

    // Use double requestAnimationFrame + small delay to ensure DOM has updated with new highlights
    let rafId1: number | undefined
    let rafId2: number | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    rafId1 = requestAnimationFrame(() => {
      rafId2 = requestAnimationFrame(() => {
        timeoutId = setTimeout(() => {
          // Check if this scroll operation is still valid (not superseded by newer one)
          if (searchScrollLockRef.current !== currentLock) return

          // First try to find the highlight mark
          let targetElement: Element | null = container.querySelector(".search-highlight-current")

          // If no highlight mark, find the message element with matching data attributes
          if (!targetElement) {
            const escapedMessageId = CSS.escape(currentSearchMatch.messageId)
            const selector = `[data-message-id="${escapedMessageId}"][data-part-index="${currentSearchMatch.partIndex}"]`
            targetElement = container.querySelector(selector)
          }

          if (targetElement) {
            // Check if this is inside a sticky user message container
            const stickyParent = targetElement.closest("[data-user-message-id]")
            if (stickyParent) {
              const messageGroupWrapper = stickyParent.parentElement
              if (messageGroupWrapper) {
                messageGroupWrapper.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                })
                return
              }
            }

            targetElement.scrollIntoView({
              behavior: "smooth",
              block: "center",
            })
          }
        }, SCROLL_HIGHLIGHT_SETTLE_DELAY_MS)
      })
    })

    // Cleanup: cancel any pending animation frames and timeouts
    return () => {
      if (rafId1 !== undefined) cancelAnimationFrame(rafId1)
      if (rafId2 !== undefined) cancelAnimationFrame(rafId2)
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }, [currentSearchMatch, chatContainerRef])
}
