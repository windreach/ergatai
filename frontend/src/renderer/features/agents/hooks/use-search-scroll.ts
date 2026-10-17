import { useEffect, useRef } from "react"
import { useAtomValue } from "jotai"
import { chatSearchCurrentMatchAtom } from "../search"

interface UseSearchScrollProps {
  chatContainerRef: React.RefObject<HTMLElement | null>
}

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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          // Check if this scroll operation is still valid (not superseded by newer one)
          if (searchScrollLockRef.current !== currentLock) return

          // First try to find the highlight mark
          let targetElement: Element | null = container.querySelector(".search-highlight-current")

          // If no highlight mark, find the message element with matching data attributes
          if (!targetElement) {
            const selector = `[data-message-id="${currentSearchMatch.messageId}"][data-part-index="${currentSearchMatch.partIndex}"]`
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
        }, 50)
      })
    })
  }, [currentSearchMatch, chatContainerRef])
}
