import { useLayoutEffect, useEffect, useRef } from "react"
import { useMessageQueueStore } from "../stores/message-queue-store"
import { appStore } from "../../../lib/jotai-store"
import { suppressInputFocusAtom } from "../atoms"
import { getSavedScrollPosition } from "./use-scroll-management"
import type { Message } from "../stores/message-store"

interface UseScrollInitProps {
  conversationId: string
  isVisiblePane: boolean
  isActive: boolean
  isMobile: boolean
  chatContainerRef: React.RefObject<HTMLElement | null>
  contentWrapperRef: React.RefObject<HTMLElement | null>
  shouldAutoScrollRef: React.MutableRefObject<boolean>
  isAutoScrollingRef: React.MutableRefObject<boolean>
  isInitializingScrollRef: React.MutableRefObject<boolean>
  scrollInitializedRef: React.MutableRefObject<boolean>
  prevScrollTopRef: React.MutableRefObject<number>
  scrollToBottom: () => void
  handleScroll: (e: Event) => void
  status: "ready" | "streaming" | "submitted" | "error"
  messages: Message[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO: replace with specific editor type
  editorRef: React.RefObject<any>
}

/**
 * Hook to manage scroll initialization, auto-scroll during streaming,
 * and scroll position restoration when switching conversations
 */
export function useScrollInit({
  conversationId,
  isVisiblePane,
  isActive,
  isMobile,
  chatContainerRef,
  contentWrapperRef,
  shouldAutoScrollRef,
  isAutoScrollingRef,
  isInitializingScrollRef,
  scrollInitializedRef,
  prevScrollTopRef,
  scrollToBottom,
  handleScroll,
  status,
  messages,
  editorRef,
}: UseScrollInitProps) {
  // Keep isActive in ref for use in callbacks (avoid stale closures)
  const isVisiblePaneRef = useRef(isVisiblePane)
  isVisiblePaneRef.current = isVisiblePane

  // Helper function to perform auto-scroll to bottom with proper flag management
  // Used by both ResizeObserver and streaming useEffect to avoid duplication
  const performAutoScrollToBottom = (container: HTMLElement) => {
    requestAnimationFrame(() => {
      isAutoScrollingRef.current = true
      container.scrollTop = container.scrollHeight
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false
      })
    })
  }

  // Initialize scroll position on mount or tab re-activation.
  // Strategy: restore saved position if user was scrolled up, otherwise scroll to bottom.
  // Uses ResizeObserver on content wrapper to catch ALL height changes (markdown rendering,
  // syntax highlighting, image loading, content-visibility reflows) — not just childList mutations.
  useLayoutEffect(() => {
    // Skip if not active (keep-alive: hidden tabs don't need scroll init)
    if (!isVisiblePane) return

    const container = chatContainerRef.current
    if (!container) return

    scrollInitializedRef.current = false
    isInitializingScrollRef.current = true

    // Check for saved scroll position from tab switch
    const savedPosition = getSavedScrollPosition(conversationId)

    if (savedPosition && !savedPosition.wasAtBottom) {
      // User was scrolled up — restore their position relative to content bottom.
      // Content may have changed height since we saved, so we offset from the bottom:
      const savedOffset = savedPosition.scrollHeight - savedPosition.scrollTop
      container.scrollTop = Math.max(0, container.scrollHeight - savedOffset)
      shouldAutoScrollRef.current = false
    } else {
      // No saved position or user was at bottom — scroll to bottom
      container.scrollTop = container.scrollHeight
      shouldAutoScrollRef.current = true
    }

    // Mark as initialized IMMEDIATELY
    scrollInitializedRef.current = true

    // Defer reset of isInitializingScrollRef so that scroll events dispatched
    // asynchronously from the programmatic scrollTop assignment above are still
    // suppressed. Without this, the guard is true→false synchronously in the
    // same task and scroll handlers never observe it as true.
    requestAnimationFrame(() => {
      isInitializingScrollRef.current = false
    })

    // ResizeObserver on content wrapper to detect any height change
    // (markdown rendering, syntax highlighting, image loads, content-visibility reflows, etc.)
    // This is more reliable than MutationObserver which only catches childList changes.
    const contentWrapper = contentWrapperRef.current
    let lastContentHeight = contentWrapper?.getBoundingClientRect().height ?? 0
    // Track the previous scrollHeight so we can adjust restored positions proportionally
    let prevScrollHeight = container.scrollHeight

    const resizeObserver = new ResizeObserver(() => {
      // Skip if not active (keep-alive: don't scroll hidden tabs)
      if (!isVisiblePaneRef.current) return

      const newContentHeight = contentWrapper?.getBoundingClientRect().height ?? 0
      if (newContentHeight === lastContentHeight) return
      lastContentHeight = newContentHeight

      if (shouldAutoScrollRef.current) {
        // Auto-scroll to bottom as content grows
        performAutoScrollToBottom(container)
      } else {
        // User is scrolled up — maintain their relative position as content height changes
        // (e.g., syntax highlighting expanding code blocks above the viewport)
        const newScrollHeight = container.scrollHeight
        if (newScrollHeight !== prevScrollHeight && prevScrollHeight > 0) {
          const delta = newScrollHeight - prevScrollHeight
          container.scrollTop = container.scrollTop + delta
        }
      }
      prevScrollHeight = container.scrollHeight
    })

    if (contentWrapper) {
      resizeObserver.observe(contentWrapper)
    }

    return () => {
      resizeObserver.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, isVisiblePane])

  // Attach scroll listener (separate effect)
  useEffect(() => {
    const container = chatContainerRef.current
    if (!container) return

    // Initialize prevScrollTopRef from the container's actual scrollTop so that
    // the first scroll event doesn't compare against a stale 0 value. This is
    // important when scroll position is restored from cache to a non-zero value.
    prevScrollTopRef.current = container.scrollTop

    container.addEventListener("scroll", handleScroll, { passive: true })
    return () => {
      container.removeEventListener("scroll", handleScroll)
    }
  }, [handleScroll, chatContainerRef, prevScrollTopRef])

  // Auto scroll to bottom when messages change during streaming
  // Only kicks in after content fills the viewport (overflow behavior)
  useEffect(() => {
    // Skip if not active (keep-alive: don't scroll hidden tabs)
    if (!isVisiblePane) return
    // Skip if scroll not yet initialized
    if (!scrollInitializedRef.current) return

    // Auto-scroll during streaming if user hasn't scrolled up
    if (shouldAutoScrollRef.current && status === "streaming") {
      const container = chatContainerRef.current
      if (container) {
        // Always scroll during streaming if auto-scroll is enabled
        // (user can disable by scrolling up)
        performAutoScrollToBottom(container)
      }
    }
  }, [isVisiblePane, messages, status, conversationId, chatContainerRef, shouldAutoScrollRef, isAutoScrollingRef, scrollInitializedRef])

  // Scroll to bottom when QueueProcessor auto-sends a queued message.
  // QueueProcessor runs globally and can't access scroll refs, so it
  // signals via a store trigger that we subscribe to here.
  useEffect(() => {
    const unsub = useMessageQueueStore.subscribe(
      (state) => state.queueSentTriggers[conversationId] || 0,
      (trigger) => {
        if (trigger === 0) return
        if (!isVisiblePaneRef.current) return
        shouldAutoScrollRef.current = true
        scrollToBottom()
      },
    )
    return unsub
  }, [conversationId, scrollToBottom])

  // Auto-focus input when switching to this chat (any conversation change)
  // Skip on mobile to prevent keyboard from opening automatically
  useEffect(() => {
    // Skip if not active (keep-alive: don't focus hidden tabs)
    if (!isActive) return
    if (isMobile) return // Don't autofocus on mobile

    // Use requestAnimationFrame to ensure DOM is ready after render
    requestAnimationFrame(() => {
      // Skip if sidebar keyboard navigation is active (user is arrowing through sidebar items)
      if (appStore.get(suppressInputFocusAtom)) {
        appStore.set(suppressInputFocusAtom, false)
        return
      }
      editorRef.current?.focus()
    })
  }, [isActive, conversationId, isMobile, editorRef])

  return {
    isVisiblePaneRef,
  }
}
