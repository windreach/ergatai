import { useEffect, useRef } from "react"

interface UseDiffSidebarConflictsProps {
  isDiffSidebarOpen: boolean
  diffDisplayMode: string
  isDetailsSidebarOpen: boolean
  isSideChatSidebarOpen: boolean
  setIsDiffSidebarOpen: (open: boolean) => void
  setIsDetailsSidebarOpen: (open: boolean) => void
  setIsSideChatSidebarOpen: (open: boolean) => void
  autoClosedStateRef: React.MutableRefObject<{
    detailsClosedBy: "plan" | "terminal" | "diff" | null
    sideChatClosedBy: "plan" | "terminal" | "diff" | null
    diffClosedByDetails: boolean
    diffClosedBySideChat: boolean
  }>
}

/**
 * Hook to manage conflicts between Diff sidebar (side-peek mode) and Details/SideChat sidebars
 */
export function useDiffSidebarConflicts({
  isDiffSidebarOpen,
  diffDisplayMode,
  isDetailsSidebarOpen,
  isSideChatSidebarOpen,
  setIsDiffSidebarOpen,
  setIsDetailsSidebarOpen,
  setIsSideChatSidebarOpen,
  autoClosedStateRef,
}: UseDiffSidebarConflictsProps) {
  const prevDiffStateRef = useRef<{
    isOpen: boolean
    mode: string
    detailsOpen: boolean
    sideChatOpen: boolean
  }>({
    isOpen: isDiffSidebarOpen,
    mode: diffDisplayMode,
    detailsOpen: isDetailsSidebarOpen,
    sideChatOpen: isSideChatSidebarOpen,
  })
  // Flag to skip center-peek switch when restoring Diff after a sidebar closes
  const isRestoringDiffRef = useRef(false)

  useEffect(() => {
    const prev = prevDiffStateRef.current
    const auto = autoClosedStateRef.current
    const isNowSidePeek = isDiffSidebarOpen && diffDisplayMode === "side-peek"
    const wasSidePeek = prev.isOpen && prev.mode === "side-peek"
    const detailsJustOpened = isDetailsSidebarOpen && !prev.detailsOpen
    const detailsJustClosed = !isDetailsSidebarOpen && prev.detailsOpen
    const sideChatJustOpened = isSideChatSidebarOpen && !prev.sideChatOpen
    const sideChatJustClosed = !isSideChatSidebarOpen && prev.sideChatOpen
    const sidebarJustOpened = detailsJustOpened || sideChatJustOpened
    const anySidebarOpen = isDetailsSidebarOpen || isSideChatSidebarOpen
    const diffSidePeekJustClosed = wasSidePeek && !isNowSidePeek

    if (isNowSidePeek && anySidebarOpen) {
      // A sidebar just opened while Diff is in side-peek -> close Diff and remember
      if (sidebarJustOpened) {
        if (detailsJustOpened) auto.diffClosedByDetails = true
        if (sideChatJustOpened) auto.diffClosedBySideChat = true
        setIsDiffSidebarOpen(false)
      }
      // Diff just opened in side-peek mode -> close both sidebars and remember
      // Skip if we're restoring Diff after a sidebar closed
      else if (!prev.isOpen && !isRestoringDiffRef.current) {
        if (isDetailsSidebarOpen) auto.detailsClosedBy = "diff"
        if (isSideChatSidebarOpen) auto.sideChatClosedBy = "diff"
        setIsDetailsSidebarOpen(false)
        setIsSideChatSidebarOpen(false)
      }
      // User manually switched to side-peek while Diff was already open -> close both sidebars and remember
      else if (prev.isOpen && prev.mode !== "side-peek") {
        if (isDetailsSidebarOpen) auto.detailsClosedBy = "diff"
        if (isSideChatSidebarOpen) auto.sideChatClosedBy = "diff"
        setIsDetailsSidebarOpen(false)
        setIsSideChatSidebarOpen(false)
      }
    }

    // Diff side-peek closed -> restore the sidebars we closed
    if (diffSidePeekJustClosed) {
      if (auto.detailsClosedBy === "diff") {
        auto.detailsClosedBy = null
        setIsDetailsSidebarOpen(true)
      }
      if (auto.sideChatClosedBy === "diff") {
        auto.sideChatClosedBy = null
        setIsSideChatSidebarOpen(true)
      }
    }

    // A sidebar closed -> restore Diff if we closed it (side-peek mode, not switching to dialog)
    if (detailsJustClosed && auto.diffClosedByDetails) {
      auto.diffClosedByDetails = false
      isRestoringDiffRef.current = true
      setIsDiffSidebarOpen(true)
      // Reset flag after state update
      requestAnimationFrame(() => {
        isRestoringDiffRef.current = false
      })
    }
    if (sideChatJustClosed && auto.diffClosedBySideChat) {
      auto.diffClosedBySideChat = false
      isRestoringDiffRef.current = true
      setIsDiffSidebarOpen(true)
      requestAnimationFrame(() => {
        isRestoringDiffRef.current = false
      })
    }

    prevDiffStateRef.current = {
      isOpen: isDiffSidebarOpen,
      mode: diffDisplayMode,
      detailsOpen: isDetailsSidebarOpen,
      sideChatOpen: isSideChatSidebarOpen,
    }
  }, [
    isDiffSidebarOpen,
    diffDisplayMode,
    isDetailsSidebarOpen,
    isSideChatSidebarOpen,
    setIsSideChatSidebarOpen,
    setIsDetailsSidebarOpen,
    setIsDiffSidebarOpen,
    autoClosedStateRef,
  ])
}
