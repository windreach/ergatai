import { useEffect, useRef } from "react"

interface UseSidebarMutexProps {
  isDetailsSidebarOpen: boolean
  isSideChatSidebarOpen: boolean
  isPlanSidebarOpen: boolean
  currentPlanPath: string | null
  isTerminalSidebarOpen: boolean
  terminalDisplayMode: "side-peek" | "bottom" | string
  setIsDetailsSidebarOpen: (open: boolean) => void
  setIsSideChatSidebarOpen: (open: boolean) => void
  setIsPlanSidebarOpen: (open: boolean) => void
  setIsTerminalSidebarOpen: (open: boolean) => void
}

/**
 * Hook to manage mutual exclusion between sidebars
 * Details/SideChat and Plan/Terminal/Diff sidebars cannot be open at the same time
 */
export function useSidebarMutex({
  isDetailsSidebarOpen,
  isSideChatSidebarOpen,
  isPlanSidebarOpen,
  currentPlanPath,
  isTerminalSidebarOpen,
  terminalDisplayMode,
  setIsDetailsSidebarOpen,
  setIsSideChatSidebarOpen,
  setIsPlanSidebarOpen,
  setIsTerminalSidebarOpen,
}: UseSidebarMutexProps) {
  // Track what was auto-closed and by whom for restoration.
  const autoClosedStateRef = useRef<{
    // Which panel closed each sidebar
    detailsClosedBy: "plan" | "terminal" | "diff" | null
    sideChatClosedBy: "plan" | "terminal" | "diff" | null
    // Which sidebars closed each panel
    planClosedByDetails: boolean
    planClosedBySideChat: boolean
    terminalClosedByDetails: boolean
    terminalClosedBySideChat: boolean
    diffClosedByDetails: boolean
    diffClosedBySideChat: boolean
  }>({
    detailsClosedBy: null,
    sideChatClosedBy: null,
    planClosedByDetails: false,
    planClosedBySideChat: false,
    terminalClosedByDetails: false,
    terminalClosedBySideChat: false,
    diffClosedByDetails: false,
    diffClosedBySideChat: false,
  })

  // Track previous states to detect opens/closes
  const prevSidebarStatesRef = useRef({
    details: isDetailsSidebarOpen,
    sideChat: isSideChatSidebarOpen,
    plan: isPlanSidebarOpen && !!currentPlanPath,
    terminal: isTerminalSidebarOpen,
  })

  useEffect(() => {
    const prev = prevSidebarStatesRef.current
    const auto = autoClosedStateRef.current
    const isPlanOpen = isPlanSidebarOpen && !!currentPlanPath

    // Detect state changes
    const detailsJustOpened = isDetailsSidebarOpen && !prev.details
    const detailsJustClosed = !isDetailsSidebarOpen && prev.details
    const sideChatJustOpened = isSideChatSidebarOpen && !prev.sideChat
    const sideChatJustClosed = !isSideChatSidebarOpen && prev.sideChat
    const planJustOpened = isPlanOpen && !prev.plan
    const planJustClosed = !isPlanOpen && prev.plan
    const terminalJustOpened = isTerminalSidebarOpen && !prev.terminal
    const terminalJustClosed = !isTerminalSidebarOpen && prev.terminal

    // Terminal in "bottom" mode doesn't conflict with the sidebars
    const terminalConflictsWithSidebars = terminalDisplayMode === "side-peek"

    // A sidebar (Details / side chat) opened → close conflicting panels and remember
    if (detailsJustOpened || sideChatJustOpened) {
      if (isPlanOpen) {
        if (detailsJustOpened) auto.planClosedByDetails = true
        if (sideChatJustOpened) auto.planClosedBySideChat = true
        setIsPlanSidebarOpen(false)
      }
      if (isTerminalSidebarOpen && terminalConflictsWithSidebars) {
        if (detailsJustOpened) auto.terminalClosedByDetails = true
        if (sideChatJustOpened) auto.terminalClosedBySideChat = true
        setIsTerminalSidebarOpen(false)
      }
    }

    // Details closed → restore what it closed
    if (detailsJustClosed) {
      if (auto.planClosedByDetails) {
        auto.planClosedByDetails = false
        setIsPlanSidebarOpen(true)
      }
      if (auto.terminalClosedByDetails) {
        auto.terminalClosedByDetails = false
        setIsTerminalSidebarOpen(true)
      }
    }

    // Side chat closed → restore what it closed
    if (sideChatJustClosed) {
      if (auto.planClosedBySideChat) {
        auto.planClosedBySideChat = false
        setIsPlanSidebarOpen(true)
      }
      if (auto.terminalClosedBySideChat) {
        auto.terminalClosedBySideChat = false
        setIsTerminalSidebarOpen(true)
      }
    }

    // Plan opened → close both sidebars and remember
    if (planJustOpened) {
      if (isDetailsSidebarOpen) {
        auto.detailsClosedBy = "plan"
        setIsDetailsSidebarOpen(false)
      }
      if (isSideChatSidebarOpen) {
        auto.sideChatClosedBy = "plan"
        setIsSideChatSidebarOpen(false)
      }
    }

    // Plan closed → restore the sidebars we closed
    if (planJustClosed) {
      if (auto.detailsClosedBy === "plan") {
        auto.detailsClosedBy = null
        setIsDetailsSidebarOpen(true)
      }
      if (auto.sideChatClosedBy === "plan") {
        auto.sideChatClosedBy = null
        setIsSideChatSidebarOpen(true)
      }
    }

    // Terminal opened → close both sidebars and remember (only in side-peek mode)
    if (terminalJustOpened && terminalConflictsWithSidebars) {
      if (isDetailsSidebarOpen) {
        auto.detailsClosedBy = "terminal"
        setIsDetailsSidebarOpen(false)
      }
      if (isSideChatSidebarOpen) {
        auto.sideChatClosedBy = "terminal"
        setIsSideChatSidebarOpen(false)
      }
    }

    // Terminal closed → restore the sidebars we closed
    if (terminalJustClosed) {
      if (auto.detailsClosedBy === "terminal") {
        auto.detailsClosedBy = null
        setIsDetailsSidebarOpen(true)
      }
      if (auto.sideChatClosedBy === "terminal") {
        auto.sideChatClosedBy = null
        setIsSideChatSidebarOpen(true)
      }
    }

    prevSidebarStatesRef.current = {
      details: isDetailsSidebarOpen,
      sideChat: isSideChatSidebarOpen,
      plan: isPlanOpen,
      terminal: isTerminalSidebarOpen,
    }
  }, [
    isDetailsSidebarOpen,
    isSideChatSidebarOpen,
    isPlanSidebarOpen,
    currentPlanPath,
    isTerminalSidebarOpen,
    terminalDisplayMode,
    setIsDetailsSidebarOpen,
    setIsSideChatSidebarOpen,
    setIsPlanSidebarOpen,
    setIsTerminalSidebarOpen,
  ])

  return {
    autoClosedStateRef,
  }
}
