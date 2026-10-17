import { useCallback, useEffect, useLayoutEffect, useRef } from "react"

interface UseChatAutoScrollOptions {
  /** Messages array — changes trigger auto-scroll while streaming */
  messages: readonly unknown[]
  /** Chat runtime status ("streaming" / "submitted" / "ready") */
  status: string
  /**
   * Whether the pane is currently visible. Scroll handling is suspended for
   * hidden keep-alive panes (CSS-hidden tabs / closed sidebars) and resumes
   * when the pane becomes visible again.
   */
  isActive: boolean
}

interface UseChatAutoScrollResult {
  containerRef: React.RefObject<HTMLDivElement | null>
  contentWrapperRef: React.RefObject<HTMLDivElement | null>
  /** Animated scroll to bottom; re-enables auto-scroll */
  scrollToBottom: () => void
}

const BOTTOM_THRESHOLD_PX = 50
const SCROLL_ANIMATION_MS = 300

/**
 * Chat scroll anchoring ported from the main chat pane (active-chat.tsx):
 *
 * - Scrolling UP disables auto-scroll immediately (user intent wins, even
 *   mid-animation); scrolling back to the bottom re-enables it.
 * - A ResizeObserver on the content wrapper catches every height change
 *   (markdown rendering, syntax highlighting, image loads). While
 *   auto-scroll is on the pane follows the bottom; while the user is
 *   scrolled up their relative position is preserved.
 * - During streaming the pane follows new content only if auto-scroll is on.
 *
 * The main pane additionally restores saved positions across tab switches;
 * side panels remount per conversation and always start at the bottom, so
 * no position cache is kept here.
 */
export function useChatAutoScroll({
  messages,
  status,
  isActive,
}: UseChatAutoScrollOptions): UseChatAutoScrollResult {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentWrapperRef = useRef<HTMLDivElement>(null)

  const shouldAutoScrollRef = useRef(true)
  const isAutoScrollingRef = useRef(false)
  const isInitializingScrollRef = useRef(false)
  const scrollInitializedRef = useRef(false)
  const prevScrollTopRef = useRef(0)

  const isAtBottom = useCallback(() => {
    const container = containerRef.current
    if (!container) return true
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      BOTTOM_THRESHOLD_PX
    )
  }, [])

  // Detect scroll direction; refs only — no re-renders on scroll
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const currentScrollTop = container.scrollTop
    const prevScrollTop = prevScrollTopRef.current
    prevScrollTopRef.current = currentScrollTop

    if (isInitializingScrollRef.current) return

    // User scrolled UP — disable auto-scroll immediately
    if (currentScrollTop < prevScrollTop) {
      shouldAutoScrollRef.current = false
      return
    }

    if (isAutoScrollingRef.current) return

    // User scrolled DOWN — re-enable only when back at the bottom
    shouldAutoScrollRef.current = isAtBottom()
  }, [isAtBottom])

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    isAutoScrollingRef.current = true
    shouldAutoScrollRef.current = true

    const start = container.scrollTop
    const startTime = performance.now()

    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / SCROLL_ANIMATION_MS, 1)
      const easedProgress = easeInOutCubic(progress)

      // Recalculate the target each frame to handle growing content
      const end = container.scrollHeight - container.clientHeight
      container.scrollTop = start + (end - start) * easedProgress

      if (progress < 1) {
        requestAnimationFrame(animateScroll)
      } else {
        container.scrollTop = container.scrollHeight
        isAutoScrollingRef.current = false
      }
    }

    requestAnimationFrame(animateScroll)
  }, [])

  // Initialize scroll position when the pane becomes visible.
  // Side panels remount per conversation (keyed), so mount == new conversation:
  // always start at the bottom with auto-scroll enabled.
  useLayoutEffect(() => {
    if (!isActive) return
    const container = containerRef.current
    if (!container) return

    isInitializingScrollRef.current = true
    container.scrollTop = container.scrollHeight
    prevScrollTopRef.current = container.scrollTop
    shouldAutoScrollRef.current = true
    scrollInitializedRef.current = true
    isInitializingScrollRef.current = false
  }, [isActive])

  // Follow content height changes (markdown, syntax highlighting, images…)
  useLayoutEffect(() => {
    if (!isActive) return
    const container = containerRef.current
    const contentWrapper = contentWrapperRef.current
    if (!container || !contentWrapper) return

    // Expose the container height as a CSS variable (MessageGroup uses it
    // to size the last group's min-height, matching the main chat pane)
    const updateContainerHeightVar = () => {
      container.style.setProperty(
        "--chat-container-height",
        `${container.getBoundingClientRect().height}px`,
      )
    }
    updateContainerHeightVar()

    let lastContentHeight = contentWrapper.getBoundingClientRect().height
    let prevScrollHeight = container.scrollHeight

    const resizeObserver = new ResizeObserver(() => {
      updateContainerHeightVar()

      const newContentHeight = contentWrapper.getBoundingClientRect().height
      if (newContentHeight === lastContentHeight) return
      lastContentHeight = newContentHeight

      if (shouldAutoScrollRef.current) {
        requestAnimationFrame(() => {
          isAutoScrollingRef.current = true
          container.scrollTop = container.scrollHeight
          requestAnimationFrame(() => {
            isAutoScrollingRef.current = false
          })
        })
      } else {
        // Keep the user's relative position as content above the viewport grows
        const newScrollHeight = container.scrollHeight
        if (newScrollHeight !== prevScrollHeight && prevScrollHeight > 0) {
          const delta = newScrollHeight - prevScrollHeight
          container.scrollTop = container.scrollTop + delta
        }
      }
      prevScrollHeight = container.scrollHeight
    })

    resizeObserver.observe(contentWrapper)
    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [isActive])

  // Scroll direction detection
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener("scroll", handleScroll, { passive: true })
    return () => container.removeEventListener("scroll", handleScroll)
  }, [handleScroll])

  // Follow streamed content while auto-scroll is enabled
  useEffect(() => {
    if (!isActive) return
    if (!scrollInitializedRef.current) return
    if (!shouldAutoScrollRef.current) return
    if (status !== "streaming" && status !== "submitted") return

    const container = containerRef.current
    if (!container) return
    requestAnimationFrame(() => {
      isAutoScrollingRef.current = true
      container.scrollTop = container.scrollHeight
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false
      })
    })
  }, [isActive, messages, status])

  return { containerRef, contentWrapperRef, scrollToBottom }
}
