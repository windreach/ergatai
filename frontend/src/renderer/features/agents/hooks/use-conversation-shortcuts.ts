import { useEffect, useCallback } from "react"
import { isDesktopApp } from "../../../lib/utils/platform"
import { useAgentConversationStore } from "../stores/conversation-store"

interface UseConversationShortcutsProps {
  chatId: string
  setUndoStack: React.Dispatch<React.SetStateAction<any[]>>
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

  // Helper to add conversation to undo stack
  const addConversationToUndoStack = useCallback((conversationId: string) => {
    const timeoutId = setTimeout(() => {
      setUndoStack((prev) => prev.filter(
        (item) => !(item.type === "conversation" && item.conversationId === conversationId)
      ))
    }, 10000)

    setUndoStack((prev) => [...prev, {
      type: "conversation",
      conversationId,
      chatId,
      timeoutId,
    }])
  }, [chatId, setUndoStack])

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

        // If multi-select mode, bulk close selected conversations
        if (isConversationMultiSelectMode && selectedConversationIds.size > 0) {
          const idsToClose = Array.from(selectedConversationIds)
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
  }, [isConversationMultiSelectMode, selectedConversationIds, clearConversationSelection, addConversationToUndoStack])

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

        // Navigate to previous tab (cycle to end if at start)
        const nextIndex =
          currentIndex - 1 < 0 ? openIds.length - 1 : currentIndex - 1
        const nextId = openIds[nextIndex]

        if (nextId) {
          store.setActiveConversation(nextId)
        }
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

        // Navigate to next tab (cycle to start if at end)
        const nextIndex = (currentIndex + 1) % openIds.length
        const nextId = openIds[nextIndex]

        if (nextId) {
          store.setActiveConversation(nextId)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])
}
