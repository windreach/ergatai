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
 * Hook to manage mutual exclusion between sidebars.
 *
 * Two mutex groups:
 *  - Details / SideChat (left-side detail panels)
 *  - Plan / Terminal-in-side-peek / Diff-in-side-peek (right-side work panels)
 *
 * When a panel from one group opens, conflicting panels in the other group
 * are auto-closed, and we remember who closed whom so we can restore on close.
 *
 * The Diff sidebar is handled by the sibling `useDiffSidebarConflicts` hook,
 * which shares the `autoClosedStateRef` returned from this hook — that's why
 * the `detailsClosedBy` / `sideChatClosedBy` types include `"diff"` and the
 * ref carries `diffClosedByDetails` / `diffClosedBySideChat` fields, even
 * though this hook itself has no Diff-handling branch.
 *
 * NOTE: Setter functions (`setIs*SidebarOpen`) MUST be referentially stable
 * (e.g., from `useState`). They are stored in refs internally to decouple
 * the effect from their stability and avoid cascading re-runs.
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
  //
  // `detailsClosedBy` / `sideChatClosedBy` record *which* panel in the other
  // group auto-closed the sidebar, so we only restore when that specific panel
  // closes. Manual opens by the user must clear these flags — otherwise a stale
  // flag can cause a restore long after the conflict has been resolved.
  //
  // NOTE: The `"diff"` variant and `diffClosedBy*` fields are used by the sibling
  // `useDiffSidebarConflicts` hook, which shares this ref. They are not dead code.
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
    terminalDisplayMode,
  })

  // Store setters in refs to decouple the effect from their referential stability.
  // If setters came from a context provider or custom hook without `useCallback`,
  // putting them directly in the dependency array would cause the effect to re-run
  // on every parent render, triggering cascading state mutations and flickering.
  const settersRef = useRef({
    setIsDetailsSidebarOpen,
    setIsSideChatSidebarOpen,
    setIsPlanSidebarOpen,
    setIsTerminalSidebarOpen,
  })
  useEffect(() => {
    settersRef.current = {
      setIsDetailsSidebarOpen,
      setIsSideChatSidebarOpen,
      setIsPlanSidebarOpen,
      setIsTerminalSidebarOpen,
    }
  }, [setIsDetailsSidebarOpen, setIsSideChatSidebarOpen, setIsPlanSidebarOpen, setIsTerminalSidebarOpen])

  useEffect(() => {
    const prev = prevSidebarStatesRef.current
    const auto = autoClosedStateRef.current
    const isPlanOpen = isPlanSidebarOpen && !!currentPlanPath
    const set = settersRef.current

    // Detect state changes
    const detailsJustOpened = isDetailsSidebarOpen && !prev.details
    const detailsJustClosed = !isDetailsSidebarOpen && prev.details
    const sideChatJustOpened = isSideChatSidebarOpen && !prev.sideChat
    const sideChatJustClosed = !isSideChatSidebarOpen && prev.sideChat
    const planJustOpened = isPlanOpen && !prev.plan
    const planJustClosed = !isPlanOpen && prev.plan
    const terminalJustOpened = isTerminalSidebarOpen && !prev.terminal
    const terminalJustClosed = !isTerminalSidebarOpen && prev.terminal
    const terminalModeChanged = terminalDisplayMode !== prev.terminalDisplayMode

    // Terminal in "bottom" mode doesn't conflict with the sidebars
    const terminalConflictsWithSidebars = terminalDisplayMode === "side-peek"
    const prevTerminalConflicted = prev.terminalDisplayMode === "side-peek"

    // A sidebar (Details / side chat) opened → close conflicting panels and remember.
    //
    // Manual opens also *invalidate* any prior auto-close tracking for that sidebar:
    // if Details was previously auto-closed by Terminal, but the user now manually
    // opens it, the old `detailsClosedBy = "terminal"` flag is stale and must be
    // cleared — otherwise Terminal closing later would (incorrectly) try to restore
    // Details, even though Details is already open, and might displace another panel
    // the user opened in the meantime.
    if (detailsJustOpened || sideChatJustOpened) {
      if (detailsJustOpened) {
        auto.detailsClosedBy = null
      }
      if (sideChatJustOpened) {
        auto.sideChatClosedBy = null
      }

      // When both Details and SideChat open in the same render and Plan is open,
      // only the *first* one (Details, by priority) claims responsibility for
      // closing Plan. Otherwise both set their `planClosedBy*` flag, and later
      // closing one restores Plan, which then conflicts with the other — causing
      // a cascading close/restore cycle and unexpectedly closing the user's panel.
      if (isPlanOpen) {
        if (detailsJustOpened) {
          auto.planClosedByDetails = true
          set.setIsPlanSidebarOpen(false)
        } else if (sideChatJustOpened && !auto.planClosedByDetails) {
          // Only SideChat opened (and Details didn't already claim it this render)
          auto.planClosedBySideChat = true
          set.setIsPlanSidebarOpen(false)
        }
      }
      if (isTerminalSidebarOpen && terminalConflictsWithSidebars) {
        if (detailsJustOpened) {
          auto.terminalClosedByDetails = true
          set.setIsTerminalSidebarOpen(false)
        } else if (sideChatJustOpened && !auto.terminalClosedByDetails) {
          auto.terminalClosedBySideChat = true
          set.setIsTerminalSidebarOpen(false)
        }
      }
    }

    // Details closed → restore what it closed
    if (detailsJustClosed) {
      if (auto.planClosedByDetails) {
        auto.planClosedByDetails = false
        set.setIsPlanSidebarOpen(true)
      }
      if (auto.terminalClosedByDetails) {
        auto.terminalClosedByDetails = false
        set.setIsTerminalSidebarOpen(true)
      }
    }

    // Side chat closed → restore what it closed
    if (sideChatJustClosed) {
      if (auto.planClosedBySideChat) {
        auto.planClosedBySideChat = false
        set.setIsPlanSidebarOpen(true)
      }
      if (auto.terminalClosedBySideChat) {
        auto.terminalClosedBySideChat = false
        set.setIsTerminalSidebarOpen(true)
      }
    }

    // Plan opened → close both sidebars and remember
    if (planJustOpened) {
      if (isDetailsSidebarOpen) {
        auto.detailsClosedBy = "plan"
        set.setIsDetailsSidebarOpen(false)
      }
      if (isSideChatSidebarOpen) {
        auto.sideChatClosedBy = "plan"
        set.setIsSideChatSidebarOpen(false)
      }
    }

    // Plan closed → restore the sidebars we closed
    if (planJustClosed) {
      if (auto.detailsClosedBy === "plan") {
        auto.detailsClosedBy = null
        set.setIsDetailsSidebarOpen(true)
      }
      if (auto.sideChatClosedBy === "plan") {
        auto.sideChatClosedBy = null
        set.setIsSideChatSidebarOpen(true)
      }
    }

    // Terminal opened → close both sidebars and remember (only in side-peek mode)
    if (terminalJustOpened && terminalConflictsWithSidebars) {
      if (isDetailsSidebarOpen) {
        auto.detailsClosedBy = "terminal"
        set.setIsDetailsSidebarOpen(false)
      }
      if (isSideChatSidebarOpen) {
        auto.sideChatClosedBy = "terminal"
        set.setIsSideChatSidebarOpen(false)
      }
    }

    // Terminal closed → restore the sidebars we closed
    if (terminalJustClosed) {
      if (auto.detailsClosedBy === "terminal") {
        auto.detailsClosedBy = null
        set.setIsDetailsSidebarOpen(true)
      }
      if (auto.sideChatClosedBy === "terminal") {
        auto.sideChatClosedBy = null
        set.setIsSideChatSidebarOpen(true)
      }
    }

    // Terminal display mode changed while already open.
    //
    // The open/close handlers above only fire on *transitions* of the terminal's
    // open state, not on mode changes. Without this branch, switching from
    // "bottom" (no conflict) to "side-peek" (conflicts) while the terminal is
    // already open would leave both sidebars open, violating the mutex. And
    // switching from "side-peek" to "bottom" would leave stale
    // `*ClosedBy === "terminal"` flags set, causing incorrect restores later.
    if (terminalModeChanged && isTerminalSidebarOpen) {
      if (terminalConflictsWithSidebars && !prevTerminalConflicted) {
        // Transitioned into conflict mode: enforce the mutex now.
        if (isDetailsSidebarOpen) {
          auto.detailsClosedBy = "terminal"
          set.setIsDetailsSidebarOpen(false)
        }
        if (isSideChatSidebarOpen) {
          auto.sideChatClosedBy = "terminal"
          set.setIsSideChatSidebarOpen(false)
        }
      } else if (!terminalConflictsWithSidebars && prevTerminalConflicted) {
        // Transitioned out of conflict mode: clear any stale terminal-close flags.
        // The sidebars themselves stay closed (the user hasn't reopened them);
        // we just stop pretending Terminal is responsible for their state, so
        // future Terminal closes won't unexpectedly restore them.
        if (auto.detailsClosedBy === "terminal") {
          auto.detailsClosedBy = null
        }
        if (auto.sideChatClosedBy === "terminal") {
          auto.sideChatClosedBy = null
        }
      }
    }

    prevSidebarStatesRef.current = {
      details: isDetailsSidebarOpen,
      sideChat: isSideChatSidebarOpen,
      plan: isPlanOpen,
      terminal: isTerminalSidebarOpen,
      terminalDisplayMode,
    }
    // Setters are intentionally NOT in the dependency array: they are accessed
    // via `settersRef`, which is kept in sync by a separate effect above.
    // Including them directly would couple this effect's lifetime to their
    // referential stability (which is not guaranteed for context-provided setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isDetailsSidebarOpen,
    isSideChatSidebarOpen,
    isPlanSidebarOpen,
    currentPlanPath,
    isTerminalSidebarOpen,
    terminalDisplayMode,
  ])

  return {
    autoClosedStateRef,
  }
}
