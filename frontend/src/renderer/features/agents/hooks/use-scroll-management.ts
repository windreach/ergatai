import { useEffect, useRef, useCallback } from "react"

// Threshold in pixels for "at bottom" detection
const AUTO_SCROLL_THRESHOLD = 50

// Max entries in scroll position cache (LRU eviction)
const MAX_SCROLL_CACHE_SIZE = 50

// Module-level scroll position cache (per conversationId, session-only)
// Stores { scrollTop, scrollHeight, wasAtBottom } so we can restore position on tab switch
// Uses LRU eviction to prevent unbounded memory growth in long-running sessions
export const scrollPositionCache = new Map<
  string,
  { scrollTop: number; scrollHeight: number; wasAtBottom: boolean }
>()

// Helper to enforce LRU eviction on the scroll position cache
function setScrollPositionCacheEntry(
  key: string,
  value: { scrollTop: number; scrollHeight: number; wasAtBottom: boolean },
) {
  // If key already exists, delete it first so it becomes the most recent
  if (scrollPositionCache.has(key)) {
    scrollPositionCache.delete(key)
  }
  // Evict oldest entry if at capacity
  if (scrollPositionCache.size >= MAX_SCROLL_CACHE_SIZE) {
    const oldestKey = scrollPositionCache.keys().next().value
    if (oldestKey !== undefined) {
      scrollPositionCache.delete(oldestKey)
    }
  }
  scrollPositionCache.set(key, value)
}

// Export function to get saved scroll position
export function getSavedScrollPosition(conversationId: string) {
  return scrollPositionCache.get(conversationId)
}

interface UseScrollManagementOptions {
  conversationId: string
  isVisiblePane: boolean
  isVisiblePaneRef: React.RefObject<boolean>
}

export function useScrollManagement({
  conversationId,
  isVisiblePane,
  isVisiblePaneRef,
}: UseScrollManagementOptions) {
  // Scroll management state (like canvas chat)
  // Using only ref to avoid re-renders on scroll
  const shouldAutoScrollRef = useRef(true)
  const isAutoScrollingRef = useRef(false) // Flag to ignore scroll events caused by auto-scroll
  const isInitializingScrollRef = useRef(false) // Flag to ignore scroll events during scroll initialization (content loading)
  const scrollInitializedRef = useRef(false) // Track whether initial scroll setup has run for this pane
  const hasUnapprovedPlanRef = useRef(false) // Track unapproved plan state for scroll initialization
  const chatContainerRef = useRef<HTMLElement | null>(null)
  const animationFrameRef = useRef<number | null>(null) // Track animation frame ID for cancellation

  // Cleanup isAutoScrollingRef on unmount to prevent stuck state
  useEffect(() => {
    return () => {
      isAutoScrollingRef.current = false
      // Cancel any pending animation frame on cleanup
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [])

  const saveScrollPosition = useCallback(() => {
    // Skip cache writes for panes that never completed initial scroll setup.
    // Hidden keep-alive panes can otherwise persist default top-position values.
    if (!scrollInitializedRef.current) return

    const container = chatContainerRef.current
    if (!container) return

    const wasAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <= AUTO_SCROLL_THRESHOLD
    setScrollPositionCacheEntry(conversationId, {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      wasAtBottom,
    })
  }, [conversationId])

  // Save scroll position when tab becomes inactive or on unmount
  useEffect(() => {
    if (!isVisiblePane) {
      saveScrollPosition()
    }
    return () => {
      saveScrollPosition()
    }
  }, [isVisiblePane, saveScrollPosition])

  // Track chat container height via CSS custom property (no re-renders)
  const chatContainerObserverRef = useRef<ResizeObserver | null>(null)

  // Ref for the inner content wrapper (for ResizeObserver-based scroll-to-bottom)
  const contentWrapperRef = useRef<HTMLDivElement | null>(null)

  // Check if user is at bottom of chat (like canvas)
  const isAtBottom = useCallback(() => {
    const container = chatContainerRef.current
    if (!container) return true
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      AUTO_SCROLL_THRESHOLD
    )
  }, [])

  // Track previous scroll position to detect scroll direction
  const prevScrollTopRef = useRef(0)

  // Handle scroll events to detect user scrolling
  // Updates shouldAutoScrollRef based on scroll direction
  // Using refs only to avoid re-renders on scroll
  const handleScroll = useCallback(() => {
    // Skip scroll handling for inactive tabs (keep-alive)
    if (!isVisiblePaneRef.current) return

    const container = chatContainerRef.current
    if (!container) return

    const currentScrollTop = container.scrollTop

    // Ignore scroll events during initialization (content loading)
    if (isInitializingScrollRef.current) {
      prevScrollTopRef.current = currentScrollTop
      return
    }

    // Ignore programmatic scroll events during auto-scroll animation
    // CRITICAL: Check this BEFORE updating prevScrollTopRef to prevent
    // programmatic scrolls from corrupting the baseline for direction detection
    if (isAutoScrollingRef.current) {
      prevScrollTopRef.current = currentScrollTop
      return
    }

    const prevScrollTop = prevScrollTopRef.current
    prevScrollTopRef.current = currentScrollTop

    // If user scrolls UP - disable auto-scroll immediately
    // This works even during auto-scroll animation (user intent takes priority)
    if (currentScrollTop < prevScrollTop) {
      shouldAutoScrollRef.current = false
      return
    }

    // If user scrolls DOWN and reaches bottom - enable auto-scroll
    shouldAutoScrollRef.current = isAtBottom()
  }, [isAtBottom, isVisiblePaneRef])

  // Scroll to bottom handler with ease-in-out animation
  const scrollToBottom = useCallback(() => {
    const container = chatContainerRef.current
    if (!container) return

    // Cancel any previous animation to prevent concurrent animations
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
    }

    isAutoScrollingRef.current = true
    shouldAutoScrollRef.current = true

    const start = container.scrollTop
    const duration = 300 // ms
    const startTime = performance.now()

    // Ease-in-out cubic function
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)
      const easedProgress = easeInOutCubic(progress)

      // Calculate end on each frame to handle dynamic content
      const end = container.scrollHeight - container.clientHeight
      container.scrollTop = start + (end - start) * easedProgress

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animateScroll)
      } else {
        // Ensure we're at the absolute bottom
        container.scrollTop = container.scrollHeight
        isAutoScrollingRef.current = false
        animationFrameRef.current = null
      }
    }

    animationFrameRef.current = requestAnimationFrame(animateScroll)
  }, [])

  return {
    shouldAutoScrollRef,
    isAutoScrollingRef,
    isInitializingScrollRef,
    scrollInitializedRef,
    hasUnapprovedPlanRef,
    chatContainerRef,
    chatContainerObserverRef,
    contentWrapperRef,
    prevScrollTopRef,
    saveScrollPosition,
    isAtBottom,
    handleScroll,
    scrollToBottom,
  }
}
