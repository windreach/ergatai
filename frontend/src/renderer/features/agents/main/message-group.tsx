import { useEffect, useRef } from "react"

interface MessageGroupProps {
  children: React.ReactNode
  isLastGroup?: boolean
}

/**
 * Measures the user message height for sticky todo positioning and optimizes
 * offscreen groups. The last group stays fully laid out while it streams.
 */
export function MessageGroup({ children, isLastGroup }: MessageGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const groupEl = groupRef.current
    if (!groupEl) return

    let observer: ResizeObserver | null = null
    let currentBubbleEl: HTMLDivElement | null = null

    const setupResizeObserver = () => {
      // Disconnect previous observer if any
      if (observer) {
        observer.disconnect()
        observer = null
      }

      // Find the actual bubble element (not the wrapper which includes gradient)
      const bubbleEl = groupEl.querySelector(
        "[data-user-bubble]"
      ) as HTMLDivElement | null

      if (!bubbleEl) {
        if (process.env.NODE_ENV === "development") {
          console.warn(
            "MessageGroup: no [data-user-bubble] element found in children. Sticky todo positioning will not work."
          )
        }
        return
      }

      currentBubbleEl = bubbleEl

      const updateHeight = () => {
        groupEl.style.setProperty(
          "--user-message-height",
          `${bubbleEl.offsetHeight}px`
        )
      }

      updateHeight()

      observer = new ResizeObserver(updateHeight)
      observer.observe(bubbleEl)
    }

    // Initial setup
    setupResizeObserver()

    // Watch for DOM changes to re-discover bubble element
    const mutationObserver = new MutationObserver(() => {
      const newBubbleEl = groupEl.querySelector(
        "[data-user-bubble]"
      ) as HTMLDivElement | null
      if (newBubbleEl !== currentBubbleEl) {
        setupResizeObserver()
      }
    })

    mutationObserver.observe(groupEl, {
      childList: true,
      subtree: true,
    })

    return () => {
      if (observer) {
        observer.disconnect()
      }
      mutationObserver.disconnect()
    }
  }, [])

  return (
    <div
      ref={groupRef}
      className={
        isLastGroup
          ? "relative min-h-[calc(var(--chat-container-height)-32px)]"
          : "relative [content-visibility:auto] [contain-intrinsic-size:auto_200px]"
      }
      data-last-group={isLastGroup || undefined}
    >
      {children}
    </div>
  )
}
