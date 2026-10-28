import { useEffect, useCallback, useRef } from "react"
import { isDesktopApp } from "../../../lib/utils/platform"
import { useAgentConversationStore } from "../stores/conversation-store"
import type { UndoItem } from "../atoms"

interface UseConversationShortcutsProps {
  chatId: string
  setUndoStack: React.Dispatch<React.SetStateAction<UndoItem[]>>
  selectedConversationIds: Set<string>
  isConversationMultiSelectMode: boolean
  clearConversationSelection: () => void
}

/**
 * Hook to manage keyboard shortcuts for conversation tabs:
 * - Cmd+W / Opt+Cmd+W: Close active conversation (or bulk close in multi-select mode)
 * - Cmd+[ / Cmd+]: Navigate between open conversation tabs
 */
export function useConversationShortcuts({
  chatId,
  setUndoStack,
  selectedConversationIds,
  isConversationMultiSelectMode,
  clearConversationSelection,
}: UseConversationShortcutsProps) {

  // Ref to track timeout IDs for cleanup on unmount
  const timeoutIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Ref to hold selectedConversationIds to prevent frequent listener re-attachment
  const selectedConversationIdsRef = useRef(selectedConversationIds)
  selectedConversationIdsRef.current = selectedConversationIds

  // Helper to add conversation to undo stack
  const addConversationToUndoStack = useCallback((conversationId: string) => {
    const timeoutId = setTimeout(() => {
      setUndoStack((prev) => prev.filter(
        (item) => !(item.type === "conversation" && item.conversationId === conversationId)
      ))
      // Remove from tracked set after timeout fires
      timeoutIdsRef.current.delete(timeoutId)
    }, 10000)

    // Track this timeout for cleanup
    timeoutIdsRef.current.add(timeoutId)

    setUndoStack((prev) => [...prev, {
      type: "conversation",
      conversationId,
      chatId,
      timeoutId,
    }])
  }, [chatId, setUndoStack])

  // Cleanup all pending timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutIdsRef.current.forEach((id) => clearTimeout(id))
      timeoutIdsRef.current.clear()
    }
  }, [])

  // Helper to navigate between conversations
  const navigate = useCallback((delta: -1 | 1) => {
    const store = useAgentConversationStore.getState()
    const activeId = store.activeConversationId
    const openIds = store.openConversationIds

    // Only navigate if we have multiple tabs
    if (openIds.length <= 1) return

    // If no active tab, select first one
    if (!activeId) {
      store.setActiveConversation(openIds[0])
      return
    }

    // Find current index
    const currentIndex = openIds.indexOf(activeId)

    if (currentIndex === -1) {
      // Current tab not found, select first
      store.setActiveConversation(openIds[0])
      return
    }

    // Calculate next index with wrapping
    const nextIndex = (currentIndex + delta + openIds.length) % openIds.length
    const nextId = openIds[nextIndex]

    if (nextId) {
      store.setActiveConversation(nextId)
    }
  }, [])

  // Keyboard shortcut: Close active conversation (or bulk close if multi-select mode)
  // Web: Opt+Cmd+W (browser uses Cmd+W to close tab)
  // Desktop: Cmd+W
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isDesktop = isDesktopApp()

      // Desktop: Cmd+W (without Alt)
      const isDesktopShortcut =
        isDesktop &&
        e.metaKey &&
        e.code === "KeyW" &&
        !e.altKey &&
        !e.shiftKey &&
        !e.ctrlKey
      // Web: Opt+Cmd+W (with Alt)
      const isWebShortcut = e.altKey && e.metaKey && e.code === "KeyW"

      if (isDesktopShortcut || isWebShortcut) {
        e.preventDefault()

        const store = useAgentConversationStore.getState()
        const currentSelectedIds = selectedConversationIdsRef.current

        // If multi-select mode, bulk close selected conversations
        if (isConversationMultiSelectMode && currentSelectedIds.size > 0) {
          const idsToClose = Array.from(currentSelectedIds)
          const remainingOpenIds = store.openConversationIds.filter(
            (id) => !idsToClose.includes(id),
          )

          // Don't close all tabs via hotkey - user should use sidebar dialog for last tab
          if (remainingOpenIds.length > 0) {
            idsToClose.forEach((id) => {
              store.removeFromOpenConversations(id)
              addConversationToUndoStack(id)
            })
          }
          clearConversationSelection()
          return
        }

        // Otherwise close active conversation
        const activeId = store.activeConversationId
        const openIds = store.openConversationIds

        // Only close if we have more than one tab open and there's an active tab
        // removeFromOpenConversations automatically switches to the last remaining tab
        if (activeId && openIds.length > 1) {
          store.removeFromOpenConversations(activeId)
          addConversationToUndoStack(activeId)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isConversationMultiSelectMode, clearConversationSelection, addConversationToUndoStack])

  // Keyboard shortcut: Navigate between conversations
  // Web: Opt+Cmd+[ and Opt+Cmd+] (browser uses Cmd+[ for back)
  // Desktop: Cmd+[ and Cmd+]
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isDesktop = isDesktopApp()

      // Check for previous conversation shortcut ([ key)
      const isPrevDesktop =
        isDesktop &&
        e.metaKey &&
        e.code === "BracketLeft" &&
        !e.altKey &&
        !e.shiftKey &&
        !e.ctrlKey
      const isPrevWeb = e.altKey && e.metaKey && e.code === "BracketLeft"

      if (isPrevDesktop || isPrevWeb) {
        e.preventDefault()
        navigate(-1)
      }

      // Check for next conversation shortcut (] key)
      const isNextDesktop =
        isDesktop &&
        e.metaKey &&
        e.code === "BracketRight" &&
        !e.altKey &&
        !e.shiftKey &&
        !e.ctrlKey
      const isNextWeb = e.altKey && e.metaKey && e.code === "BracketRight"

      if (isNextDesktop || isNextWeb) {
        e.preventDefault()
        navigate(1)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [navigate])
}
